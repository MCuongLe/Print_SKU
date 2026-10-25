// UID trạng thái New để chọn in tem: bộ chuẩn hóa dòng group-uid-infos + bộ đọc trong wms-bridge (fetch/chrome giả lập, không gọi mạng).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dir = "extension/inside-po-connector/";
const coreSource = fs.readFileSync(dir + "group-uid-sync-core.js", "utf8");
const bridgeSource = fs.readFileSync(dir + "wms-bridge.js", "utf8");

// Dòng thật của WMS (rút gọn): group_uid_code là số, created_by_name là email, UID New chưa có products
const row = (code, extra = {}) => ({
  id: 28835, group_uid_code: code, group_uid_type: 2, warehouse_id: 1177, status_id: 1, created_by: 44480,
  created_at: "2026-10-14 11:13:37", updated_at: "2026-10-14 11:13:37", group_uid_type_name: "Fabric Roll",
  warehouse_name: "WH - MATERIAL - MTG", created_by_name: "nguoidung2@example.com", status_name: "New",
  created_at_tz: "2026-10-14T11:13:37+07:00", updated_at_tz: "2026-10-14T11:13:37+07:00", ...extra,
});

const coreContext = { globalThis: {} };
vm.runInNewContext(coreSource, coreContext);
const core = coreContext.globalThis.HasakiGroupUidSyncCore;
assert.equal(typeof core.normalizeNewUidPage, "function");

const page = core.normalizeNewUidPage({ page: 1, size: 500, count: 5590, records: [
  row(1028261014000001),
  row(1028260000000111, { warehouse_id: 1339, warehouse_name: "WH - MATERIAL - GARMENT", created_by_name: "nguoidung4@example.com", batch_code: "197/9", roll_code: "197/9-004", location_description: "F0-KHO-502-05-01-01", created_at_tz: "2026-10-08T08:02:01+07:00", updated_at_tz: "2026-10-09T10:00:00+07:00" }),
  row(1028261008000112, { status_id: 2, status_name: "Available" }),
  row(1028261014000001, { created_by_name: "trùng@hasaki.vn" }),
  row(1028261014000003, { status_id: undefined, status_name: "NEW", created_by_name: undefined, created_by: 777, group_uid_type_name: "" }),
] });
assert.equal(page.total, 5590, "tổng lấy từ count của WMS");
assert.equal(page.sourceRows, 5);
assert.equal(page.rows.length, 3, "bỏ UID không phải New, gộp UID trùng mã");
assert.deepEqual(JSON.parse(JSON.stringify(page.rows[0])), {
  group_uid_code: "1028261014000001", warehouse_id: 1177, warehouse: "WH - MATERIAL - MTG", type: "Fabric Roll",
  created_by: "trùng@hasaki.vn", created_at: "2026-10-14T04:13:37.000Z", updated_at: "2026-10-14T04:13:37.000Z",
  location: null, batch_code: null, roll_code: null,
});
const garment = page.rows.find(r => r.group_uid_code === "1028260000000111");
assert.equal(garment.warehouse_id, 1339);
assert.equal(garment.batch_code, "197/9"); assert.equal(garment.roll_code, "197/9-004"); assert.equal(garment.location, "F0-KHO-502-05-01-01");
assert.equal(garment.created_at, "2026-10-08T01:02:01.000Z");
assert.equal(garment.updated_at, "2026-10-09T03:00:00.000Z", "created_at và updated_at tách riêng");
const byId = page.rows.find(r => r.group_uid_code === "1028261014000003");
assert.equal(byId.created_by, "777", "thiếu created_by_name thì dùng created_by");
assert.equal(byId.type, null);
assert.equal(core.normalizeNewUidPage({ records: [] }).rows.length, 0);
assert.throws(() => core.normalizeNewUidPage({ records: [row("abc")] }), /Group UID không hợp lệ/);
assert.throws(() => core.normalizeNewUidPage({ records: [row(1028261014000009, { created_at_tz: "sai-ngày", created_at: undefined })] }), /Ngày/);

// --- Bộ đọc trong wms-bridge ---
const calls = [];
let listener;
const bridgeContext = {
  window: {}, URL, Date, Intl, Promise, JSON, Math, Number, String, Array, Object, Error, setTimeout, console,
  localStorage: { getItem: key => ({ auth_store: JSON.stringify({ state: { token: "test-token" } }), company_id: "1002" })[key] ?? null },
  fetch: async (url, options) => { calls.push({ url: new URL(url), headers: options.headers }); return { ok: true, status: 200, json: async () => ({ page: 1, size: 500, count: 2, records: [row(1028261014000001), row(1028261008000112, { status_id: 2, status_name: "Available" })] }) }; },
  chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
};
bridgeContext.globalThis = bridgeContext;
bridgeContext.globalThis.HasakiGroupUidSyncCore = core;
vm.runInNewContext(bridgeSource, bridgeContext);
const send = (message, sender = { id: "ext-id" }) => new Promise(resolve => { const kept = listener(message, sender, resolve); if (kept === false) resolve({ ignored: true }); });

(async () => {
  const from = "2026-10-08T00:00:00.000Z", to = "2026-10-14T09:00:00.000Z";
  const both = await send({ type: "GET_GROUP_UID_NEW_PAGE", payload: { page: 2, size: 500, from, to } });
  assert.equal(both.ok, true);
  assert.equal(both.data.rows.length, 1, "chỉ giữ UID New");
  assert.deepEqual(JSON.parse(JSON.stringify(both.data.warehouseIds)), [1177, 1339], "mặc định cả hai kho WH - MATERIAL");
  assert.equal(both.data.total, 2);
  let url = calls.at(-1).url;
  assert.equal(url.pathname, "/api/v1/wms/group-uid-infos");
  assert.equal(url.searchParams.get("active_tab"), "group-list");
  assert.equal(url.searchParams.get("status_ids"), "1", "WMS lọc sẵn trạng thái New");
  assert.equal(url.searchParams.get("warehouse_ids"), "1177,1339");
  assert.equal(url.searchParams.get("page"), "2"); assert.equal(url.searchParams.get("size"), "500");
  assert.equal(url.searchParams.get("from_updated_at"), String(Date.parse(from)));
  assert.equal(url.searchParams.get("to_updated_at"), String(Date.parse(to)));
  assert.equal(calls.at(-1).headers.Authorization, "Bearer test-token");

  await send({ type: "GET_GROUP_UID_NEW_PAGE", payload: { warehouseIds: [1339], from } });
  url = calls.at(-1).url;
  assert.equal(url.searchParams.get("warehouse_ids"), "1339");
  assert.ok(Math.abs(Number(url.searchParams.get("to_updated_at")) - Date.now()) < 60000, "chỉ có from thì to = bây giờ (WMS cần đủ hai mốc)");

  await send({ type: "GET_GROUP_UID_NEW_PAGE", payload: {} });
  url = calls.at(-1).url;
  assert.equal(url.searchParams.has("from_updated_at"), false, "không chọn ngày thì lấy mọi UID New");
  assert.equal(url.searchParams.has("to_updated_at"), false);

  const bad = await send({ type: "GET_GROUP_UID_NEW_PAGE", payload: { warehouseIds: [1151, 1178] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /kho hợp lệ/);
  const mixed = await send({ type: "GET_GROUP_UID_NEW_PAGE", payload: { warehouseIds: [1177, 999] } });
  assert.deepEqual(JSON.parse(JSON.stringify(mixed.data.warehouseIds)), [1177], "kho ngoài hai kho cho phép bị bỏ");
  assert.equal((await send({ type: "GET_GROUP_UID_NEW_PAGE", payload: {} }, { id: "other-extension" })).ignored, true, "bỏ qua tin nhắn từ nơi khác");
  console.log("group_uid_new_core: UID New, lọc kho/ngày phía WMS, hai kho cho phép và chặn dữ liệu sai passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
