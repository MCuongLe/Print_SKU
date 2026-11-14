"""Chạy cả bộ test trong tests/ (Playwright *_browser.cjs, Node *.cjs/*.mjs, Python test_*.py bằng unittest) và in bảng PASS/FAIL.

    python scripts/run_tests.py                  # cả bộ, 4 tiến trình song song
    python scripts/run_tests.py --jobs 1         # tuần tự từng tệp, đúng như bản cũ
    python scripts/run_tests.py --only sku_sync  # chỉ test có tên chứa từ khoá; nhiều từ khoá cách nhau dấu phẩy (--only xa_vai,icon_standard)
    python scripts/run_tests.py --changed        # chỉ test liên quan tệp đang đổi (git); không map được thì chạy cả bộ
    python scripts/run_tests.py --changed --list # chỉ in test gợi ý + khối chưa có test / tệp không map được, không chạy (lead quyết bậc)
    python scripts/run_tests.py --port 8012      # phục vụ + đặt BASE ở cổng khác (worktree; cổng 8000 giữ cho cây chính)
    python scripts/run_tests.py --no-server      # không tự mở python -m http.server

Mặc định tự mở máy chủ tĩnh nếu cổng chưa có, và đặt PLAYWRIGHT_MODULE nếu biến chưa có và thư mục mặc định tồn tại.
Mỗi test vẫn là một tiến trình riêng; --jobs N chạy N tiến trình cùng lúc (mặc định 4, không quá số lõi), in kết quả theo
thứ tự hoàn thành. Test hỏng được chạy lại MỘT lần, tuần tự, sau khi cả bộ xong (tắt bằng --no-retry); test chỉ đạt ở lần
hai được ghi rõ là chập chờn. Thoát mã 1 khi còn test hỏng sau lần hai.

Một máy chỉ chạy MỘT bộ một lúc: tệp khoá nằm ở thư mục .git chung của mọi worktree (PRINT_SKU_TEST_LOCK đổi đường dẫn);
phiên đến sau chờ tối đa --lock-wait giây (0 = không chờ, báo rõ rồi thoát mã 3). --no-lock bỏ qua khoá.
Sau mỗi lần chạy in 15 test chậm nhất và ghi outputs/test-times.json (số đo từng test; lần sau dùng để xếp test dài chạy trước).
"""
from __future__ import annotations

import argparse
import concurrent.futures as futures
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
OUTPUTS = ROOT / "outputs"  # đã nằm trong .gitignore
TIMES_FILE = OUTPUTS / "test-times.json"
DEFAULT_PLAYWRIGHT = Path(os.environ.get("USERPROFILE", "")) / "playwright-tools" / "node_modules" / "playwright"
SKIP = {"xlsx_read.cjs", "page_settle.cjs"}  # thư viện dùng chung của test, không phải test
DEFAULT_PORT = 8000
DEFAULT_JOBS = 4
LOCK_WAIT_SECONDS = 1800
# Bộ chuẩn giao diện: đúng 11 test ở docs/chuan/GIAO_DIEN.md mục "Kiểm giao diện" (nguồn duy nhất, 13/11/2026);
# luôn chạy kèm khi --changed thấy index.html đổi.
UI_STANDARD = ("design_tokens_ratchet.cjs", "typography_browser.cjs", "ui_standard_browser.cjs",
               "icon_standard_browser.cjs", "a11y_axe_browser.cjs", "contrast_states_browser.cjs",
               "touch_target_browser.cjs", "small_targets_browser.cjs", "tick_standard_browser.cjs",
               "scan_field_standard_browser.cjs", "notice_standard_browser.cjs")
# Đường dẫn đổi mà không test nào của bộ này cần chạy (tài liệu, cấu hình máy; workstation-agent/ có bộ test riêng
# `node --test` trong thư mục đó, không nằm trong run_tests.py): không ép chạy cả bộ.
IGNORED_PREFIX = ("docs/", ".claude/", "outputs/", "workstation-agent/")
IGNORED_NAMES = {".gitignore", ".gitattributes", "repomix.config.json"}
IGNORED_SUFFIX = (".md",)


# ---------------------------------------------------------------- tệp test và số đo

def list_tests(tests_dir: Path = TESTS) -> list[Path]:
    return sorted(p for p in tests_dir.iterdir()
                  if (p.suffix in {".cjs", ".mjs"} or p.suffix == ".py" and p.name.startswith("test_")) and p.name not in SKIP)


def test_kind(path: Path) -> str:
    """python | edge (.mjs) | browser (mở Chrome qua Playwright) | node."""
    if path.suffix == ".py":
        return "python"
    if path.suffix == ".mjs":
        return "edge"
    try:
        return "browser" if "chromium" in path.read_text(encoding="utf-8", errors="replace") else "node"
    except OSError:
        return "node"


def load_times(path: Path = TIMES_FILE) -> dict[str, dict]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        tests = data.get("tests", {})
        return tests if isinstance(tests, dict) else {}
    except (OSError, ValueError):
        return {}


def schedule_order(files: list[Path], prev: dict[str, dict]) -> list[Path]:
    """Test dài chạy trước (LPT) để hàng đợi không dồn một test dài vào cuối. Chưa có số đo: ước 60 s nếu mở Chrome, 5 s còn lại."""
    def key(path: Path):
        seconds = prev.get(path.name, {}).get("seconds")
        if not isinstance(seconds, (int, float)):
            seconds = 60.0 if test_kind(path) == "browser" else 5.0
        return (-seconds, path.name)
    return sorted(files, key=key)


def save_times(path: Path, results: dict[str, dict], meta: dict, existing: set[str] | None) -> None:
    """Gộp số đo vào tệp cũ: bộ chạy một phần chỉ cập nhật test đã chạy; tên test không còn tồn tại thì bỏ."""
    merged = {name: row for name, row in load_times(path).items() if existing is None or name in existing}
    merged.update(results)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"lastRun": meta, "tests": dict(sorted(merged.items()))}, ensure_ascii=False, indent=1) + "\n",
                    encoding="utf-8")


def format_times(rows: list[tuple[str, str, float, bool]], wall: float, jobs: int, top: int = 15) -> str:
    """rows = (tên, loại, giây, đạt). In `top` test chậm nhất + tổng theo loại + hệ số tăng tốc so với chạy tuần tự."""
    if not rows:
        return ""
    total = sum(r[2] for r in rows)
    lines = [f"Thời gian từng test — {min(top, len(rows))} test chậm nhất (cộng dồn {total:.0f}s, thực tế {wall:.0f}s"
             f"{f', ×{total / wall:.1f} với {jobs} tiến trình' if jobs > 1 and wall > 0 else ''}):"]
    for rank, (name, kind, seconds, ok) in enumerate(sorted(rows, key=lambda r: -r[2])[:top], 1):
        lines.append(f"  {rank:>2}. {seconds:>6.1f}s  {kind:<7} {name}{'' if ok else '  (HỎNG)'}")
    by_kind: dict[str, list[float]] = {}
    for _, kind, seconds, _ in rows:
        by_kind.setdefault(kind, []).append(seconds)
    lines.append("  Theo loại: " + " · ".join(f"{k} {len(v)} test {sum(v):.0f}s" for k, v in sorted(by_kind.items())))
    return "\n".join(lines)


# ---------------------------------------------------------------- khoá một bộ một lúc

def pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, 0, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: tiến trình có thật, chỉ không đủ quyền
        code = ctypes.c_ulong()
        ok = kernel.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def default_lock_path() -> Path:
    """Khoá dùng chung cho mọi worktree của repo: thư mục .git chung (outputs/ nằm riêng từng worktree nên không chặn được chéo)."""
    env = os.environ.get("PRINT_SKU_TEST_LOCK")
    if env:
        return Path(env)
    try:
        run = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True, text=True, timeout=15)
        text = run.stdout.strip()
        if run.returncode == 0 and text:
            folder = Path(text)
            folder = folder if folder.is_absolute() else ROOT / folder
            if folder.is_dir():
                return folder.resolve() / "print_sku_run_tests.lock"
    except (OSError, subprocess.SubprocessError):
        pass
    return Path(tempfile.gettempdir()) / "print_sku_run_tests.lock"


class RunLock:
    """Tệp khoá {pid, token, startedAt, cwd, argv}. Tạo nguyên tử (O_EXCL); chủ khoá cập nhật mtime mỗi BEAT giây.
    Khoá chết = tiến trình chủ không còn HOẶC mtime cũ hơn STALE giây (chủ bị treo / máy ngủ). Khoá chết bị phá khi phiên khác thấy."""

    BEAT = 20
    STALE = 120

    def __init__(self, path: Path, info: dict | None = None):
        self.path = Path(path)
        self.token = uuid.uuid4().hex
        self.info = {"pid": os.getpid(), "token": self.token, "startedAt": time.time(), "cwd": str(ROOT),
                     "argv": sys.argv[1:], **(info or {})}
        self.held = False
        self._stop = threading.Event()

    def _read(self) -> dict | None:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None

    def _age(self) -> float:
        try:
            return time.time() - self.path.stat().st_mtime
        except OSError:
            return 0.0

    def is_stale(self, holder: dict | None) -> bool:
        if holder is None:  # đang được ghi dở hoặc hỏng: chỉ coi là chết khi lâu không ai cập nhật
            return self._age() > self.STALE
        pid = holder.get("pid")
        return not isinstance(pid, int) or not pid_alive(pid) or self._age() > self.STALE

    def _break(self, seen: dict | None) -> None:
        now = self._read()  # chỉ xoá khi vẫn đúng khoá chết vừa thấy (tránh xoá nhầm khoá mới của phiên khác)
        if (now or {}).get("token") == (seen or {}).get("token"):
            try:
                self.path.unlink()
            except OSError:
                pass

    def try_acquire(self) -> tuple[bool, dict | None]:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(3):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                holder = self._read()
                if self.is_stale(holder):
                    self._break(holder)
                    continue
                return False, holder
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(json.dumps(self.info, ensure_ascii=False))
            self.held = True
            threading.Thread(target=self._beat, daemon=True).start()
            return True, None
        return False, self._read()

    def _beat(self) -> None:
        while not self._stop.wait(self.BEAT):
            try:
                os.utime(self.path)
            except OSError:
                pass

    def describe(self, holder: dict | None) -> str:
        if not holder:
            return "một phiên khác (chưa đọc được thông tin khoá)"
        started = holder.get("startedAt")
        since = f"bắt đầu {time.strftime('%H:%M', time.localtime(started))}, đã {(time.time() - started) / 60:.0f} phút" \
            if isinstance(started, (int, float)) else "chưa rõ lúc bắt đầu"
        return f"PID {holder.get('pid')}, {since}, cây {holder.get('cwd')}, lệnh: run_tests.py {' '.join(holder.get('argv') or [])}".rstrip()

    def acquire(self, wait_seconds: float, say) -> bool:
        deadline = time.time() + max(0.0, wait_seconds)
        announced = 0.0
        while True:
            ok, holder = self.try_acquire()
            if ok:
                return True
            now = time.time()
            if now >= deadline:
                say(f"Không chạy: bộ test của phiên khác còn giữ khoá ({self.describe(holder)}). "
                    f"Chờ lâu hơn bằng --lock-wait <giây>, hoặc bỏ qua khoá bằng --no-lock (máy dễ quá tải, test dễ chập chờn).")
                return False
            if now - announced >= 60:
                say(f"Đang chờ bộ test của phiên khác ({self.describe(holder)}); chờ tối đa {max(0, deadline - now) / 60:.0f} phút nữa.")
                announced = now
            time.sleep(min(5.0, max(0.2, deadline - now)))

    def release(self) -> None:
        self._stop.set()
        if self.held and (self._read() or {}).get("token") == self.token:
            try:
                self.path.unlink()
            except OSError:
                pass
        self.held = False


# ---------------------------------------------------------------- chọn test theo tệp đổi (--changed)

_LITERAL = re.compile(r"""["'`]([^"'`\r\n]{1,240}?\.(?:sql|js|mjs|cjs|py|json|html|ts|md|css|svg|png|csv|xlsx|txt))["'`]""", re.I)
_HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@", re.M)
_SUFFIX = re.compile(r"(?:-b)?-(?:script|style|screen|core|ui|theme|tab)$")


def git_lines(*args: str) -> list[str] | None:
    try:
        run = subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
    except (OSError, subprocess.SubprocessError):
        return None
    return run.stdout.splitlines() if run.returncode == 0 else None


def changed_paths(ref: str = "HEAD") -> list[str] | None:
    """Tệp đổi so với ref (đã stage hoặc chưa) + tệp chưa theo dõi; None khi không đọc được git."""
    diff = git_lines("diff", "--name-only", "--no-renames", ref, "--")
    other = git_lines("ls-files", "--others", "--exclude-standard")
    if diff is None or other is None:
        return None
    return sorted({p.strip().replace("\\", "/") for p in diff + other if p.strip()})


def changed_line_ranges(diff_text: str) -> list[tuple[int, int]]:
    """Dải dòng (phía mới) của `git diff -U0`; hunk chỉ xoá tính tại dòng liền sau."""
    ranges = []
    for match in _HUNK.finditer(diff_text):
        start = int(match.group(1))
        count = int(match.group(2)) if match.group(2) is not None else 1
        ranges.append((start, start + max(count, 1) - 1))
    return ranges


def dependency_map(tests: list[Path], repo_files: list[str], read=lambda p: p.read_text(encoding="utf-8", errors="replace")
                   ) -> tuple[dict[str, set[str]], dict[str, str]]:
    """Mỗi test nhắc tới những tệp repo nào (quét tên tệp trong chuỗi ký tự; module Python của scripts/ theo từ khoá).
    Quét thừa còn hơn thiếu: chỉ làm chọn nhiều test hơn cần, không bỏ sót. Trả (test → tập đường dẫn, test → mã nguồn)."""
    by_name: dict[str, list[str]] = {}
    for rel in repo_files:
        by_name.setdefault(rel.rsplit("/", 1)[-1], []).append(rel)
    py_modules = {rel.rsplit("/", 1)[-1][:-3]: rel for rel in repo_files if rel.startswith("scripts/") and rel.endswith(".py")}
    deps: dict[str, set[str]] = {}
    sources: dict[str, str] = {}
    for test in tests:
        text = read(test)
        sources[test.name] = text
        found: set[str] = set()
        for literal in _LITERAL.findall(text):
            tail = literal.replace("\\", "/").lstrip("./")
            candidates = by_name.get(tail.rsplit("/", 1)[-1], [])
            narrowed = [c for c in candidates if "/" not in tail or c.endswith(tail)]
            found.update(narrowed or candidates)
        if test.suffix == ".py":
            found.update(rel for stem, rel in py_modules.items() if re.search(rf"\b{re.escape(stem)}\b", text))
        found.discard("tests/" + test.name)
        deps[test.name] = found
    return deps, sources


def block_keys(ident: str) -> tuple[list[str], list[str]]:
    """Từ id khối index.html → (chuỗi tìm trong mã test, chuỗi tìm trong tên tệp test). `xa-vai-script` → xa-vai-script, xa-vai / xa_vai."""
    if not ident:
        return [], []
    stem = ident
    while _SUFFIX.search(stem):
        stem = _SUFFIX.sub("", stem)
    keys = [ident] + ([stem] if len(stem) >= 6 and stem != ident else [])
    return keys, [k.replace("-", "_") for k in keys if len(k) >= 6]


def index_selection(blocks: list[dict], ranges: list[tuple[int, int]], sources: dict[str, str]) -> tuple[dict[str, str], list[str]]:
    """Khối index.html chứa dòng đổi → test nhắc id / gốc id khối đó. Trả (test → lý do, khối không map được)."""
    selected: dict[str, str] = {}
    unmapped: list[str] = []
    for lo, hi in ranges:
        hit = [b for b in blocks if b["start"] <= hi and b["end"] >= lo]
        if not hit:
            unmapped.append(f"dòng {lo}–{hi} (ngoài khối có id)")
            continue
        found = False  # khối lồng nhau (section chứa script): đủ một khối có test nhắc tới là dải dòng này map được
        for block in hit:
            text_keys, name_keys = block_keys(block["id"].replace("src=", ""))
            for name, text in sources.items():
                if any(k in text for k in text_keys) or any(k in name for k in name_keys):
                    selected.setdefault(name, f"index.html · {block['id']}")
                    found = True
        if not found:
            names = ", ".join(b["id"] or b["hint"] or b["tag"] for b in hit[:3])
            unmapped.append(f"dòng {lo}–{hi} trong khối {names} (không test nào nhắc tới)")
    return selected, unmapped


def is_ignored(path: str) -> bool:
    return path.startswith(IGNORED_PREFIX) or path in IGNORED_NAMES or path.endswith(IGNORED_SUFFIX)


def plan_changed(changed: list[str], tests: list[Path], deps: dict[str, set[str]], index_pick) -> tuple[dict[str, str], list[str]]:
    """Trả (test → lý do, đường dẫn không map được). `index_pick()` cho index.html → (test → lý do, khối không map được).
    Có đường dẫn không map được thì người gọi chạy cả bộ."""
    names = {t.name for t in tests}
    chosen: dict[str, str] = {}
    unmapped: list[str] = []
    for path in changed:
        hit = False
        if path.startswith("tests/") and path.split("/", 1)[1] in names:
            chosen.setdefault(path.split("/", 1)[1], path)
            hit = True
        for name in names:
            if path in deps.get(name, ()):
                chosen.setdefault(name, path)
                hit = True
        if path == "index.html":
            picked, bad = index_pick()
            for name, why in picked.items():
                chosen.setdefault(name, why)
            for name in UI_STANDARD:
                if name in names:
                    chosen.setdefault(name, "index.html · bộ chuẩn giao diện")
            unmapped.extend(f"index.html: {b}" for b in bad)
            hit = True
        if not hit and not is_ignored(path):
            unmapped.append(path)
    return chosen, unmapped


# ---------------------------------------------------------------- chạy test

def kill_tree(proc: subprocess.Popen) -> None:
    """Dừng cả cây tiến trình (node + Chrome con); subprocess.run chỉ dừng node nên Chrome mồ côi còn ăn máy."""
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
        else:
            proc.kill()
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        proc.kill()
    except OSError:
        pass


def run_one(path: Path, env: dict, timeout: int, live: set | None = None) -> tuple[bool, float, str]:
    t0 = time.time()
    cmd = [sys.executable, "-m", "unittest", str(path)] if path.suffix == ".py" else ["node", str(path)]
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            text=True, encoding="utf-8", errors="replace")
    if live is not None:
        live.add(proc)
    try:
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            try:
                proc.communicate(timeout=15)
            except (subprocess.TimeoutExpired, OSError):
                pass
            return False, time.time() - t0, f"quá {timeout} giây"
        ok = proc.returncode == 0
        tail = (out + err).strip().splitlines()
        return ok, time.time() - t0, "" if ok else "\n".join(tail[-12:])
    finally:
        if live is not None:
            live.discard(proc)


def server_up(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as resp:
            return resp.status == 200
    except Exception:  # noqa: BLE001
        return False


def served_tree_differs(port: int) -> bool:
    """True khi máy chủ ở cổng này phục vụ index.html KHÁC tệp của cây này (vd. worktree chạy trên cổng 8000 của cây chính)."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/index.html", timeout=10) as resp:
            served = resp.read()
        return hashlib.sha256(served).digest() != hashlib.sha256((ROOT / "index.html").read_bytes()).digest()
    except Exception:  # noqa: BLE001
        return False


def say(text: str) -> None:
    print(text, flush=True)


NO_TEST_MARK = "không test nào nhắc tới"


def only_filter(files: list[Path], spec: str) -> list[Path]:
    """--only: một hoặc nhiều từ khoá cách nhau dấu phẩy; giữ test có tên chứa BẤT KỲ từ khoá nào (05/11/2026, bậc 1 cần
    gọi một lệnh cho test màn + 3 test chuẩn). Chuỗi rỗng / chỉ dấu phẩy = không lọc."""
    keys = [k.strip() for k in spec.split(",") if k.strip()]
    if not keys:
        return files
    return [p for p in files if any(k in p.name for k in keys)]


def split_unmapped(unmapped: list[str]) -> tuple[list[str], list[str]]:
    """Tách phần không map được thành (khối index.html chưa có test nào nhắc, tệp / dải dòng khác)."""
    blocks = [u for u in unmapped if NO_TEST_MARK in u]
    others = [u for u in unmapped if NO_TEST_MARK not in u]
    return blocks, others


def changed_summary(chosen: dict[str, str], unmapped: list[str], all_files: list[Path], listing: bool) -> list[str]:
    """Dòng in cho --changed. Có phần không map được: --list in gợi ý + hai nhóm để lead quyết bậc (--only hoặc cả bộ);
    không --list thì giữ hành vi cũ (chạy cả bộ)."""
    lines: list[str] = []
    reasons: dict[str, int] = {}
    for why in chosen.values():
        reasons[why] = reasons.get(why, 0) + 1
    picked = [p.name for p in all_files if p.name in chosen]
    if not unmapped:
        lines.append(f"Chọn {len(picked)}/{len(all_files)} test: " + " · ".join(f"{k} → {v}" for k, v in sorted(reasons.items())[:8]))
        return lines
    blocks, others = split_unmapped(unmapped)
    if not listing:
        lines.append("Không map được sang test nào → chạy CẢ BỘ: " + "; ".join(unmapped[:8]) + (" …" if len(unmapped) > 8 else ""))
        lines.append("(--changed --list để xem gợi ý và tự chọn --only thay vì cả bộ)")
        return lines
    lines.append(f"Gợi ý {len(picked)}/{len(all_files)} test (map được): " + " · ".join(f"{k} → {v}" for k, v in sorted(reasons.items())[:8]))
    lines.extend(f"  {name}" for name in picked)
    if blocks:
        lines.append("Khối index.html chưa có test nào nhắc (viết test hoặc lead quyết bậc):")
        lines.extend(f"  {b}" for b in blocks[:12])
    if others:
        lines.append("Tệp không map được (lead quyết bậc: thêm --only hoặc chạy cả bộ):")
        lines.extend(f"  {o}" for o in others[:12])
    stems = [name.rsplit(".", 1)[0] for name in picked]
    lines.append("Không --list: sẽ chạy CẢ BỘ." + (f" Chạy riêng phần gợi ý: --only {','.join(stems)}" if stems else ""))
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="chỉ chạy test có tên chứa từ khoá; nhiều từ khoá cách nhau dấu phẩy")
    parser.add_argument("--changed", nargs="?", const="HEAD", default=None, metavar="REF",
                        help="chỉ chạy test liên quan tệp đổi so với REF (mặc định HEAD, gồm cả tệp chưa theo dõi); không map được thì cả bộ (kèm --list: in gợi ý để lead quyết)")
    parser.add_argument("--jobs", type=int, default=DEFAULT_JOBS, help=f"số test chạy cùng lúc (mặc định {DEFAULT_JOBS}, tối đa theo số lõi; 1 = tuần tự như cũ)")
    parser.add_argument("--port", type=int, default=None, help=f"cổng máy chủ tĩnh + BASE (mặc định {DEFAULT_PORT}, để cho cây chính; worktree dùng cổng khác)")
    parser.add_argument("--list", action="store_true", help="chỉ in danh sách test sẽ chạy rồi thoát")
    parser.add_argument("--no-server", action="store_true")
    parser.add_argument("--timeout", type=int, default=600, help="giây cho mỗi test")
    parser.add_argument("--no-retry", action="store_true", help="không chạy lại test hỏng lần hai")
    parser.add_argument("--no-lock", action="store_true", help="bỏ qua khoá một-bộ-một-lúc")
    parser.add_argument("--lock-wait", type=int, default=LOCK_WAIT_SECONDS, help="giây chờ khi phiên khác đang chạy bộ test (0 = không chờ)")
    args = parser.parse_args(argv)
    for stream in (sys.stdout, sys.stderr):  # console Windows mặc định cp1252 không in được tiếng Việt
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

    env = dict(os.environ)
    if "PLAYWRIGHT_MODULE" not in env and DEFAULT_PLAYWRIGHT.exists():
        env["PLAYWRIGHT_MODULE"] = str(DEFAULT_PLAYWRIGHT).replace("\\", "/")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    port = args.port or DEFAULT_PORT
    if args.port:
        env["BASE"] = env["APP_URL"] = f"http://127.0.0.1:{port}/"
    elif env.get("BASE"):
        port = urllib.parse.urlparse(env["BASE"]).port or port

    all_files = list_tests()
    files = all_files
    if args.changed is not None:
        changed = changed_paths(args.changed)
        if changed is None:
            say("--changed: không đọc được git → chạy cả bộ.")
        else:
            repo = git_lines("ls-files", "--cached", "--others", "--exclude-standard") or []
            deps, sources = dependency_map(all_files, [p.replace("\\", "/") for p in repo])

            def index_pick():
                from importlib import import_module
                sys.path.insert(0, str(ROOT / "scripts"))
                blocks = import_module("index_outline").outline((ROOT / "index.html").read_text(encoding="utf-8"))
                diff = subprocess.run(["git", "diff", "-U0", "--no-renames", args.changed, "--", "index.html"], cwd=ROOT,
                                      capture_output=True, text=True, encoding="utf-8", errors="replace").stdout
                return index_selection(blocks, changed_line_ranges(diff), sources)

            chosen, unmapped = plan_changed(changed, all_files, deps, index_pick)
            say(f"--changed {args.changed}: {len(changed)} tệp đổi" + (f" ({', '.join(changed[:6])}{' …' if len(changed) > 6 else ''})" if changed else ""))
            if any(p.startswith("workstation-agent/") for p in changed):
                say("workstation-agent/ đổi: bộ test của agent chạy riêng (`node --test` trong workstation-agent/), không thuộc run_tests.py.")
            for line in changed_summary(chosen, unmapped, all_files, args.list):
                say(line)
            if unmapped and args.list:
                return 0
            if not unmapped:
                files = [p for p in all_files if p.name in chosen]
                if not files:
                    say("Không có test liên quan (chỉ đổi tài liệu / cấu hình): bậc 0, chỉ cần commit_gate.")
                    return 0
    files = only_filter(files, args.only)
    if not files:
        say("Không có test nào khớp.")
        return 0
    if args.list:
        say("\n".join(p.name for p in files) + f"\n{len(files)}/{len(all_files)} test")
        return 0
    jobs = max(1, min(args.jobs, os.cpu_count() or 1, len(files)))
    if args.jobs > jobs and jobs < len(files):
        say(f"--jobs {args.jobs} vượt số lõi ({os.cpu_count()}) → dùng {jobs}.")

    lock = None
    if not args.no_lock:
        lock = RunLock(default_lock_path(), {"jobs": jobs})
        if not lock.acquire(args.lock_wait, say):
            return 3

    server = None
    live: set = set()
    prev_times = load_times()
    results: dict[str, tuple[bool, float, str]] = {}
    flaky: list[str] = []
    second: dict[str, float] = {}
    started = time.time()
    try:
        if not args.no_server and not server_up(port):
            server = subprocess.Popen([sys.executable, "-m", "http.server", str(port)], cwd=ROOT,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            for _ in range(20):
                if server_up(port):
                    break
                time.sleep(0.5)
        elif server_up(port) and served_tree_differs(port):
            say(f"CẢNH BÁO: máy chủ cổng {port} phục vụ index.html KHÁC cây này ({ROOT}); test trình duyệt đang kiểm cây kia. "
                f"Chạy với --port <cổng khác> để dùng máy chủ riêng của cây này.")

        order = files if jobs == 1 else schedule_order(files, prev_times)
        done = 0
        say(f"Chạy {len(order)} test, {jobs} tiến trình" + (" (tuần tự)" if jobs == 1 else "") + f"; cổng {port}.")
        pool = futures.ThreadPoolExecutor(max_workers=jobs)
        try:
            pending = {pool.submit(run_one, p, env, args.timeout, live): p for p in order}
            for fut in futures.as_completed(pending):
                path = pending[fut]
                ok, took, detail = fut.result()
                results[path.name] = (ok, took, detail)
                done += 1
                say(f"{'' if jobs == 1 else f'[{done}/{len(order)}] '}{'PASS' if ok else 'FAIL'}  {path.name}  ({took:.0f}s)")
        except BaseException:
            for proc in list(live):
                kill_tree(proc)
            pool.shutdown(wait=False, cancel_futures=True)
            raise
        pool.shutdown(wait=True)
        retry = [p for p in order if not results[p.name][0]] if not args.no_retry else []
        if retry:
            say(f"\nChạy lại {len(retry)} test hỏng, tuần tự (lần 2):")
            for path in retry:
                first_detail = results[path.name][2]
                ok, took, detail = run_one(path, env, args.timeout)
                second[path.name] = took
                if ok:
                    flaky.append(path.name)
                    results[path.name] = (True, took, first_detail)
                else:
                    results[path.name] = (False, took, detail)
                say(f"{'PASS (lần 2)' if ok else 'FAIL (lần 2)'}  {path.name}  ({took:.0f}s)")
    finally:
        if server:
            server.terminate()
        if lock:
            lock.release()

    wall = time.time() - started
    kinds = {p.name: test_kind(p) for p in files}
    rows = [(name, kinds[name], r[1], r[0]) for name, r in results.items()]
    stamp = time.strftime("%Y-%m-%dT%H:%M:%S")
    try:
        save_times(TIMES_FILE, {name: {"kind": kinds[name], "seconds": round(r[1], 1), "ok": r[0], "at": stamp,
                                       **({"retrySeconds": round(second[name], 1)} if name in second else {})}
                               for name, r in results.items()},
                   {"at": stamp, "jobs": jobs, "wallSeconds": round(wall, 1), "tests": len(results), "only": args.only,
                    "changed": args.changed, "cpus": os.cpu_count()},
                   {p.name for p in all_files})
    except OSError as exc:
        say(f"(không ghi được {TIMES_FILE}: {exc})")
    print("\n" + format_times(rows, wall, jobs), flush=True)

    failed = [(name, r[2]) for name, r in results.items() if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} PASS trong {wall:.0f}s")
    if flaky:
        print(f"CHẬP CHỜN (hỏng lần 1, đạt lần 2): {', '.join(flaky)} — ghi vào báo cáo; lỗi lần 1 ở dưới.")
        for name in flaky:
            print(f"\n--- {name} (lần 1)\n{results[name][2]}")
    for name, detail in failed:
        print(f"\n--- {name}\n{detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
