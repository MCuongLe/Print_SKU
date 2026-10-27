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

  // Số phiếu cho nguồn Cut (GET_WMS_DOC_INFO, 26/10/2026): mapping trên dòng Import/Export → phiếu ADJ (danh sách + chi tiết lấy PO) / IT.
  // Chỉ GET, ≤ 20 mã mỗi loại, WMS bỏ qua bộ lọc (trả phiếu khác mã) thì không nhận. Lệnh lạ thì listener không trả lời → coi là chưa hỗ trợ.
  const askDoc = (listener, payload) => new Promise(resolve => {
    if (listener({ type: "GET_WMS_DOC_INFO", payload }, { id: "ext" }, resolve) !== true) resolve({ ok: false, error: { code: "NOT_HANDLED", message: "wms-bridge chưa nhận GET_WMS_DOC_INFO" } });
  });
  const ADJ_MAP = "100052600000001", ADJ_MAP2 = "100052600000003", IT_MAP = "10022600000002";
  const docFetch = (over = {}) => {
    const fn = async (url, init) => {
      fn.calls.push({ url: new URL(String(url)), init });
      const p = new URL(String(url)).pathname;
      if (p in over) return typeof over[p] === "function" ? over[p](new URL(String(url))) : over[p];
      if (p === "/api/v1/wms/adjustments") return reply(200, { count: 2, records: [
        { adjustment_id: 501, adjustment_number: "1008260000000001", reason_name: "Xuất test", mapping_code: ADJ_MAP, status_name: "Closed" },
        { adjustment_id: 599, adjustment_number: "1008260000000099", reason_name: "Xuất sử dụng", mapping_code: "100052600000099" }, // WMS trả thêm phiếu khác mã
      ] });
      if (p === "/api/v1/wms/adjustment/adjustments/detail") return reply(200, { data: { adjustment_id: 501, adjustment_number: "1008260000000001", reference_code: "10012600000001", description: "https://work.example.test/tasks?task_id=1" } });
      if (p === "/api/v1/wms/internal-transfers") return reply(200, { records: [{ internal_transfer_id: 77, internal_transfer_number: "1007260000000002", mapping_id: Number(IT_MAP), to_warehouse_name: "WH - SEMI PRODUCT - TEST", description: "NPL may mẫu giả", status_name: "Closed" }] });
      return reply(404, {});
    };
    fn.calls = [];
    return fn;
  };
  fetchImpl = docFetch();
  result = await askDoc(load({ fetchImpl }), { adj: [ADJ_MAP, ` ${ADJ_MAP2} `, "abc"], it: [IT_MAP] });
  assert.equal(result.ok, true, JSON.stringify(result));
  const plain = value => JSON.parse(JSON.stringify(value)); // đối tượng tạo trong vm khác realm
  assert.deepEqual(plain(result.data.adj), [{ mappingCode: ADJ_MAP, number: "1008260000000001", reason: "Xuất test", po: "10012600000001" }], "ADJ: số phiếu + lý do + số PO; phiếu khác mã bị bỏ, mã không có phiếu thì không trả");
  assert.deepEqual(plain(result.data.it), [{ mappingId: IT_MAP, number: "1007260000000002", toWarehouse: "WH - SEMI PRODUCT - TEST", description: "NPL may mẫu giả", status: "Closed" }]);
  const byPath = p => fetchImpl.calls.filter(c => c.url.pathname === p);
  assert.equal(byPath("/api/v1/wms/adjustments")[0].url.searchParams.get("mapping_codes"), `${ADJ_MAP},${ADJ_MAP2}`, "lọc mapping_codes (bỏ mã sai dạng)");
  assert.deepEqual(byPath("/api/v1/wms/adjustment/adjustments/detail").map(c => c.url.searchParams.get("adjustment_id")), ["501"], "chỉ đọc chi tiết phiếu đúng mã");
  assert.equal(byPath("/api/v1/wms/internal-transfers")[0].url.searchParams.get("mapping_ids"), IT_MAP);
  assert.ok(fetchImpl.calls.every(c => !c.init.method && !c.init.body && c.init.credentials === "omit"), "chỉ GET, không gửi cookie");
  // Chỉ IT → không gọi ADJ; chi tiết ADJ trả số phiếu khác → không lấy PO
  fetchImpl = docFetch();
  result = await askDoc(load({ fetchImpl }), { it: [IT_MAP] });
  assert.deepEqual(plain([result.ok, result.data.adj, fetchImpl.calls.map(c => c.url.pathname)]), [true, [], ["/api/v1/wms/internal-transfers"]]);
  fetchImpl = docFetch({ "/api/v1/wms/adjustment/adjustments/detail": reply(200, { data: { adjustment_number: "1008260000000777", reference_code: "10012600000777" } }) });
  result = await askDoc(load({ fetchImpl }), { adj: [ADJ_MAP] });
  assert.equal(result.data.adj[0].po, null, "chi tiết lệch số phiếu → không lấy PO");
  // Chi tiết ADJ lỗi riêng một phiếu: vẫn trả số phiếu + lý do của danh sách và các phiếu còn lại (review 26/10/2026: một chi tiết lỗi làm hỏng
  // cả lô). Vòng 2: chỉ 404 / thân rỗng (204) là chắc chắn không có chi tiết → po null; lỗi tạm (WMS 500 sau 3 lần thử, mất mạng, thân hỏng)
  // → detailFailed: true để bộ ghép coi phiếu là chưa tra được và thử lại lượt sau (set_source chỉ ghi Cut chưa nguồn: ghi PO rỗng là mất
  // PO vĩnh viễn). Hết phiên (401) / mất quyền (403) ở chi tiết → lỗi cả lệnh.
  const twoAdj = { "/api/v1/wms/adjustments": reply(200, { records: [
    { adjustment_id: 501, adjustment_number: "1008260000000001", reason_name: "Xuất test", mapping_code: ADJ_MAP },
    { adjustment_id: 503, adjustment_number: "1008260000000003", reason_name: "Xuất test", mapping_code: ADJ_MAP2 },
  ] }) };
  const detailBy = reply501 => url => (url.searchParams.get("adjustment_id") === "501" ? reply501()
    : reply(200, { data: { adjustment_id: 503, adjustment_number: "1008260000000003", reference_code: "10012600000003" } }));
  for (const [label, reply501, extra] of [
    ["500", () => reply(500, {}), { detailFailed: true }],
    ["mất mạng", () => { throw new TypeError("Failed to fetch"); }, { detailFailed: true }],
    ["thân hỏng", () => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } }), { detailFailed: true }],
    ["404", () => reply(404, {}), {}],
    ["204 thân rỗng", () => reply(204, null), {}],
  ]) {
    fetchImpl = docFetch({ ...twoAdj, "/api/v1/wms/adjustment/adjustments/detail": detailBy(reply501) });
    result = await askDoc(load({ fetchImpl }), { adj: [ADJ_MAP, ADJ_MAP2], it: [IT_MAP] });
    assert.equal(result.ok, true, `chi tiết ${label}: ${JSON.stringify(result)}`);
    assert.deepEqual(plain(result.data.adj), [
      { mappingCode: ADJ_MAP, number: "1008260000000001", reason: "Xuất test", po: null, ...extra },
      { mappingCode: ADJ_MAP2, number: "1008260000000003", reason: "Xuất test", po: "10012600000003" },
    ], `chi tiết ${label}: ${extra.detailFailed ? "đánh dấu detailFailed (thử lại lượt sau)" : "chắc chắn không có chi tiết → po null, không cờ"}, giữ các phiếu còn lại`);
    assert.equal(result.data.it.length, 1, `chi tiết ${label}: vẫn trả phiếu IT`);
  }
  for (const [status, reason] of [[403, "denied"], [401, "session"]]) {
    fetchImpl = docFetch({ ...twoAdj, "/api/v1/wms/adjustment/adjustments/detail": detailBy(() => reply(status, {})) });
    result = await askDoc(load({ fetchImpl }), { adj: [ADJ_MAP, ADJ_MAP2], it: [IT_MAP] });
    assert.deepEqual([result.ok, result.error.code, result.error.reason], [false, "WMS_DOC_READ_FAILED", reason], `chi tiết ${status}: lỗi cả lệnh`);
    assert.match(result.error.message, /phiếu ADJ/);
  }
  // Tham số sai: không gọi WMS
  for (const bad of [{}, { adj: [], it: [] }, { adj: ["abc"] }, { adj: Array.from({ length: 21 }, (_, i) => String(100052600000100 + i)) }, { it: Array.from({ length: 21 }, (_, i) => String(10022600000100 + i)) }]) {
    fetchImpl = docFetch();
    result = await askDoc(load({ fetchImpl }), bad);
    assert.equal(result.ok, false, JSON.stringify(bad).slice(0, 80));
    assert.equal(result.error.code, "WMS_DOC_READ_FAILED");
    assert.equal(fetchImpl.calls.length, 0, "tham số sai thì không gọi WMS");
  }
  // 403 / hết phiên / mất mạng
  fetchImpl = docFetch({ "/api/v1/wms/adjustments": reply(403, {}) });
  result = await askDoc(load({ fetchImpl }), { adj: [ADJ_MAP] });
  assert.deepEqual([result.ok, result.error.reason], [false, "denied"]);
  assert.match(result.error.message, /phiếu ADJ/);
  result = await askDoc(load({ token: "", fetchImpl: docFetch() }), { it: [IT_MAP] });
  assert.match(result.error.message, /đăng nhập lại/);
  result = await askDoc(load({ fetchImpl: sequence(new TypeError("Failed to fetch")) }), { it: [IT_MAP] });
  assert.deepEqual([result.ok, result.error.reason], [false, "network"]);

  // ---- RỦI RO LƯU TRỮ · Hàng chưa lên kệ (26/10/2026): Transfer Location History theo vị trí đến + SKU (GET_TRANSFER_BIN_PAGE) ----
  for (const file of ["app-bridge.js", "background.js"]) assert.match(fs.readFileSync(DIR + file, "utf8"), /"GET_TRANSFER_BIN_PAGE"/, `${file}: allow-list có GET_TRANSFER_BIN_PAGE`);
  {
    // Cầu nối chưa có lệnh thì im lặng: chặn bằng hạn chờ để test báo đỏ thay vì thoát lặng lẽ.
    const within = (promise, ms = 3000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("wms-bridge không trả lời GET_TRANSFER_BIN_PAGE")), ms); })]).finally(() => clearTimeout(timer)); };
    const BIN = "F0-A0-00-00-00-00", SKU = "900000051";
    const tb = (over = {}) => ({ id: 11, warehouse_id: 1177, sku: SKU, quantity: 1.5, bin_out: "F0-KHO-01-01-01-01", bin_in: BIN, cart_code: "", status: 1, created_by: 99, created_user_name: "cat@example.test", created_at: "2026-10-20 10:00:00", transfer_type: "EDIT_UID_GROUP", source_id: 7001, ...over });
    const vnMs = text => Date.parse(`${text.replace(" ", "T")}+07:00`);
    const makeFetch = ({ records, count, history = "ok" }) => {
      const fetchImpl = async (url, init) => {
        fetchImpl.calls.push({ url: String(url), init });
        const u = new URL(url);
        if (u.pathname.endsWith("/transfer-bins")) return records === 204 ? reply(204, null) : records === 403 ? reply(403, {}) : reply(200, { count, page: 1, size: 20, records });
        if (u.pathname.endsWith("/group-uid-info-histories")) return history === "fail" ? reply(403, {}) : reply(200, { count: 2, records: [
          { id: 1, group_uid_id: 7001, group_uid_code: "1028260000000701", action: 9, warehouse_id: 1177 },
          { id: 2, group_uid_id: 8888, group_uid_code: "1028260000000888", action: 10, warehouse_id: 1177 },
        ] });
        return reply(404, {});
      };
      fetchImpl.calls = [];
      return fetchImpl;
    };
    const rows = [
      tb(),
      tb({ id: 12, transfer_type: "", source_id: 7002, created_at: "2026-10-19 09:00:00", created_user_name: "chuyen@example.test" }),
      tb({ id: 13, transfer_type: "RE_PO", source_id: 555, created_at: "2026-10-18 08:00:00", created_user_name: "" }),
      tb({ id: 14, bin_in: "F0-KHO-01-01-01-01" }),
      tb({ id: 15, sku: "900000099" }),
    ];
    let tf = makeFetch({ records: rows, count: 30 });
    result = await within(ask(load({ fetchImpl: tf }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, companyId: 1002, binIn: BIN, sku: ` ${SKU} `, page: 1, size: 999 }));
    assert.equal(result.ok, true, JSON.stringify(result));
    const d = result.data;
    assert.deepEqual(JSON.parse(JSON.stringify(d.rows[0])), { id: 11, sku: SKU, qty: 1.5, from: "F0-KHO-01-01-01-01", to: BIN, type: "EDIT_UID_GROUP", by: "cat@example.test", at: "2026-10-20 10:00:00", uidId: 7001, uid: "1028260000000701" }, "dòng chuẩn hoá + mã Group UID tra từ lịch sử cùng giờ");
    assert.deepEqual(d.rows.map(r => [r.id, r.type, r.uidId, r.uid, r.by]), [[11, "EDIT_UID_GROUP", 7001, "1028260000000701", "cat@example.test"], [12, "", 7002, "", "chuyen@example.test"], [13, "RE_PO", null, "", "99"]], "source_id chỉ là Group UID khi loại trống / EDIT_UID_GROUP; thiếu tên thì lấy created_by");
    assert.deepEqual([d.sourceRows, d.total, d.size, d.warehouseId, d.binIn, d.sku], [5, 3, 50, 1177, BIN, SKU], "dòng khác vị trí / SKU (WMS bỏ qua bộ lọc) bị loại và không tin count; tối đa 50 dòng/trang");
    const sent = new URL(tf.calls[0].url);
    assert.equal(sent.pathname, "/api/v1/wms/transfer-bins");
    assert.deepEqual(["warehouse_id", "bin_in", "keywords", "page", "size"].map(k => sent.searchParams.get(k)), ["1177", BIN, SKU, "1", "50"], "lọc kho (số ít), vị trí đến, SKU");
    assert.deepEqual([tf.calls[0].init.headers["company-ids"], tf.calls[0].init.credentials], ["1002", "omit"], "đọc đúng pháp nhân của kho, không gửi cookie");
    const hist = tf.calls.map(c => new URL(c.url)).filter(u => u.pathname.endsWith("/group-uid-info-histories"));
    assert.equal(hist.length, 2, "hai mốc giờ cách xa nhau → hai lần tra lịch sử (tối đa 3)");
    for (const u of hist) assert.deepEqual([u.searchParams.get("active_tab"), u.searchParams.get("warehouse_ids")], ["group-history", "1177"]);
    const t11 = vnMs("2026-10-20 10:00:00");
    assert.ok(hist.some(u => Number(u.searchParams.get("from_updated_at")) <= t11 - 60000 && Number(u.searchParams.get("to_updated_at")) >= t11 + 60000), "khoảng tra quanh giờ chuyển (giờ WMS là giờ VN)");
    // Kho Garment: header công ty của kho đó; không có dòng thì không tra lịch sử
    const seen = [];
    const headerFetch = async (url, init) => { seen.push({ url: String(url), init }); return reply(200, { count: 0, records: [] }); };
    result = await within(ask(load({ fetchImpl: headerFetch }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1339, companyId: 1005, binIn: "F0-AJ-00-00-00-00", sku: SKU }));
    assert.deepEqual([result.ok, result.data.rows.length, result.data.total, result.data.size], [true, 0, 0, 20], "mặc định 20 dòng; không có dòng là 0");
    assert.equal(seen[0].init.headers["company-ids"], "1005", "đọc đúng pháp nhân của kho");
    assert.equal(seen[0].init.credentials, "omit");
    assert.equal(seen.length, 1, "không có dòng cần tra thì không gọi lịch sử");
    // Mã vị trí có chữ tiếng Việt vẫn đọc được (không làm dừng cả lượt đọc nguồn)
    seen.length = 0;
    result = await within(ask(load({ fetchImpl: headerFetch }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: "F0-ĐG-00-00-00-01", sku: SKU }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(new URL(seen[0].url).searchParams.get("bin_in"), "F0-ĐG-00-00-00-01");
    // Lịch sử lỗi (403): vẫn trả dòng, mã Group UID để trống
    tf = makeFetch({ records: rows.slice(0, 1), count: 1, history: "fail" });
    result = await within(ask(load({ fetchImpl: tf }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: BIN, sku: SKU }));
    assert.deepEqual([result.ok, result.data.rows[0].uid, result.data.rows[0].uidId, result.data.total], [true, "", 7001, 1], "tra lịch sử lỗi không làm hỏng lệnh");
    // Tham số sai: không gọi WMS
    for (const bad of [{ warehouseId: 0, binIn: BIN, sku: SKU }, { warehouseId: 1177, binIn: "", sku: SKU }, { warehouseId: 1177, binIn: BIN, sku: "" }, { warehouseId: 1177, binIn: BIN, sku: "900 000" }, { warehouseId: 1177, binIn: "F0&A0", sku: SKU }]) {
      tf = makeFetch({ records: [], count: 0 });
      result = await within(ask(load({ fetchImpl: tf }), "GET_TRANSFER_BIN_PAGE", bad));
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.equal(result.error.code, "TRANSFER_BIN_READ_FAILED");
      assert.equal(tf.calls.length, 0, "tham số sai thì không gọi WMS");
    }
    result = await within(ask(load({ fetchImpl: makeFetch({ records: 403 }) }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: BIN, sku: SKU }));
    assert.deepEqual([result.ok, result.error.code, result.error.reason], [false, "TRANSFER_BIN_READ_FAILED", "denied"]);
    assert.match(result.error.message, /chuyển vị trí/);
    result = await within(ask(load({ token: "", fetchImpl: makeFetch({ records: [] }) }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: BIN, sku: SKU }));
    assert.match(result.error.message, /đăng nhập lại/);
    result = await within(ask(load({ fetchImpl: makeFetch({ records: 204 }) }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: BIN, sku: SKU }));
    assert.deepEqual([result.ok, result.data.rows.length, result.data.total], [true, 0, 0], "204 là 0 dòng");
    result = await within(ask(load({ fetchImpl: async () => reply(200, { count: 1, items: [tb()] }) }), "GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: BIN, sku: SKU }));
    assert.equal(result.ok, false, "WMS đổi khoá danh sách → lỗi, không coi là 0 dòng");
  }

  // ---- 27/10/2026: WMS trả HTTP 200 {page, size} (không count, không records) khi danh sách rỗng — đo thật ở transfer-bins và group-uid-infos
  // (khoảng ngày không có thay đổi). Trước đây bị coi là "WMS đổi dạng" → Hàng chưa lên kệ dừng ở cặp rỗng đầu tiên (1/35 cặp có nguồn), đồng bộ Group UID gia tăng báo Lỗi.
  // 0.12.2 nới hai lệnh đó; 0.12.3 thêm lịch sử Cắt / chuyển vị trí (group-uid-info-histories) và Import/Export (đối chiếu lệnh đếm).
  // Tồn kho cũng trả {page, size} khi kho / công ty không khớp nên Kiểm kê (tồn kho, APPROVED) vẫn phải báo lỗi (R8a). ----
  {
    const EMPTY = { page: 1, size: 20 };
    const BIN = "F0-A0-00-00-00-00", SKU = "900000051", from = "2026-10-01T00:00:00+07:00", to = "2026-10-02T00:00:00+07:00";
    const bodyFetch = body => async () => reply(200, body);
    const TRANSFER = ["GET_TRANSFER_BIN_PAGE", { warehouseId: 1177, binIn: BIN, sku: SKU }], GROUP = ["GET_GROUP_UID_PAGE", {}];
    for (const [type, payload] of [TRANSFER, GROUP]) {
      result = await ask(load({ fetchImpl: bodyFetch(EMPTY) }), type, payload);
      assert.equal(result.ok, true, `${type}: {page,size} là danh sách rỗng, không phải lỗi · ${JSON.stringify(result.error || "")}`);
      assert.deepEqual([result.data.rows.length, result.data.total], [0, 0], `${type}: 0 dòng`);
      // Chỉ đúng dạng {page, size} số: khoá thừa, count (kể cả 0) không kèm danh sách, page / size chuỗi, thiếu khoá, thân rỗng / null / mảng vẫn là WMS đổi dạng
      for (const drift of [{ page: 1, size: 20, items: [{ sku: SKU }] }, { page: 1, size: 20, count: 5 }, { page: 1, size: 20, count: 0 }, { page: "1", size: "20" }, { page: "x", size: 20 }, { page: 1 }, {}, null, []]) {
        result = await ask(load({ fetchImpl: bodyFetch(drift) }), type, payload);
        assert.equal(result.ok, false, `${type}: dạng lạ ${JSON.stringify(drift)} vẫn là lỗi`);
      }
    }
    // 0.12.3: lịch sử Cắt (Đối chiếu ADJ tự động mỗi 30 phút) và lịch sử chuyển vị trí cùng endpoint group-uid-info-histories cũng trả {page, size}
    // khi khoảng rỗng → 0 dòng. Bộ chuẩn hoá hai lệnh này nay đòi có danh sách: count không kèm danh sách, khoá danh sách lạ, page / size chuỗi,
    // thiếu khoá, {}, null, mảng là "WMS đổi dạng" — trước đây thành 0 dòng (count thành tổng) và lượt Cắt tiến mốc phủ qua khoảng chưa đọc.
    const HISTORY = ["GET_GROUP_UID_HISTORY_PAGE", { from, to }], MOVES = ["GET_GROUP_UID_MOVES_PAGE", { companyId: 1002, from, to }];
    const listedRow = {
      GET_GROUP_UID_HISTORY_PAGE: { group_uid_code: "1028260000000901", note: "Cut 2 out of group 1028260000000901 (remaining 8)", warehouse_name: "WH - MATERIAL - MTG", updated_at_tz: "2026-10-01T10:00:00+07:00" },
      GET_GROUP_UID_MOVES_PAGE: { id: 901, group_uid_code: "1028260000000902", action: 4, action_name: "Transfer location", warehouse_id: 1177, updated_at_tz: "2026-10-01T10:00:00+07:00" },
    };
    for (const [type, payload] of [HISTORY, MOVES]) {
      result = await ask(load({ fetchImpl: bodyFetch(EMPTY) }), type, payload);
      assert.equal(result.ok, true, `${type}: {page,size} là danh sách rỗng, không phải lỗi · ${JSON.stringify(result.error || "")}`);
      assert.deepEqual([result.data.rows.length, result.data.total, result.data.sourceRows], [0, 0, 0], `${type}: 0 dòng`);
      for (const drift of [{ page: 1, size: 20, count: 5 }, { page: 1, size: 20, count: 0 }, { page: 1, size: 20, results: [listedRow[type]] }, { page: "1", size: "20" }, { page: "x", size: 20 }, { page: 1 }, {}, null, []]) {
        result = await ask(load({ fetchImpl: bodyFetch(drift) }), type, payload);
        assert.equal(result.ok, false, `${type}: dạng lạ ${JSON.stringify(drift)} vẫn là lỗi`);
        assert.match(result.error.message, /đổi dạng dữ liệu/, `${type}: ${JSON.stringify(drift)} → ${result.error.message}`);
      }
      // {page, size} kèm khoá thừa không bị đổi thành rỗng: `items` là khoá danh sách bộ chuẩn hoá vẫn đọc (dùng chung với normalizePage) → dòng vẫn được đọc
      result = await ask(load({ fetchImpl: bodyFetch({ page: 1, size: 20, items: [listedRow[type]] }) }), type, payload);
      assert.deepEqual([result.ok, result.data?.rows.length], [true, 1], `${type}: {page,size,items:[…]} không bị coi là rỗng · ${JSON.stringify(result.error || "")}`);
      // 204 và {count:0, records:[]} vẫn hợp lệ
      for (const empty of [reply(204, null), reply(200, { count: 0, records: [] })]) {
        result = await ask(load({ fetchImpl: async () => empty }), type, payload);
        assert.deepEqual([result.ok, result.data?.rows.length, result.data?.total], [true, 0, 0], `${type}: ${empty.status} rỗng vẫn là 0 dòng`);
      }
      // Có danh sách nhưng rỗng mà count báo còn dòng ở trang này là mâu thuẫn (cùng luật với Import/Export): lỗi mạng, không thành 0 dòng + tiến mốc phủ
      result = await ask(load({ fetchImpl: async () => reply(200, { count: 5, page: 1, size: 500, records: [] }) }), type, { ...payload, page: 1, size: 500 });
      assert.deepEqual([result.ok, result.error?.reason], [false, "network"], `${type}: records rỗng mà count 5 là mâu thuẫn · ${JSON.stringify(result.data || "")}`);
      assert.match(result.error.message, /mâu thuẫn/, type);
      // Trang vượt cuối hợp lệ: 1.000 dòng, trang 3 × 500 → 0 dòng, tổng giữ 1.000
      result = await ask(load({ fetchImpl: async () => reply(200, { count: 1000, page: 3, size: 500, records: [] }) }), type, { ...payload, page: 3, size: 500 });
      assert.deepEqual([result.ok, result.data?.rows.length, result.data?.total], [true, 0, 1000], `${type}: trang vượt cuối là 0 dòng`);
    }
    // Lệnh chuyển vị trí vẫn gửi công ty yêu cầu (tham số thứ ba của getJson) khi bật emptyPage
    {
      const seen = [];
      result = await ask(load({ fetchImpl: async (url, init) => { seen.push(init.headers["company-ids"]); return reply(200, EMPTY); } }), ...MOVES);
      assert.deepEqual([result.ok, seen], [true, ["1002"]], "GET_GROUP_UID_MOVES_PAGE: header company-ids = công ty yêu cầu");
    }

    // 0.12.3: Import/Export — cả lệnh dòng (config_query=1) lẫn lệnh đếm (config_query=2) trả {page, size} khi khoảng ngày rỗng → 0 dòng.
    // Danh sách {page, size} chỉ là rỗng khi lệnh đếm cũng không còn dòng ở trang này: đếm > (page − 1) × size mà danh sách rỗng → lỗi (reason network).
    {
      const IE = "GET_STOCK_IMPORT_EXPORT_PAGE", iePayload = { warehouseIds: [1151], companyId: 1002, from, to };
      const ieFetch = (listBody, countBody) => {
        const fn = async url => { fn.queries.push(new URL(url).searchParams.get("config_query")); return reply(200, new URL(url).searchParams.get("config_query") === "2" ? countBody : listBody); };
        fn.queries = [];
        return fn;
      };
      let ief = ieFetch({ page: 1, size: 500 }, { page: 1, size: 500 });
      result = await ask(load({ fetchImpl: ief }), IE, iePayload);
      assert.equal(result.ok, true, `${IE}: hai lệnh {page,size} là khoảng rỗng · ${JSON.stringify(result.error || "")}`);
      assert.deepEqual([result.data.rows.length, result.data.total, result.data.totalPages], [0, 0, 1], `${IE}: 0 dòng`);
      assert.deepEqual(ief.queries.sort(), ["1", "2"]);
      result = await ask(load({ fetchImpl: ieFetch({ page: 1, size: 500 }, { count: 1200, page: 1, size: 500 }) }), IE, iePayload);
      assert.deepEqual([result.ok, result.error?.code, result.error?.reason], [false, "IMPORT_EXPORT_READ_FAILED", "network"], `${IE}: danh sách rỗng mà lệnh đếm 1.200 dòng là mâu thuẫn`);
      assert.match(result.error.message, /mâu thuẫn/);
      result = await ask(load({ fetchImpl: ieFetch({ page: 1, size: 500 }, { count: 3, page: 1, size: 500 }) }), IE, iePayload);
      assert.deepEqual([result.ok, result.error?.reason], [false, "network"], `${IE}: lệnh đếm 3 dòng mà trang 1 rỗng → lỗi`);
      // Trang vượt cuối hợp lệ: 1.000 dòng, trang 3 × 500 → 0 dòng
      result = await ask(load({ fetchImpl: ieFetch({ page: 3, size: 500 }, { count: 1000, page: 3, size: 500 }) }), IE, { ...iePayload, page: 3, size: 500 });
      assert.equal(result.ok, true, `${IE}: trang vượt cuối · ${JSON.stringify(result.error || "")}`);
      assert.deepEqual([result.data.rows.length, result.data.total, result.data.totalPages], [0, 1000, 2], `${IE}: trang vượt cuối là 0 dòng`);
      // Danh sách có dòng thật: như cũ (tổng theo lệnh đếm)
      result = await ask(load({ fetchImpl: ieFetch({ page: 1, size: 500, records: [movement] }, { count: 1200, page: 1, size: 500 }) }), IE, iePayload);
      assert.deepEqual([result.ok, result.data?.rows.length, result.data?.total, result.data?.totalPages], [true, 1, 1200, 3], `${IE}: danh sách có dòng chạy như cũ`);
      // Căn cứ an toàn của việc nới (đo 27/10/2026): company-ids lệch kho trả HTTP 400, kho không tồn tại trả 404 — lỗi, không thành 0 dòng
      for (const status of [400, 404]) {
        result = await ask(load({ fetchImpl: async () => reply(status, { message: "khong co quyen kho" }) }), IE, iePayload);
        assert.deepEqual([result.ok, result.error?.reason, result.error?.code], [false, "network", "IMPORT_EXPORT_READ_FAILED"], `${IE}: HTTP ${status} là lỗi, không phải 0 dòng`);
        assert.match(result.error.message, new RegExp(`mã ${status}`), `${IE}: ${status}`);
      }
      // Danh sách dạng lạ khác {page, size} vẫn là WMS đổi dạng
      for (const drift of [{ page: 1, size: 500, count: 5 }, { page: 1, size: 500, items: [movement] }, { page: "1", size: "500" }, {}, null, []]) {
        result = await ask(load({ fetchImpl: ieFetch(drift, { page: 1, size: 500 }) }), IE, iePayload);
        assert.equal(result.ok, false, `${IE}: danh sách dạng lạ ${JSON.stringify(drift)} vẫn là lỗi`);
        assert.match(result.error.message, /đổi dạng dữ liệu/, `${IE}: ${JSON.stringify(drift)}`);
      }
    }

    // Không nới ở nơi khác: tồn kho / kết quả kiểm kê nhận {page, size} vẫn báo "WMS đổi dạng"
    // (0.12.3 bỏ Import/Export khỏi danh sách này có chủ ý — ca Import/Export ở khối trên)
    for (const [type, payload] of [
      ["GET_SKU_COUNT_INVENTORY_PAGE", { warehouseIds: [1177], companyId: 1002 }],
      ["GET_SKU_COUNT_APPROVED_PAGE", { warehouseIds: [1177], companyId: 1002 }],
    ]) {
      result = await ask(load({ fetchImpl: bodyFetch(EMPTY) }), type, payload);
      assert.equal(result.ok, false, `${type}: {page,size} không được coi là danh sách rỗng`);
      assert.match(result.error.message, /đổi dạng dữ liệu/, type);
    }
  }

  console.log("wms_bridge_reads: thử lại 429/5xx/lỗi mạng, 204, 401/403 và hết phiên cho Group UID, lịch sử Cắt, lịch sử chuyển vị trí, nhập xuất kho, đọc Group UID/ASN theo PO và số phiếu ADJ / IT (GET_WMS_DOC_INFO; chi tiết ADJ 404 / rỗng → po null, lỗi tạm 500 / mất mạng / thân hỏng → detailFailed, 401/403 → lỗi cả lệnh), Transfer Location History (lọc vị trí + SKU, tra mã Group UID), thân {page,size} rỗng (Group UID, chuyển vị trí, lịch sử Cắt / chuyển vị trí, Import/Export đối chiếu lệnh đếm; tồn kho / APPROVED vẫn lỗi) passed");
})().catch(error => { console.error(error); process.exit(1); });
