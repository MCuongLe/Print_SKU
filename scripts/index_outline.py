"""Mục lục khối của index.html: loại, id, dòng đầu–cuối, kích thước — để tìm khối nhanh thay vì grep mò.

index.html là trang một tệp (~2,5 MB, ~17.000 dòng): mỗi module = <style id> + <section id> + <script id>.
Số dòng đổi liên tục nên mục lục KHÔNG lưu vào repo; chạy lại khi cần (dưới 1 giây).

  python scripts/index_outline.py                 # mọi khối style/script + section có id
  python scripts/index_outline.py uid-block       # chỉ khối có id/nhãn chứa chuỗi (không phân biệt hoa thường)
  python scripts/index_outline.py --big 40        # chỉ khối ≥ 40 KB
  python scripts/index_outline.py --no-id         # chỉ khối style/script chưa có id
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OPEN = re.compile(r"<(style|script|section)\b([^>]*)>", re.I)
ID = re.compile(r"""\bid\s*=\s*["']([^"']+)["']""")
SRC = re.compile(r"""\bsrc\s*=\s*["']([^"']+)["']""")


def label_for(body):
    """Khối không id: lấy dòng chú thích đầu tiên (// hoặc /* */) làm nhãn, không có thì 'dòng minified'."""
    for raw in body.splitlines()[:6]:
        line = raw.strip()
        m = re.match(r"(?://|/\*+)\s*(.+?)\s*(?:\*/)?$", line)
        if m and m.group(1):
            return m.group(1)[:70]
        if len(line) > 400:
            return "(dòng minified)"
    return ""


SECTION_SCAN = re.compile(r"<(/?)(section|script|style)\b[^>]*>", re.I)


def _section_end(text, start):
    """Vị trí ngay sau </section> khớp với thẻ mở (đếm section lồng nhau, bỏ qua thân script/style)."""
    depth, pos = 1, start
    while True:
        m = SECTION_SCAN.search(text, pos)
        if not m:
            return -1
        closing, tag = m.group(1), m.group(2).lower()
        if tag in ("script", "style"):
            if closing:
                pos = m.end()
                continue
            close = text.find(f"</{tag}>", m.end())
            if close < 0:
                return -1
            pos = close + len(tag) + 3
            continue
        depth += -1 if closing else 1
        pos = m.end()
        if depth == 0:
            return m.end()


def outline(text):
    # Quét tuần tự: chuỗi "<script"/"<style" nằm TRONG thân một khối script (vd. bundle React) không được tính là khối mới.
    rows, pos = [], 0
    while True:
        m = OPEN.search(text, pos)
        if not m:
            break
        tag, attrs = m.group(1).lower(), m.group(2)
        ident = ID.search(attrs)
        if tag == "section":
            pos = m.end()
            if not ident:
                continue
            end_pos = _section_end(text, m.end())
            if end_pos < 0:
                continue
        else:
            close = text.find(f"</{tag}>", m.end())
            if close < 0:
                break
            end_pos = close + len(tag) + 3
            pos = end_pos
        start_line = text.count("\n", 0, m.start()) + 1
        end_line = text.count("\n", 0, end_pos) + 1
        src = SRC.search(attrs)
        name = ident.group(1) if ident else (f"src={src.group(1)}" if src else "")
        hint = "" if ident or src or tag == "section" else label_for(text[m.end():end_pos])
        rows.append({"tag": tag, "id": name, "hint": hint, "start": start_line, "end": end_line,
                     "kb": (end_pos - m.start()) / 1024, "max_line": max((len(l) for l in text[m.start():end_pos].splitlines()), default=0)})
    return rows


def main():
    ap = argparse.ArgumentParser(description="Mục lục khối index.html")
    ap.add_argument("filter", nargs="?", default="", help="chuỗi lọc theo id / nhãn")
    ap.add_argument("--big", type=float, default=0, help="chỉ khối có kích thước ≥ N KB")
    ap.add_argument("--no-id", action="store_true", help="chỉ khối style/script chưa có id")
    ap.add_argument("--file", default=str(ROOT / "index.html"))
    args = ap.parse_args()
    text = Path(args.file).read_text(encoding="utf-8")
    rows = outline(text)
    total = len(rows)
    if args.filter:
        needle = args.filter.lower()
        rows = [r for r in rows if needle in r["id"].lower() or needle in r["hint"].lower()]
    if args.big:
        rows = [r for r in rows if r["kb"] >= args.big]
    if args.no_id:
        rows = [r for r in rows if r["tag"] != "section" and not r["id"]]
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"index.html: {text.count(chr(10)) + 1} dòng, {len(text.encode('utf-8')) / 1048576:.2f} MB, {total} khối — hiện {len(rows)}")
    print(f"{'loại':<8}{'dòng':>13}  {'KB':>6}  id / nhãn")
    for r in rows:
        mark = " ⚠ dòng dài" if r["max_line"] > 2000 else ""
        name = r["id"] or f"(không id) {r['hint']}".rstrip()
        print(f"{r['tag']:<8}{r['start']:>6}–{r['end']:<6}  {r['kb']:>6.1f}  {name}{mark}")


if __name__ == "__main__":
    main()
