#!/usr/bin/env python3
"""Upsert the local SKU SQLite database into Supabase via its REST API.

Required environment variables:

    SUPABASE_URL
    SUPABASE_SECRET_KEY

The sync is intentionally non-destructive: records missing from the local
database are not deleted from Supabase.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


DEFAULT_TABLE = "SKU_Name"
DEFAULT_BATCH_SIZE = 500


def active_skus(database: Path) -> list[dict[str, str]]:
    connection = sqlite3.connect(database)
    try:
        columns = {
            row[1] for row in connection.execute("PRAGMA table_info(products)")
        }
        required = {
            "sku",
            "product_name",
            "category_id",
            "category_name",
            "status",
        }
        missing = sorted(required.difference(columns))
        if missing:
            raise ValueError(
                f"products table is missing required columns: {', '.join(missing)}"
            )

        rows = connection.execute(
            """
            SELECT sku, product_name, category_id, category_name, status
            FROM products
            WHERE TRIM(sku) <> ''
              AND TRIM(product_name) <> ''
              AND status = '1'
            ORDER BY sku
            """
        ).fetchall()
    finally:
        connection.close()

    updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return [
        {
            "sku": str(sku).strip(),
            "product_name": str(product_name).strip(),
            "category_id": str(category_id or "").strip(),
            "category_name": str(category_name or "").strip(),
            "status": str(status).strip(),
            "updated_at": updated_at,
        }
        for sku, product_name, category_id, category_name, status in rows
    ]


def request_headers(secret_key: str) -> dict[str, str]:
    return {
        "apikey": secret_key,
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/json; charset=utf-8",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def upsert_batch(
    endpoint: str,
    secret_key: str,
    batch: list[dict[str, str]],
    retries: int = 3,
) -> None:
    payload = json.dumps(batch, ensure_ascii=False).encode("utf-8")
    for attempt in range(1, retries + 1):
        request = Request(
            endpoint,
            data=payload,
            headers=request_headers(secret_key),
            method="POST",
        )
        try:
            with urlopen(request, timeout=45) as response:
                if response.status not in (200, 201, 204):
                    raise RuntimeError(f"Unexpected HTTP status {response.status}")
            return
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:1000]
            retryable = error.code == 429 or 500 <= error.code < 600
            if attempt == retries or not retryable:
                raise RuntimeError(f"Supabase HTTP {error.code}: {detail}") from error
        except (URLError, TimeoutError) as error:
            if attempt == retries:
                raise RuntimeError(f"Cannot reach Supabase: {error}") from error
        time.sleep(attempt * 2)


def sync(
    database: Path,
    supabase_url: str,
    secret_key: str,
    table: str,
    batch_size: int,
) -> dict[str, object]:
    records = active_skus(database)
    endpoint = (
        f"{supabase_url.rstrip('/')}/rest/v1/{quote(table, safe='')}"
        "?on_conflict=sku"
    )
    batch_count = 0
    for start in range(0, len(records), batch_size):
        upsert_batch(endpoint, secret_key, records[start : start + batch_size])
        batch_count += 1
        print(
            f"Synced {min(start + batch_size, len(records))}/{len(records)} SKU",
            file=sys.stderr,
        )
    return {
        "database": str(database.resolve()),
        "table": table,
        "active_skus": len(records),
        "batches": batch_count,
        "mode": "upsert_only",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", "-d", type=Path, default=Path("data/sku.db"))
    parser.add_argument("--table", default=DEFAULT_TABLE)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and count local data without contacting Supabase",
    )
    args = parser.parse_args()

    if not args.database.is_file():
        parser.error(f"Database does not exist: {args.database}")
    if args.batch_size < 1 or args.batch_size > 1000:
        parser.error("--batch-size must be between 1 and 1000")

    if args.dry_run:
        records = active_skus(args.database.resolve())
        categories: dict[str, int] = {}
        for record in records:
            label = f"{record['category_id']} | {record['category_name']}"
            categories[label] = categories.get(label, 0) + 1
        print(
            json.dumps(
                {
                    "database": str(args.database.resolve()),
                    "active_skus": len(records),
                    "categories": categories,
                    "mode": "dry_run",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    secret_key = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if not supabase_url:
        parser.error("SUPABASE_URL is not set")
    if not secret_key:
        parser.error("SUPABASE_SECRET_KEY is not set")
    if not supabase_url.startswith("https://"):
        parser.error("SUPABASE_URL must start with https://")

    result = sync(
        args.database.resolve(),
        supabase_url,
        secret_key,
        args.table,
        args.batch_size,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
