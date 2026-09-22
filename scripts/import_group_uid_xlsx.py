#!/usr/bin/env python3
"""Validate a WMS XLSX and upsert Group UID into the existing Supabase in batches.

Uses only the standard library. Default is dry-run; --apply sends data.
Source dates without offsets are interpreted as UTC+07:00.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from apply_supabase_sql import project_ref, read_token, run_query
from import_sku_xlsx import worksheet_rows

FIELDS = {
    'Group UID Code': 'group_uid_code', 'Batch Code': 'batch_code',
    'Roll Code': 'roll_code', 'Warehouse': 'warehouse', 'Location': 'location',
    'Product Name': 'product', 'SKU': 'sku', 'Qty': 'qty',
    'Updated By': 'updated_by', 'Updated Date': 'updated_date', 'Status': 'status',
}
SOURCE_TZ = timezone(timedelta(hours=7))


def parse_rows(rows):
    rows = iter(rows)
    headers = next(rows, [])
    for header in FIELDS:
        if headers.count(header) != 1:
            raise ValueError(f'Missing or duplicate header: {header}')
    indices = {field: headers.index(header) for header, field in FIELDS.items()}
    result, seen = [], set()
    for number, values in enumerate(rows, 2):
        if not any(values):
            continue
        row = {field: (values[i].strip() or None) if i < len(values) else None
               for field, i in indices.items()}
        code = row['group_uid_code']
        if not code or code in seen:
            raise ValueError(f'Row {number}: missing or duplicate Group UID Code')
        seen.add(code)
        try:
            qty = Decimal(row['qty'] or '')
        except InvalidOperation as error:
            raise ValueError(f'Row {number}: invalid Qty') from error
        if not qty.is_finite() or qty < 0:
            raise ValueError(f'Row {number}: Qty must be finite and nonnegative')
        row['qty'] = str(qty)  # JSON string -> PostgreSQL numeric, no float rounding.
        try:
            date = datetime.fromisoformat(row['updated_date'] or '')
        except ValueError as error:
            raise ValueError(f'Row {number}: invalid Updated Date; expected ISO date/time') from error
        row['updated_date'] = (date if date.tzinfo else date.replace(tzinfo=SOURCE_TZ)).isoformat()
        if not row['status']:
            raise ValueError(f'Row {number}: missing Status')
        result.append(row)
    if not result:
        raise ValueError('No data rows')
    return result


def import_sql(rows):
    payload = json.dumps(rows, ensure_ascii=False).replace("'", "''")
    columns = ', '.join(FIELDS.values())
    definitions = ', '.join(f'{c} ' + ('numeric' if c == 'qty' else 'timestamptz' if c == 'updated_date' else 'text') for c in FIELDS.values())
    updates = ', '.join(f'{c} = excluded.{c}' for c in FIELDS.values() if c != 'group_uid_code')
    # A single statement is atomic. Old snapshots cannot replace newer source dates.
    return f"""with incoming as (
      select * from jsonb_to_recordset('{payload}'::jsonb) as r({definitions})
    ), written as (
      insert into public.group_uid_details ({columns}) select {columns} from incoming
      on conflict (group_uid_code) do update set {updates}
      where excluded.updated_date >= group_uid_details.updated_date
      returning group_uid_code
    ) select (select count(*) from incoming) as input_rows,
             (select count(*) from written) as written_rows"""


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    rows = parse_rows(worksheet_rows(args.source))
    print(json.dumps({'rows': len(rows), 'blank_sku': sum(not r['sku'] for r in rows),
                      'qty_sum': str(sum(Decimal(r['qty']) for r in rows)),
                      'statuses': dict(Counter(r['status'] for r in rows))}, ensure_ascii=False))
    if not args.apply:
        print('Dry-run: validated only. Use --apply to import.')
        return
    token = read_token(Path(__file__).resolve().parent.parent)
    if not token:
        raise SystemExit('Missing SUPABASE_ACCESS_TOKEN in environment or .env')
    ref = project_ref('')
    for start in range(0, len(rows), 500):
        batch = rows[start:start + 500]
        print(f'Batch {start // 500 + 1}:', run_query(ref, token, import_sql(batch), 120), flush=True)
    print('Import complete. If interrupted, rerun the same file to resume safely.')


if __name__ == '__main__':
    main()
