// Lịch sử chuyển vị trí Group UID: bộ chuẩn hóa dòng WMS + bộ đọc trong wms-bridge (fetch/chrome giả lập, không gọi mạng).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const dir = "extension/inside-po-connector/";
const coreSource = fs.readFileSync(dir + "group-uid-sync-core.js", "utf8");
const bridgeSource = fs.readFileSync(dir + "wms-bridge.js", "utf8");

const transfer = (id, extra = {}) => ({
  id, group_uid_id: 20000 + id, group_uid_code: 1028260605000000 + id, action: 4, action_name: "Transfer location",
  warehouse_id: 1177, warehouse_name: "WH - MATERIAL - MTG",
  location_description: "F0-VR-00-00-00-00", old_location_description: "F0-KHO-503-02-04-01",
  updated_by_name: "user@example.test", created_by_name: "other@example.test",
  created_at_tz: "2026-10-10T15:37:52+07:00", updated_at_tz: "2026-10-10T15:37:52+07:00", ...extra,
});

// --- Bộ chuẩn hóa ---
const coreContext = { globalThis: {} };
vm.runInNewContext(coreSource, coreContext);
const core = coreContext.globalThis.HasakiGroupUidSyncCore;
assert.equal(typeof core.normalizeMovesPage, "function");

const page = core.normalizeMovesPage({ page: 1, size: 500, count: 7, records: [
  transfer(39311),
  { id: 39312, group_uid_code: 1028260605000999, action: 9, action_name: "Cut", warehouse_id: 1177, note: "Cut 1 out of group 1028260605000999 (remaining 2)", updated_at_tz: "2026-10-10T15:40:00+07:00" },
  transfer(39313, { action: undefined, action_name: "transfer LOCATION", old_location_description: null, location_description: "  F0-KHO-501-01-01-01 " }),
  transfer(39311),
  transfer(39314, { warehouse_id: null, warehouse_name: "", updated_by_name: undefined, created_by_name: "creator@example.test" }),
] });
assert.equal(page.total, 7, "tổng lấy từ count của WMS");
assert.equal(page.sourceRows, 5);
assert.equal(page.rows.length, 3, "bỏ dòng Cut, gộp dòng trùng id");
assert.deepEqual(JSON.parse(JSON.stringify(page.rows[0])), {
  history_id: 39311, group_uid_code: "1028260605039311", warehouse_id: 1177, warehouse: "WH - MATERIAL - MTG",
  action_code: 4, action_name: "Transfer location", from_location: "F0-KHO-503-02-04-01", to_location: "F0-VR-00-00-00-00",
  moved_by: "user@example.test", moved_at: "2026-10-10T08:37:52.000Z",
});
assert.equal(page.rows[1].history_id, 39313);
assert.equal(page.rows[1].action_code, 4, "nhận dòng theo tên khi thiếu mã action");
assert.equal(page.rows[1].from_location, null);
assert.equal(page.rows[1].to_location, "F0-KHO-501-01-01-01");
assert.equal(page.rows[2].warehouse_id, null);
assert.equal(page.rows[2].warehouse, null);
assert.equal(page.rows[2].moved_by, "creator@example.test");
assert.equal(core.normalizeMovesPage({ records: [] }).rows.length, 0);
assert.equal(core.normalizeMovesPage({ records: [] }).total, 0);
assert.throws(() => core.normalizeMovesPage({ records: [transfer(0)] }), /thiếu mã dòng/);
assert.throws(() => core.normalizeMovesPage({ records: [transfer(5, { group_uid_code: "abc" })] }), /Group UID không hợp lệ/);
assert.throws(() => core.normalizeMovesPage({ records: [transfer(5, { updated_at_tz: "sai-ngày", updated_at: undefined, created_at_tz: undefined })] }), /Ngày cập nhật/);

const companies = core.normalizeCompanies({ records: [
  { company_id: 1001, company_code: "hasaki", company_name: "Cty CP Hasaki Vietnam" },
  { id: "1002", code: "mastige", name: "Cty Mastige" },
  { company_id: "x" }, { company_id: 0 },
] });
assert.deepEqual(JSON.parse(JSON.stringify(companies)), [
  { companyId: 1001, companyCode: "hasaki", companyName: "Cty CP Hasaki Vietnam" },
  { companyId: 1002, companyCode: "mastige", companyName: "Cty Mastige" },
]);

// --- Bộ đọc trong wms-bridge ---
const calls = [];
let listener;
const bridgeContext = {
  window: {}, URL, Date, Intl, Promise, JSON, Math, Number, String, Array, Object, Error, setTimeout, console,
  localStorage: { getItem: key => ({ auth_store: JSON.stringify({ state: { token: "test-token" } }), company_id: "1001" })[key] ?? null },
  fetch: async (url, options) => {
    calls.push({ url: new URL(url), headers: options.headers });
    const path = new URL(url).pathname;
    if (path.endsWith("/master-data/company")) return { ok: true, status: 200, json: async () => ({ records: [{ company_id: 1005, company_code: "garment", company_name: "Cty Garment" }] }) };
    return { ok: true, status: 200, json: async () => ({ page: 1, size: 500, count: 1, records: [transfer(1), { id: 2, group_uid_code: 1028260605000300, action: 9, action_name: "Cut", updated_at_tz: "2026-10-10T15:40:00+07:00" }] }) };
  },
  chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
};
bridgeContext.globalThis = bridgeContext;
bridgeContext.globalThis.HasakiGroupUidSyncCore = core;
vm.runInNewContext(bridgeSource, bridgeContext);
assert.equal(typeof listener, "function");

const send = (message, sender = { id: "ext-id" }) => new Promise(resolve => {
  const kept = listener(message, sender, resolve);
  if (kept === false) resolve({ ignored: true });
});

(async () => {
  const from = "2026-10-01T00:00:00.000Z", to = "2026-10-10T09:00:00.000Z";
  const moves = await send({ type: "GET_GROUP_UID_MOVES_PAGE", payload: { companyId: 1002, page: 2, size: 500, from, to } });
  assert.equal(moves.ok, true);
  assert.equal(moves.data.rows.length, 1, "chỉ giữ dòng Transfer location");
  assert.equal(moves.data.total, 1);
  assert.equal(moves.data.companyId, 1002);
  const url = calls.at(-1).url, headers = calls.at(-1).headers;
  assert.equal(url.pathname, "/api/v1/wms/group-uid-info-histories");
  assert.equal(url.searchParams.get("active_tab"), "group-history");
  assert.equal(url.searchParams.get("actions"), "4", "WMS chỉ trả dòng Transfer location");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("size"), "500");
  assert.equal(url.searchParams.get("from_updated_at"), String(Date.parse(from)));
  assert.equal(url.searchParams.get("to_updated_at"), String(Date.parse(to)));
  assert.equal(url.searchParams.has("warehouse_ids"), false, "không giới hạn kho: lấy mọi kho của công ty");
  assert.equal(headers["company-ids"], "1002", "đổi công ty theo yêu cầu, không theo công ty đang chọn trên WMS");
  assert.equal(headers.Authorization, "Bearer test-token");

  const noCompany = await send({ type: "GET_GROUP_UID_MOVES_PAGE", payload: { page: 1 } });
  assert.equal(noCompany.ok, false);
  assert.match(noCompany.error.message, /công ty/);

  const list = await send({ type: "GET_WMS_COMPANIES", payload: {} });
  assert.equal(list.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(list.data.companies)), [{ companyId: 1005, companyCode: "garment", companyName: "Cty Garment" }]);
  assert.equal(calls.at(-1).url.searchParams.get("check_permission"), "true");

  assert.equal((await send({ type: "GET_GROUP_UID_MOVES_PAGE", payload: { companyId: 1002 } }, { id: "other-extension" })).ignored, true, "bỏ qua tin nhắn từ nơi khác");
  console.log("group_uid_moves_core: Transfer location, bộ đọc theo công ty và chặn dữ liệu sai passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
