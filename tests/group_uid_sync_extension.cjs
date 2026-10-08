const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("extension/inside-po-connector/group-uid-sync-core.js", "utf8");
const context = { globalThis: null, String, Number, Date, Array, Map, Object, RegExp, Error };
context.globalThis = context;
vm.runInNewContext(source, context);
const core = context.HasakiGroupUidSyncCore;

const raw = {
  group_uid_code: "1028261006000050", batch_code: "1", roll_code: "1",
  warehouse_name: "WH - MATERIAL - MTG", location_description: "F0-KHO-HM-04-01-01",
  status_name: "Available", updated_by_name: "user@example.invalid",
  updated_at_tz: "2026-10-07T08:41:57+07:00", uid_quantity: 7429,
  products: [{ sku: "422268923", quantity: 7429 }],
};
const row = JSON.parse(JSON.stringify(core.normalizeRow(raw)));
assert.deepEqual(row, {
  group_uid_code: "1028261006000050", batch_code: "1", roll_code: "1",
  warehouse: "WH - MATERIAL - MTG", location: "F0-KHO-HM-04-01-01", sku: "422268923",
  qty: 7429, updated_by: "user@example.invalid", updated_date: "2026-10-07T01:41:57.000Z", status: "Available",
  products: [{ sku: "422268923", quantity: 7429, product_name: null }],
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
    group_uid_code: "1028261008000140",
    warehouse_name: "WH - MATERIAL - MTG",
    status_name: "New",
    updated_at_tz: "2026-10-08T08:02:01+07:00",
  }],
});
assert.equal(actualWmsShape.total, 28608);
assert.equal(actualWmsShape.rows.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(actualWmsShape.rows[1])), {
  group_uid_code: "1028261008000140",
  batch_code: null,
  roll_code: null,
  warehouse: "WH - MATERIAL - MTG",
  location: null,
  sku: null,
  qty: 0,
  updated_by: null,
  updated_date: "2026-10-08T01:02:01.000Z",
  status: "New",
  products: [],
});
const multiSku = JSON.parse(JSON.stringify(core.normalizeRow({
  ...raw,
  group_uid_code: "1028260925000067",
  uid_quantity: 44,
  products: [
    { sku: "422439484", quantity: 7, product_name: "Panty XL" },
    { sku: "422439472", quantity: 7, product_name: "Panty M" },
    { sku: "422439473", quantity: 3, product_name: "Panty L" },
    { sku: "422439482", quantity: 10, product_name: "Panty M Blue" },
    { sku: "422439483", quantity: 17, product_name: "Panty L Blue" },
  ],
})));
assert.equal(multiSku.sku, null);
assert.equal(multiSku.qty, 44);
assert.equal(multiSku.products.length, 5);
assert.equal(multiSku.products.reduce((sum, item) => sum + item.quantity, 0), 44);
assert.throws(() => core.normalizeRow({ ...raw, updated_at_tz: "sai-ngày" }), /Ngày cập nhật/);
console.log("group_uid_sync_extension: ok");
