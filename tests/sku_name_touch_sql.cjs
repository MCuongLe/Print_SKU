// Trigger sku_name_touch trên SKU_Name (19/10/2026, mục "Phát sinh" của docs/plans/2026-10-18-danh-muc-sku-tren-may.md).
// Danh mục SKU trên máy hỏi phần đổi theo updated_at > maxUpdatedAt (sku_catalog_changes). Trước đây Edge sku-sync tự đặt updated_at = một
// mốc `now` cho MỌI mẻ 400 dòng → máy kiểm giữa hai mẻ bỏ sót các mẻ sau; giờ Edge ≠ giờ database; sửa tên đường khác không đổi updated_at.
// Trigger: thêm dòng / dữ liệu thật sự đổi → updated_at = clock_timestamp() (giờ database, tăng theo từng dòng); ghi lại y nguyên → giữ mốc cũ.
// Test tĩnh: đọc tệp SQL (chưa có Postgres cục bộ). Chạy: node tests/sku_name_touch_sql.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const file = path.join(__dirname, "..", "supabase", "sku_name_touch_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/sku_name_touch_v1.sql");
const sql = fs.readFileSync(file, "utf8");
const body = sql.replace(/--[^\n]*/g, "");

assert.match(body, /^\s*begin;/m, "chạy trong giao dịch");
assert.match(body, /^\s*commit;/m);
assert.match(body, /create or replace function public\.sku_name_touch\(\)\s+returns trigger\s+language plpgsql\s+set search_path\s*=\s*''/i, "hàm trigger, search_path rỗng");
assert.doesNotMatch(body, /security definer/i, "hàm trigger không cần SECURITY DEFINER");
assert.match(body, /tg_op\s*=\s*'INSERT'/i, "thêm dòng → đóng dấu");
assert.match(body, /\(new\.sku,\s*new\.product_name,\s*new\.category_id,\s*new\.category_name,\s*new\.status\)\s+is distinct from\s+\(old\.sku,\s*old\.product_name,\s*old\.category_id,\s*old\.category_name,\s*old\.status\)/i,
  "so đúng 5 cột dữ liệu (các trường sku-sync so + sku)");
assert.equal((body.match(/clock_timestamp\(\)/g) || []).length >= 1, true, "giờ database theo từng dòng (clock_timestamp, không phải now())");
// Codex 19/10: ràng buộc ĐÚNG nhánh — thêm dòng và nhánh "dữ liệu đổi" đều gán clock_timestamp(), nhánh else mới giữ mốc cũ.
assert.match(body, /if tg_op\s*=\s*'INSERT' then\s+new\.updated_at\s*:=\s*clock_timestamp\(\);/i, "nhánh INSERT gán clock_timestamp()");
assert.match(body, /is distinct from\s+\(old\.sku,[^)]*\)\s+then\s+new\.updated_at\s*:=\s*clock_timestamp\(\);\s+else\s+new\.updated_at\s*:=\s*old\.updated_at;/i, "nhánh dữ liệu đổi gán clock_timestamp(), else giữ mốc cũ");
assert.doesNotMatch(body, /new\.updated_at\s*:=\s*now\(\)/i, "không dùng now() (cùng một mốc cho cả giao dịch)");
assert.match(body, /new\.updated_at\s*:=\s*old\.updated_at/i, "ghi lại y nguyên → giữ mốc cũ (không đẩy dòng vào phần đổi)");
assert.match(body, /revoke all on function public\.sku_name_touch\(\) from public, anon, authenticated/i);
assert.match(body, /create or replace trigger sku_name_touch\s+before insert or update on public\."SKU_Name"\s+for each row execute function public\.sku_name_touch\(\)/i, "BEFORE INSERT OR UPDATE, từng dòng, chạy lại được không cần DROP");
assert.doesNotMatch(body, /\bdrop\b|\btruncate\b|\bdelete\s+from\b|\balter table\b/i, "không DROP / xoá / sửa bảng (apply_supabase_sql.py chặn DROP)");
assert.doesNotMatch(body, /sku_name_inactive_since/i, "không đụng trigger inactive_since đang có");
assert.match(body, /notify pgrst/i);
console.log("sku_name_touch_sql: trigger BEFORE INSERT OR UPDATE trên SKU_Name — thêm dòng / 5 cột dữ liệu đổi → updated_at = clock_timestamp(), ghi y nguyên giữ mốc cũ, không SECURITY DEFINER, revoke đúng, chạy lại được, không đụng bảng / trigger khác — passed");
