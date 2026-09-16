#!/usr/bin/env python3
"""Report the categories contained in a Mastige product export workbook.

Used to verify a freshly downloaded export belongs to the category we intend to
merge, so a wrong file can never be merged under the wrong category label.
Only depends on the standard library (reuses the OOXML reader of the importer).
"""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from import_sku_xlsx import unique_names, worksheet_rows


def inspect(source: Path) -> dict[str, object]:
    rows = worksheet_rows(source)
    headers = next(rows)
    while headers and not headers[-1]:
        headers.pop()
    columns = unique_names(headers)
    index = {name: position for position, name in enumerate(columns)}
    if "category_id" not in index:
        raise ValueError("Workbook has no category_id column")

    counter: Counter[tuple[str, str]] = Counter()
    total = 0
    for values in rows:
        values = (values + [""] * len(columns))[: len(columns)]
        sku = values[index["sku"]].strip() if "sku" in index else ""
        if not sku:
            continue
        total += 1
        category_id = values[index["category_id"]].strip()
        category_name = values[index.get("category_name", index["category_id"])].strip()
        counter[(category_id, category_name)] += 1

    return {
        "file": source.name,
        "rows_with_sku": total,
        "categories": [
            {"category_id": cid, "category_name": cname, "rows": count}
            for (cid, cname), count in counter.most_common()
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    print(json.dumps(inspect(args.source.resolve()), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
