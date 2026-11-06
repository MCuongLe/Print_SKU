// Migration supabase/xa_vai_it_report_delete_v1.sql (06/11/2026): Admin xoá dòng mục "Ngoài đợt xả" — chỉ khi giờ quét cuối khớp bản web đang thấy.
// Kiểm tĩnh văn bản SQL (máy không có Postgres).
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
for (const part of ["to_regprocedure('public.xa_vai_it_report_delete(jsonb)')", "not has_function_privilege('anon'", "print_admin_allowed", "r.last_at = w.seen_at"]) assert.ok(kiem[1].includes(part), `-- kiem có ${part}`);

assert.deepEqual([...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]), ["xa_vai_it_report_delete"]);
assert.ok(sql.includes("revoke all on function public.xa_vai_it_report_delete(jsonb) from public, anon, authenticated;"));
assert.deepEqual([...sql.matchAll(/^grant [^;]+;$/gm)].map((m) => m[0]), ["grant execute on function public.xa_vai_it_report_delete(jsonb) to authenticated;"]);

const body = squash(sql.slice(sql.indexOf("create or replace function public.xa_vai_it_report_delete(")));
assert.ok(body.includes("security definer set search_path = ''"));
const order = ["if not public.print_admin_allowed() then", "jsonb_array_length(p_items) not between 1 and 2000",
  "delete from public.xa_vai_it_reports r using want w where r.group_uid_code = w.code and r.last_at = w.seen_at"];
let at = -1;
for (const step of order) { const i = body.indexOf(step); assert.ok(i > at, `thứ tự: ${step}`); at = i; }
// Giờ sai mẫu bị chặn trước khi ép kiểu; ép kiểu lỗi (tháng 13…) trả INVALID_INPUT, không ném lỗi.
assert.ok(body.includes("coalesce(e->>'lastAt', '') !~"));
assert.ok(body.includes("exception when invalid_datetime_format or datetime_field_overflow or invalid_time_zone_displacement_value then"), "giờ / múi giờ hỏng → INVALID_INPUT");
assert.ok(kiem[1].includes("to_regprocedure('public.xa_vai_it_report_delete(text[])') is null"), "không có overload text[] (bản nháp chưa chạy)");
assert.equal((body.match(/\bdelete from\b/g) || []).length, 1, "một lệnh xoá duy nhất, chỉ xa_vai_it_reports");
assert.ok(!/\b(update|delete from|insert into) public\.(xa_vai_it_uids|xa_vai_measures|xa_vai_it_batches)\b/.test(body));
assert.ok(body.includes("'deleted', v_n, 'requested', v_req, 'stale', v_req - v_n"));
// Mẫu giờ khớp đúng chuỗi xa_vai_it_outside trả (to_jsonb timestamptz) và chặn chuỗi lạ.
const re = new RegExp(body.match(/!~ '([^']+)'/)[1]);
for (const ok of ["2026-11-06T09:12:55.667579+00:00", "2026-11-06T09:12:55+07:00", "2026-11-06T09:12:55.5Z"]) assert.ok(re.test(ok), ok);
for (const bad of ["", "06/11/2026", "2026-11-06", "2026-11-06T09:12:55.667579+00:00'; drop"]) assert.ok(!re.test(bad), bad);
console.log("xa_vai_it_report_delete_sql: OK");
