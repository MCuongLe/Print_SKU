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
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", sku: "Z", count_inbin: 0, quantity: 10, location_description: "F0-AJ-00-00-00-00", created_at: "2025-12-04 06:12:53", updated_at: "2026-10-12 15:17:20" },
  { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", sku: "EMPTY", count_inbin: 0, quantity: 0 },
] });
assert.equal(inventory.rows.length, 5, "dòng In-BIN = 0 nhưng tổng quantity > 0 được giữ (qty = 0) để không bỏ sót hàng giữ chỗ; dòng tồn 0 hẳn bị loại");
assert.equal(inventory.rows[0].qty, 2, "count_inbin phải được ưu tiên hơn quantity");
assert.equal(inventory.rows[0].total, 99, "total là tổng mọi trạng thái, không thấp hơn qty");
assert.equal(inventory.rows[1].total, 3, "thiếu quantity thì total = In-BIN");
const held = inventory.rows.find(row => row.sku === "Z");
assert.equal(held.qty, 0, "hàng giữ chỗ không tính vào tồn In-BIN của Kiểm kê");
assert.equal(held.total, 10);
assert.equal(held.modified, "2026-10-12 15:17:20", "giữ Modified date để tính số ngày ở vị trí");
assert.equal(held.created, "2025-12-04 06:12:53", "giữ ngày tạo làm dự phòng");
assert.equal(inventory.rows[0].modified, "", "WMS không trả updated_at thì để trống, không tự điền ngày khác");
// Hàng đã lấy (chỉ có quantity + count_picked, không có count_inbin) vẫn là tồn tại vị trí.
const picked = core.normalizeInventoryPage({ records: [
  { warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG", sku: "P", location_description: "F0-A0-00-00-00-00", quantity: 430, count_picked: 430, created_at: "2025-12-04 06:12:53", updated_at: "2026-10-12 15:17:20" },
] });
assert.equal(picked.rows.length, 1);
assert.equal(picked.rows[0].qty, 430, "thiếu count_inbin thì lấy quantity, không bỏ hàng đã lấy");
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
assert.equal(approved.sourceRows, 3, "0.10.8 (D2): sourceRows = số dòng WMS trả (trước khi lọc) để Kiểm kê so với total");

// Báo cáo Import/Export: type 1 = nhập, 2 = xuất; giờ lấy từ created_at_tz; dòng thiếu SKU/kho/loại bị bỏ.
const movements = core.normalizeImportExportPage({ page: 1, size: 500, records: [
  { id: 267157413, warehouse_id: 1151, warehouse_name: "OFFICE - 130 AP CHANH - MTG", sku: "322200644", product_name: "Backdrop", quantity: 1, current_quantity: 2, type: 1, source_type: "PURCHASE_ORDER", source_code: "1001261012030931", source_mapping_id: "10012610063063", created_at: "2026-10-15 07:41:14", created_at_tz: "2026-10-15T07:41:14+07:00", created_user_name: "a@example.com" },
  { id: 266077815, warehouse_id: 1151, sku: "422415401", quantity: 50, type: 2, source_type: "ADJUSTMENT", reason_name: "Xuất sử dụng", created_at: "2026-10-13 12:48:03" },
  { id: 265657070, warehouse_id: 1151, sku: "422514540", quantity: 2, type: 2, source_type: "ADJUSTMENT" },
  { id: 1, warehouse_id: 1151, sku: "X", quantity: 5, type: 3 },
  { id: 2, warehouse_id: 1151, sku: "", quantity: 5, type: 1 },
  { id: 3, sku: "Y", quantity: 5, type: 1 },
] });
assert.deepEqual(movements.rows.map(row => [row.sku, row.kind, row.qty, row.balance]), [["322200644", "in", 1, 2], ["422415401", "out", 50, null], ["422514540", "out", 2, null]], "chỉ giữ dòng nhập/xuất hợp lệ; current_quantity trống thì balance = null");
assert.equal(movements.rows[0].createdAt, "2026-10-15T07:41:14+07:00", "ưu tiên created_at_tz có múi giờ");
assert.equal(movements.rows[1].createdAt, "2026-10-13 12:48:03", "thiếu created_at_tz thì dùng created_at");
assert.equal(movements.rows[1].reason, "Xuất sử dụng");
assert.equal(movements.sourceRows, 6, "sourceRows là số dòng WMS trả về, không phải số dòng đã lọc");

// 0.10.7 (review R8a): WMS đổi khoá danh sách → lỗi, không lưu bản chụp 0 dòng; 204 ({records: []}) vẫn hợp lệ.
for (const fn of ["normalizeApprovedPage", "normalizeInventoryPage", "normalizeImportExportPage"]) {
  assert.throws(() => core[fn]({ count: 3, items: [{ sku: "900000001" }] }), /WMS đổi dạng dữ liệu/, fn);
  assert.equal(core[fn]({ count: 0, page: 1, size: 500, records: [] }).rows.length, 0, `${fn}: 204 vẫn hợp lệ`);
}
console.log("inventory_audit_core: company switch, qty>0, held stock kept and approved-only filter passed");
