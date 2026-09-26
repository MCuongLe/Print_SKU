#!/usr/bin/env python3
"""Upsert a WMS "Group UID Detail" export (.xlsx) straight into Supabase.

Required environment variables:

    SUPABASE_URL
    SUPABASE_SECRET_KEY

Nguồn: file .xlsx export tay từ WMS (màn Group UID Detail, ví dụ kho
WH - MATERIAL - MTG) — đúng 22 cột thật đã kiểm chứng ngày 25/09/2026, script
chỉ lấy 10 cột khớp bảng public.group_uid_details (theo TÊN cột, không theo vị
trí, để WMS đổi thứ tự cột vẫn đọc đúng):

    Group UID Code -> group_uid_code   Warehouse   -> warehouse
    Batch Code     -> batch_code       Location    -> location
    Roll Code      -> roll_code        SKU         -> sku
    Qty            -> qty              Updated By  -> updated_by
    Updated Date   -> updated_date     Status      -> status

Cột "SKU Qty"/"Product Qty" KHÔNG phải "Qty" — ba cột số riêng biệt trong file
thật, dò theo đúng tên để không lấy nhầm. "Product Name" bị bỏ qua có chủ đích
(cùng lý do migration group_uid_v3_drop_product.sql: tên sản phẩm tra từ
SKU_Name theo SKU, không lưu lại bản sao từ WMS).

Đồng bộ CHỈ upsert (on_conflict=group_uid_code, giữ nguyên logic
group_uid_import_commit đang dùng: qty/status/... của WMS luôn là bản mới
nhất) — không xoá UID nào vắng mặt trong file, vì mỗi lần export chỉ theo
một kho, không phải toàn bộ hệ thống.

    python scripts/sync_group_uid_to_supabase.py "D:\\UID\\Copy of GROUP_UID_DETAIL_....xlsx"
    python scripts/sync_group_uid_to_supabase.py "..." --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
from import_sku_xlsx import worksheet_rows  # noqa: E402


DEFAULT_TABLE = "group_uid_details"
DEFAULT_BATCH_SIZE = 500
MAX_CODE_LEN = 40

# Ánh xạ theo TÊN cột thật của file export, không theo vị trí.
SOURCE_COLUMNS = {
    "group_uid_code": "Group UID Code",
    "batch_code": "Batch Code",
    "roll_code": "Roll Code",
    "warehouse": "Warehouse",
    "location": "Location",
    "sku": "SKU",
    "qty": "Qty",
    "updated_by": "Updated By",
    "updated_date": "Updated Date",
    "status": "Status",
}
# WMS ghi giờ theo UTC+07:00 (xem comment cột updated_date trong
# supabase/group_uid_v1.sql) nhưng không kèm offset trong file export — phải
# gắn tay, nếu không PostgREST/Postgres sẽ hiểu nhầm giờ UTC và lệch 7 tiếng.
SOURCE_TZ_OFFSET = "+07:00"


def parse_rows(source: Path) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    rows = worksheet_rows(source)
    try:
        headers = next(rows)
    except StopIteration as error:
        raise ValueError("Workbook rỗng") from error
    index = {name.strip(): position for position, name in enumerate(headers)}
    missing = sorted(set(SOURCE_COLUMNS.values()).difference(index))
    if missing:
        raise ValueError(f"File thiếu cột: {', '.join(missing)} — WMS có thể đã đổi tên cột export")

    good: list[dict[str, object]] = []
    bad: list[dict[str, object]] = []
    seen: dict[str, int] = {}
    for row_no, values in enumerate(rows, start=2):
        get = lambda name: (values[index[SOURCE_COLUMNS[name]]] if index[SOURCE_COLUMNS[name]] < len(values) else "").strip()
        code = get("group_uid_code")
        if not code:
            continue  # dòng trống cuối bảng, không phải lỗi
        if len(code) > MAX_CODE_LEN:
            bad.append({"row": row_no, "group_uid_code": code, "reason": f"Group UID Code dài quá {MAX_CODE_LEN} ký tự"})
            continue
        status = get("status")
        if not status:
            bad.append({"row": row_no, "group_uid_code": code, "reason": "Thiếu Status"})
            continue
        qty_raw = get("qty").replace(",", "")
        try:
            qty = float(qty_raw) if qty_raw else 0.0
        except ValueError:
            bad.append({"row": row_no, "group_uid_code": code, "reason": f"Qty không phải số: {qty_raw!r}"})
            continue
        if qty < 0:
            bad.append({"row": row_no, "group_uid_code": code, "reason": f"Qty âm: {qty}"})
            continue
        updated_raw = get("updated_date")
        try:
            updated_date = datetime.strptime(updated_raw, "%Y-%m-%d %H:%M:%S").strftime("%Y-%m-%dT%H:%M:%S") + SOURCE_TZ_OFFSET
        except ValueError:
            bad.append({"row": row_no, "group_uid_code": code, "reason": f"Updated Date không đọc được: {updated_raw!r}"})
            continue

        record = {
            "group_uid_code": code,
            "batch_code": get("batch_code") or None,
            "roll_code": get("roll_code") or None,
            "warehouse": get("warehouse") or None,
            "location": get("location") or None,
            "sku": get("sku") or None,
            "qty": qty,
            "updated_by": get("updated_by") or None,
            "updated_date": updated_date,
            "status": status,
        }
        prior = seen.get(code)
        if prior is not None:
            # WMS đôi khi xuất trùng 1 UID trên 2 dòng (ví dụ đang chuyển kho) —
            # Postgres không cho ON CONFLICT đụng cùng 1 dòng 2 lần trong một
            # batch, nên phải tự khử trùng: giữ dòng có Updated Date mới nhất.
            if good[prior]["updated_date"] <= updated_date:
                good[prior] = record
            continue
        seen[code] = len(good)
        good.append(record)
    return good, bad


def request_headers(secret_key: str) -> dict[str, str]:
    return {
        "apikey": secret_key,
        "Authorization": f"Bearer {secret_key}",
        "Content-Type": "application/json; charset=utf-8",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }


def upsert_batch(endpoint: str, secret_key: str, batch: list[dict[str, object]], retries: int = 3) -> None:
    payload = json.dumps(batch, ensure_ascii=False).encode("utf-8")
    for attempt in range(1, retries + 1):
        request = Request(endpoint, data=payload, headers=request_headers(secret_key), method="POST")
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


def sync(records: list[dict[str, object]], supabase_url: str, secret_key: str, table: str, batch_size: int) -> int:
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{quote(table, safe='')}?on_conflict=group_uid_code"
    batches = 0
    for start in range(0, len(records), batch_size):
        upsert_batch(endpoint, secret_key, records[start : start + batch_size])
        batches += 1
        print(f"Synced {min(start + batch_size, len(records))}/{len(records)} Group UID", file=sys.stderr)
    return batches


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path, help="File .xlsx export từ WMS (Group UID Detail)")
    parser.add_argument("--table", default=DEFAULT_TABLE)
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--dry-run", action="store_true", help="Chỉ đọc và kiểm tra file, không gọi Supabase")
    args = parser.parse_args()

    if not args.source.is_file():
        parser.error(f"Không thấy file: {args.source}")
    if args.batch_size < 1 or args.batch_size > 1000:
        parser.error("--batch-size phải từ 1 đến 1000")

    good, bad = parse_rows(args.source.resolve())

    if args.dry_run:
        warehouses: dict[str, int] = {}
        for r in good:
            key = str(r["warehouse"] or "(trống)")
            warehouses[key] = warehouses.get(key, 0) + 1
        print(json.dumps({
            "file": args.source.name,
            "rows_valid": len(good),
            "rows_rejected": len(bad),
            "rejected_samples": bad[:10],
            "warehouses": warehouses,
            "mode": "dry_run",
        }, ensure_ascii=False, indent=2))
        return

    if bad:
        print(f"[CANH BAO] {len(bad)} dong bi bo qua (khong hop le):", file=sys.stderr)
        for entry in bad[:20]:
            print(f"  - dong {entry['row']} ({entry.get('group_uid_code','?')}): {entry['reason']}", file=sys.stderr)
        if len(bad) > 20:
            print(f"  ... va {len(bad) - 20} dong khac", file=sys.stderr)

    supabase_url = os.environ.get("SUPABASE_URL", "").strip()
    secret_key = os.environ.get("SUPABASE_SECRET_KEY", "").strip()
    if not supabase_url:
        parser.error("SUPABASE_URL is not set")
    if not secret_key:
        parser.error("SUPABASE_SECRET_KEY is not set")
    if not supabase_url.startswith("https://"):
        parser.error("SUPABASE_URL must start with https://")

    batches = sync(good, supabase_url, secret_key, args.table, args.batch_size)
    print(json.dumps({
        "file": args.source.name,
        "table": args.table,
        "rows_synced": len(good),
        "rows_rejected": len(bad),
        "batches": batches,
        "mode": "upsert_only",
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
