"""Test scripts/record_ledger.py: chỉ ghi sổ migration đã commit và đĩa trùng HEAD; câu SQL đúng khuôn release.py."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import record_ledger  # noqa: E402
import release  # noqa: E402

SQL = b"-- kiem: select 1;\nselect 1;\n"


class CollectTests(unittest.TestCase):
    def test_collect_uses_hash_after_crlf_normalisation(self):
        rows = record_ledger.collect(["supabase/fake_v1.sql"], head_bytes=lambda rel: SQL, disk_bytes=lambda rel: SQL.replace(b"\n", b"\r\n"))
        self.assertEqual(rows, [("fake_v1.sql", release.content_sha(SQL))])

    def test_accepts_backslash_and_dot_prefix(self):
        rows = record_ledger.collect([".\\supabase\\fake_v1.sql"], head_bytes=lambda rel: SQL, disk_bytes=lambda rel: SQL)
        self.assertEqual([name for name, _ in rows], ["fake_v1.sql"])

    def test_refuses_changed_after_commit(self):
        with self.assertRaises(record_ledger.Refuse) as caught:
            record_ledger.collect(["supabase/fake_v1.sql"], head_bytes=lambda rel: SQL, disk_bytes=lambda rel: SQL + b"-- changed\n")
        self.assertIn("khác HEAD", str(caught.exception))

    def test_refuses_not_committed(self):
        def missing(rel):
            raise record_ledger.Refuse("không có")
        with self.assertRaises(record_ledger.Refuse) as caught:
            record_ledger.collect(["supabase/fake_v1.sql"], head_bytes=missing, disk_bytes=lambda rel: SQL)
        self.assertIn("chưa có ở HEAD", str(caught.exception))

    def test_refuses_outside_supabase_folder(self):
        for bad in ["index.html", "supabase/sub/x.sql", "supabase/x.txt", "tests/x.sql"]:
            with self.assertRaises(record_ledger.Refuse, msg=bad):
                record_ledger.collect([bad], head_bytes=lambda rel: SQL, disk_bytes=lambda rel: SQL)


class BuildSqlTests(unittest.TestCase):
    def test_upsert_per_file_only_insert(self):
        sql = record_ledger.build_sql([("a_v1.sql", "a" * 64), ("b_v1.sql", "b" * 64)], "abc1234", "may-test#lead", "ghi chú")
        self.assertEqual(sql.count("insert into public.release_ledger"), 2)
        for needle in ["'migration'", "'a_v1.sql'", "'b_v1.sql'", "'abc1234'", "'may-test#lead'", "'ghi chú'", "a" * 64]:
            self.assertIn(needle, sql)
        lowered = sql.lower()
        for forbidden in ["delete ", "drop ", "truncate "]:
            self.assertNotIn(forbidden, lowered)


if __name__ == "__main__":
    unittest.main()
