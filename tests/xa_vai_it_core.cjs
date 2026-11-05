// Xả vải theo phiếu IT (05/11/2026, Extension 0.12.6): normalizeXaVaiIt (đầu phiếu + dòng SL đã xuất + Group UID) và bộ đọc GET_XA_VAI_IT
// trong wms-bridge (fetch / chrome giả lập, không gọi mạng). Dạng phản hồi theo mẫu thật đo 05/11/2026; giá trị là dữ liệu giả.
//   node tests/xa_vai_it_core.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dir = "extension/inside-po-connector/";
const coreContext = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(dir + "group-uid-sync-core.js", "utf8"), coreContext);
const core = coreContext.globalThis.HasakiGroupUidSyncCore;
assert.equal(typeof core.normalizeXaVaiIt, "function");

const MAPPING = "10022600000001";
const HEAD = {
  internal_transfer_id: 8000001, internal_transfer_number: "1007260000000001", mapping_id: MAPPING, from_warehouse_name: "WH - MATERIAL - MTG",
  to_warehouse_name: "WH - SEMI PRODUCT - MTG", status_name: "Closed", type_name: "Normal", total_it_items: 2, description: "định mức xả vải mã TEST01",
  created_user_name: "nguoi.tao@example.com", created_at_tz: "2026-11-04T08:46:10+07:00",
};
const line = (sku, quantity, delivered, extra = {}) => ({ internal_transfer_item_id: 1, sku, product_name: `Vải thử ${sku}/mm`, quantity, delivered_quantity: delivered, uom: "mm", ...extra });
const ITEMS = { records: [line("900000001", 632000, 756071), line("900000002", 100000, null)] };
// group_uid_code là SỐ trong phản hồi thật.
const uid = (n, sku, qty, extra = {}) => ({ id: n, group_uid_code: 1028260000000000 + n, processing_source_code: MAPPING, processing_source_type: "INTERNAL_TRANSFER",
  uid_quantity: qty, batch_code: `LOT${n}`, roll_code: `R0${n}`, group_rfid_mapping: `A5000000000${n}`, location_description: "F0-A0-00-00-00-00", status_name: "Available",
  products: [{ product_id: 1, sku, product_name: `Vải thử ${sku}/mm`, quantity: qty }], ...extra });
const UIDS = [uid(1, "900000001", 300000), uid(2, "900000001", 286071), uid(1, "900000001", 300000) /* trùng */,
  uid(3, "900000001", 1000, { processing_source_code: "10022699999999" }) /* khác nguồn */, uid(4, "900000009", 5000) /* SKU ngoài phiếu */,
  uid(5, "900000001", 5000, { group_uid_code: "12345" }), uid(6, "900000001", 5000, { products: [{ sku: "900000001" }, { sku: "900000002" }] })];

const it = JSON.parse(JSON.stringify(core.normalizeXaVaiIt(HEAD, ITEMS, UIDS)));
assert.equal(it.number, "1007260000000001"); assert.equal(it.id, 8000001); assert.equal(it.mappingId, MAPPING);
assert.equal(it.description, "định mức xả vải mã TEST01"); assert.equal(it.status, "Closed"); assert.equal(it.items, undefined, "không trả items kiểu IN TEM SKU");
assert.deepEqual(it.lines, [
  { sku: "900000001", name: "Vải thử 900000001/mm", unit: "mm", requestedQty: 632000, deliveredQty: 756071 },
  { sku: "900000002", name: "Vải thử 900000002/mm", unit: "mm", requestedQty: 100000, deliveredQty: 0 },
]);
assert.deepEqual(it.uids, [
  { groupUid: "1028260000000001", sku: "900000001", lot: "LOT1", roll: "R01", qty: 300000, rfid: "A50000000001", status: "Available", location: "F0-A0-00-00-00-00" },
  { groupUid: "1028260000000002", sku: "900000001", lot: "LOT2", roll: "R02", qty: 286071, rfid: "A50000000002", status: "Available", location: "F0-A0-00-00-00-00" },
]);
assert.equal(it.uidTotal, 2);
assert.deepEqual(it.skipped, { otherSource: 1, badCode: 1, multiSku: 1, otherSku: 1 });
// Không có mapping_id → không nhận UID nào.
assert.equal(core.normalizeXaVaiIt({ ...HEAD, mapping_id: "" }, ITEMS, UIDS).uids.length, 0);
assert.throws(() => core.normalizeXaVaiIt(HEAD, { records: [line("900000001", 1, -5)] }, []), /SL đã xuất không hợp lệ/);
assert.throws(() => core.normalizeXaVaiIt(HEAD, { records: [line("900000001", 1, "abc")] }, []), /SL đã xuất không hợp lệ/);

// --- Bộ đọc trong wms-bridge ---
const calls = [];
let listener, lists = { records: [HEAD], count: 1 }, uidPages = [{ data: { records: UIDS.slice(0, 2), count: 2 } }];
const bridgeContext = {
  window: {}, URL, Date, Intl, Promise, JSON, Math, Number, String, Array, Object, Error, setTimeout, console,
  localStorage: { getItem: key => ({ auth_store: JSON.stringify({ state: { token: "test-token" } }), company_id: "1005" })[key] ?? null },
  fetch: async (url, options) => {
    const u = new URL(url); calls.push({ url: u, headers: options.headers });
    const body = u.pathname.endsWith("/internal-transfers") ? lists : u.pathname.endsWith("/group-uid-infos") ? uidPages[Number(u.searchParams.get("page")) - 1] || { data: { records: [], count: 0 } } : ITEMS;
    return { ok: true, status: 200, json: async () => body };
  },
  chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
};
bridgeContext.globalThis = bridgeContext;
bridgeContext.globalThis.HasakiGroupUidSyncCore = core;
vm.runInNewContext(fs.readFileSync(dir + "wms-bridge.js", "utf8"), bridgeContext);
const send = (message, sender = { id: "ext-id" }) => new Promise(resolve => { const kept = listener(message, sender, resolve); if (kept === false) resolve({ ignored: true }); });

(async () => {
  const ok = await send({ type: "GET_XA_VAI_IT", payload: { number: " 1007260000000001 " } });
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.data.uids.length, 2); assert.equal(ok.data.lines[0].deliveredQty, 756071); assert.ok(ok.data.generatedAt);
  const [list, items, uids] = calls.slice(-3);
  assert.equal(list.url.pathname, "/api/v1/wms/internal-transfers");
  assert.equal(list.url.searchParams.get("internal_transfer_numbers"), "1007260000000001");
  assert.equal(items.url.searchParams.get("internal_transfer_id"), "8000001");
  assert.equal(uids.url.pathname, "/api/v1/wms/group-uid-infos");
  assert.equal(uids.url.searchParams.get("processing_source_code"), MAPPING);
  assert.equal(uids.url.searchParams.get("size"), "500");
  for (const c of calls) { assert.equal(c.headers["company-ids"], undefined, "không phụ thuộc công ty của tab"); assert.equal(c.headers.Authorization, "Bearer test-token"); }

  // Nhiều trang: đọc tới khi đủ tổng.
  const many = Array.from({ length: 600 }, (_, i) => uid(100 + i, "900000001", 1000));
  uidPages = [{ data: { records: many.slice(0, 500), count: 600 } }, { data: { records: many.slice(500), count: 600 } }];
  let before = calls.length;
  const paged = await send({ type: "GET_XA_VAI_IT", payload: { number: "1007260000000001" } });
  assert.equal(paged.ok, true); assert.equal(paged.data.uids.length, 600);
  assert.deepEqual(calls.slice(before).filter(c => c.url.pathname.endsWith("/group-uid-infos")).map(c => c.url.searchParams.get("page")), ["1", "2"]);

  // WMS bỏ qua bộ lọc (tổng vọt lên) → báo lỗi, không đọc cả kho.
  uidPages = [{ data: { records: many.slice(0, 500), count: 25000 } }];
  before = calls.length;
  const huge = await send({ type: "GET_XA_VAI_IT", payload: { number: "1007260000000001" } });
  assert.equal(huge.ok, false); assert.match(huge.error.message, /tối đa 3\.000/); assert.equal(huge.error.code, "INTERNAL_TRANSFER_READ_FAILED");
  assert.equal(calls.slice(before).filter(c => c.url.pathname.endsWith("/group-uid-infos")).length, 1);

  // Không có phiếu / số sai / nơi gửi lạ.
  lists = { records: [] };
  assert.match((await send({ type: "GET_XA_VAI_IT", payload: { number: "1007260000000001" } })).error.message, /Không tìm thấy phiếu IT/);
  before = calls.length;
  const bad = await send({ type: "GET_XA_VAI_IT", payload: { number: "123456" } });
  assert.match(bad.error.message, /16 chữ số/); assert.equal(calls.length, before, "số phiếu sai thì không gọi WMS");
  assert.equal((await send({ type: "GET_XA_VAI_IT", payload: { number: "1007260000000001" } }, { id: "other" })).ignored, true);

  // Cầu nối web và background cho lệnh đi qua.
  for (const file of ["app-bridge.js", "background.js"]) assert.ok(fs.readFileSync(dir + file, "utf8").includes('"GET_XA_VAI_IT"'), `${file} cho GET_XA_VAI_IT`);
  console.log("xa_vai_it_core: dòng SL đã xuất, Group UID theo mapping_id (lọc nguồn / trùng / SKU ngoài phiếu), nhiều trang, chặn WMS bỏ lọc, không company-ids passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
