// Migration supabase/xa_vai_it_delete_v1.sql (06/11/2026): Admin xoá đợt xả theo phiếu IT. Kiểm tĩnh văn bản SQL (máy không có Postgres).
//   node tests/xa_vai_it_delete_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const raw = fs.readFileSync(path.join(root, "supabase/xa_vai_it_delete_v1.sql"), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = (s) => s.replace(/\s+/g, " ").trim();

assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql) && sql.indexOf("commit;") < sql.indexOf("notify pgrst"));
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_it_delete_v1\.sql$/m);
assert.ok(!/\b(drop|truncate|delete\s+from|alter\s+table)\b/i.test(topLevel), "không lệnh phá huỷ ở cấp cao nhất");
const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem && /^select /i.test(kiem[1]) && !/\b(insert|update|delete from|drop|alter|create|grant|revoke)\b/i.test(kiem[1]));
for (const part of ["to_regprocedure('public.xa_vai_it_delete(text)')", "not has_function_privilege('anon'", "print_admin_allowed", "on delete cascade"]) assert.ok(kiem[1].includes(part), `-- kiem có ${part}`);

assert.deepEqual([...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]), ["xa_vai_it_delete"]);
assert.ok(sql.includes("revoke all on function public.xa_vai_it_delete(text) from public, anon, authenticated;"));
assert.deepEqual([...sql.matchAll(/^grant [^;]+;$/gm)].map((m) => m[0]), ["grant execute on function public.xa_vai_it_delete(text) to authenticated;"], "chỉ authenticated (Admin kiểm trong hàm)");

const body = squash(sql.slice(sql.indexOf("create or replace function public.xa_vai_it_delete(")));
assert.ok(body.includes("security definer set search_path = ''"));
const order = ["if not public.print_admin_allowed() then", "if v_it !~ '^[0-9]{16}$' then",
  "select b.* into v_row from public.xa_vai_it_batches b where b.it_number = v_it for update;", "if not found then",
  "delete from public.xa_vai_it_batches where it_number = v_it;"];
let at = -1;
for (const step of order) { const i = body.indexOf(step); assert.ok(i > at, `thứ tự: ${step}`); at = i; }
assert.ok(body.includes("'FORBIDDEN'") && body.includes("'INVALID_INPUT'") && body.includes("'NOT_FOUND'"));
// Chỉ xoá đợt (UID theo cascade); không đụng mét đã đo / lệnh in.
assert.equal((body.match(/\bdelete from\b/g) || []).length, 1, "một lệnh xoá duy nhất");
assert.ok(!/\b(update|delete from|insert into) public\.(xa_vai_measures|print_jobs)\b/.test(body), "không sửa xa_vai_measures / print_jobs");
assert.ok(body.includes("'uidCount', v_uids, 'measuredCount', v_measured"));
console.log("xa_vai_it_delete_sql: OK");
