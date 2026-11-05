// Migration supabase/xa_vai_a4_v2.sql (05/11/2026): phiếu A4 xả vải bản mới — dữ liệu lệnh in thêm phiếu IT, mã vải / màu, đơn vị gốc.
// Kiểm tĩnh văn bản SQL (máy không có Postgres).
//   node tests/xa_vai_a4_v2_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const raw = fs.readFileSync(path.join(root, "supabase/xa_vai_a4_v2.sql"), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const fnBody = (text, name) => {
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `có hàm ${name}`);
  const open = text.indexOf("$$", start), close = text.indexOf("$$", open + 2);
  return squash(text.slice(open + 2, close));
};

assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql) && sql.indexOf("commit;") < sql.indexOf("notify pgrst"));
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_a4_v2\.sql$/m);
assert.ok(!/\b(drop|truncate|delete\s+from|alter\s+table)\b/i.test(topLevel), "không lệnh phá huỷ / đổi bảng ở cấp cao nhất");
const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem && /^select /i.test(kiem[1]) && !/\b(insert|update|delete|drop|alter|create|grant|revoke)\b/i.test(kiem[1]));
for (const part of ["= 320", "= 1234", "'Đen-Deep black'", "'Dusty Mauve'", "'Cam'", "'Trắng'", "->>'fabricCode') is null", "->>'color') is null"]) assert.ok(kiem[1].includes(part), `-- kiem có ${part}`);

const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created, ["xa_vai_name_parts", "xa_vai_mm_to_unit", "_xa_vai_unit_json", "_xa_vai_item_json", "_xa_vai_print_enqueue_body"], "không thay xa_vai_it_save (giữ bản xa_vai_it_v2)");
assert.ok(!/^grant /m.test(sql), "không cấp quyền hàm nào (đều nội bộ)");
for (const sig of ["xa_vai_name_parts(text)", "xa_vai_mm_to_unit(text, numeric)", "_xa_vai_unit_json(public.xa_vai_measures, text)", "_xa_vai_item_json(public.xa_vai_measures)",
  "_xa_vai_print_enqueue_body(text, text[], integer, text, boolean, text)"])
  assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), `revoke ${sig}`);

// Tách tên: đi lùi bỏ none / thông số; mã vải none → null.
const parts = fnBody(sql, "xa_vai_name_parts");
for (const p of ["for v_i in reverse v_n - 1 .. least(3, v_n - 1) loop", "lower(v_seg) <> 'none'", "v_seg !~* v_spec", "if lower(v_code) = 'none' or v_code like '%\\%%' then", "if v_n < 3 then", "if v_n >= 4 then", "btrim(coalesce(v_parts[v_n], ''), E' \\t\\r\\n')"])
  assert.ok(parts.includes(p), `name_parts có ${p}`);
// Đổi đơn vị: nghịch đảo xa_vai_system_mm — m ÷ 1000, mm giữ, g = mm × GSM × khổ ÷ 1000; cùng cách đọc GSM / khổ với xa_vai_system_mm.
const conv = fnBody(sql, "xa_vai_mm_to_unit");
for (const p of ["return round(p_mm / 1000, 2);", "return round(p_mm, 0);", "return round(p_mm * v_gsm * v_width / 1000, 0);", "if v_unit <> 'g' then return null;"])
  assert.ok(conv.includes(p), `mm_to_unit có ${p}`);
const a1 = fs.readFileSync(path.join(root, "supabase/xa_vai_a4_v1.sql"), "utf8").replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "");
const sysMm = fnBody(a1, "xa_vai_system_mm");
for (const re of ["(\\d+(?:[.,]\\d+)?)\\s*gsm", "(\\d+(?:[.,]\\d+)?)\\s*cm", "(\\d+(?:[.,]\\d+)?)(?:[_-](\\d+(?:[.,]\\d+)?))?\\s*in\\y"])
  assert.ok(sysMm.includes(re) && conv.includes(re), `cùng biểu thức đọc ${re}`);

// Tên hiện tại không khớp số chụp lúc đo → giữ mm.
const unitJson = fnBody(sql, "_xa_vai_unit_json");
assert.ok(unitJson.includes("when p_row.system_mm is not null and public.xa_vai_system_mm(p_product_name, p_row.system_qty) is distinct from p_row.system_mm then jsonb_build_object('unit', 'mm', 'systemQty', p_row.system_mm, 'actualQty', p_row.actual_mm"));
// Dòng đo + lệnh in: thêm trường, giữ trường v1, template_version 1.
const item = fnBody(sql, "_xa_vai_item_json");
assert.ok(item.includes("'printedAt', p_row.printed_at, 'printJobId', p_row.print_job_id) || public._xa_vai_unit_json(p_row, (select s.product_name from public.\"SKU_Name\" s where s.sku = p_row.sku))"));
const enq = fnBody(sql, "_xa_vai_print_enqueue_body");
for (const p of ["'itNumbers', coalesce((select jsonb_agg(distinct c.it order by c.it) from (select (select x.it_number from public.xa_vai_it_uids x where x.group_uid_code = u order by x.added_at desc, x.it_number limit 1) as it from unnest(v_uids) as u) c where c.it is not null), '[]'::jsonb)",
  "'systemMm', m.system_mm, 'actualMm', m.actual_mm, 'measuredAt', public._xa_vai_iso(m.measured_at)) || public._xa_vai_unit_json(m, s.product_name)",
  "order by m.sku, m.measured_at, m.group_uid_code", "left join public.\"SKU_Name\" s on s.sku = m.sku",
  "values (v_nonce, 'xa_vai_sheet', 1, v_payload, p_copies, 'xa-vai', v_device)"])
  assert.ok(enq.includes(p), `enqueue có ${p.slice(0, 60)}`);
// Ngoài phần payload, thân hàm giống hệt bản đang chạy (xa_vai_a4_v1).
const a1Enq = fnBody(a1, "_xa_vai_print_enqueue_body");
const cut = s => s.slice(0, s.indexOf("select jsonb_build_object('itemCode', v_item")) + "|" + s.slice(s.indexOf("v_device := public.print_device_by_token(p_access_token);"));
assert.equal(cut(enq), cut(a1Enq), "phần còn lại của _xa_vai_print_enqueue_body không đổi");
console.log("xa_vai_a4_v2_sql: tách mã vải / màu, đổi mm → đơn vị gốc (nghịch đảo system_mm), dòng đo + lệnh in thêm trường giữ v1, quyền nội bộ đều đạt");
