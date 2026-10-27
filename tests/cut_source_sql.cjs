// Migration supabase/cut_source_v1.sql (26/10/2026, nguồn phiếu ADJ / IT cho từng lần Cut; kế hoạch
// docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md việc 1). Không có Postgres cục bộ: kiểm tĩnh văn bản SQL.
//   * hai hàm cũ chép từ bản đang chạy (wms_group_uid_cut_import + cut_group_uid_reconcile: backend_hygiene_v1.sql; thân Tick giúp:
//     floor_access_v1.sql), giữ chữ ký, giữ D8 (p_data_until tương lai) và che email, chỉ đổi số dòng tối thiểu;
//   * nạp Cut KHÔNG ghi đè nguồn đã có (Extension cũ gửi dòng không nguồn); RPC mới chỉ Admin, revoke rồi grant authenticated;
//   * Tick giúp bỏ Cut nguồn IT; đầu tệp có Vì sao / Tác động / -- kiem: / -- Rút lui; không lệnh xoá cấp cao nhất.
//   node tests/cut_source_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const stripComments = s => s.replace(/--[^\n]*/g, "");
const raw = read("supabase/cut_source_v1.sql");
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

// ---------- Đầu tệp: Vì sao, Tác động, -- kiem: (một câu SELECT chỉ đọc), -- Rút lui ----------
const header = [];
for (const line of raw.split("\n")) { const t = line.trim(); if (t.startsWith("--")) header.push(t); else if (t) break; }
assert.ok(header.some(l => /Vì sao/.test(l)) && header.some(l => /Tác động/.test(l)), "đầu tệp ghi Vì sao + Tác động");
const kiem = header.map(l => l.match(/^--\s*kiem\s*:\s*(\S.*?)\s*$/i)).filter(Boolean).map(m => m[1]);
assert.ok(kiem.length >= 1, "có dòng -- kiem:");
for (const k of kiem) {
  assert.match(k, /^select\b/i, "-- kiem: là câu SELECT");
  assert.ok(!/;/.test(k) && !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(k), `-- kiem: không có từ khoá ghi: ${k}`);
}
assert.ok(kiem.some(k => /source_note/.test(k) && /wms_group_uid_cut_set_source/.test(k) && /wms_group_uid_cut_unresolved/.test(k)), "-- kiem: kiểm cột + hai hàm mới");
const rollback = header.findIndex(l => /^--\s*r[uú]t\s+lui\b/i.test(l));
assert.ok(rollback >= 0 && /^--(?: {2,}|\t)\s*\S/.test(header[rollback + 1] || ""), "khối -- Rút lui có lệnh thụt vào");
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/cut_source_v1\.sql$/m, "lệnh chạy không kèm --allow-destructive");

// ---------- Khung: giao dịch, nạp lại schema, không xoá cấp cao nhất, không DO / EXECUTE động ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "begin; … commit;");
assert.ok(sql.indexOf("commit;") < sql.indexOf("notify pgrst, 'reload schema';"), "notify pgrst sau commit");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|database|view|type|index|function|trigger|policy)\b/i, "DROP"], [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"], [/\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b/i, "ALTER TABLE … DROP"],
  [/\bdo\s+\$/i, "khối DO"], [/\bexecute\s+(format|'|\$)/i, "EXECUTE động"],
]) assert.ok(!re.test(topLevel), `không có ${label} ở cấp cao nhất`);

// ---------- Năm cột nguồn (idempotent) ----------
const alter = sql.match(/alter table public\.wms_group_uid_cuts([\s\S]*?);/);
assert.ok(alter, "alter table wms_group_uid_cuts");
for (const re of [
  /add column if not exists source_type text check \(source_type is null or source_type in \('ADJ',\s*'IT'\)\)/,
  /add column if not exists source_code text check \(source_code is null or source_code ~ '\^\[0-9\]\{6,40\}\$'\)/,
  /add column if not exists source_reason text check \(source_reason is null or length\(source_reason\) <= 120\)/,
  /add column if not exists source_at timestamptz/,
  /add column if not exists source_note text check \(source_note is null or length\(source_note\) <= 200\)/,
]) assert.match(alter[1], re);
assert.match(sql, /create index if not exists wms_group_uid_cuts_unresolved_idx on public\.wms_group_uid_cuts \(cut_at\) where source_type is null;/);

// ---------- Hàm của đợt ----------
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual([...created].sort(), ["_cut_group_uid_adj_from_wms_body", "cut_group_uid_reconcile", "wms_group_uid_cut_import", "wms_group_uid_cut_set_source", "wms_group_uid_cut_unresolved"], "đúng năm hàm");
const fn = {};
for (const name of created) {
  fn[name] = fnOf(sql, name, "cut_source_v1");
  assert.match(fn[name].head, /security definer set search_path\s*=\s*''/, `${name}: security definer + search_path ''`);
}

// Bản gốc: bản đang chạy (lead đã đối chiếu: backend_hygiene_v1.sql cho import/reconcile, floor_access_v1.sql cho thân Tick giúp)
const ORIGINALS = { wms_group_uid_cut_import: "supabase/backend_hygiene_v1.sql", cut_group_uid_reconcile: "supabase/backend_hygiene_v1.sql", _cut_group_uid_adj_from_wms_body: "supabase/floor_access_v1.sql" };
const MAX_CHANGED = { wms_group_uid_cut_import: 5, cut_group_uid_reconcile: 1, _cut_group_uid_adj_from_wms_body: 1 };
const old = {};
for (const [name, file] of Object.entries(ORIGINALS)) {
  old[name] = fnOf(stripComments(read(file)), name, file);
  assert.equal(squash(fn[name].head), squash(old[name].head), `${name}: giữ nguyên chữ ký, kiểu trả như ${file}`);
  const now = lines(fn[name].body), missing = lines(old[name].body).filter(l => !now.includes(l));
  assert.ok(missing.length <= MAX_CHANGED[name], `${name}: đổi ${missing.length} dòng bản gốc (tối đa ${MAX_CHANGED[name]}):\n  ${missing.join("\n  ")}`);
}

// ---------- wms_group_uid_cut_import: giữ D8, nhận nguồn tuỳ chọn, không ghi đè nguồn đã có ----------
{
  const b = fn.wms_group_uid_cut_import.body;
  assert.match(b, /if p_data_until > now\(\) \+ interval '5 minutes' then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','INVALID_FILE'/, "D8: chặn mốc dữ liệu tương lai");
  assert.ok(b.indexOf("interval '5 minutes'") < b.indexOf("insert into public.wms_group_uid_history_imports"), "D8 trước khi ghi");
  const recordsets = [...b.matchAll(/jsonb_to_recordset\(p_rows\) as x\(([^)]*)\)/g)].map(m => m[1]);
  assert.equal(recordsets.length, 2);
  for (const r of recordsets) assert.ok(r.endsWith("warehouse text,source_type text,source_code text,source_reason text,source_at timestamptz,source_note text"), "jsonb_to_recordset có đủ năm cột nguồn");
  assert.match(b, /insert into public\.wms_group_uid_cuts as w\(group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,import_id,source_type,source_code,source_reason,source_at,source_note\)/);
  assert.match(b, /select group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,v_import,source_type,source_code,source_reason,source_at,source_note from src/);
  for (const col of ["source_type", "source_code", "source_reason", "source_at", "source_note"]) {
    assert.ok(b.includes(`${col}=case when w.source_type is null then excluded.${col} else w.${col} end`), `${col}: chỉ ghi khi dòng chưa có nguồn`);
    assert.ok(!new RegExp(`\\b${col}=excluded\\.${col}\\b`).test(b), `${col}: không ghi đè thẳng`);
  }
  assert.match(b, /is distinct from \(excluded\.qty,excluded\.remaining_qty,excluded\.sku,excluded\.cut_by,excluded\.warehouse\)\s+or \(w\.source_type is null and excluded\.source_type is not null\)/, "chỉ cập nhật khi khác (thêm: có nguồn mới cho dòng chưa nguồn)");
  assert.match(b, /btrim\(source_type\)\) not in \('ADJ','IT'\)|btrim\(source_type\) not in \('ADJ','IT'\)/, "nguồn lạ → INVALID_ROWS");
  assert.match(b, /case when nullif\(btrim\(source_type\),''\) is null then null else left\(nullif\(btrim\(source_note\),''\),200\) end as source_note/, "dòng không nguồn → mọi cột nguồn null; ghi chú ≤ 200");
}

// ---------- cut_group_uid_reconcile: giữ che email, trả nguồn trong wmsCuts ----------
{
  const b = fn.cut_group_uid_reconcile.body;
  assert.match(b, /v_admin boolean := public\.group_uid_admin_allowed\(\);/);
  assert.ok(b.includes("'by',case when v_admin then w.cut_by else split_part(w.cut_by,'@',1) end"), "người ngoài Admin chỉ thấy phần trước @");
  assert.ok(b.includes("'sourceType',w.source_type,'sourceCode',w.source_code,'sourceReason',w.source_reason"), "wmsCuts có loại, số phiếu, lý do");
  assert.ok(b.includes("'sourceNote',case when v_admin then w.source_note else regexp_replace(w.source_note,'([^[:space:]@]+)@[^[:space:]@]+','\\1','g') end"), "ghi chú: email rút về phần trước @ cho người ngoài Admin");
  const coverage = s => squash(s.slice(s.indexOf("'coverage'"), s.indexOf("'lastImport'")));
  assert.equal(coverage(b), coverage(old.cut_group_uid_reconcile.body), "coverage giữ nguyên (wms_cut_coverage dùng cùng biểu thức)");
}

// ---------- RPC mới chỉ Admin ----------
for (const [name, sig, params] of [["wms_group_uid_cut_set_source", "jsonb", "p_rows jsonb"], ["wms_group_uid_cut_unresolved", "integer", "p_days integer default 30"]]) {
  const f = fn[name];
  assert.match(squash(f.head), new RegExp(`^create or replace function public\\.${name}\\(${params}\\) returns jsonb language plpgsql (volatile|stable) security definer set search_path = '' as$`));
  assert.match(f.body, /^\s*declare[\s\S]*?begin\s+if not public\.group_uid_admin_allowed\(\) then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','FORBIDDEN'/, `${name}: kiểm Admin đầu tiên`);
  const revoke = `revoke all on function public.${name}(${sig}) from public, anon, authenticated;`, grant = `grant execute on function public.${name}(${sig}) to authenticated;`;
  assert.ok(sql.includes(revoke) && sql.includes(grant) && sql.indexOf(revoke) < sql.indexOf(grant), `${name}: revoke public/anon/authenticated rồi grant authenticated`);
}
{
  const b = fn.wms_group_uid_cut_set_source.body;
  assert.match(fn.wms_group_uid_cut_set_source.head, /\bvolatile\b/);
  assert.match(b, /jsonb_array_length\(p_rows\) not between 1 and 5000/, "1–5.000 dòng");
  assert.match(b, /coalesce\(btrim\(source_type\),''\) not in \('ADJ','IT'\)/, "nguồn phải ADJ / IT (không ghi null)");
  assert.match(b, /coalesce\(btrim\(source_code\),''\) !~ '\^\[0-9\]\{6,40\}\$'/, "số phiếu bắt buộc, chữ số");
  const upd = b.match(/update public\.wms_group_uid_cuts w\s+set ([^\n]*)\s+from src s\s+where ([^\n]*)/);
  assert.ok(upd, "update theo khoá");
  assert.deepEqual(upd[1].split(",").map(s => s.trim().split("=")[0]), ["source_type", "source_code", "source_reason", "source_at", "source_note"], "chỉ ghi cột nguồn");
  assert.equal(squash(upd[2]), "w.group_uid_code=s.group_uid_code and w.cut_at=s.cut_at and w.source_type is null", "khoá (group_uid_code, cut_at), chỉ dòng chưa có nguồn");
  assert.match(b, /'updated',v_updated,'skipped',v_total-v_updated/);
}
{
  const b = fn.wms_group_uid_cut_unresolved.body;
  assert.match(fn.wms_group_uid_cut_unresolved.head, /\bstable\b/);
  assert.match(b, /least\(greatest\(coalesce\(p_days,30\),1\),60\)/, "p_days kẹp 1–60");
  assert.match(b, /jsonb_build_object\('groupUid',q\.group_uid_code,'cutAt',q\.cut_at,'qty',q\.qty,'sku',q\.sku\)/, "trả mã, giờ, số lượng, SKU");
  assert.match(b, /where w\.source_type is null and w\.cut_at >= v_since and w\.sku is not null\s+order by w\.cut_at desc limit 5000/, "Cut chưa nguồn trong khoảng, tối đa 5.000 mới nhất");
  assert.match(b, /'truncated',v_count > 5000/);
  assert.match(b, /jsonb_build_object\('sku',u\.sku,'type',u\.source_type,'at',u\.source_at\)/, "phiếu đã gán: SKU + loại + giờ phiếu");
  assert.match(b, /w\.source_type is not null and w\.source_at >= v_since - interval '1 day'/);
}

// ---------- Tick giúp: bỏ Cut nguồn IT; thân còn lại giữ nguyên ----------
{
  const b = fn._cut_group_uid_adj_from_wms_body.body;
  assert.ok(b.includes("join public.wms_group_uid_cuts w on w.group_uid_code = c.group_uid_code and w.cut_at >= c.cut_at and w.source_type is distinct from 'IT'"), "Tick giúp chỉ tính Cut không phải IT (Cut chưa rõ vẫn tính như cũ)");
  assert.equal(squash(b.replace(" and w.source_type is distinct from 'IT'", "")), squash(old._cut_group_uid_adj_from_wms_body.body), "chỉ thêm điều kiện nguồn");
  assert.ok(sql.includes("revoke all on function public._cut_group_uid_adj_from_wms_body(text, text[]) from public, anon, authenticated;"), "thân nội bộ vẫn không cấp cho ai");
}

// ---------- Quyền: chỉ cấp authenticated cho hai RPC mới ----------
assert.deepEqual([...sql.matchAll(/^\s*grant\b[^;]*;/gim)].map(m => squash(m[0])).sort(), [
  "grant execute on function public.wms_group_uid_cut_set_source(jsonb) to authenticated;",
  "grant execute on function public.wms_group_uid_cut_unresolved(integer) to authenticated;",
]);
assert.ok(!/\bto\s+(anon|public)\b/i.test(sql), "không cấp gì cho anon / public");

console.log("cut_source_sql: 5 cột nguồn, import giữ D8 + không ghi đè nguồn, reconcile giữ che email + trả nguồn (ghi chú che email), set_source / unresolved chỉ Admin (revoke rồi grant authenticated), Tick giúp bỏ Cut IT, đầu tệp kiem + Rút lui, không lệnh xoá: PASS");
