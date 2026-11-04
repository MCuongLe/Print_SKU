"""scripts/run_tests.py (tăng tốc bộ test, 04/11/2026): hàm thuần — khoá một-bộ-một-lúc, chọn test theo tệp đổi (--changed),
xếp thứ tự chạy theo số đo, gộp số đo, chạy một tiến trình test. Không gọi git, không mở trình duyệt, không chạm khoá thật."""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import run_tests as rt  # noqa: E402


class LockTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "sub" / "run.lock"

    def tearDown(self):
        self.tmp.cleanup()

    def test_second_session_is_refused_until_release(self):
        first, second = rt.RunLock(self.path), rt.RunLock(self.path)
        self.assertTrue(first.try_acquire()[0])
        ok, holder = second.try_acquire()
        self.assertFalse(ok)
        self.assertEqual(holder["pid"], os.getpid())
        first.release()
        self.assertFalse(self.path.exists())
        self.assertTrue(second.try_acquire()[0])
        second.release()

    def test_dead_process_lock_is_broken(self):
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"pid": child.pid, "token": "chet", "startedAt": time.time()}), encoding="utf-8")
        lock = rt.RunLock(self.path)
        self.assertTrue(lock.try_acquire()[0])
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))["token"], lock.token)
        lock.release()

    def test_old_heartbeat_lock_is_broken_even_if_pid_alive(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text(json.dumps({"pid": os.getpid(), "token": "treo", "startedAt": time.time()}), encoding="utf-8")
        old = time.time() - rt.RunLock.STALE - 60
        os.utime(self.path, (old, old))
        lock = rt.RunLock(self.path)
        self.assertTrue(lock.try_acquire()[0])
        lock.release()

    def test_half_written_fresh_lock_is_not_broken(self):
        self.path.parent.mkdir(parents=True)
        self.path.write_text("", encoding="utf-8")
        ok, holder = rt.RunLock(self.path).try_acquire()
        self.assertFalse(ok)
        self.assertIsNone(holder)

    def test_no_wait_says_how_to_bypass(self):
        first = rt.RunLock(self.path)
        first.try_acquire()
        said = []
        self.assertFalse(rt.RunLock(self.path).acquire(0, said.append))
        self.assertEqual(len(said), 1)
        self.assertIn("--no-lock", said[0])
        self.assertIn(f"PID {os.getpid()}", said[0])
        first.release()

    def test_release_never_removes_someone_elses_lock(self):
        mine = rt.RunLock(self.path)
        mine.try_acquire()
        self.path.write_text(json.dumps({"pid": os.getpid(), "token": "cua-phien-khac"}), encoding="utf-8")
        mine.release()
        self.assertTrue(self.path.exists())

    def test_pid_alive_knows_itself_and_a_finished_child(self):
        self.assertTrue(rt.pid_alive(os.getpid()))
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait()
        self.assertFalse(rt.pid_alive(child.pid))


class ChangedSelectionTest(unittest.TestCase):
    REPO = ["supabase/a_v1.sql", "supabase/b_v1.sql", "extension/inside-po-connector/background.js", "scripts/commit_gate.py",
            "index.html", "docs/x.md", "tests/xlsx_read.cjs"]
    SOURCES = {
        "a_sql.cjs": 'const f = path.join(root, "supabase", "a_v1.sql");',
        "ext.cjs": 'fs.readFileSync(path.join(extensionDir, "background.js"), "utf8")',
        "xa_browser.cjs": "chromium.launch(); page.locator('#xa-vai-screen')",
        "typography_browser.cjs": "chromium.launch();",
        "test_gate.py": "import commit_gate\n",
        "sheet_browser.cjs": "chromium.launch(); require('./xlsx_read.cjs')",
    }

    def setUp(self):
        self.tests = [Path("tests") / name for name in self.SOURCES]
        self.deps, self.sources = rt.dependency_map(self.tests, self.REPO, read=lambda p: self.SOURCES[p.name])

    def plan(self, changed, pick=lambda: ({}, [])):
        return rt.plan_changed(changed, self.tests, self.deps, pick)

    def test_dependency_scan_finds_files_named_in_strings_and_python_modules(self):
        self.assertEqual(self.deps["a_sql.cjs"], {"supabase/a_v1.sql"})
        self.assertEqual(self.deps["ext.cjs"], {"extension/inside-po-connector/background.js"})
        self.assertEqual(self.deps["test_gate.py"], {"scripts/commit_gate.py"})
        self.assertEqual(self.deps["sheet_browser.cjs"], {"tests/xlsx_read.cjs"})
        self.assertEqual(self.deps["xa_browser.cjs"], set())

    def test_changed_migration_selects_its_test(self):
        chosen, unmapped = self.plan(["supabase/a_v1.sql"])
        self.assertEqual(set(chosen), {"a_sql.cjs"})
        self.assertEqual(unmapped, [])

    def test_file_without_test_is_unmapped_so_the_whole_suite_runs(self):
        chosen, unmapped = self.plan(["supabase/b_v1.sql", "supabase/a_v1.sql"])
        self.assertEqual(unmapped, ["supabase/b_v1.sql"])
        self.assertIn("a_sql.cjs", chosen)

    def test_docs_and_markdown_need_no_test(self):
        self.assertEqual(self.plan(["docs/x.md", "README.md", ".claude/settings.json"]), ({}, []))

    def test_changed_test_helper_selects_its_users_and_changed_test_selects_itself(self):
        self.assertEqual(set(self.plan(["tests/xlsx_read.cjs"])[0]), {"sheet_browser.cjs"})
        self.assertEqual(set(self.plan(["tests/xa_browser.cjs"])[0]), {"xa_browser.cjs"})
        self.assertEqual(self.plan(["tests/nhap_vao_test_da_xoa.cjs"])[1], ["tests/nhap_vao_test_da_xoa.cjs"])

    def test_python_script_selects_the_test_that_imports_it(self):
        self.assertEqual(set(self.plan(["scripts/commit_gate.py"])[0]), {"test_gate.py"})

    def test_index_html_adds_block_tests_and_the_ui_standard_group(self):
        chosen, unmapped = self.plan(["index.html"], lambda: ({"xa_browser.cjs": "index.html · xa-vai-script"}, []))
        self.assertEqual(set(chosen), {"xa_browser.cjs", "typography_browser.cjs"})
        self.assertEqual(unmapped, [])

    def test_index_html_block_without_test_is_unmapped(self):
        _, unmapped = self.plan(["index.html"], lambda: ({}, ["dòng 5–6 trong khối worker-bundle (không test nào nhắc tới)"]))
        self.assertEqual(len(unmapped), 1)
        self.assertTrue(unmapped[0].startswith("index.html: "))


class IndexBlocksTest(unittest.TestCase):
    BLOCKS = [
        {"tag": "section", "id": "xa-vai-screen", "hint": "", "start": 5, "end": 60},
        {"tag": "script", "id": "xa-vai-script", "hint": "", "start": 10, "end": 50},
        {"tag": "script", "id": "", "hint": "(dòng minified)", "start": 70, "end": 71},
        {"tag": "style", "id": "khong-ai-nhac-style", "hint": "", "start": 80, "end": 90},
    ]
    SOURCES = {"xa_vai_a4_browser.cjs": "page.locator('#xa-vai-screen')", "khac_browser.cjs": "page.goto(BASE)"}

    def test_range_inside_a_block_selects_tests_that_name_the_block_or_its_stem(self):
        selected, unmapped = rt.index_selection(self.BLOCKS, [(20, 21)], self.SOURCES)
        self.assertEqual(set(selected), {"xa_vai_a4_browser.cjs"})
        self.assertEqual(unmapped, [])

    def test_nested_blocks_one_named_by_a_test_is_enough(self):
        self.assertEqual(rt.index_selection(self.BLOCKS, [(12, 12)], self.SOURCES)[1], [])

    def test_block_without_id_or_without_test_or_outside_any_block_is_unmapped(self):
        for line in (70, 85, 100):
            selected, unmapped = rt.index_selection(self.BLOCKS, [(line, line)], self.SOURCES)
            self.assertEqual(selected, {}, line)
            self.assertEqual(len(unmapped), 1, line)

    def test_block_keys_strip_the_kind_suffix(self):
        self.assertEqual(rt.block_keys("xa-vai-script"), (["xa-vai-script", "xa-vai"], ["xa_vai_script", "xa_vai"]))
        self.assertEqual(rt.block_keys("admin-command-header-b-script")[0][1], "admin-command-header")
        self.assertEqual(rt.block_keys(""), ([], []))
        self.assertEqual(rt.block_keys("app-ui")[0], ["app-ui"])  # gốc quá ngắn: chỉ khớp đúng id

    def test_diff_hunks_become_new_side_line_ranges(self):
        diff = "@@ -1,2 +10,3 @@ x\n+a\n@@ -5 +7 @@\n@@ -20,2 +30,0 @@\n"
        self.assertEqual(rt.changed_line_ranges(diff), [(10, 12), (7, 7), (30, 30)])


class TimesTest(unittest.TestCase):
    def test_longest_known_test_runs_first_and_unknown_browser_tests_are_assumed_long(self):
        files = [Path("tests/a.cjs"), Path("tests/b.cjs"), Path("tests/c.cjs")]
        prev = {"a.cjs": {"seconds": 5}, "b.cjs": {"seconds": 50}}
        self.assertEqual([p.name for p in rt.schedule_order(files, prev)], ["b.cjs", "a.cjs", "c.cjs"])
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web_browser.cjs"
            web.write_text("const { chromium } = require('playwright');", encoding="utf-8")
            self.assertEqual(rt.test_kind(web), "browser")
            order = rt.schedule_order([Path("tests/a.cjs"), web], {"a.cjs": {"seconds": 30}})
            self.assertEqual(order[0], web)

    def test_partial_run_updates_only_its_tests_and_drops_deleted_ones(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "out" / "test-times.json"
            rt.save_times(path, {"a.cjs": {"seconds": 1.0}, "gone.cjs": {"seconds": 9.0}}, {"jobs": 4}, None)
            rt.save_times(path, {"a.cjs": {"seconds": 2.0}}, {"jobs": 1}, {"a.cjs", "b.cjs"})
            tests = rt.load_times(path)
            self.assertEqual(tests, {"a.cjs": {"seconds": 2.0}})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["lastRun"], {"jobs": 1})
            self.assertEqual(rt.load_times(Path(tmp) / "khong-co.json"), {})

    def test_table_lists_slowest_first_and_reports_speedup(self):
        rows = [("nhanh.cjs", "node", 1.0, True), ("cham.cjs", "browser", 30.0, False), ("vua.cjs", "browser", 10.0, True)]
        text = rt.format_times(rows, wall=14.0, jobs=4, top=2)
        lines = text.splitlines()
        self.assertIn("cham.cjs", lines[1])
        self.assertIn("(HỎNG)", lines[1])
        self.assertIn("vua.cjs", lines[2])
        self.assertNotIn("nhanh.cjs", "\n".join(lines[1:3]))
        self.assertIn("×2.9", lines[0])
        self.assertIn("browser 2 test 40s", lines[3])


class RunOneTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def script(self, name, body):
        path = self.dir / name
        path.write_text(body, encoding="utf-8")
        return path

    def test_exit_code_decides_and_failure_keeps_the_output_tail(self):
        ok, _, detail = rt.run_one(self.script("ok.cjs", "console.log('ổn');"), dict(os.environ), 60)
        self.assertTrue(ok)
        self.assertEqual(detail, "")
        ok, _, detail = rt.run_one(self.script("bad.cjs", "console.error('nổ'); process.exit(1);"), dict(os.environ), 60)
        self.assertFalse(ok)
        self.assertIn("nổ", detail)

    def test_timeout_stops_the_test_and_reports_it(self):
        started = time.time()
        ok, _, detail = rt.run_one(self.script("slow.cjs", "setTimeout(() => {}, 60000);"), dict(os.environ), 1)
        self.assertFalse(ok)
        self.assertEqual(detail, "quá 1 giây")
        self.assertLess(time.time() - started, 30)

    def test_main_with_no_matching_test_returns_zero_without_taking_the_lock(self):
        self.assertEqual(rt.main(["--only", "khong_co_test_nao_ten_nhu_the_zzz", "--no-server"]), 0)


if __name__ == "__main__":
    unittest.main()
