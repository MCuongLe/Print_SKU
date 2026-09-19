#!/usr/bin/env python3
"""Apply a .sql file to the Supabase project through the Management API.

No psql, no Supabase CLI, no third-party package: the Management API accepts a
whole SQL script over HTTPS, so the standard library is enough.

Required credential, looked up in this order:

    1. environment variable SUPABASE_ACCESS_TOKEN
    2. line ``SUPABASE_ACCESS_TOKEN=...`` in the repository ``.env`` file

The token is a Supabase *personal access token* (``sbp_...``) created at
https://supabase.com/dashboard/account/tokens. It is not the publishable key and
not the secret key; those two only reach PostgREST and cannot run DDL. ``.env``
is already excluded from Git. The token is never printed by this script.

The project reference comes from SUPABASE_URL (https://<ref>.supabase.co) unless
--project-ref says otherwise.

Usage:

    python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql --dry-run
    python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


MANAGEMENT_API = "https://api.supabase.com"
TOKEN_VARIABLE = "SUPABASE_ACCESS_TOKEN"

# Cầu dao: một lượt nạp schema bình thường chỉ thêm bảng, thêm cột và thay hàm.
# Câu lệnh xoá dữ liệu hoặc xoá đối tượng phải được gọi tên rõ bằng --allow-destructive,
# vì chạy nhầm lên database production thì không có đường lùi.
DESTRUCTIVE_PATTERNS = (
    (r"\bdrop\s+(table|schema|database|view|type|index|function|trigger|policy)\b", "DROP"),
    (r"\btruncate\b", "TRUNCATE"),
    (r"\bdelete\s+from\b", "DELETE FROM"),
    (r"\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b", "ALTER TABLE ... DROP"),
)

INTROSPECTION = """
select 'table' as kind, table_name as name
  from information_schema.tables
 where table_schema = 'public'
union all
select 'function' as kind, routine_name as name
  from information_schema.routines
 where routine_schema = 'public'
 order by kind, name
"""


def strip_sql_comments(sql: str) -> str:
    """Remove -- line comments and /* block */ comments before scanning."""
    without_blocks = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    return re.sub(r"--[^\n]*", " ", without_blocks)


def strip_function_bodies(sql: str) -> str:
    """Drop $$ ... $$ bodies.

    A ``delete from`` inside a function body is a definition, not something this
    run executes. Scanning it as a live statement makes the circuit breaker fire
    on every ordinary migration, which teaches people to pass --allow-destructive
    by reflex -- and that is exactly how a breaker stops protecting anything.
    Semicolons inside those bodies would also inflate the statement count.
    """
    return re.sub(r"\$([A-Za-z_]\w*)?\$.*?\$\1?\$", " ", sql, flags=re.DOTALL)


def top_level_sql(sql: str) -> str:
    return strip_function_bodies(strip_sql_comments(sql))


def destructive_statements(sql: str) -> list[str]:
    body = top_level_sql(sql).lower()
    return [label for pattern, label in DESTRUCTIVE_PATTERNS if re.search(pattern, body)]


def read_token(repository: Path) -> str:
    token = (os.environ.get(TOKEN_VARIABLE) or "").strip()
    if token:
        return token
    env_file = repository / ".env"
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            name, separator, value = line.partition("=")
            if separator and name.strip() == TOKEN_VARIABLE:
                return value.strip().strip('"').strip("'")
    return ""


def project_ref(explicit: str) -> str:
    if explicit:
        return explicit
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    match = re.match(r"https://([a-z0-9]+)\.supabase\.(co|in)", url)
    if not match:
        raise SystemExit(
            "Không xác định được project ref. Đặt SUPABASE_URL=https://<ref>.supabase.co "
            "hoặc truyền --project-ref."
        )
    return match.group(1)


def run_query(ref: str, token: str, sql: str, timeout: int) -> object:
    request = Request(
        f"{MANAGEMENT_API}/v1/projects/{ref}/database/query",
        data=json.dumps({"query": sql}).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
    except HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:600]
        hint = ""
        if error.code in (401, 403):
            hint = (
                f"\nToken không dùng được. {TOKEN_VARIABLE} phải là personal access token "
                "(sbp_...) tạo ở https://supabase.com/dashboard/account/tokens — "
                "không phải publishable key hay secret key."
            )
        raise SystemExit(f"Management API HTTP {error.code}: {detail}{hint}") from error
    except URLError as error:
        raise SystemExit(f"Không gọi được Management API: {error.reason}") from error
    return json.loads(body) if body.strip() else []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sql_file", type=Path, help="đường dẫn file .sql cần chạy")
    parser.add_argument("--project-ref", default="", help="ghi đè project ref lấy từ SUPABASE_URL")
    parser.add_argument("--dry-run", action="store_true", help="chỉ in ra những gì sẽ chạy, không gọi Supabase")
    parser.add_argument("--allow-destructive", action="store_true", help="cho phép file chứa DROP / TRUNCATE / DELETE")
    parser.add_argument("--no-verify", action="store_true", help="bỏ bước liệt kê bảng và hàm sau khi chạy")
    parser.add_argument("--timeout", type=int, default=120, help="giây chờ mỗi lần gọi (mặc định 120)")
    arguments = parser.parse_args()

    if not arguments.sql_file.is_file():
        raise SystemExit(f"Không thấy file: {arguments.sql_file}")
    sql = arguments.sql_file.read_text(encoding="utf-8-sig")
    if not sql.strip():
        raise SystemExit("File SQL rỗng.")

    risky = destructive_statements(sql)
    if risky and not arguments.allow_destructive:
        raise SystemExit(
            f"Dừng: file chứa {', '.join(risky)}. Xem lại rồi chạy lại kèm --allow-destructive "
            "nếu thật sự muốn xoá."
        )

    repository = Path(__file__).resolve().parent.parent
    ref = project_ref(arguments.project_ref)
    statements = [part for part in top_level_sql(sql).split(";") if part.strip()]

    print(f"File      : {arguments.sql_file}")
    print(f"Project   : {ref}")
    print(f"Câu lệnh  : {len(statements)}")
    if risky:
        print(f"Cảnh báo  : {', '.join(risky)} (đã bật --allow-destructive)")

    if arguments.dry_run:
        print("\n--dry-run: không gọi Supabase. Nội dung sẽ gửi:\n")
        print(sql.rstrip())
        return 0

    token = read_token(repository)
    if not token:
        raise SystemExit(
            f"Thiếu {TOKEN_VARIABLE}. Tạo personal access token ở "
            "https://supabase.com/dashboard/account/tokens rồi đặt vào biến môi trường "
            f"{TOKEN_VARIABLE}, hoặc thêm dòng {TOKEN_VARIABLE}=sbp_... vào file .env ở gốc repo "
            "(.env đã nằm trong .gitignore)."
        )

    run_query(ref, token, sql, arguments.timeout)
    print("\nĐã chạy xong.")

    if arguments.no_verify:
        return 0

    rows = run_query(ref, token, INTROSPECTION, arguments.timeout)
    tables = [row["name"] for row in rows if isinstance(row, dict) and row.get("kind") == "table"]
    functions = [row["name"] for row in rows if isinstance(row, dict) and row.get("kind") == "function"]
    print(f"\nSchema public hiện có {len(tables)} bảng và {len(functions)} hàm.")
    print("Bảng  : " + (", ".join(tables) if tables else "—"))
    print("Hàm   : " + (", ".join(functions) if functions else "—"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
