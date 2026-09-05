#!/usr/bin/env python3
"""Merge a filtered Mastige Category XLSX export into an existing SKU database.

The Mastige ``Download -> Category`` workbook has a different, very wide
layout from the full SKU export.  This script reads its core product columns,
adds the category selected on the website, and inserts only SKUs that are not
already present in ``products``.
"""

from __future__ import annotations

import argparse
import json
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

        existing_skus = {
            row[0]
            for row in connection.execute(
                "SELECT sku FROM products WHERE TRIM(sku) <> ''"
            )
        }
        next_source_row = connection.execute(
            "SELECT COALESCE(MAX(source_row), 1) + 1 FROM products"
        ).fetchone()[0]

        quoted_columns = ", ".join(f'"{name}"' for name in destination_columns)
        placeholders = ", ".join("?" for _ in destination_columns)
        insert_sql = f"INSERT INTO products ({quoted_columns}) VALUES ({placeholders})"

        inserted = 0
        duplicate_skus = 0
        empty_skus = 0
        batch: list[tuple[object, ...]] = []
        for values in rows:
            values = (values + [""] * len(source_columns))[: len(source_columns)]
            sku = values[selected["sku"]].strip()
            if not sku:
                empty_skus += 1
                continue
            if sku in existing_skus:
                duplicate_skus += 1
                continue

            record = {name: "" for name in destination_columns}
            record["source_row"] = next_source_row
            record["category_id"] = category_id
            record["category_name"] = category_name
            record["imported_at"] = imported_at
            for destination, index in selected.items():
                record[destination] = values[index].strip()
            record["status"] = status_value(str(record.get("status", "")))

            batch.append(tuple(record[name] for name in destination_columns))
            existing_skus.add(sku)
            next_source_row += 1
            inserted += 1
            if len(batch) >= 500:
                connection.executemany(insert_sql, batch)
                batch.clear()
        if batch:
            connection.executemany(insert_sql, batch)

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
            "duplicates_skipped": duplicate_skus,
            "empty_skus_skipped": empty_skus,
            "category_rows": category_count,
            "total_rows": total_rows,
            "distinct_skus": distinct_skus,
            "backup": str(backup.resolve()) if backup is not None else None,
        }
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def main() -> None:
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
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
