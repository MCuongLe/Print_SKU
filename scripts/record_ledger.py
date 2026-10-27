#!/usr/bin/env python3
"""Ghi sổ `release_ledger` cho migration đã chạy trực tiếp bằng `apply_supabase_sql.py` (lead tự chạy, 26/10/2026).

`release.py --plan` coi migration chưa có trong sổ là "còn chờ"; chạy trực tiếp thì sổ không tự cập nhật. Sau khi COMMIT migration, chạy:

    python scripts/record_ledger.py supabase/cut_source_v1.sql [supabase/khac.sql ...] [--dry-run] [--note "..."]

Chỉ ghi (insert / upsert, không xoá). Mỗi tệp phải đã commit và nội dung trên đĩa trùng HEAD (sha sau khi đổi CRLF -> LF, đúng cách `release.py` so);
tệp chưa commit hoặc đã sửa sau commit thì dừng. Ghi bằng `apply_supabase_sql.py` (token trong `.env`, không in ra).
"""
from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import release  # noqa: E402  (content_sha, upsert_sql: cùng cách tính sha và câu ghi sổ với release.py)


class Refuse(Exception):
    pass


def git_bytes(args: list[str]) -> bytes:
    done = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
    if done.returncode != 0:
        raise Refuse(done.stderr.decode("utf-8", "replace").strip() or f"git {' '.join(args)} lỗi")
    return done.stdout


def collect(paths: list[str], head_bytes=None, disk_bytes=None) -> list[tuple[str, str]]:
    """[(tên tệp, sha)] của các migration; từ chối khi không nằm ở supabase/, chưa commit hoặc đĩa khác HEAD."""
    head_bytes = head_bytes or (lambda rel: git_bytes(["show", f"HEAD:{rel}"]))
    disk_bytes = disk_bytes or (lambda rel: open(os.path.join(ROOT, rel), "rb").read())
    rows: list[tuple[str, str]] = []
    for raw in paths:
        rel = raw.replace("\\", "/").lstrip("./")
        parts = rel.split("/")
        if len(parts) != 2 or parts[0] != "supabase" or not parts[1].endswith(".sql"):
            raise Refuse(f"{raw}: chỉ nhận supabase/<tên>.sql")
        try:
            head = head_bytes(rel)
        except Refuse:
            raise Refuse(f"{rel}: chưa có ở HEAD, hãy commit trước")
        disk = disk_bytes(rel)
        if release.content_sha(head) != release.content_sha(disk):
            raise Refuse(f"{rel}: nội dung trên đĩa khác HEAD (đã sửa sau commit); commit lại rồi chạy lại")
        rows.append((parts[1], release.content_sha(head)))
    return rows


def build_sql(rows: list[tuple[str, str]], commit: str, holder: str, note: str | None) -> str:
    return ";\n".join(release.upsert_sql("migration", name, sha, commit, holder, note) for name, sha in rows) + ";\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Ghi sổ release_ledger cho migration đã chạy trực tiếp.")
    parser.add_argument("files", nargs="+", help="supabase/<tên>.sql đã commit và đã chạy")
    parser.add_argument("--dry-run", action="store_true", help="chỉ in câu SQL ghi sổ, không ghi")
    parser.add_argument("--note", default="chạy trực tiếp apply_supabase_sql.py (lead, được người dùng cho phép)")
    args = parser.parse_args(argv)
    try:
        rows = collect(args.files)
        commit = git_bytes(["rev-parse", "--short=7", "HEAD"]).decode().strip()
    except Refuse as error:
        print(f"DỪNG: {error}", file=sys.stderr)
        return 2
    sql = build_sql(rows, commit, f"{platform.node()}#lead", args.note)
    if args.dry_run:
        print(sql)
        return 0
    with tempfile.TemporaryDirectory() as folder:
        path = os.path.join(folder, "record_ledger.sql")
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(sql)
        done = subprocess.run([sys.executable, os.path.join(HERE, "apply_supabase_sql.py"), path], cwd=ROOT)
    if done.returncode == 0:
        print(f"Đã ghi sổ {len(rows)} migration ở commit {commit}: {', '.join(name for name, _ in rows)}")
    return done.returncode


if __name__ == "__main__":
    raise SystemExit(main())
