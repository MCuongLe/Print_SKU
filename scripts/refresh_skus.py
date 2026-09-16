#!/usr/bin/env python3
"""Refresh the SKU database from Mastige Inside, one category at a time.

Inside has no usable API for this: its export endpoint answers 401 unless the
request comes from a logged-in page, so the browser has to stay in the loop.
This tool packages everything around that constraint.

    python scripts/refresh_skus.py snippet   # in ra doan JS de dan vao Console
    python scripts/refresh_skus.py merge     # quet Downloads, kiem tra, nap vao sku.db
    python scripts/refresh_skus.py sync      # day sku.db len Supabase

Them category: sua scripts/sku_categories.json, khong can sua code.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

from inspect_export_category import inspect
from merge_sku_category_xlsx import merge_workbook


CONFIG_PATH = Path(__file__).with_name("sku_categories.json")
EXPORT_GLOB = "hasaki-product-all-sku-cate-*.xlsx"
DEFAULT_DOWNLOADS = Path.home() / "Downloads"
DEFAULT_DATABASE = Path("data/sku.db")

# Doan JS dan vao Console cua mot tab inside.mastige.vn da dang nhap.
# Moi category duoc nap trong mot iframe cung origin nen khong phai tai lai trang.
# Server tra 503 khi file export chua tao xong; khi do iframe hien trang loi va
# script bam lai (export da duoc cache trong ngay nen lan sau gan nhu tuc thi).
SNIPPET = r"""
(async () => {
  const CATS = @@CATS@@;
  const ATTEMPTS = 3;
  const log = (m) => console.log("%c[SKU]", "color:#0a7", m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (!location.hostname.endsWith("mastige.vn")) {
    log("Hay chay tren mot tab inside.mastige.vn da dang nhap.");
    return;
  }
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;left:-9999px;width:1280px;height:900px";
  document.body.appendChild(frame);
  const done = [], failed = [];
  for (const id of CATS) {
    let ok = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
      log("category " + id + " - lan " + attempt);
      frame.src = "/sales/product?kw=&category_id=" + id +
        "&barcode=0&status=1&type=0&pushweb=&config=&stocking_status=0&hide_kw=";
      await new Promise((r) => { frame.onload = r; setTimeout(r, 60000); });
      const w = frame.contentWindow, d = frame.contentDocument;
      const btn = d && d.getElementById("download-products");
      if (!btn) { log("  [!] khong thay nut Download - phien dang nhap co the da het han"); break; }
      await new Promise((res) => {
        w.exportComplete = function () { setTimeout(res, 5000); };
        btn.click();
        setTimeout(res, 300000);
      });
      const text = ((frame.contentDocument && frame.contentDocument.body.innerText) || "").slice(0, 500);
      if (/503|Service Unavailable|Bad Gateway|Not Found/i.test(text)) {
        log("  [...] file chua san sang (503), thu lai");
        await sleep(5000);
      } else {
        ok = true;
        log("  [ok] da tai");
      }
    }
    (ok ? done : failed).push(id);
  }
  frame.remove();
  log("XONG - tai duoc: " + (done.join(", ") || "khong co") +
      (failed.length ? " | chua duoc: " + failed.join(", ") : ""));
  log("Buoc tiep: python scripts/refresh_skus.py merge");
})();
"""


def load_categories() -> list[dict[str, str]]:
    data = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    categories = data.get("categories")
    if not categories:
        raise ValueError(f"{CONFIG_PATH.name} does not list any categories")
    for entry in categories:
        if not str(entry.get("id", "")).strip() or not str(entry.get("name", "")).strip():
            raise ValueError(f"Every category needs an id and a name: {entry!r}")
    return [{"id": str(e["id"]).strip(), "name": str(e["name"]).strip()} for e in categories]


def newest_export_per_category(
    downloads: Path, minutes: int
) -> tuple[dict[str, Path], list[dict[str, object]]]:
    """Map category_id to the newest matching export file, plus files we refused."""
    cutoff = time.time() - minutes * 60
    candidates = sorted(
        (path for path in downloads.glob(EXPORT_GLOB) if path.stat().st_mtime >= cutoff),
        key=lambda path: path.stat().st_mtime,
    )
    chosen: dict[str, Path] = {}
    rejected: list[dict[str, object]] = []
    for path in candidates:
        try:
            report = inspect(path)
        except Exception as error:  # unreadable, or an unexpected layout
            rejected.append({"file": path.name, "reason": str(error)})
            continue
        found = report["categories"]
        if len(found) != 1:
            rejected.append(
                {
                    "file": path.name,
                    "reason": f"chua {len(found)} category, chi nhan file mot category",
                }
            )
            continue
        chosen[found[0]["category_id"]] = path  # danh sach da sap theo mtime, file moi thang
    return chosen, rejected


def command_snippet(_: argparse.Namespace) -> int:
    categories = load_categories()
    identifiers = json.dumps([entry["id"] for entry in categories])
    print(SNIPPET.replace("@@CATS@@", identifiers).strip())
    print()
    print(
        f"# {len(categories)} category: " + ", ".join(entry["id"] for entry in categories),
        file=sys.stderr,
    )
    print(
        "# Dan doan tren vao Console (F12) cua tab inside.mastige.vn da dang nhap.",
        file=sys.stderr,
    )
    return 0


def command_merge(args: argparse.Namespace) -> int:
    categories = load_categories()
    database = args.database.resolve()
    if not database.is_file():
        print(f"Database does not exist: {database}", file=sys.stderr)
        return 2

    chosen, rejected = newest_export_per_category(args.downloads, args.since_minutes)
    backup = args.backup.resolve() if args.backup else None

    merged: list[dict[str, object]] = []
    missing: list[dict[str, str]] = []
    for entry in categories:
        source = chosen.get(entry["id"])
        if source is None:
            missing.append(entry)
            continue
        result = merge_workbook(source, database, entry["id"], entry["name"], backup)
        backup = None  # chi sao luu mot lan cho ca luot chay
        merged.append(
            {
                "category_id": entry["id"],
                "category_name": entry["name"],
                "file": source.name,
                "inserted": result["inserted"],
                "category_rows": result["category_rows"],
                "total_rows": result["total_rows"],
            }
        )

    report = {
        "database": str(database),
        "downloads": str(args.downloads),
        "window_minutes": args.since_minutes,
        "merged": merged,
        "inserted_total": sum(int(item["inserted"]) for item in merged),
        "total_rows": merged[-1]["total_rows"] if merged else None,
        "missing": missing,
        "ignored_files": rejected,
    }
    if missing:
        report["next_step"] = "chay lai snippet cho cac category con thieu"
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if missing else 0


def command_sync(args: argparse.Namespace) -> int:
    script = Path(__file__).with_name("sync_sku_to_supabase.py")
    command = [sys.executable, str(script), "--database", str(args.database)]
    if args.dry_run:
        command.append("--dry-run")
    return subprocess.call(command)


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("snippet", help="In doan JS de dan vao Console").set_defaults(
        handler=command_snippet
    )

    merge = subparsers.add_parser("merge", help="Nap cac file vua tai vao sku.db")
    merge.add_argument("--database", "-d", type=Path, default=DEFAULT_DATABASE)
    merge.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    merge.add_argument(
        "--since-minutes",
        type=int,
        default=180,
        help="Chi nhan file tai trong khoang thoi gian nay (mac dinh 180 phut)",
    )
    merge.add_argument("--backup", type=Path, help="Sao luu sku.db truoc khi nap")
    merge.set_defaults(handler=command_merge)

    sync = subparsers.add_parser("sync", help="Day sku.db len Supabase")
    sync.add_argument("--database", "-d", type=Path, default=DEFAULT_DATABASE)
    sync.add_argument("--dry-run", action="store_true")
    sync.set_defaults(handler=command_sync)

    args = parser.parse_args()
    raise SystemExit(args.handler(args))


if __name__ == "__main__":
    main()
