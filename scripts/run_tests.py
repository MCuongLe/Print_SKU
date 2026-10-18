"""Chạy cả bộ test trong tests/ (Playwright *_browser.cjs, Node *.cjs/*.mjs) và in bảng PASS/FAIL.

    python scripts/run_tests.py                 # cả bộ
    python scripts/run_tests.py --only sku_sync # chỉ test có tên chứa từ khoá
    python scripts/run_tests.py --no-server     # không tự mở python -m http.server 8000

Mặc định tự mở máy chủ tĩnh cổng 8000 nếu chưa có, và đặt PLAYWRIGHT_MODULE nếu biến chưa có
và thư mục mặc định tồn tại. Test hỏng được chạy lại MỘT lần, tuần tự, sau khi cả bộ xong (tắt bằng
--no-retry); test chỉ đạt ở lần hai được ghi rõ là chập chờn. Thoát mã 1 khi còn test hỏng sau lần hai.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TESTS = ROOT / "tests"
DEFAULT_PLAYWRIGHT = Path(os.environ.get("USERPROFILE", "")) / "playwright-tools" / "node_modules" / "playwright"
SKIP = {"xlsx_read.cjs"}  # thư viện dùng chung, không phải test


def server_up() -> bool:
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default="", help="chỉ chạy test có tên chứa chuỗi này")
    parser.add_argument("--no-server", action="store_true")
    parser.add_argument("--timeout", type=int, default=600, help="giây cho mỗi test")
    parser.add_argument("--no-retry", action="store_true", help="không chạy lại test hỏng lần hai")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):  # console Windows mặc định cp1252 không in được tiếng Việt
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass

    env = dict(os.environ)
    if "PLAYWRIGHT_MODULE" not in env and DEFAULT_PLAYWRIGHT.exists():
        env["PLAYWRIGHT_MODULE"] = str(DEFAULT_PLAYWRIGHT).replace("\\", "/")
    env.setdefault("PYTHONIOENCODING", "utf-8")

    server = None
    if not args.no_server and not server_up():
        server = subprocess.Popen([sys.executable, "-m", "http.server", "8000"], cwd=ROOT,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            if server_up():
                break
            time.sleep(0.5)

    files = sorted(p for p in TESTS.iterdir() if p.suffix in {".cjs", ".mjs"} and p.name not in SKIP)
    if args.only:
        files = [p for p in files if args.only in p.name]
    def run_one(path: Path) -> tuple[bool, float, str]:
        t0 = time.time()
        try:
            run = subprocess.run(["node", str(path)], cwd=ROOT, env=env, capture_output=True,
                                 text=True, encoding="utf-8", errors="replace", timeout=args.timeout)
            ok = run.returncode == 0
            tail = (run.stdout + run.stderr).strip().splitlines()
            detail = "" if ok else "\n".join(tail[-12:])
        except subprocess.TimeoutExpired:
            ok, detail = False, f"quá {args.timeout} giây"
        return ok, time.time() - t0, detail

    results: dict[str, tuple[bool, float, str]] = {}
    flaky: list[str] = []
    started = time.time()
    try:
        for path in files:
            ok, took, detail = run_one(path)
            results[path.name] = (ok, took, detail)
            print(f"{'PASS' if ok else 'FAIL'}  {path.name}  ({took:.0f}s)", flush=True)
        retry = [p for p in files if not results[p.name][0]] if not args.no_retry else []
        if retry:
            print(f"\nChạy lại {len(retry)} test hỏng, tuần tự (lần 2):", flush=True)
            for path in retry:
                first_detail = results[path.name][2]
                ok, took, detail = run_one(path)
                if ok:
                    flaky.append(path.name)
                    results[path.name] = (True, took, first_detail)
                else:
                    results[path.name] = (False, took, detail)
                print(f"{'PASS (lần 2)' if ok else 'FAIL (lần 2)'}  {path.name}  ({took:.0f}s)", flush=True)
    finally:
        if server:
            server.terminate()

    failed = [(name, r[2]) for name, r in results.items() if not r[0]]
    print(f"\n{len(results) - len(failed)}/{len(results)} PASS trong {time.time() - started:.0f}s")
    if flaky:
        print(f"CHẬP CHỜN (hỏng lần 1, đạt lần 2): {', '.join(flaky)} — ghi vào báo cáo; lỗi lần 1 ở dưới.")
        for name in flaky:
            print(f"\n--- {name} (lần 1)\n{results[name][2]}")
    for name, detail in failed:
        print(f"\n--- {name}\n{detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
