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
 6. Phụ thuộc: thẻ <script src=http…>/<link href=http…> mới trong index.html/extension, package.json/node_modules mới.
 7. Bản đồ (cảnh báo): diff thêm migration, Edge, tệp Extension hoặc khối <script id=/<style id= mới mà docs/PROJECT_MAP.md không đổi.

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
    for n in names:
        if Path(n).name == "package.json" or "/node_modules/" in n:
            fails.append(f"[6 phụ thuộc] tệp gói npm trong diff: {n}")

    # 7. Bản đồ dự án (cảnh báo)
    touches_map = "docs/PROJECT_MAP.md" in names
    triggers = [n for n in names if n.startswith("supabase/") or n.startswith("extension/inside-po-connector/") and n.endswith(".js")]
    new_blocks = [f"index.html:{no}" for no, text in added.get("index.html", []) if BLOCK_ID.search(text)]
    if (triggers or new_blocks) and not touches_map:
        warns.append("[7 bản đồ] diff đụng " + ", ".join((triggers + new_blocks)[:5]) + " nhưng docs/PROJECT_MAP.md không đổi — kiểm xem bản đồ có cần cập nhật")

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
