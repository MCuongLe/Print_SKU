#!/usr/bin/env python3
"""Import a Mastige/Hasaki product XLSX export into SQLite.

The system-generated workbook currently contains malformed page-margin metadata,
so this importer reads the OOXML worksheet directly instead of using openpyxl.
It only depends on the Python standard library.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import unicodedata
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from xml.etree import ElementTree as ET


MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"m": MAIN_NS, "r": REL_NS, "p": PKG_REL_NS}


def column_index(reference: str) -> int:
    match = re.match(r"([A-Z]+)", reference.upper())
    if not match:
        raise ValueError(f"Invalid cell reference: {reference!r}")
    result = 0
    for char in match.group(1):
        result = result * 26 + ord(char) - ord("A") + 1
    return result - 1


def sql_name(value: str, fallback: str) -> str:
    value = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode()
    value = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    if not value:
        value = fallback
    if value[0].isdigit():
        value = f"field_{value}"
    return value


def shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(item.itertext()) for item in root.findall("m:si", NS)]


def first_sheet_path(archive: zipfile.ZipFile) -> str:
    workbook = ET.fromstring(archive.read("xl/workbook.xml"))
    sheet = workbook.find("m:sheets/m:sheet", NS)
    if sheet is None:
        raise ValueError("Workbook contains no worksheets")
    relationship_id = sheet.attrib[f"{{{REL_NS}}}id"]
    relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    for relationship in relationships.findall("p:Relationship", NS):
        if relationship.attrib.get("Id") == relationship_id:
            target = relationship.attrib["Target"].lstrip("/")
            return target if target.startswith("xl/") else f"xl/{target}"
    raise ValueError("Could not resolve the first worksheet")


def cell_value(cell: ET.Element, strings: list[str]) -> str:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        inline = cell.find("m:is", NS)
        return "" if inline is None else "".join(inline.itertext())
    value = cell.findtext("m:v", default="", namespaces=NS)
    if cell_type == "s" and value:
        return strings[int(value)]
    if cell_type == "b":
        return "1" if value == "1" else "0"
    return value


def worksheet_rows(source: Path):
    with zipfile.ZipFile(source) as archive:
        strings = shared_strings(archive)
        sheet_path = first_sheet_path(archive)
        with archive.open(sheet_path) as stream:
            for _, element in ET.iterparse(stream, events=("end",)):
                if element.tag != f"{{{MAIN_NS}}}row":
                    continue
                values: dict[int, str] = {}
                for cell in element.findall("m:c", NS):
                    index = column_index(cell.attrib["r"])
                    values[index] = cell_value(cell, strings).strip()
                width = max(values, default=-1) + 1
                yield [values.get(index, "") for index in range(width)]
                element.clear()


def unique_names(headers: list[str]) -> list[str]:
    names: list[str] = []
    used: dict[str, int] = {}
    for ordinal, header in enumerate(headers, start=1):
        base = sql_name(header, f"column_{ordinal}")
        used[base] = used.get(base, 0) + 1
        names.append(base if used[base] == 1 else f"{base}_{used[base]}")
    return names


def import_workbook(source: Path, database: Path) -> dict[str, object]:
    rows = worksheet_rows(source)
    try:
        headers = next(rows)
    except StopIteration as error:
        raise ValueError("Workbook is empty") from error

    while headers and not headers[-1]:
        headers.pop()
    if not headers:
        raise ValueError("Workbook has no header row")

    columns = unique_names(headers)
    database.parent.mkdir(parents=True, exist_ok=True)
    imported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    connection = sqlite3.connect(database)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.execute("DROP TABLE IF EXISTS products_new")
        definitions = ", ".join(f'"{name}" TEXT' for name in columns)
        connection.execute(
            f"CREATE TABLE products_new (source_row INTEGER PRIMARY KEY, {definitions}, imported_at TEXT NOT NULL)"
        )
        placeholders = ", ".join("?" for _ in range(len(columns) + 2))
        insert_sql = f"INSERT INTO products_new VALUES ({placeholders})"

        batch: list[tuple[object, ...]] = []
        row_count = 0
        for source_row, values in enumerate(rows, start=2):
            values = (values + [""] * len(columns))[: len(columns)]
            if not any(values):
                continue
            batch.append((source_row, *values, imported_at))
            row_count += 1
            if len(batch) >= 1000:
                connection.executemany(insert_sql, batch)
                batch.clear()
        if batch:
            connection.executemany(insert_sql, batch)

        connection.execute("DROP TABLE IF EXISTS products")
        connection.execute("ALTER TABLE products_new RENAME TO products")
        connection.execute("DROP TABLE IF EXISTS column_map")
        connection.execute(
            "CREATE TABLE column_map (ordinal INTEGER PRIMARY KEY, excel_header TEXT NOT NULL, sqlite_column TEXT NOT NULL UNIQUE)"
        )
        connection.executemany(
            "INSERT INTO column_map VALUES (?, ?, ?)",
            [(index, header, column) for index, (header, column) in enumerate(zip(headers, columns), start=1)],
        )
        connection.execute(
            "CREATE TABLE IF NOT EXISTS import_runs (imported_at TEXT PRIMARY KEY, source_file TEXT NOT NULL, row_count INTEGER NOT NULL)"
        )
        connection.execute(
            "INSERT OR REPLACE INTO import_runs VALUES (?, ?, ?)",
            (imported_at, source.name, row_count),
        )

        for candidate in ("sku", "barcode", "id", "product_name", "name"):
            if candidate in columns:
                connection.execute(
                    f'CREATE INDEX IF NOT EXISTS "idx_products_{candidate}" ON products("{candidate}")'
                )
        connection.commit()

        result: dict[str, object] = {
            "database": str(database.resolve()),
            "source_file": source.name,
            "rows": row_count,
            "columns": len(columns),
            "column_map": dict(zip(headers, columns)),
        }
        if "sku" in columns:
            result["nonempty_skus"] = connection.execute(
                "SELECT COUNT(*) FROM products WHERE TRIM(sku) <> ''"
            ).fetchone()[0]
            result["distinct_skus"] = connection.execute(
                "SELECT COUNT(DISTINCT sku) FROM products WHERE TRIM(sku) <> ''"
            ).fetchone()[0]
        return result
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Path to the Mastige product XLSX export")
    parser.add_argument("--database", "-d", type=Path, default=Path("data/sku.db"))
    args = parser.parse_args()

    if not args.source.is_file():
        parser.error(f"Source workbook does not exist: {args.source}")
    result = import_workbook(args.source.resolve(), args.database.resolve())
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
