"""scripts/live_status.py (đợt 5 chuẩn hoá tài liệu, 25/10/2026): hàm thuần — chặn câu ghi, đọc đối tượng migration,
suy trạng thái mong đợi, dựng báo cáo. Không gọi Supabase, không gọi git."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import live_status as ls  # noqa: E402


class SelectOnly(unittest.TestCase):
    def test_select_and_with_pass(self):
        ls.select_only("select 1")
        ls.select_only("  WITH x as (select 1) select * from x;  ")

    def test_writes_and_stacked_statements_are_refused(self):
        for sql in ["drop table x", "update a set b = 1", "select 1; delete from x", "insert into a values (1)"]:
            with self.assertRaises(ValueError, msg=sql):
                ls.select_only(sql)


class SqlObjects(unittest.TestCase):
    SQL = """-- create table public.trong_comment (id int);
begin;
create table if not exists public.bang_a (id int);
create unique index if not exists bang_a_id_idx on public.bang_a (id);
create or replace function public.ham_a(p text) returns void language plpgsql security definer set search_path = '' as $$
begin create table public.trong_than (id int); end $$;
create or replace trigger trg_a before insert on public.bang_a for each row execute function public.ham_a();
drop function if exists public.ham_cu(text);
drop table if exists public.bang_cu;
select cron.schedule('viec-dem', '0 20 * * *', $$select public.ham_a('x')$$);
select cron.unschedule('viec-cu');
create table cron.khong_tinh (id int);
commit;"""

    def test_creates_and_drops_in_order_skip_comments_bodies_other_schemas(self):
        got = [(a, k, n) for _pos, a, k, n in ls.sql_objects(self.SQL)]
        self.assertEqual(got, [
            ("create", "table", "bang_a"),
            ("create", "index", "bang_a_id_idx"),
            ("create", "function", "ham_a"),
            ("create", "trigger", "trg_a"),
            ("drop", "function", "ham_cu"),
            ("drop", "table", "bang_cu"),
            ("create", "cron", "viec-dem"),
            ("drop", "cron", "viec-cu"),
        ])


class Expected(unittest.TestCase):
    def test_later_drop_removes_and_recreate_restores(self):
        files = [
            ("a_v1.sql", "create table public.t1 (id int); create function public.f1() returns int language sql as $$ select 1 $$;"),
            ("a_v2.sql", "drop table if exists public.t1; create table public.t2 (id int);"),
            ("a_v3.sql", "create or replace function public.f1() returns int language sql as $$ select 2 $$;"),
        ]
        expected, per_file = ls.expected_objects(files)
        self.assertEqual(expected, {("function", "f1"), ("table", "t2")})
        self.assertEqual(per_file["a_v1.sql"], {("function", "f1")})   # t1 đã bị xoá sau đó → không đòi
        self.assertEqual(per_file["a_v2.sql"], {("table", "t2")})

    def test_constraint_using_index_renames_index(self):
        files = [
            ("b_v1.sql", "create unique index if not exists t_idx on public.t(a, b);"),
            ("b_v2.sql", "do $$ begin if true then alter table public.t add constraint t_pkey primary key using index t_idx; end if; end $$;"),
        ]
        expected, per_file = ls.expected_objects(files)
        self.assertEqual(expected, {("index", "t_pkey")})
        self.assertEqual(per_file["b_v1.sql"], set())

    def test_missing_by_file(self):
        per_file = {"x_v1.sql": {("function", "f1"), ("trigger", "tg")}, "y_v1.sql": {("table", "t")}}
        db = {"function": {"f1"}, "trigger": set(), "table": {"t"}, "index": set(), "cron": set()}
        self.assertEqual(ls.missing_by_file(per_file, db), {"x_v1.sql": ["trigger tg"]})


class CronVn(unittest.TestCase):
    def test_utc_to_vn(self):
        self.assertEqual(ls.cron_vn("0 20 * * *"), "03:00 mỗi ngày")
        self.assertEqual(ls.cron_vn("15 20 * * 0"), "03:15 thứ Hai")
        self.assertEqual(ls.cron_vn("*/30 * * * *"), "mỗi 30 phút")
        self.assertEqual(ls.cron_vn("0 3 1 * *"), "0 3 1 * *")


class ExtensionGate(unittest.TestCase):
    OLD, NEW = "0.10.9", "0.10.10"

    def test_ext_less_compares_numeric_segments_like_edge(self):
        self.assertTrue(ls.ext_less(self.OLD, self.NEW))          # không so chuỗi: "0.10.9" > "0.10.10" theo chuỗi
        self.assertFalse(ls.ext_less(self.NEW, self.OLD))
        self.assertFalse(ls.ext_less(self.NEW, self.NEW))
        self.assertTrue(ls.ext_less("0.9.99", "0.10.0"))
        self.assertFalse(ls.ext_less("1.0.0", self.NEW))
        for undeclared in (None, "", "v" + self.NEW, self.NEW + " ", "0.10", "0.10.10.1", 10):
            self.assertTrue(ls.ext_less(undeclared, self.NEW), repr(undeclared))
        for bad_min in (None, "", "v" + self.NEW, "0.10", 10):    # mức sai dạng = không có mức
            self.assertFalse(ls.ext_less(self.OLD, bad_min), repr(bad_min))

    def test_devices_query_is_a_single_select(self):
        ls.select_only(ls.DEVICES_SQL)

    def test_device_need_prefers_last_kind_then_highest(self):
        mins = {"sku": "0.10.11", "group_uid": "0.10.10"}
        self.assertEqual(ls.device_need(mins, "group_uid"), "0.10.10")
        self.assertEqual(ls.device_need(mins, "cut_adj"), "0.10.11")
        self.assertIsNone(ls.device_need({}, "sku"))


class Render(unittest.TestCase):
    def test_report_has_status_groups_and_flags(self):
        report = ls.render({
            "now": "25/10/2026 21:40",
            "git": {"head": "a0ea302 Chuan hoa", "origin": "a0ea302", "ahead": 0, "behind": 0},
            "extension": "0.10.8", "agent_version": "0.10.2",
            "migrations": {"ok": 85, "missing": {"sku_name_touch_v1.sql": ["function sku_name_touch", "trigger sku_name_touch"]}},
            "edge": [{"slug": "sku-sync", "version": 12, "deployed": "24/10 07:26", "commit": "23/10 23:07", "stale": False},
                     {"slug": "sku-vision", "version": 5, "deployed": "21/10 11:31", "commit": "21/10 11:40", "stale": True}],
            "agents": [{"name": "Máy kho 01", "version": "0.10.2", "capabilities": ["sku:v1"], "last_seen": "24/10 16:30", "enabled": True}],
            "cron": [{"name": "print-jobs-purge", "schedule": "0 20 * * *", "active": True}],
            "leases": [{"kind": "group_uid", "last_finished": "24/10 16:24"}],
        })
        for part in ["## Trạng thái lên thật", "**Web:**", "**ĐÃ LÊN — migration", "**ĐÃ LÊN — Edge Function", "**CHƯA LÊN**",
                     "sku_name_touch_v1.sql", "sku-vision", "Máy kho 01", "print-jobs-purge", "03:00"]:
            self.assertIn(part, report)
        self.assertIn("kiểm nội dung", report)  # Edge deploy trước commit cuối → cờ
        self.assertNotIn("Máy đồng bộ", report)  # không có khoá devices (--offline) → không in dòng nào

    BASE = {
        "now": "26/10/2026 14:40", "git": {"head": "a1 b", "origin": "a1", "ahead": 0, "behind": 0},
        "extension": "0.10.10", "agent_version": "0.10.2", "migrations": {"ok": 88, "missing": {}},
        "edge": [], "agents": [], "cron": [], "leases": [],
    }

    def test_devices_section_flags_below_minimum_and_undeclared(self):
        rows = [
            {"device": "may-a", "id4": "ab12", "version": "0.10.9", "last_seen": "26/10 12:48", "last_kind": "sku"},
            {"device": "may-b", "id4": "cd34", "version": None, "last_seen": "26/10 11:23", "last_kind": "group_uid"},
            {"device": "may-c", "id4": "ef56", "version": "0.10.10", "last_seen": "25/10 11:53", "last_kind": "cut_adj"},
        ]
        report = ls.render({**self.BASE, "devices": {"min": {"sku": "0.10.10", "group_uid": "0.10.10"}, "rows": rows}})
        self.assertIn("group_uid ≥ 0.10.10, sku ≥ 0.10.10", report)   # xếp theo tên loại
        self.assertRegex(report, r"`may-a` #ab12 v0\.10\.9 \(SKU, 26/10 12:48\) — dưới mức tối thiểu")
        self.assertRegex(report, r"`may-b` #cd34 chưa khai báo \(Group UID, 26/10 11:23\) — dưới mức tối thiểu")
        self.assertRegex(report, r"`may-c` #ef56 v0\.10\.10 \(ADJ, 25/10 11:53\)(?! —)")   # đủ bản: không cờ

    def test_devices_section_before_any_minimum_marks_undeclared_only(self):
        rows = [{"device": "may-b", "id4": "cd34", "version": None, "last_seen": "26/10 11:23", "last_kind": "sku"},
                {"device": "may-c", "id4": "ef56", "version": "0.10.10", "last_seen": "26/10 11:00", "last_kind": "sku"}]
        report = ls.render({**self.BASE, "devices": {"min": {}, "rows": rows}})
        self.assertIn("chưa đặt (không chặn)", report)
        self.assertRegex(report, r"`may-b` #cd34 chưa khai báo \(SKU, 26/10 11:23\) — chưa khai báo bản")
        self.assertNotIn("dưới mức", report)

    def test_devices_section_empty_and_missing_table(self):
        self.assertIn("chưa máy nào gọi Edge", ls.render({**self.BASE, "devices": {"min": {}, "rows": []}}))
        self.assertIn("migration `sync_auto_v3` chưa chạy", ls.render({**self.BASE, "devices": {"missing": True}}))


if __name__ == "__main__":
    unittest.main()
