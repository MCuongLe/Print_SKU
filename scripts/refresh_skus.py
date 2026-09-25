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
import hashlib
import json
import sqlite3
import subprocess
import sys
import time
from contextlib import closing
from datetime import datetime, timedelta
from pathlib import Path

from apply_sku_rows import apply_rows
from inspect_export_category import inspect
from merge_sku_category_xlsx import merge_workbook


CONFIG_PATH = Path(__file__).with_name("sku_categories.json")
EXPORT_GLOB = "hasaki-product-all-sku-cate-*.xlsx"
CHANGES_GLOB = "sku-changes-*.json"
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


def exports_by_category(
    downloads: Path, minutes: int
) -> tuple[dict[str, list[Path]], list[dict[str, object]]]:
    """Group export files by category (cu truoc, moi sau), plus the files we refused.

    Inside kich hoat tai hai lan moi cu bam nen mot category thuong co nhieu file
    trung nhau; giu ca nhom de `--cleanup` don duoc het.
    """
    cutoff = time.time() - minutes * 60
    candidates = sorted(
        (path for path in downloads.glob(EXPORT_GLOB) if path.stat().st_mtime >= cutoff),
        key=lambda path: path.stat().st_mtime,
    )
    groups: dict[str, list[Path]] = {}
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
        groups.setdefault(found[0]["category_id"], []).append(path)
    return groups, rejected


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


# Doan JS doc THANG bang danh sach cua Inside, khong qua may chu export.
# Trang danh sach sap theo Modified giam dan, nen chi can doc tu tren xuong toi
# khi cham dong cu hon moc cat la du. Ten san pham nam trong the <a> cua o
# Product Name; chu dung truoc the do la ten thuong hieu, KHONG duoc lay.
QUICK_SNIPPET = r"""
(async () => {
  const CATS = @@CATS@@;
  const MOC = "@@CUTOFF@@";          // chi lay dong sua tu ngay nay tro di
  const MOI_LAN = 200;
  const TOI_DA_TRANG = 40;
  const log = (m) => console.log("%c[SKU]", "color:#0a7", m);
  if (!document.getElementById("download-products")) { log("CHUA DANG NHAP"); return; }

  const doc1Trang = async (id, trang) => {
    const url = "/sales/product?kw=&category_id=" + id +
      "&barcode=0&status=1&type=0&pushweb=&config=&stocking_status=0&hide_kw=" +
      "&limit=" + MOI_LAN + "&page=" + trang;
    const doc = new DOMParser().parseFromString(
      await (await fetch(url, { credentials: "include" })).text(), "text/html");
    const heads = [...doc.querySelectorAll("table thead th")].map((t) => t.textContent.trim().toLowerCase());
    const need = { sku: "sku", product_name: "product name", status: "status",
                   barcode: "barcode", latest_cost: "latestcost",
                   product_average_cost: "average cost", price: "price", modified: "modified" };
    const idx = {};
    for (const [key, label] of Object.entries(need)) {
      idx[key] = heads.indexOf(label);
      if (idx[key] < 0 && ["sku", "product_name", "status", "modified"].includes(key)) {
        throw new Error("Inside doi ten cot: khong thay '" + label + "'");
      }
    }
    return [...doc.querySelectorAll("table tbody tr")].map((tr) => {
      const td = tr.querySelectorAll("td");
      const o = td[idx.product_name];
      const link = o && o.querySelector("a");        // ten that nam trong the <a>
      const lay = (k) => (idx[k] >= 0 ? (td[idx[k]]?.textContent || "").trim() : "");
      return {
        sku: lay("sku"),
        product_name: link ? link.textContent.trim() : "",
        status: lay("status"),
        barcode: lay("barcode"),
        latest_cost: lay("latest_cost"),
        product_average_cost: lay("product_average_cost"),
        price: lay("price"),
        modified: lay("modified")
      };
    }).filter((r) => r.sku && r.product_name);
  };

  const ketQua = [];
  for (const cat of CATS) {
    let lay = 0;
    for (let trang = 1; trang <= TOI_DA_TRANG; trang++) {
      const rows = await doc1Trang(cat.id, trang);
      if (!rows.length) break;
      const moi = rows.filter((r) => r.modified >= MOC);
      for (const r of moi) ketQua.push({ ...r, category_id: cat.id, category_name: cat.name });
      lay += moi.length;
      if (moi.length < rows.length) break;           // da cham vung cu hon moc cat
    }
    log("category " + cat.id + ": " + lay + " dong thay doi");
  }

  const payload = { generatedAt: new Date().toISOString(), cutoff: MOC,
                    categories: CATS.map((c) => c.id), rows: ketQua };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sku-changes-" + Date.now() + ".json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  log("XONG - " + ketQua.length + " dong. Buoc tiep: python scripts/refresh_skus.py apply");
})();
"""


def command_quick(args: argparse.Namespace) -> int:
    categories = load_categories()
    cutoff = (datetime.now() - timedelta(days=args.days)).strftime("%y-%m-%d")
    snippet = (QUICK_SNIPPET
               .replace("@@CATS@@", json.dumps(categories, ensure_ascii=False))
               .replace("@@CUTOFF@@", cutoff))
    print(snippet.strip())
    print()
    print(f"# Lay cac dong sua tu {cutoff} tro di, {len(categories)} category.", file=sys.stderr)
    print("# Dan vao Console (F12) cua tab inside.mastige.vn da dang nhap.", file=sys.stderr)
    return 0


def command_apply(args: argparse.Namespace) -> int:
    database = args.database.resolve()
    if not database.is_file():
        print(f"Database does not exist: {database}", file=sys.stderr)
        return 2
    cutoff = time.time() - args.since_minutes * 60
    files = sorted(
        (path for path in args.downloads.glob(CHANGES_GLOB) if path.stat().st_mtime >= cutoff),
        key=lambda path: path.stat().st_mtime,
    )
    if not files:
        print(json.dumps({"error": "Khong thay file sku-changes-*.json moi trong Downloads",
                          "downloads": str(args.downloads)}, ensure_ascii=False, indent=2))
        return 1
    source = files[-1]
    content = source.read_bytes()
    payload = json.loads(content.decode("utf-8"))
    rows = payload.get("rows") or []
    if not rows:
        report = {"file": source.name, "rows_read": 0,
                  "note": "khong co dong nao thay doi"}
    else:
        report = apply_rows(database, rows, force=args.force)
        report["file"] = source.name
        report["cutoff"] = payload.get("cutoff")
    record_pending_json(database, source.name, hashlib.sha256(content).hexdigest())
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def record_pending_json(database: Path, name: str, digest: str) -> None:
    """Remember a successfully applied file until Supabase sync completes."""
    with closing(sqlite3.connect(database)) as connection:
        with connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS pending_sku_json "
                "(file_name TEXT PRIMARY KEY, sha256 TEXT NOT NULL)"
            )
            connection.execute(
                "INSERT OR REPLACE INTO pending_sku_json VALUES (?, ?)", (name, digest)
            )


def cleanup_synced_json(database: Path, downloads: Path) -> dict[str, object]:
    """Delete only applied JSON files whose contents have not changed."""
    result: dict[str, object] = {"deleted": [], "skipped": []}
    with closing(sqlite3.connect(database)) as connection:
        table = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='pending_sku_json'"
        ).fetchone()
        if not table:
            return result
        with connection:
            pending = connection.execute(
                "SELECT file_name, sha256 FROM pending_sku_json"
            ).fetchall()
            root = downloads.resolve()
            for name, digest in pending:
                path = root / name
                if (path.parent != root or path.is_symlink()
                        or not path.name.startswith("sku-changes-") or path.suffix != ".json"):
                    result["skipped"].append({"file": name, "reason": "invalid path"})
                    continue
                if not path.is_file():
                    result["skipped"].append({"file": name, "reason": "file missing"})
                    connection.execute("DELETE FROM pending_sku_json WHERE file_name = ?", (name,))
                    continue
                try:
                    current_digest = hashlib.sha256(path.read_bytes()).hexdigest()
                except OSError as error:
                    result["skipped"].append({"file": name, "reason": str(error)})
                    continue
                if current_digest != digest:
                    result["skipped"].append({"file": name, "reason": "file changed"})
                    continue
                try:
                    path.unlink()
                except OSError as error:
                    result["skipped"].append({"file": name, "reason": str(error)})
                    continue
                connection.execute("DELETE FROM pending_sku_json WHERE file_name = ?", (name,))
                result["deleted"].append(name)
    return result


def command_merge(args: argparse.Namespace) -> int:
    categories = load_categories()
    database = args.database.resolve()
    if not database.is_file():
        print(f"Database does not exist: {database}", file=sys.stderr)
        return 2

    groups, rejected = exports_by_category(args.downloads, args.since_minutes)
    backup = args.backup.resolve() if args.backup else None

    merged: list[dict[str, object]] = []
    missing: list[dict[str, str]] = []
    used_files: list[Path] = []
    for entry in categories:
        files = groups.get(entry["id"])
        if not files:
            missing.append(entry)
            continue
        source = files[-1]  # file moi nhat cua category nay
        result = merge_workbook(
            source, database, entry["id"], entry["name"], backup, not args.no_update
        )
        backup = None  # chi sao luu mot lan cho ca luot chay
        used_files.extend(files)
        merged.append(
            {
                "category_id": entry["id"],
                "category_name": entry["name"],
                "file": source.name,
                "duplicates": len(files) - 1,
                "inserted": result["inserted"],
                "updated": result["updated"],
                "changed_fields": result["changed_fields"],
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
        "updated_total": sum(int(item["updated"]) for item in merged),
        "total_rows": merged[-1]["total_rows"] if merged else None,
        "missing": missing,
        "ignored_files": rejected,
    }
    if missing:
        report["next_step"] = "chay lai snippet cho cac category con thieu"
    if args.cleanup:
        # Chi xoa file cua nhung category da nap xong; file la, file nhieu category
        # va file cua category chua nap deu giu nguyen.
        deleted: list[str] = []
        freed = 0
        failures: list[dict[str, str]] = []
        for path in used_files:
            try:
                size = path.stat().st_size
                path.unlink()
            except OSError as error:
                failures.append({"file": path.name, "reason": str(error)})
                continue
            deleted.append(path.name)
            freed += size
        report["cleanup"] = {
            "deleted": len(deleted),
            "freed_bytes": freed,
            "files": deleted,
            "failed": failures,
        }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if missing else 0


def command_sync(args: argparse.Namespace) -> int:
    script = Path(__file__).with_name("sync_sku_to_supabase.py")
    command = [sys.executable, str(script), "--database", str(args.database)]
    if args.dry_run:
        command.append("--dry-run")
    status = subprocess.call(command)
    if status == 0 and not args.dry_run:
        print(json.dumps({"json_cleanup": cleanup_synced_json(args.database, args.downloads)},
                         ensure_ascii=False, indent=2))
    return status


def main() -> None:
    # Keep Vietnamese output valid in Windows consoles and redirected reports.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")

    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("snippet", help="In doan JS de dan vao Console").set_defaults(
        handler=command_snippet
    )

    quick = subparsers.add_parser("quick", help="In doan JS doc thang tu Inside, khong can Excel")
    quick.add_argument("--days", type=int, default=7,
                       help="Lay cac dong sua trong bao nhieu ngay gan day (mac dinh 7)")
    quick.set_defaults(handler=command_quick)

    apply_cmd = subparsers.add_parser("apply", help="Nap file sku-changes-*.json vao sku.db")
    apply_cmd.add_argument("--database", "-d", type=Path, default=DEFAULT_DATABASE)
    apply_cmd.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    apply_cmd.add_argument("--since-minutes", type=int, default=60)
    apply_cmd.add_argument("--force", action="store_true",
                           help="Bo qua cau dao doi ten hang loat (chi dung khi da kiem tra tan mat)")
    apply_cmd.set_defaults(handler=command_apply)

    merge = subparsers.add_parser("merge", help="Nap cac file Excel (doi chieu toan bo)")
    merge.add_argument("--database", "-d", type=Path, default=DEFAULT_DATABASE)
    merge.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    merge.add_argument(
        "--since-minutes",
        type=int,
        default=180,
        help="Chi nhan file tai trong khoang thoi gian nay (mac dinh 180 phut)",
    )
    merge.add_argument("--backup", type=Path, help="Sao luu sku.db truoc khi nap")
    merge.add_argument(
        "--no-update",
        action="store_true",
        help="Chi them SKU moi, khong cap nhat ten/trang thai/category cua SKU da co",
    )
    merge.add_argument(
        "--cleanup",
        action="store_true",
        help="Xoa cac file export cua category da nap xong (ke ca ban trung)",
    )
    merge.set_defaults(handler=command_merge)

    sync = subparsers.add_parser("sync", help="Day sku.db len Supabase")
    sync.add_argument("--database", "-d", type=Path, default=DEFAULT_DATABASE)
    sync.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    sync.add_argument("--dry-run", action="store_true")
    sync.set_defaults(handler=command_sync)

    args = parser.parse_args()
    raise SystemExit(args.handler(args))


if __name__ == "__main__":
    main()
