#!/usr/bin/env python3
"""Lấy danh sách Group UID từ HASAKI WMS về JSON, để khảo sát trước khi dựng database.

Ba điều đã đo trên máy thật ngày 22/09/2026, đừng mất công thử lại:

1. WMS là SPA. `fetch` thẳng URL trả HTTP 200 nhưng vỏ HTML rỗng (0 cột, 0 dòng);
   dữ liệu do JavaScript nạp rồi mới dựng bảng. Không đọc được như Mastige Inside.
2. API riêng của WMS đã được bảo mật — chủ hệ thống chốt không dùng.
3. Nạp từng trang vào iframe KHÔNG chạy được: quá 4 phút vẫn chưa dựng xong một
   trang. Phải chạy ngay trong tab thật.

Nên cách duy nhất còn lại: script chạy trong trang, bấm phân trang Ant Design
(`li.ant-pagination-next`) để SPA tự đổi trang mà không tải lại — nhờ đó script
không bị mất — rồi gom dữ liệu và tải về một file JSON.

Bảng bị tách làm hai: bảng đầu chỉ có 21 tiêu đề và `tbody` RỖNG, bảng sau chỉ
có dòng dữ liệu và không có tiêu đề. Phải đọc tiêu đề ở bảng đầu, dữ liệu ở bảng
sau, khớp nhau theo chỉ số cột.

    python scripts/wms_group_uid.py snippet    # in đoạn JS dán vào Console tab WMS
    python scripts/wms_group_uid.py inspect    # đọc file JSON vừa tải, báo cấu trúc dữ liệu
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

DEFAULT_DOWNLOADS = Path.home() / "Downloads"
SNAPSHOT_GLOB = "wms-group-uid-*.json"

# Ánh xạ theo TÊN tiêu đề chứ không theo vị trí: WMS đổi thứ tự cột thì vẫn đúng,
# đổi tên cột thì báo lỗi rõ ràng chứ không âm thầm lấy sai cột.
COLUMNS = [
    "Group UID code",
    "Batch code",
    "Roll code",
    "Type",
    "Warehouse",
    "Location",
    "Product",
    "Total SKU",
    "Total product",
    "Status",
]
KEY_COLUMN = "Group UID code"

SNIPPET = r"""
(async () => {
  const COT = @@COLUMNS@@;
  const KHOA = "@@KEY@@";
  const TOI_DA_TRANG = @@MAX_PAGES@@;
  const log = (m) => console.log("%c[WMS]", "color:#0a7", m);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (!location.hostname.includes("inshasaki.com")) {
    log("Hay chay tren tab wms.inshasaki.com dang mo danh sach Group UID.");
    return;
  }

  // Bang bi tach: bang co thead thi tbody rong, bang co du lieu thi khong co thead.
  const bangTieuDe = () => [...document.querySelectorAll("table")]
    .find((t) => t.querySelectorAll("thead th").length > 5);
  const bangDuLieu = () => [...document.querySelectorAll("table")]
    .find((t) => t.querySelectorAll("tbody tr").length > 0);

  const bt = bangTieuDe();
  if (!bt) { log("Khong thay bang tieu de. Dang o dung trang danh sach Group UID chua?"); return; }
  const heads = [...bt.querySelectorAll("thead th")].map((t) => t.textContent.trim());
  const idx = {};
  const thieu = [];
  for (const c of COT) { idx[c] = heads.indexOf(c); if (idx[c] < 0) thieu.push(c); }
  if (thieu.length) { log("WMS doi ten cot, khong thay: " + thieu.join(", ")); return; }

  const docTrang = () => {
    const tb = bangDuLieu();
    if (!tb) return [];
    return [...tb.querySelectorAll("tbody tr")].map((tr) => {
      const td = tr.querySelectorAll("td");
      if (td.length !== heads.length) return null;      // bo dong dem/spacer
      const o = {};
      for (const c of COT) o[c] = (td[idx[c]]?.textContent || "").replace(/\s+/g, " ").trim();
      return o;
    }).filter((o) => o && o[KHOA]);
  };

  // Cho bang dung xong: so dong phai giu nguyen 3 nhip lien tiep moi tinh la on dinh.
  const choOnDinh = async () => {
    let truoc = -1, on = 0;
    for (let i = 0; i < 360; i++) {
      const n = bangDuLieu()?.querySelectorAll("tbody tr").length || 0;
      if (n > 0 && n === truoc) { on += 1; if (on >= 3) return n; } else on = 0;
      truoc = n;
      await sleep(500);
    }
    return truoc;
  };

  const nutSau = () => document.querySelector("li.ant-pagination-next");
  const hetTrang = () => {
    const n = nutSau();
    return !n || n.classList.contains("ant-pagination-disabled") ||
           n.getAttribute("aria-disabled") === "true";
  };

  const tatCa = [];
  const daThay = new Set();
  for (let trang = 1; trang <= TOI_DA_TRANG; trang++) {
    await choOnDinh();
    const rows = docTrang();
    if (!rows.length) { log("trang " + trang + ": khong doc duoc dong nao, dung"); break; }
    let moi = 0;
    for (const r of rows) {
      const k = r[KHOA];
      if (daThay.has(k)) continue;
      daThay.add(k);
      tatCa.push(r);
      moi += 1;
    }
    log("trang " + trang + ": " + rows.length + " dong, " + moi + " moi (tong " + tatCa.length + ")");
    if (!moi) { log("khong co dong moi nao, dung"); break; }
    if (hetTrang()) { log("het trang"); break; }

    const dauTruoc = rows[0][KHOA];
    const n = nutSau();
    (n.querySelector("button") || n).click();
    // Cho SPA doi trang: dong dau phai khac dong dau cua trang truoc.
    let doi = false;
    for (let i = 0; i < 360; i++) {
      const r0 = docTrang()[0];
      if (r0 && r0[KHOA] !== dauTruoc) { doi = true; break; }
      await sleep(500);
    }
    if (!doi) { log("bam sang trang sau nhung du lieu khong doi, dung"); break; }
  }

  const payload = {
    source: "wms.inshasaki.com/inventory/group-uid/list",
    pageUrl: location.href.split("?")[0],
    generatedAt: new Date().toISOString(),
    headers: heads,
    rows: tatCa
  };
  // Giu du lieu tren window TRUOC KHI tai: chay het 8.000 dong mat gan 20 phut,
  // tai that bai ma khong giu lai thi mat trang cong (da bi mot lan).
  window.__wmsPayload = payload;

  const taiVe = () => {
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "wms-group-uid-" + Date.now() + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  };
  taiVe();     // thu tai ngay; chay ngan thi an

  // Chrome chi cho tai tu dong khi con "user activation". Chay lau thi quyen do
  // het han va a.click() bi chan im lang, nen luon dung san mot nut that.
  const nut = document.createElement("button");
  nut.textContent = "Tai file JSON (" + tatCa.length + " Group UID)";
  nut.style.cssText = "position:fixed;z-index:2147483647;right:24px;bottom:24px;padding:16px 22px;" +
    "font:700 16px Arial;background:#005F41;color:#fff;border:0;border-radius:8px;cursor:pointer;" +
    "box-shadow:0 6px 24px rgba(0,0,0,.35)";
  nut.onclick = () => { taiVe(); nut.textContent = "Da tai - bam lai neu can"; };
  document.body.appendChild(nut);

  log("XONG - " + tatCa.length + " Group UID.");
  log("Neu Downloads chua co file, bam nut xanh goc duoi ben phai.");
  log("Buoc tiep: python scripts/wms_group_uid.py inspect");
})();
"""


def command_snippet(args: argparse.Namespace) -> int:
    snippet = (
        SNIPPET.replace("@@COLUMNS@@", json.dumps(COLUMNS, ensure_ascii=False))
        .replace("@@KEY@@", KEY_COLUMN)
        .replace("@@MAX_PAGES@@", str(args.max_pages))
    )
    print(snippet.strip())
    print()
    print(f"# Toi da {args.max_pages} trang.", file=sys.stderr)
    print(
        "# Mo tab wms.inshasaki.com o danh sach Group UID voi size mong muon "
        "(vd &size=1000 cho 9 trang), roi dan doan tren vao Console (F12).",
        file=sys.stderr,
    )
    return 0


def command_inspect(args: argparse.Namespace) -> int:
    cutoff = time.time() - args.since_minutes * 60
    files = sorted(
        (p for p in args.downloads.glob(SNAPSHOT_GLOB) if p.stat().st_mtime >= cutoff),
        key=lambda p: p.stat().st_mtime,
    )
    if not files:
        print(f"Khong thay file {SNAPSHOT_GLOB} moi trong {args.downloads}", file=sys.stderr)
        return 1
    source = files[-1]
    payload = json.loads(source.read_text(encoding="utf-8"))
    rows = payload.get("rows") or []
    if not rows:
        print(json.dumps({"file": source.name, "rows": 0}, ensure_ascii=False, indent=2))
        return 0

    report: dict[str, object] = {
        "file": source.name,
        "generatedAt": payload.get("generatedAt"),
        "rows": len(rows),
        "columns_on_page": payload.get("headers"),
    }

    fields = []
    for key in rows[0].keys():
        values = [str(row.get(key, "") or "").strip() for row in rows]
        filled = [v for v in values if v]
        numeric = (
            all(v.replace(".", "").replace(",", "").isdigit() for v in filled) if filled else False
        )
        fields.append(
            {
                "column": key,
                "filled": f"{len(filled)}/{len(values)}",
                "distinct": len(set(filled)),
                "max_len": max((len(v) for v in filled), default=0),
                "looks_numeric": numeric,
                "samples": [v for v, _ in Counter(filled).most_common(3)],
            }
        )
    report["fields"] = fields

    codes = [str(row.get(KEY_COLUMN, "")).strip() for row in rows]
    duplicates = [code for code, count in Counter(codes).items() if count > 1]
    report["duplicate_keys"] = len(duplicates)
    if duplicates:
        report["duplicate_samples"] = duplicates[:5]
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    snippet = subparsers.add_parser("snippet", help="In doan JS de dan vao Console tab WMS")
    snippet.add_argument("--max-pages", type=int, default=200, help="Tran so trang (mac dinh 200)")
    snippet.set_defaults(handler=command_snippet)

    inspect_cmd = subparsers.add_parser(
        "inspect", help="Doc file JSON vua tai, bao cau truc du lieu"
    )
    inspect_cmd.add_argument("--downloads", type=Path, default=DEFAULT_DOWNLOADS)
    inspect_cmd.add_argument("--since-minutes", type=int, default=240)
    inspect_cmd.set_defaults(handler=command_inspect)

    args = parser.parse_args()
    raise SystemExit(args.handler(args))


if __name__ == "__main__":
    main()
