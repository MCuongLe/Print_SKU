"""JSON export cleanup must follow a complete Supabase sync."""

import argparse
import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from refresh_skus import command_apply, command_sync  # noqa: E402


class JsonCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.database = root / "sku.db"
        self.downloads = root / "Downloads"
        self.downloads.mkdir()
        with contextlib.closing(sqlite3.connect(self.database)) as connection:
            connection.executescript(
                "CREATE TABLE products (source_row INTEGER PRIMARY KEY, sku TEXT, "
                "product_name TEXT, status TEXT, category_id TEXT, "
                "category_name TEXT, imported_at TEXT);"
                "CREATE TABLE import_runs (imported_at TEXT PRIMARY KEY, "
                "source_file TEXT, row_count INTEGER);"
            )
        self.source = self.downloads / "sku-changes-synthetic.json"
        self.source.write_text(json.dumps({"rows": [{
            "sku": "TEST-001", "product_name": "Synthetic product",
            "status": "Active", "category_id": "954",
            "category_name": "Synthetic category",
        }]}), encoding="utf-8")
        self.apply_args = argparse.Namespace(
            database=self.database, downloads=self.downloads,
            since_minutes=60, force=False,
        )
        self.sync_args = argparse.Namespace(
            database=self.database, downloads=self.downloads, dry_run=False,
        )

    def apply(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(command_apply(self.apply_args), 0)

    def sync(self, status):
        with patch("refresh_skus.subprocess.call", return_value=status):
            with contextlib.redirect_stdout(io.StringIO()):
                return command_sync(self.sync_args)

    def test_only_successful_sync_deletes_applied_json(self):
        self.apply()
        unrelated = self.downloads / "sku-changes-unapplied.json"
        unrelated.write_text("{}", encoding="utf-8")
        self.assertTrue(self.source.exists())
        self.assertEqual(self.sync(1), 1)
        self.assertTrue(self.source.exists())
        self.sync_args.dry_run = True
        self.assertEqual(self.sync(0), 0)
        self.assertTrue(self.source.exists())
        self.sync_args.dry_run = False
        self.assertEqual(self.sync(0), 0)
        self.assertFalse(self.source.exists())
        self.assertTrue(unrelated.exists())

    def test_modified_file_is_retained(self):
        self.apply()
        self.source.write_text("{}", encoding="utf-8")
        self.assertEqual(self.sync(0), 0)
        self.assertTrue(self.source.exists())

    def test_empty_export_is_cleaned_only_after_sync(self):
        self.source.write_text('{"rows": []}', encoding="utf-8")
        self.apply()
        self.assertTrue(self.source.exists())
        self.assertEqual(self.sync(0), 0)
        self.assertFalse(self.source.exists())


if __name__ == "__main__":
    unittest.main()
