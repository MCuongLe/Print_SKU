"""Chạy cả bộ test trong tests/ (Playwright *_browser.cjs, Node *.cjs/*.mjs) và in bảng PASS/FAIL.

    python scripts/run_tests.py                 # cả bộ
    python scripts/run_tests.py --only sku_sync # chỉ test có tên chứa từ khoá
    python scripts/run_tests.py --no-server     # không tự mở python -m http.server 8000

Mặc định tự mở máy chủ tĩnh cổng 8000 nếu chưa có, và đặt PLAYWRIGHT_MODULE nếu biến chưa có
và thư mục mặc định tồn tại. Thoát mã 1 khi có test hỏng.
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
    args = parser.parse_args()

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
    results = []
    started = time.time()
    try:
        for path in files:
            t0 = time.time()
            try:
                run = subprocess.run(["node", str(path)], cwd=ROOT, env=env, capture_output=True,
                                     text=True, encoding="utf-8", errors="replace", timeout=args.timeout)
                ok = run.returncode == 0
                tail = (run.stdout + run.stderr).strip().splitlines()
                detail = "" if ok else "\n".join(tail[-12:])
            except subprocess.TimeoutExpired:
                ok, detail = False, f"quá {args.timeout} giây"
            results.append((path.name, ok, time.time() - t0, detail))
            print(f"{'PASS' if ok else 'FAIL'}  {path.name}  ({time.time() - t0:.0f}s)", flush=True)
    finally:
        if server:
            server.terminate()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} PASS trong {time.time() - started:.0f}s")
    for name, _, _, detail in failed:
        print(f"\n--- {name}\n{detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
