// Migration supabase/print_sku_v3_v1.sql (23/10/2026, gộp tem SKU v1 + v2 thành mẫu v3): chỉ thay print_agent_claim, thêm đúng
// MỘT nhánh (sku, template_version 3, capability 'sku:v3'); phần còn lại giống từng ký tự bản trước (print_sku_po_v1.sql).
//   node tests/print_sku_v3_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const claimOf = sql => {
  const a = sql.indexOf("create or replace function public.print_agent_claim(");
  assert.ok(a >= 0, "có print_agent_claim");
  return sql.slice(a, sql.indexOf("end$$;", a) + 6);
};
const migration = read("supabase/print_sku_v3_v1.sql");
const previous = claimOf(read("supabase/print_sku_po_v1.sql"));
const next = claimOf(migration);
const V2 = "    (type='sku' and template_version=2 and 'sku:v2'=any(v_cap)) or\n";
const V3 = "    (type='sku' and template_version=3 and 'sku:v3'=any(v_cap)) or\n";

assert.equal((next.match(/sku:v3/g) || []).length, 1, "đúng một nhánh sku:v3");
assert.ok(next.includes(V2 + V3), "nhánh v3 ngay sau nhánh v2 (v1, v2 giữ nguyên cho lệnh cũ)");
assert.equal(next.replace(V3, ""), previous, "bỏ nhánh v3 thì giống hệt bản trước");
assert.ok(/security definer set search_path=''/.test(next), "giữ security definer + search_path rỗng");
assert.ok(/^begin;$/m.test(migration) && /^commit;$/m.test(migration), "chạy trong một giao dịch");
assert.equal((migration.match(/create or replace function/g) || []).length, 1, "chỉ thay một hàm");
const body = migration.replace(/^--.*$/gm, "");
assert.ok(!/print_enqueue|drop |grant |revoke /i.test(body), "không đụng enqueue, không drop, không đổi quyền");
assert.ok(/notify pgrst, 'reload schema';/.test(body));
console.log("print_sku_v3_sql: nhánh sku:v3 duy nhất ngay sau v2, phần còn lại giữ nguyên passed");
