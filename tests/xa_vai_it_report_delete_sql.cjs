// Migration supabase/xa_vai_it_report_delete_v1.sql (06/11/2026): Admin xoá dòng mục "Ngoài đợt xả". Kiểm tĩnh văn bản SQL (máy không có Postgres).
//   node tests/xa_vai_it_report_delete_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const raw = fs.readFileSync(path.join(root, "supabase/xa_vai_it_report_delete_v1.sql"), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = (s) => s.replace(/\s+/g, " ").trim();

assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql) && sql.indexOf("commit;") < sql.indexOf("notify pgrst"));
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_it_report_delete_v1\.sql$/m);
assert.ok(!/\b(drop|truncate|delete\s+from|alter\s+table)\b/i.test(topLevel), "không lệnh phá huỷ ở cấp cao nhất");
const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem && /^select /i.test(kiem[1]) && !/\b(insert|update|delete from|drop|alter|create|grant|revoke)\b/i.test(kiem[1]));
for (const part of ["to_regprocedure('public.xa_vai_it_report_delete(text[])')", "not has_function_privilege('anon'", "print_admin_allowed"]) assert.ok(kiem[1].includes(part), `-- kiem có ${part}`);

assert.deepEqual([...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]), ["xa_vai_it_report_delete"]);
assert.ok(sql.includes("revoke all on function public.xa_vai_it_report_delete(text[]) from public, anon, authenticated;"));
assert.deepEqual([...sql.matchAll(/^grant [^;]+;$/gm)].map((m) => m[0]), ["grant execute on function public.xa_vai_it_report_delete(text[]) to authenticated;"]);

const body = squash(sql.slice(sql.indexOf("create or replace function public.xa_vai_it_report_delete(")));
assert.ok(body.includes("security definer set search_path = ''"));
const order = ["if not public.print_admin_allowed() then", "if p_uids is null or exists", "if cardinality(v_uids) not between 1 and 2000 then",
  "delete from public.xa_vai_it_reports r where r.group_uid_code = any(v_uids)"];
let at = -1;
for (const step of order) { const i = body.indexOf(step); assert.ok(i > at, `thứ tự: ${step}`); at = i; }
assert.equal((body.match(/\bdelete from\b/g) || []).length, 1, "một lệnh xoá duy nhất, chỉ xa_vai_it_reports");
assert.ok(!/\b(update|delete from|insert into) public\.(xa_vai_it_uids|xa_vai_measures|xa_vai_it_batches)\b/.test(body));
assert.ok(body.includes("'deleted', v_n, 'requested', cardinality(v_uids)"));
console.log("xa_vai_it_report_delete_sql: OK");
