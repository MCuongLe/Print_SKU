#!/usr/bin/env python3
"""Triển khai Edge Function supabase/functions/sku-vision (TÌM SKU) qua Management API.

Không cần Supabase CLI hay Deno — chỉ thư viện chuẩn, giống scripts/apply_supabase_sql.py
(dùng lại read_token / project_ref của file đó).

Token cần quyền "Edge Functions: write" (token chỉ có "Database: read-write" sẽ bị
403). Tạo tại https://supabase.com/dashboard/account/tokens rồi đặt vào dòng
SUPABASE_ACCESS_TOKEN=... của .env. Script không bao giờ in token.

Hàm triển khai với verify_jwt = false vì publishable key dạng sb_publishable_ không
phải JWT; index.ts tự kiểm tra header apikey. Khoá Gemini KHÔNG đi qua script này:
người quản trị tự nhập GEMINI_API_KEY ở Dashboard → Edge Functions → Secrets.

    python scripts/deploy_sku_vision.py --dry-run
    python scripts/deploy_sku_vision.py
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from apply_supabase_sql import MANAGEMENT_API, project_ref, read_token  # noqa: E402

REPOSITORY = Path(__file__).resolve().parent.parent
SLUG = "sku-vision"
SOURCE = REPOSITORY / "supabase" / "functions" / SLUG / "index.ts"


def multipart(metadata: dict, files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    boundary = f"----print-sku-{uuid.uuid4().hex}"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"metadata\"\r\n"
        f"Content-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n".encode("utf-8")
    ]
    for name, content in files:
        parts.append(
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            f"Content-Type: application/typescript\r\n\r\n".encode("utf-8") + content + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(parts), boundary


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--project-ref", default="", help="mặc định lấy từ SUPABASE_URL")
    parser.add_argument("--dry-run", action="store_true", help="chỉ in thông tin sẽ gửi, không gọi Supabase")
    arguments = parser.parse_args()

    source = SOURCE.read_bytes()
    metadata = {"name": SLUG, "entrypoint_path": "index.ts", "verify_jwt": False}
    ref = project_ref(arguments.project_ref)
    print(f"Project: {ref} | hàm: {SLUG} | {SOURCE.relative_to(REPOSITORY)} ({len(source):,} byte) | verify_jwt: false")
    if arguments.dry_run:
        print("Chạy thử: chưa gửi gì lên Supabase.")
        return 0

    token = read_token(REPOSITORY)
    if not token:
        raise SystemExit("Thiếu SUPABASE_ACCESS_TOKEN (biến môi trường hoặc dòng trong .env).")
    body, boundary = multipart(metadata, [("index.ts", source)])
    request = Request(
        f"{MANAGEMENT_API}/v1/projects/{ref}/functions/deploy?slug={SLUG}",
        data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode("utf-8") or "{}")
    except HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:600]
        hint = ""
        if error.code in (401, 403):
            hint = ("\nToken thiếu quyền hoặc hết hạn — tạo token mới có quyền \"Edge Functions: write\" "
                    "tại https://supabase.com/dashboard/account/tokens rồi thay dòng SUPABASE_ACCESS_TOKEN trong .env.")
        raise SystemExit(f"Management API HTTP {error.code}: {detail}{hint}") from error
    except URLError as error:
        raise SystemExit(f"Không gọi được Management API: {error.reason}") from error

    print(f"Đã triển khai {result.get('slug', SLUG)} — phiên bản {result.get('version')} — trạng thái {result.get('status')}.")
    print(f"Địa chỉ: https://{ref}.supabase.co/functions/v1/{SLUG}")
    print("Nhớ đặt GEMINI_API_KEY ở Dashboard → Edge Functions → Secrets nếu chưa đặt.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
