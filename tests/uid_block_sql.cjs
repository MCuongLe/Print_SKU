// LỰA UID BLOCKED (supabase/uid_block_v1.sql, 20/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * hai bảng uid_block_lists / uid_block_items bật RLS, thu hồi khỏi public/anon/authenticated, chỉ service_role;
//   * uid_block_import: SECURITY DEFINER + search_path '', kiểm group_uid_admin_allowed() đầu tiên, chỉ cấp authenticated,
//     kiểm kiểu từng trường (INVALID_INPUT), 1–20.000 dòng, Group UID đúng 16 chữ số, bỏ trùng, giữ 5 danh sách (DELETE dòng);
//   * uid_block_snapshot / uid_block_compare: chỉ đọc (stable), cấp anon + authenticated; snapshot trùng id → {unchanged:true, listId};
//     compare tối đa 20.000 mã, trả rows/missing/blockedOutside (≤ 500)/blockedOutsideTotal;
//   * anon chỉ được gọi đúng hai hàm đọc; chỉ thêm (không drop / truncate / alter … drop), có begin/commit + notify pgrst.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.UID_BLOCK_SQL || path.join(__dirname, "..", "supabase", "uid_block_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/uid_block_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm, không drop/truncate");

// Bảng: chỉ service_role
for (const t of ["uid_block_lists", "uid_block_items"]) {
  assert.match(code, new RegExp(`create table if not exists public\\.${t}\\b`), `thiếu bảng ${t}`);
  assert.match(code, new RegExp(`alter table public\\.${t} enable row level security`), `${t} chưa bật RLS`);
  assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`), `${t} chưa thu hồi quyền`);
  assert.match(code, new RegExp(`grant [^;]* on public\\.${t} to service_role;`), `${t} chưa cấp service_role`);
  assert.doesNotMatch(code, new RegExp(`grant [^;]* on public\\.${t} to [^;]*\\b(anon|authenticated|public)\\b`), `${t} không được cấp cho anon/authenticated`);
  assert.doesNotMatch(code, new RegExp(`create policy [^;]* on public\\.${t}\\b`), `${t} không có policy (chỉ đi qua hàm)`);
}
const lists = code.match(/create table if not exists public\.uid_block_lists \(([\s\S]*?)\n\);/);
assert.ok(lists, "không đọc được định nghĩa uid_block_lists");
for (const col of ["id uuid primary key default gen_random_uuid\\(\\)", "file_name text", "sheets jsonb", "item_count integer", "by_warehouse jsonb", "imported_by uuid", "imported_at timestamptz not null default now\\(\\)"]) {
  assert.match(lists[1], new RegExp(col), `uid_block_lists thiếu cột ${col}`);
}
const items = code.match(/create table if not exists public\.uid_block_items \(([\s\S]*?)\n\);/);
assert.ok(items, "không đọc được định nghĩa uid_block_items");
assert.match(items[1], /list_id uuid not null references public\.uid_block_lists\(id\) on delete cascade/, "dòng phải xoá theo danh sách (cascade)");
for (const col of ["group_uid_code", "sku", "product_name", "lot", "roll", "warehouse", "location", "file_status"]) {
  assert.match(items[1], new RegExp(`\\b${col} text\\b`), `uid_block_items thiếu cột ${col}`);
}
assert.match(items[1], /primary key \(list_id, group_uid_code\)/, "khoá chính (list_id, group_uid_code)");
assert.match(items[1], /group_uid_code text not null check \(group_uid_code ~ '\^\[0-9\]\{16\}\$'\)/, "bảng phải chặn Group UID khác 16 chữ số");

const fn = name => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: m[1].replace(/\s+/g, " ").trim(), head: m[2], body: m[3] };
};
const imp = fn("uid_block_import"), snap = fn("uid_block_snapshot"), cmp = fn("uid_block_compare");
assert.equal(imp.params, "p_list jsonb, p_items jsonb");
assert.equal(snap.params, "p_known_list_id uuid default null");
assert.equal(cmp.params, "p_codes text[]");
for (const [name, f] of [["uid_block_import", imp], ["uid_block_snapshot", snap], ["uid_block_compare", cmp]]) {
  assert.match(f.head, /returns jsonb/i, `${name} trả jsonb`);
  assert.match(f.head, /security definer/i, `${name} phải SECURITY DEFINER`);
  assert.match(f.head, /set search_path = ''/, `${name} phải set search_path = ''`);
  assert.match(f.body, /'meta',\s*jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, `${name} trả meta {updatedAt, schemaVersion:1}`);
}
for (const [name, f] of [["uid_block_snapshot", snap], ["uid_block_compare", cmp]]) {
  assert.match(f.head, /\bstable\b/i, `${name} phải stable (chỉ đọc)`);
  assert.doesNotMatch(f.body, /\b(insert|update|delete|truncate)\b|pg_advisory/i, `${name} không được ghi`);
}
assert.doesNotMatch(imp.head, /\bstable\b/i, "uid_block_import ghi dữ liệu, không được stable");

// ---- uid_block_import ----
const firstIf = imp.body.indexOf("if ");
assert.ok(firstIf >= 0 && imp.body.slice(firstIf, firstIf + 60).includes("not public.group_uid_admin_allowed()"), "uid_block_import phải kiểm group_uid_admin_allowed() đầu tiên");
assert.match(imp.body, /'FORBIDDEN'/);
assert.match(imp.body, /pg_advisory_xact_lock\(hashtext\('public\.uid_block_import'\)\)/, "nạp tuần tự bằng advisory lock (hai Admin cùng nạp)");
assert.ok(imp.body.indexOf("pg_advisory_xact_lock") > imp.body.indexOf("group_uid_admin_allowed"), "khoá sau khi kiểm Admin");
assert.match(imp.body, /jsonb_typeof\(p_list\) <> 'object'/, "p_list phải là object");
assert.match(imp.body, /jsonb_typeof\(p_list->'fileName'\) is distinct from 'string'/, "fileName phải là chuỗi");
assert.match(imp.body, /length\(btrim\(p_list->>'fileName'\)\) not between 1 and 200/, "fileName 1–200 ký tự");
assert.match(imp.body, /jsonb_typeof\(p_list->'sheets'\) is distinct from 'array'/, "sheets phải là mảng");
assert.match(imp.body, /jsonb_typeof\(s\.v\) <> 'string'/, "mỗi sheet phải là chuỗi");
assert.match(imp.body, /jsonb_typeof\(p_items\) <> 'array'/, "p_items phải là mảng");
assert.match(imp.body, /jsonb_array_length\(case when jsonb_typeof\(p_items\) = 'array' then p_items else '\[\]'::jsonb end\) not between 1 and 20000\b/, "p_items 1–20.000 phần tử (không gọi jsonb_array_length trên giá trị không phải mảng)");
assert.match(imp.body, /jsonb_typeof\(e\.v\) <> 'object'/, "mỗi dòng phải là object");
assert.match(imp.body, /jsonb_typeof\(e\.v->'groupUid'\) is distinct from 'string'/, "groupUid phải là chuỗi");
assert.match(imp.body, /btrim\(e\.v->>'groupUid'\) !~ '\^\[0-9\]\{16\}\$'/, "groupUid đúng 16 chữ số sau btrim");
for (const f of ["sku", "productName", "lot", "roll", "warehouse", "location", "fileStatus"]) {
  assert.ok(imp.body.includes(`coalesce(jsonb_typeof(e.v->'${f}'),'null') not in ('string','null')`), `trường ${f} phải là chuỗi hoặc null`);
  assert.ok(imp.body.includes(`length(coalesce(e.v->>'${f}','')) > 300`), `trường ${f} tối đa 300 ký tự`);
}
assert.match(imp.body, /'INVALID_INPUT'/, "sai kiểu trả INVALID_INPUT");
assert.doesNotMatch(imp.body, /'INVALID_ROWS'/, "mã lỗi thống nhất INVALID_INPUT");
assert.match(imp.body, /exception when others then[\s\S]*'INVALID_INPUT'/, "lỗi ghi dòng phải trả INVALID_INPUT, không ném lỗi thô");
assert.match(imp.body, /distinct on \(btrim\(e\.v->>'groupUid'\)\)/, "bỏ trùng theo groupUid");
assert.match(imp.body, /\(select auth\.uid\(\)\)/, "ghi người nạp = auth.uid()");
assert.match(imp.body, /clock_timestamp\(\)/, "giờ nạp lấy sau khi khoá (clock_timestamp), không lấy giờ đầu giao dịch");
assert.match(imp.body, /jsonb_object_agg\(/, "by_warehouse đếm theo kho");
assert.match(imp.body, /delete from public\.uid_block_lists\s+where id not in \(select id from public\.uid_block_lists order by imported_at desc, id desc limit 5\)/, "giữ 5 danh sách mới nhất (DELETE dòng)");
for (const k of ["'listId'", "'itemCount'", "'byWarehouse'"]) assert.ok(imp.body.includes(k), `uid_block_import thiếu khoá trả về ${k}`);

// ---- uid_block_snapshot ----
assert.match(snap.body, /from public\.uid_block_lists[\s\S]*?order by imported_at desc, id desc\s+limit 1/, "danh sách mới nhất theo imported_at desc, id desc");
assert.match(snap.body, /p_known_list_id is not null and v_list\.id = p_known_list_id/, "trùng id web đang giữ → unchanged");
assert.match(snap.body, /'unchanged',true,'listId',v_list\.id/, "trả {unchanged:true, listId}");
assert.match(snap.body, /'unchanged',false,'list',null,'items','\[\]'::jsonb/, "chưa có danh sách → {list:null, items:[]}");
assert.match(snap.body, /'unchanged',false,\s*'list',\s*jsonb_build_object\(/, "khác → unchanged:false + list");
for (const k of ["'id'", "'fileName'", "'sheets'", "'itemCount'", "'byWarehouse'", "'importedAt'"]) assert.ok(snap.body.includes(k), `list thiếu ${k}`);
for (const k of ["'groupUid'", "'sku'", "'productName'", "'lot'", "'roll'", "'warehouse'", "'location'", "'fileStatus'"]) assert.ok(snap.body.includes(k), `items thiếu ${k}`);
assert.doesNotMatch(snap.body, /group_uid_details/, "snapshot chỉ đọc danh sách đã nạp");

// ---- uid_block_compare ----
assert.match(cmp.body, /cardinality\(p_codes\) > 20000\b/, "compare tối đa 20.000 mã");
assert.match(cmp.body, /'INVALID_INPUT'/, "quá giới hạn trả INVALID_INPUT");
assert.match(cmp.body, /from public\.group_uid_details/, "đối chiếu với group_uid_details");
assert.match(cmp.body, /g\.status = 'Blocked'/, "blockedOutside = status Blocked");
assert.match(cmp.body, /limit 500\b/, "blockedOutside tối đa 500");
for (const k of ["'rows'", "'missing'", "'blockedOutside'", "'blockedOutsideTotal'", "'groupUid'", "'status'", "'qcStatus'", "'warehouse'", "'location'", "'sku'"]) assert.ok(cmp.body.includes(k), `compare thiếu ${k}`);
assert.match(cmp.body, /g\.qc_status/, "rows kèm qc_status");
assert.match(cmp.body, /not exists \(select 1 from (pg_temp\.)?\w+ c where c\.code = g\.group_uid_code\)|not exists \(select 1 from unnest\(/, "blockedOutside loại mã có trong p_codes");

// ---- Cấp quyền gọi ----
assert.match(code, /revoke all on function public\.uid_block_import\(jsonb,jsonb\) from public, anon;/, "thu hồi uid_block_import khỏi public/anon");
assert.match(code, /grant execute on function public\.uid_block_import\(jsonb,jsonb\) to authenticated;/, "uid_block_import chỉ cấp authenticated");
for (const [name, sig] of [["uid_block_snapshot", "uuid"], ["uid_block_compare", "text\\[\\]"]]) {
  assert.match(code, new RegExp(`revoke all on function public\\.${name}\\(${sig}\\) from public;`), `${name} chưa thu hồi khỏi public`);
  assert.match(code, new RegExp(`grant execute on function public\\.${name}\\(${sig}\\) to anon, authenticated;`), `${name} phải cấp anon + authenticated`);
}
const anonFns = new Set([...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map(m => m[1]));
assert.deepEqual([...anonFns].sort(), ["uid_block_compare", "uid_block_snapshot"], "anon chỉ được gọi hai hàm đọc");
const grants = [...code.matchAll(/grant execute on function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual([...new Set(grants)].sort(), ["uid_block_compare", "uid_block_import", "uid_block_snapshot"], "chỉ cấp quyền ba hàm của module");

console.log("uid_block_sql: bảng RLS chỉ service_role, import kiểm Admin + kiểu + 16 số + 20.000 dòng + giữ 5, snapshot unchanged, compare Blocked ngoài tệp, anon chỉ 2 hàm đọc — passed");
