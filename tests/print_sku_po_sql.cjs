// Migration supabase/print_sku_po_v1.sql (22/10/2026, tem Phụ liệu có PO + ngày nhận): chỉ thay print_agent_claim, thêm đúng
// MỘT nhánh (sku, template_version 2, capability 'sku:v2'); phần còn lại giống từng ký tự bản trước (warehouse_location_v1.sql).
//   node tests/print_sku_po_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const claimOf = sql => {
  const a = sql.indexOf("create or replace function public.print_agent_claim(");
  assert.ok(a >= 0, "có print_agent_claim");
  return sql.slice(a, sql.indexOf("end$$;", a) + 6);
};
const migration = read("supabase/print_sku_po_v1.sql");
const previous = claimOf(read("supabase/warehouse_location_v1.sql"));
const next = claimOf(migration);
const V2 = "    (type='sku' and template_version=2 and 'sku:v2'=any(v_cap)) or\n";

assert.equal((next.match(/sku:v2/g) || []).length, 1, "đúng một nhánh sku:v2");
assert.ok(next.includes("    (type='sku' and template_version=1 and 'sku:v1'=any(v_cap)) or\n" + V2), "nhánh v2 ngay sau nhánh v1");
assert.equal(next.replace(V2, ""), previous, "bỏ nhánh v2 thì giống hệt bản trước (không đổi gì khác)");
assert.ok(/security definer set search_path=''/.test(next), "giữ security definer + search_path rỗng");
assert.ok(/^begin;$/m.test(migration) && /^commit;$/m.test(migration), "chạy trong một giao dịch");
assert.equal((migration.match(/create or replace function/g) || []).length, 1, "chỉ thay một hàm");
assert.ok(!/print_enqueue|drop |grant |revoke /i.test(migration.replace(/^--.*$/gm, "")), "không đụng enqueue, không drop, không đổi quyền");
assert.ok(fs.readFileSync("supabase/print_sku_po_v1.sql", "utf8").includes("\r\n"), "tệp SQL giữ CRLF như các migration khác");

// Đột biến: mỗi bản sửa sai phải bị một kiểm ở trên bắt
const mutants = [
  next.replace(V2, ""),                                                     // quên nhánh v2
  next.replace("template_version=2 and 'sku:v2'", "template_version=2 and 'sku:v1'"), // agent cũ nhận lệnh v2 → in thiếu PO
  next.replace(V2, V2.replace("template_version=2", "template_version>=1")),
  next.replace("security definer", "security invoker"),
  next.replace("for update skip locked", "for update"),
];
for (const [index, mutant] of mutants.entries()) {
  let caught = false;
  try {
    assert.equal((mutant.match(/sku:v2/g) || []).length, 1);
    assert.ok(mutant.includes("    (type='sku' and template_version=1 and 'sku:v1'=any(v_cap)) or\n" + V2));
    assert.equal(mutant.replace(V2, ""), previous);
    assert.ok(/security definer set search_path=''/.test(mutant));
  } catch { caught = true; }
  assert.ok(caught, `đột biến ${index + 1} phải bị bắt`);
}
console.log(`print_sku_po_sql: nhánh sku:v2 duy nhất, phần còn lại giữ nguyên, ${mutants.length}/${mutants.length} đột biến bị bắt`);
