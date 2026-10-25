"""Cảnh báo mới của scripts/commit_gate.py (đợt 5 chuẩn hoá tài liệu, 25/10/2026): chỉ hàm thuần, không gọi git."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import commit_gate as gate  # noqa: E402


class DocLongLines(unittest.TestCase):
    def test_only_added_prose_lines_over_400(self):
        long = "x" * 401
        content = "\n".join(["# Tiêu đề", long, "| " + long + " |", "```", long, "```", long, "ngắn"])
        # dòng 2 (văn xuôi), 3 (bảng), 5 (khối mã), 7 (văn xuôi) dài; chỉ 2 và 7 được thêm mới thì mới báo
        self.assertEqual(gate.doc_long_lines(content, {2, 3, 5, 8}), [(2, 401)])
        self.assertEqual(gate.doc_long_lines(content, {7}), [(7, 401)])

    def test_exactly_400_is_ok(self):
        self.assertEqual(gate.doc_long_lines("y" * 400, {1}), [])


class DefinerIssues(unittest.TestCase):
    GOOD = """begin;
create or replace function public.mau_doc(p_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin return null; end $$;
revoke all on function public.mau_doc(text) from public, anon, authenticated;
grant execute on function public.mau_doc(text) to authenticated;
commit;"""

    def test_good_function_has_no_issue(self):
        self.assertEqual(gate.definer_issues(self.GOOD, {2}), [])

    def test_missing_search_path_and_revoke(self):
        sql = """create or replace function public.mau_ghi(p text)
returns void language plpgsql security definer as $$ begin null; end $$;
grant execute on function public.mau_ghi(text) to authenticated;"""
        issues = gate.definer_issues(sql, {1})
        self.assertEqual(len(issues), 2, issues)
        self.assertTrue(any("search_path" in i for i in issues))
        self.assertTrue(any("revoke" in i for i in issues))

    def test_untouched_function_is_ignored(self):
        sql = "create function public.cu(p text) returns void language sql security definer as $$ select 1 $$;"
        self.assertEqual(gate.definer_issues(sql, set()), [])

    def test_invoker_function_needs_nothing(self):
        sql = "create function public.thuong() returns int language sql stable as $$ select 1 $$;"
        self.assertEqual(gate.definer_issues(sql, {1}), [])


class MessageIssues(unittest.TestCase):
    def test_plain_vietnamese_without_marks_is_ok(self):
        self.assertEqual(gate.message_issues("Chuan hoa tai lieu dot 5: commit_gate canh bao\n\n- chi tiet co dau cung duoc"), [])

    def test_subject_with_marks_is_warned(self):
        self.assertEqual(len(gate.message_issues("feat: thêm animation chibi")), 1)

    def test_empty_message_is_warned(self):
        self.assertEqual(len(gate.message_issues("  \n")), 1)


class MissingCodes(unittest.TestCase):
    RULES = "- [N0965] **17/10** ...\n- [N20261025-2108] **25/10** ...\n"

    def test_known_codes_pass_and_unknown_are_listed(self):
        lines = ["- luật A. (17/10 · N0965, N0966)", "- luật B. (25/10 · N20261025-2108)", "- luật C. (25/10 · N20261025-0001)"]
        self.assertEqual(gate.missing_codes(lines, self.RULES), ["N0966", "N20261025-0001"])

    def test_placeholder_pattern_is_not_a_code(self):
        self.assertEqual(gate.missing_codes(["mã `[N<yyyymmdd>-<hhmm>]` và `N<4 số>`"], self.RULES), [])


if __name__ == "__main__":
    unittest.main()
