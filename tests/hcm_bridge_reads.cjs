// Kiểm tra extension/inside-po-connector/hcm-bridge.js (cầu nối chỉ đọc tới app xây dựng) không cần Chrome hay app thật:
// nạp script vào một vm với localStorage, location, chrome.runtime và fetch giả, rồi gửi message như background làm.
//   node tests/hcm_bridge_reads.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const SOURCE = fs.readFileSync("extension/inside-po-connector/hcm-bridge.js", "utf8");
const TOKEN = "secret-app-token-123";

function load({ token = TOKEN, pathname = "/apps/hasaki-construction-management/", fetchImpl }) {
  const listeners = [];
  const sandbox = {
    console, URLSearchParams,
    location: { pathname, origin: "https://apps-mastige.inshasaki.com" },
    localStorage: { getItem: key => (key === "hcm_auth_token" && token ? token : null) },
    chrome: { runtime: { id: "ext", onMessage: { addListener: listener => listeners.push(listener) } } },
    fetch: fetchImpl,
    setTimeout: callback => { callback(); return 0; }, // bỏ thời gian chờ giữa các lần thử lại
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: "hcm-bridge.js" });
  assert.equal(listeners.length, 1, "hcm-bridge phải đăng ký đúng một listener");
  // Nạp lần hai trong cùng tab (tiêm lại sau khi Reload) không được đăng ký thêm listener.
  vm.runInContext(SOURCE, sandbox, { filename: "hcm-bridge.js" });
  assert.equal(listeners.length, 1, "nạp lần hai không được nhân đôi listener");
  return listeners[0];
}

const ask = (listener, payload, sender = { id: "ext" }, type = "GET_HCM_DATA") => new Promise(resolve => {
  const handled = listener({ type, payload }, sender, resolve);
  if (handled === false) resolve("IGNORED");
});
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

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

const STOCK = [
  { sku: "900000077", name: "Xi măng", unit: "bao", qtyImported: 340, qtyExported: 251, qtyAdjust: 0, inStock: 89 },
  { sku: "900000076", name: "Cừ tràm", unit: "cây", qtyImported: 192, qtyExported: 192, qtyAdjust: 0, inStock: 0 },
  { sku: "900000070", name: "Cuộn", unit: "cuộn", qtyImported: 12, qtyExported: 0, qtyAdjust: 0, inStock: 12 },
];

(async () => {
  // Đọc đúng đường dẫn con của app, kèm Bearer, cùng nguồn gốc, chỉ GET
  let fetchImpl = sequence(reply(200, { ok: true, count: 3, totalCount: 3, generatedAt: "2026-10-15T07:17:37.428Z", rows: STOCK }));
  let result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.data.resource, result.data.total, result.data.rows.length, result.data.generatedAt], ["stock", 3, 3, "2026-10-15T07:17:37.428Z"]);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, "/apps/hasaki-construction-management/api/stock?limit=1000&offset=0");
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(fetchImpl.calls[0].init.credentials, "same-origin", "cookie Cloudflare Access đi kèm yêu cầu cùng nguồn");
  assert.equal(fetchImpl.calls[0].init.method, undefined, "chỉ GET (không đặt method)");
  assert.equal(JSON.stringify(result).includes(TOKEN), false, "token không bao giờ được trả về trang Print SKU");

  // Dòng nhập WMS đã nạp vào app: đúng đường dẫn con, cùng cách đọc
  fetchImpl = sequence(reply(200, { ok: true, totalCount: 1, rows: [{ id: "f#1", sku: "900000077", quantity: 340, type: "Imp" }] }));
  result = await ask(load({ fetchImpl }), { resource: "wmsImports" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetchImpl.calls[0].url, "/apps/hasaki-construction-management/api/wms-imports?limit=1000&offset=0");
  assert.equal(result.data.rows[0].sku, "900000077");

  // Chạy cả khi địa chỉ app không có dấu "/" cuối
  fetchImpl = sequence(reply(200, { ok: true, totalCount: 0, rows: [] }));
  result = await ask(load({ fetchImpl, pathname: "/apps/hasaki-construction-management" }), { resource: "stock" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetchImpl.calls[0].url, "/apps/hasaki-construction-management/api/stock?limit=1000&offset=0");
  assert.deepEqual([result.data.rows.length, result.data.total], [0, 0]);

  // Nhiều trang: đọc tiếp theo offset cho tới khi đủ tổng
  const many = Array.from({ length: 1500 }, (_, i) => ({ sku: `S${i}` }));
  fetchImpl = sequence(reply(200, { ok: true, totalCount: 1500, rows: many.slice(0, 1000) }), reply(200, { ok: true, totalCount: 1500, rows: many.slice(1000) }));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.rows.length, 1500);
  assert.deepEqual(fetchImpl.calls.map(call => call.url.split("?")[1]), ["limit=1000&offset=0", "limit=1000&offset=1000"]);

  // Dữ liệu đổi trong lúc đọc (tổng giảm làm thiếu dòng) thì báo lỗi, không trả thiếu
  fetchImpl = sequence(reply(200, { ok: true, totalCount: 1500, rows: many.slice(0, 1000) }), reply(200, { ok: true, totalCount: 1500, rows: [] }));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /thay đổi/);

  // Chưa đăng nhập app: báo ngay, không gọi fetch
  fetchImpl = sequence(reply(200, { ok: true, totalCount: 0, rows: [] }));
  result = await ask(load({ token: "", fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /đăng nhập/);
  assert.equal(result.error.code, "HCM_READ_FAILED");
  assert.equal(fetchImpl.calls.length, 0);

  // 401 / 403: báo đúng và không thử lại
  fetchImpl = sequence(reply(401, { ok: false, error: "unauthorized" }));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /hết hạn/);
  assert.equal(fetchImpl.calls.length, 1, "401 không được thử lại");
  fetchImpl = sequence(reply(403, { ok: false, error: "admin_scope_required" }));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.match(result.error.message, /quyền/);
  assert.equal(fetchImpl.calls.length, 1);

  // 503 rồi 200; mất mạng một lần rồi đọc được; mất mạng kéo dài thì báo ngắt kết nối sau 3 lần
  fetchImpl = sequence(reply(503, {}), reply(200, { ok: true, totalCount: 3, rows: STOCK }));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(fetchImpl.calls.length, 2);
  fetchImpl = sequence(new TypeError("Failed to fetch"), reply(200, { ok: true, totalCount: 3, rows: STOCK }));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, true, JSON.stringify(result));
  fetchImpl = sequence(new TypeError("Failed to fetch"));
  result = await ask(load({ fetchImpl }), { resource: "stock" });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /ngắt kết nối/);
  assert.equal(fetchImpl.calls.length, 3);

  // Chỉ đọc được nguồn trong danh sách cho phép: không cho trang tự chọn đường dẫn API
  for (const resource of ["", "state", "auth/users", "../api/state", "constructor", "__proto__", "toString"]) {
    fetchImpl = sequence(reply(200, { ok: true, totalCount: 0, rows: [] }));
    result = await ask(load({ fetchImpl }), { resource });
    assert.equal(result.ok, false, `resource ${JSON.stringify(resource)}`);
    assert.match(result.error.message, /không hợp lệ/);
    assert.equal(fetchImpl.calls.length, 0, `resource ${JSON.stringify(resource)}: không được gọi API`);
  }

  // Chỉ nhận message của chính extension và đúng loại
  fetchImpl = sequence(reply(200, { ok: true, totalCount: 0, rows: [] }));
  const listener = load({ fetchImpl });
  assert.equal(await ask(listener, { resource: "stock" }, { id: "kẻ-lạ" }), "IGNORED");
  assert.equal(await ask(listener, { resource: "stock" }, { id: "ext" }, "GET_PO"), "IGNORED");
  assert.equal(fetchImpl.calls.length, 0);

  console.log("hcm_bridge_reads: đường dẫn con, Bearer + cookie, nhiều trang, thiếu dòng, 401/403, thử lại, danh sách nguồn và không lộ token passed");
})().catch(error => { console.error(error); process.exit(1); });
