"""scripts/release.py (26/10/2026, mô hình A, docs/plans/2026-10-26-release-script.md Việc 2).

Hàm thuần (hash CRLF→LF, đầu tệp migration, tách chuỗi cho dấu vết nội dung, câu SQL sổ / khoá, biên bản) và luồng
--plan / --apply / --init / --status chạy với bản giả của git, run_query, Management API, input, isatty, subprocess.
Không gọi mạng, không đọc .env: mọi lối ra ngoài của release.py đi qua Ctx, test thay bằng FakeCtx; urlopen, subprocess,
input và read_token thật bị chặn trong lúc chạy. Cuối tệp: đột biến mã nguồn release.py phải bị bắt.

    python -X utf8 tests/test_release.py
"""
from __future__ import annotations

import contextlib
import datetime as dt
import hashlib
import http.client
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
sys.path.insert(0, str(SCRIPTS))
import apply_supabase_sql as supa  # noqa: E402
import live_status as live  # noqa: E402

SOURCE_PATH = SCRIPTS / "release.py"
SOURCE = SOURCE_PATH.read_text(encoding="utf-8")


def load(source: str = SOURCE, name: str = "release_test_module"):
    """Nạp release.py (hoặc bản đột biến) thành module riêng."""
    module = types.ModuleType(name)
    module.__file__ = str(SOURCE_PATH)
    sys.modules[name] = module
    exec(compile(source, str(SOURCE_PATH), "exec"), module.__dict__)
    return module


R = load()

# ---- dữ liệu giả chuẩn (không token / ref / máy / SKU / UID thật)
TOKEN = "tok-gia-khong-that-release-0001"
REF = "abcdefghijklmnopqrst"
HEAD = "c0ffee0" + "1" * 33
OTHER_HEAD = "deadbee" + "2" * 33
NOW = dt.datetime(2026, 10, 26, 16, 0, tzinfo=live.VN)
NOW_MS = int(NOW.timestamp() * 1000)
HOST = "may-a"
HOLDER = "may-a#ab12cd34"
VER_HEAD, VER_OLD = "9.9.1", "9.9.0"

SQL_A = "-- a_v1: bảng cũ đã chạy\nbegin;\ncreate table if not exists public.bang_a (id int);\ncommit;\n"
SQL_B = ("-- b_v1: bảng mới (SKU giả 900000001)\n-- Vì sao: thử release.py\n"
         "-- kiem: select to_regclass('public.bang_b') is not null as ok\n"
         "-- Rút lui (giả):\n--   drop table if exists public.bang_b;\n"
         "begin;\ncreate table if not exists public.bang_b (id int);\ncommit;\n")
SQL_C = ("-- c_v1: hàm mới\n-- kiem: select true as ok\nbegin;\n"
         "create or replace function public.ham_c() returns int language sql security definer set search_path = '' as $$ select 1 $$;\n"
         "revoke all on function public.ham_c() from public, anon, authenticated;\ncommit;\n")
SQL_D = "-- d_v1: dọn bảng cũ\n-- kiem: select true as ok\nbegin;\ndrop table if exists public.bang_cu;\ncommit;\n"
SQL_E = "-- e_v1: bảng không có dòng kiem\nbegin;\ncreate table if not exists public.bang_e (id int);\ncommit;\n"
# Bản cũ của a_v1.sql (commit ghi trong sổ): chỉ khác chú thích (kể cả thêm dòng chú thích, CRLF) / khác nội dung SQL.
SQL_A_OLD_COMMENT = ("-- a_v1: bảng cũ (chú thích bản cũ)\r\n-- thêm một dòng chú thích\r\nbegin;\r\n"
                     "create table if not exists public.bang_a (id int);\r\ncommit;\r\n")
SQL_A_OLD_CONTENT = "-- a_v1: bảng cũ đã chạy\nbegin;\ncreate table if not exists public.bang_a (id bigint);\ncommit;\n"
# Tệp ví dụ (như print_queue_bootstrap.example.sql): không phải migration — không chờ, không chạy, không ghi sổ, không đếm.
SQL_EXAMPLE = "-- x.example: tệp ví dụ, không phải migration\ncreate table public.vi_du (id int);\n"
ORDER_WITH_EXAMPLE = ["a_v1.sql", "x.example.sql", "b_v1.sql", "c_v1.sql", "y.sql"]
EDGE_A = ('const MSG = "Phiên Admin không hợp lệ (giả)";\n'
          "const OTHER = 'Mã lượt đồng bộ không hợp lệ';\n"
          "const PROMPT = `Bạn là trợ lý in.\nTrả JSON {\"intent\": \"print_it\", \"reply\": \"Câu trả lời ngắn gọn\"}\n"
          "Không in thẳng; UID giả 1028260000000001.`;\n"
          'export default () => new Response("Đã nhận yêu cầu in tem");\n')
EDGE_A_STRINGS = ["Phiên Admin không hợp lệ (giả)", "Mã lượt đồng bộ không hợp lệ", "Đã nhận yêu cầu in tem"]
EDGE_A_UNSURE = EDGE_A + 'if (ok) /"/.test(MSG);\n'
MANIFEST = json.dumps({"manifest_version": 3, "name": "Inside PO Connector", "version": VER_HEAD}).encode()
LEDGER_SQL_FILE = (ROOT / "supabase" / "release_ledger_v1.sql").read_bytes()


def sha(data) -> str:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def bundle(*strings: str) -> bytes:
    """Bundle ESZIP giả: phần đầu nhị phân + mã đã biên dịch chứa các chuỗi một dòng; thân template không giữ nguyên văn."""
    code = "\n".join(f'const s{index} = "{text}";' for index, text in enumerate(strings))
    return b"ESZIP2.3\x00\x01\xff\xfe" + code.encode("utf-8") + b"\nconst PROMPT = `<da bien dich>`;\x00"


def iso(moment: dt.datetime) -> str:
    return moment.astimezone(dt.timezone.utc).isoformat()


FIELD = re.compile(r"'((?:[^']|'')*)'|null")
TUPLE = re.compile(r"\(((?:'(?:[^']|'')*'|null)(?:, (?:'(?:[^']|'')*'|null)){5})\)")


class FakeMixin:
    """Thay mọi lối ra ngoài của release.Ctx; ghi lại sự kiện theo thứ tự để test khẳng định thứ tự."""

    def setup(self, module, out_dir: Path, **overrides):
        self.R = module
        self.out_dir = out_dir
        self.events: list[tuple] = []
        self.prompts: list[str] = []
        self.answers: list[str] = []
        self.tty = True
        self.token_value = TOKEN
        self.branch = "main"
        self.dirty = ""
        self.fetch_code = 0
        self.behind = 0
        self.gate_code = 0
        self.push_code = 0
        self.move_head_on_push = False   # True: phiên khác commit ngay khi đang hỏi câu push → HEAD đổi sau câu hỏi
        self.branch_on_push = None       # tên nhánh sau câu hỏi push (None = giữ nguyên)
        self.steal_on_sql = None         # câu SQL mà sau khi chạy thì máy khác chiếm khoá
        self.steal_on_prompt = None      # đầu câu hỏi mà lúc hỏi thì máy khác chiếm khoá
        self.on_lock = None              # hàm(fake) chạy ngay khi lấy được khoá (mô phỏng máy khác vừa ghi sổ)
        self.diff_code = 0               # mã thoát của git diff --name-only origin/main..<sha>
        self.committed = {"scripts/deploy_ham_a.py"}
        self.fail_message = "Management API HTTP 400: lỗi giả"
        self.fail_unknown = False
        self.deploy_output = None
        self.updated_after = None        # updated_at (ms) Supabase trả sau deploy; None = lúc deploy
        self.web = ["c0ffee0 Them bang b", "c0ffee1 Edge ham-a"]
        self.diff_names = ["supabase/b_v1.sql", "index.html"]
        self.order = ["a_v1.sql", "b_v1.sql", "c_v1.sql"]
        self.head_files = {
            "supabase/a_v1.sql": SQL_A.encode(), "supabase/b_v1.sql": SQL_B.encode(), "supabase/c_v1.sql": SQL_C.encode(),
            "supabase/functions/ham-a/index.ts": EDGE_A.encode(),
            "extension/inside-po-connector/manifest.json": MANIFEST, "workstation-agent/VERSION": b"9.9.9\n",
        }
        self.worktree: dict[str, bytes] = {}
        self.old_files: dict[tuple[str, str], bytes] = {}   # (commit trong sổ, đường dẫn) → nội dung bản cũ; thiếu = không có trên máy
        self.scripts = {"scripts/deploy_ham_a.py"}
        self.ledger_exists = True
        self.ledger = {
            ("migration", "a_v1.sql"): self.row("migration", "a_v1.sql", sha(SQL_A), None),
            ("edge", "ham-a"): self.row("edge", "ham-a", "0" * 64, "v4"),
            ("extension", "inside-po-connector"): self.row("extension", "inside-po-connector", None, VER_OLD),
        }
        self.db = {"table": {"bang_a"}, "function": set(), "index": set(), "trigger": set(), "cron": set()}
        self.apply_objects = True
        self.kiem_override: dict[str, object] = {}
        self.fail_when = None            # hàm(sql) → True: câu đó lỗi Management API
        self.functions = {"ham-a": {"slug": "ham-a", "version": 4, "updated_at": NOW_MS - 86_400_000, "status": "ACTIVE"}}
        self.bodies = {"ham-a": bundle("bản cũ của hàm ham-a giả")}
        self.body_after = {"ham-a": bundle(*EDGE_A_STRINGS)}
        self.version_step = 1
        self.status_after = "ACTIVE"
        self.deploy_code = 0
        self.devices = None              # None = chưa có bảng sync_auto_devices
        self.commit_ct = {}
        self.tick = 0
        for key, value in overrides.items():
            setattr(self, key, value)
        return self

    @staticmethod
    def row(kind, name, sha256, note, applied=None, by="may-a#00000000"):
        return {"kind": kind, "name": name, "sha256": sha256, "commit_sha": "beef001", "applied_at": iso(applied or NOW - dt.timedelta(days=2)),
                "applied_by": by, "note": note}

    # ---- terminal, đồng hồ, máy
    def isatty(self):
        self.events.append(("isatty",))
        return self.tty

    def ask(self, prompt):
        self.prompts.append(prompt)
        self.events.append(("ask", prompt))
        print(prompt)
        if self.steal_on_prompt and prompt.startswith(self.steal_on_prompt):
            self.steal()
        if not self.answers:
            return ""                    # như EOF: hết câu trả lời = từ chối
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def steal(self):
        self.ledger[("lock", "release")] = self.row("lock", "release", None, "release.py", applied=NOW, by="may-b#00000001")
        self.events.append(("steal",))

    def pushed(self):
        return [e[1] for e in self.events if e[0] == "git" and e[1][0] == "push"]

    def now(self):
        self.tick += 1
        return NOW + dt.timedelta(seconds=self.tick)

    def host(self):
        return HOST

    def rand(self):
        return "ab12cd34"

    def read_token(self):
        return self.token_value

    def project_ref(self, explicit):
        return explicit or REF

    # ---- git, tiến trình con, tệp
    def git(self, *args, binary=False):
        a = list(args)
        self.events.append(("git", tuple(a)))

        def out(text, code=0):
            return code, (text.encode("utf-8") if binary else text)

        asked_push = any(p.startswith("Push") for p in self.prompts)
        if a[:2] == ["rev-parse", "--abbrev-ref"]:
            return out((self.branch_on_push if asked_push and self.branch_on_push else self.branch) + "\n")
        if a == ["rev-parse", "HEAD"]:
            return out((OTHER_HEAD if asked_push and self.move_head_on_push else HEAD) + "\n")
        if a[0] == "cat-file":
            return (0 if a[-1].partition(":")[2] in self.committed else 128), (b"" if binary else "")
        if a[:2] == ["rev-parse", "--short"]:
            return out("beef001\n")
        if a[0] == "status":
            return out(self.dirty)
        if a[:2] == ["rev-list", "--count"]:
            return out(f"{self.behind}\n")
        if a[:2] == ["rev-list", "--left-right"]:
            return out(f"{len(self.web)}\t{self.behind}\n")
        if a[0] == "rev-list":
            return out("".join(f"{index:040x}\n" for index in range(len(self.web))))
        if a[0] == "log" and "--oneline" in a:
            return out("".join(line + "\n" for line in self.web))
        if a[0] == "log" and "--format=%ct" in a:
            return out(f"{self.commit_ct.get(a[-1], NOW_MS // 1000 - 7 * 86400)}\n")
        if a[0] == "log":
            return out("c0ffee0 Thong diep gia\n")
        if a[0] == "diff" and "--stat" in a:
            if (a[2].split("..")[0], a[-1]) not in self.old_files:
                return out("", 128)
            return out(f" {a[-1]} | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n")
        if a[0] == "diff":
            return out("".join(name + "\n" for name in self.diff_names), self.diff_code)
        if a[0] == "ls-tree":
            prefix = a[-1].rstrip("/") + "/"
            paths = sorted(p for p in self.head_files if p.startswith(prefix))
            if "-r" not in a:
                paths = sorted({prefix + p[len(prefix):].split("/")[0] for p in paths})
            return out("".join(p + "\n" for p in paths))
        if a[0] == "show":
            rev, _sep, path = a[1].partition(":")
            data = self.head_files.get(path) if rev == HEAD else self.old_files.get((rev, path))
            if data is None:
                return 128, (b"" if binary else "")
            return 0, (data if binary else data.decode("utf-8"))
        raise AssertionError(f"git ngoài kịch bản: {a}")

    def git_live(self, *args):
        self.events.append(("git", tuple(args)))
        if args[0] == "fetch":
            return self.fetch_code
        if args[0] == "push":
            return self.push_code
        raise AssertionError(f"git ngoài kịch bản: {args}")

    def run(self, command):
        self.events.append(("run", tuple(command)))
        joined = " ".join(command).replace("\\", "/")
        if "commit_gate.py" in joined:
            return self.gate_code, ("KHÔNG ĐẠT [giả] mục 2" if self.gate_code else "Đủ điều kiện commit")
        match = re.search(r"scripts/deploy_([a-z0-9_]+)\.py", joined)
        if not match:
            raise AssertionError(f"tiến trình ngoài kịch bản: {command}")
        slug = match.group(1).replace("_", "-")
        if self.deploy_code:
            return self.deploy_code, self.deploy_output or "Management API HTTP 500: lỗi giả"
        fn = self.functions.setdefault(slug, {"slug": slug, "version": 0, "status": "ACTIVE"})
        fn["version"] = int(fn.get("version") or 0) + self.version_step
        fn["updated_at"] = self.updated_after if self.updated_after is not None else int(self.now().timestamp() * 1000)
        fn["status"] = self.status_after
        self.bodies[slug] = self.body_after.get(slug, b"")
        return 0, f"Đã triển khai {slug} — phiên bản {fn['version']} — trạng thái {fn['status']}."

    def exists(self, rel):
        return rel in self.scripts

    def worktree_bytes(self, rel):
        return self.worktree.get(rel, self.head_files.get(rel))

    def migration_order(self):
        return list(self.order)

    # ---- Supabase
    def query(self, sql):
        self.events.append(("query", sql))
        if self.fail_when and self.fail_when(sql):
            raise self.R.ApiError(self.fail_message, unknown=self.fail_unknown)
        s = " ".join(sql.split())
        if s.startswith("select to_regclass('public.release_ledger') is not null"):
            return [{"ok": self.ledger_exists}]
        if s.startswith("select kind, name, sha256"):
            return [dict(row) for _key, row in sorted(self.ledger.items())]
        if s.startswith("insert into public.release_ledger as l"):
            return self._lock_take(s)
        if s.startswith("update public.release_ledger set applied_at = now()"):
            return self._lock_touch(s, delete=False)
        if s.startswith("delete from public.release_ledger where kind = 'lock'"):
            return self._lock_touch(s, delete=True)
        if s.startswith("select applied_by, applied_at from public.release_ledger"):
            lock = self.ledger.get(("lock", "release"))
            return [{"applied_by": lock["applied_by"], "applied_at": lock["applied_at"]}] if lock else []
        if s.startswith("insert into public.release_ledger (kind"):
            return self._write(s)
        if "'function', (select" in s:
            return [{"status": json.dumps({
                "function": sorted(self.db["function"]), "table": sorted(self.db["table"]), "index": sorted(self.db["index"]),
                "trigger": sorted(self.db["trigger"]), "cron": [{"name": n, "schedule": "0 20 * * *", "active": True} for n in sorted(self.db["cron"])],
                "agents": [], "leases": []})}]
        if "from public.sync_auto_devices" in s:
            if self.devices is None:
                raise self.R.ApiError("Management API HTTP 400: relation \"public.sync_auto_devices\" does not exist")
            return [{"status": {"devices": self.devices, "min_extension": {}}}]
        if s.lower().startswith("select"):
            if sql in self.kiem_override:
                return [{"ok": self.kiem_override[sql]}]
            table = re.search(r"to_regclass\('public\.(\w+)'\)", s)
            return [{"ok": (table.group(1) in self.db["table"]) if table else ("select true" in s)}]
        return self._migrate(sql)

    def _migrate(self, sql):
        if self.apply_objects:
            for _pos, action, kind, name in live.sql_objects(sql):
                (self.db[kind].add if action == "create" else self.db[kind].discard)(name)
        if "public.release_ledger" in sql:
            self.ledger_exists = True
        if self.steal_on_sql and sql == self.steal_on_sql:
            self.steal()
        return []

    def _lock_take(self, s):
        holder = re.search(r"values \('lock', 'release', '((?:[^']|'')*)'", s).group(1)
        lock = self.ledger.get(("lock", "release"))
        guard = re.search(r"where l\.applied_at < now\(\) - interval '(\d+) minutes'", s)
        if lock and guard:
            since = dt.datetime.fromisoformat(lock["applied_at"])
            if NOW - since < dt.timedelta(minutes=int(guard.group(1))):
                return []
        self.ledger[("lock", "release")] = self.row("lock", "release", None, "release.py", applied=NOW, by=holder)
        if self.on_lock:
            self.on_lock(self)
        return [{"applied_by": holder}]

    def _lock_touch(self, s, delete):
        holder = re.search(r"applied_by = '((?:[^']|'')*)'", s).group(1)
        lock = self.ledger.get(("lock", "release"))
        if not lock or lock["applied_by"] != holder:
            return []
        if delete:
            del self.ledger[("lock", "release")]
        else:
            lock["applied_at"] = iso(NOW)
        return [{"applied_by": holder}]

    def _write(self, s):
        written = []
        for match in TUPLE.finditer(s.split(" values ", 1)[1]):
            kind, name, sha256, commit, by, note = [None if f.group(0) == "null" else f.group(1).replace("''", "'") for f in FIELD.finditer(match.group(1))]
            if " do nothing" in s and (kind, name) in self.ledger:
                continue
            self.ledger[(kind, name)] = {"kind": kind, "name": name, "sha256": sha256, "commit_sha": commit, "applied_at": iso(self.now()),
                                         "applied_by": by, "note": note}
            self.events.append(("write", kind, name))
            written.append({"kind": kind, "name": name})
        return written

    def api(self, path, raw=False):
        self.events.append(("api", path))
        match = re.fullmatch(r"/functions/([a-z0-9-]+)(/body)?", path)
        if not match:
            raise AssertionError(f"API ngoài kịch bản: {path}")
        if match.group(2):
            return self.bodies.get(match.group(1))
        fn = self.functions.get(match.group(1))
        return dict(fn) if fn else None

    def edge_list(self):
        self.events.append(("api", "/functions"))
        return [dict(fn) for fn in self.functions.values()]


class Case(unittest.TestCase):
    R = R  # module đang thử; phần đột biến cuối tệp thay bằng bản đã sửa

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

        def blocked(*_args, **_kwargs):
            raise AssertionError("test không được gọi mạng / tiến trình / .env / input thật")

        for target in (mock.patch.object(supa, "urlopen", blocked), mock.patch.object(live, "urlopen", blocked),
                       mock.patch.object(supa, "read_token", blocked), mock.patch.object(subprocess, "run", blocked),
                       mock.patch.object(subprocess, "Popen", blocked), mock.patch("builtins.input", blocked)):
            target.start()
            self.addCleanup(target.stop)
        if hasattr(self.R, "urlopen"):
            patcher = mock.patch.object(self.R, "urlopen", blocked)
            patcher.start()
            self.addCleanup(patcher.stop)

    def fake(self, **overrides):
        cls = type("FakeCtx", (FakeMixin, self.R.Ctx), {})
        return cls().setup(self.R, Path(self.tmp.name), **overrides)

    def main(self, argv, ctx):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.R.main(argv, ctx)
        self.out = out.getvalue() + err.getvalue()
        return code

    def reports(self):
        return sorted(Path(self.tmp.name).glob("release-*.md"))

    def kinds(self, ctx, kind):
        return [e for e in ctx.events if e[0] == kind]

    def index(self, ctx, predicate, last=False):
        hits = [i for i, e in enumerate(ctx.events) if predicate(e)]
        self.assertTrue(hits, "không thấy sự kiện cần tìm")
        return hits[-1] if last else hits[0]

    def ran(self, ctx, text):
        return any(e[0] == "query" and e[1] == text for e in ctx.events)

    def assert_no_token(self, ctx):
        self.assertNotIn(TOKEN, self.out)
        self.assertNotIn(TOKEN, repr(ctx.events))
        for report in self.reports():
            self.assertNotIn(TOKEN, report.read_text(encoding="utf-8"))


# ===================================================================== hàm thuần
class Hashing(Case):
    def test_sha256_after_crlf_to_lf(self):
        self.assertEqual(self.R.content_sha(b"select 1;\r\nselect 2;\r\n"), self.R.content_sha(b"select 1;\nselect 2;\n"))
        self.assertEqual(self.R.content_sha("a\r\nb"), hashlib.sha256(b"a\nb").hexdigest())
        self.assertNotEqual(self.R.content_sha(b"a\nb"), self.R.content_sha(b"a\nc"))


class Header(Case):
    SQL = ("-- Tiêu đề tệp\n-- kiem: select 1 = 1 as ok\n-- KIEM : select true as ok;\n"
           "-- Rút lui (cổng mở lại ngay):\n--   update public.x set y = 1;\n--   drop table if exists public.z;\n"
           "-- Lệnh: python scripts/release.py --apply\n--   (dòng thụt sau mục khác, không thuộc rút lui)\n"
           "begin;\n-- kiem: select false as ok\ncommit;\n")

    def test_kiem_and_rollback_block(self):
        head = self.R.parse_header(self.SQL)
        self.assertEqual(head.kiem, ["select 1 = 1 as ok", "select true as ok;"])   # dòng sau begin; không tính
        self.assertEqual(head.rollback, ["-- Rút lui (cổng mở lại ngay):", "--   update public.x set y = 1;", "--   drop table if exists public.z;"])
        self.assertEqual(len(head.lines), 8)

    def test_rollback_with_or_without_marks_any_case(self):
        for title in ("-- Rut lui:", "-- RÚT LUI", "-- rút lui: chạy tay", "-- Rút lui (NFD)"):
            head = self.R.parse_header(f"-- x\n{title}\n--   drop table a;\n-- khác\nbegin;\n")
            self.assertEqual(len(head.rollback), 2, title)
            self.assertEqual(head.rollback[1], "--   drop table a;")
        self.assertEqual(self.R.parse_header("-- không có\nbegin;\n").rollback, [])

    def test_crlf_header(self):
        head = self.R.parse_header(self.SQL.replace("\n", "\r\n"))
        self.assertEqual(head.kiem[0], "select 1 = 1 as ok")


class Literals(Case):
    def lits(self, source):
        return self.R.string_literals(source)

    def test_quotes_and_escapes(self):
        source = ("const a = 'it\\'s a long string here';\nconst b = \"say \\\"hi\\\" to everyone ok\";\n"
                  "const c = \"ngắn\";\n// \"chuỗi trong chú thích dài\"\n/* 'chuỗi trong khối chú thích' */\n"
                  "const d = \"Phiên Admin không hợp lệ\";\n")
        found, certain = self.lits(source)
        self.assertTrue(certain)
        self.assertEqual(found, ["it\\'s a long string here", 'say \\"hi\\" to everyone ok', "Phiên Admin không hợp lệ"])

    def test_template_bodies_skipped_like_print_assistant_and_sku_vision(self):
        # Mô phỏng prompt nhiều dòng trong backtick chứa nháy kép / nháy đơn (print-assistant, sku-vision).
        source = ("const SYSTEM = `Bạn là trợ lý in tem.\nTrả về JSON {\"intent\": \"print_it\", \"reply\": \"Câu trả lời ngắn gọn\"}.\n"
                  "Don't print directly; nếu thiếu số phiếu thì hỏi lại \"Số phiếu IT là gì?\"\n`;\n"
                  "const PROMPT = `Đọc tem: ${items.map((item) => `${item.sku} \"x\"`).join(\", \")} — ${label ?? \"không có nhãn đâu\"}`;\n"
                  "const fallback = itNumber ? `Đọc phiếu IT ${itNumber}.` : \"Số phiếu IT là gì đó?\";\n"
                  "const MSG = 'Trợ lý AI đang bận; thử lại sau';\n")
        found, certain = self.lits(source)
        self.assertTrue(certain)
        self.assertEqual(found, ["Số phiếu IT là gì đó?", "Trợ lý AI đang bận; thử lại sau"])

    def test_regex_literals_with_quotes_and_division(self):
        source = ("const values = skus.map(value => `\"${value.replace(/[\"\\\\]/g, \"\")}\"`).join(\",\");\n"
                  "if (!/^Bearer\\s+\\S+$/i.test(authorization)) throw new Error(\"AUTH:Phiên Admin không hợp lệ\");\n"
                  "const half = total / 2 / count;\nconst re = /'[^']*'/g;\n"
                  "const text = \"INVALID_RUN:Mã lượt không hợp lệ\";\n")
        found, certain = self.lits(source)
        self.assertTrue(certain)
        self.assertEqual(found, ["AUTH:Phiên Admin không hợp lệ", "INVALID_RUN:Mã lượt không hợp lệ"])

    def test_unterminated_or_ambiguous_is_unsure(self):
        for source in ('const x = "chuỗi chưa đóng thật dài\n;', "const t = `chưa đóng thật dài", "/* chưa đóng", EDGE_A_UNSURE):
            self.assertFalse(self.lits(source)[1], source[:30])

    def test_type_declarations_and_imports_skipped(self):
        source = ('import { x } from "https://esm.sh/thu-vien-gia@1.0.0";\n'
                  'type Kind = "loai-dai-hon-muoi-bon" | "loai-khac-cung-dai";\n'
                  'interface Item { kind: "kieu-trong-interface-dai"; }\n'
                  'export type Meta = { provider: "nha-cung-cap-dai-ten" };\n'
                  'const real = "đây là chuỗi thật dài";\n')
        found, certain = self.lits(source)
        self.assertTrue(certain)
        self.assertEqual(found, ["đây là chuỗi thật dài"])

    def test_four_real_edge_sources_are_certain(self):
        for path in sorted((ROOT / "supabase" / "functions").glob("*/index.ts")):
            found, certain = self.lits(path.read_text(encoding="utf-8"))
            self.assertTrue(certain, path.parent.name)
            self.assertTrue(found, path.parent.name)
            self.assertFalse([s for s in found if "\n" in s or "`" in s or len(s) < 14], path.parent.name)

    def test_fingerprint_verdicts(self):
        ok = self.R.fingerprint(EDGE_A, bundle(*EDGE_A_STRINGS))
        self.assertEqual(ok, ("ok", [], 3))
        missing = self.R.fingerprint(EDGE_A, bundle(*EDGE_A_STRINGS[:2]))
        self.assertEqual(missing, ("missing", ["Đã nhận yêu cầu in tem"], 3))
        self.assertEqual(self.R.fingerprint(EDGE_A_UNSURE, b"")[0], "unsure")
        self.assertEqual(self.R.fingerprint(EDGE_A, None)[0], "unsure")
        self.assertEqual(self.R.fingerprint("const a = 1;\n", b"x")[0], "none")
        escaped = "const q = 'Không được \\'gõ\\' sai đâu nhé';\n"
        self.assertEqual(self.R.fingerprint(escaped, "Không được 'gõ' sai đâu nhé".encode())[0], "ok")


class SqlAndNames(Case):
    def test_literal_quoting(self):
        self.assertEqual(self.R.lit("a'b"), "'a''b'")
        self.assertEqual(self.R.lit(None), "null")

    def test_lock_sql_is_single_conditional_upsert(self):
        sql = " ".join(self.R.lock_take_sql(HOLDER).split())
        self.assertRegex(sql, r"^insert into public\.release_ledger as l .*values \('lock', 'release', 'may-a#ab12cd34'")
        self.assertIn("on conflict (kind, name) do update set applied_at = now()", sql)
        self.assertIn("where l.applied_at < now() - interval '30 minutes' returning applied_by", sql)
        self.assertEqual(sql.count(";"), 0)

    def test_reads_pass_select_only(self):
        for sql in (self.R.LEDGER_SQL, self.R.LEDGER_EXISTS_SQL, self.R.LOCK_READ_SQL):
            live.select_only(sql)

    def test_slug_to_deploy_script(self):
        self.assertEqual(self.R.deploy_script("sku-sync"), "scripts/deploy_sku_sync.py")
        for slug in ("sku-sync", "group-uid-sync", "print-assistant", "sku-vision"):
            self.assertTrue((ROOT / self.R.deploy_script(slug)).is_file(), slug)

    def test_destructive_and_definer_flags(self):
        mig = self.R.Migration("d_v1.sql", SQL_D, sha(SQL_D))
        self.assertEqual(mig.risky, ["DROP"])
        self.assertFalse(self.R.Migration("b_v1.sql", SQL_B, sha(SQL_B)).risky)   # drop trong chú thích Rút lui không tính
        self.assertTrue(self.R.Migration("c_v1.sql", SQL_C, sha(SQL_C)).definer)
        self.assertFalse(self.R.Migration("a_v1.sql", SQL_A, sha(SQL_A)).definer)


# Mục 2 review vòng 1: câu phá huỷ chạy NGAY trong khối DO (và SQL động) phải đòi gõ tên tệp; thân create function thì không.
DO_FILES = ["db_hygiene_v1.sql", "group_uid_sync_v2_products.sql", "sku_missing_archive_v1.sql", "sku_po_receipts_v1.sql",
            "sku_sync_full_v1.sql", "sync_auto_v1.sql", "sync_auto_v2.sql", "uid_block_auto_v1.sql"]


class Destructive(Case):
    def risky(self, sql):
        return self.R.Migration("z_v1.sql", sql, sha(sql)).risky

    def test_do_block_delete_needs_name_function_body_does_not(self):
        self.assertIn("DELETE FROM", self.risky("begin;\ndo $$ begin delete from public.bang_a where id < 0; end $$;\ncommit;\n"))
        self.assertIn("TRUNCATE", self.risky("do $body$\nbegin\n  truncate public.bang_a;\nend\n$body$;\n"))
        self.assertEqual(self.risky("create or replace function public.don() returns void language plpgsql as $$\n"
                                    "begin delete from public.bang_a; end $$;\n"), [])
        self.assertEqual(self.risky("create procedure public.don2() language plpgsql as $p$ begin truncate public.bang_a; end $p$;\n"), [])
        self.assertEqual(self.risky("select cron.schedule('viec-gia', '0 20 * * *', $$select public.don()$$);\n"), [])

    def test_execute_inside_do_is_flagged_fail_closed(self):
        flags = self.risky("do $$ begin execute format('select %s', 1); end $$;\n")
        self.assertIn("EXECUTE động trong DO", flags)
        self.assertEqual(self.risky("create trigger trg after insert on public.bang_a for each row execute function public.don();\n"), [])

    def test_more_drop_kinds(self):
        for kind in ("materialized view public.mv_gia", "sequence public.seq_gia", "extension pg_gia", "role vai_gia",
                     "procedure public.don2()", "domain public.kieu_gia", "publication pub_gia"):
            self.assertIn("DROP", self.risky(f"drop {kind};\n"), kind)
        self.assertEqual(self.risky("-- drop materialized view public.mv_gia;\nselect 1;\n"), [])

    def test_real_do_files_only_sku_sync_full_gets_new_flag(self):
        for name in DO_FILES:
            sql = (ROOT / "supabase" / name).read_text(encoding="utf-8-sig")
            old = supa.destructive_statements(sql)
            new = self.risky(sql)
            self.assertTrue(set(old) <= set(new), name)
            if name == "sku_sync_full_v1.sql":
                self.assertIn("EXECUTE động trong DO", new)
                self.assertIn("ALTER TABLE ... DROP", new)
            else:
                self.assertEqual(new, old, name)

    def test_do_delete_file_needs_typed_name_in_gate(self):
        sql_do = "-- h_v1: dọn bằng khối DO\n-- kiem: select true as ok\nbegin;\ndo $$ begin delete from public.bang_a where id < 0; end $$;\ncommit;\n"
        for answer, expected in (("y", 1), ("h_v1.sql", 0)):
            ctx = self.fake(answers=["y", answer], order=["a_v1.sql", "h_v1.sql"], web=[])
            ctx.head_files = {"supabase/a_v1.sql": SQL_A.encode(), "supabase/h_v1.sql": sql_do.encode(),
                              "extension/inside-po-connector/manifest.json": MANIFEST}
            ctx.ledger[("extension", "inside-po-connector")]["note"] = VER_HEAD
            self.assertEqual(self.main(["--apply"], ctx), expected, (answer, self.out))
            self.assertEqual(self.ran(ctx, sql_do), expected == 0)


class Report(Case):
    def test_render_report_sections(self):
        text = self.R.render_report({
            "title": "26/10/2026 16:00", "mode": "apply", "result": "ĐẠT", "head": "c0ffee0", "holder": HOLDER, "ref": REF,
            "preflight": ["- Nhánh main"], "plan": ["Kế hoạch phát hành — HEAD c0ffee0"], "steps": ["- 16:00:01 Migration b_v1.sql: đạt"],
            "before": ["- Migration: 1 tệp"], "after": ["- Migration: 2 tệp"], "live": "## Trạng thái lên thật (live_status.py, 26/10/2026 16:01)\n",
            "rules": "- [N20261026-1600] **26/10/2026 — Phát hành**",
        })
        for part in ("# Biên bản phát hành", "## Preflight", "## Kế hoạch", "## Các bước", "## Sổ trước", "## Sổ sau",
                     "## Trạng thái lên thật", "## Dòng RULES.md", "[N20261026-1600]", "b_v1.sql"):
            self.assertIn(part, text)
        self.assertLess(text.index("## Sổ trước"), text.index("## Sổ sau"))


# ===================================================================== cờ, terminal
class ArgsAndTerminal(Case):
    def test_yes_flag_does_not_exist(self):
        for argv in (["--yes"], ["--apply", "--yes"], ["--init", "--yes"], ["-y"]):
            ctx = self.fake()
            self.assertEqual(self.main(argv, ctx), 2, argv)
            self.assertIn("Không có cờ --yes", self.out)
            self.assertFalse([e for e in ctx.events if e[0] in ("git", "query", "api", "run", "ask")])

    def test_abbreviations_and_bad_combos_rejected(self):
        for argv in (["--app"], ["--status", "--rerun", "a_v1.sql"], ["--init", "--only", "edge"], ["--plan", "--apply"]):
            self.assertEqual(self.main(argv, self.fake()), 2, argv)

    def test_no_terminal_exits_2_before_anything(self):
        for argv in (["--apply"], ["--init"]):
            ctx = self.fake(tty=False, answers=["y"] * 10)
            self.assertEqual(self.main(argv, ctx), 2)
            self.assertIn("terminal", self.out)
            self.assertFalse([e for e in ctx.events if e[0] in ("git", "query", "api", "run", "ask")])
            self.assertEqual(self.reports(), [])

    def test_default_is_plan_and_read_only(self):
        ctx = self.fake()
        self.assertEqual(self.main([], ctx), 0)
        self.assertIn("Kế hoạch phát hành", self.out)
        writes = [e for e in ctx.events if e[0] == "query" and not e[1].lstrip().lower().startswith("select")]
        self.assertEqual(writes, [])
        self.assertFalse([e for e in ctx.events if e[0] in ("run", "ask")])
        self.assertFalse([e for e in ctx.events if e[0] == "git" and e[1][0] in ("fetch", "push")])


# ===================================================================== --plan / --status
class PlanFlow(Case):
    def test_pending_in_fixed_order(self):
        ctx = self.fake(order=["a_v1.sql", "c_v1.sql", "b_v1.sql"])
        self.assertEqual(self.main(["--plan"], ctx), 0)
        parts = ["1. Migration chờ", "c_v1.sql", "b_v1.sql", "2. Edge chờ deploy", "ham-a", "3. Extension", VER_HEAD, "4. Web"]
        positions = [self.out.index(part) for part in parts]
        self.assertEqual(positions, sorted(positions))
        self.assertNotIn("a_v1.sql", self.out)
        self.assertIn("SECURITY DEFINER", self.out)
        self.assert_no_token(ctx)

    def test_plan_reads_head_not_worktree(self):
        ctx = self.fake(worktree={"supabase/b_v1.sql": b"-- ban trong cay lam viec\nselect 1;\n"})
        ctx.token = TOKEN
        plan = self.R.build_plan(ctx, HEAD, ctx.ledger)
        item = next(m for m in plan.migrations if m.name == "b_v1.sql")
        self.assertEqual(item.sql, SQL_B)
        self.assertEqual(item.sha, sha(SQL_B))
        self.assertIn(("git", ("show", f"{HEAD}:supabase/b_v1.sql")), [(e[0], e[1][:2]) if e[0] == "git" else e for e in ctx.events])

    def test_modified_after_run_listed_with_stat_and_accept_hint(self):
        ctx = self.fake(old_files={("beef001", "supabase/a_v1.sql"): SQL_A_OLD_COMMENT.encode()})
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--plan"], ctx), 0)                # --plan vẫn thoát 0
        self.assertIn("1 tệp migration đã sửa sau khi chạy — --apply sẽ dừng (mã 3)", self.out)
        self.assertIn("   ! a_v1.sql", self.out)
        self.assertNotIn("   - a_v1.sql", self.out)                     # không nằm trong danh sách sẽ chạy
        self.assertIn("supabase/a_v1.sql | 2 +-", self.out)          # git diff --stat <commit trong sổ>..<sha>
        self.assertIn(("git", ("diff", "--stat", f"beef001..{HEAD}", "--", "supabase/a_v1.sql")), ctx.events)
        self.assertIn(("git", ("show", "beef001:supabase/a_v1.sql")), [(e[0], e[1][:2]) if e[0] == "git" else e for e in ctx.events])
        self.assertIn("chỉ sửa chú thích: ghi nhận bằng --accept a_v1.sql", self.out)
        self.assertNotIn("Không có việc chờ", self.out)

    def test_modified_hint_rerun_when_sql_changed_or_old_unreadable(self):
        ctx = self.fake(old_files={("beef001", "supabase/a_v1.sql"): SQL_A_OLD_CONTENT.encode()})
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--plan"], ctx), 0)
        self.assertIn("nội dung SQL đã đổi: chạy lại bằng --rerun a_v1.sql", self.out)
        self.assertIn("--accept sẽ KHÔNG đưa phần sửa lên database", self.out)
        self.assertNotIn("ghi nhận bằng --accept", self.out)
        ctx = self.fake()                                               # commit trong sổ không có trên máy
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--plan"], ctx), 0)
        self.assertIn("không đọc được bản cũ (commit beef001)", self.out)
        self.assertIn("--rerun a_v1.sql", self.out)

    def test_only_modified_files_is_not_nothing_pending(self):
        ctx = self.fake(web=[], order=["a_v1.sql"])
        del ctx.head_files["supabase/b_v1.sql"], ctx.head_files["supabase/c_v1.sql"]
        ctx.ledger[("edge", "ham-a")]["sha256"] = sha(EDGE_A)
        ctx.ledger[("extension", "inside-po-connector")]["note"] = VER_HEAD
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--plan"], ctx), 0)
        self.assertNotIn("Không có việc chờ", self.out)
        self.assertIn("1 tệp migration đã sửa sau khi chạy — --apply sẽ dừng (mã 3)", self.out)

    def test_status_lists_modified_files(self):
        ctx = self.fake(old_files={("beef001", "supabase/a_v1.sql"): SQL_A_OLD_COMMENT.encode()})
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--status"], ctx), 0)
        self.assertIn("1 tệp migration đã sửa sau khi chạy — --apply sẽ dừng (mã 3)", self.out)
        self.assertIn("--accept a_v1.sql", self.out)

    def test_no_token_exit_3_clear_message(self):
        ctx = self.fake(token_value="")
        self.assertEqual(self.main(["--plan"], ctx), 3)
        self.assertIn("Thiếu SUPABASE_ACCESS_TOKEN", self.out)
        self.assertFalse([e for e in ctx.events if e[0] in ("query", "api")])

    def test_missing_ledger_exit_3(self):
        ctx = self.fake(ledger_exists=False)
        self.assertEqual(self.main(["--plan"], ctx), 3)
        self.assertIn("--init", self.out)

    def test_nothing_pending(self):
        ctx = self.fake(web=[], order=["a_v1.sql"])
        del ctx.head_files["supabase/b_v1.sql"], ctx.head_files["supabase/c_v1.sql"]
        ctx.ledger[("edge", "ham-a")]["sha256"] = sha(EDGE_A)
        ctx.ledger[("extension", "inside-po-connector")]["note"] = VER_HEAD
        self.assertEqual(self.main(["--plan"], ctx), 0)
        self.assertIn("Không có việc chờ.", self.out)
        ctx.answers = []
        self.assertEqual(self.main(["--apply"], ctx), 0)
        self.assertIn("Không có việc chờ.", self.out)
        self.assertFalse([e for e in ctx.events if e[0] == "write"])

    def test_status_prints_ledger_and_lock(self):
        ctx = self.fake()
        ctx.ledger[("lock", "release")] = FakeMixin.row("lock", "release", None, "release.py", applied=NOW - dt.timedelta(minutes=5), by="may-b#00000001")
        self.assertEqual(self.main(["--status"], ctx), 0)
        for part in ("Migration: 1 tệp", "ham-a", VER_OLD, "may-b#00000001"):
            self.assertIn(part, self.out)

    def test_example_sql_is_never_a_migration(self):
        ctx = self.fake(order=list(ORDER_WITH_EXAMPLE))
        ctx.head_files["supabase/x.example.sql"] = SQL_EXAMPLE.encode()
        ctx.head_files["supabase/y.sql"] = SQL_E.encode()
        # sổ cũ lỡ có dòng tệp ví dụ với sha khác: không được báo "đã sửa sau khi chạy", không được đếm ở --status
        ctx.ledger[("migration", "x.example.sql")] = FakeMixin.row("migration", "x.example.sql", "f" * 64, None)
        self.assertEqual(self.main(["--plan"], ctx), 0)
        self.assertIn("   - y.sql", self.out)
        self.assertNotIn("x.example.sql", self.out)
        plan = self.R.build_plan(ctx, HEAD, ctx.ledger)
        self.assertEqual([name for name, _sql in plan.files], ["a_v1.sql", "b_v1.sql", "c_v1.sql", "y.sql"])
        self.assertEqual(plan.changed, [])
        self.assertEqual(self.main(["--status"], ctx), 0)
        self.assertIn("Migration: 1 tệp", self.out)
        self.assertNotIn("x.example.sql", self.out)
        self.assertEqual(self.main(["--plan", "--rerun", "x.example.sql"], ctx), 2)


# ===================================================================== --apply
ALL_YES = ["y", "y", "y", "y", "y", "y"]   # cả bộ test, b_v1, c_v1, Edge ham-a, Extension, push
PUSH = ("push", "origin", f"{HEAD}:refs/heads/main")


class ApplyFlow(Case):
    def happy(self, **overrides):
        overrides.setdefault("answers", list(ALL_YES))
        ctx = self.fake(**overrides)
        code = self.main(["--apply"], ctx)
        return ctx, code

    def test_happy_path_fixed_order_and_ledger_after_verification(self):
        ctx, code = self.happy()
        self.assertEqual(code, 0, self.out)
        ran_b = self.index(ctx, lambda e: e[0] == "query" and e[1] == SQL_B)
        ran_c = self.index(ctx, lambda e: e[0] == "query" and e[1] == SQL_C)
        kiem_b = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("select to_regclass('public.bang_b')"))
        write_b = self.index(ctx, lambda e: e == ("write", "migration", "b_v1.sql"))
        write_c = self.index(ctx, lambda e: e == ("write", "migration", "c_v1.sql"))
        deploy = self.index(ctx, lambda e: e[0] == "run" and "deploy_ham_a.py" in " ".join(e[1]))
        body = self.index(ctx, lambda e: e == ("api", "/functions/ham-a/body"))
        write_edge = self.index(ctx, lambda e: e == ("write", "edge", "ham-a"))
        write_ext = self.index(ctx, lambda e: e == ("write", "extension", "inside-po-connector"))
        push = self.index(ctx, lambda e: e == ("git", PUSH))
        self.assertEqual(ctx.pushed(), [PUSH])          # đúng commit đã kiểm, không force, đúng nhánh
        lock = self.index(ctx, lambda e: e[0] == "query" and "insert into public.release_ledger as l" in e[1])
        unlock = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("delete from public.release_ledger"), last=True)
        self.assertTrue(lock < ran_b < kiem_b < write_b < ran_c < write_c < deploy < body < write_edge < write_ext < push < unlock)
        self.assertEqual(ctx.ledger[("migration", "b_v1.sql")]["sha256"], sha(SQL_B))
        self.assertEqual(ctx.ledger[("migration", "b_v1.sql")]["applied_by"], HOLDER)
        self.assertEqual(ctx.ledger[("migration", "b_v1.sql")]["commit_sha"], HEAD[:7])
        self.assertEqual(ctx.ledger[("edge", "ham-a")]["sha256"], sha(EDGE_A))
        self.assertEqual(ctx.ledger[("edge", "ham-a")]["note"], "v5")
        self.assertEqual(ctx.ledger[("extension", "inside-po-connector")]["note"], VER_HEAD)
        self.assertNotIn(("lock", "release"), ctx.ledger)
        self.assertIn("SECURITY DEFINER", self.out)
        self.assertIn("Rút lui", self.out)
        self.assert_no_token(ctx)

    def test_report_written_with_all_sections(self):
        ctx, code = self.happy()
        self.assertEqual(code, 0, self.out)
        reports = self.reports()
        self.assertEqual([p.name for p in reports], ["release-20261026-1600.md"])
        text = reports[0].read_text(encoding="utf-8")
        for part in ("## Preflight", "Cây làm việc sạch", "commit_gate", "## Kế hoạch", "## Các bước", "b_v1.sql", "ham-a",
                     "## Sổ trước", "## Sổ sau", "## Trạng thái lên thật", "**ĐÃ LÊN — migration:**", "[N20261026-1600]", "ĐẠT"):
            self.assertIn(part, text)
        after = text[text.index("## Sổ sau"):]
        self.assertIn("b_v1.sql", after)
        self.assertNotIn(TOKEN, text)

    def test_reads_head_not_worktree(self):
        ctx, code = self.happy(worktree={"supabase/b_v1.sql": b"-- ban trong cay lam viec\ncreate table public.sai (id int);\n"})
        self.assertEqual(code, 0, self.out)
        self.assertTrue(self.ran(ctx, SQL_B))
        self.assertFalse([e for e in ctx.events if e[0] == "query" and "public.sai" in e[1]])
        self.assertEqual(ctx.ledger[("migration", "b_v1.sql")]["sha256"], sha(SQL_B))

    def test_kiem_false_stops_without_ledger_and_prints_rollback(self):
        kiem = "select to_regclass('public.bang_b') is not null as ok"
        ctx, code = self.happy(kiem_override={kiem: False})
        self.assertEqual(code, 1)
        self.assertTrue(self.ran(ctx, SQL_B))
        self.assertNotIn(("migration", "b_v1.sql"), ctx.ledger)
        self.assertFalse([e for e in ctx.events if e[0] == "write"])
        self.assertIn("--   drop table if exists public.bang_b;", self.out)
        self.assertFalse(self.ran(ctx, SQL_C))
        self.assertFalse([e for e in ctx.events if e[0] in ("run",) and "deploy" in " ".join(e[1])])
        self.assertEqual(ctx.pushed(), [])
        self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_missing_objects_stop_without_ledger(self):
        ctx, code = self.happy(apply_objects=False, kiem_override={"select to_regclass('public.bang_b') is not null as ok": True})
        self.assertEqual(code, 1)
        self.assertIn("table bang_b", self.out)
        self.assertNotIn(("migration", "b_v1.sql"), ctx.ledger)

    def test_file_without_kiem_is_weak_but_recorded(self):
        ctx = self.fake(answers=["y", "y", "y", "y", "y", "y", "y"], order=["a_v1.sql", "b_v1.sql", "c_v1.sql", "e_v1.sql"])
        ctx.head_files["supabase/e_v1.sql"] = SQL_E.encode()
        self.assertEqual(self.main(["--apply"], ctx), 0, self.out)
        self.assertIn("xác minh yếu", self.out)
        self.assertIn(("migration", "e_v1.sql"), ctx.ledger)

    def test_destructive_file_needs_its_exact_name(self):
        for answer, expected in (("y", 1), ("D_V1.SQL", 1), ("d_v1.sql", 0)):
            ctx = self.fake(answers=["y", answer], order=["a_v1.sql", "d_v1.sql"], web=[], diff_names=["supabase/d_v1.sql"])
            ctx.head_files = {k: v for k, v in ctx.head_files.items() if not k.startswith("supabase/") or k == "supabase/a_v1.sql"}
            ctx.head_files["supabase/d_v1.sql"] = SQL_D.encode()
            ctx.ledger[("extension", "inside-po-connector")]["note"] = VER_HEAD
            ctx.ledger.pop(("edge", "ham-a"))
            self.assertEqual(self.main(["--apply"], ctx), expected, (answer, self.out))
            self.assertIn("DROP", self.out)
            self.assertEqual(self.ran(ctx, SQL_D), expected == 0, answer)
            self.assertEqual(("migration", "d_v1.sql") in ctx.ledger, expected == 0)

    def test_destructive_allowance_is_per_file(self):
        sql_f = "-- f_v1: dọn tiếp\n-- kiem: select true as ok\nbegin;\ndelete from public.bang_a;\ncommit;\n"
        ctx = self.fake(answers=["y", "d_v1.sql", "y"], order=["a_v1.sql", "d_v1.sql", "f_v1.sql"], web=[])
        ctx.head_files = {"supabase/a_v1.sql": SQL_A.encode(), "supabase/d_v1.sql": SQL_D.encode(), "supabase/f_v1.sql": sql_f.encode(),
                          "extension/inside-po-connector/manifest.json": MANIFEST}
        ctx.ledger[("extension", "inside-po-connector")]["note"] = VER_HEAD
        self.assertEqual(self.main(["--apply"], ctx), 1)
        self.assertTrue(self.ran(ctx, SQL_D))
        self.assertFalse(self.ran(ctx, sql_f))
        self.assertIn("DELETE FROM", self.out)

    def test_decline_stops_and_releases_lock(self):
        ctx = self.fake(answers=["y", "n"])
        self.assertEqual(self.main(["--apply"], ctx), 1)
        self.assertFalse(self.ran(ctx, SQL_B))
        self.assertFalse([e for e in ctx.events if e[0] == "write"])
        self.assertNotIn(("lock", "release"), ctx.ledger)
        self.assertEqual(ctx.pushed(), [])

    def test_tests_question_needs_y(self):
        ctx = self.fake(answers=["n"])
        self.assertEqual(self.main(["--apply"], ctx), 1)
        self.assertIn("cả bộ test", ctx.prompts[0])
        self.assertFalse(self.ran(ctx, SQL_B))

    def test_tests_question_skipped_without_code_files(self):
        ctx = self.fake(answers=ALL_YES[1:], diff_names=["docs/PROJECT_MAP.md"])
        self.assertEqual(self.main(["--apply"], ctx), 0, self.out)
        self.assertFalse([p for p in ctx.prompts if "cả bộ test" in p])
        self.assertIn("Cổng bộ test: bỏ qua (diff không có tệp mã)", self.reports()[0].read_text(encoding="utf-8"))

    def test_tests_question_for_python_and_mjs(self):
        for name in ("scripts/deploy_sku_sync.py", "tests/sku_sync_function.mjs"):
            ctx = self.fake(answers=["n"], diff_names=["docs/PROJECT_MAP.md", name])
            self.assertEqual(self.main(["--apply"], ctx), 1, name)
            self.assertIn("cả bộ test", ctx.prompts[0])

    def test_tests_gate_fails_closed_when_diff_fails(self):
        ctx = self.fake(answers=list(ALL_YES), diff_code=128)
        self.assertEqual(self.main(["--apply"], ctx), 3)
        self.assertIn("Không đọc được diff origin/main", self.out)
        self.assertFalse(self.ran(ctx, SQL_B))
        self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_lock_held_stops_expired_lock_is_taken(self):
        ctx = self.fake(answers=list(ALL_YES))
        ctx.ledger[("lock", "release")] = FakeMixin.row("lock", "release", None, "release.py", applied=NOW - dt.timedelta(minutes=10), by="may-b#00000001")
        self.assertEqual(self.main(["--apply"], ctx), 3)
        self.assertIn("Khoá phát hành đang do may-b#00000001", self.out)
        self.assertFalse(self.ran(ctx, SQL_B))
        self.assertEqual(ctx.ledger[("lock", "release")]["applied_by"], "may-b#00000001")
        ctx = self.fake(answers=list(ALL_YES))
        ctx.ledger[("lock", "release")] = FakeMixin.row("lock", "release", None, "release.py", applied=NOW - dt.timedelta(minutes=31), by="may-b#00000001")
        self.assertEqual(self.main(["--apply"], ctx), 0, self.out)
        self.assertTrue(self.ran(ctx, SQL_B))

    def test_lock_released_when_migration_fails(self):
        ctx, code = self.happy(fail_when=lambda sql: sql == SQL_B)
        self.assertEqual(code, 1)
        self.assertIn("lỗi giả", self.out)
        self.assertIn("Rút lui", self.out)
        self.assertTrue([e for e in ctx.events if e[0] == "query" and e[1].startswith("delete from public.release_ledger")])
        self.assertNotIn(("lock", "release"), ctx.ledger)
        self.assertFalse([e for e in ctx.events if e[0] == "write"])
        self.assertTrue(self.reports())

    def test_ledger_write_failure_after_run(self):
        ctx, code = self.happy(fail_when=lambda sql: sql.startswith("insert into public.release_ledger (kind"))
        self.assertEqual(code, 1)
        self.assertTrue(self.ran(ctx, SQL_B))
        self.assertIn("ĐÃ CHẠY b_v1.sql nhưng chưa ghi sổ", self.out)
        self.assertIn("chạy lại chỉ an toàn nếu tệp idempotent", self.out)
        self.assertNotIn("chạy lại an toàn vì", self.out)
        self.assertFalse(self.ran(ctx, SQL_C))
        # Mục 5: biên bản ghi câu thật (không phải dòng "!!!"), dòng RULES không coi b_v1.sql là đã xong
        text = self.reports()[0].read_text(encoding="utf-8")
        self.assertRegex(text, r"Dừng: ĐÃ CHẠY b_v1\.sql nhưng chưa ghi sổ")
        self.assertNotRegex(text, r"Dừng: !+")
        rules = next(line for line in text.splitlines() if line.startswith("- [N"))
        self.assertNotIn("migration b_v1.sql", rules)
        self.assertIn("không chạy mục nào", rules)

    def test_migration_unknown_result_is_not_called_unchanged(self):
        ctx, code = self.happy(fail_when=lambda sql: sql == SQL_B, fail_unknown=True,
                               fail_message="Không gọi được Management API: timed out")
        self.assertEqual(code, 1)
        self.assertIn("KẾT QUẢ CHƯA RÕ", self.out)
        self.assertIn("máy chủ có thể đã ghi", self.out)
        self.assertNotIn("database không đổi", self.out)
        self.assertIn("Kiểm chỉ đọc", self.out)                       # gợi ý bằng verify chỉ đọc
        self.assertTrue([e for e in ctx.events if e[0] == "query" and e[1].startswith("select to_regclass('public.bang_b')")])
        self.assertNotIn(("migration", "b_v1.sql"), ctx.ledger)
        self.assertFalse(self.ran(ctx, SQL_C))
        self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_migration_rejected_400_says_unchanged(self):
        ctx, code = self.happy(fail_when=lambda sql: sql == SQL_B)
        self.assertEqual(code, 1)
        self.assertIn("database không đổi", self.out)
        self.assertNotIn("KẾT QUẢ CHƯA RÕ", self.out)

    def test_unexpected_exception_is_reported_not_traceback(self):
        def boom(sql):
            if sql == SQL_C:
                raise RuntimeError("lỗi lạ giả")
            return False
        ctx, code = self.happy(fail_when=boom)
        self.assertEqual(code, 1)
        self.assertNotIn("Traceback", self.out)
        self.assertIn("RuntimeError", self.out)
        self.assertNotIn(("lock", "release"), ctx.ledger)
        self.assertRegex(self.reports()[0].read_text(encoding="utf-8"), r"Dừng: lỗi không lường trước")

    def test_lock_take_error_tries_release(self):
        ctx, code = self.happy(fail_when=lambda sql: sql.startswith("insert into public.release_ledger as l"), fail_unknown=True,
                               fail_message="Không gọi được Management API: timed out")
        self.assertEqual(code, 3)
        self.assertTrue([e for e in ctx.events if e[0] == "query" and e[1].startswith("delete from public.release_ledger where kind = 'lock'")])
        self.assertFalse(self.ran(ctx, SQL_B))

    def test_token_inside_errors_never_printed(self):
        ctx, code = self.happy(fail_when=lambda sql: sql == SQL_B, fail_message=f"Management API HTTP 400: lỗi gần {TOKEN}")
        self.assertEqual(code, 1)
        self.assert_no_token(ctx)
        ctx, code = self.happy(deploy_code=1, deploy_output=f"Traceback giả ... Bearer {TOKEN}")
        self.assertEqual(code, 1)
        self.assert_no_token(ctx)

    def test_ctrl_c_at_gate_releases_lock(self):
        ctx, code = self.happy(answers=["y", KeyboardInterrupt()])
        self.assertEqual(code, 1)
        self.assertIn("Ctrl+C", self.out)
        self.assertNotIn(("lock", "release"), ctx.ledger)
        self.assertFalse(self.ran(ctx, SQL_B))

    def test_kiem_must_be_exactly_true(self):
        kiem = "select to_regclass('public.bang_b') is not null as ok"
        for value in ("t", 1, "true"):
            ctx, code = self.happy(kiem_override={kiem: value})
            self.assertEqual(code, 1, value)
            self.assertNotIn(("migration", "b_v1.sql"), ctx.ledger)

    def test_lock_stolen_between_gates_stops_before_next_step(self):
        ctx, code = self.happy(steal_on_sql=SQL_B)
        self.assertEqual(code, 1)
        self.assertIn("Mất khoá phát hành", self.out)
        self.assertFalse(self.ran(ctx, SQL_C))
        self.assertEqual(ctx.ledger[("lock", "release")]["applied_by"], "may-b#00000001")   # không xoá khoá của máy khác

    def test_lock_stolen_while_asking_push_stops_push(self):
        ctx, code = self.happy(steal_on_prompt="Push")
        self.assertEqual(code, 1)
        self.assertIn("Mất khoá phát hành", self.out)
        self.assertEqual(ctx.pushed(), [])

    def test_preflight_failures_exit_3_before_supabase(self):
        cases = [dict(branch="nhanh-khac"), dict(dirty=" M index.html\n"), dict(fetch_code=1), dict(behind=2), dict(gate_code=1)]
        for overrides in cases:
            ctx = self.fake(answers=list(ALL_YES), **overrides)
            self.assertEqual(self.main(["--apply"], ctx), 3, overrides)
            self.assertFalse([e for e in ctx.events if e[0] in ("query", "api")], overrides)
            self.assertEqual(ctx.pushed(), [], overrides)

    def test_no_token_on_apply_exit_3(self):
        ctx = self.fake(token_value="", answers=list(ALL_YES))
        self.assertEqual(self.main(["--apply"], ctx), 3)
        self.assertIn("Thiếu SUPABASE_ACCESS_TOKEN", self.out)
        self.assertFalse([e for e in ctx.events if e[0] in ("query", "api")])

    def test_rerun_only_with_flag(self):
        ctx = self.fake(answers=list(ALL_YES))
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--apply"], ctx), 3, self.out)      # đổi chốt 26/10/2026: tệp đã sửa CHẶN, không chỉ cảnh báo
        self.assertFalse(self.ran(ctx, SQL_A))                         # tệp đã sửa sau khi chạy: KHÔNG tự chạy
        self.assertIn("đã sửa sau khi chạy", self.out)
        self.assertEqual(ctx.ledger[("migration", "a_v1.sql")]["sha256"], "f" * 64)
        self.assertEqual(ctx.pushed(), [])
        ctx = self.fake(answers=["y", "y", "y", "y", "y", "y", "y"])
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        self.assertEqual(self.main(["--apply", "--rerun", "supabase/a_v1.sql"], ctx), 0, self.out)
        self.assertTrue(self.ran(ctx, SQL_A))
        self.assertIn("CHẠY LẠI", self.out)
        self.assertEqual(ctx.ledger[("migration", "a_v1.sql")]["sha256"], sha(SQL_A))

    def test_modified_file_blocks_every_apply_mode_before_any_gate(self):
        for argv in (["--apply"], ["--apply", "--only", "migrations"], ["--apply", "--only", "edge"]):
            ctx = self.fake(answers=list(ALL_YES), old_files={("beef001", "supabase/a_v1.sql"): SQL_A_OLD_CONTENT.encode()})
            for name, body in (("b_v1.sql", SQL_B), ("c_v1.sql", SQL_C)):          # không còn migration mới: chỉ còn tệp đã sửa
                ctx.ledger[("migration", name)] = FakeMixin.row("migration", name, sha(body), None)
            ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
            self.assertEqual(self.main(argv, ctx), 3, (argv, self.out))
            self.assertIn("đã sửa sau khi chạy", self.out)
            self.assertIn("--rerun a_v1.sql", self.out)
            self.assertEqual(ctx.prompts, [], argv)                          # dừng TRƯỚC mọi cổng
            self.assertFalse([e for e in ctx.events if e[0] == "query" and not e[1].lstrip().lower().startswith("select")], argv)
            self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy_" in " ".join(e[1])], argv)
            self.assertFalse([e for e in ctx.events if e[0] == "api" and e[1].startswith("/functions/")], argv)   # không cổng Edge
            self.assertEqual(ctx.pushed(), [], argv)
            self.assertNotIn("Không có việc chờ", self.out)

    def test_rerun_of_one_file_does_not_unblock_another(self):
        ctx = self.fake(answers=["y"] * 8)
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        ctx.ledger[("migration", "c_v1.sql")] = FakeMixin.row("migration", "c_v1.sql", "e" * 64, None)
        self.assertEqual(self.main(["--apply", "--rerun", "a_v1.sql"], ctx), 3, self.out)
        self.assertIn("c_v1.sql", self.out)
        self.assertFalse(self.ran(ctx, SQL_A) or self.ran(ctx, SQL_C))
        self.assertEqual(ctx.prompts, [])

    def test_rerun_refused_when_nothing_to_rerun(self):
        for name in ("a_v1.sql", "khong_co.sql", "b_v1.sql"):
            ctx = self.fake(answers=list(ALL_YES))
            self.assertEqual(self.main(["--apply", "--rerun", name], ctx), 2, name)
            self.assertFalse([e for e in ctx.events if e[0] == "write"])

    def test_edge_fingerprint_missing_stops(self):
        ctx, code = self.happy(body_after={"ham-a": bundle(*EDGE_A_STRINGS[:2])})
        self.assertEqual(code, 1)
        self.assertIn("Dấu vết nội dung", self.out)
        self.assertIn("Đã nhận yêu cầu in tem", self.out)
        self.assertNotEqual(ctx.ledger[("edge", "ham-a")]["sha256"], sha(EDGE_A))
        self.assertFalse([e for e in ctx.events if e == ("write", "extension", "inside-po-connector")])
        self.assertEqual(ctx.pushed(), [])

    def test_edge_fingerprint_unsure_only_warns(self):
        ctx = self.fake(answers=list(ALL_YES), body_after={"ham-a": b"ESZIP2.3 khong co chuoi nao"})
        ctx.head_files["supabase/functions/ham-a/index.ts"] = EDGE_A_UNSURE.encode()
        self.assertEqual(self.main(["--apply"], ctx), 0, self.out)
        self.assertIn("bỏ qua dấu vết", self.out)
        self.assertEqual(ctx.ledger[("edge", "ham-a")]["sha256"], sha(EDGE_A_UNSURE))

    def test_edge_version_status_and_deploy_errors_stop(self):
        for overrides in (dict(version_step=0), dict(version_step=2), dict(status_after="THROTTLED"), dict(deploy_code=1),
                          dict(updated_after=NOW_MS - 86_400_000)):
            ctx, code = self.happy(**overrides)
            self.assertEqual(code, 1, overrides)
            self.assertNotEqual(ctx.ledger[("edge", "ham-a")]["sha256"], sha(EDGE_A), overrides)
            self.assertEqual(ctx.pushed(), [], overrides)

    def test_edge_old_updated_at_stops(self):
        ctx, code = self.happy(updated_after=NOW_MS - 86_400_000)
        self.assertEqual(code, 1)
        self.assertIn("updated_at không sau lúc bắt đầu deploy", self.out)

    def test_edge_deploy_failure_unknown_vs_rejected(self):
        ctx, code = self.happy(deploy_code=1)                          # HTTP 500 / hết giờ: chưa rõ
        self.assertEqual(code, 1)
        self.assertIn("KẾT QUẢ CHƯA RÕ", self.out)
        self.assertNotIn("giữ bản cũ", self.out)
        self.assertIn("bản 4", self.out)                               # đọc lại bản đang chạy để gợi ý
        ctx, code = self.happy(deploy_code=1, deploy_output="Management API HTTP 400: entrypoint sai")
        self.assertEqual(code, 1)
        self.assertIn("bị từ chối", self.out)
        self.assertNotIn("KẾT QUẢ CHƯA RÕ", self.out)

    def test_deploy_script_must_be_committed(self):
        ctx, code = self.happy(committed=set())
        self.assertEqual(code, 1)
        self.assertIn("scripts/deploy_ham_a.py không có ở commit", self.out)
        self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy" in " ".join(e[1])])
        self.assertIn(("git", ("cat-file", "-e", f"{HEAD}:scripts/deploy_ham_a.py")), ctx.events)

    def test_edge_without_deploy_script_stops(self):
        ctx, code = self.happy(scripts=set())
        self.assertEqual(code, 1)
        self.assertIn("Chưa có scripts/deploy_ham_a.py", self.out)
        self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy" in " ".join(e[1])])

    def test_edge_worktree_differs_from_head_stops_before_deploy(self):
        ctx, code = self.happy(worktree={"supabase/functions/ham-a/index.ts": b"const MSG = 'ban sua chua commit';\n"})
        self.assertEqual(code, 1)
        self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy" in " ".join(e[1])])

    def test_new_edge_function_first_deploy(self):
        ctx = self.fake(answers=list(ALL_YES))
        ctx.functions = {}
        ctx.ledger.pop(("edge", "ham-a"))
        self.assertEqual(self.main(["--apply"], ctx), 0, self.out)
        self.assertEqual(ctx.ledger[("edge", "ham-a")]["note"], "v1")

    def test_extension_gate_lists_devices_and_needs_y(self):
        devices = [{"device": "may-a", "id4": "ab12", "version": VER_HEAD, "last_seen": iso(NOW), "last_kind": "sku"},
                   {"device": "may-b", "id4": "cd34", "version": VER_OLD, "last_seen": iso(NOW), "last_kind": "group_uid"}]
        ctx, code = self.happy(devices=devices, answers=["y", "y", "y", "y", "n"])
        self.assertEqual(code, 1)
        self.assertRegex(self.out, r"`may-b` #cd34 v9\.9\.0 .*còn bản cũ")
        self.assertNotRegex(self.out, r"`may-a` #ab12 v9\.9\.1 .*còn bản cũ")
        self.assertIn(f"Đã Reload Extension {VER_HEAD}", self.out)
        self.assertEqual(ctx.ledger[("extension", "inside-po-connector")]["note"], VER_OLD)
        self.assertEqual(ctx.pushed(), [])

    def test_push_needs_y_and_unchanged_head(self):
        ctx, code = self.happy(answers=["y", "y", "y", "y", "y", "n"])
        self.assertEqual(code, 1)
        self.assertIn("c0ffee1 Edge ham-a", self.out)
        self.assertEqual(ctx.pushed(), [])
        ctx, code = self.happy(move_head_on_push=True)               # phiên khác commit SAU câu hỏi push
        self.assertEqual(code, 1)
        self.assertIn("HEAD hoặc nhánh đã đổi", self.out)
        self.assertEqual(ctx.pushed(), [])
        ctx, code = self.happy(branch_on_push="nhanh-khac")
        self.assertEqual(code, 1)
        self.assertEqual(ctx.pushed(), [])

    def test_sha_pinned_before_preflight(self):
        ctx, code = self.happy()
        self.assertEqual(code, 0, self.out)
        first_head = self.index(ctx, lambda e: e == ("git", ("rev-parse", "HEAD")))
        status = self.index(ctx, lambda e: e[0] == "git" and e[1][0] == "status")
        self.assertLess(first_head, status)
        self.assertIn(("git", ("rev-list", "--count", f"{HEAD}..origin/main")), ctx.events)
        gate = [e for e in ctx.events if e[0] == "run" and "commit_gate.py" in " ".join(e[1])]
        self.assertEqual(gate[0][1][-2:], ("--commit", HEAD))

    def test_plan_rebuilt_after_lock_when_ledger_changed(self):
        def other_machine_ran_b(fake):
            fake.ledger[("migration", "b_v1.sql")] = FakeMixin.row("migration", "b_v1.sql", sha(SQL_B), None, by="may-b#00000001")
        ctx, code = self.happy(on_lock=other_machine_ran_b, answers=["y"] + list(ALL_YES))
        self.assertEqual(code, 0, self.out)
        self.assertIn("Kế hoạch đã đổi", self.out)
        self.assertFalse(self.ran(ctx, SQL_B))
        self.assertTrue(self.ran(ctx, SQL_C))
        ctx, code = self.happy(on_lock=other_machine_ran_b, answers=["n"])
        self.assertEqual(code, 1)
        self.assertFalse(self.ran(ctx, SQL_B) or self.ran(ctx, SQL_C))

    def test_example_sql_never_run_on_apply(self):
        ctx = self.fake(answers=["y"] * 7, order=list(ORDER_WITH_EXAMPLE))
        ctx.head_files["supabase/x.example.sql"] = SQL_EXAMPLE.encode()
        ctx.head_files["supabase/y.sql"] = SQL_E.encode()
        self.assertEqual(self.main(["--apply"], ctx), 0, self.out)
        self.assertFalse(self.ran(ctx, SQL_EXAMPLE))
        self.assertTrue(self.ran(ctx, SQL_E))
        self.assertIn(("migration", "y.sql"), ctx.ledger)
        self.assertNotIn(("migration", "x.example.sql"), ctx.ledger)
        self.assertNotIn("x.example.sql", self.out)

    def test_only_edge_refused_while_migrations_pending(self):
        ctx = self.fake(answers=list(ALL_YES))
        self.assertEqual(self.main(["--apply", "--only", "edge"], ctx), 3)
        self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy" in " ".join(e[1])])

    def test_only_migrations_runs_nothing_else(self):
        ctx = self.fake(answers=["y", "y", "y"])
        self.assertEqual(self.main(["--apply", "--only", "migrations"], ctx), 0, self.out)
        self.assertTrue(self.ran(ctx, SQL_B) and self.ran(ctx, SQL_C))
        self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy" in " ".join(e[1])])
        self.assertEqual(ctx.pushed(), [])
        self.assertIn("CHƯA chạy: Edge, Extension, push", self.out)
        self.assertNotIn("mọi mục đã chạy", self.out)

    def test_gate_shows_first_12_header_lines(self):
        long_sql = "".join(f"-- dòng đầu số {index:02d}\n" for index in range(1, 21)) + "-- kiem: select true as ok\nbegin;\nselect 1;\ncommit;\n"
        ctx = self.fake(answers=["y", "n"], order=["a_v1.sql", "g_v1.sql"])
        ctx.head_files = {"supabase/a_v1.sql": SQL_A.encode(), "supabase/g_v1.sql": long_sql.encode(),
                          "extension/inside-po-connector/manifest.json": MANIFEST}
        self.assertEqual(self.main(["--apply"], ctx), 1)
        self.assertIn("dòng đầu số 12", self.out)
        self.assertNotIn("dòng đầu số 13", self.out)


# ===================================================================== --init
class InitFlow(Case):
    def init_ctx(self, **overrides):
        ctx = self.fake(ledger_exists=False, order=["a_v1.sql", "b_v1.sql", "c_v1.sql", "release_ledger_v1.sql"], **overrides)
        ctx.ledger = {}
        ctx.head_files["supabase/release_ledger_v1.sql"] = LEDGER_SQL_FILE
        ctx.db = {"table": {"bang_a", "bang_b"}, "function": {"ham_c"}, "index": set(), "trigger": set(), "cron": set()}
        return ctx

    def test_needs_seed(self):
        ctx = self.init_ctx(answers=["seed"])
        self.assertEqual(self.main(["--init"], ctx), 1)
        self.assertFalse(self.ran(ctx, LEDGER_SQL_FILE.decode("utf-8")))
        self.assertFalse([e for e in ctx.events if e[0] == "query" and not e[1].lstrip().lower().startswith("select")])
        self.assertIn("Không gõ SEED", self.out)

    def test_seeds_every_head_file_edge_and_extension(self):
        ctx = self.init_ctx(answers=["SEED", VER_HEAD])
        self.assertEqual(self.main(["--init"], ctx), 0, self.out)
        self.assertTrue(self.ran(ctx, LEDGER_SQL_FILE.decode("utf-8")))
        names = sorted(name for kind, name in ctx.ledger if kind == "migration")
        self.assertEqual(names, ["a_v1.sql", "b_v1.sql", "c_v1.sql", "release_ledger_v1.sql"])
        self.assertEqual(ctx.ledger[("migration", "release_ledger_v1.sql")]["sha256"], sha(LEDGER_SQL_FILE))
        self.assertEqual(ctx.ledger[("edge", "ham-a")]["sha256"], sha(EDGE_A))
        self.assertEqual(ctx.ledger[("edge", "ham-a")]["note"], "v4 (init)")
        self.assertEqual(ctx.ledger[("extension", "inside-po-connector")]["note"], VER_HEAD)
        self.assertEqual({ctx.ledger[("migration", n)]["note"] for n in names}, {"init"})
        self.assertNotIn(("lock", "release"), ctx.ledger)
        self.assertTrue(self.reports())
        self.assert_no_token(ctx)
        refresh = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("update public.release_ledger set applied_at"), last=True)
        seed = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("insert into public.release_ledger (kind"))
        self.assertLess(refresh, seed)                                  # gia hạn khoá ngay trước khi ghi sổ

    def test_lists_files_without_objects_before_seed(self):
        sql_n = "-- n_v2: chỉ thêm cột\nbegin;\nalter table public.bang_a add column if not exists ghi_chu text;\ncommit;\n"
        ctx = self.init_ctx(answers=["seed"])
        ctx.order.insert(3, "n_v2.sql")
        ctx.head_files["supabase/n_v2.sql"] = sql_n.encode()
        self.assertEqual(self.main(["--init"], ctx), 1)
        self.assertIn("1 tệp không có đối tượng để kiểm", self.out)
        self.assertIn("n_v2.sql", self.out)
        self.assertLess(self.out.index("không có đối tượng để kiểm"), self.out.index("Gõ SEED"))

    def test_refuses_when_ledger_already_has_migration_rows(self):
        sql_n = "-- n_v2: chỉ thêm cột (chưa chạy)\nbegin;\nalter table public.bang_a add column if not exists ghi_chu text;\ncommit;\n"
        ctx = self.init_ctx(answers=["SEED", ""])
        ctx.ledger_exists = True
        for name, body in (("a_v1.sql", SQL_A), ("b_v1.sql", SQL_B), ("c_v1.sql", SQL_C)):
            ctx.ledger[("migration", name)] = FakeMixin.row("migration", name, sha(body), "init")
        ctx.order.insert(3, "n_v2.sql")
        ctx.head_files["supabase/n_v2.sql"] = sql_n.encode()
        self.assertEqual(self.main(["--init"], ctx), 3)
        self.assertIn("sổ đã có 3 dòng migration", self.out)
        self.assertIn("--apply", self.out)
        self.assertNotIn(("migration", "n_v2.sql"), ctx.ledger)
        self.assertFalse([p for p in ctx.prompts if "SEED" in p])
        self.assertFalse([e for e in ctx.events if e[0] == "write"])

    def test_refuses_when_other_machine_seeded_after_seed_prompt(self):
        def other_machine_seeded(fake):
            fake.ledger[("migration", "a_v1.sql")] = FakeMixin.row("migration", "a_v1.sql", sha(SQL_A), "init", by="may-b#00000001")
        ctx = self.init_ctx(answers=["SEED", VER_HEAD], on_lock=other_machine_seeded)
        self.assertEqual(self.main(["--init"], ctx), 3)
        self.assertFalse([e for e in ctx.events if e[0] == "write"])
        self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_lock_lost_before_seed_writes_nothing(self):
        ctx = self.init_ctx(answers=["SEED", VER_HEAD], steal_on_prompt="Bản Extension")
        self.assertEqual(self.main(["--init"], ctx), 1)
        self.assertIn("Mất khoá phát hành", self.out)
        self.assertFalse([e for e in ctx.events if e[0] == "write"])

    def test_ledger_sql_unknown_result(self):
        ctx = self.init_ctx(answers=["SEED", VER_HEAD], fail_when=lambda sql: "create table if not exists public.release_ledger" in sql,
                            fail_unknown=True, fail_message="Không gọi được Management API: timed out")
        self.assertEqual(self.main(["--init"], ctx), 1)
        self.assertIn("KẾT QUẢ CHƯA RÕ", self.out)
        self.assertNotIn("database không đổi", self.out)

    def test_stops_when_live_status_has_missing_objects(self):
        ctx = self.init_ctx(answers=["SEED", VER_HEAD])
        ctx.db["table"].discard("bang_b")
        self.assertEqual(self.main(["--init"], ctx), 3)
        self.assertIn("b_v1.sql: thiếu table bang_b", self.out)
        self.assertFalse([e for e in ctx.events if e[0] == "write"])
        self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_stale_edge_needs_slug_typed(self):
        stale = {"supabase/functions/ham-a": NOW_MS // 1000}
        ctx = self.init_ctx(answers=["SEED", "", VER_HEAD], commit_ct=stale)
        self.assertEqual(self.main(["--init"], ctx), 0, self.out)
        self.assertNotIn(("edge", "ham-a"), ctx.ledger)
        ctx = self.init_ctx(answers=["SEED", "ham-a", VER_HEAD], commit_ct=stale)
        self.assertEqual(self.main(["--init"], ctx), 0, self.out)
        self.assertIn(("edge", "ham-a"), ctx.ledger)

    def test_example_sql_not_seeded(self):
        ctx = self.init_ctx(answers=["SEED", VER_HEAD])
        ctx.order = ["a_v1.sql", "x.example.sql", "b_v1.sql", "c_v1.sql", "y.sql", "release_ledger_v1.sql"]
        ctx.head_files["supabase/x.example.sql"] = SQL_EXAMPLE.encode()
        ctx.head_files["supabase/y.sql"] = SQL_E.encode()
        ctx.db["table"].add("bang_e")          # bảng của tệp ví dụ (vi_du) KHÔNG có trên DB: không được làm --init dừng
        self.assertEqual(self.main(["--init"], ctx), 0, self.out)
        self.assertIn(("migration", "y.sql"), ctx.ledger)
        self.assertNotIn(("migration", "x.example.sql"), ctx.ledger)
        self.assertEqual(len([key for key in ctx.ledger if key[0] == "migration"]), 5)

    def test_blank_extension_is_not_recorded(self):
        ctx = self.init_ctx(answers=["SEED", ""])
        self.assertEqual(self.main(["--init"], ctx), 0, self.out)
        self.assertNotIn(("extension", "inside-po-connector"), ctx.ledger)
        self.assertIn(("migration", "a_v1.sql"), ctx.ledger)

    def test_ledger_file_must_be_committed(self):
        ctx = self.init_ctx(answers=["SEED", ""])
        del ctx.head_files["supabase/release_ledger_v1.sql"]
        self.assertEqual(self.main(["--init"], ctx), 3)
        self.assertIn("release_ledger_v1.sql", self.out)


# ===================================================================== --accept (người dùng chốt 26/10/2026)
class AcceptFlow(Case):
    def accept_ctx(self, old=SQL_A_OLD_COMMENT, note="init", **overrides):
        ctx = self.fake(old_files={("beef001", "supabase/a_v1.sql"): old.encode()} if old is not None else {}, **overrides)
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = "f" * 64
        ctx.ledger[("migration", "a_v1.sql")]["note"] = note
        return ctx

    def upserts(self, ctx):
        return [e[1] for e in ctx.events if e[0] == "query" and e[1].startswith("insert into public.release_ledger (kind")]

    def test_needs_terminal(self):
        ctx = self.accept_ctx(tty=False, answers=["a_v1.sql"])
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 2)
        self.assertIn("terminal", self.out)
        self.assertFalse([e for e in ctx.events if e[0] in ("git", "query", "api", "run", "ask")])

    def test_bad_names_and_combinations_exit_2(self):
        for argv in (["--accept", "x.example.sql"], ["--accept", "../a_v1.sql"], ["--accept", "supabase/sub/a_v1.sql"],
                     ["--accept", "a_v1.txt"], ["--accept", "a_v1.sql", "--only", "edge"],
                     ["--accept", "a_v1.sql", "--rerun", "a_v1.sql"], ["--accept", "a_v1.sql", "--apply"]):
            ctx = self.accept_ctx(answers=["a_v1.sql"])
            self.assertEqual(self.main(argv, ctx), 2, argv)
            self.assertEqual(self.upserts(ctx), [], argv)
        ctx = self.accept_ctx(answers=["x.example.sql"])
        ctx.head_files["supabase/x.example.sql"] = SQL_EXAMPLE.encode()
        self.assertEqual(self.main(["--accept", "supabase/x.example.sql"], ctx), 2)
        self.assertIn("không phải migration", self.out)

    def test_not_in_ledger_not_in_head_or_unchanged_exit_2(self):
        for name, phrase in (("b_v1.sql", "tệp không có trong sổ — chạy bằng --apply"), ("khong_co.sql", "không có supabase/khong_co.sql ở HEAD")):
            ctx = self.accept_ctx(answers=[name])
            self.assertEqual(self.main(["--accept", name], ctx), 2, name)
            self.assertIn(phrase, self.out)
            self.assertEqual(self.upserts(ctx), [])
        ctx = self.accept_ctx(answers=["a_v1.sql"])
        ctx.ledger[("migration", "a_v1.sql")]["sha256"] = sha(SQL_A)
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 2)
        self.assertIn("tệp không đổi so với sổ", self.out)
        self.assertEqual(self.upserts(ctx), [])
        self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_wrong_empty_or_eof_answer_writes_nothing(self):
        for answers in (["A_V1.SQL"], ["y"], [""], []):                # [] = EOF ở bản giả
            ctx = self.accept_ctx(answers=list(answers))
            self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 1, answers)
            self.assertEqual(self.upserts(ctx), [], answers)
            self.assertEqual(ctx.ledger[("migration", "a_v1.sql")]["sha256"], "f" * 64)
            self.assertNotIn(("lock", "release"), ctx.ledger)

    def test_typed_name_records_without_running_sql(self):
        ctx = self.accept_ctx(answers=["a_v1.sql"])
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 0, self.out)
        self.assertEqual(len(self.upserts(ctx)), 1)
        row = ctx.ledger[("migration", "a_v1.sql")]
        self.assertEqual((row["sha256"], row["commit_sha"], row["applied_by"], row["note"]),
                         (sha(SQL_A), HEAD[:7], HOLDER, f"init; accept {HEAD[:7]}"))
        self.assertFalse([e for e in ctx.events if e[0] == "query" and ("create table" in e[1] or e[1] in (SQL_A, SQL_A_OLD_COMMENT))])
        self.assertFalse([e for e in ctx.events if e[0] == "run" and "deploy_" in " ".join(e[1])])
        self.assertFalse([e for e in ctx.events if e[0] == "api" and e[1].startswith("/functions/")])
        self.assertEqual(ctx.pushed(), [])
        lock = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("insert into public.release_ledger as l"))
        ask = self.index(ctx, lambda e: e[0] == "ask")
        refresh = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("update public.release_ledger set applied_at"), last=True)
        write = self.index(ctx, lambda e: e[0] == "query" and e[1].startswith("insert into public.release_ledger (kind"))
        self.assertTrue(lock < ask < refresh < write)
        self.assertNotIn(("lock", "release"), ctx.ledger)               # khoá đã nhả
        self.assertIn("Chỉ khác chú thích", self.out)
        self.assertNotIn("KHÔNG được chạy trên database", self.out)
        self.assertIn("supabase/a_v1.sql | 2 +-", self.out)
        self.assertIn("`release.py --accept`", self.reports()[0].read_text(encoding="utf-8"))
        self.assert_no_token(ctx)

    def test_note_accept_when_old_note_empty(self):
        ctx = self.accept_ctx(note=None, answers=["a_v1.sql"])          # gõ tên tệp, dù cờ dùng dạng supabase/<tệp>
        self.assertEqual(self.main(["--accept", "supabase/a_v1.sql"], ctx), 0, self.out)
        self.assertEqual(ctx.ledger[("migration", "a_v1.sql")]["note"], "accept")

    def test_sql_change_shows_diff_and_warns(self):
        ctx = self.accept_ctx(old=SQL_A_OLD_CONTENT, answers=["a_v1.sql"])
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 0, self.out)
        self.assertIn("phần sửa này KHÔNG được chạy trên database", self.out)
        self.assertIn("-create table if not exists public.bang_a (id bigint);", self.out)
        self.assertIn("+create table if not exists public.bang_a (id int);", self.out)
        self.assertFalse([e for e in ctx.events if e[0] == "query" and "create table" in e[1]])

    def test_old_version_unreadable_is_treated_as_changed(self):
        ctx = self.accept_ctx(old=None, answers=["a_v1.sql"])
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 0, self.out)
        self.assertIn("không đọc được bản cũ", self.out)
        self.assertIn("KHÔNG được chạy trên database", self.out)

    def test_lock_lost_before_write_writes_nothing(self):
        ctx = self.accept_ctx(answers=["a_v1.sql"], steal_on_prompt="Gõ nguyên tên tệp a_v1.sql")
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 1)
        self.assertIn("Mất khoá phát hành", self.out)
        self.assertEqual(self.upserts(ctx), [])

    def test_lock_held_by_other_machine_exit_3(self):
        ctx = self.accept_ctx(answers=["a_v1.sql"])
        ctx.ledger[("lock", "release")] = FakeMixin.row("lock", "release", None, "release.py", applied=NOW - dt.timedelta(minutes=5), by="may-b#00000001")
        self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 3)
        self.assertEqual(self.upserts(ctx), [])
        self.assertEqual(ctx.prompts, [])

    def test_preflight_failures_exit_3(self):
        for overrides in (dict(dirty=" M index.html\n"), dict(branch="nhanh-khac"), dict(behind=1), dict(token_value="")):
            ctx = self.accept_ctx(answers=["a_v1.sql"], **overrides)
            self.assertEqual(self.main(["--accept", "a_v1.sql"], ctx), 3, overrides)
            self.assertEqual(self.upserts(ctx), [], overrides)
            self.assertEqual(ctx.prompts, [], overrides)


# ===================================================================== lớp Ctx thật (input / urlopen / run_query giả)
class RealCtx(Case):
    def ctx(self):
        ctx = self.R.Ctx()
        ctx.token, ctx.ref = TOKEN, REF
        return ctx

    def test_ask_eof_is_refusal(self):
        with mock.patch("builtins.input", side_effect=EOFError):
            self.assertEqual(self.ctx().ask("Chạy b_v1.sql? [y/N] "), "")

    def test_query_errors_classified_and_token_redacted(self):
        cases = [(SystemExit(f"Management API HTTP 400: syntax error gần {TOKEN}"), False),
                 (SystemExit("Management API HTTP 401: token hỏng"), False),
                 (SystemExit("Management API HTTP 502: Bad Gateway"), True),
                 (SystemExit("Không gọi được Management API: timed out"), True),
                 (TimeoutError("The read operation timed out"), True),
                 (ConnectionResetError(10054, "reset"), True),
                 (http.client.RemoteDisconnected("đóng kết nối"), True),
                 (json.JSONDecodeError("Expecting value", "", 0), True)]
        for error, unknown in cases:
            with mock.patch.object(supa, "run_query", side_effect=error):
                with self.assertRaises(self.R.ApiError, msg=repr(error)) as caught:
                    self.ctx().query("select 1")
            self.assertEqual(caught.exception.unknown, unknown, repr(error))
            self.assertNotIn(TOKEN, str(caught.exception))

    def test_api_http_codes_and_network(self):
        def http_error(code):
            return HTTPError(f"https://api.example.invalid/v1/projects/{REF}/functions/x", code, "giả", {}, None)
        with mock.patch.object(self.R, "urlopen", side_effect=http_error(404)):
            self.assertIsNone(self.ctx().api("/functions/x"))
        for error, unknown in ((http_error(400), False), (http_error(403), False), (http_error(500), True), (http_error(504), True),
                               (URLError("dns giả"), True), (TimeoutError("timed out"), True),
                               (http.client.IncompleteRead(b"x"), True)):
            with mock.patch.object(self.R, "urlopen", side_effect=error):
                with self.assertRaises(self.R.ApiError, msg=repr(error)) as caught:
                    self.ctx().api("/functions/x")
            self.assertEqual(caught.exception.unknown, unknown, repr(error))
        response = mock.MagicMock()
        response.__enter__.return_value.read.return_value = b"<html>khong phai json</html>"
        with mock.patch.object(self.R, "urlopen", return_value=response):
            with self.assertRaises(self.R.ApiError) as caught:
                self.ctx().api("/functions/x")
        self.assertTrue(caught.exception.unknown)

    def test_edge_list_errors_become_api_error(self):
        for error, unknown in ((SystemExit("Management API HTTP 401 khi đọc Edge Function"), False), (TimeoutError("timed out"), True)):
            with mock.patch.object(live, "edge_functions", side_effect=error):
                with self.assertRaises(self.R.ApiError) as caught:
                    self.ctx().edge_list()
            self.assertEqual(caught.exception.unknown, unknown)

    def test_resolve_ref_mismatch_and_missing(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": f"https://{REF}.supabase.co"}):
            with self.assertRaises(self.R.Stop) as caught:
                self.R.resolve_ref("zzzzzzzzzzzzzzzzzzzz", os.environ["SUPABASE_URL"])
            self.assertEqual(caught.exception.code, 3)
            self.assertEqual(self.R.resolve_ref(REF, os.environ["SUPABASE_URL"]), REF)
        with mock.patch.dict(os.environ, {"SUPABASE_URL": ""}):
            with self.assertRaises(self.R.Stop) as caught:
                self.R.resolve_ref("", "")
            self.assertEqual(caught.exception.code, 3)

    def test_say_redacts_token(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.ctx().say(f"lỗi gần {TOKEN}")
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertIn("lỗi gần", out.getvalue())


# ===================================================================== đột biến
MUTANTS = [
    ("push trước migration", 'STAGES = ("migration", "edge", "extension", "push")', 'STAGES = ("push", "migration", "edge", "extension")'),
    ("ghi sổ trước xác minh",
     "        verify_migration(ctx, plan, item)\n        record_after(ctx, plan, \"migration\", item.name, item.sha, None)\n",
     "        record_after(ctx, plan, \"migration\", item.name, item.sha, None)\n        verify_migration(ctx, plan, item)\n"),
    ("chấp nhận --yes", '    parser.add_argument("--rerun"', '    parser.add_argument("--yes", "-y", action="store_true")\n    parser.add_argument("--rerun"'),
    ("bỏ cổng gõ tên tệp cho DROP", "        if answer != item.name:", "        if answer not in (item.name, \"y\"):"),
    ("bỏ khoá", "    holder = acquire_lock(ctx)\n", "    holder = ctx.holder\n"),
    ("đọc cây làm việc thay vì HEAD", '    code, data = ctx.git("show", f"{sha}:{rel}", binary=True)', "    code, data = 0, ctx.worktree_bytes(rel)"),
    ("không thoát khi không có terminal", 'if mode in ("apply", "init", "accept") and not ctx.isatty():',
     'if mode in ("apply", "init", "accept") and False:'),
    ("in token", "    ctx.token = token\n", "    ctx.token = token\n    print(token)\n"),
    ("khoá không có hạn 30 phút", "f\"where l.applied_at < now() - interval '{LOCK_MINUTES} minutes' \"", '""'),
    ("không nhả khoá khi lỗi", "    finally:\n        release_lock(ctx, holder)", "    finally:\n        pass"),
    ("bỏ -- kiem", "        if not ok:\n            problems.append", "        if False:\n            problems.append"),
    ("dấu vết thiếu không chặn", '    if verdict == "missing":', '    if verdict == "khong-bao-gio":'),
    ("bỏ kiểm cây sạch", "    if code != 0 or dirty.strip():", "    if code != 0:"),
    ("bỏ kiểm HEAD tụt origin/main", "    if int(behind) > 0:", "    if int(behind) > 99:"),
    ("bỏ commit_gate", '        raise Stop(3, f"commit_gate.py --commit', '        print(f"commit_gate.py --commit'),
    ("tự chạy tệp đã sửa sau khi chạy", "        elif rerun == name:", "        elif True:"),
    ("hash không đổi CRLF", 'data.replace(b"\\r\\n", b"\\n")', "data"),
    ("tách cả thân template", '        if c == "`":', '        if c == "\\x00":'),
    ("Edge không kiểm bản tăng 1", "    if new_version != old_version + 1:", "    if new_version < old_version:"),
    ("không token vẫn chạy", "    if not token:\n        raise Stop(3,", "    if False:\n        raise Stop(3,"),
    ("bỏ lọc .example.sql", '    return name.endswith(".sql") and not name.endswith(".example.sql")', '    return name.endswith(".sql")'),
    # ---- review vòng 1 (26/10/2026)
    ("1 chưa rõ coi như chắc chắn", "        if error.unknown:\n            step(ctx, f\"Migration", "        if False:\n            step(ctx, f\"Migration"),
    ("1 lỗi lấy khoá không thử nhả", "ctx.query(lock_release_sql(ctx.holder))  # cố gắng", "pass  # cố gắng"),
    ("2 risky chỉ dùng destructive_statements", "        return deep_destructive(self.sql)", "        return supa.destructive_statements(self.sql)"),
    ("2 không quét thân DO", '            kept.append(" " + body + " ")', '            kept.append(" ")'),
    ("2 bỏ EXECUTE trong DO", '        labels.append("EXECUTE động trong DO")', "        pass"),
    ("2 bỏ loại DROP mới", "(materialized\\s+view|sequence|extension|role|procedure|domain|publication)", "(khong_bao_gio)"),
    ("3 push --force", 'ctx.git_live("push", "origin", f"{plan.sha}:refs/heads/main")', 'ctx.git_live("push", "--force", "origin", f"{plan.sha}:refs/heads/main")'),
    ("3 push nhánh main thay vì sha đã kiểm", 'ctx.git_live("push", "origin", f"{plan.sha}:refs/heads/main")', 'ctx.git_live("push", "origin", "main")'),
    ("3 bỏ kiểm HEAD / nhánh sau câu hỏi push", '    if head_sha(ctx) != plan.sha or branch.strip() != "main":', "    if False:"),
    ("4 'Không có việc chờ' dù còn tệp đã sửa", "    if plan.changed:\n        out += render_changed(plan)", "    if False:\n        out += render_changed(plan)"),
    ("5 biên bản lấy dòng đầu thô", "step(ctx, \"Dừng\", (stop.title or first_line(stop.message))[:200])", "step(ctx, \"Dừng\", stop.message.splitlines()[0][:200])"),
    ("5 done() trước ghi sổ", "        record_after(ctx, plan, \"migration\", item.name, item.sha, None)\n        done(ctx, f\"migration {item.name}\")\n",
     "        done(ctx, f\"migration {item.name}\")\n        record_after(ctx, plan, \"migration\", item.name, item.sha, None)\n"),
    ("6 git diff lỗi vẫn bỏ cổng bộ test", "    if code != 0:\n        raise Stop(3, f\"Không đọc được diff", "    if False:\n        raise Stop(3, f\"Không đọc được diff"),
    ("6 thiếu .py / .mjs", '".cjs", ".py", ".mjs")', '".cjs")'),
    ("7 --init không từ chối sổ đã có dòng", "    if existing:\n        raise Stop(3,", "    if False:\n        raise Stop(3,"),
    ("7 --init không đọc lại sổ sau khoá", "        if seeded:\n            raise Stop(3,", "        if False:\n            raise Stop(3,"),
    ("7 --init không gia hạn khoá trước khi ghi sổ", "        refresh_lock(ctx)\n        try:\n            written", "        try:\n            written"),
    ("7 --apply không dựng lại kế hoạch sau khoá", "        fresh = build_plan(ctx, sha, read_ledger(ctx), args.rerun)", "        fresh = plan"),
    ("8 bỏ kiểm script deploy có ở commit", "    if code != 0:\n        raise Stop(1, f\"{script} không có ở commit", "    if False:\n        raise Stop(1, f\"{script} không có ở commit"),
    ("9 EOF thành đồng ý", '        except EOFError:\n            return ""', '        except EOFError:\n            return "y"'),
    ("9 refresh_lock bỏ kiểm dòng trả về", "    if not (isinstance(rows, list) and rows):\n        raise Stop(1, f\"Mất khoá", "    if False:\n        raise Stop(1, f\"Mất khoá"),
    ("9 bỏ gia hạn khoá trước push", '    refresh_lock(ctx)\n    if ctx.git_live("push"', '    if ctx.git_live("push"'),
    ("9 bỏ kiểm updated_at Edge", '    if ms_of(after.get("updated_at")) < started - CLOCK_SLACK_MS:', "    if False:"),
    ("9 SystemExit không thành ApiError", "        except SystemExit as error:\n            raise api_error(", "        except ZeroDivisionError as error:\n            raise api_error("),
    ("9 -- kiem nhận giá trị truthy", "    return value is True, f\"trả {value!r}\"", "    return bool(value), f\"trả {value!r}\""),
    ("9 bỏ redact", '        text = text.replace(token, "[đã che token]")', "        text = text"),
    # ---- đổi chốt 26/10/2026: tệp đã sửa sau khi chạy CHẶN; chế độ --accept
    ("chặn: --apply đi tiếp khi còn tệp đã sửa", "    if plan.changed:\n        names = ", "    if False:\n        names = "),
    ("chặn: --only edge lách", "    block_changed(plan)  # mọi --only, trước khi lấy khoá", '    if args.only != "edge":\n        block_changed(plan)'),
    ("chặn: --rerun tệp A làm lọt tệp B", '        else:\n            commit = str(row.get("commit_sha") or "")',
     '        elif not rerun:\n            commit = str(row.get("commit_sha") or "")'),
    ("accept chạy SQL của tệp", "        refresh_lock(ctx)\n        old_note", "        refresh_lock(ctx)\n        ctx.query(new_text)\n        old_note"),
    ("accept không gia hạn khoá trước khi ghi", "        refresh_lock(ctx)\n        old_note", "        old_note"),
    ("accept không đòi gõ tên", "        if typed != name:\n            raise Stop(1,", "        if False:\n            raise Stop(1,"),
    ("accept ghi trước khi xác nhận", '        typed = ctx.ask(f"Gõ nguyên tên tệp {name}',
     '        record(ctx, plan, "migration", name, change.sha, "accept")\n        typed = ctx.ask(f"Gõ nguyên tên tệp {name}'),
    ("accept không lấy khoá", "    holder = acquire_lock(ctx)  # --accept cũng giữ khoá", "    holder = ctx.holder  # --accept cũng giữ khoá"),
    ("accept nhận *.example.sql", "    if not is_migration(name):\n        raise Stop(2,", "    if False:\n        raise Stop(2,"),
    ("accept nhận tệp không có trong sổ", '        if row is None:\n            raise Stop(2, f"--accept', '        if False:\n            raise Stop(2, f"--accept'),
]


class Mutations(unittest.TestCase):
    def test_every_mutant_is_caught(self):
        loader = unittest.TestLoader()
        cases = [Hashing, Header, Literals, SqlAndNames, Destructive, Report, ArgsAndTerminal, PlanFlow, ApplyFlow, InitFlow,
                 AcceptFlow, RealCtx]

        def run(module):
            suite = unittest.TestSuite()
            for case in cases:
                suite.addTests(loader.loadTestsFromTestCase(type(case.__name__, (case,), {"R": module})))
            return unittest.TextTestRunner(stream=io.StringIO(), verbosity=0, failfast=True).run(suite)

        # Bộ test gốc phải xanh với bản không đột biến, nếu không thì "bị bắt" chẳng chứng minh gì.
        self.assertTrue(run(load(SOURCE, name="release_baseline")).wasSuccessful(), "bộ test gốc phải đạt trước khi thử đột biến")
        caught = 0
        for number, (label, old, new) in enumerate(MUTANTS, 1):
            with self.subTest(label):
                self.assertIn(old, SOURCE, f"đột biến '{label}': chuỗi gốc không còn trong release.py")
                result = run(load(SOURCE.replace(old, new), name=f"release_mutant_{number}"))
                self.assertFalse(result.wasSuccessful(), f"đột biến '{label}' không bị test nào bắt")
                caught += 0 if result.wasSuccessful() else 1
        print(f"\ntest_release: {caught}/{len(MUTANTS)} đột biến bị bắt", file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
