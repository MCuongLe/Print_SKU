import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from import_group_uid_xlsx import FIELDS, parse_rows, import_sql


class GroupUidImportTests(unittest.TestCase):
    def rows(self, **changes):
        row = dict(zip(FIELDS.values(), ['0000123', '001', '', 'TEST WH', '', '', '0', '', '2026-09-22 17:02:00', 'New']))
        row.update(changes)
        return [list(FIELDS), [row[field] for field in FIELDS.values()]]

    def test_preserve_codes_blanks_and_timezone(self):
        row = parse_rows(self.rows())[0]
        self.assertEqual(row['group_uid_code'], '0000123')
        self.assertEqual(row['batch_code'], '001')
        self.assertIsNone(row['sku'])
        self.assertEqual(row['qty'], '0')
        self.assertEqual(row['updated_date'], '2026-09-22T17:02:00+07:00')

    def test_reject_duplicate_and_invalid_values(self):
        rows = self.rows()
        with self.assertRaises(ValueError):
            parse_rows(rows + [rows[1]])
        for changes in [{'qty': '-1'}, {'qty': 'NaN'}, {'qty': 'Infinity'}, {'qty': ''}, {'updated_date': ''}, {'status': ''}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                parse_rows(self.rows(**changes))

    def test_decimal_and_sql_quote(self):
        rows = parse_rows(self.rows(qty='0.123456789', warehouse="Test O'Brien"))
        self.assertEqual(rows[0]['qty'], '0.123456789')
        sql = import_sql(rows)
        self.assertIn("O''Brien", sql)
        self.assertNotIn('product', sql)
        self.assertIn('excluded.updated_date >= group_uid_details.updated_date', sql)

    def test_legacy_product_name_column_is_ignored(self):
        headers, values = self.rows(sku='000123456')
        headers.insert(6, 'Product Name')
        values.insert(6, 'WMS name that must not be stored')
        row = parse_rows([headers, values])[0]
        self.assertNotIn('product', row)
        self.assertEqual(row['sku'], '000123456')


if __name__ == '__main__':
    unittest.main()
