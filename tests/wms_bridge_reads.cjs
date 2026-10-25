// Kiểm tra extension/inside-po-connector/wms-bridge.js không cần Chrome hay WMS thật:
// nạp ba script vào một vm với localStorage, chrome.runtime và fetch giả, rồi gửi message như trang web làm.
//   node tests/wms_bridge_reads.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const DIR = "extension/inside-po-connector/";

function load({ token = "test-token", fetchImpl }) {
  const listeners = [];
  const store = token ? { auth_store: JSON.stringify({ state: { token } }), company_id: "1002" } : {};
  const sandbox = {
    console, URL, URLSearchParams,
    localStorage: { getItem: key => (key in store ? store[key] : null) },
    chrome: { runtime: { id: "ext", onMessage: { addListener: listener => listeners.push(listener) } } },
    fetch: fetchImpl,
    setTimeout: callback => { callback(); return 0; }, // bỏ thời gian chờ giữa các lần thử lại
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const name of ["group-uid-sync-core.js", "inventory-audit-core.js", "wms-bridge.js"]) {
    vm.runInContext(fs.readFileSync(DIR + name, "utf8"), sandbox, { filename: name });
  }
  assert.equal(listeners.length, 1, "wms-bridge phải đăng ký đúng một listener");
  return listeners[0];
}

const ask = (listener, type, payload = {}) => new Promise(resolve => listener({ type, payload }, { id: "ext" }, resolve));
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// Mỗi lần gọi lấy một phần tử trong danh sách; phần tử là Error thì fetch ném lỗi (mất mạng).
function sequence(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

const ROW = {
  group_uid_code: "1028260000000050", batch_code: "B", roll_code: "5", warehouse_name: "WH", location_description: "A-01",
  uid_quantity: 3, status_name: "Available", updated_at_tz: "2026-10-10T10:00:00+07:00",
  products: [{ sku: "900000014", quantity: 3, product_name: "Vai thu nghiem" }],
};

(async () => {
  // Group UID: mất mạng một lần rồi đọc được, không hỏng cả lượt
  let fetchImpl = sequence(new TypeError("Failed to fetch"), reply(200, { count: 1, records: [ROW] }));
  let result = await ask(load({ fetchImpl }), "GET_GROUP_UID_PAGE");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.rows.length, 1);
  assert.equal(fetchImpl.calls.length, 2, "phải thử lại sau lỗi mạng");

  // Group UID: 429 rồi 200
  fetchImpl = sequence(reply(429, {}), reply(200, { count: 1, records: [ROW] }));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_PAGE");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetchImpl.calls.length, 2);

  // Group UID: WMS trả 204 cho khoảng rỗng thì là 0 dòng, không phải lỗi đọc JSON
  fetchImpl = sequence(reply(204, null));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_PAGE");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.data.rows.length, result.data.total], [0, 0]);

  // Lịch sử Cắt: 503 rồi 200, và 204
  fetchImpl = sequence(reply(503, {}), reply(200, { count: 0, records: [] }));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_HISTORY_PAGE");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetchImpl.calls.length, 2);
  result = await ask(load({ fetchImpl: sequence(reply(204, null)) }), "GET_GROUP_UID_HISTORY_PAGE");
  assert.equal(result.ok, true, JSON.stringify(result));

  // 401/403: báo đúng thông điệp của từng loại đọc và không thử lại
  fetchImpl = sequence(reply(401, {}));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_HISTORY_PAGE");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Admin/);
  assert.equal(fetchImpl.calls.length, 1, "401 không được thử lại");
  assert.equal(result.error.reason, "session", "0.10.7: 401 = hết phiên (đồng bộ tự động bỏ qua)");
  fetchImpl = sequence(reply(403, {}));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_PAGE");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Group UID/);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(result.error.reason, "denied", "0.10.7: 403 = mất quyền (đồng bộ tự động báo lỗi)");
  result = await ask(load({ fetchImpl: sequence(reply(503, {}), reply(503, {}), reply(503, {})) }), "GET_GROUP_UID_PAGE");
  assert.deepEqual([result.ok, result.error.reason], [false, "network"], "0.10.7: hết lượt thử lại 5xx = lỗi mạng/máy chủ");

  // Hết phiên WMS: báo "đăng nhập lại" ngay, không gọi fetch và không bị nhầm thành lỗi mạng
  for (const type of ["GET_GROUP_UID_PAGE", "GET_GROUP_UID_HISTORY_PAGE", "GET_GROUP_UID_MOVES_PAGE"]) {
    fetchImpl = sequence(new TypeError("Failed to fetch"));
    result = await ask(load({ token: "", fetchImpl }), type);
    assert.equal(result.ok, false, type);
    assert.match(result.error.message, /đăng nhập lại/, `${type}: ${result.error.message}`);
    assert.doesNotMatch(result.error.message, /ngắt kết nối/, type);
    assert.equal(fetchImpl.calls.length, 0, `${type}: không được gọi fetch khi chưa có phiên`);
  }

  // Lỗi mạng kéo dài: sau 3 lần thì báo ngắt kết nối
  fetchImpl = sequence(new TypeError("Failed to fetch"));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_PAGE");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ngắt kết nối/);
  assert.equal(fetchImpl.calls.length, 3);

  // Nhập xuất kho (Kiểm soát công trình): hai lệnh config_query=1 (dòng) + 2 (tổng), đúng kho/khoảng ngày/công ty, chia trang theo tổng
  const movement = { id: 7, warehouse_id: 1151, warehouse_name: "OFFICE - 130 AP CHANH - MTG", sku: "900000077", quantity: 12, type: 2, source_type: "ADJUSTMENT", reason_name: "Xuất sử dụng", created_at_tz: "2026-10-12T17:23:09+07:00" };
  const movementFetch = async (url, init) => {
    movementFetch.calls.push({ url: String(url), init });
    const query = new URL(url).searchParams.get("config_query");
    return reply(200, query === "2" ? { count: 474, page: 1, size: 500 } : { page: 1, size: 500, records: [movement] });
  };
  movementFetch.calls = [];
  const from = new Date("2026-07-01T00:00:00+07:00").getTime(), to = new Date("2026-10-15T23:59:59+07:00").getTime();
  result = await ask(load({ fetchImpl: movementFetch }), "GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [1151], companyId: 1002, from: "2026-07-01T00:00:00+07:00", to: "2026-10-15T23:59:59+07:00", page: 1, size: 500 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.data.rows.length, result.data.rows[0].kind, result.data.total, result.data.totalPages], [1, "out", 474, 1], "474 dòng / 500 mỗi trang = 1 trang");
  assert.equal(movementFetch.calls.length, 2, "một lệnh lấy dòng, một lệnh lấy tổng");
  const sent = movementFetch.calls.map(call => new URL(call.url));
  assert.equal(sent[0].pathname, "/api/v2/wms/report-management/stock-import-exports");
  assert.deepEqual(sent.map(url => url.searchParams.get("config_query")).sort(), ["1", "2"]);
  for (const url of sent) {
    assert.equal(url.searchParams.get("warehouse_ids"), "1151");
    assert.equal(url.searchParams.get("from_date"), String(from));
    assert.equal(url.searchParams.get("to_date"), String(to));
  }
  assert.equal(movementFetch.calls[0].init.headers["company-ids"], "1002", "đọc đúng pháp nhân của kho");
  assert.equal(movementFetch.calls[0].init.credentials, "omit");
  movementFetch.calls.length = 0;
  result = await ask(load({ fetchImpl: movementFetch }), "GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [1151], from: String(from), to: String(to), page: 2, size: 100 });
  assert.equal(result.data.totalPages, 5, "474 dòng / 100 mỗi trang = 5 trang; mili giây dạng chuỗi cũng được nhận");
  assert.equal(new URL(movementFetch.calls[0].url).searchParams.get("from_date"), String(from));
  for (const bad of [{ warehouseIds: [] }, { warehouseIds: [1151], from: "không phải ngày" }, { warehouseIds: [1151], from: "2026-10-15", to: "2026-07-01" }, { warehouseIds: [1151] }]) {
    fetchImpl = sequence(reply(200, {}));
    result = await ask(load({ fetchImpl }), "GET_STOCK_IMPORT_EXPORT_PAGE", bad);
    assert.equal(result.ok, false, JSON.stringify(bad));
    assert.equal(result.error.code, "IMPORT_EXPORT_READ_FAILED");
    assert.equal(fetchImpl.calls.length, 0, "tham số sai thì không gọi WMS");
  }
  fetchImpl = sequence(reply(403, {}));
  result = await ask(load({ fetchImpl }), "GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [1151], from, to });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Import\/Export/);
  result = await ask(load({ token: "", fetchImpl: sequence(reply(200, {})) }), "GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [1151], from, to });
  assert.match(result.error.message, /đăng nhập lại/);
  result = await ask(load({ fetchImpl: sequence(reply(204, null)) }), "GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [1151], from, to });
  assert.deepEqual([result.ok, result.data.rows.length, result.data.total], [true, 0, 0], "khoảng ngày không có dòng nào là 0 dòng, không phải lỗi");

  // Lấy mẫu cắt/QC: Group UID và ASN theo PO — đúng tham số lọc, số PO sai không gọi WMS, WMS trả PO khác bị chặn, 403 / hết phiên / 204
  const PO = "10012600000777";
  const poRow = (over = {}) => ({ ...ROW, group_uid_code: 1028260000000001, processing_source_code: PO, processing_source_type: "PURCHASE_ORDER", ...over });
  fetchImpl = sequence(reply(200, { count: 1, records: [poRow()] }));
  result = await ask(load({ fetchImpl }), "GET_PO_GROUP_UID_PAGE", { purchaseOrder: ` ${PO} `, page: 2, size: 9999 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.data.rows[0].group_uid_code, result.data.rows[0].purchase_order, result.data.total, result.data.page, result.data.size, result.data.purchaseOrder], ["1028260000000001", PO, 1, 2, 500, PO]);
  let sentUrl = new URL(fetchImpl.calls[0].url);
  assert.equal(sentUrl.pathname, "/api/v1/wms/group-uid-infos");
  assert.deepEqual([sentUrl.searchParams.get("processing_source_code"), sentUrl.searchParams.get("active_tab"), sentUrl.searchParams.get("page"), sentUrl.searchParams.get("size")], [PO, "group-list", "2", "500"], "số PO được cắt khoảng trắng, size chặn ở 500");
  assert.equal(sentUrl.searchParams.get("from_updated_at"), String(Date.UTC(2020, 0, 1)));
  assert.ok(Number(sentUrl.searchParams.get("to_updated_at")) > Date.now(), "WMS cần đủ cả from và to; to là ngày mai");
  assert.equal(fetchImpl.calls[0].init.credentials, "omit");
  assert.equal(sentUrl.searchParams.get("warehouse_ids"), null, "không lọc kho: PO có thể nhận ở nhiều kho");
  for (const bad of ["", "abc", "12345", "1001260000077x", null]) {
    fetchImpl = sequence(reply(200, { count: 0, records: [] }));
    result = await ask(load({ fetchImpl }), "GET_PO_GROUP_UID_PAGE", { purchaseOrder: bad });
    assert.equal(result.ok, false, String(bad));
    assert.match(result.error.message, /mã PO hợp lệ/);
    assert.equal(fetchImpl.calls.length, 0, "PO sai thì không gọi WMS");
  }
  result = await ask(load({ fetchImpl: sequence(reply(200, { count: 2, records: [poRow(), poRow({ group_uid_code: 1028260000000002, processing_source_code: "10012699999999" })] })) }), "GET_PO_GROUP_UID_PAGE", { purchaseOrder: PO });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /không phải PO/, "WMS bỏ qua bộ lọc thì không trộn UID của PO khác");
  fetchImpl = sequence(reply(403, {}));
  result = await ask(load({ fetchImpl }), "GET_PO_GROUP_UID_PAGE", { purchaseOrder: PO });
  assert.match(result.error.message, /Group UID/);
  assert.equal(fetchImpl.calls.length, 1);
  result = await ask(load({ token: "", fetchImpl: sequence(reply(200, {})) }), "GET_PO_GROUP_UID_PAGE", { purchaseOrder: PO });
  assert.match(result.error.message, /đăng nhập lại/);
  result = await ask(load({ fetchImpl: sequence(reply(204, null)) }), "GET_PO_GROUP_UID_PAGE", { purchaseOrder: PO });
  assert.deepEqual([result.ok, result.data.rows.length, result.data.total, result.data.totalPages], [true, 0, 0, 1], "PO chưa có UID là 0 dòng, không phải lỗi");

  const asnRow = (over = {}) => ({ asn_id: 60611, asn_number: "1002261015060611", asn_type: "PURCHASE_ORDER", status_name: "Received", inbound_shmt_number: "1001260618081586", purchase_order_number: PO, warehouse_name: "WH - MATERIAL - MTG", created_at_tz: "2026-10-15T18:51:03+07:00", ...over });
  fetchImpl = sequence(reply(200, { count: 2, records: [asnRow(), asnRow({ asn_id: 35563, asn_number: "1002261015035563", status_name: "Open" })] }));
  result = await ask(load({ fetchImpl }), "GET_PO_ASN_PAGE", { purchaseOrder: PO });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.data.rows.map(row => row.status), result.data.total, result.data.purchaseOrder], [["Received", "Open"], 2, PO]);
  sentUrl = new URL(fetchImpl.calls[0].url);
  assert.equal(sentUrl.pathname, "/api/v2/wms/asns");
  assert.equal(sentUrl.searchParams.get("purchase_order_numbers"), PO, "tên tham số SỐ NHIỀU mới lọc được");
  assert.equal(sentUrl.searchParams.get("from_date"), String(Date.UTC(2020, 0, 1)));
  assert.ok(Number(sentUrl.searchParams.get("to_date")) > Date.now());
  result = await ask(load({ fetchImpl: sequence(reply(200, { count: 1, records: [asnRow({ purchase_order_number: "10012699999999" })] })) }), "GET_PO_ASN_PAGE", { purchaseOrder: PO });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /không phải PO/);
  fetchImpl = sequence(reply(200, {}));
  result = await ask(load({ fetchImpl }), "GET_PO_ASN_PAGE", { purchaseOrder: "abc" });
  assert.equal(result.ok, false);
  assert.equal(fetchImpl.calls.length, 0);
  assert.match((await ask(load({ fetchImpl: sequence(reply(403, {})) }), "GET_PO_ASN_PAGE", { purchaseOrder: PO })).error.message, /ASN/);
  result = await ask(load({ fetchImpl: sequence(reply(204, null)) }), "GET_PO_ASN_PAGE", { purchaseOrder: PO });
  assert.deepEqual([result.ok, result.data.rows.length, result.data.total], [true, 0, 0], "PO chưa có ASN là 0 dòng, không phải lỗi");

  console.log("wms_bridge_reads: thử lại 429/5xx/lỗi mạng, 204, 401/403 và hết phiên cho Group UID, lịch sử Cắt, lịch sử chuyển vị trí, nhập xuất kho và đọc Group UID/ASN theo PO passed");
})().catch(error => { console.error(error); process.exit(1); });
