#!/usr/bin/env python3
"""Phát hành bằng một lệnh: migration → Edge → Reload Extension → push, có cổng xác nhận (mô hình A, 26/10/2026).

    python scripts/release.py                 # = --plan: chỉ đọc, in việc chờ theo thứ tự cố định
    python scripts/release.py --plan   [--only migrations|edge] [--rerun <tệp.sql>]
    python scripts/release.py --apply  [--only migrations|edge] [--rerun <tệp.sql>]
    python scripts/release.py --status        # sổ release_ledger + khoá phát hành + tệp đã sửa sau khi chạy
    python scripts/release.py --init          # một lần: tạo sổ, ghi nhận migration + Edge đang chạy (gõ SEED)
    python scripts/release.py --accept <tệp.sql>   # ghi nhận tệp đã sửa sau khi chạy là đã lên, KHÔNG chạy SQL (gõ tên tệp)

Hợp đồng: docs/plans/2026-10-26-release-script.md. Token và project ref như scripts/apply_supabase_sql.py
(SUPABASE_ACCESS_TOKEN ở biến môi trường hoặc .env; SUPABASE_URL hoặc --project-ref). Script không in token.
Thoát: 0 xong / không có việc; 1 dừng vì lỗi hoặc người dùng từ chối; 2 cần terminal thật hoặc cờ sai; 3 preflight không đạt.
Không có cờ --yes: --apply / --init / --accept chỉ chạy trên terminal thật, mỗi cổng gõ y; tệp có DROP / DELETE / TRUNCATE
(kể cả trong khối DO) gõ nguyên tên tệp.
Tệp migration đã sửa sau khi chạy (sha ở HEAD khác sổ) CHẶN --apply (mã 3, mọi --only, trước mọi cổng; người dùng chốt
26/10/2026): chạy lại bằng --rerun <tệp> nếu SQL đổi, hoặc --accept <tệp> nếu chỉ sửa chú thích (--accept chỉ ghi sổ).
Nguồn đọc bằng git show <HEAD>:<đường dẫn>, cây làm việc phải sạch. Sổ ghi SAU khi xác minh đạt.
Biên bản (ngoài git): outputs/release/release-<yyyymmdd-hhmm>.md.
"""
from __future__ import annotations

import argparse
import datetime as dt
import difflib
import hashlib
import http.client
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent))
import apply_supabase_sql as supa  # noqa: E402  (token, project ref, run_query, câu phá huỷ)
import live_status as live  # noqa: E402  (thứ tự migration, đối tượng phải có, STATUS_SQL, select_only, Edge)

ROOT = Path(__file__).resolve().parents[1]
VN = live.VN
# Thứ tự cố định (AGENTS luật 4). Đổi thứ tự ở đây là đổi luật: test đột biến "push trước migration" bắt.
STAGES = ("migration", "edge", "extension", "push")
LOCK_MINUTES = 30
MIN_LITERAL = 14
CLOCK_SLACK_MS = 60_000          # lệch đồng hồ máy ↔ Supabase cho phép khi so updated_at với lúc bắt đầu deploy
EXT_NAME = "inside-po-connector"
MANIFEST = "extension/inside-po-connector/manifest.json"
AGENT_VERSION = "workstation-agent/VERSION"
LEDGER_FILE = "release_ledger_v1.sql"
CODE_SUFFIXES = (".js", ".ts", ".html", ".sql", ".cjs", ".py", ".mjs")
STAGE_LABELS = {"migration": "migration", "edge": "Edge", "extension": "Extension", "push": "push"}
DEFINER = re.compile(r"\bsecurity\s+definer\b", re.I)
RELOAD_CHECKLIST = (
    "1. Trên từng máy Admin đang đồng bộ: mở chrome://extensions, bấm Reload ở Inside PO Connector.",
    "2. Kiểm số bản hiện {version}.",
    "3. Tải lại (F5) mọi tab Inside / WMS đang mở.",
    "4. Mở trang Options của Extension: thẻ Trạng thái không đỏ.",
)

LEDGER_EXISTS_SQL = "select to_regclass('public.release_ledger') is not null as ok"
LEDGER_SQL = ("select kind, name, sha256, commit_sha, applied_at, applied_by, note "
              "from public.release_ledger order by kind, name")
LOCK_READ_SQL = "select applied_by, applied_at from public.release_ledger where kind = 'lock' and name = 'release'"


class Stop(Exception):
    """Dừng có chủ đích: mã thoát + câu báo tiếng Việt; `title` = một dòng thật cho biên bản (không phải dòng trang trí)."""

    def __init__(self, code: int, message: str, title: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.title = title


class ApiError(Exception):
    """Lỗi gọi Supabase / Management API (không chứa token).

    unknown=True: KHÔNG biết máy chủ đã ghi hay chưa (mất mạng, hết giờ, HTTP ≥ 500 hoặc 408, phản hồi hỏng);
    unknown=False: máy chủ từ chối rõ ràng (HTTP 4xx) — chắc chắn chưa ghi.
    """

    def __init__(self, message: str, unknown: bool = False):
        super().__init__(message)
        self.unknown = unknown


def http_unknown(status: int) -> bool:
    return status >= 500 or status == 408


def api_error(message, token: str) -> ApiError:
    """SystemExit của apply_supabase_sql / live_status → ApiError; chỉ HTTP 4xx (trừ 408) là bị từ chối rõ ràng."""
    text = redact(message, token)
    status = re.search(r"HTTP (\d{3})", text)
    return ApiError(text, unknown=not status or http_unknown(int(status.group(1))))


def first_line(text: str) -> str:
    """Dòng đầu có chữ (bỏ dòng trang trí toàn dấu !)."""
    return next((line.strip() for line in text.splitlines() if line.strip().strip("!")), "")


# ===================================================================== hàm thuần
def content_sha(data: bytes | str) -> str:
    """sha256 hex của nội dung sau khi đổi CRLF → LF (cùng nội dung, khác kiểu xuống dòng → cùng hash)."""
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()


def short(value: str | None, size: int = 12) -> str:
    return (value or "—")[:size]


def redact(text: object, token: str) -> str:
    text = str(text)
    if token and len(token) >= 6:
        text = text.replace(token, "[đã che token]")
    return text


def lit(value) -> str:
    """Hằng chuỗi SQL (nháy đơn nhân đôi); None → null."""
    if value is None:
        return "null"
    text = str(value)
    if "\x00" in text:
        raise ValueError("giá trị có ký tự NUL")
    return "'" + text.replace("'", "''") + "'"


KIEM_LINE = re.compile(r"^--\s*kiem\s*:\s*(\S.*?)\s*$", re.I)
ROLLBACK_LINE = re.compile(r"^--\s*r[uú]t\s+lui\b", re.I)
INDENTED = re.compile(r"^--(?: {2,}|\t)\s*\S")


@dataclass
class Header:
    lines: list[str]      # dòng chú thích đầu tệp (trước câu SQL đầu tiên)
    kiem: list[str]       # câu SELECT của mỗi dòng `-- kiem:`
    rollback: list[str]   # dòng `-- Rút lui` + các dòng chú thích thụt vào ngay sau


def parse_header(sql: str) -> Header:
    lines: list[str] = []
    for raw in sql.replace("\r\n", "\n").split("\n"):
        line = unicodedata.normalize("NFC", raw.strip())
        if line.startswith("--"):
            lines.append(line)
        elif line:
            break
    kiem = [match.group(1) for line in lines if (match := KIEM_LINE.match(line))]
    rollback: list[str] = []
    for index, line in enumerate(lines):
        if ROLLBACK_LINE.match(line):
            rollback.append(line)
            for follow in lines[index + 1:]:
                if not INDENTED.match(follow):
                    break
                rollback.append(follow)
            break
    return Header(lines, kiem, rollback)


# ---- tách chuỗi ký tự cho dấu vết nội dung Edge
REGEX_AFTER = {"", "{", "}", "(", ",", "=", ":", "[", "!", "&", "|", "?", ";", "+", "-", "*", "%", "<", ">", "~", "^"}
REGEX_AFTER_WORD = {"return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"}
KNOWN_WORDS = REGEX_AFTER_WORD | {"from", "import", "export", "declare", "type", "interface"}
STATEMENT_WORDS = {"const", "let", "var", "function", "async", "export", "class", "if", "for", "while", "return", "import", "type", "interface", "enum"}
IDENT = re.compile(r"[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*")
TYPE_ALIAS = re.compile(r"\s+[A-Za-z_$][\w$]*\s*(?:<[^;=]*>\s*)?=(?![=>])")
INTERFACE_NAME = re.compile(r"\s+[A-Za-z_$][\w$]*")


def _string_end(source: str, start: int) -> tuple[int, bool]:
    """Chuỗi '…' / "…" bắt đầu ở `start`: (vị trí sau dấu đóng | -1 khi chưa đóng trên dòng, có nối dòng bằng \\)."""
    quote, j, n, joined = source[start], start + 1, len(source), False
    while j < n:
        ch = source[j]
        if ch == "\\":
            if source[j + 1:j + 2] in ("\n", "\r", "\u2028", "\u2029"):
                joined = True
            j += 3 if source[j + 1:j + 3] == "\r\n" else 2
            continue
        if ch == quote:
            return j + 1, joined
        if ch in "\r\n":
            return -1, joined
        j += 1
    return -1, joined


def _template_tail(source: str, j: int) -> tuple[int, str]:
    """Quét thân template từ `j`: (sau dấu ` , "end") | (sau ${ , "hole") | (-1, "") khi chưa đóng."""
    n = len(source)
    while j < n:
        ch = source[j]
        if ch == "\\":
            j += 2
            continue
        if ch == "`":
            return j + 1, "end"
        if ch == "$" and source[j + 1:j + 2] == "{":
            return j + 2, "hole"
        j += 1
    return -1, ""


def _regex_end(source: str, start: int) -> int:
    j, n, in_class = start + 1, len(source), False
    while j < n:
        ch = source[j]
        if ch == "\\":
            j += 2
            continue
        if ch in "\r\n":
            return -1
        if in_class:
            in_class = ch != "]"
        elif ch == "[":
            in_class = True
        elif ch == "/":
            j += 1
            while j < n and (source[j].isalnum() or source[j] in "_$"):
                j += 1
            return j
        j += 1
    return -1


def string_literals(source: str, min_len: int = MIN_LITERAL) -> tuple[list[str], bool]:
    """Chuỗi ký tự một dòng ('…' / "…", nguyên văn giữa hai dấu nháy, có escape) dài ≥ min_len, theo thứ tự xuất hiện.

    Bỏ qua: chú thích, thân template literal (kể cả biểu thức ${…} bên trong), regex literal, chuỗi trong khai báo
    `type` / `interface` và chỉ định import (bản biên dịch bỏ kiểu). Trả (danh sách, chắc chắn?): không chắc khi có
    chuỗi / template / chú thích / regex chưa đóng hoặc ngoặc lệch — khi đó bỏ qua dấu vết, không chặn.
    """
    found: list[str] = []
    n, i = len(source), 0
    prev = ""                       # token trước: "" | "id" | "num" | "str" | "tpl" | "kw:<từ>" | dấu
    depth = 0                       # độ sâu ngoặc nhọn
    holes: list[int] = []           # độ sâu khi mở ${ … } của template
    skip: list | None = None        # [độ sâu, "type" | "interface", đã vào khối?]
    line_start = True               # token đầu dòng (cho khai báo type không có dấu ;)
    if source.startswith("#!"):
        i = source.find("\n") if "\n" in source else n

    def enter_template(after: int, kind: str) -> int:
        nonlocal depth, prev
        if kind == "end":
            prev = "tpl"
        else:
            holes.append(depth)
            depth += 1
            prev = "{"
        return after

    while i < n:
        c = source[i]
        if c in " \t\f\v\u00a0\ufeff":
            i += 1
            continue
        if c in "\r\n":
            line_start = True
            i += 1
            continue
        at_line_start, line_start = line_start, False
        nxt = source[i + 1:i + 2]
        if c == "/" and nxt == "/":
            j = source.find("\n", i)
            i = n if j < 0 else j
            continue
        if c == "/" and nxt == "*":
            j = source.find("*/", i + 2)
            if j < 0:
                return found, False
            i = j + 2
            continue
        if c in "'\"":
            j, joined = _string_end(source, i)
            if j < 0:
                return found, False
            text = source[i + 1:j - 1]
            if not holes and skip is None and prev not in ("kw:from", "kw:import") and not joined and len(text) >= min_len:
                found.append(text)
            i, prev = j, "str"
            continue
        if c == "`":
            j, kind = _template_tail(source, i + 1)
            if j < 0:
                return found, False
            i = enter_template(j, kind)
            continue
        if c == "}":
            depth -= 1
            if holes and depth == holes[-1]:
                holes.pop()
                j, kind = _template_tail(source, i + 1)
                if j < 0:
                    return found, False
                i = enter_template(j, kind)
                continue
            if depth < 0:
                return found, False
            if skip and skip[1] == "interface" and skip[2] and depth == skip[0]:
                skip = None
            i, prev = i + 1, "}"
            continue
        if c == "{":
            if skip and skip[1] == "interface" and depth == skip[0]:
                skip[2] = True
            depth += 1
            i, prev = i + 1, "{"
            continue
        if c == "/" and (prev in REGEX_AFTER or (prev.startswith("kw:") and prev[3:] in REGEX_AFTER_WORD)):
            j = _regex_end(source, i)
            if j < 0:
                return found, False
            i, prev = j, "re"
            continue
        word = IDENT.match(source, i)
        if word:
            text = word.group(0)
            if skip and skip[1] == "type" and depth == skip[0] and at_line_start and text in STATEMENT_WORDS:
                skip = None                                   # khai báo type trước không có dấu ;
            if skip is None and (at_line_start or prev in ("", ";", "{", "}", "kw:export", "kw:declare")):
                if text == "type" and TYPE_ALIAS.match(source, word.end()):
                    skip = [depth, "type", False]
                elif text == "interface" and INTERFACE_NAME.match(source, word.end()):
                    skip = [depth, "interface", False]
            i, prev = word.end(), (f"kw:{text}" if text in KNOWN_WORDS else "id")
            continue
        if c.isdigit() or (c == "." and nxt.isdigit()):
            j = i + 1
            while j < n and (source[j].isalnum() or source[j] in "._"):
                j += 1
            i, prev = j, "num"
            continue
        if c == ";" and skip and skip[1] == "type" and depth == skip[0]:
            skip = None
        i, prev = i + 1, c
    if depth != 0 or holes:
        return found, False
    return found, True


_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}


def js_unescape(raw: str) -> str | None:
    """Giá trị của chuỗi JS từ nội dung nguyên văn; None khi escape lạ."""
    out, i, n = [], 0, len(raw)
    while i < n:
        c = raw[i]
        if c != "\\":
            out.append(c)
            i += 1
            continue
        if i + 1 >= n:
            return None
        e = raw[i + 1]
        if e in _ESCAPES:
            out.append(_ESCAPES[e])
            i += 2
        elif e == "x" and re.fullmatch(r"[0-9A-Fa-f]{2}", raw[i + 2:i + 4]):
            out.append(chr(int(raw[i + 2:i + 4], 16)))
            i += 4
        elif e == "u" and raw[i + 2:i + 3] == "{":
            end = raw.find("}", i + 3)
            if end < 0 or not re.fullmatch(r"[0-9A-Fa-f]{1,6}", raw[i + 3:end]):
                return None
            out.append(chr(int(raw[i + 3:end], 16)))
            i = end + 1
        elif e == "u" and re.fullmatch(r"[0-9A-Fa-f]{4}", raw[i + 2:i + 6]):
            out.append(chr(int(raw[i + 2:i + 6], 16)))
            i += 6
        elif e in "\r\n":
            i += 2
        else:
            out.append(e)
            i += 2
    return "".join(out)


def fingerprint(source: str, bundle: bytes | None) -> tuple[str, list[str], int]:
    """Dấu vết nội dung: mọi chuỗi một dòng ≥ 14 ký tự của nguồn HEAD phải có trong bundle (giải mã UTF-8).

    Trả ("ok" | "missing" | "unsure" | "none", chuỗi thiếu, số chuỗi). "unsure" = bộ tách không chắc hoặc không có
    bundle (cảnh báo, không chặn); "none" = nguồn không có chuỗi đủ dài.
    """
    literals, certain = string_literals(source)
    unique = list(dict.fromkeys(literals))
    if not certain or bundle is None:
        return "unsure", [], len(unique)
    if not unique:
        return "none", [], 0
    text = bundle.decode("utf-8", errors="replace")
    missing = []
    for item in unique:
        decoded = js_unescape(item)
        if item not in text and not (decoded and decoded in text):
            missing.append(item)
    return ("missing" if missing else "ok"), missing, len(unique)


DOLLAR_TAG = re.compile(r"\$([A-Za-z_]\w*)?\$")
ROUTINE_HEAD = re.compile(r"\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b", re.I)
DO_HEAD = re.compile(r"^\s*do\b", re.I)
EXTRA_DESTRUCTIVE = ((r"\bdrop\s+(materialized\s+view|sequence|extension|role|procedure|domain|publication)\b", "DROP"),)


def deep_destructive(sql: str) -> list[str]:
    """Câu phá huỷ chạy NGAY khi nạp tệp (review vòng 1, 26/10/2026; apply_supabase_sql.py giữ nguyên).

    Như apply_supabase_sql.destructive_statements nhưng chỉ gỡ thân $$…$$ của câu `create [or replace] function | procedure`
    (tính từ dấu ; trước đó); thân khối DO và các $$ khác vẫn được quét. EXECUTE trong thân DO = SQL động không đọc được
    → coi là rủi ro (fail-closed). Thêm DROP materialized view / sequence / extension / role / procedure / domain / publication.
    """
    text = supa.strip_sql_comments(sql)
    kept, do_bodies, pos = [], [], 0
    while True:
        match = DOLLAR_TAG.search(text, pos)
        end = text.find(match.group(0), match.end()) if match else -1
        if not match or end < 0:                     # hết khối $$ (hoặc $$ chưa đóng: quét nguyên phần còn lại)
            kept.append(text[pos:])
            break
        head = text[text.rfind(";", 0, match.start()) + 1:match.start()]
        body = text[match.end():end]
        kept.append(text[pos:match.start()])
        if ROUTINE_HEAD.search(head):
            kept.append(" ")
        else:
            kept.append(" " + body + " ")
            if DO_HEAD.match(head):
                do_bodies.append(body)
        pos = end + len(match.group(0))
    scan = "".join(kept).lower()
    labels = list(supa.destructive_statements(sql))
    for pattern, label in tuple(supa.DESTRUCTIVE_PATTERNS) + EXTRA_DESTRUCTIVE:
        if label not in labels and re.search(pattern, scan):
            labels.append(label)
    if any(re.search(r"\bexecute\b", body, re.I) for body in do_bodies):
        labels.append("EXECUTE động trong DO")
    return labels


def deploy_script(slug: str) -> str:
    return f"scripts/deploy_{slug.replace('-', '_')}.py"


def ms_of(value) -> int:
    """updated_at của Management API (ms, giây hoặc ISO) → ms."""
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value if value > 1e11 else value * 1000)
    if isinstance(value, str) and value.strip():
        try:
            return int(dt.datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            return 0
    return 0


def vn(value) -> str:
    try:
        return live.vn_time(value) or "—"
    except (ValueError, TypeError, OSError, OverflowError):
        return str(value)


def first_value(rows):
    if isinstance(rows, list) and rows and isinstance(rows[0], dict) and rows[0]:
        return next(iter(rows[0].values()))
    return None


# ---- câu SQL của sổ và khoá (Management API chạy bằng vai chủ bảng; ghi qua đây, không qua PostgREST)
def lock_take_sql(holder: str) -> str:
    """Lấy khoá bằng MỘT câu: chèn mới, hoặc chiếm dòng cũ chỉ khi đã quá hạn; trả applied_by khi lấy được."""
    return ("insert into public.release_ledger as l (kind, name, applied_by, note) "
            f"values ('lock', 'release', {lit(holder)}, 'release.py') "
            "on conflict (kind, name) do update set applied_at = now(), applied_by = excluded.applied_by, note = excluded.note "
            f"where l.applied_at < now() - interval '{LOCK_MINUTES} minutes' "
            "returning applied_by")


def lock_refresh_sql(holder: str) -> str:
    return (f"update public.release_ledger set applied_at = now() where kind = 'lock' and name = 'release' "
            f"and applied_by = {lit(holder)} returning applied_by")


def lock_release_sql(holder: str) -> str:
    return (f"delete from public.release_ledger where kind = 'lock' and name = 'release' "
            f"and applied_by = {lit(holder)} returning applied_by")


def upsert_sql(kind: str, name: str, sha: str | None, commit: str, holder: str, note: str | None) -> str:
    return ("insert into public.release_ledger (kind, name, sha256, commit_sha, applied_by, note) "
            f"values ({lit(kind)}, {lit(name)}, {lit(sha)}, {lit(commit)}, {lit(holder)}, {lit(note)}) "
            "on conflict (kind, name) do update set sha256 = excluded.sha256, commit_sha = excluded.commit_sha, "
            "applied_at = now(), applied_by = excluded.applied_by, note = excluded.note returning kind, name")


def seed_sql(rows: list[tuple], holder: str) -> str:
    values = ", ".join(f"({lit(kind)}, {lit(name)}, {lit(sha)}, {lit(commit)}, {lit(holder)}, {lit(note)})"
                       for kind, name, sha, commit, note in rows)
    return ("insert into public.release_ledger (kind, name, sha256, commit_sha, applied_by, note) "
            f"values {values} on conflict (kind, name) do nothing returning kind, name")


# ===================================================================== lối ra ngoài
def resolve_ref(explicit: str, env_url: str) -> str:
    """Project ref từ --project-ref hoặc SUPABASE_URL (apply_supabase_sql.project_ref); hai nguồn khác nhau → dừng."""
    try:
        ref = supa.project_ref(explicit)
    except SystemExit as error:
        raise Stop(3, str(error.code)) from None
    from_env = re.match(r"https://([a-z0-9]+)\.supabase\.(co|in)", (env_url or "").strip())
    if explicit and from_env and from_env.group(1) != explicit:
        raise Stop(3, f"--project-ref {explicit} khác project trong SUPABASE_URL ({from_env.group(1)}): kiểm lại rồi chạy lại.")
    if not re.fullmatch(r"[a-z0-9]+", ref or ""):
        raise Stop(3, f"Project ref sai dạng: {ref!r}.")
    return ref


class Ctx:
    """Mọi lối ra ngoài (git, Supabase, Management API, terminal, tiến trình con, đồng hồ, tệp) đi qua đây; test thay bằng bản giả."""

    def __init__(self) -> None:
        self.token = ""
        self.ref = ""
        self.holder = ""
        self.timeout = 120
        self.out_dir = ROOT / "outputs" / "release"
        self.report: Report | None = None
        self.blobs: dict[tuple[str, str], bytes] = {}     # git show trong một lượt (kế hoạch dựng lại sau khoá không đọc lại)
        self._order: list[str] | None = None
        try:
            tty_out = sys.stdout.isatty()
        except (AttributeError, ValueError):
            tty_out = False
        self.color = tty_out and (os.name != "nt" or "WT_SESSION" in os.environ or "TERM" in os.environ)

    # ---- terminal, đồng hồ, máy
    def isatty(self) -> bool:
        try:
            return bool(sys.stdin.isatty())
        except (AttributeError, ValueError):
            return False

    def ask(self, prompt: str) -> str:
        try:
            return input(redact(prompt, self.token))
        except EOFError:
            return ""

    def say(self, text: str = "", tone: str = "") -> None:
        clean = redact(text, self.token)
        if tone == "warn" and self.color:
            clean = f"\033[33m{clean}\033[0m"
        print(clean, flush=True)

    def now(self) -> dt.datetime:
        return dt.datetime.now(VN)

    def host(self) -> str:
        return socket.gethostname() or os.environ.get("COMPUTERNAME", "")

    def rand(self) -> str:
        return secrets.token_hex(4)

    # ---- git, tiến trình con, tệp
    def git(self, *args: str, binary: bool = False):
        run = subprocess.run(["git", *args], cwd=ROOT, capture_output=True)
        return run.returncode, (run.stdout if binary else run.stdout.decode("utf-8", "replace"))

    def git_live(self, *args: str) -> int:
        """git có thể hỏi đăng nhập (fetch / push): để nguyên terminal, không bắt đầu ra."""
        return subprocess.run(["git", *args], cwd=ROOT).returncode

    def run(self, command: list[str]) -> tuple[int, str]:
        env = {**os.environ, "PYTHONIOENCODING": "utf-8"}
        run = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
        return run.returncode, (run.stdout or "") + (run.stderr or "")

    def exists(self, rel: str) -> bool:
        return (ROOT / rel).is_file()

    def worktree_bytes(self, rel: str) -> bytes | None:
        try:
            return (ROOT / rel).read_bytes()
        except OSError:
            return None

    def migration_order(self) -> list[str]:
        if self._order is None:
            self._order = [name for name, _sql in live.migration_files()]
        return list(self._order)

    def write_text(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")

    # ---- Supabase
    def read_token(self) -> str:
        return supa.read_token(ROOT)

    def project_ref(self, explicit: str) -> str:
        return resolve_ref(explicit, os.environ.get("SUPABASE_URL", ""))

    def query(self, sql: str):
        """run_query; lỗi → ApiError. Hết giờ / mất kết nối / HTTP ≥ 500 / phản hồi hỏng = KẾT QUẢ CHƯA RÕ (unknown)."""
        try:
            return supa.run_query(self.ref, self.token, sql, self.timeout)
        except SystemExit as error:
            raise api_error(error.code, self.token) from None
        except (OSError, http.client.HTTPException, ValueError) as error:   # TimeoutError, ConnectionResetError, JSON hỏng…
            raise ApiError(f"Không rõ kết quả ({type(error).__name__}): {redact(error, self.token)}", unknown=True) from None

    def api(self, path: str, raw: bool = False):
        """GET Management API /v1/projects/<ref><path>; 404 → None."""
        request = Request(f"{supa.MANAGEMENT_API}/v1/projects/{self.ref}{path}",
                          headers={"Authorization": f"Bearer {self.token}"}, method="GET")
        try:
            with urlopen(request, timeout=self.timeout) as response:
                body = response.read()
        except HTTPError as error:
            if error.code == 404:
                return None
            raise ApiError(f"Management API HTTP {error.code} khi đọc {path} (401: token hỏng / hết hạn; 403: thiếu quyền)",
                           unknown=http_unknown(error.code)) from None
        except (URLError, OSError, http.client.HTTPException) as error:
            raise ApiError(f"Không gọi được Management API khi đọc {path} ({type(error).__name__})", unknown=True) from None
        if raw:
            return body
        try:
            return json.loads(body.decode("utf-8") or "null")
        except ValueError:
            raise ApiError(f"Phản hồi {path} không phải JSON", unknown=True) from None

    def edge_list(self) -> list[dict]:
        try:
            return live.edge_functions(self.ref, self.token, self.timeout)
        except SystemExit as error:
            raise api_error(error.code, self.token) from None
        except (OSError, http.client.HTTPException, ValueError) as error:
            raise ApiError(f"Không gọi được Management API khi đọc Edge ({type(error).__name__})", unknown=True) from None


def ask_yes(ctx: Ctx, prompt: str) -> bool:
    return ctx.ask(prompt).strip().lower() == "y"


def warn(ctx: Ctx, text: str) -> None:
    ctx.say(f"CẢNH BÁO: {text}", tone="warn")


def step(ctx: Ctx, title: str, result: str, measure: str = "") -> None:
    if ctx.report:
        ctx.report.step(title, result, measure)


def done(ctx: Ctx, text: str) -> None:
    if ctx.report:
        ctx.report.done.append(text)


# ===================================================================== đọc HEAD, sổ, kế hoạch
def head_bytes(ctx: Ctx, sha: str, rel: str) -> bytes:
    """Nội dung tệp ở commit `sha` (git show), không đọc cây làm việc; nhớ trong lượt chạy."""
    if (sha, rel) in ctx.blobs:
        return ctx.blobs[(sha, rel)]
    code, data = ctx.git("show", f"{sha}:{rel}", binary=True)
    if code != 0:
        raise Stop(1, f"Không đọc được {rel} ở commit {sha[:7]} (git show).")
    ctx.blobs[(sha, rel)] = data
    return data


def head_sha(ctx: Ctx) -> str:
    code, out = ctx.git("rev-parse", "HEAD")
    sha = out.strip()
    if code != 0 or not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise Stop(3, "Không đọc được HEAD (git rev-parse HEAD).")
    return sha


def head_sql_files(ctx: Ctx, sha: str) -> list[str]:
    """Tên tệp supabase/*.sql ở HEAD theo thứ tự chạy của live_status.migration_files() (thứ tự vào git)."""
    code, out = ctx.git("ls-tree", "--name-only", sha, "supabase/")
    if code != 0:
        raise Stop(3, "Không liệt kê được supabase/ ở HEAD (git ls-tree).")
    names = {path.split("/", 1)[1] for path in out.split() if path.count("/") == 1 and is_migration(path)}
    ordered = [name for name in ctx.migration_order() if name in names]
    return ordered + sorted(names - set(ordered))


def head_edge_slugs(ctx: Ctx, sha: str) -> list[str]:
    code, out = ctx.git("ls-tree", "-r", "--name-only", sha, "--", "supabase/functions")
    if code != 0:
        raise Stop(3, "Không liệt kê được supabase/functions ở HEAD (git ls-tree).")
    return sorted(m.group(1) for path in out.split() if (m := re.fullmatch(r"supabase/functions/([a-z0-9][a-z0-9-]*)/index\.ts", path)))


def is_migration(name: str) -> bool:
    """supabase/*.sql là migration, trừ tệp ví dụ *.example.sql (vd. print_queue_bootstrap.example.sql; lead chốt 26/10/2026).
    live_status.migration_files() vẫn đếm tệp ví dụ: release.py tự lọc ở danh sách HEAD, sổ và biên bản."""
    return name.endswith(".sql") and not name.endswith(".example.sql")


def edge_rel(slug: str) -> str:
    return f"supabase/functions/{slug}/index.ts"


def head_version(ctx: Ctx, sha: str) -> tuple[str, str]:
    raw = head_bytes(ctx, sha, MANIFEST)
    try:
        version = str(json.loads(raw.decode("utf-8-sig")).get("version") or "")
    except (ValueError, AttributeError):
        raise Stop(1, f"{MANIFEST} ở HEAD không phải JSON hợp lệ.") from None
    return version, content_sha(raw)


def read_ledger(ctx: Ctx) -> dict:
    rows = ctx.query(live.select_only(LEDGER_SQL))
    return {(row.get("kind"), row.get("name")): row for row in rows if isinstance(row, dict)} if isinstance(rows, list) else {}


def db_status(ctx: Ctx) -> dict:
    rows = ctx.query(live.select_only(live.STATUS_SQL))
    status = rows[0].get("status") if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
    if isinstance(status, str):
        status = json.loads(status)
    return status if isinstance(status, dict) else {}


def db_objects(status: dict) -> dict[str, set[str]]:
    return {kind: ({c.get("name") for c in status.get("cron") or []} if kind == "cron" else set(status.get(kind) or []))
            for kind in live.KINDS}


@dataclass
class Migration:
    name: str
    sql: str
    sha: str
    ledger_sha: str | None = None
    rerun: bool = False

    @property
    def header(self) -> Header:
        return parse_header(self.sql)

    @property
    def risky(self) -> list[str]:
        return deep_destructive(self.sql)

    @property
    def definer(self) -> bool:
        return bool(DEFINER.search(supa.strip_sql_comments(self.sql)))


@dataclass
class Edge:
    slug: str
    source: str
    sha: str
    ledger_sha: str | None = None


@dataclass
class Changed:
    """Tệp migration đã có trong sổ mà sha ở HEAD khác: đã sửa sau khi chạy, chưa lên database. CHẶN --apply (chốt 26/10/2026)."""
    name: str
    ledger_sha: str | None
    sha: str
    commit: str = ""                                   # commit_sha trong sổ (bản đã chạy)
    stat: list[str] = field(default_factory=list)      # git diff --stat <commit trong sổ>..<sha> -- supabase/<tệp>
    old: str | None = None                             # nội dung bản cũ (git show <commit>:…); None = không đọc được
    comment_only: bool | None = None                   # chỉ khác chú thích? None = không so được


def sql_without_comments(sql: str) -> str:
    """SQL đã bỏ chú thích (apply_supabase_sql.strip_sql_comments), gộp khoảng trắng: so 'chỉ sửa chú thích'."""
    return " ".join(supa.strip_sql_comments(sql.replace("\r\n", "\n")).split())


@dataclass
class Plan:
    sha: str
    files: list[tuple[str, str]]                       # mọi supabase/*.sql ở HEAD theo thứ tự chạy (cho expected_objects)
    hashes: dict[str, str]
    migrations: list[Migration] = field(default_factory=list)
    changed: list[Changed] = field(default_factory=list)
    edges: list[Edge] = field(default_factory=list)
    version: str = ""
    noted: str | None = None                           # bản Extension trong sổ
    manifest_sha: str = ""
    web: list[str] = field(default_factory=list)

    @property
    def short(self) -> str:
        return self.sha[:7]

    @property
    def extension(self) -> bool:
        return bool(self.version) and self.version != self.noted


def migration_arg(value: str | None, flag: str) -> str | None:
    """Tên tệp của --rerun / --accept: chỉ `<tên>.sql` hoặc `supabase/<tên>.sql` (không đường dẫn lạ, không *.example.sql)."""
    if not value:
        return None
    text = value.replace("\\", "/")
    name = text[len("supabase/"):] if text.startswith("supabase/") else text
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*\.sql", name):
        raise Stop(2, f"{flag} cần tên tệp supabase/<tên>.sql: {value!r}.")
    if not is_migration(name):
        raise Stop(2, f"{flag} {name}: tệp ví dụ *.example.sql không phải migration.")
    return name


def build_plan(ctx: Ctx, sha: str, ledger: dict, rerun: str | None = None) -> Plan:
    names = head_sql_files(ctx, sha)
    files, hashes = [], {}
    for name in names:
        raw = head_bytes(ctx, sha, f"supabase/{name}")
        files.append((name, raw.decode("utf-8-sig", errors="replace")))
        hashes[name] = content_sha(raw)
    rerun = migration_arg(rerun, "--rerun")
    if rerun:
        row = ledger.get(("migration", rerun))
        if rerun not in hashes:
            raise Stop(2, f"--rerun {rerun}: không có supabase/{rerun} ở HEAD.")
        if row is None:
            raise Stop(2, f"--rerun {rerun}: tệp chưa có trong sổ — --apply thường sẽ chạy tệp này, không cần --rerun.")
        if row.get("sha256") == hashes[rerun]:
            raise Stop(2, f"--rerun {rerun}: sha ở HEAD trùng sổ, không có gì để chạy lại.")
    plan = Plan(sha=sha, files=files, hashes=hashes)
    for name, sql in files:
        row = ledger.get(("migration", name))
        if row is None:
            plan.migrations.append(Migration(name, sql, hashes[name]))
        elif row.get("sha256") == hashes[name]:
            continue
        elif rerun == name:
            plan.migrations.append(Migration(name, sql, hashes[name], row.get("sha256"), rerun=True))
        else:
            commit = str(row.get("commit_sha") or "")
            stat: list[str] = []
            old = None
            if re.fullmatch(r"[0-9a-f]{7,40}", commit):
                code, out = ctx.git("diff", "--stat", f"{commit}..{sha}", "--", f"supabase/{name}")
                stat = out.strip().splitlines() if code == 0 else []
                code, blob = ctx.git("show", f"{commit}:supabase/{name}", binary=True)
                old = blob.decode("utf-8-sig", errors="replace") if code == 0 else None
            only = None if old is None else sql_without_comments(old) == sql_without_comments(sql)
            plan.changed.append(Changed(name, row.get("sha256"), hashes[name], commit, stat, old, only))
    for slug in head_edge_slugs(ctx, sha):
        raw = head_bytes(ctx, sha, edge_rel(slug))
        row = ledger.get(("edge", slug)) or {}
        digest = content_sha(raw)
        if row.get("sha256") != digest:
            plan.edges.append(Edge(slug, raw.decode("utf-8", errors="replace"), digest, row.get("sha256")))
    plan.version, plan.manifest_sha = head_version(ctx, sha)
    plan.noted = (ledger.get(("extension", EXT_NAME)) or {}).get("note")
    code, out = ctx.git("rev-list", f"origin/main..{sha}")
    if code != 0:
        raise Stop(3, "Không so được HEAD với origin/main (git rev-list): kiểm remote origin.")
    plan.web = out.split()
    return plan


def stages_for(only: str | None) -> tuple[str, ...]:
    wanted = {"migrations": "migration", "edge": "edge"}.get(only or "")
    return tuple(stage for stage in STAGES if wanted is None or stage == wanted)


def pending_count(plan: Plan, stages) -> int:
    return ((len(plan.migrations) if "migration" in stages else 0) + (len(plan.edges) if "edge" in stages else 0)
            + (1 if plan.extension and "extension" in stages else 0) + (1 if plan.web and "push" in stages else 0))


def migration_flags(item: Migration) -> str:
    flags = []
    if item.rerun:
        flags.append("chạy lại theo --rerun")
    if item.risky:
        flags.append(f"{', '.join(item.risky)} — gõ tên tệp")
    if item.definer:
        flags.append("SECURITY DEFINER")
    if not item.header.kiem:
        flags.append("xác minh yếu: không có -- kiem")
    return f" [{'; '.join(flags)}]" if flags else ""


def render_plan(plan: Plan, stages) -> list[str]:
    out = [f"Kế hoạch phát hành — HEAD {plan.short}; thứ tự cố định: migration → Edge → Extension → push."]
    number = 0
    if "migration" in stages:
        number += 1
        out.append(f"{number}. Migration chờ: {len(plan.migrations) or 'không'}")
        out += [f"   - {item.name}{migration_flags(item)}" for item in plan.migrations]
    if "edge" in stages:
        number += 1
        out.append(f"{number}. Edge chờ deploy: {len(plan.edges) or 'không'}")
        out += [f"   - {edge.slug}: nguồn HEAD {short(edge.sha)}, sổ {short(edge.ledger_sha) if edge.ledger_sha else 'chưa có'}"
                for edge in plan.edges]
    if "extension" in stages:
        number += 1
        out.append(f"{number}. Extension {EXT_NAME}: " + (f"{plan.version} ở HEAD, sổ {plan.noted or 'chưa ghi'} → cổng Reload"
                                                          if plan.extension else f"không (sổ = {plan.version})"))
    if "push" in stages:
        number += 1
        out.append(f"{number}. Web: " + (f"{len(plan.web)} commit chưa push lên origin/main" if plan.web
                                        else "không (HEAD không đi trước origin/main theo lần fetch gần nhất)"))
    if plan.changed:
        out += render_changed(plan)
    elif not pending_count(plan, stages):
        out.append("Không có việc chờ.")
    return out


def render_changed(plan: Plan) -> list[str]:
    """Tệp đã sửa sau khi chạy: tên, diff --stat so với bản trong sổ, lối thoát (--accept khi chỉ khác chú thích, không thì --rerun)."""
    out = [f"! {len(plan.changed)} tệp migration đã sửa sau khi chạy — --apply sẽ dừng (mã 3):"]
    for change in plan.changed:
        out.append(f"   ! {change.name}: sổ {short(change.ledger_sha)} (commit {change.commit or '?'}), HEAD {short(change.sha)}")
        if change.old is None:
            out.append(f"       không đọc được bản cũ (commit {change.commit or '?'})")
        out += [f"       {line.strip()}" for line in change.stat]
        if change.comment_only is True:
            out.append(f"       → chỉ sửa chú thích: ghi nhận bằng --accept {change.name}")
        elif change.comment_only is False:
            out.append(f"       → nội dung SQL đã đổi: chạy lại bằng --rerun {change.name} "
                       "(--accept sẽ KHÔNG đưa phần sửa lên database)")
        else:
            out.append(f"       → không so được: kiểm tay; --rerun {change.name} để chạy lại, hoặc --accept {change.name} "
                       "nếu chắc chỉ sửa chú thích (--accept KHÔNG chạy SQL)")
    return out


def render_ledger(ledger: dict) -> list[str]:
    rows = list(ledger.values())
    migrations = [r for r in rows if r.get("kind") == "migration" and is_migration(str(r.get("name") or ""))]
    out = [f"- Migration: {len(migrations)} tệp"]
    if migrations:
        last = max(migrations, key=lambda r: str(r.get("applied_at") or ""))
        out[0] += f"; ghi gần nhất {last.get('name')} ({vn(last.get('applied_at'))}, commit {last.get('commit_sha') or '—'}, {last.get('applied_by') or '—'})"
    for row in sorted((r for r in rows if r.get("kind") == "edge"), key=lambda r: str(r.get("name"))):
        out.append(f"- Edge {row.get('name')} {row.get('note') or '—'}: sha {short(row.get('sha256'))}, {vn(row.get('applied_at'))}, "
                   f"commit {row.get('commit_sha') or '—'}")
    ext = ledger.get(("extension", EXT_NAME))
    out.append(f"- Extension {EXT_NAME}: {ext.get('note')} ({vn(ext.get('applied_at'))})" if ext else f"- Extension {EXT_NAME}: chưa ghi")
    lock = ledger.get(("lock", "release"))
    out.append(f"- Khoá phát hành: {lock.get('applied_by')} từ {vn(lock.get('applied_at'))} (hạn {LOCK_MINUTES} phút)" if lock
               else "- Khoá phát hành: trống")
    return out


def ledger_changes(before: dict, after: dict) -> list[str]:
    out = []
    for key, row in sorted(after.items(), key=lambda item: (str(item[0][0]), str(item[0][1]))):
        if key[0] == "lock" or (key[0] == "migration" and not is_migration(str(key[1]))):
            continue
        old = before.get(key)
        if old is None or any(old.get(k) != row.get(k) for k in ("sha256", "note", "applied_at")):
            out.append(f"- {key[0]} {key[1]}: {'mới' if old is None else 'cập nhật'}, sha {short(row.get('sha256'))}"
                       + (f", {row.get('note')}" if row.get("note") else ""))
    return out or ["- Không đổi."]


# ===================================================================== preflight, khoá
NO_TOKEN = (f"Thiếu {supa.TOKEN_VARIABLE}: release.py cần personal access token của Management API để đọc sổ release_ledger "
            f"(cả --plan). Đặt biến môi trường {supa.TOKEN_VARIABLE} hoặc thêm dòng cùng tên vào .env ở gốc repo như "
            "scripts/apply_supabase_sql.py (token tạo ở https://supabase.com/dashboard/account/tokens). Script không in token.")


def connect(ctx: Ctx, args, need_ledger: bool = True) -> None:
    """Token, project ref, (sổ tồn tại). Hỏng → Stop(3)."""
    token = ctx.read_token()
    if not token:
        raise Stop(3, NO_TOKEN)
    ctx.token = token
    ctx.ref = ctx.project_ref(args.project_ref)
    if not ctx.holder:
        machine = re.sub(r"[^A-Za-z0-9_.-]", "-", ctx.host() or "")[:60] or "may"
        ctx.holder = f"{machine}#{ctx.rand()}"
    if need_ledger:
        try:
            ok = first_value(ctx.query(live.select_only(LEDGER_EXISTS_SQL)))
        except ApiError as error:
            raise Stop(3, f"Không đọc được Supabase (project {ctx.ref}): {error}") from None
        if ok is not True:
            raise Stop(3, "Chưa có sổ public.release_ledger: chạy python scripts/release.py --init một lần (terminal thật).")


def local_preflight(ctx: Ctx, sha: str) -> None:
    """Nhánh main, cây sạch, commit `sha` (đã ghim) không tụt origin/main sau git fetch, commit_gate đạt. Hỏng → Stop(3)."""
    code, branch = ctx.git("rev-parse", "--abbrev-ref", "HEAD")
    if code != 0 or branch.strip() != "main":
        raise Stop(3, f"Đang ở nhánh {branch.strip() or '?'}: release.py chỉ chạy trên main.")
    pre(ctx, "Nhánh main")
    code, dirty = ctx.git("status", "--porcelain", "--untracked-files=no")
    if code != 0 or dirty.strip():
        listed = "\n".join(f"  {line}" for line in dirty.strip().splitlines()[:10])
        raise Stop(3, "Cây làm việc có thay đổi chưa commit (git status --porcelain --untracked-files=no):\n"
                   f"{listed}\nrelease.py chỉ phát hành nguồn đã commit: commit hoặc cất thay đổi rồi chạy lại.")
    pre(ctx, "Cây làm việc sạch (git status --porcelain --untracked-files=no rỗng)")
    if ctx.git_live("fetch", "--quiet", "origin") != 0:
        raise Stop(3, "git fetch origin lỗi: không so được HEAD với origin/main.")
    code, behind = ctx.git("rev-list", "--count", f"{sha}..origin/main")
    behind = behind.strip()
    if code != 0 or not behind.isdigit():
        raise Stop(3, "Không so được HEAD với origin/main (git rev-list).")
    if int(behind) > 0:
        raise Stop(3, f"HEAD tụt origin/main {behind} commit: pull / rebase rồi chạy lại.")
    pre(ctx, f"HEAD {sha[:7]} không tụt origin/main (sau git fetch)")
    code, output = ctx.run([sys.executable, "-X", "utf8", "scripts/commit_gate.py", "--commit", sha])
    if code != 0:
        tail = "\n".join(f"  {line}" for line in output.strip().splitlines()[-15:])
        raise Stop(3, f"commit_gate.py --commit {sha[:7]} KHÔNG ĐẠT:\n" + tail)
    pre(ctx, f"commit_gate.py --commit {sha[:7]} đạt")


def pre(ctx: Ctx, text: str) -> None:
    if ctx.report:
        ctx.report.preflight.append(f"- {text}")


def acquire_lock(ctx: Ctx) -> str:
    try:
        rows = ctx.query(lock_take_sql(ctx.holder))
    except ApiError as error:
        try:
            ctx.query(lock_release_sql(ctx.holder))  # cố gắng: máy chủ có thể đã chèn khoá trước khi lỗi
        except ApiError:
            pass
        raise Stop(3, f"Không lấy được khoá phát hành: {error}") from None
    if isinstance(rows, list) and any(isinstance(r, dict) and r.get("applied_by") == ctx.holder for r in rows):
        ctx.say(f"Đã lấy khoá phát hành ({ctx.holder}; hạn {LOCK_MINUTES} phút, gia hạn ở mỗi bước).")
        pre(ctx, f"Khoá phát hành: {ctx.holder}")
        return ctx.holder
    who, since = "?", None
    try:
        held = ctx.query(live.select_only(LOCK_READ_SQL))
        if isinstance(held, list) and held and isinstance(held[0], dict):
            who, since = held[0].get("applied_by") or "?", held[0].get("applied_at")
    except ApiError:
        pass
    raise Stop(3, f"Khoá phát hành đang do {who} giữ từ {vn(since)} (hết hạn {LOCK_MINUTES} phút sau lần gia hạn cuối): "
               "đợi máy kia xong hoặc khoá hết hạn rồi chạy lại.")


def refresh_lock(ctx: Ctx) -> None:
    try:
        rows = ctx.query(lock_refresh_sql(ctx.holder))
    except ApiError as error:
        raise Stop(1, f"Không gia hạn được khoá phát hành: {error}") from None
    if not (isinstance(rows, list) and rows):
        raise Stop(1, f"Mất khoá phát hành (quá {LOCK_MINUTES} phút và máy khác đã lấy): dừng; chạy lại --apply.")


def release_lock(ctx: Ctx, holder: str) -> None:
    try:
        rows = ctx.query(lock_release_sql(holder))
    except ApiError as error:
        warn(ctx, f"không nhả được khoá phát hành ({error}); khoá tự hết hạn sau {LOCK_MINUTES} phút.")
        return
    ctx.say("Đã nhả khoá phát hành." if isinstance(rows, list) and rows
            else "Khoá phát hành không còn do máy này giữ: không có gì để nhả.")


def record(ctx: Ctx, plan: Plan, kind: str, name: str, sha: str | None, note: str | None) -> None:
    rows = ctx.query(upsert_sql(kind, name, sha, plan.short, ctx.holder, note))
    if not (isinstance(rows, list) and rows):
        raise ApiError("câu ghi sổ không trả dòng nào")


def record_after(ctx: Ctx, plan: Plan, kind: str, name: str, sha: str | None, note: str | None) -> None:
    """Ghi sổ một mục SAU khi đã xác minh đạt; ghi lỗi → báo lớn rồi dừng."""
    try:
        record(ctx, plan, kind, name, sha, note)
    except ApiError as error:
        title = {"migration": f"ĐÃ CHẠY {name} nhưng chưa ghi sổ", "edge": f"ĐÃ DEPLOY {name} nhưng chưa ghi sổ",
                 "extension": f"Đã xác nhận Reload {name} nhưng chưa ghi sổ"}[kind]
        advice = {"migration": "chạy lại chỉ an toàn nếu tệp idempotent",
                  "edge": "chạy lại --apply sẽ deploy lại cùng nguồn HEAD",
                  "extension": "chạy lại --apply sẽ hỏi lại"}[kind]
        unsure = "\nKết quả ghi sổ CHƯA RÕ: sổ có thể đã ghi — xem python scripts/release.py --status." if error.unknown else ""
        bar = "!" * 78
        raise Stop(1, f"{bar}\n{title}; {advice}.{unsure}\nLỗi ghi sổ: {error}\n{bar}", title=title) from None
    ctx.say(f"Đã ghi sổ: {kind} {name}.")


# ===================================================================== các cổng
def ask_tests(ctx: Ctx, plan: Plan) -> None:
    code, names = ctx.git("diff", "--name-only", f"origin/main..{plan.sha}")
    if code != 0:
        raise Stop(3, f"Không đọc được diff origin/main..{plan.short} (git diff): không bỏ qua cổng bộ test.")
    files = [name.strip() for name in names.splitlines() if name.strip().endswith(CODE_SUFFIXES)]
    if not files:
        pre(ctx, "Cổng bộ test: bỏ qua (diff không có tệp mã)")
        return
    ctx.say(f"Diff origin/main..HEAD có {len(files)} tệp mã: {', '.join(files[:5])}{' …' if len(files) > 5 else ''}.")
    if not ask_yes(ctx, "Đã có kết quả cả bộ test (python scripts/run_tests.py) cho HEAD này? [y/N] "):
        raise Stop(1, "Chưa có kết quả cả bộ test cho HEAD: chạy python scripts/run_tests.py rồi --apply lại "
                   "(release.py không tự chạy bộ test).")
    pre(ctx, "Người dùng xác nhận đã có kết quả cả bộ test cho HEAD")


def show_migration(ctx: Ctx, plan: Plan, item: Migration, index: int) -> None:
    _code, commit = ctx.git("log", "-1", "--format=%h %s", plan.sha, "--", f"supabase/{item.name}")
    head = item.header
    ctx.say("")
    ctx.say(f"── Migration {index}/{len(plan.migrations)}: {item.name}"
            + (f" — CHẠY LẠI theo --rerun (sổ {short(item.ledger_sha)} → HEAD {short(item.sha)})" if item.rerun else ""))
    ctx.say(f"Commit: {commit.strip() or '?'}")
    for line in head.lines[:12]:
        ctx.say(f"  {line}")
    if item.risky:
        warn(ctx, f"tệp có {', '.join(item.risky)}: phải gõ nguyên tên tệp; chỉ tệp này được --allow-destructive.")
    if item.definer:
        ctx.say("Cờ: SECURITY DEFINER (kiểm set search_path = '' và revoke).")
    if head.rollback:
        ctx.say("Rút lui (chỉ in, không chạy tự động):")
        for line in head.rollback:
            ctx.say(f"  {line}")
    if not head.kiem:
        warn(ctx, f"{item.name} không có dòng -- kiem: → xác minh yếu (chỉ kiểm đối tượng tệp tạo ra).")


def confirm_migration(ctx: Ctx, item: Migration) -> bool:
    """True khi tệp có DROP / DELETE / TRUNCATE và người dùng đã gõ đúng tên tệp (= --allow-destructive cho riêng tệp này)."""
    if item.risky:
        answer = ctx.ask(f"Gõ nguyên tên tệp {item.name} để chạy (kèm --allow-destructive cho riêng tệp này), Enter để dừng: ").strip()
        if answer != item.name:
            raise Stop(1, f"Không gõ đúng tên {item.name}: dừng, không chạy (các mục sau cũng không chạy).")
        return True
    if not ask_yes(ctx, f"Chạy {item.name}? [y/N] "):
        raise Stop(1, f"Người dùng từ chối {item.name}: dừng (các mục sau không chạy).")
    return False


def rollback_text(item: Migration) -> str:
    lines = item.header.rollback
    return ("\nRút lui (chỉ in, không chạy tự động):\n" + "\n".join(f"  {line}" for line in lines)) if lines else \
        "\nTệp không có khối -- Rút lui."


def run_migration(ctx: Ctx, plan: Plan, item: Migration, allowed: bool) -> None:
    risky = deep_destructive(item.sql)
    if risky and not allowed:
        raise Stop(1, f"{item.name} có {', '.join(risky)} mà chưa gõ tên tệp: không chạy.")
    started = time.monotonic()
    try:
        ctx.query(item.sql)
    except ApiError as error:
        if error.unknown:
            step(ctx, f"Migration {item.name}", "KẾT QUẢ CHƯA RÕ", str(error)[:200])
            raise Stop(1, f"KẾT QUẢ CHƯA RÕ: máy chủ có thể đã ghi {item.name} ({error}).\n{verify_hint(ctx, plan, item)}\n"
                       "Chưa ghi sổ. Đối chiếu bằng --plan, -- kiem và python scripts/live_status.py trước khi chạy lại; "
                       f"không rollback tự động.{rollback_text(item)}", title=f"KẾT QUẢ CHƯA RÕ: {item.name}") from None
        step(ctx, f"Migration {item.name}", "bị từ chối", str(error)[:200])
        raise Stop(1, f"Migration {item.name} bị từ chối: {error}\nMỗi tệp là một giao dịch: database không đổi. "
                   f"Không rollback tự động.{rollback_text(item)}", title=f"Migration {item.name} bị từ chối") from None
    ctx.say(f"Đã chạy {item.name} ({time.monotonic() - started:.1f} s).")


def verify_hint(ctx: Ctx, plan: Plan, item: Migration) -> str:
    """Sau kết quả chưa rõ: kiểm CHỈ ĐỌC để gợi ý tệp đã chạy hay chưa; không ghi sổ."""
    problems, wanted, checks = migration_checks(ctx, plan, item)
    if problems:
        return "Kiểm chỉ đọc: CHƯA đạt — " + "; ".join(problems)
    if not wanted and not checks:
        return "Kiểm chỉ đọc: tệp không có đối tượng / -- kiem để đối chiếu."
    return f"Kiểm chỉ đọc: đối tượng {wanted}/{wanted}, -- kiem {checks}/{checks} ĐẠT → nhiều khả năng tệp ĐÃ chạy."


def run_kiem(ctx: Ctx, check: str) -> tuple[bool, str]:
    try:
        sql = live.select_only(check)
    except ValueError:
        return False, "không phải một câu SELECT chỉ đọc"
    try:
        value = first_value(ctx.query(sql))
    except ApiError as error:
        return False, str(error)
    return value is True, f"trả {value!r}"


def migration_checks(ctx: Ctx, plan: Plan, item: Migration) -> tuple[list[str], int, int]:
    """Kiểm chỉ đọc: (vấn đề, số đối tượng tệp tạo ra, số dòng -- kiem)."""
    problems = []
    _expected, per_file = live.expected_objects(plan.files)
    want = per_file.get(item.name, set())
    if want:
        try:
            missing = live.missing_by_file({item.name: want}, db_objects(db_status(ctx))).get(item.name, [])
        except ApiError as error:
            missing = [f"(không đọc được trạng thái DB: {error})"]
        if missing:
            problems.append("thiếu đối tượng trên DB: " + ", ".join(missing))
    kiem = item.header.kiem
    for check in kiem:
        ok, detail = run_kiem(ctx, check)
        if not ok:
            problems.append(f"-- kiem không trả true: {check} ({detail})")
    return problems, len(want), len(kiem)


def verify_migration(ctx: Ctx, plan: Plan, item: Migration) -> None:
    """Đối tượng tệp tạo ra có trên DB (expected_objects + STATUS_SQL) và mọi `-- kiem:` trả true. Hỏng → Stop(1), không ghi sổ."""
    problems, wanted, checks = migration_checks(ctx, plan, item)
    if problems:
        step(ctx, f"Migration {item.name}", "ĐÃ CHẠY, xác minh KHÔNG ĐẠT", "; ".join(problems)[:300])
        raise Stop(1, f"Xác minh {item.name} KHÔNG ĐẠT — chưa ghi sổ:\n" + "\n".join(f"  - {p}" for p in problems)
                   + rollback_text(item), title=f"ĐÃ CHẠY {item.name}, xác minh KHÔNG ĐẠT, chưa ghi sổ")
    if not checks:
        warn(ctx, f"{item.name}: xác minh yếu (không có -- kiem:); đối tượng: {wanted} đủ.")
    step(ctx, f"Migration {item.name}", "đạt", f"đối tượng {wanted}/{wanted}, -- kiem {checks}/{checks}"
         + ("" if checks else ", xác minh yếu"))


def stage_migrations(ctx: Ctx, plan: Plan) -> None:
    for index, item in enumerate(plan.migrations, 1):
        show_migration(ctx, plan, item, index)
        allowed = confirm_migration(ctx, item)
        refresh_lock(ctx)
        run_migration(ctx, plan, item, allowed)
        verify_migration(ctx, plan, item)
        record_after(ctx, plan, "migration", item.name, item.sha, None)
        done(ctx, f"migration {item.name}")


def deploy_one(ctx: Ctx, plan: Plan, edge: Edge, index: int) -> None:
    script, rel = deploy_script(edge.slug), edge_rel(edge.slug)
    ctx.say("")
    ctx.say(f"── Edge {index}/{len(plan.edges)}: {edge.slug}")
    if not ctx.exists(script):
        raise Stop(1, f"Chưa có {script} cho Edge {edge.slug}: tạo script deploy (khuôn scripts/deploy_sku_sync.py) rồi chạy lại.")
    code, _out = ctx.git("cat-file", "-e", f"{plan.sha}:{script}")
    if code != 0:
        raise Stop(1, f"{script} không có ở commit {plan.short} (chưa commit?): release.py chỉ chạy script deploy đã commit.")
    before = ctx.api(f"/functions/{edge.slug}")
    old_version = int((before or {}).get("version") or 0)
    if before:
        ctx.say(f"Đang chạy: bản {old_version}, deploy {vn(before.get('updated_at'))}, trạng thái {before.get('status')}.")
    else:
        ctx.say("Chưa có trên Supabase: hàm mới, deploy lần đầu.")
    ctx.say(f"Nguồn HEAD sha {short(edge.sha)}; sổ {short(edge.ledger_sha) if edge.ledger_sha else 'chưa có'}.")
    if not ask_yes(ctx, f"Deploy {edge.slug} từ HEAD {plan.short}? [y/N] "):
        raise Stop(1, f"Người dùng từ chối deploy {edge.slug}: dừng.")
    refresh_lock(ctx)
    current = ctx.worktree_bytes(rel)
    if current is None or content_sha(current) != edge.sha:
        raise Stop(1, f"{rel} trong cây làm việc khác HEAD (script deploy đọc cây làm việc): dừng trước khi deploy.")
    started = int(ctx.now().timestamp() * 1000)
    code, output = ctx.run([sys.executable, "-X", "utf8", script, "--project-ref", ctx.ref])
    for line in output.strip().splitlines()[-12:]:
        ctx.say(f"  {line}")
    if code != 0:
        rejected = re.search(r"Management API HTTP (\d{3})", output)
        if rejected and not http_unknown(int(rejected.group(1))):
            step(ctx, f"Edge {edge.slug}", "deploy bị từ chối", f"HTTP {rejected.group(1)}")
            raise Stop(1, f"Deploy {edge.slug} bị từ chối (HTTP {rejected.group(1)}): bản đang chạy giữ nguyên; sổ không đổi.",
                       title=f"Deploy {edge.slug} bị từ chối")
        seen = running_version(ctx, edge.slug)
        step(ctx, f"Edge {edge.slug}", "deploy KẾT QUẢ CHƯA RÕ", f"mã {code}; {seen}")
        raise Stop(1, f"KẾT QUẢ CHƯA RÕ: deploy {edge.slug} lỗi (mã {code}); máy chủ có thể đã nhận bản mới. Đọc lại: {seen} "
                   f"(trước khi deploy: bản {old_version}). Chưa ghi sổ; kiểm bản đang chạy trước khi deploy lại.",
                   title=f"KẾT QUẢ CHƯA RÕ: deploy {edge.slug}")
    try:
        after = ctx.api(f"/functions/{edge.slug}") or {}
    except ApiError as error:
        raise Stop(1, f"KẾT QUẢ CHƯA RÕ: đã chạy deploy {edge.slug} nhưng không đọc lại được bản đang chạy ({error}). Chưa ghi sổ.",
                   title=f"KẾT QUẢ CHƯA RÕ: deploy {edge.slug}") from None
    new_version = int(after.get("version") or 0)
    problems = []
    if new_version != old_version + 1:
        problems.append(f"bản {new_version}, cần {old_version + 1}")
    if ms_of(after.get("updated_at")) < started - CLOCK_SLACK_MS:
        problems.append("updated_at không sau lúc bắt đầu deploy")
    if after.get("status") != "ACTIVE":
        problems.append(f"trạng thái {after.get('status')}, cần ACTIVE")
    if problems:
        step(ctx, f"Edge {edge.slug}", "xác minh KHÔNG ĐẠT", "; ".join(problems))
        raise Stop(1, f"Xác minh Edge {edge.slug} KHÔNG ĐẠT: {'; '.join(problems)}. Sổ không đổi.")
    try:
        bundle = ctx.api(f"/functions/{edge.slug}/body", raw=True)
    except ApiError as error:
        warn(ctx, f"không đọc được bundle {edge.slug} ({error}).")
        bundle = None
    verdict, missing, total = fingerprint(edge.source, bundle)
    if verdict == "missing":
        step(ctx, f"Edge {edge.slug}", "dấu vết KHÔNG ĐẠT", f"thiếu {len(missing)}/{total} chuỗi")
        sample = "\n".join(f"  - {item[:80]!r}" for item in missing[:5])
        raise Stop(1, f"Dấu vết nội dung KHÔNG ĐẠT: bundle {edge.slug} bản {new_version} thiếu {len(missing)}/{total} chuỗi của "
                   f"nguồn HEAD:\n{sample}\nSổ không đổi; kiểm bản đang chạy trước khi deploy lại.")
    if verdict in ("unsure", "none"):
        warn(ctx, f"{edge.slug}: " + ("bộ tách chuỗi không chắc hoặc không có bundle" if verdict == "unsure"
                                       else "nguồn không có chuỗi ≥ 14 ký tự") + " — bỏ qua dấu vết nội dung.")
    measure = f"bản {old_version} → {new_version}, " + (f"dấu vết {total}/{total}" if verdict == "ok" else "bỏ qua dấu vết")
    step(ctx, f"Edge {edge.slug}", "đạt", measure)
    record_after(ctx, plan, "edge", edge.slug, edge.sha, f"v{new_version}")
    done(ctx, f"Edge {edge.slug} v{new_version}")


def running_version(ctx: Ctx, slug: str) -> str:
    """Đọc lại bản Edge đang chạy (chỉ đọc) để gợi ý sau một lần deploy kết quả chưa rõ."""
    try:
        fn = ctx.api(f"/functions/{slug}")
    except ApiError as error:
        return f"không đọc được bản đang chạy ({error})"
    if not fn:
        return "chưa có hàm trên Supabase"
    return f"bản {fn.get('version')}, deploy {vn(fn.get('updated_at'))}, trạng thái {fn.get('status')}"


def stage_edges(ctx: Ctx, plan: Plan) -> None:
    for index, edge in enumerate(plan.edges, 1):
        deploy_one(ctx, plan, edge, index)


def show_devices(ctx: Ctx, version: str) -> None:
    try:
        rows = ctx.query(live.select_only(live.DEVICES_SQL))
    except ApiError:
        ctx.say("  (chưa có bảng sync_auto_devices: không liệt kê máy đồng bộ)")
        return
    info = first_value(rows)
    info = json.loads(info) if isinstance(info, str) else (info or {})
    devices = (info.get("devices") or []) if isinstance(info, dict) else []
    if not devices:
        ctx.say("  (chưa máy nào gọi Edge trong 14 ngày)")
        return
    ctx.say("  Máy đồng bộ (14 ngày):")
    for row in devices:
        row = {**row, "last_seen": vn(row.get("last_seen"))}
        old = bool(version) and live.ext_less(row.get("version"), version)
        ctx.say(f"  - {live.device_line(row, {})}" + (f" — còn bản cũ (cần {version})" if old else ""), tone="warn" if old else "")


def stage_extension(ctx: Ctx, plan: Plan) -> None:
    if not plan.extension:
        return
    ctx.say("")
    ctx.say(f"── Extension {EXT_NAME}: sổ {plan.noted or 'chưa ghi'} → {plan.version}")
    for line in RELOAD_CHECKLIST:
        ctx.say(f"  {line.format(version=plan.version)}")
    show_devices(ctx, plan.version)
    if not ask_yes(ctx, f"Đã Reload Extension {plan.version} trên mọi máy Admin đang đồng bộ và tải lại tab Inside / WMS? [y/N] "):
        raise Stop(1, "Chưa xác nhận Reload Extension: dừng trước push (sổ không đổi).")
    refresh_lock(ctx)
    step(ctx, f"Extension {plan.version}", "người dùng xác nhận đã Reload")
    record_after(ctx, plan, "extension", EXT_NAME, plan.manifest_sha, plan.version)
    done(ctx, f"Extension {plan.version} (đã Reload)")


def stage_push(ctx: Ctx, plan: Plan) -> None:
    if not plan.web:
        return
    ctx.say("")
    ctx.say(f"── Push {len(plan.web)} commit lên origin/main (push main = web lên ngay)")
    _code, log = ctx.git("log", "--oneline", f"origin/main..{plan.sha}")
    for line in log.strip().splitlines():
        ctx.say(f"  {line}")
    if not ask_yes(ctx, f"Push {len(plan.web)} commit (đến {plan.short}) lên origin/main? [y/N] "):
        raise Stop(1, "Người dùng từ chối push: migration / Edge / Extension đã ghi sổ; web chưa lên.")
    _code, branch = ctx.git("rev-parse", "--abbrev-ref", "HEAD")
    if head_sha(ctx) != plan.sha or branch.strip() != "main":
        raise Stop(1, f"HEAD hoặc nhánh đã đổi trong lúc phát hành (đã kiểm {plan.short} trên main): dừng, không push; chạy lại --apply.")
    refresh_lock(ctx)
    if ctx.git_live("push", "origin", f"{plan.sha}:refs/heads/main") != 0:
        step(ctx, "Push", "LỖI")
        raise Stop(1, "git push lỗi: web chưa lên (sổ giữ nguyên các mục đã chạy).")
    step(ctx, "Push", "đạt", f"{len(plan.web)} commit")
    done(ctx, f"push {len(plan.web)} commit")


RUNNERS = {"migration": stage_migrations, "edge": stage_edges, "extension": stage_extension, "push": stage_push}


# ===================================================================== luồng
def run_plan(ctx: Ctx, args) -> int:
    connect(ctx, args)
    ledger = read_ledger(ctx)
    plan = build_plan(ctx, head_sha(ctx), ledger, args.rerun)
    code, branch = ctx.git("rev-parse", "--abbrev-ref", "HEAD")
    if branch.strip() != "main":
        ctx.say(f"Lưu ý: đang ở nhánh {branch.strip() or '?'} — --apply chỉ chạy trên main.")
    code, dirty = ctx.git("status", "--porcelain", "--untracked-files=no")
    if dirty.strip():
        ctx.say(f"Lưu ý: cây làm việc có {len(dirty.strip().splitlines())} tệp đổi chưa commit — kế hoạch tính theo HEAD; "
                "--apply sẽ dừng ở preflight.")
    for line in render_plan(plan, stages_for(args.only)):
        ctx.say(line)
    return 0


def run_status(ctx: Ctx, args) -> int:
    connect(ctx, args)
    ledger = read_ledger(ctx)
    ctx.say(f"Sổ release_ledger (project {ctx.ref}):")
    for line in render_ledger(ledger):
        ctx.say(line)
    plan = build_plan(ctx, head_sha(ctx), ledger)
    for line in render_changed(plan) if plan.changed else []:
        ctx.say(line)
    return 0


def block_changed(plan: Plan) -> None:
    """Tệp migration đã sửa sau khi chạy (trừ tệp của --rerun) chặn MỌI chặng của --apply, mọi --only (chốt 26/10/2026)."""
    if plan.changed:
        names = ", ".join(change.name for change in plan.changed)
        raise Stop(3, f"Dừng (mã 3): {len(plan.changed)} tệp migration đã sửa sau khi chạy chưa xử lý: {names}. Không chạy cổng nào, "
                   "không ghi gì. Mỗi tệp: --rerun <tệp> để chạy lại bản mới, hoặc --accept <tệp> nếu chỉ sửa chú thích; rồi --apply lại.",
                   title=f"{len(plan.changed)} tệp migration đã sửa sau khi chạy: {names}")


def plan_key(plan: Plan) -> tuple:
    """Dấu của kế hoạch để biết sổ có đổi giữa lúc dựng kế hoạch và lúc lấy khoá."""
    return (tuple((m.name, m.sha, m.rerun) for m in plan.migrations), tuple((e.slug, e.sha) for e in plan.edges),
            plan.extension and plan.version, tuple(plan.web), tuple(c.name for c in plan.changed))


def apply_flow(ctx: Ctx, args) -> int:
    rep = ctx.report
    sha = head_sha(ctx)                      # ghim commit MỘT LẦN, trước preflight: preflight, kế hoạch và push đều dùng sha này
    if rep:
        rep.sha = sha
    local_preflight(ctx, sha)
    connect(ctx, args)
    pre(ctx, f"Token, project ref {ctx.ref}, sổ release_ledger có")
    ledger = read_ledger(ctx)
    plan = build_plan(ctx, sha, ledger, args.rerun)
    stages = stages_for(args.only)
    if rep:
        rep.before, rep.files, rep.version = ledger, plan.files, plan.version
        rep.plan = render_plan(plan, stages)
    for line in render_plan(plan, stages):
        ctx.say(line)
    block_changed(plan)  # mọi --only, trước khi lấy khoá
    if args.only == "edge" and plan.migrations:
        raise Stop(3, f"Còn {len(plan.migrations)} migration chờ: --only edge chỉ chạy khi không còn migration chờ "
                   "(thứ tự migration → Edge).")
    if not pending_count(plan, stages):
        return 0
    holder = acquire_lock(ctx)
    try:
        fresh = build_plan(ctx, sha, read_ledger(ctx), args.rerun)
        if plan_key(fresh) != plan_key(plan):
            ctx.say("")
            ctx.say("Kế hoạch đã đổi sau khi lấy khoá (máy khác vừa ghi sổ?). Kế hoạch mới:")
            for line in render_plan(fresh, stages):
                ctx.say(line)
            if not ask_yes(ctx, "Tiếp tục theo kế hoạch mới? [y/N] "):
                raise Stop(1, "Dừng: kế hoạch đổi sau khi lấy khoá và người dùng không tiếp tục.")
            if rep:
                rep.plan = rep.plan + ["", "Kế hoạch mới sau khi lấy khoá:"] + render_plan(fresh, stages)
        block_changed(fresh)
        plan = fresh
        if not pending_count(plan, stages):
            ctx.say("Không còn việc chờ sau khi lấy khoá.")
            return 0
        ask_tests(ctx, plan)
        for stage in stages:
            RUNNERS[stage](ctx, plan)
        skipped = [STAGE_LABELS[stage] for stage in STAGES if stage not in stages]
        ctx.say("")
        if skipped:
            ctx.say(f"Xong chặng {', '.join(STAGE_LABELS[stage] for stage in stages)} (đã chạy, xác minh, ghi sổ); "
                    f"CHƯA chạy: {', '.join(skipped)} (do --only {args.only}).")
        else:
            ctx.say("Xong: mọi mục đã chạy, xác minh và ghi sổ.")
        return 0
    finally:
        release_lock(ctx, holder)


def ask_extension_version(ctx: Ctx) -> str:
    for _attempt in range(2):
        value = ctx.ask("Bản Extension đang chạy trên các máy Admin (x.y.z; để trống = chưa ghi dòng extension): ").strip()
        if not value or live.EXT_VERSION.match(value):
            return value
        warn(ctx, f"sai dạng x.y.z: {value!r}.")
    warn(ctx, "bỏ qua dòng extension (chưa ghi).")
    return ""


def migration_rows(ledger: dict) -> int:
    return sum(1 for kind, name in ledger if kind == "migration" and is_migration(str(name)))


def existing_migrations(ctx: Ctx) -> int:
    """Số dòng migration đã có trong sổ; 0 khi bảng release_ledger chưa có."""
    try:
        exists = first_value(ctx.query(live.select_only(LEDGER_EXISTS_SQL)))
        return migration_rows(read_ledger(ctx)) if exists is True else 0
    except ApiError as error:
        raise Stop(3, f"Không đọc được Supabase (project {ctx.ref}): {error}") from None


def init_flow(ctx: Ctx, args) -> int:
    rep = ctx.report
    sha = head_sha(ctx)                      # ghim commit trước preflight, như --apply
    if rep:
        rep.sha = sha
    local_preflight(ctx, sha)
    connect(ctx, args, need_ledger=False)
    pre(ctx, f"Token, project ref {ctx.ref}")
    names = head_sql_files(ctx, sha)
    if LEDGER_FILE not in names:
        raise Stop(3, f"supabase/{LEDGER_FILE} chưa có ở HEAD: commit tệp rồi chạy lại --init.")
    existing = existing_migrations(ctx)
    if existing:
        raise Stop(3, f"--init chỉ chạy một lần: sổ đã có {existing} dòng migration; tệp mới chạy bằng --apply (xem --status).")
    files = [(name, head_bytes(ctx, sha, f"supabase/{name}")) for name in names]
    texts = [(name, raw.decode("utf-8-sig", errors="replace")) for name, raw in files]
    version, manifest_sha = head_version(ctx, sha)
    slugs = head_edge_slugs(ctx, sha)
    _expected, per_file = live.expected_objects(texts)
    unchecked = [name for name, _sql in texts if not per_file.get(name)]
    summary = [f"--init ở HEAD {sha[:7]}: chạy supabase/{LEDGER_FILE}; ghi nhận {len(names)} tệp migration (gồm {LEDGER_FILE}) "
               f"và Edge {', '.join(slugs) or 'không'} là đã chạy; hỏi bản Extension đang chạy trên các máy."]
    if unchecked:
        summary.append(f"{len(unchecked)} tệp không có đối tượng để kiểm (ghi nhận \"đã chạy\" chỉ theo xác nhận SEED): "
                       + ", ".join(unchecked))
    if rep:
        rep.files, rep.version, rep.plan = texts, version, summary
    for line in summary:
        ctx.say(line)
    if ctx.ask("Gõ SEED để tạo sổ và ghi nhận (Enter để dừng): ").strip() != "SEED":
        raise Stop(1, "Không gõ SEED: không làm gì.")
    ledger_sql = dict(texts)[LEDGER_FILE]
    try:
        ctx.query(ledger_sql)
    except ApiError as error:
        if error.unknown:
            raise Stop(1, f"KẾT QUẢ CHƯA RÕ: chạy {LEDGER_FILE} lỗi ({error}); máy chủ có thể đã tạo bảng release_ledger. "
                       "Xem --status rồi chạy lại --init (tệp idempotent).", title=f"KẾT QUẢ CHƯA RÕ: {LEDGER_FILE}") from None
        raise Stop(1, f"Chạy {LEDGER_FILE} bị từ chối: {error} (giao dịch: database không đổi).") from None
    checks = parse_header(ledger_sql).kiem
    for check in checks:
        ok, detail = run_kiem(ctx, check)
        if not ok:
            raise Stop(1, f"{LEDGER_FILE}: -- kiem không trả true ({detail}).")
    step(ctx, f"Chạy {LEDGER_FILE}", "đạt", f"-- kiem {len(checks)}/{len(checks)}")
    holder = acquire_lock(ctx)
    try:
        before = read_ledger(ctx)
        if rep:
            rep.before = before
        seeded = migration_rows(before)
        if seeded:
            raise Stop(3, f"--init chỉ chạy một lần: máy khác vừa ghi {seeded} dòng migration vào sổ; xem --status.")
        missing = live.missing_by_file(per_file, db_objects(db_status(ctx)))
        if missing:
            listed = "\n".join(f"  - {name}: thiếu {', '.join(miss)}" for name, miss in sorted(missing.items()))
            raise Stop(3, "live_status còn tệp thiếu đối tượng trên DB — chạy các tệp đó trước (apply_supabase_sql.py) "
                       f"rồi --init lại:\n{listed}")
        step(ctx, "Đối chiếu live_status", "đạt", f"{len(texts)} tệp không thiếu đối tượng")
        rows = [("migration", name, content_sha(raw), sha[:7], "init") for name, raw in files]
        deployed = {fn.get("slug"): fn for fn in ctx.edge_list() if isinstance(fn, dict)}
        for slug in slugs:
            fn = deployed.get(slug)
            if not fn:
                warn(ctx, f"Edge {slug} chưa có trên Supabase: không ghi; --apply sẽ deploy.")
                continue
            _code, last = ctx.git("log", "-1", "--format=%ct", sha, "--", f"supabase/functions/{slug}")
            last = last.strip()
            if last.isdigit() and ms_of(fn.get("updated_at")) / 1000 < int(last):
                warn(ctx, f"Edge {slug}: bản đang chạy (bản {fn.get('version')}, deploy {vn(fn.get('updated_at'))}) cũ hơn commit cuối "
                          f"của thư mục hàm ({vn(int(last))}).")
                typed = ctx.ask(f"Gõ {slug} nếu chắc bản đang chạy là nguồn HEAD (Enter = không ghi, --apply sẽ deploy lại): ").strip()
                if typed != slug:
                    ctx.say(f"Edge {slug}: không ghi nhận.")
                    continue
            rows.append(("edge", slug, content_sha(head_bytes(ctx, sha, edge_rel(slug))), sha[:7], f"v{fn.get('version')} (init)"))
        show_devices(ctx, version)
        running = ask_extension_version(ctx)
        if running:
            rows.append(("extension", EXT_NAME, manifest_sha if running == version else None, sha[:7], running))
        refresh_lock(ctx)
        try:
            written = ctx.query(seed_sql(rows, ctx.holder))
        except ApiError as error:
            if error.unknown:
                raise Stop(1, f"KẾT QUẢ CHƯA RÕ: ghi sổ lỗi ({error}); sổ có thể đã ghi. Xem --status "
                           "(--init lại sẽ dừng nếu sổ đã có dòng).", title="KẾT QUẢ CHƯA RÕ: ghi sổ --init") from None
            raise Stop(1, f"Ghi sổ bị từ chối: {error} (sổ đã tạo, chưa ghi nhận; --init lại an toàn).") from None
        count = len(written) if isinstance(written, list) else 0
        step(ctx, "Ghi nhận sổ", "đạt", f"{count}/{len(rows)} dòng mới; dòng đã có giữ nguyên")
        done(ctx, f"--init ghi {count}/{len(rows)} dòng")
        ctx.say(f"Đã ghi {count}/{len(rows)} dòng vào sổ (dòng đã có giữ nguyên).")
        return 0
    finally:
        release_lock(ctx, holder)


ACCEPT_DIFF_LINES = 40


def show_accept(ctx: Ctx, plan: Plan, change: Changed) -> None:
    new_text = dict(plan.files)[change.name]
    ctx.say("")
    ctx.say(f"── --accept {change.name}: sổ {short(change.ledger_sha)} (commit {change.commit or '?'}) → HEAD {short(change.sha)} "
            f"({plan.short})")
    for line in change.stat:
        ctx.say(f"  {line.strip()}")
    if change.old is None:
        warn(ctx, f"không đọc được bản cũ (commit {change.commit or '?'}): không so được — coi như KHÁC nội dung SQL.")
    else:
        diff = list(difflib.unified_diff(change.old.replace("\r\n", "\n").splitlines(), new_text.replace("\r\n", "\n").splitlines(),
                                         f"{change.commit}:supabase/{change.name}", f"{plan.short}:supabase/{change.name}",
                                         n=1, lineterm=""))
        for line in diff[:ACCEPT_DIFF_LINES]:
            ctx.say(f"  {line}")
        if len(diff) > ACCEPT_DIFF_LINES:
            ctx.say(f"  … còn {len(diff) - ACCEPT_DIFF_LINES} dòng (git diff {change.commit}..{plan.short} -- supabase/{change.name})")
    if change.comment_only:
        ctx.say("Chỉ khác chú thích: SQL chạy trên database không đổi.")
    else:
        warn(ctx, f"phần sửa này KHÔNG được chạy trên database: --accept chỉ ghi sổ. Muốn đưa phần sửa lên thì dùng "
                  f"--apply --rerun {change.name}.")


def accept_flow(ctx: Ctx, args) -> int:
    """--accept <tệp>: ghi nhận bản HEAD của MỘT tệp đã sửa sau khi chạy là đã lên; KHÔNG chạy SQL, không đụng Edge / Extension / push."""
    rep = ctx.report
    name = migration_arg(args.accept, "--accept")
    sha = head_sha(ctx)
    if rep:
        rep.sha = sha
    local_preflight(ctx, sha)
    connect(ctx, args)
    pre(ctx, f"Token, project ref {ctx.ref}, sổ release_ledger có")
    holder = acquire_lock(ctx)  # --accept cũng giữ khoá
    try:
        ledger = read_ledger(ctx)
        plan = build_plan(ctx, sha, ledger)
        if rep:
            rep.before, rep.files, rep.version = ledger, plan.files, plan.version
        row = ledger.get(("migration", name))
        if name not in plan.hashes:
            raise Stop(2, f"--accept {name}: không có supabase/{name} ở HEAD {plan.short}.")
        if row is None:
            raise Stop(2, f"--accept {name}: tệp không có trong sổ — chạy bằng --apply.")
        if row.get("sha256") == plan.hashes[name]:
            raise Stop(2, f"--accept {name}: tệp không đổi so với sổ, không có gì để ghi nhận.")
        change = next(item for item in plan.changed if item.name == name)
        new_text = dict(plan.files)[name]
        if rep:
            rep.plan = [f"--accept {name}: ghi nhận bản HEAD {plan.short} (sha {short(change.sha)}) là đã lên, KHÔNG chạy SQL; "
                        f"bản trong sổ {short(change.ledger_sha)} (commit {change.commit or '?'}); "
                        + ("chỉ khác chú thích." if change.comment_only else "KHÁC nội dung SQL hoặc không so được.")]
        show_accept(ctx, plan, change)
        typed = ctx.ask(f"Gõ nguyên tên tệp {name} để ghi nhận bản HEAD {plan.short} là ĐÃ LÊN (KHÔNG chạy SQL), Enter để dừng: ").strip()
        if typed != name:
            raise Stop(1, f"Không gõ đúng tên {name}: không ghi gì.")
        refresh_lock(ctx)
        old_note = str(row.get("note") or "").strip()
        note = (f"{old_note}; accept {plan.short}" if old_note else "accept")[-500:]
        try:
            record(ctx, plan, "migration", name, change.sha, note)
        except ApiError as error:
            state = "kết quả ghi sổ CHƯA RÕ (có thể đã ghi — xem --status)" if error.unknown else "sổ chưa đổi"
            raise Stop(1, f"--accept {name}: ghi sổ lỗi ({error}); {state}.", title=f"--accept {name}: chưa ghi sổ") from None
        step(ctx, f"--accept {name}", "đạt", f"sổ {short(change.ledger_sha)} → {short(change.sha)}, note {note!r}, không chạy SQL")
        done(ctx, f"accept {name} (không chạy SQL)")
        ctx.say(f"Đã ghi nhận {name} = bản HEAD {plan.short} (sha {short(change.sha)}); không chạy SQL nào.")
        return 0
    finally:
        release_lock(ctx, holder)


# ===================================================================== biên bản
def render_report(info: dict) -> str:
    lines = [f"# Biên bản phát hành {info['title']} — `release.py --{info['mode']}`", "",
             f"- Kết quả: {info['result']}",
             f"- HEAD: `{info['head'] or '?'}`; máy: `{info['holder'] or '?'}`; project: `{info['ref'] or '?'}`", "",
             "## Preflight", ""] + (info["preflight"] or ["- (chưa tới)"]) + [""]
    lines += ["## Kế hoạch", "", "```"] + (info["plan"] or ["(chưa dựng)"]) + ["```", ""]
    lines += ["## Các bước", ""] + (info["steps"] or ["- (không có bước nào)"]) + [""]
    lines += ["## Sổ trước", ""] + info["before"] + [""]
    lines += ["## Sổ sau", ""] + info["after"] + [""]
    lines += [info["live"].rstrip(), ""]
    lines += ["## Dòng RULES.md (lead chép, sửa câu chữ nếu cần)", "", info["rules"], ""]
    return "\n".join(lines)


def live_data(ctx: Ctx, rep: Report) -> dict:
    """Dữ liệu cho live_status.render, đọc như live_status.py nhưng từ HEAD và qua Ctx."""
    sha = rep.sha
    _c, head = ctx.git("log", "-1", "--format=%h %s", sha)
    _c, origin = ctx.git("rev-parse", "--short", "origin/main")
    _c, counts = ctx.git("rev-list", "--left-right", "--count", f"{sha}...origin/main")
    parts = counts.split()
    try:
        agent = head_bytes(ctx, sha, AGENT_VERSION).decode("utf-8", "replace").strip()
    except Stop:
        agent = "?"
    _expected, per_file = live.expected_objects(rep.files)
    status = db_status(ctx)
    missing = live.missing_by_file(per_file, db_objects(status))
    data = {
        "now": ctx.now().strftime("%d/%m/%Y %H:%M"),
        "git": {"head": head.strip(), "origin": origin.strip(),
                "ahead": int(parts[0]) if parts and parts[0].isdigit() else 0,
                "behind": int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0},
        "extension": rep.version or "?", "agent_version": agent,
        "migrations": {"ok": sum(1 for name, _sql in rep.files if name not in missing), "missing": missing},
        "edge": [], "cron": status.get("cron") or [],
        "agents": [{**a, "last_seen": vn(a.get("last_seen"))} for a in status.get("agents") or []],
        "leases": [{"kind": l.get("kind"), "last_finished": vn(l.get("last_finished"))} for l in status.get("leases") or []],
    }
    for fn in sorted(ctx.edge_list(), key=lambda r: str(r.get("slug", ""))):
        _c, last = ctx.git("log", "-1", "--format=%ct", sha, "--", f"supabase/functions/{fn.get('slug')}")
        last = last.strip()
        data["edge"].append({"slug": fn.get("slug"), "version": fn.get("version"), "deployed": vn(fn.get("updated_at")),
                             "commit": vn(int(last)) if last.isdigit() else "chưa có trong git",
                             "stale": last.isdigit() and ms_of(fn.get("updated_at")) / 1000 < int(last)})
    try:
        info = first_value(ctx.query(live.select_only(live.DEVICES_SQL)))
        info = json.loads(info) if isinstance(info, str) else (info or {})
        data["devices"] = {"min": info.get("min_extension") or {},
                           "rows": [{**r, "last_seen": vn(r.get("last_seen"))} for r in info.get("devices") or []]}
    except ApiError:
        data["devices"] = {"missing": True}
    return data


class Report:
    """Biên bản --apply / --init: outputs/release/release-<yyyymmdd-hhmm>.md (ngoài git)."""

    def __init__(self, ctx: Ctx, mode: str):
        self.ctx, self.mode = ctx, mode
        self.started = ctx.now()
        self.preflight: list[str] = []
        self.plan: list[str] = []
        self.steps: list[str] = []
        self.done: list[str] = []
        self.before: dict | None = None
        self.sha = ""
        self.files: list[tuple[str, str]] | None = None
        self.version = ""

    def step(self, title: str, result: str, measure: str = "") -> None:
        moment = self.ctx.now().strftime("%H:%M:%S")
        self.steps.append(f"- {moment} {title}: {result}" + (f" ({measure})" if measure else ""))

    def finish(self, code: int) -> Path | None:
        ctx = self.ctx
        before = render_ledger(self.before) if self.before is not None else ["- (chưa đọc)"]
        after = ["- (không đọc: chưa kết nối Supabase)"]
        live_text = "## Trạng thái lên thật\n\n- Không dựng: chưa kết nối Supabase hoặc chưa đọc HEAD."
        if ctx.token and ctx.ref:
            try:
                now_ledger = read_ledger(ctx)
                after = render_ledger(now_ledger) + (["", "Thay đổi trong lượt này:"] + ledger_changes(self.before, now_ledger)
                                                     if self.before is not None else [])
            except (ApiError, ValueError) as error:
                after = [f"- Không đọc được sổ: {error}"]
            if self.sha and self.files is not None:
                try:
                    live_text = live.render(live_data(ctx, self))
                except (ApiError, Stop, ValueError, KeyError, TypeError) as error:
                    live_text = f"## Trạng thái lên thật\n\n- Không dựng được: {error}"
        stamp = self.started.strftime("%Y%m%d-%H%M")
        path = ctx.out_dir / f"release-{stamp}.md"
        number = 2
        while path.exists():
            path = ctx.out_dir / f"release-{stamp}-{number}.md"
            number += 1
        result = "ĐẠT" if code == 0 else f"DỪNG (mã {code})"
        rules = (f"- [N{stamp}] **{self.started:%d/%m/%Y} — Phát hành bằng `release.py --{self.mode}` (HEAD `{self.sha[:7] or '?'}`): "
                 f"{result}.** {'; '.join(self.done) or 'không chạy mục nào'}. Biên bản: `outputs/release/{path.name}`.")
        text = render_report({
            "title": self.started.strftime("%d/%m/%Y %H:%M"), "mode": self.mode, "result": result, "head": self.sha[:7],
            "holder": ctx.holder, "ref": ctx.ref, "preflight": self.preflight, "plan": self.plan, "steps": self.steps,
            "before": before, "after": after, "live": live_text, "rules": rules,
        })
        try:
            ctx.write_text(path, redact(text, ctx.token))
        except OSError as error:
            warn(ctx, f"không ghi được biên bản {path}: {error}")
            return None
        ctx.say(f"Biên bản: {path}")
        return path


def run_write(ctx: Ctx, args, mode: str) -> int:
    """--apply / --init / --accept: luôn ghi biên bản, kể cả khi dừng."""
    ctx.report = Report(ctx, mode)
    code = 1
    try:
        code = {"apply": apply_flow, "init": init_flow, "accept": accept_flow}[mode](ctx, args)
    except Stop as stop:
        ctx.say(stop.message, tone="warn" if stop.code else "")
        step(ctx, "Dừng", (stop.title or first_line(stop.message))[:200])
        code = stop.code
    except ApiError as error:
        what = "KẾT QUẢ CHƯA RÕ (máy chủ có thể đã ghi)" if error.unknown else "Supabase từ chối"
        ctx.say(f"{what}: {error}", tone="warn")
        step(ctx, "Dừng", f"{what}: {str(error)[:200]}")
        code = 1
    except KeyboardInterrupt:
        ctx.say("Đã dừng (Ctrl+C).", tone="warn")
        step(ctx, "Dừng", "Ctrl+C")
        code = 1
    except Exception as error:  # noqa: BLE001 — lỗi lạ vẫn vào biên bản và thoát mã 1, không traceback trần
        ctx.say(f"Lỗi không lường trước ({type(error).__name__}): {error}", tone="warn")
        step(ctx, "Dừng", f"lỗi không lường trước: {type(error).__name__}: {str(error)[:150]}")
        code = 1
    finally:
        try:
            ctx.report.finish(code)
        except Exception as error:  # noqa: BLE001
            warn(ctx, f"không dựng được biên bản ({type(error).__name__}: {error}).")
    return code


# ===================================================================== dòng lệnh
class Parser(argparse.ArgumentParser):
    TRANSLATE = (("unrecognized arguments", "cờ không nhận"), ("not allowed with argument", "không dùng cùng"),
                 ("invalid choice", "giá trị không hợp lệ"), ("expected one argument", "cần một giá trị"),
                 ("choose from", "chọn trong"))

    def error(self, message: str):
        text = message
        for english, vietnamese in self.TRANSLATE:
            text = text.replace(english, vietnamese)
        hint = ""
        if re.search(r"(^|\s)(--yes|-y)(\s|$)", message.split(":", 1)[-1]):
            hint = "\nKhông có cờ --yes: --apply / --init hỏi từng cổng trên terminal thật."
        self.print_usage(sys.stderr)
        self.exit(2, f"release.py: lỗi cờ: {text}{hint}\n")


def parse_args(argv):
    parser = Parser(prog="release.py", allow_abbrev=False,
                    description="Phát hành: migration → Edge → Reload Extension → push (không cờ = --plan, chỉ đọc).")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--plan", dest="mode", action="store_const", const="plan", help="chỉ đọc: in việc chờ (mặc định)")
    mode.add_argument("--apply", dest="mode", action="store_const", const="apply", help="chạy tuần tự, mỗi cổng gõ y")
    mode.add_argument("--status", dest="mode", action="store_const", const="status", help="in sổ release_ledger + khoá")
    mode.add_argument("--init", dest="mode", action="store_const", const="init", help="tạo sổ, ghi nhận bản đang chạy (gõ SEED)")
    mode.add_argument("--accept", metavar="TỆP.sql",
                      help="ghi nhận một tệp đã sửa sau khi chạy là đã lên, KHÔNG chạy SQL (chỉ khi chỉ sửa chú thích; gõ tên tệp)")
    parser.add_argument("--only", choices=("migrations", "edge"), help="chỉ một chặng (tệp migration đã sửa sau khi chạy vẫn chặn)")
    parser.add_argument("--rerun", metavar="TỆP.sql",
                        help="chạy lại một tệp đã có trong sổ mà sha khác (tệp đã sửa khác vẫn chặn --apply)")
    parser.add_argument("--project-ref", default="", help="ghi đè project ref lấy từ SUPABASE_URL")
    args = parser.parse_args(argv)
    if args.accept and (args.rerun or args.only):
        parser.error("--accept không dùng cùng --rerun / --only")
    if args.rerun and args.mode not in (None, "plan", "apply"):
        parser.error("--rerun chỉ dùng với --plan / --apply")
    if args.only and args.mode not in (None, "plan", "apply"):
        parser.error("--only chỉ dùng với --plan / --apply")
    if args.rerun and args.only == "edge":
        parser.error("--rerun không dùng cùng --only edge")
    return args


def main(argv=None, ctx: Ctx | None = None) -> int:
    ctx = ctx or Ctx()
    try:
        args = parse_args(argv)
    except SystemExit as exit_:
        return exit_.code if isinstance(exit_.code, int) else 2
    mode = "accept" if args.accept else (args.mode or "plan")
    if mode in ("apply", "init", "accept") and not ctx.isatty():
        ctx.say(f"--{mode} cần terminal thật (gõ y / tên tệp ở từng cổng); không có cờ --yes. Chạy lại trong cửa sổ terminal.")
        return 2
    if mode == "accept":
        try:
            migration_arg(args.accept, "--accept")
        except Stop as stop:
            ctx.say(stop.message)
            return stop.code
    if mode in ("apply", "init", "accept"):
        return run_write(ctx, args, mode)
    try:
        return run_plan(ctx, args) if mode == "plan" else run_status(ctx, args)
    except Stop as stop:
        ctx.say(stop.message)
        return stop.code
    except ApiError as error:
        ctx.say(f"Lỗi Supabase: {error}")
        return 1
    except KeyboardInterrupt:
        ctx.say("Đã dừng (Ctrl+C).")
        return 1
    except Exception as error:  # noqa: BLE001 — chỉ đọc, nhưng vẫn không để traceback trần
        ctx.say(f"Lỗi không lường trước ({type(error).__name__}): {error}")
        return 1


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.exit(main())
