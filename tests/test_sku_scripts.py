"""Các chốt chặn dữ liệu của script nạp SKU và Group UID (dữ liệu giả, không gọi Supabase)."""

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import merge_sku_category_xlsx as merge  # noqa: E402
import sync_group_uid_to_supabase as group_sync  # noqa: E402
import sync_sku_to_supabase as sku_sync  # noqa: E402

PRODUCT_COLUMNS = (
    "source_row INTEGER PRIMARY KEY, sku TEXT, barcode TEXT, product_name TEXT, brand_name TEXT, price TEXT, "
    "latest_cost TEXT, product_average_cost TEXT, status TEXT, category_id TEXT, category_name TEXT, imported_at TEXT"
)


class MergeCategoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.database = self.root / "sku.db"
        connection = sqlite3.connect(self.database)
        connection.execute(f"CREATE TABLE products ({PRODUCT_COLUMNS})")
        connection.execute("CREATE TABLE import_runs (imported_at TEXT PRIMARY KEY, source_file TEXT, inserted INTEGER)")
        connection.execute(
            "INSERT INTO products VALUES (1, 'SKU-OLD', '', 'Ten cu', '', '', '', '', '1', '954', 'Cat', '2026-01-01')"
        )
        connection.commit()
        connection.close()

    def merge(self, header, *rows):
        source = self.root / "export.xlsx"
        source.write_bytes(b"")
        with patch.object(merge, "worksheet_rows", lambda path: iter([list(header), *[list(row) for row in rows]])):
            return merge.merge_workbook(source, self.database, "957", "Thoi Trang", None)

    def products(self):
        connection = sqlite3.connect(self.database)
        try:
            return {row[0]: row[1:] for row in connection.execute("SELECT sku, product_name, status FROM products")}
        finally:
            connection.close()

    def test_ten_hoac_trang_thai_rong_khong_ghi_de_va_khong_chen_dong_rac(self):
        result = self.merge(
            ["sku", "product_name", "status"],
            ["SKU-OLD", "", "Active"],      # tên rỗng: không được xoá tên cũ
            ["SKU-OLD2", "Ten", ""],         # trạng thái rỗng
            ["SKU-NEW", "", "Active"],       # SKU mới tên rỗng: không chèn
            ["SKU-OK", "Ten moi", "Active"],
        )
        self.assertEqual(result["incomplete_rows_skipped"], 3)
        self.assertEqual(result["inserted"], 1)
        products = self.products()
        self.assertEqual(products["SKU-OLD"], ("Ten cu", "1"))
        self.assertNotIn("SKU-NEW", products)
        self.assertNotIn("SKU-OLD2", products)
        self.assertEqual(products["SKU-OK"], ("Ten moi", "1"))

    def test_sku_trung_trong_file_giu_dong_dau(self):
        result = self.merge(
            ["sku", "product_name", "status"],
            ["SKU-DUP", "Dong dau", "Active"],
            ["SKU-DUP", "Dong sau", "Active"],
        )
        self.assertEqual(result["duplicate_skus_skipped"], 1)
        self.assertEqual(self.products()["SKU-DUP"], ("Dong dau", "1"))

    def test_file_khong_co_cot_trang_thai_van_nap_duoc(self):
        result = self.merge(["sku", "product_name"], ["SKU-A", "Ten A"], ["SKU-B", "Ten B"])
        self.assertEqual(result["incomplete_rows_skipped"], 0)
        self.assertEqual(result["inserted"], 2)


class ActiveSkusTests(unittest.TestCase):
    def test_sku_trung_trong_sku_db_chi_len_mot_dong_lay_dong_nhap_sau(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "sku.db"
            connection = sqlite3.connect(database)
            connection.execute(f"CREATE TABLE products ({PRODUCT_COLUMNS})")
            for row_no, (sku, name) in enumerate([("A1", "Ban dau"), (" A1 ", "Ban sau"), ("B2", "Khac")], start=1):
                connection.execute(
                    "INSERT INTO products VALUES (?, ?, '', ?, '', '', '', '', '1', '954', 'Cat', 'x')", (row_no, sku, name)
                )
            connection.commit()
            connection.close()
            records = sku_sync.active_skus(database, False)
        self.assertEqual([record["sku"] for record in records], ["A1", "B2"])
        self.assertEqual(records[0]["product_name"], "Ban sau")


class GroupUidQtyTests(unittest.TestCase):
    def parse(self, qty):
        header = list(group_sync.SOURCE_COLUMNS.values())
        values = {
            "Group UID Code": "1028261006000050", "Batch Code": "B", "Roll Code": "5", "Warehouse": "WH", "Location": "A-01",
            "SKU": "422000001", "Qty": qty, "Updated By": "x", "Updated Date": "2026-10-10 10:00:00", "Status": "Available",
        }
        with patch.object(group_sync, "worksheet_rows", lambda path: iter([header, [values[name] for name in header]])):
            return group_sync.parse_rows(Path("giả.xlsx"))

    def test_qty_khong_huu_han_bi_loai_khoi_lo_nap(self):
        for qty in ["NaN", "nan", "inf", "-inf", "1e999"]:
            with self.subTest(qty=qty):
                good, bad = self.parse(qty)
                self.assertEqual(good, [])
                self.assertEqual(len(bad), 1)
                self.assertIn("Qty", bad[0]["reason"])

    def test_qty_binh_thuong_van_nhan(self):
        for qty, expected in [("12", 12.0), ("1,200", 1200.0), ("0", 0.0)]:
            with self.subTest(qty=qty):
                good, bad = self.parse(qty)
                self.assertEqual(bad, [])
                self.assertEqual(good[0]["qty"], expected)


if __name__ == "__main__":
    unittest.main()
