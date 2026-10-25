"""scripts/codex_review.py nạp tệp chuẩn docs/chuan theo loại thay đổi (đợt 5 chuẩn hoá tài liệu, 25/10/2026)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import codex_review as cr  # noqa: E402


class StandardsFor(unittest.TestCase):
    def test_by_change_type(self):
        self.assertEqual(cr.standards_for(["index.html"], images=False), ["GIAO_DIEN.md", "MA_WEB.md"])
        self.assertEqual(cr.standards_for(["supabase/a_v1.sql", "extension/inside-po-connector/x.js"], images=False), ["DU_LIEU.md"])
        self.assertEqual(cr.standards_for(["tests/x.cjs", "scripts/y.py"], images=False), ["KIEM_THU_GIT.md"])
        self.assertEqual(cr.standards_for(["docs/a.md"], images=False), ["TAI_LIEU.md"])
        self.assertEqual(cr.standards_for([], images=True), ["GIAO_DIEN.md"])

    def test_no_duplicates_and_stable_order(self):
        got = cr.standards_for(["tests/a.cjs", "index.html", "supabase/b.sql", "index.html"], images=False)
        self.assertEqual(got, ["KIEM_THU_GIT.md", "GIAO_DIEN.md", "MA_WEB.md", "DU_LIEU.md"])

    def test_block_contains_file_text(self):
        block = cr.standards_block(["TAI_LIEU.md"])
        self.assertIn("docs/chuan/TAI_LIEU.md", block)
        self.assertIn("Chuẩn viết tài liệu", block)


if __name__ == "__main__":
    unittest.main()
