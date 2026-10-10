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
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", sku: "Z", count_inbin: 0, quantity: 10 },
] });
assert.equal(inventory.rows.length, 4, "count_inbin <= 0 phải bị loại dù tổng quantity còn dương");
assert.equal(inventory.rows[0].qty, 2, "count_inbin phải được ưu tiên hơn quantity");

const now = Date.parse("2026-10-10T12:00:00+07:00");
const approved = core.normalizeApprovedPage({ count: 3, records: [
  { checklist_id: 1, warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", plan_object_code: "A", status_name: "APPROVED", approved_at_tz: "2026-09-10T12:00:00+07:00", approved_by_name: "manager-a" },
  { checklist_id: 2, warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", plan_object_code: "B", status_name: "APPROVED", approved_at_tz: "2026-09-09T11:59:59+07:00", approved_by_name: "manager-b" },
  { checklist_id: 3, warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", plan_object_code: "C", status_name: "CANCELED", approved_at_tz: "2026-10-09T12:00:00+07:00" },
] });
const result = core.reconcile(inventory.rows, approved.rows, now, 30);
assert.deepEqual(JSON.parse(JSON.stringify(result.summary)), { total: 3, never: 1, recent: 1, overdue: 1, qty: 10 });
assert.equal(result.rows.find(r => r.sku === "A").status, "recent", "đúng 30 ngày vẫn là trong hạn");
assert.equal(result.rows.find(r => r.sku === "A").qty, 5, "phải cộng mọi vị trí");
assert.equal(result.rows.find(r => r.sku === "B").status, "overdue");
assert.equal(result.rows.find(r => r.sku === "C").status, "never");

console.log("inventory_audit_core: company switch, qty>0, aggregation and 30-day boundary passed");
