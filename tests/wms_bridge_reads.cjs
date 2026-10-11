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
  group_uid_code: "1028261006000050", batch_code: "B", roll_code: "5", warehouse_name: "WH", location_description: "A-01",
  uid_quantity: 3, status_name: "Available", updated_at_tz: "2026-10-10T10:00:00+07:00",
  products: [{ sku: "422000001", quantity: 3, product_name: "Vai thu nghiem" }],
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
  fetchImpl = sequence(reply(403, {}));
  result = await ask(load({ fetchImpl }), "GET_GROUP_UID_PAGE");
  assert.equal(result.ok, false);
  assert.match(result.error.message, /Group UID/);
  assert.equal(fetchImpl.calls.length, 1);

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

  console.log("wms_bridge_reads: thử lại 429/5xx/lỗi mạng, 204, 401/403 và hết phiên cho Group UID, lịch sử Cắt, lịch sử chuyển vị trí passed");
})().catch(error => { console.error(error); process.exit(1); });
