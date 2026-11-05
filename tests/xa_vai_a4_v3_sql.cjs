// Migration supabase/xa_vai_a4_v3.sql (05/11/2026): lệnh in phiếu A4 xả vải thêm deviceName (tên máy gửi lệnh — ô "Người xả", agent 0.12.1).
// Kiểm tĩnh văn bản SQL (máy không có Postgres): chỉ thay _xa_vai_print_enqueue_body, phần còn lại giống hệt bản xa_vai_a4_v2.
//   node tests/xa_vai_a4_v3_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8").replace(/\r\n/g, "\n");
const raw = read("supabase/xa_vai_a4_v3.sql");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = (s) => s.replace(/\s+/g, " ").trim();
const fnText = (text, name) => {
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `có hàm ${name}`);
  const open = text.indexOf("$$", start), close = text.indexOf("$$", open + 2);
  return text.slice(start, close + 2);
};

assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql) && sql.indexOf("commit;") < sql.indexOf("notify pgrst"));
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_a4_v3\.sql$/m);
assert.ok(!/\b(drop|truncate|delete\s+from|alter\s+table)\b/i.test(topLevel), "không lệnh phá huỷ / đổi bảng ở cấp cao nhất");
assert.ok(!/^grant /m.test(sql), "không cấp quyền (hàm nội bộ)");
const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem && /^select /i.test(kiem[1]) && !/\b(insert|update|delete|drop|alter|create|grant|revoke)\b/i.test(kiem[1]));
assert.ok(kiem[1].includes("position('deviceName'") && kiem[1].includes("not has_function_privilege('anon'"));

const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
assert.deepEqual(created, ["_xa_vai_print_enqueue_body"]);
assert.ok(sql.includes("revoke all on function public._xa_vai_print_enqueue_body(text, text[], integer, text, boolean, text) from public, anon, authenticated;"));

const v3 = squash(fnText(sql, "_xa_vai_print_enqueue_body"));
const v2 = squash(fnText(read("supabase/xa_vai_a4_v2.sql").replace(/--[^\n]*/g, ""), "_xa_vai_print_enqueue_body"));
assert.ok(v3.includes("security definer set search_path = ''"));
// Máy được nhận ra TRƯỚC khi dựng payload; deviceName = tên máy đó (≤ 60), máy không nhận ra → null.
const devAt = v3.indexOf("v_device := public.print_device_by_token(p_access_token);");
assert.ok(devAt > 0 && devAt < v3.indexOf("into v_payload"), "nhận máy trước khi dựng payload");
assert.equal(v3.split("public.print_device_by_token(").length - 1, 1, "chỉ gọi một lần");
assert.ok(v3.includes("'deviceName', (select left(nullif(btrim(d.name), ''), 60) from public.print_devices d where d.id = v_device),"));
// Ngoài hai chỗ trên, thân hàm giống hệt bản v2 đang chạy.
const strip = (s) => s.replace(" v_device := public.print_device_by_token(p_access_token);", "")
  .replace(" 'deviceName', (select left(nullif(btrim(d.name), ''), 60) from public.print_devices d where d.id = v_device),", "");
assert.equal(strip(v3), strip(v2), "không đổi gì khác so với xa_vai_a4_v2");
console.log("xa_vai_a4_v3_sql: OK");
