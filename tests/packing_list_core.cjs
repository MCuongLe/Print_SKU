// Packing List PO của WMS: bộ chuẩn hóa dòng inbound-packing-lists + bộ đọc trong wms-bridge (fetch/chrome giả lập, không gọi mạng).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dir = "extension/inside-po-connector/";
const coreSource = fs.readFileSync(dir + "group-uid-sync-core.js", "utf8");
const bridgeSource = fs.readFileSync(dir + "wms-bridge.js", "utf8");

// Dòng thật của WMS (rút gọn): mỗi dòng là một cuộn của PO; SKU là Combo (kg)
const row = (code, extra = {}) => ({
  id: 10326, inbound_shmt_id: 42241906, inbound_shmt_number: "1001261014067061", purchase_order_number: "10012608011632", sku: "900000071",
  quantity: 19.76, code, created_at: "2026-10-08 10:17:33", created_by: "nguoidung5@example.com", product_name: "(Combo) Vải Single/HP SV18/190gsm/Đen/kg",
  purchase_order_status_name: "Open", batch_code: "1148/8", status_id: 2, status_name: "Approved", gross_quantity: 19.76, net_quantity: 19.76, delivery_method: "PARTIAL", ...extra,
});

const coreContext = { globalThis: {} };
vm.runInNewContext(coreSource, coreContext);
const core = coreContext.globalThis.HasakiGroupUidSyncCore;
assert.equal(typeof core.normalizePackingListPage, "function");

const page = core.normalizePackingListPage({ page: 1, size: 500, count: 53, records: [
  row("1148/8-025"), row("1148/8-024", { quantity: 19.88 }), row("1", { quantity: 1, batch_code: "N03-693/9/26DT", delivery_method: "FULL_PO", sku: "900000057" }),
  row("14", { status_name: undefined, product_name: undefined, batch_code: undefined, inbound_shmt_number: undefined, delivery_method: undefined }),
  row("12", { group_uid_code: 1028260000000146 }), row("13", { group_uid_code: " 1028260000000147 " }), row("15", { group_uid_code: "" }),
] });
assert.equal(page.total, 53, "tổng lấy từ count của WMS");
assert.equal(page.sourceRows, 7); assert.equal(page.rows.length, 7, "giữ nguyên từng dòng (từng cuộn), việc đếm UID do trang làm");
assert.deepEqual(JSON.parse(JSON.stringify(page.rows[0])), {
  purchase_order: "10012608011632", shipment: "1001261014067061", sku: "900000071", product_name: "(Combo) Vải Single/HP SV18/190gsm/Đen/kg",
  quantity: 19.76, code: "1148/8-025", batch_code: "1148/8", status: "Approved", delivery: "PARTIAL", group_uid: null,
});
// Cuộn đã tạo Group UID (WMS trả số; mã giả): giữ dạng chuỗi để trang bỏ dòng này khi gán tem; khoá luôn có (kể cả null) để trang biết Extension đã đủ mới
assert.equal(page.rows[4].group_uid, "1028260000000146"); assert.equal(page.rows[5].group_uid, "1028260000000147"); assert.equal(page.rows[6].group_uid, null);
assert.ok(page.rows.every(r => "group_uid" in r));
assert.equal(page.rows[2].quantity, 1); assert.equal(page.rows[2].code, "1", "dòng quantity 1 / code 1 vẫn là một cuộn, trả về để trang đếm");
assert.equal(page.rows[0].group_uid, null, "WMS bỏ khoá group_uid_code khi cuộn chưa có UID → null");
const bare = page.rows[3];
assert.equal(bare.status, null); assert.equal(bare.product_name, null); assert.equal(bare.batch_code, null); assert.equal(bare.shipment, null); assert.equal(bare.delivery, null);
assert.equal(core.normalizePackingListPage({ records: [] }).rows.length, 0);
assert.throws(() => core.normalizePackingListPage({ records: [row("1", { purchase_order_number: "abc" })] }), /mã PO không hợp lệ/);
assert.throws(() => core.normalizePackingListPage({ records: [row("1", { sku: "" })] }), /SKU không hợp lệ/);
assert.throws(() => core.normalizePackingListPage({ records: [row("1", { quantity: "x" })] }), /số lượng không hợp lệ/);
assert.throws(() => core.normalizePackingListPage({ records: [row("1", { quantity: -3 })] }), /số lượng không hợp lệ/);

// --- Bộ đọc trong wms-bridge ---
const calls = [];
let listener;
const bridgeContext = {
  window: {}, URL, Date, Intl, Promise, JSON, Math, Number, String, Array, Object, Error, setTimeout, console,
  localStorage: { getItem: key => ({ auth_store: JSON.stringify({ state: { token: "test-token" } }), company_id: "1002" })[key] ?? null },
  fetch: async (url, options) => { calls.push({ url: new URL(url), headers: options.headers }); return { ok: true, status: 200, json: async () => ({ page: 1, size: 500, count: 1200, records: [row("1148/8-001"), row("1148/8-002")] }) }; },
  chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
};
bridgeContext.globalThis = bridgeContext;
bridgeContext.globalThis.HasakiGroupUidSyncCore = core;
vm.runInNewContext(bridgeSource, bridgeContext);
const send = (message, sender = { id: "ext-id" }) => new Promise(resolve => { const kept = listener(message, sender, resolve); if (kept === false) resolve({ ignored: true }); });

(async () => {
  const one = await send({ type: "GET_PACKING_LIST_PAGE", payload: { purchaseOrders: ["10012608011632"], page: 2, size: 500 } });
  assert.equal(one.ok, true);
  assert.equal(one.data.rows.length, 2);
  assert.equal(one.data.total, 1200); assert.equal(one.data.totalPages, 3, "1.200 dòng / 500 = 3 trang");
  assert.deepEqual(JSON.parse(JSON.stringify(one.data.purchaseOrders)), ["10012608011632"]);
  let url = calls.at(-1).url;
  assert.equal(url.pathname, "/api/v1/wms/inbound-packing-lists");
  assert.equal(url.searchParams.get("purchase_order_numbers"), "10012608011632");
  assert.equal(url.searchParams.get("page"), "2"); assert.equal(url.searchParams.get("size"), "500");
  assert.equal(calls.at(-1).headers.Authorization, "Bearer test-token");

  const many = await send({ type: "GET_PACKING_LIST_PAGE", payload: { purchaseOrders: [" 10012608011632 ", "10012606143838", "10012608011632", "abc", "", null, 5] } });
  assert.deepEqual(JSON.parse(JSON.stringify(many.data.purchaseOrders)), ["10012608011632", "10012606143838"], "bỏ mã không hợp lệ và mã trùng, cắt khoảng trắng");
  assert.equal(calls.at(-1).url.searchParams.get("purchase_order_numbers"), "10012608011632,10012606143838");
  const lots = Array.from({ length: 30 }, (_, i) => String(10012600000000 + i));
  await send({ type: "GET_PACKING_LIST_PAGE", payload: { purchaseOrders: lots } });
  assert.equal(calls.at(-1).url.searchParams.get("purchase_order_numbers").split(",").length, 20, "tối đa 20 PO một lần");
  await send({ type: "GET_PACKING_LIST_PAGE", payload: { purchaseOrders: ["10012608011632"], size: 9999, page: -4 } });
  assert.equal(calls.at(-1).url.searchParams.get("size"), "500"); assert.equal(calls.at(-1).url.searchParams.get("page"), "1");

  const before = calls.length;
  const none = await send({ type: "GET_PACKING_LIST_PAGE", payload: { purchaseOrders: ["abc"] } });
  assert.equal(none.ok, false); assert.match(none.error.message, /mã PO hợp lệ/); assert.equal(calls.length, before, "không có PO hợp lệ thì không gọi WMS");
  assert.equal((await send({ type: "GET_PACKING_LIST_PAGE", payload: { purchaseOrders: ["10012608011632"] } }, { id: "other-extension" })).ignored, true, "bỏ qua tin nhắn từ nơi khác");
  console.log("packing_list_core: chuẩn hóa dòng Packing List, lọc theo PO, giới hạn 20 PO và chặn dữ liệu sai passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
