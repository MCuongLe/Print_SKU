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
});

const page = core.normalizePage({ data: { items: [raw, { ...raw, status_name: "Allocated", updated_at_tz: "2026-10-07T09:00:00+07:00" }], total: 28468 } });
assert.equal(page.total, 28468);
assert.equal(page.rows.length, 1);
assert.equal(page.rows[0].status, "Allocated");
assert.throws(() => core.normalizeRow({ ...raw, products: [{ sku: "A" }, { sku: "B" }] }), /nhiều SKU/);
assert.throws(() => core.normalizeRow({ ...raw, updated_at_tz: "sai-ngày" }), /Ngày cập nhật/);
console.log("group_uid_sync_extension: ok");
