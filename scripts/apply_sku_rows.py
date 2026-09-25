#!/usr/bin/env python3
"""Nạp các dòng SKU đọc trực tiếp từ trang danh sách Inside vào sku.db.

Khác với đường Excel: dữ liệu tới đây là danh sách dict đã lọc theo cột
Modified, thường chỉ vài chục tới vài trăm dòng thay vì cả 21.000 dòng.
Quy tắc thêm/cập nhật giữ y như merge_sku_category_xlsx để hai đường cho ra
cùng một kết quả.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from merge_sku_category_xlsx import comparable, status_value


# CHỈ những cột mà trang danh sách thật sự hiển thị. Đo trên máy thật: cột
# Barcode, LatestCost và Average Cost render RỖNG trong bảng HTML (giá chỉ có
# trong file Excel), nên nếu đưa chúng vào đây thì mỗi lần nạp sẽ ghi rỗng đè
# lên số thật — đã xoá nhầm giá vốn 44 dòng lúc chạy thử. Giá và barcode để
# đường Excel đối chiếu lo.
TRACKED_COLUMNS = [
    "product_name",
    "status",
    "category_id",
    "category_name",
]
REQUIRED_FIELDS = {"sku", "product_name", "category_id", "category_name", "status"}


def normalize(row: dict[str, object]) -> dict[str, str]:
    clean = {name: str(row.get(name, "") or "").strip() for name in TRACKED_COLUMNS}
    clean["status"] = status_value(clean["status"])
    clean["sku"] = str(row.get("sku", "") or "").strip()
    return clean


# Cầu dao đổi tên hàng loạt. Một lỗi parser (lấy nhầm ô, dính tiền tố thương
# hiệu, Inside đổi cấu trúc) luôn làm GẦN NHƯ MỌI dòng "đổi tên", trong khi
# người thật sửa tên chỉ vài chục dòng. Vượt ngưỡng thì huỷ cả lượt nạp và bắt
# người dùng nhìn tận mắt, thay vì âm thầm ghi sai 21.000 tên.
RENAME_FLOOR = 25          # dưới mức này luôn cho qua
RENAME_PERCENT = 20        # trên mức sàn thì không được vượt tỷ lệ này


def apply_rows(
    database: Path, rows: list[dict[str, object]], force: bool = False
) -> dict[str, object]:
    missing = REQUIRED_FIELDS.difference(rows[0]) if rows else set()
    if missing:
        raise ValueError(f"Dòng dữ liệu thiếu trường: {', '.join(sorted(missing))}")

    prepared = [normalize(row) for row in rows]
    prepared = [row for row in prepared if row["sku"] and row["product_name"]]
    if not prepared:
        raise ValueError("Không có dòng nào hợp lệ để nạp")

    imported_at = datetime.now(timezone.utc).isoformat(timespec="microseconds")
    connection = sqlite3.connect(database)
    try:
        table_info = connection.execute("PRAGMA table_info(products)").fetchall()
        if not table_info:
            raise ValueError("Database không có bảng products")
        destination_columns = [info[1] for info in table_info]
        for name in TRACKED_COLUMNS + ["sku", "source_row", "imported_at"]:
            if name not in destination_columns:
                raise ValueError(f"Bảng products thiếu cột {name}")

        # Chỉ đọc đúng những SKU liên quan, không quét cả bảng.
        wanted = [row["sku"] for row in prepared]
        existing: dict[str, tuple[str, ...]] = {}
        tracked_sql = ", ".join(f'"{name}"' for name in TRACKED_COLUMNS)
        for start in range(0, len(wanted), 400):
            chunk = wanted[start : start + 400]
            placeholders = ", ".join("?" for _ in chunk)
            for found in connection.execute(
                f"SELECT sku, {tracked_sql} FROM products WHERE sku IN ({placeholders})", chunk
            ):
                existing[found[0]] = tuple(
                    comparable(name, value) for name, value in zip(TRACKED_COLUMNS, found[1:])
                )

        next_source_row = connection.execute(
            "SELECT COALESCE(MAX(source_row), 1) + 1 FROM products"
        ).fetchone()[0]
        quoted = ", ".join(f'"{name}"' for name in destination_columns)
        insert_sql = f"INSERT INTO products ({quoted}) VALUES ({', '.join('?' for _ in destination_columns)})"
        assignments = ", ".join(f'"{name}" = ?' for name in TRACKED_COLUMNS)
        update_sql = f'UPDATE products SET {assignments}, "imported_at" = ? WHERE sku = ?'

        inserted = updated = unchanged = skipped_empty = 0
        changed_fields: dict[str, int] = {}
        inserts: list[tuple[object, ...]] = []
        updates: list[tuple[object, ...]] = []
        seen: set[str] = set()
        for row in prepared:
            sku = row["sku"]
            if sku in seen:
                continue
            seen.add(sku)
            values = tuple(row[name] for name in TRACKED_COLUMNS)
            if any(not value for value in values):
                # Chốt chặn thứ hai: không bao giờ ghi giá trị rỗng đè lên dữ liệu cũ.
                skipped_empty += 1
                continue
            keys = tuple(comparable(name, value) for name, value in zip(TRACKED_COLUMNS, values))

            current = existing.get(sku)
            if current is not None:
                if current == keys:
                    unchanged += 1
                    continue
                for name, before, after in zip(TRACKED_COLUMNS, current, keys):
                    if before != after:
                        changed_fields[name] = changed_fields.get(name, 0) + 1
                updates.append(values + (imported_at, sku))
                updated += 1
                continue

            record = {name: "" for name in destination_columns}
            record["source_row"] = next_source_row
            record["imported_at"] = imported_at
            record["sku"] = sku
            for name, value in zip(TRACKED_COLUMNS, values):
                record[name] = value
            inserts.append(tuple(record[name] for name in destination_columns))
            next_source_row += 1
            inserted += 1

        renames = changed_fields.get("product_name", 0)
        compared = updated + unchanged
        limit = max(RENAME_FLOOR, compared * RENAME_PERCENT // 100)
        if renames > limit and not force:
            raise ValueError(
                f"Dừng: {renames}/{compared} dòng bị đổi tên, vượt ngưỡng {limit}. "
                "Gần như chắc chắn là lỗi đọc dữ liệu chứ không phải người sửa tên. "
                "Kiểm tra lại rồi chạy với --force nếu thật sự đúng."
            )

        if inserts:
            connection.executemany(insert_sql, inserts)
        if updates:
            connection.executemany(update_sql, updates)
        connection.execute(
            "INSERT OR REPLACE INTO import_runs VALUES (?, ?, ?)",
            (imported_at, "inside-list", inserted),
        )
        connection.commit()

        total_rows = connection.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        return {
            "rows_read": len(rows),
            "inserted": inserted,
            "updated": updated,
            "unchanged": unchanged,
            "skipped_empty": skipped_empty,
            "changed_fields": changed_fields,
            "rename_limit": limit,
            "total_rows": total_rows,
        }
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
