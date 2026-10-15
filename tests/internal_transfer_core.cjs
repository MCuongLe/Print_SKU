// Phiếu IT (chuyển kho nội bộ) cho IN TEM SKU: bộ chuẩn hóa đầu phiếu + dòng và bộ đọc trong wms-bridge (fetch/chrome giả lập, không gọi mạng).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dir = "extension/inside-po-connector/";
const coreSource = fs.readFileSync(dir + "group-uid-sync-core.js", "utf8");
const bridgeSource = fs.readFileSync(dir + "wms-bridge.js", "utf8");

// Dữ liệu thật của WMS (rút gọn, đã đổi người dùng): đầu phiếu và 3 dòng pcs / mm / g
const HEAD = {
  internal_transfer_id: 8121626, internal_transfer_number: "1007261015013137", from_warehouse_name: "WH - MATERIAL - MTG", to_warehouse_name: "SF - HIEP THANH Q12",
  status_id: 4, status_name: "In-progress", type_name: "Normal", total_it_items: 22, description: "outsource_order 45 IT_OUT", created_user_name: "nguoi.tao@example.com",
  created_at: "2026-10-15 16:38:39", created_at_tz: "2026-10-15T16:38:39+07:00",
};
const item = (sku, quantity, uom, extra = {}) => ({ internal_transfer_item_id: 1, internal_transfer_id: 8121626, status_id: 4, product_id: 1, product_name: `Hàng ${sku}/${uom}`, sku, quantity, uom, stock_out_quantity: 999999, ...extra });
const ITEMS = { total_quantity: 170042, records: [item("422499599", 2, "pcs"), item("422292974", 170000, "mm"), item("422386182", 42, "g"), item("422386183", 1.5, null, { product_name: undefined })] };

const coreContext = { globalThis: {} };
vm.runInNewContext(coreSource, coreContext);
const core = coreContext.globalThis.HasakiGroupUidSyncCore;
assert.equal(typeof core.normalizeInternalTransfer, "function");

const it = JSON.parse(JSON.stringify(core.normalizeInternalTransfer(HEAD, ITEMS)));
const { items: _items, ...itHead } = it;
assert.deepEqual(itHead, {
  number: "1007261015013137", id: 8121626, status: "In-progress", type: "Normal", fromWarehouse: "WH - MATERIAL - MTG", toWarehouse: "SF - HIEP THANH Q12",
  description: "outsource_order 45 IT_OUT", createdBy: "nguoi.tao@example.com", createdAt: "2026-10-15T09:38:39.000Z", totalItems: 22,
});
assert.deepEqual(it.items, [
  { sku: "422499599", name: "Hàng 422499599/pcs", quantity: 2, unit: "pcs" },
  { sku: "422292974", name: "Hàng 422292974/mm", quantity: 170000, unit: "mm" },
  { sku: "422386182", name: "Hàng 422386182/g", quantity: 42, unit: "g" },
  { sku: "422386183", name: null, quantity: 1.5, unit: null },
], "số lượng giữ đúng theo phiếu (quantity, không dùng stock_out_quantity), phiếu không ghi đơn vị thì unit = null");
assert.equal(core.normalizeInternalTransfer({ ...HEAD, created_at_tz: "sai", created_at: undefined, total_it_items: 0 }, { records: [] }).createdAt, null, "ngày sai không làm hỏng phiếu");
assert.equal(core.normalizeInternalTransfer({ ...HEAD, total_it_items: 0 }, { records: [item("1", 1, "pcs")] }).totalItems, 1);
assert.throws(() => core.normalizeInternalTransfer({ ...HEAD, internal_transfer_id: "x" }, ITEMS), /không hợp lệ/);
assert.throws(() => core.normalizeInternalTransfer(HEAD, { records: [item("", 1, "pcs")] }), /SKU không hợp lệ/);
assert.throws(() => core.normalizeInternalTransfer(HEAD, { records: [item("422", -1, "pcs")] }), /số lượng không hợp lệ/);
assert.throws(() => core.normalizeInternalTransfer(HEAD, { records: [item("422", null, "pcs")] }), /số lượng không hợp lệ/);

// --- Bộ đọc trong wms-bridge ---
const calls = [];
let listener, lists = { records: [HEAD], count: 1 };
const bridgeContext = {
  window: {}, URL, Date, Intl, Promise, JSON, Math, Number, String, Array, Object, Error, setTimeout, console,
  localStorage: { getItem: key => ({ auth_store: JSON.stringify({ state: { token: "test-token" } }), company_id: "1002" })[key] ?? null },
  fetch: async (url, options) => {
    const u = new URL(url); calls.push({ url: u, headers: options.headers });
    const body = u.pathname.endsWith("/internal-transfers") ? lists : ITEMS;
    return { ok: true, status: 200, json: async () => body };
  },
  chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
};
bridgeContext.globalThis = bridgeContext;
bridgeContext.globalThis.HasakiGroupUidSyncCore = core;
vm.runInNewContext(bridgeSource, bridgeContext);
const send = (message, sender = { id: "ext-id" }) => new Promise(resolve => { const kept = listener(message, sender, resolve); if (kept === false) resolve({ ignored: true }); });

(async () => {
  const ok = await send({ type: "GET_INTERNAL_TRANSFER", payload: { number: " 1007261015013137 " } });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.number, "1007261015013137"); assert.equal(ok.data.items.length, 4); assert.ok(ok.data.generatedAt);
  const [list, items] = calls.slice(-2).map(c => c.url);
  assert.equal(list.pathname, "/api/v1/wms/internal-transfers");
  assert.equal(list.searchParams.get("internal_transfer_numbers"), "1007261015013137");
  assert.equal(list.searchParams.has("from_date"), false, "không cần khoảng ngày (phiếu cũ vẫn tìm được)");
  assert.equal(items.pathname, "/api/v1/wms/transfer/internal-transfer-items/list-details");
  assert.equal(items.searchParams.get("internal_transfer_id"), "8121626");
  assert.equal(calls.at(-1).headers.Authorization, "Bearer test-token");

  // WMS trả phiếu khác số (tìm gần đúng) hoặc không có phiếu: báo không tìm thấy, không đọc dòng
  lists = { records: [{ ...HEAD, internal_transfer_number: "10072610150131370" }] };
  let before = calls.length;
  const miss = await send({ type: "GET_INTERNAL_TRANSFER", payload: { number: "1007261015013137" } });
  assert.equal(miss.ok, false); assert.match(miss.error.message, /Không tìm thấy phiếu IT 1007261015013137/);
  assert.equal(miss.error.code, "INTERNAL_TRANSFER_READ_FAILED");
  assert.equal(calls.length, before + 1, "không có phiếu thì không gọi API dòng");
  lists = { records: [] };
  assert.match((await send({ type: "GET_INTERNAL_TRANSFER", payload: { number: "1007260101000001" } })).error.message, /Không tìm thấy/);

  before = calls.length;
  const bad = await send({ type: "GET_INTERNAL_TRANSFER", payload: { number: "IT-123" } });
  assert.equal(bad.ok, false); assert.match(bad.error.message, /Số phiếu IT không hợp lệ/); assert.equal(calls.length, before, "số phiếu sai thì không gọi WMS");
  assert.equal((await send({ type: "GET_INTERNAL_TRANSFER", payload: { number: "1007261015013137" } }, { id: "other-extension" })).ignored, true, "bỏ qua tin nhắn từ nơi khác");
  console.log("internal_transfer_core: phiếu IT theo số phiếu, dòng SKU + số lượng + đơn vị, không tìm thấy / số sai / dữ liệu sai passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
