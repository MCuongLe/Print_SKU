const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("extension/inside-po-connector/inventory-audit-core.js", "utf8");
const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const core = sandbox.HasakiInventoryAuditCore;

const selected = core.selectWarehouses({ records: [
  { warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", warehouse_code: "1631", _company_id: 1002, _company_name: "Cty Mastige" },
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", warehouse_code: "1721", _company_id: 1005, _company_name: "Cty Garment" },
] });
assert.deepEqual(JSON.parse(JSON.stringify(selected.warehouses.map(w => [w.warehouseId, w.companyId]))), [[1177, 1002], [1339, 1005]]);
assert.deepEqual(JSON.parse(JSON.stringify(selected.missingNames)), []);

const inventory = core.normalizeInventoryPage({ count: 5, page: 1, size: 500, records: [
  { warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", sku: "A", product_name: "Vải A", location_description: "A-01", count_inbin: 2, quantity: 99 },
  { warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", sku: "A", product_name: "Vải A", location_description: "A-02", count_inbin: 3 },
  { warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", sku: "B", product_name: "Vải B", location_description: "B-01", count_inbin: 4 },
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", sku: "C", product_name: "Chỉ C", location_description: "C-01", count_inbin: 1 },
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", sku: "Z", count_inbin: 0, quantity: 10, location_description: "F0-AJ-00-00-00-00", created_at: "2026-10-01 08:00:00" },
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", sku: "EMPTY", count_inbin: 0, quantity: 0 },
] });
assert.equal(inventory.rows.length, 5, "dòng In-BIN = 0 nhưng tổng quantity > 0 được giữ (qty = 0) để không bỏ sót hàng giữ chỗ; dòng tồn 0 hẳn bị loại");
assert.equal(inventory.rows[0].qty, 2, "count_inbin phải được ưu tiên hơn quantity");
assert.equal(inventory.rows[0].total, 99, "total là tổng mọi trạng thái, không thấp hơn qty");
assert.equal(inventory.rows[1].total, 3, "thiếu quantity thì total = In-BIN");
const held = inventory.rows.find(row => row.sku === "Z");
assert.equal(held.qty, 0, "hàng giữ chỗ không tính vào tồn In-BIN của Kiểm kê");
assert.equal(held.total, 10);
assert.equal(held.since, "2026-10-01 08:00:00", "giữ ngày tạo dòng tồn để tính số ngày ở vị trí");
assert.equal(inventory.rows.filter(row => row.qty > 0).length, 4, "Kiểm kê vẫn chỉ thấy 4 dòng In-BIN > 0");

// Đối chiếu tồn kho với ngày duyệt (mốc 30 ngày) chạy ở Admin trong index.html, không còn bản trong extension.
const approved = core.normalizeApprovedPage({ count: 3, records: [
  { checklist_id: 1, warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", plan_object_code: "A", status_name: "APPROVED", approved_at_tz: "2026-09-10T12:00:00+07:00", approved_by_name: "manager-a" },
  { checklist_id: 2, warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", plan_object_code: "B", status_name: "APPROVED", approved_at_tz: "2026-09-09T11:59:59+07:00", approved_by_name: "manager-b" },
  { checklist_id: 3, warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", plan_object_code: "C", status_name: "CANCELED", approved_at_tz: "2026-10-09T12:00:00+07:00" },
] });
assert.deepEqual(approved.rows.map(row => row.sku), ["A", "B"], "chỉ giữ checklist APPROVED, bỏ CANCELED");
assert.equal(approved.rows[0].approvedAt, "2026-09-10T12:00:00+07:00");
assert.equal(approved.rows[0].approvedBy, "manager-a");
assert.equal(approved.total, 3, "total lấy từ count của WMS, không phải số dòng đã lọc");

console.log("inventory_audit_core: company switch, qty>0, held stock kept and approved-only filter passed");
