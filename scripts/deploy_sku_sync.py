#!/usr/bin/env python3
"""Triển khai Edge Function sku-sync qua Supabase Management API."""

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
SLUG = "sku-sync"
SOURCE = REPOSITORY / "supabase" / "functions" / SLUG / "index.ts"


def multipart(metadata: dict, files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    boundary = f"----print-sku-{uuid.uuid4().hex}"
    parts = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
        f'Content-Type: application/json\r\n\r\n{json.dumps(metadata)}\r\n'.encode()
    ]
    for name, content in files:
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
            f'Content-Type: application/typescript\r\n\r\n'.encode() + content + b"\r\n"
        )
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), boundary


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", default="")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    source = SOURCE.read_bytes()
    ref = project_ref(args.project_ref)
    print(f"Project: {ref} | hàm: {SLUG} | {len(source):,} byte | verify_jwt: false")
    if args.dry_run:
        return 0
    token = read_token(REPOSITORY)
    if not token:
        raise SystemExit("Thiếu SUPABASE_ACCESS_TOKEN trong môi trường hoặc .env")
    body, boundary = multipart({"name": SLUG, "entrypoint_path": "index.ts", "verify_jwt": False}, [("index.ts", source)])
    request = Request(
        f"{MANAGEMENT_API}/v1/projects/{ref}/functions/deploy?slug={SLUG}", data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    try:
        with urlopen(request, timeout=120) as response:
            result = json.loads(response.read().decode() or "{}")
    except HTTPError as error:
        raise SystemExit(f"Management API HTTP {error.code}: {error.read().decode('utf-8', 'replace')[:600]}") from error
    except URLError as error:
        raise SystemExit(f"Không gọi được Management API: {error.reason}") from error
    print(f"Đã triển khai {result.get('slug', SLUG)} — phiên bản {result.get('version')} — trạng thái {result.get('status')}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
