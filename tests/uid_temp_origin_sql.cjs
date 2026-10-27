// Migration supabase/uid_temp_origin_v1.sql (26/10/2026, kế hoạch docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md việc 2.1):
// UID tạm lưu phiếu gốc (cột uid_temp_rows.origin jsonb). Không có Postgres cục bộ: kiểm tĩnh văn bản SQL.
//   * đầu tệp có `-- kiem:` (một câu SELECT chỉ đọc) và khối `-- Rút lui`; begin/commit + notify pgrst; không lệnh xoá ở cấp cao nhất;
//   * cột origin: add column if not exists, chỉ object hoặc null, giới hạn kích thước;
//   * uid_temp_save chép từ bản gốc uid_temp_snapshot_v1.sql, chỉ đổi tối thiểu: kiểu origin (object / null), giới hạn 8.000 ký tự, ghi cột;
//   * uid_temp_overview chép từ bản đang chạy backend_hygiene_v1.sql (che email createdBy), trả thêm origin và che origin.by cho người ngoài Admin;
//   * giữ chữ ký, SECURITY DEFINER + search_path '', quyền như bản gốc (save chỉ authenticated, overview anon + authenticated).
//   node tests/uid_temp_origin_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const FILE = "supabase/uid_temp_origin_v1.sql";
assert.ok(fs.existsSync(path.join(root, FILE)), `chưa có migration thêm cột origin (${FILE})`);
const raw = read(FILE);
const stripComments = s => s.replace(/--[^\n]*/g, "");
const sql = stripComments(raw);
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const lines = s => s.split("\n").map(l => l.trim()).filter(Boolean);
const fnOf = (text, name, label) => {
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${label}: thiếu hàm ${name}`);
  const open = text.indexOf("$$", start), close = text.indexOf("$$", open + 2);
  assert.ok(open > start && close > open, `${label}: không tách được thân ${name}`);
  return { head: text.slice(start, open), body: text.slice(open + 2, close) };
};

// ---------- Đầu tệp: -- kiem: + Rút lui (như scripts/release.py parse_header) ----------
const header = [];
for (const line of raw.split("\n")) { const t = line.trim(); if (t.startsWith("--")) header.push(t); else if (t) break; }
const kiem = header.map(l => l.match(/^--\s*kiem\s*:\s*(\S.*?)\s*$/i)).filter(Boolean).map(m => m[1]);
assert.equal(kiem.length, 1, "đầu tệp có đúng một dòng -- kiem:");
assert.match(kiem[0], /^select\b/i, "-- kiem: là một câu SELECT");
assert.doesNotMatch(kiem[0], /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i, "-- kiem: không có từ khoá ghi (live_status.select_only)");
assert.ok(!kiem[0].replace(/;\s*$/, "").includes(";"), "-- kiem: chỉ một câu");
for (const want of ["uid_temp_rows", "origin", "uid_temp_save", "uid_temp_overview"]) assert.ok(kiem[0].includes(want), `-- kiem: kiểm ${want}`);
const back = header.findIndex(l => /^--\s*r[uú]t\s+lui\b/i.test(l));
assert.ok(back >= 0, "đầu tệp có khối -- Rút lui");
assert.match(header[back + 1] || "", /^--(?: {2,}|\t)\s*\S/, "khối Rút lui có dòng lệnh thụt vào");
assert.match(raw, /^-- Lệnh: python scripts\/apply_supabase_sql\.py supabase\/uid_temp_origin_v1\.sql$/m, "ghi lệnh chạy, không cần --allow-destructive");

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "chạy trong begin; … commit;");
assert.match(sql, /notify pgrst,\s*'reload schema';/, "nạp lại schema PostgREST");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|view|type|index|function|trigger|policy|column)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\balter\s+table\b[^;]*\bdrop\b/i, "ALTER TABLE … DROP"],
]) assert.ok(!re.test(topLevel), `không có lệnh xoá ở cấp cao nhất (${label})`);

// ---------- Cột origin ----------
const col = topLevel.match(/alter table public\.uid_temp_rows\s+add column if not exists origin jsonb([^;]*);/);
assert.ok(col, "thêm cột uid_temp_rows.origin jsonb (if not exists, chạy lại được)");
assert.match(col[1], /check \(origin is null or \(jsonb_typeof\(origin\) = 'object' and length\(origin::text\) <= 8000\)\)/, "cột chỉ nhận object ≤ 8.000 ký tự hoặc null");

// ---------- Đúng hai hàm, giữ chữ ký + definer ----------
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created.sort(), ["uid_temp_overview", "uid_temp_save"], "chỉ thay uid_temp_save + uid_temp_overview");
const ORIGINALS = { uid_temp_save: "supabase/uid_temp_snapshot_v1.sql", uid_temp_overview: "supabase/backend_hygiene_v1.sql" };
// Số dòng bản gốc được đổi (dòng thêm mới không tính)
const MAX_CHANGED = { uid_temp_save: 3, uid_temp_overview: 1 };
const fn = {};
for (const [name, file] of Object.entries(ORIGINALS)) {
  fn[name] = fnOf(sql, name, FILE);
  const old = fnOf(stripComments(read(file)), name, file);
  assert.equal(squash(fn[name].head), squash(old.head), `${name}: giữ chữ ký, kiểu trả, security definer như ${file}`);
  assert.match(fn[name].head, /security definer set search_path = ''/, `${name}: security definer + search_path ''`);
  const now = lines(fn[name].body);
  const missing = lines(old.body).filter(l => !now.includes(l));
  assert.ok(missing.length <= MAX_CHANGED[name], `${name}: đổi ${missing.length} dòng bản gốc (tối đa ${MAX_CHANGED[name]}):\n  ${missing.join("\n  ")}`);
}

// ---------- uid_temp_save: kiểu + kích thước origin, ghi cột ----------
{
  const b = fn.uid_temp_save.body;
  assert.ok(b.indexOf("public.group_uid_admin_allowed()") < b.indexOf("origin"), "kiểm Admin trước mọi thứ");
  assert.ok(b.includes("or coalesce(jsonb_typeof(e.v->'origin'),'null') not in ('object','null')"), "origin chỉ là object hoặc null (thiếu khoá = null: Extension / web cũ)");
  assert.ok(b.includes("or length(coalesce(e.v->>'origin','')) > 8000"), "giới hạn kích thước origin");
  assert.ok(b.includes("or (jsonb_typeof(e.v->'origin') = 'object' and coalesce(jsonb_typeof(e.v->'origin'->'lines'),'array') <> 'array')"), "origin.lines (nếu có) là mảng");
  assert.match(b, /insert into public\.uid_temp_rows\(run_id, idx, wh, warehouse_name, sku, product_name, qty, source_code, mapping_id, created_by, created_at, origin\)/, "ghi cột origin");
  assert.match(b, /x\."createdAt", x\.origin\s+from jsonb_array_elements\(p_rows\) with ordinality as e\(v, o\),/, "giá trị origin lấy từ dòng");
  assert.match(b, /jsonb_to_record\(e\.v\) as x\(wh text, "warehouseName" text, sku text, "productName" text, qty numeric, "sourceCode" text, "mappingId" text, "createdBy" text, "createdAt" timestamptz, origin jsonb\)/, "đọc origin kiểu jsonb");
  for (const keep of ["'FORBIDDEN'", "pg_advisory_xact_lock(", "jsonb_array_length(p_rows) > 5000", "'INVALID_ROWS'", "'STALE_RUN'", "order by read_at desc, created_at desc, id desc limit 10", "(select auth.uid())"]) assert.ok(b.includes(keep), `uid_temp_save giữ ${keep}`);
}

// ---------- uid_temp_overview: trả origin, che email người duyệt cho người ngoài Admin ----------
{
  const b = fn.uid_temp_overview.body;
  assert.match(fn.uid_temp_overview.head, /\bstable\b/, "chỉ đọc (stable)");
  assert.doesNotMatch(b, /\b(insert|update|delete)\b/i, "không ghi");
  assert.match(b, /v_admin boolean := public\.group_uid_admin_allowed\(\);/, "kiểm Admin một lần");
  assert.ok(b.includes("'createdBy',coalesce(case when v_admin then r.created_by else split_part(r.created_by,'@',1) end,'')"), "giữ che email createdBy (backend_hygiene_v1)");
  assert.ok(b.includes("'origin',case when r.origin is null then null when v_admin or jsonb_typeof(r.origin->'by') is distinct from 'string' then r.origin else jsonb_set(r.origin,'{by}',to_jsonb(split_part(r.origin->>'by','@',1))) end"), "origin.by: người ngoài Admin chỉ thấy phần trước @");
  assert.doesNotMatch(b, /'origin',\s*r\.origin\s*[,)]/, "không trả origin thô");
}

// ---------- Quyền: như bản gốc ----------
const grants = [...sql.matchAll(/^\s*(grant|revoke)\b[^;]*;/gim)].map(m => squash(m[0]));
assert.deepEqual(grants, [
  "revoke all on function public.uid_temp_save(jsonb,jsonb) from public, anon;",
  "revoke all on function public.uid_temp_overview() from public;",
  "grant execute on function public.uid_temp_save(jsonb,jsonb) to authenticated;",
  "grant execute on function public.uid_temp_overview() to anon, authenticated;",
], "quyền giữ như uid_temp_snapshot_v1 (save chỉ authenticated, overview anon + authenticated)");
assert.match(read("supabase/snapshot_cache_v1.sql"), /return jsonb_set\(public\.uid_temp_overview\(\), '\{data,unchanged\}'/, "uid_temp_snapshot vẫn lấy dữ liệu từ uid_temp_overview (tự có origin)");

console.log("uid_temp_origin_sql: -- kiem + Rút lui, cột origin (object/null ≤ 8.000), save + overview chép bản đang chạy đổi tối thiểu, che origin.by cho người ngoài Admin, quyền như cũ — passed");
