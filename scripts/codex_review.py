"""Gửi một thay đổi cho Codex CLI review độc lập (chỉ đọc), kết quả ghi ra tệp Markdown.

    python scripts/codex_review.py --commit <sha>            # review một commit
    python scripts/codex_review.py --working-tree            # review diff cây làm việc so với HEAD
    python scripts/codex_review.py --images <thư mục ảnh>    # review giao diện từ ảnh chụp (kèm --brief)
    tuỳ chọn: --brief <tệp.md> (bản giao việc / bối cảnh), --out <tệp.md>, --max 10, --focus "<chuỗi>"

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

OUTPUT_CODE = """Đầu ra bằng tiếng Việt, tối đa {max_findings} phát hiện, xếp theo mức nghiêm trọng giảm dần. Mỗi phát hiện: tệp và dòng
(bản sau thay đổi), mức (nghiêm trọng / trung bình / nhỏ), mô tả, kịch bản dữ liệu cụ thể dẫn tới sai, đề xuất sửa ngắn.
Ưu tiên: mất dữ liệu hoặc bỏ sót khi đồng bộ, so sánh sai kiểu, điều kiện dừng phân trang, SQL sai ngữ nghĩa, tương thích giữa
Extension cũ/mới và Edge cũ/mới, quyền và bí mật. Phần nào không thấy lỗi thì ghi rõ "không phát hiện".
"""

OUTPUT_UI = """Đầu ra bằng tiếng Việt, tối đa {max_findings} nhận xét, xếp theo mức tác động giảm dần. Mỗi nhận xét: ảnh số mấy và vùng nào,
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
    args = parser.parse_args()

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
        else:
            diff = git("diff", "--no-color", "HEAD")
            if not diff.strip():
                print("Cây làm việc không có thay đổi so với HEAD", file=sys.stderr)
                return 2
            parts.append("Review MÃ của thay đổi trong cây làm việc so với HEAD:\n```diff\n" + diff + "\n```")
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
