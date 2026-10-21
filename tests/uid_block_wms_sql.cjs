// LỰA UID BLOCKED lấy từ WMS (21/10/2026, supabase/uid_block_wms_v1.sql): danh sách = UID Blocked trong group_uid_details ở các kho
// được chọn, nạp qua uid_block_import (giữ quy tắc cũ: Admin, khoá, giữ 5 danh sách, chép lượt đã quét). Test tĩnh: node tests/uid_block_wms_sql.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const file = path.join(__dirname, "..", "supabase", "uid_block_wms_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/uid_block_wms_v1.sql");
const body = fs.readFileSync(file, "utf8").replace(/--[^\n]*/g, "");

assert.match(body, /^\s*begin;/m);
assert.match(body, /^\s*commit;/m);
assert.match(body, /notify pgrst/i);
assert.match(body, /create or replace function public\.uid_block_import_wms\(p_warehouses text\[\]\)\s+returns jsonb language plpgsql security definer set search_path = ''/i, "SECURITY DEFINER, search_path rỗng");
const fn = body.slice(body.indexOf("create or replace function public.uid_block_import_wms"), body.indexOf("revoke all on function public.uid_block_import_wms"));
assert.ok(fn.indexOf("group_uid_admin_allowed()") > -1 && fn.indexOf("group_uid_admin_allowed()") < fn.indexOf("group_uid_details"), "kiểm Admin TRƯỚC khi đọc dữ liệu");
assert.match(fn, /cardinality\(v_wh\) > 10/, "giới hạn số kho");
assert.match(fn, /g\.status ilike 'blocked'/i, "chỉ UID đang Blocked");
assert.match(fn, /g\.warehouse = any\(v_wh\)/, "lọc đúng kho được chọn");
assert.match(fn, /g\.group_uid_code ~ '\^\[0-9\]\{16\}\$'/, "chỉ Group UID 16 số (uid_block_import từ chối mã khác)");
assert.match(fn, /'lot', left\(g\.batch_code, 300\)/, "Lot = batch_code (≤ 300 ký tự như uid_block_import)");
assert.match(fn, /'roll', left\(g\.roll_code, 300\)/, "Roll = roll_code");
assert.match(fn, /"SKU_Name" s where s\.sku = g\.sku limit 1/, "tên hàng theo SKU_Name, một dòng");
assert.match(fn, /'NO_ROWS'/, "không có UID → báo, không nạp danh sách rỗng");
assert.match(fn, /return public\.uid_block_import\(jsonb_build_object\('fileName', v_name, 'sheets', to_jsonb\(v_wh\)\), v_items\)/, "nạp qua uid_block_import (giữ khoá, 5 danh sách, chép lượt quét)");
assert.doesNotMatch(fn, /insert into public\.uid_block_(lists|items|scans)/i, "không tự ghi bảng — mọi ghi đi qua uid_block_import");
assert.match(body, /revoke all on function public\.uid_block_import_wms\(text\[\]\) from public, anon;/);
assert.match(body, /grant execute on function public\.uid_block_import_wms\(text\[\]\) to authenticated;/);
assert.doesNotMatch(body, /grant execute on function public\.uid_block_import_wms\(text\[\]\) to[^;]*anon/i, "anon không được gọi");
assert.doesNotMatch(body, /\bdrop\b|\btruncate\b|\bdelete\s+from\b|\balter table\b/i, "chỉ thêm hàm");
console.log("uid_block_wms_sql: Admin trước, chỉ UID Blocked 16 số ở kho chọn (≤ 10), Lot/Roll/tên hàng, NO_ROWS, nạp qua uid_block_import, quyền authenticated — passed");
