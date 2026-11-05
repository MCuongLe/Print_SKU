// Migration supabase/xa_vai_it_v1.sql (05/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md): đợt xả vải theo phiếu IT.
// Kiểm tĩnh văn bản SQL (máy không có Postgres).
//   node tests/xa_vai_it_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const FILE = "supabase/xa_vai_it_v1.sql";
assert.ok(fs.existsSync(path.join(root, FILE)), `thiếu tệp migration ${FILE}`);
const raw = fs.readFileSync(path.join(root, FILE), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const fnBody = name => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `có hàm ${name}`);
  const open = sql.indexOf("$$", start), close = sql.indexOf("$$", open + 2);
  return { head: squash(sql.slice(start, open)), body: squash(sql.slice(open + 2, close)) };
};

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "một giao dịch begin; … commit;");
assert.ok(sql.indexOf("commit;") < sql.indexOf("notify pgrst, 'reload schema';"), "notify pgrst sau commit");
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_it_v1\.sql$/m, "lệnh chạy không kèm --allow-destructive");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|database|view|type|index|function|trigger|policy)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b/i, "ALTER TABLE … DROP"],
]) assert.ok(!re.test(topLevel), `không có lệnh xoá ở cấp cao nhất (${label})`);
assert.ok(!/\bdelete\s+from\b/i.test(sql), "nạp lại không gỡ UID cũ: không có delete ở đâu");

const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem, "có dòng -- kiem:");
assert.match(kiem[1], /^select /i);
assert.ok(!/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(kiem[1]), "-- kiem: chỉ đọc");
for (const part of ["public.xa_vai_it_batches", "public.xa_vai_it_uids", "relrowsecurity", "to_regprocedure('public.xa_vai_it_save(jsonb)')",
  "not has_function_privilege('anon', 'public.xa_vai_it_save(jsonb)'", "has_function_privilege('anon', 'public.xa_vai_it_of_uids(text[])'"])
  assert.ok(kiem[1].includes(part), `-- kiem: có ${part}`);
assert.match(raw, /^-- Rút lui[^\n]*--allow-destructive/m, "khối -- Rút lui ghi rõ --allow-destructive");
for (const sig of ["xa_vai_it_of_uids\\(text\\[\\]\\)", "xa_vai_it_get\\(text\\)", "xa_vai_it_list\\(integer\\)", "xa_vai_it_save\\(jsonb\\)"])
  assert.match(raw, new RegExp(`^--\\s+drop function if exists public\\.${sig};$`, "m"));

// ---------- Bảng ----------
for (const t of ["xa_vai_it_batches", "xa_vai_it_uids"]) {
  assert.match(sql, new RegExp(`create table if not exists public\\.${t} \\(`), `tạo bảng ${t} (if not exists)`);
  assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security;`), `RLS ${t}`);
  assert.match(sql, new RegExp(`revoke all on table public\\.${t} from public, anon, authenticated;`), `thu quyền bảng ${t}`);
}
assert.ok(!/create policy/i.test(sql), "không policy");
assert.ok(!/grant [^;]*on table[^;]*to (anon|authenticated)/i.test(sql), "không grant bảng cho anon / authenticated");
const batches = squash(sql.match(/create table if not exists public\.xa_vai_it_batches \(([\s\S]*?)\n\);/)[1]);
for (const col of ["it_number text primary key check (it_number ~ '^[0-9]{16}$')", "item_code text not null check (item_code ~ '^[0-9A-Z._-]{1,40}$')",
  "lines jsonb not null check (jsonb_typeof(lines) = 'array')", "loaded_at timestamptz not null default now()", "mapping_id text"])
  assert.ok(batches.includes(col), `cột đợt: ${col}`);
const uids = squash(sql.match(/create table if not exists public\.xa_vai_it_uids \(([\s\S]*?)\n\);/)[1]);
for (const col of ["it_number text not null references public.xa_vai_it_batches(it_number) on delete cascade",
  "group_uid_code text not null check (group_uid_code ~ '^[0-9]{16}$')", "wms_mm numeric(14,0)", "primary key (it_number, group_uid_code)"])
  assert.ok(uids.includes(col), `cột UID: ${col}`);
assert.match(sql, /create index if not exists xa_vai_it_uids_uid_idx on public\.xa_vai_it_uids \(group_uid_code\);/);

// ---------- Hàm: chỉ hàm mới, không thay hàm có sẵn ----------
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created, ["xa_vai_it_save", "_xa_vai_it_json", "xa_vai_it_list", "xa_vai_it_get", "xa_vai_it_of_uids"]);

// Quyền: hàm ghi chỉ authenticated, hàm đọc anon + authenticated, hàm nội bộ không ai.
const grants = [...sql.matchAll(/^grant execute on function public\.(\w+)\(([^)]*)\) to ([^;]+);$/gm)].map(m => `${m[1]}(${m[2]}) → ${m[3]}`);
assert.deepEqual(grants, ["xa_vai_it_save(jsonb) → authenticated", "xa_vai_it_list(integer) → anon, authenticated",
  "xa_vai_it_get(text) → anon, authenticated", "xa_vai_it_of_uids(text[]) → anon, authenticated"]);
for (const sig of ["xa_vai_it_save(jsonb)", "xa_vai_it_list(integer)", "xa_vai_it_get(text)", "xa_vai_it_of_uids(text[])", "_xa_vai_it_json(public.xa_vai_it_batches)"])
  assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), `revoke ${sig}`);
for (const name of ["xa_vai_it_save", "xa_vai_it_list", "xa_vai_it_get", "xa_vai_it_of_uids"])
  assert.match(fnBody(name).head, /security definer set search_path = '' as$/, `${name}: security definer + search_path rỗng`);

// ---------- xa_vai_it_save ----------
const save = fnBody("xa_vai_it_save");
assert.equal(save.head, "create or replace function public.xa_vai_it_save(p_batch jsonb) returns jsonb language plpgsql volatile security definer set search_path = '' as");
const b = save.body;
assert.ok(b.indexOf("if not public.print_admin_allowed() then") >= 0 && b.indexOf("if not public.print_admin_allowed() then") < b.indexOf("insert into"), "kiểm Admin trước khi ghi");
for (const part of ["'FORBIDDEN'", "'INVALID_INPUT'", "'INVALID_ITEM_CODE'", "'NOT_DELIVERED'", "v_it !~ '^[0-9]{16}$'", "public._xa_vai_item_code(p_batch->>'itemCode')",
  "jsonb_array_length(v_lines) not between 1 and 200", "jsonb_array_length(v_uids) > 3000", "count(*) - count(distinct btrim(l->>'sku'))",
  "v_delivered <= 0 or jsonb_array_length(v_uids) = 0", "SKU lặp ở nhiều dòng của phiếu IT", "public.xa_vai_system_mm(l->>'name', (l->>'deliveredQty')::numeric)",
  "on conflict (it_number) do update set", "on conflict (it_number, group_uid_code) do update set"])
  assert.ok(b.includes(part), `save có: ${part}`);
// Ép kiểu số chỉ trong CASE sau khi biết là số (OR của SQL không bảo đảm thứ tự).
for (const m of b.matchAll(/\((\w)->>'(deliveredQty|requestedQty|qty)'\)::numeric < 0/g)) {
  const before = b.slice(Math.max(0, m.index - 80), m.index);
  assert.match(before, new RegExp(`case when jsonb_typeof\\(${m[1]}->'${m[2]}'\\) = 'number' then $`), `ép ${m[2]} nằm trong CASE`);
}
// SKU của UID phải có trong dòng phiếu.
assert.ok(b.includes("not exists (select 1 from jsonb_array_elements(v_lines) as x(l) where btrim(l->>'sku') = btrim(u->>'sku'))"));
// Nạp lại: không gỡ UID, đếm UID mới thêm.
assert.ok(b.includes("returning (xmax = 0) as inserted") && b.includes("count(*) filter (where inserted)"));

// ---------- Đọc ----------
const json = fnBody("_xa_vai_it_json").body;
for (const part of ["left join public.xa_vai_measures m on m.group_uid_code = x.group_uid_code", "group by x.sku", "left join agg a on a.sku = t.l->>'sku'", "with ordinality", "'uidCount', (select coalesce(sum(per.uid_count), 0) from per)", "'measuredCount'", "'actualMm'", "'printedCount'", "order by per.n"])
  assert.ok(json.includes(part), `_xa_vai_it_json có: ${part}`);
const list = fnBody("xa_vai_it_list").body;
assert.ok(list.includes("least(greatest(coalesce(p_limit, 30), 1), 100)") && list.includes("order by b.loaded_at desc"));
const get = fnBody("xa_vai_it_get").body;
for (const part of ["'NOT_FOUND'", "'state', coalesce(m.status, 'new')", "'printedItemCode', m.item_code"]) assert.ok(get.includes(part), `get có: ${part}`);
const of = fnBody("xa_vai_it_of_uids").body;
for (const part of ["cardinality(v_codes) > 500", "distinct on (x.group_uid_code)", "order by x.group_uid_code, x.added_at desc, b.loaded_at desc"]) assert.ok(of.includes(part), `of_uids có: ${part}`);
// UID ở nhiều đợt: xếp theo lúc UID vào đợt (added_at không bị on conflict cập nhật), không theo lần nạp lại.
assert.ok(!/added_at\s*=\s*excluded/.test(sql), "nạp lại không đổi added_at");
// Gom một lần theo SKU: không còn truy vấn con quét lại UID cho từng dòng.
assert.ok(!/\(select count\(\*\) from u where/.test(json), "_xa_vai_it_json không quét lại UID mỗi dòng");

// Không đụng bảng / hàm có sẵn.
assert.ok(!/alter table public\.xa_vai_measures/i.test(sql) && !/(insert into|update) public\.xa_vai_measures/i.test(sql), "không ghi xa_vai_measures");

console.log("xa_vai_it_sql: bảng + RLS, 4 RPC đúng quyền, kiểm Admin, ép kiểu an toàn, nạp lại không gỡ UID, dòng kiem + rút lui đều đạt");
