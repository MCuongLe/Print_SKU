"""Hook PreToolUse của Claude Code cho Print_SKU (khai báo ở .claude/settings.json, 18/10/2026).

    python scripts/claude_hooks.py commit   # matcher Bash: lệnh có `git commit` → chạy scripts/commit_gate.py, KHÔNG ĐẠT thì chặn
    python scripts/claude_hooks.py files    # matcher Write|Edit|MultiEdit: chặn ghi đè cả index.html bằng Write, chặn sửa .env

Đọc JSON sự kiện từ stdin. Thoát 0 = cho qua; thoát 2 = chặn, lý do in ra stderr (Claude Code đưa lại cho model).
Lỗi bất ngờ của chính hook (JSON hỏng, thiếu Python…) → cho qua, không khoá việc vì hook hỏng.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def say(text: str) -> None:
    sys.stderr.buffer.write((text + "\n").encode("utf-8", "replace"))
    sys.stderr.flush()


def check_commit(cmd: str) -> int:
    # Chỉ xét khi lệnh thật sự chạy git commit (bỏ qua --dry-run, chuỗi trong echo/grep tách bằng nháy)
    if not re.search(r"(^|[;&|]\s*|\s)git\s+(-C\s+\S+\s+)?commit\b", cmd) or "--dry-run" in cmd:
        return 0
    # `git add … && git commit` trong cùng lệnh: lúc hook chạy, phần add chưa xảy ra → soát cả cây làm việc thay vì chỉ phần đã stage
    args = [sys.executable, str(ROOT / "scripts" / "commit_gate.py")]
    if not re.search(r"\bgit\s+(-C\s+\S+\s+)?add\b", cmd):
        args.append("--cached")
    run = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if run.returncode == 0:
        return 0
    lines = [l for l in run.stdout.splitlines() if l.startswith(("KHÔNG ĐẠT", "Chưa đủ"))]
    say("Hook cổng commit (scripts/commit_gate.py" + (" --cached" if "--cached" in args else "") + ") CHẶN commit:\n" + "\n".join(lines[:15])
        + "\nSửa các mục trên rồi commit lại; nếu là dữ liệu giả hợp lệ bị bắt nhầm thì báo người dùng trước khi bỏ qua.")
    return 2


def check_files(tool: str, data: dict) -> int:
    raw = data.get("file_path") or data.get("path") or ""
    if not raw:
        return 0
    path = Path(raw)
    name = path.name.lower()
    if name == ".env" or (name.startswith(".env.") and name != ".env.example"):
        say(f"Hook chặn {tool} lên {raw}: tệp .env chứa token Management Supabase và khoá — người dùng tự sửa.")
        return 2
    try:
        is_index = path.resolve() == (ROOT / "index.html").resolve()
    except OSError:
        is_index = False
    if tool == "Write" and is_index and path.exists():
        say("Hook chặn Write ghi đè cả index.html (2,3 MB): luật dự án chỉ cho sửa từng đoạn bằng Edit theo chuỗi neo, "
            "và đã có lần phiên khác ghi đè cả tệp. Dùng Edit, hoặc script Python thay đúng chuỗi neo (assert count == 1).")
        return 2
    return 0


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        event = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
    except ValueError:
        return 0
    tool = event.get("tool_name", "")
    data = event.get("tool_input") or {}
    try:
        if mode == "commit" and tool == "Bash":
            return check_commit(str(data.get("command", "")))
        if mode == "files" and tool in ("Write", "Edit", "MultiEdit"):
            return check_files(tool, data)
    except Exception as error:  # noqa: BLE001 — hook hỏng thì cho qua, không chặn việc
        say(f"Hook {mode} lỗi, cho qua: {error}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
