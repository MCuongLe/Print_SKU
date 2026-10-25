"""Báo cáo "Trạng thái lên thật" — CHỈ ĐỌC (đợt 5 chuẩn hoá tài liệu, 25/10/2026).

    python scripts/live_status.py             # git + migration + Supabase (cần token như apply_supabase_sql.py)
    python scripts/live_status.py --offline   # chỉ git + phân tích tệp migration, không gọi Supabase

Đọc:
- git: HEAD, origin/main theo lần fetch gần nhất (script không fetch), phiên bản Extension và agent trong repo.
- supabase/*.sql theo thứ tự tệp vào git: đối tượng public mỗi tệp tạo / xoá (hàm, bảng, index, trigger, việc cron),
  suy ra đối tượng phải có trên DB; tệp có đối tượng còn thiếu là dấu hiệu migration chưa chạy.
- Supabase qua Management API: một câu SELECT (pg_proc, pg_class, pg_indexes, pg_trigger, cron.job, print_agents,
  sync_auto_leases) và danh sách Edge Function. Mọi câu SQL phải qua `select_only`.

In Markdown theo khuôn mục "Trạng thái lên thật" (docs/chuan/TAI_LIEU.md) để lead chép vào docs/QUYET_DINH.md;
phần "Đã lên, CHƯA thử thật" vẫn ghi tay. Không ghi tệp nào, không ghi Supabase.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_supabase_sql as supa  # noqa: E402  (token, project ref, câu truy vấn, bỏ chú thích / thân hàm)

ROOT = Path(__file__).resolve().parents[1]
VN = dt.timezone(dt.timedelta(hours=7))
KINDS = ("function", "table", "index", "trigger", "cron")

NAME = r"(?:public\.)?\"?(\w+)\"?(?![\w.])"
PATTERNS = [
    ("create", "table", re.compile(r"\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?" + NAME, re.I)),
    ("create", "index", re.compile(r"\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?\"?(\w+)\"?\s+on\b", re.I)),
    ("create", "function", re.compile(r"\bcreate\s+(?:or\s+replace\s+)?function\s+" + NAME + r"\s*\(", re.I)),
    ("create", "trigger", re.compile(r"\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+\"?(\w+)\"?", re.I)),
    ("drop", "table", re.compile(r"\bdrop\s+table\s+(?:if\s+exists\s+)?" + NAME, re.I)),
    ("drop", "index", re.compile(r"\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?" + NAME, re.I)),
    ("drop", "function", re.compile(r"\bdrop\s+function\s+(?:if\s+exists\s+)?" + NAME, re.I)),
    ("drop", "trigger", re.compile(r"\bdrop\s+trigger\s+(?:if\s+exists\s+)?\"?(\w+)\"?", re.I)),
    ("create", "cron", re.compile(r"\bcron\.schedule\s*\(\s*'([^']+)'", re.I)),
    ("drop", "cron", re.compile(r"\bcron\.unschedule\s*\(\s*'([^']+)'", re.I)),
]
# `add constraint X primary key|unique using index Y` đổi tên index Y thành X; thường nằm trong khối do $$…$$ có điều kiện
# (vd. db_hygiene_v1) nên đọc cả thân khối.
USING_INDEX = re.compile(r"\badd\s+constraint\s+\"?(\w+)\"?\s+(?:primary\s+key|unique)\s+using\s+index\s+\"?(\w+)\"?", re.I)
CRON_HOUR_UTC = re.compile(r"^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)$")
WEEKDAY = {"0": "Chủ nhật", "1": "thứ Hai", "2": "thứ Ba", "3": "thứ Tư", "4": "thứ Năm", "5": "thứ Sáu", "6": "thứ Bảy"}


def select_only(sql: str) -> str:
    """Chỉ cho một câu SELECT / WITH; câu ghi hoặc nhiều câu → ValueError."""
    body = sql.strip().rstrip(";").strip()
    if not re.match(r"(?is)^(select|with)\b", body) or ";" in supa.strip_function_bodies(supa.strip_sql_comments(body)):
        raise ValueError("live_status chỉ chạy một câu SELECT / WITH")
    if re.search(r"(?i)\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b", supa.strip_sql_comments(body)):
        raise ValueError("live_status không chạy câu có từ khoá ghi")
    return body


def sql_objects(sql: str) -> list[tuple[int, str, str, str]]:
    """[(vị trí, create|drop, loại, tên)] của đối tượng schema public theo thứ tự xuất hiện; bỏ chú thích và thân $$…$$
    (riêng cron.schedule nằm ngoài thân hàm nên vẫn đọc từ bản đã bỏ chú thích)."""
    no_comments = supa.strip_sql_comments(sql)
    top = supa.strip_function_bodies(no_comments)
    found = []
    for action, kind, pattern in PATTERNS:
        source = no_comments if kind == "cron" else top
        for match in pattern.finditer(source):
            if kind == "cron":
                # vị trí theo bản top-level để xếp cùng thứ tự với lệnh khác: tìm lại đúng câu cron trong `top`
                pos = top.find(match.group(0))
                if pos < 0:
                    continue  # nằm trong thân hàm → không phải lệnh chạy của migration
            else:
                pos = match.start()
            found.append((pos, action, kind, match.group(1)))
    for match in USING_INDEX.finditer(no_comments):
        pos = match.start() + len(no_comments)  # sau mọi lệnh cấp ngoài của tệp (vị trí trong bản có thân khối khác thang)
        found.append((pos, "drop", "index", match.group(2)))
        found.append((pos + 1, "create", "index", match.group(1)))
    return sorted(found)


def expected_objects(files: list[tuple[str, str]]) -> tuple[set[tuple[str, str]], dict[str, set[tuple[str, str]]]]:
    """Từ [(tên tệp, SQL)] theo thứ tự chạy: (đối tượng phải còn trên DB, {tệp: đối tượng tệp tạo và vẫn phải còn})."""
    state: set[tuple[str, str]] = set()
    created: dict[str, set[tuple[str, str]]] = {}
    for name, sql in files:
        made = created.setdefault(name, set())
        for _pos, action, kind, obj in sql_objects(sql):
            key = (kind, obj)
            if action == "create":
                state.add(key)
                made.add(key)
            else:
                state.discard(key)
    return state, {name: made & state for name, made in created.items()}


def missing_by_file(per_file: dict[str, set[tuple[str, str]]], db: dict[str, set[str]]) -> dict[str, list[str]]:
    out = {}
    for name, objs in per_file.items():
        miss = sorted(f"{kind} {obj}" for kind, obj in objs if obj not in db.get(kind, set()))
        if miss:
            out[name] = miss
    return out


def cron_vn(schedule: str) -> str:
    """'15 20 * * 0' (UTC) → '03:15 thứ Hai'; '*/30 * * * *' → 'mỗi 30 phút'; lịch khác giữ nguyên."""
    every = re.match(r"^\*/(\d+) \* \* \* \*$", schedule.strip())
    if every:
        return f"mỗi {every.group(1)} phút"
    m = CRON_HOUR_UTC.match(schedule.strip())
    if not m or not m.group(1).isdigit() or not m.group(2).isdigit() or m.group(3) != "*" or m.group(4) != "*":
        return schedule
    minute, hour = int(m.group(1)), int(m.group(2)) + 7
    day_shift, hour = divmod(hour, 24)
    when = f"{hour:02d}:{minute:02d}"
    weekday = m.group(5)
    if weekday == "*":
        return f"{when} mỗi ngày"
    if weekday.isdigit():
        return f"{when} {WEEKDAY[str((int(weekday) + day_shift) % 7)]}"
    return schedule


def render(data: dict) -> str:
    g, mig = data["git"], data["migrations"]
    lines = [
        f"## Trạng thái lên thật (live_status.py, {data['now']})",
        "",
        "Mục này thắng mọi ghi chú \"CHƯA LÊN\" trong nhật ký. Sinh bằng `python scripts/live_status.py` (chỉ đọc); "
        "nhóm \"Đã lên, CHƯA thử thật\" ghi tay.",
        "",
        f"**Web:** `HEAD` = `{g['head']}`; `origin/main` = `{g['origin']}` (theo lần fetch gần nhất)"
        + ("" if not (g["ahead"] or g["behind"]) else f"; main đi trước {g['ahead']}, đi sau {g['behind']} commit") + ".",
        "",
        f"**ĐÃ LÊN — migration:** {mig['ok']} tệp có đủ đối tượng trên DB.",
        "",
        "**ĐÃ LÊN — Edge Function (bản đang chạy ↔ commit cuối của thư mục hàm)**",
    ]
    for e in data["edge"]:
        flag = " — deploy trước commit cuối: kiểm nội dung" if e["stale"] else ""
        lines.append(f"- `{e['slug']}` bản {e['version']}, deploy {e['deployed']}; commit cuối {e['commit']}{flag}.")
    lines += ["", "**ĐÃ LÊN — Extension / agent / cron**",
              f"- Extension trong repo {data['extension']}; agent trong repo {data['agent_version']} (bản đang cài: xem agent dưới)."]
    for a in data["agents"]:
        state = "" if a["enabled"] else " (đang tắt)"
        caps = ", ".join(f"`{c}`" for c in a["capabilities"] or [])
        lines.append(f"- Agent `{a['name']}`{state}: {a['version'] or 'chưa báo phiên bản'}, khai {caps or 'không'}; lần thấy cuối {a['last_seen'] or 'chưa từng'}.")
    if data["cron"]:
        lines.append("- Cron (giờ VN): " + "; ".join(f"`{c['name']}` {cron_vn(c['schedule'])}{'' if c['active'] else ' (tắt)'}" for c in data["cron"]) + ".")
    if data["leases"]:
        lines.append("- Đồng bộ tự động, lượt xong cuối: " + "; ".join(f"{l['kind']} {l['last_finished'] or '—'}" for l in data["leases"]) + ".")
    lines += ["", "**CHƯA LÊN** (tệp migration có đối tượng chưa có trên DB)"]
    if mig["missing"]:
        for name, miss in sorted(mig["missing"].items()):
            lines.append(f"- `{name}`: thiếu {', '.join(miss)}.")
    else:
        lines.append("- Không có.")
    lines += ["", "**Đã lên, CHƯA thử thật**", "- (ghi tay)"]
    return "\n".join(lines) + "\n"


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()


def vn_time(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, (int, float)):
        moment = dt.datetime.fromtimestamp(value / 1000 if value > 1e11 else value, VN)
    else:
        moment = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(VN)
    return moment.strftime("%d/%m %H:%M")


def migration_files() -> list[tuple[str, str]]:
    """Tệp supabase/*.sql theo thứ tự vào git (tệp chưa theo dõi xếp cuối theo tên)."""
    rows = []
    for path in sorted((ROOT / "supabase").glob("*.sql")):
        rel = path.relative_to(ROOT).as_posix()
        added = git("log", "--diff-filter=A", "--format=%ct", "--", rel).splitlines()
        rows.append((int(added[-1]) if added else 10**12, path.name, path.read_text(encoding="utf-8-sig", errors="replace")))
    return [(name, sql) for _t, name, sql in sorted(rows)]


STATUS_SQL = """select json_build_object(
  'function', (select coalesce(json_agg(distinct p.proname), '[]') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'),
  'table', (select coalesce(json_agg(c.relname), '[]') from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')),
  'index', (select coalesce(json_agg(indexname), '[]') from pg_indexes where schemaname = 'public'),
  'trigger', (select coalesce(json_agg(distinct t.tgname), '[]') from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and not t.tgisinternal),
  'cron', (select coalesce(json_agg(json_build_object('name', jobname, 'schedule', schedule, 'active', active) order by jobname), '[]') from cron.job),
  'agents', (select coalesce(json_agg(json_build_object('name', name, 'enabled', enabled, 'version', state->>'version', 'capabilities', capabilities, 'last_seen', last_seen_at) order by name), '[]') from public.print_agents),
  'leases', (select coalesce(json_agg(json_build_object('kind', kind, 'last_finished', last_finished_at) order by kind), '[]') from public.sync_auto_leases)
) as status"""


def edge_functions(ref: str, token: str, timeout: int) -> list[dict]:
    request = Request(f"{supa.MANAGEMENT_API}/v1/projects/{ref}/functions", headers={"Authorization": f"Bearer {token}"}, method="GET")
    try:
        with urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8") or "[]")
    except HTTPError as error:
        raise SystemExit(f"Management API HTTP {error.code} khi đọc Edge Function (401: token hỏng / hết hạn; 403: thiếu quyền)") from error
    except URLError as error:
        raise SystemExit(f"Không gọi được Management API: {error.reason}") from error


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--offline", action="store_true", help="không gọi Supabase")
    parser.add_argument("--project-ref", default="")
    parser.add_argument("--timeout", type=int, default=60)
    args = parser.parse_args()

    head = git("log", "-1", "--format=%h %s")
    origin = git("rev-parse", "--short", "origin/main")
    counts = git("rev-list", "--left-right", "--count", "HEAD...origin/main").split()
    manifest = json.loads((ROOT / "extension" / "inside-po-connector" / "manifest.json").read_text(encoding="utf-8"))
    agent_version = (ROOT / "workstation-agent" / "VERSION").read_text(encoding="utf-8").strip()
    files = migration_files()
    expected, per_file = expected_objects(files)

    data = {
        "now": dt.datetime.now(VN).strftime("%d/%m/%Y %H:%M"),
        "git": {"head": head, "origin": origin, "ahead": int(counts[0]) if counts else 0, "behind": int(counts[1]) if len(counts) > 1 else 0},
        "extension": manifest.get("version", "?"), "agent_version": agent_version,
        "migrations": {"ok": len(files), "missing": {}}, "edge": [], "agents": [], "cron": [], "leases": [],
    }
    if args.offline:
        print(f"(--offline: {len(files)} tệp migration, {len(expected)} đối tượng phải có; không gọi Supabase)\n", file=sys.stderr)
        print(render(data))
        return 0

    token = supa.read_token(ROOT)
    if not token:
        raise SystemExit(f"Thiếu {supa.TOKEN_VARIABLE} (biến môi trường hoặc .env) — chạy --offline nếu chỉ cần phần git.")
    ref = supa.project_ref(args.project_ref)
    rows = supa.run_query(ref, token, select_only(STATUS_SQL), args.timeout)
    status = rows[0]["status"] if isinstance(rows, list) and rows else {}
    if isinstance(status, str):
        status = json.loads(status)
    db = {kind: set(status.get(kind) or []) if kind != "cron" else {c["name"] for c in status.get("cron") or []} for kind in KINDS}
    missing = missing_by_file(per_file, db)
    data["migrations"] = {"ok": sum(1 for name, _sql in files if name not in missing), "missing": missing}
    for f in sorted(edge_functions(ref, token, args.timeout), key=lambda r: r.get("slug", "")):
        last = git("log", "-1", "--format=%ct", "--", f"supabase/functions/{f.get('slug')}")
        deployed = f.get("updated_at") or 0
        data["edge"].append({
            "slug": f.get("slug"), "version": f.get("version"), "deployed": vn_time(deployed),
            "commit": vn_time(int(last)) if last else "chưa có trong git",
            "stale": bool(last) and deployed / 1000 < int(last),
        })
    data["agents"] = [{**a, "last_seen": vn_time(a.get("last_seen"))} for a in status.get("agents") or []]
    data["cron"] = status.get("cron") or []
    data["leases"] = [{"kind": l["kind"], "last_finished": vn_time(l.get("last_finished"))} for l in status.get("leases") or []]
    print(render(data))
    return 0


if __name__ == "__main__":
    sys.exit(main())
