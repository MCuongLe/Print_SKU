"""Gửi một thay đổi cho Codex CLI review độc lập (chỉ đọc), kết quả ghi ra tệp Markdown.

    python scripts/codex_review.py --commit <sha>            # review một commit
    python scripts/codex_review.py --working-tree            # review diff cây làm việc so với HEAD
    python scripts/codex_review.py --images <thư mục ảnh>    # review giao diện từ ảnh chụp (kèm --brief)
    tuỳ chọn: --brief <tệp.md> (bản giao việc / bối cảnh), --out <tệp.md>, --max 10, --focus "<chuỗi>"
              --add <tệp mới chưa theo dõi> ... (đưa tệp mới vào diff cây làm việc)

Ba luật review (người dùng chốt 18/10/2026, docs/DOI_AGENT.md):
 1. Tối đa 3 vòng cho một đợt: `--round N` (1–3); vòng 4 bị từ chối → dừng, xem lại hướng tiếp cận thay vì vá tiếp.
 2. Vòng sau chỉ review phần vừa sửa: mỗi lượt --working-tree lưu ảnh chụp các tệp đang đổi vào outputs/codex-review/snap-<giờ>/
    (đường dẫn in ra và ghi ở outputs/codex-review/last-snapshot); vòng sau chạy `--working-tree --since last --round 2`
    → chỉ gửi diff giữa ảnh chụp và cây hiện tại, không quét lại cả đợt.
 3. Gom lỗi theo loại: Codex xếp phát hiện theo nhóm cùng nguyên nhân / cùng mẫu, mỗi nhóm kê mọi vị trí (cả chỗ tương tự ngoài
    diff mà nó thấy) để một lần sửa xử lý sạch cả nhóm.

Yêu cầu: Codex CLI đã cài (`npm install -g @openai/codex`) và đã đăng nhập. Không cần khoá API trong repo.
Codex chạy với `--sandbox read-only`, không sửa được tệp. Script không gửi .env hay bất kỳ bí mật nào:
chỉ gửi diff/ảnh được chỉ định, bản giao việc (nếu có) và phần "quyết định đã chốt" trích từ RULES.md theo từ khoá.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):  # Windows mặc định cp1252, không in được tiếng Việt / mũi tên
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[1]
RULES = ROOT / "RULES.md"
IMAGE_TYPES = {".png", ".jpg", ".jpeg", ".webp"}

CONTEXT = """Bạn là reviewer độc lập cho repo Print_SKU: ứng dụng web tĩnh một tệp index.html (React bundle + nhiều khối
<script id=…> thuần), Chrome Extension CHỈ ĐỌC (extension/inside-po-connector: cào HTML Inside, gọi API WMS bằng phiên của tab
đang đăng nhập), Supabase (SQL/RPC/pg_cron trong supabase/*.sql, Edge Function Deno trong supabase/functions/*), test Playwright
trong tests/. Giao diện tiếng Việt có dấu, icon Lucide trước nhãn ngắn, không câu hướng dẫn trong màn, không phụ thuộc ngoài.

Quy tắc review: chỉ đọc, không sửa tệp. Không coi là lỗi những quyết định đã chốt được liệt kê bên dưới. Không bình luận phong cách.
"""

OUTPUT_CODE = """Đầu ra bằng tiếng Việt, tối đa {max_findings} NHÓM lỗi, xếp theo mức nghiêm trọng giảm dần. GOM THEO LOẠI: các lỗi cùng
nguyên nhân hoặc cùng mẫu (ví dụ cùng thiếu kiểm null, cùng độ ưu tiên CSS bị đè, cùng quên một nhánh) là MỘT nhóm. Mỗi nhóm: tên loại,
mức (nghiêm trọng / trung bình / nhỏ), nguyên nhân chung, danh sách MỌI vị trí bị ảnh hưởng (tệp:dòng bản sau thay đổi — kể cả chỗ
tương tự ngoài diff mà bạn tìm thấy trong repo), một kịch bản dữ liệu cụ thể dẫn tới sai, một cách sửa áp được cho cả nhóm.
Ưu tiên: mất dữ liệu hoặc bỏ sót khi đồng bộ, so sánh sai kiểu, điều kiện dừng phân trang, SQL sai ngữ nghĩa, tương thích giữa
Extension cũ/mới và Edge cũ/mới, quyền và bí mật. Phần nào không thấy lỗi thì ghi rõ "không phát hiện".
"""

OUTPUT_UI = """Đầu ra bằng tiếng Việt, tối đa {max_findings} nhận xét, xếp theo mức tác động giảm dần; vấn đề cùng loại xuất hiện ở nhiều
ảnh gom thành một nhận xét kê đủ các ảnh. Mỗi nhận xét: ảnh số mấy và vùng nào,
vấn đề (thứ bậc thông tin, khoảng cách, tương phản, nhãn gây hiểu nhầm, thao tác thừa, trạng thái thiếu), ảnh hưởng tới quyết định
của người dùng, đề xuất cụ thể làm được trong CSS/HTML của chính màn đó và nằm trong chuẩn: thang chữ 12/13/14/16/18/22/28, đậm
400/600/700, icon Lucide 16/20/24, không thêm font hay thư viện. Cuối cùng nêu 3 điều đang làm tốt nên giữ. Không nhận xét dữ liệu giả.
"""


def git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace").stdout


def rules_excerpt(keywords: list[str], limit: int = 40) -> str:
    """Trích các dòng RULES.md chứa 'không', 'cố ý', 'đã chốt', 'quyết định' và một trong các từ khoá."""
    if not RULES.exists():
        return ""
    picked: list[str] = []
    for line in RULES.read_text(encoding="utf-8", errors="replace").splitlines():
        low = line.lower()
        if not any(k.lower() in low for k in keywords):
            continue
        if re.search(r"không |cố ý|đã chốt|quyết định|người dùng:", low):
            picked.append(line.strip()[:400])
        if len(picked) >= limit:
            break
    return "\n".join(picked)


SNAP_ROOT = ROOT / "outputs" / "codex-review"
MAX_ROUNDS = 3
NULL = "NUL" if sys.platform == "win32" else "/dev/null"


def rel_of(path: str) -> str:
    return Path(path).resolve().relative_to(ROOT).as_posix()


def changed_paths(extra: list[str]) -> list[str]:
    """Tệp đã theo dõi đang khác HEAD + tệp mới được chỉ định bằng --add."""
    paths = [n for n in git("diff", "--name-only", "HEAD").splitlines() if n]
    for e in extra:
        rel = rel_of(e)
        if rel not in paths:
            paths.append(rel)
    return paths


def file_diff(old: Path | None, new: Path, label: str) -> str:
    """diff một tệp giữa hai bản (old None hoặc không có = tệp mới), nhãn a/<label> b/<label>."""
    left = str(old) if old is not None and old.exists() else NULL
    right = str(new) if new.exists() else NULL
    raw = subprocess.run(["git", "diff", "--no-index", "--no-color", "--", left, right], cwd=ROOT, capture_output=True,
                         text=True, encoding="utf-8", errors="replace").stdout
    lines = []
    for line in raw.splitlines():
        if line.startswith("diff --git "):
            line = f"diff --git a/{label} b/{label}"
        elif line.startswith("--- ") and not line.startswith("--- /dev/null"):
            line = f"--- a/{label}"
        elif line.startswith("+++ ") and not line.startswith("+++ /dev/null"):
            line = f"+++ b/{label}"
        lines.append(line)
    return "\n".join(lines) + ("\n" if lines else "")


def working_diff(extra: list[str]) -> str:
    diff = git("diff", "--no-color", "HEAD")
    for e in extra:
        rel = rel_of(e)
        if not git("ls-files", "--", rel).strip():
            diff += file_diff(None, ROOT / rel, rel)
    return diff


def since_diff(snap: Path, extra: list[str]) -> str:
    """Chỉ phần đổi từ ảnh chụp vòng trước tới cây hiện tại (luật 2)."""
    listed = set((snap / "paths.txt").read_text(encoding="utf-8").splitlines()) if (snap / "paths.txt").exists() else set()
    out = []
    for rel in sorted(set(changed_paths(extra)) | listed):
        if rel in listed:
            out.append(file_diff(snap / "files" / rel, ROOT / rel, rel))
        else:  # tệp bắt đầu đổi sau vòng trước: so với HEAD, hoặc tệp mới hoàn toàn
            out.append(git("diff", "--no-color", "HEAD", "--", rel) or file_diff(None, ROOT / rel, rel))
    return "".join(out)


def save_snapshot(extra: list[str], stamp: str) -> Path:
    snap = SNAP_ROOT / f"snap-{stamp}"
    paths = changed_paths(extra)
    for rel in paths:
        src = ROOT / rel
        if src.exists():
            dst = snap / "files" / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(src.read_bytes())
    snap.mkdir(parents=True, exist_ok=True)
    (snap / "paths.txt").write_text("\n".join(paths), encoding="utf-8")
    (SNAP_ROOT / "last-snapshot").write_text(str(snap), encoding="utf-8")
    return snap


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--commit")
    group.add_argument("--working-tree", action="store_true")
    group.add_argument("--images")
    parser.add_argument("--brief", help="tệp Markdown bản giao việc / bối cảnh màn")
    parser.add_argument("--focus", default="", help="câu hỏi trọng tâm cho reviewer")
    parser.add_argument("--keywords", default="", help="từ khoá trích RULES.md, cách nhau bởi dấu phẩy")
    parser.add_argument("--max", type=int, default=10)
    parser.add_argument("--out")
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--round", type=int, default=1, help="vòng thứ mấy của đợt này (tối đa 3)")
    parser.add_argument("--since", help="thư mục ảnh chụp vòng trước, hoặc 'last': chỉ review phần sửa từ đó")
    parser.add_argument("--add", nargs="*", default=[], help="tệp mới chưa theo dõi cần đưa vào diff cây làm việc")
    parser.add_argument("--prepare-only", action="store_true",
                        help="chỉ dựng nội dung review (diff + RULES + luật vòng) ra outputs/claude-review/prompt-*.md cho /review-claude, không gọi Codex")
    args = parser.parse_args()
    if args.round > MAX_ROUNDS:
        print(f"Đã {MAX_ROUNDS} vòng review cho đợt này mà chưa xong: DỪNG vá, xem lại hướng tiếp cận (thiết kế, nguyên nhân gốc) "
              "rồi báo người dùng trước khi review tiếp.", file=sys.stderr)
        return 3
    if args.since and not args.working_tree:
        print("--since chỉ dùng với --working-tree", file=sys.stderr)
        return 2

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M")
    out = Path(args.out) if args.out else ROOT / "outputs" / "codex-review" / f"review-{stamp}.md"
    out.parent.mkdir(parents=True, exist_ok=True)

    parts = [CONTEXT]
    images: list[Path] = []
    if args.images:
        folder = Path(args.images)
        images = sorted(p for p in folder.iterdir() if p.suffix.lower() in IMAGE_TYPES)
        if not images:
            print(f"Không có ảnh trong {folder}", file=sys.stderr)
            return 2
        parts.append("Review GIAO DIỆN từ ảnh đính kèm, theo thứ tự tên tệp:\n" + "\n".join(f"{i + 1}. {p.name}" for i, p in enumerate(images)))
        output = OUTPUT_UI
    else:
        if args.commit:
            diff = git("show", "--stat", "--patch", "--no-color", args.commit)
            parts.append(f"Review MÃ của commit {args.commit} (diff đính kèm; đọc thêm tệp trong repo nếu cần):\n```diff\n{diff}\n```")
        elif args.since:
            snap = Path((SNAP_ROOT / "last-snapshot").read_text(encoding="utf-8").strip()) if args.since == "last" else Path(args.since)
            if not snap.is_dir():
                print(f"Không thấy ảnh chụp {snap}", file=sys.stderr)
                return 2
            diff = since_diff(snap, args.add)
            if not diff.strip():
                print("Không có gì sửa từ vòng trước", file=sys.stderr)
                return 2
            parts.append(f"Vòng {args.round}/{MAX_ROUNDS}: CHỈ review phần vừa sửa sau vòng trước (diff dưới đây so với ảnh chụp vòng trước). "
                         "Không quét lại phần đã review; chỉ báo lỗi mới do bản sửa gây ra, hoặc bản sửa chưa xử lý hết cả nhóm lỗi:\n```diff\n"
                         + diff + "\n```")
        else:
            diff = working_diff(args.add)
            if not diff.strip():
                print("Cây làm việc không có thay đổi so với HEAD", file=sys.stderr)
                return 2
            parts.append(f"Vòng {args.round}/{MAX_ROUNDS}. Review MÃ của thay đổi trong cây làm việc so với HEAD:\n```diff\n" + diff + "\n```")
        output = OUTPUT_CODE
    if args.brief:
        parts.append("Bản giao việc / bối cảnh:\n" + Path(args.brief).read_text(encoding="utf-8", errors="replace"))
    keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    if keywords:
        excerpt = rules_excerpt(keywords)
        if excerpt:
            parts.append("Quyết định đã chốt (trích RULES.md):\n" + excerpt)
    if args.focus:
        parts.append("Trọng tâm: " + args.focus)
    parts.append(output.format(max_findings=args.max))
    prompt = "\n\n".join(parts)

    if args.prepare_only:
        # /review-claude (18/10/2026): cùng phạm vi, cùng luật 3 vòng / --since last với Codex; các agent Claude đọc tệp này.
        prompt_out = ROOT / "outputs" / "claude-review" / f"prompt-{stamp}.md"
        prompt_out.parent.mkdir(parents=True, exist_ok=True)
        prompt_out.write_text(prompt, encoding="utf-8")
        print(f"PROMPT {prompt_out}")
        print(f"REPORT {ROOT / 'outputs' / 'claude-review' / f'review-{stamp}.md'}")
        if args.working_tree:
            snap = save_snapshot(args.add, stamp)
            print(f"Ảnh chụp vòng {args.round}: {snap}")
        return 0

    cmd = ["codex", "exec", "--sandbox", "read-only", "-C", str(ROOT), "-o", str(out)]
    for image in images:
        cmd += ["-i", str(image)]
    cmd.append("-")
    print(f"Codex review → {out}", flush=True)
    try:
        run = subprocess.run(cmd, input=prompt, text=True, encoding="utf-8", errors="replace",
                             capture_output=True, timeout=args.timeout, shell=sys.platform == "win32")
    except FileNotFoundError:
        print("Không thấy lệnh codex; cài: npm install -g @openai/codex", file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        print(f"Codex quá {args.timeout} giây", file=sys.stderr)
        return 2
    if run.returncode != 0:
        print(run.stderr[-2000:], file=sys.stderr)
        return run.returncode
    if out.exists():
        print(out.read_text(encoding="utf-8", errors="replace"))
    if args.working_tree:
        snap = save_snapshot(args.add, stamp)
        nxt = args.round + 1
        print(f"\nẢnh chụp vòng {args.round}: {snap}")
        print(f"Vòng {nxt} (chỉ phần sửa): python scripts/codex_review.py --working-tree --since last --round {nxt}" if nxt <= MAX_ROUNDS
              else f"Đã đủ {MAX_ROUNDS} vòng: không review tiếp; còn lỗi thì xem lại hướng tiếp cận.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
