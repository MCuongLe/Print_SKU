"""Cổng trước commit: kiểm bằng máy 7 mục mà trước đây agent kiem-thu đọc diff bằng mắt.

    python scripts/commit_gate.py                 # git diff HEAD (cây làm việc + đã stage)
    python scripts/commit_gate.py --cached        # chỉ phần đã stage
    python scripts/commit_gate.py --commit <sha>  # một commit đã có

Mục kiểm (chỉ trên DÒNG THÊM MỚI của diff, trừ mục 4–5):
 1. Bí mật: sb_secret_, khoá service_role gán thẳng, JWT, SUPABASE_ACCESS_TOKEN=, sbp_…, tệp .env (chữ `service_role` trong GRANT là tên vai, không tính).
 2. Dữ liệu thật: SKU 9 số bắt đầu bằng 4 (42xxxxxxx…), Group UID 16 số bắt đầu 102826 nhưng không phải dải giả 1028260000000xxx,
    email cá nhân @hasaki (trừ api@). Dữ liệu giả chuẩn: SKU 9000000xx, UID 1028260000000xxx, phiếu/PO 100000001.
 3. Mã hoá: mojibake (Ã©, Ä‘, á»…), và `git diff --check` (khoảng trắng cuối dòng, xung đột).
 4. Xuống dòng: tệp bị đổi CRLF↔LF cả tệp (diff thường lớn hơn nhiều so với diff --ignore-cr-at-eol).
 5. Phiên bản Extension: manifest.json = mọi test khẳng định số phiên bản = ghi chú mới nhất trong README Extension.
 6. Phụ thuộc: thẻ <script src=http…>/<link href=http…> mới trong index.html/extension, package.json/node_modules mới
    (package.json chỉ đổi dòng "version" thì không tính: nâng phiên bản agent không thêm phụ thuộc).
 7. Bản đồ (cảnh báo): diff thêm migration, Edge, tệp Extension hoặc khối <script id=/<style id= mới mà docs/PROJECT_MAP.md không đổi.

Cảnh báo theo chuẩn docs/chuan (25/10/2026, chưa chặn — xét chuyển sang chặn sau 2–3 đợt):
 8. Tài liệu: dòng văn xuôi thêm mới trong .md dài quá 400 ký tự (bảng và khối mã không tính).
 9. SQL: hàm SECURITY DEFINER được tạo / sửa trong diff mà thiếu `set search_path` hoặc thiếu `revoke … on function` cùng tên trong tệp.
10. Mã nhật ký: mã `N0965` / `N20261025-2108` thêm mới trong .md mà nhật ký RULES.md (trên máy) không có thẻ `[mã]`.
11. Commit message: dòng đầu có chữ có dấu (khuôn: tiếng Việt không dấu). Chỉ xét với --commit hoặc --message-file.

    python scripts/commit_gate.py --cached --message-file <tệp thông điệp>   # soát cả thông điệp trước khi commit

Thoát mã 1 khi có mục KHÔNG ĐẠT; cảnh báo không chặn. Không sửa gì.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "extension" / "inside-po-connector" / "manifest.json"
EXT_README = ROOT / "extension" / "inside-po-connector" / "README.md"

SECRETS = [
    (re.compile(r"sb_secret_[A-Za-z0-9_-]{8,}"), "khoá sb_secret_"),
    (re.compile(r"(?i)service[_-]?role[_-]?key\s*[:=]\s*[\"']?\S{12,}"), "khoá service_role gán thẳng"),
    (re.compile(r"eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}"), "JWT"),
    (re.compile(r"SUPABASE_ACCESS_TOKEN\s*=\s*\S{8,}"), "SUPABASE_ACCESS_TOKEN="),
    (re.compile(r"\bsbp_[a-f0-9]{20,}\b"), "token Management sbp_"),
    (re.compile(r"(?i)\b(?:api[_-]?key|secret|password|mật khẩu)\b\s*[:=]\s*['\"][^'\"\s]{12,}['\"]"), "khoá/mật khẩu gán thẳng"),
]
REAL_DATA = [
    (re.compile(r"(?<![\d.])4\d{8}(?![\d.])"), "SKU thật 9 số bắt đầu bằng 4"),
    (re.compile(r"(?<!\d)102826(?!0000000)\d{10}(?!\d)"), "Group UID thật (ngoài dải giả 1028260000000xxx)"),
    (re.compile(r"(?i)\b(?!api@)(?!noreply@)[a-z0-9._-]+@hasaki(?:group)?\.vn\b"), "email cá nhân"),
]
MOJIBAKE = re.compile("Ä‘|á»|Ã[\u0080-¿‘’“”†‡…ˆ‰Š‹ŒŽ™š›œžŸƒ‚ȃ ]|Ä[\u0080-¿]|Æ°|Æ¡")
CDN = re.compile(r"""<(?:script[^>]*\ssrc|link[^>]*\shref)\s*=\s*["']https?://""", re.I)
VERSION_LINE = re.compile(r"(?i)\bver")
VERSION_LIT = re.compile(r"""["']v?(\d+\.\d+\.\d+)["']""")
BLOCK_ID = re.compile(r"""<(?:script|style)\s+id=["']""")
RULES = ROOT / "RULES.md"
DOC_LINE_MAX = 400
CODE = re.compile(r"\bN(?:\d{8}-\d{4}[a-z]?|\d{4})\b")
VI_MARKS = re.compile(r"[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]", re.I)
FUNC_HEAD = re.compile(r"create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?\"?(\w+)\"?\s*\((.*?)\$\w*\$", re.I | re.S)


def doc_long_lines(content: str, added: set[int]) -> list[tuple[int, int]]:
    """Dòng văn xuôi (không phải bảng, không trong khối ```) thuộc `added` mà dài hơn DOC_LINE_MAX: [(số dòng, độ dài)]."""
    out, fence = [], False
    for no, line in enumerate(content.splitlines(), 1):
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence or line.lstrip().startswith("|") or no not in added:
            continue
        if len(line) > DOC_LINE_MAX:
            out.append((no, len(line)))
    return out


def definer_issues(sql: str, added: set[int]) -> list[str]:
    """Hàm SECURITY DEFINER có dòng `create … function` nằm trong `added` mà thiếu search_path / revoke cùng tên."""
    issues = []
    for match in FUNC_HEAD.finditer(sql):
        line_no = sql.count("\n", 0, match.start()) + 1
        head = match.group(0).lower()
        if line_no not in added or "security definer" not in head:
            continue
        name = match.group(1)
        if "search_path" not in head:
            issues.append(f"{name} (dòng {line_no}): SECURITY DEFINER thiếu `set search_path`")
        if not re.search(rf"revoke\s+[^;]*on\s+function\s+(?:public\.)?\"?{re.escape(name)}\"?\s*\(", sql, re.I):
            issues.append(f"{name} (dòng {line_no}): thiếu `revoke … on function {name}` from public, anon, authenticated "
                          "(bắt buộc với hàm mới; `create or replace` hàm đã có thì quyền cũ được giữ)")
    return issues


def message_issues(message: str) -> list[str]:
    """Khuôn commit (docs/chuan/KIEM_THU_GIT.md): dòng đầu tiếng Việt không dấu."""
    subject = next((line.strip() for line in message.splitlines() if line.strip()), "")
    if not subject:
        return ["thông điệp rỗng"]
    if VI_MARKS.search(subject):
        return [f"dòng đầu có dấu (khuôn: tiếng Việt không dấu): {subject[:80]}"]
    return []


def missing_codes(lines: list[str], rules_text: str) -> list[str]:
    """Mã nhật ký trong `lines` mà RULES.md không có thẻ `[mã]`; giữ thứ tự gặp, không trùng."""
    tags = set(re.findall(r"\[(N(?:\d{8}-\d{4}[a-z]?|\d{4}))\]", rules_text))
    out: list[str] = []
    for line in lines:
        for code in CODE.findall(line):
            if code not in tags and code not in out:
                out.append(code)
    return out


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


def parse_added(diff: str) -> dict[str, list[tuple[int, str]]]:
    """Trả {tệp: [(số dòng mới, nội dung dòng thêm)]} từ diff -U0."""
    files: dict[str, list[tuple[int, str]]] = {}
    current, line_no = None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            name = raw[4:].strip()
            current = None if name == "/dev/null" else name[2:] if name.startswith("b/") else name
            files.setdefault(current, []) if current else None
        elif raw.startswith("@@"):
            m = re.search(r"\+(\d+)", raw)
            line_no = int(m.group(1)) if m else 0
        elif current and raw.startswith("+") and not raw.startswith("+++"):
            files[current].append((line_no, raw[1:]))
            line_no += 1
        elif current and not raw.startswith("-") and not raw.startswith("\\"):
            line_no += 1
    return files


def main() -> int:
    for stream in (sys.stdout, sys.stderr):  # console Windows mặc định cp1252 không in được tiếng Việt
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass
    parser = argparse.ArgumentParser()
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--cached", action="store_true")
    scope.add_argument("--commit")
    parser.add_argument("--message-file", help="tệp thông điệp commit sắp dùng (soát khuôn, mục 11)")
    args = parser.parse_args()

    if args.commit:
        rng = [f"{args.commit}~1", args.commit]
    elif args.cached:
        rng = ["--cached", "HEAD"]
    else:
        rng = ["HEAD"]

    diff = git("diff", "-U0", "--no-color", *rng, "--")
    added = parse_added(diff)
    names = [n for n in git("diff", "--name-only", *rng, "--").splitlines() if n]
    if not names:
        print("Không có thay đổi để soát.")
        return 0

    fails: list[str] = []
    warns: list[str] = []

    def hit(items, label_fn, limit=6):
        shown = 0
        for path, lines in added.items():
            for no, text in lines:
                for pattern, label in items:
                    if pattern.search(text):
                        if shown < limit:
                            fails.append(f"{label_fn(label)}: {path}:{no}: {text.strip()[:110]}")
                        shown += 1
        if shown > limit:
            fails.append(f"… và {shown - limit} dòng nữa")

    # 1. Bí mật
    hit(SECRETS, lambda l: f"[1 bí mật] {l}")
    for n in names:
        base = Path(n).name
        if base == ".env" or base.startswith(".env.") and base != ".env.example":
            fails.append(f"[1 bí mật] tệp môi trường trong diff: {n}")

    # 2. Dữ liệu thật
    hit(REAL_DATA, lambda l: f"[2 dữ liệu thật] {l}")

    # 3. Mã hoá (bỏ qua chính tệp này: nó chứa chuỗi mojibake mẫu trong mô tả và biểu thức dò)
    self_name = Path(__file__).resolve().relative_to(ROOT).as_posix()
    saved = added.pop(self_name, None)
    hit([(MOJIBAKE, "mojibake")], lambda l: f"[3 mã hoá] {l}")
    if saved is not None:
        added[self_name] = saved
    check = subprocess.run(["git", "diff", "--check", *rng, "--"], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check.returncode != 0:
        fails.append("[3 mã hoá] git diff --check: " + " | ".join(check.stdout.strip().splitlines()[:4]))

    # 4. Đổi xuống dòng cả tệp
    def numstat(extra: list[str]) -> dict[str, int]:
        out: dict[str, int] = {}
        for row in git("diff", "--numstat", *extra, *rng, "--").splitlines():
            parts = row.split("\t")
            if len(parts) == 3 and parts[0].isdigit():
                out[parts[2]] = int(parts[0]) + int(parts[1])
        return out
    plain, no_cr = numstat([]), numstat(["--ignore-cr-at-eol"])
    for n, total in plain.items():
        clean = no_cr.get(n, total)
        if total >= 40 and clean * 4 < total:
            fails.append(f"[4 xuống dòng] {n}: diff {total} dòng nhưng chỉ {clean} dòng khác thật → đổi CRLF/LF cả tệp")

    # 5. Phiên bản Extension: chỉ xét khi diff ĐỔI số phiên bản trong manifest (nhiều test giả lập Extension cũ ở mức tối thiểu là cố ý)
    manifest_rel = "extension/inside-po-connector/manifest.json"
    try:
        version = json.loads(MANIFEST.read_text(encoding="utf-8"))["version"] if not args.commit else json.loads(git("show", f"{args.commit}:{manifest_rel}"))["version"]
    except Exception as error:  # noqa: BLE001
        version, fails = None, fails + [f"[5 phiên bản] không đọc được manifest: {error}"]
    base_ref = f"{args.commit}~1" if args.commit else "HEAD"
    try:
        old_version = json.loads(git("show", f"{base_ref}:{manifest_rel}"))["version"]
    except Exception:  # noqa: BLE001
        old_version = version
    if version and old_version != version:
        tree = (lambda p: git("show", f"{args.commit}:{p}")) if args.commit else (lambda p: (ROOT / p).read_text(encoding="utf-8", errors="replace"))
        for test in sorted((ROOT / "tests").glob("*.*js")):
            rel = test.relative_to(ROOT).as_posix()
            for i, line in enumerate(tree(rel).splitlines(), 1):
                if VERSION_LINE.search(line) and old_version in VERSION_LIT.findall(line):
                    fails.append(f"[5 phiên bản] {rel}:{i} còn khẳng định {old_version}, manifest đã lên {version}")
        readme = tree("extension/inside-po-connector/README.md")
        if f"Phiên bản {version}" not in readme:
            fails.append(f"[5 phiên bản] README Extension chưa có ghi chú 'Phiên bản {version}'")

    # 6. Phụ thuộc
    for path, lines in added.items():
        if path == "index.html" or path.startswith("extension/"):
            for no, text in lines:
                if CDN.search(text):
                    fails.append(f"[6 phụ thuộc] thẻ nạp ngoài mới: {path}:{no}: {text.strip()[:100]}")
    version_only = re.compile(r'''^\s*"version"\s*:\s*"[^"]+"\s*,?\s*$''')
    for n in names:
        if "/node_modules/" in n:
            fails.append(f"[6 phụ thuộc] tệp gói npm trong diff: {n}")
        elif Path(n).name == "package.json":
            # Chỉ bỏ qua khi tệp đã có từ trước và mọi dòng thêm vào chỉ là dòng "version" (tệp mới hoặc dòng khác đổi thì vẫn chặn).
            changed = added.get(n, [])
            if not changed or any(not version_only.match(text) for _no, text in changed):
                fails.append(f"[6 phụ thuộc] tệp gói npm trong diff: {n}")

    # 7. Bản đồ dự án (cảnh báo)
    touches_map = "docs/PROJECT_MAP.md" in names
    triggers = [n for n in names if n.startswith("supabase/") or n.startswith("extension/inside-po-connector/") and n.endswith(".js")]
    new_blocks = [f"index.html:{no}" for no, text in added.get("index.html", []) if BLOCK_ID.search(text)]
    if (triggers or new_blocks) and not touches_map:
        warns.append("[7 bản đồ] diff đụng " + ", ".join((triggers + new_blocks)[:5]) + " nhưng docs/PROJECT_MAP.md không đổi — kiểm xem bản đồ có cần cập nhật")

    # 8–11. Cảnh báo theo chuẩn docs/chuan (không chặn)
    def content_of(path: str) -> str:
        if args.commit:
            return git("show", f"{args.commit}:{path}")
        if args.cached:
            return git("show", f":{path}")
        file = ROOT / path
        return file.read_text(encoding="utf-8", errors="replace") if file.exists() else ""

    rules_text = RULES.read_text(encoding="utf-8", errors="replace") if RULES.exists() else ""
    for path, lines in added.items():
        nos = {no for no, _text in lines}
        if path.endswith(".md"):
            for no, length in doc_long_lines(content_of(path), nos)[:5]:
                warns.append(f"[8 tài liệu] {path}:{no}: dòng {length} ký tự > {DOC_LINE_MAX} (docs/chuan/TAI_LIEU.md)")
            if rules_text and path != "RULES.md":
                codes = missing_codes([text for _no, text in lines], rules_text)
                if codes:
                    warns.append(f"[10 mã nhật ký] {path}: không thấy thẻ trong RULES.md: {', '.join(codes[:8])}")
        elif path.startswith("supabase/") and path.endswith(".sql"):
            for issue in definer_issues(content_of(path), nos)[:6]:
                warns.append(f"[9 SQL] {path}: {issue}")
    message = ""
    if args.message_file:
        message = Path(args.message_file).read_text(encoding="utf-8", errors="replace")
    elif args.commit:
        message = git("log", "-1", "--format=%B", args.commit)
    if args.message_file or args.commit:
        for issue in message_issues(message):
            warns.append(f"[11 commit] {issue}")

    untracked = [n for n in git("ls-files", "--others", "--exclude-standard").splitlines() if n]
    if untracked and not args.commit:
        warns.append(f"[tệp chưa theo dõi, không soát] {', '.join(untracked[:8])}{' …' if len(untracked) > 8 else ''}")

    print(f"Soát {len(names)} tệp: " + ", ".join(names[:10]) + (" …" if len(names) > 10 else ""))
    for w in warns:
        print("CẢNH BÁO " + w)
    for f in fails:
        print("KHÔNG ĐẠT " + f)
    if fails:
        print(f"\nChưa đủ điều kiện commit: {len(fails)} mục.")
        return 1
    print("\nĐủ điều kiện commit: 7 mục ĐẠT" + (f" ({len(warns)} cảnh báo)." if warns else "."))
    return 0


if __name__ == "__main__":
    sys.exit(main())
