#!/usr/bin/env python3
"""Merge a filtered Mastige Category XLSX export into an existing SKU database.

The Mastige ``Download -> Category`` workbook has a different, very wide
layout from the full SKU export.  This script reads its core product columns
and adds the category selected on the website.  SKUs missing from ``products``
are inserted; SKUs already there are updated when a tracked field (tên, trạng
thái, barcode, giá, thương hiệu, category) khác với file export, để bản local
luôn phản chiếu Inside.  ``--no-update`` giữ hành vi chỉ thêm như trước.
"""

from __future__ import annotations

import argparse
import json
import sys
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from import_sku_xlsx import unique_names, worksheet_rows


SOURCE_CANDIDATES = {
    "sku": ("sku",),
    "barcode": ("barcode",),
    "product_name": ("product_name", "name"),
    "brand_name": ("brand_name", "brand"),
    "price": ("price",),
    "latest_cost": ("latest_cost", "last_cost"),
    "product_average_cost": ("product_average_cost", "average_cost"),
    "status": ("status",),
}


# Cột số: bản cũ lưu chuỗi rỗng còn export ghi "0", so thô sẽ báo đổi cho gần
# như mọi dòng. So theo giá trị số để chỉ bắt thay đổi thật.
NUMERIC_COLUMNS = {"price", "latest_cost", "product_average_cost"}

# workstation-agent/src/job-validator.mjs (cleanText(item.productName, 180)) cắt
# cứng tên sản phẩm ở 180 ký tự khi nhận lệnh in — đây là giới hạn THẬT sự áp
# dụng lúc in, không phải giới hạn của database. Tên nào dài hơn mức này vẫn
# nạp bình thường vào sku.db/Supabase (không chặn), nhưng sẽ bị agent cắt mất
# đuôi khi lên tem, giống lỗi SKU [SKU_DA_XOA] ngày 24/09/2026 (ten 150 ky tu bi
# web cat con 140, khong lien quan agent — nhung agent cung se cat neu ten
# THAT SU dai hon 180). Kiem chung ngay 18/09/2026 tung thay ten dai nhat la
# 191 ky tu trong catalog thuc te, tuc la da co ten vuot muc nay. Vi vay moi
# lan nap du lieu moi can canh bao de con nguoi quyet dinh co nang gioi han
# phia agent len hay khong, thay vi am tham mat du lieu luc in.
AGENT_PRODUCT_NAME_LIMIT = 180


def comparable(column: str, value: str) -> str:
    text = (value or "").strip()
    if column in NUMERIC_COLUMNS:
        try:
            return format(float(text or 0), ".4f")
        except ValueError:
            return text
    return text


def status_value(value: str) -> str:
    normalized = value.strip().casefold()
    return {
        "active": "1",
        "in-active": "0",
        "inactive": "0",
        "pending": "2",
        "reject": "3",
    }.get(normalized, value.strip())


def merge_workbook(
    source: Path,
    database: Path,
    category_id: str,
    category_name: str,
    backup: Path | None,
    update_existing: bool = True,
) -> dict[str, object]:
    rows = worksheet_rows(source)
    try:
        headers = next(rows)
    except StopIteration as error:
        raise ValueError("Workbook is empty") from error

    while headers and not headers[-1]:
        headers.pop()
    source_columns = unique_names(headers)
    source_index = {name: index for index, name in enumerate(source_columns)}

    selected: dict[str, int] = {}
    for destination, candidates in SOURCE_CANDIDATES.items():
        for candidate in candidates:
            if candidate in source_index:
                selected[destination] = source_index[candidate]
                break
    if "sku" not in selected:
        raise ValueError("Workbook does not contain an SKU column")

    if backup is not None:
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(database, backup)

    imported_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    connection = sqlite3.connect(database)
    try:
        table_info = connection.execute("PRAGMA table_info(products)").fetchall()
        if not table_info:
            raise ValueError("Database does not contain the products table")
        destination_columns = [row[1] for row in table_info]
        required = {"source_row", "sku", "category_id", "category_name", "imported_at"}
        missing = sorted(required.difference(destination_columns))
        if missing:
            raise ValueError(f"Products table is missing required columns: {', '.join(missing)}")

        # Các cột được đồng bộ lại mỗi lần nạp cho SKU đã có sẵn.
        tracked_columns = [name for name in selected if name != "sku"]
        tracked_columns += ["category_id", "category_name"]
        tracked_sql = ", ".join(f'"{name}"' for name in tracked_columns)
        existing_rows = {
            row[0]: tuple(
                comparable(name, value) for name, value in zip(tracked_columns, row[1:])
            )
            for row in connection.execute(
                f"SELECT sku, {tracked_sql} FROM products WHERE TRIM(sku) <> ''"
            )
        }
        next_source_row = connection.execute(
            "SELECT COALESCE(MAX(source_row), 1) + 1 FROM products"
        ).fetchone()[0]

        quoted_columns = ", ".join(f'"{name}"' for name in destination_columns)
        placeholders = ", ".join("?" for _ in destination_columns)
        insert_sql = f"INSERT INTO products ({quoted_columns}) VALUES ({placeholders})"
        assignments = ", ".join(f'"{name}" = ?' for name in tracked_columns)
        update_sql = f'UPDATE products SET {assignments}, "imported_at" = ? WHERE sku = ?'

        inserted = 0
        updated = 0
        unchanged = 0
        empty_skus = 0
        changed_fields: dict[str, int] = {}
        long_product_names: list[dict[str, object]] = []
        batch: list[tuple[object, ...]] = []
        updates: list[tuple[object, ...]] = []
        for values in rows:
            values = (values + [""] * len(source_columns))[: len(source_columns)]
            sku = values[selected["sku"]].strip()
            if not sku:
                empty_skus += 1
                continue

            mapped = {name: values[index].strip() for name, index in selected.items()}
            mapped["status"] = status_value(str(mapped.get("status", "")))
            mapped["category_id"] = category_id
            mapped["category_name"] = category_name
            name = mapped.get("product_name", "")
            if len(name) > AGENT_PRODUCT_NAME_LIMIT:
                long_product_names.append({"sku": sku, "length": len(name)})
            tracked_values = tuple(mapped[name] for name in tracked_columns)
            tracked_keys = tuple(
                comparable(name, value) for name, value in zip(tracked_columns, tracked_values)
            )

            current = existing_rows.get(sku)
            if current is not None:
                if not update_existing or current == tracked_keys:
                    unchanged += 1
                    continue
                for name, before, after in zip(tracked_columns, current, tracked_keys):
                    if before != after:
                        changed_fields[name] = changed_fields.get(name, 0) + 1
                updates.append(tracked_values + (imported_at, sku))
                existing_rows[sku] = tracked_keys
                updated += 1
                if len(updates) >= 500:
                    connection.executemany(update_sql, updates)
                    updates.clear()
                continue

            record = {name: "" for name in destination_columns}
            record["source_row"] = next_source_row
            record["imported_at"] = imported_at
            record.update(mapped)

            batch.append(tuple(record[name] for name in destination_columns))
            existing_rows[sku] = tracked_keys
            next_source_row += 1
            inserted += 1
            if len(batch) >= 500:
                connection.executemany(insert_sql, batch)
                batch.clear()
        if batch:
            connection.executemany(insert_sql, batch)
        if updates:
            connection.executemany(update_sql, updates)

        connection.execute(
            "INSERT OR REPLACE INTO import_runs VALUES (?, ?, ?)",
            (imported_at, source.name, inserted),
        )
        connection.commit()

        category_count = connection.execute(
            "SELECT COUNT(*) FROM products WHERE category_id = ?",
            (category_id,),
        ).fetchone()[0]
        total_rows = connection.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        distinct_skus = connection.execute(
            "SELECT COUNT(DISTINCT sku) FROM products WHERE TRIM(sku) <> ''"
        ).fetchone()[0]
        return {
            "database": str(database.resolve()),
            "source_file": source.name,
            "category_id": category_id,
            "category_name": category_name,
            "inserted": inserted,
            "updated": updated,
            "changed_fields": changed_fields,
            "unchanged": unchanged,
            "empty_skus_skipped": empty_skus,
            "category_rows": category_count,
            "total_rows": total_rows,
            "distinct_skus": distinct_skus,
            "backup": str(backup.resolve()) if backup is not None else None,
            "long_product_names": long_product_names,
        }
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> None:
    # Keep Vietnamese output valid in Windows consoles and redirected reports.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Filtered Mastige Category XLSX export")
    parser.add_argument("--database", "-d", type=Path, default=Path("data/sku.db"))
    parser.add_argument("--category-id", required=True)
    parser.add_argument("--category-name", required=True)
    parser.add_argument(
        "--backup",
        type=Path,
        help="Optional database backup path created immediately before the merge",
    )
    parser.add_argument(
        "--no-update",
        action="store_true",
        help="Chi them SKU moi, khong cap nhat SKU da co (mac dinh la co cap nhat)",
    )
    args = parser.parse_args()

    if not args.source.is_file():
        parser.error(f"Source workbook does not exist: {args.source}")
    if not args.database.is_file():
        parser.error(f"Database does not exist: {args.database}")
    result = merge_workbook(
        args.source.resolve(),
        args.database.resolve(),
        args.category_id,
        args.category_name,
        args.backup.resolve() if args.backup else None,
        not args.no_update,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
