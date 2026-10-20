const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("extension/inside-po-connector/group-uid-sync-core.js", "utf8");
const context = { globalThis: null, String, Number, Date, Array, Map, Object, RegExp, Error };
context.globalThis = context;
vm.runInNewContext(source, context);
const core = context.HasakiGroupUidSyncCore;

const raw = {
  group_uid_code: "1028260000000050", batch_code: "1", roll_code: "1",
  warehouse_name: "WH - MATERIAL - MTG", location_description: "F0-KHO-HM-04-01-01",
  status_name: "Available", quality_control_status_name: "Passed", group_rfid_mapping: " a00000000001 ", updated_by_name: "user@example.invalid",
  updated_at_tz: "2026-10-07T08:41:57+07:00", uid_quantity: 7429,
  products: [{ sku: "900000002", quantity: 7429 }],
};
const row = JSON.parse(JSON.stringify(core.normalizeRow(raw)));
assert.deepEqual(row, {
  group_uid_code: "1028260000000050", batch_code: "1", roll_code: "1",
  warehouse: "WH - MATERIAL - MTG", location: "F0-KHO-HM-04-01-01", sku: "900000002",
  qty: 7429, updated_by: "user@example.invalid", updated_date: "2026-10-07T01:41:57.000Z", status: "Available", qc_status: "Passed",
  group_rfid_mapping: "A00000000001",
  products: [{ sku: "900000002", quantity: 7429, product_name: null }],
});

const page = core.normalizePage({ data: { items: [raw, { ...raw, status_name: "Allocated", updated_at_tz: "2026-10-07T09:00:00+07:00" }], total: 28468 } });
assert.equal(page.total, 28468);
assert.equal(page.rows.length, 1);
assert.equal(page.rows[0].status, "Allocated");

const actualWmsShape = core.normalizePage({
  page: 1,
  size: 500,
  count: 28608,
  records: [raw, {
    group_uid_code: "1028260000000140",
    warehouse_name: "WH - MATERIAL - MTG",
    status_name: "New",
    updated_at_tz: "2026-10-08T08:02:01+07:00",
  }],
});
assert.equal(actualWmsShape.total, 28608);
assert.equal(actualWmsShape.rows.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(actualWmsShape.rows[1])), {
  group_uid_code: "1028260000000140",
  batch_code: null,
  roll_code: null,
  warehouse: "WH - MATERIAL - MTG",
  location: null,
  sku: null,
  qty: 0,
  updated_by: null,
  updated_date: "2026-10-08T01:02:01.000Z",
  status: "New",
  qc_status: null,
  group_rfid_mapping: null,
  products: [],
});
const multiSku = JSON.parse(JSON.stringify(core.normalizeRow({
  ...raw,
  group_uid_code: "1028260000000067",
  uid_quantity: 44,
  products: [
    { sku: "900000008", quantity: 7, product_name: "Panty XL" },
    { sku: "900000004", quantity: 7, product_name: "Panty M" },
    { sku: "900000005", quantity: 3, product_name: "Panty L" },
    { sku: "900000006", quantity: 10, product_name: "Panty M Blue" },
    { sku: "900000007", quantity: 17, product_name: "Panty L Blue" },
  ],
})));
assert.equal(multiSku.sku, null);
assert.equal(multiSku.qty, 44);
assert.equal(multiSku.products.length, 5);
assert.equal(multiSku.products.reduce((sum, item) => sum + item.quantity, 0), 44);
assert.throws(() => core.normalizeRow({ ...raw, updated_at_tz: "sai-ngày" }), /Ngày cập nhật/);
// RFID (group_rfid_mapping, 20/10/2026): WMS chỉ có khoá khi UID đã gắn tem RFID. Ba trạng thái (Codex 20/10): chuỗi 1–40
// chữ/số → viết hoa; thiếu / null / rỗng → null (chưa gắn hoặc WMS gỡ → xoá theo); có giá trị nhưng SAI dạng → khoá bị bỏ khi
// gửi (JSON) → Edge "không biết" → giữ RFID đang lưu, không xoá nhầm.
const rfidOf = value => core.normalizeRow({ ...raw, group_rfid_mapping: value }).group_rfid_mapping;
const sentKeys = value => Object.keys(JSON.parse(JSON.stringify(core.normalizeRow({ ...raw, group_rfid_mapping: value }))));
assert.equal(rfidOf("B00000000002"), "B00000000002");
for (const gone of ["", "   ", null, undefined]) {
  assert.equal(rfidOf(gone), null, `RFID ${JSON.stringify(gone)} = chưa gắn → null`);
  assert.ok(sentKeys(gone).includes("group_rfid_mapping"), "null vẫn gửi khoá (Edge biết là đã gỡ)");
}
for (const bad of ["A-0001", "A0000 0000001", "Ã00000000001", "A".repeat(41), ["A00000000001"], 12345, { code: "A00000000001" }]) {
  assert.equal(sentKeys(bad).includes("group_rfid_mapping"), false, `RFID sai dạng ${JSON.stringify(bad)} → bỏ khoá khi gửi (không xoá nhầm)`);
}
assert.equal(rfidOf("A".repeat(40)), "A".repeat(40), "đúng 40 ký tự vẫn nhận");
console.log("group_uid_sync_extension: ok");
