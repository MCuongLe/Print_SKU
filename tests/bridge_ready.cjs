// window.PrintSkuBridgeReady: hỏi lại tiện ích (PING) trước khi các màn gửi lệnh qua cầu nối extension.
// Chạy hàm thật lấy từ index.html trong sandbox có cầu nối giả lập; không cần trình duyệt.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.resolve(__dirname, "..", "index.html"), "utf8");
const start = html.indexOf("        // Hỏi lại tiện ích trước mỗi lệnh gửi qua cầu nối extension");
const end = html.indexOf("        window.fetch = async (input, init = {}) => {", start);
assert.ok(start >= 0 && end > start, "Không tìm thấy PrintSkuBridgeReady trong index.html");
const source = html.slice(start, end);

// Mọi helper gửi lệnh qua cầu nối phải hỏi lại tiện ích trước.
const definitions = html.match(/(?:const extensionRequest=\(type,payload=\{\},timeout=\d+\)=>|function extensionRequest\(type,payload=\{\},timeout=\d+\)\{return )[^;]{0,60}/g) || [];
assert.equal(definitions.length, 5, `cần 5 helper extensionRequest, thấy ${definitions.length}`);
for (const definition of definitions) assert.match(definition, /window\.PrintSkuBridgeReady\(type\)\.then\(/, `helper chưa hỏi lại tiện ích: ${definition}`);

// Sandbox: cửa sổ giả có postMessage/addEventListener; `bridge` quyết định cầu nối trả lời thế nào.
// Trong vm của Node, `window` bên trong ngữ cảnh là proxy toàn cục (khác đối tượng bên ngoài), nên sự kiện phải mang
// đúng proxy đó làm `source` thì phép so `event.source === window` mới đúng như trên trình duyệt.
const makeWindow = bridge => {
  const listeners = new Set();
  let self;
  const win = {
    location: { origin: "http://localhost:8000" },
    setTimeout, clearTimeout, Math, Date, Error, Promise,
    addEventListener: (type, fn) => { if (type === "message") listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
    postMessage: data => {
      if (data?.source !== "PRINT_SKU_APP") return;
      const reply = bridge(data);
      if (reply) setImmediate(() => listeners.forEach(fn => fn({ source: self, origin: win.location.origin, data: { source: "HASAKI_INSIDE_CONNECTOR", requestId: data.requestId, ...reply } })));
    },
  };
  const context = vm.createContext(win);
  vm.runInContext("var window = globalThis;", context);
  self = vm.runInContext("window", context);
  vm.runInContext(source, context);
  return win;
};
const messageOf = promise => promise.then(() => "OK", error => error.message);

(async () => {
  let mode = "ok";
  const win = makeWindow(request => {
    assert.equal(request.type, "PING");
    if (mode === "ok") return { ok: true, data: { version: "x" } };
    return null; // cầu nối cũ mồ côi: im lặng
  });

  // Chưa từng kết nối + im lặng → "không tìm thấy" (không đoán là vừa cập nhật).
  const fresh = makeWindow(() => null);
  assert.equal(await messageOf(fresh.PrintSkuBridgeReady("GET_PO", 40)), "Không tìm thấy tiện ích kết nối");

  assert.equal(await messageOf(win.PrintSkuBridgeReady("GET_PO", 40)), "OK", "cầu nối trả lời: cho phép gửi lệnh");
  mode = "silent";
  const t = Date.now();
  assert.equal(await messageOf(win.PrintSkuBridgeReady("GET_PO", 40)), "Tiện ích vừa được cập nhật — tải lại trang (F5)", "đã từng kết nối rồi im lặng: báo tải lại trang");
  assert.ok(Date.now() - t < 1000, "báo lỗi theo hạn PING, không chờ hạn của lệnh");
  assert.equal(await messageOf(makeWindow(() => ({ ok: false, error: { code: "EXTENSION_RELOADED" } })).PrintSkuBridgeReady("GET_PO", 40)), "Tiện ích vừa được cập nhật — tải lại trang (F5)", "cầu nối mới báo EXTENSION_RELOADED");

  // PING / PING_WMS là bước kiểm tra kết nối của từng màn: không hỏi lại (kể cả khi cầu nối im lặng).
  assert.equal(await messageOf(makeWindow(() => null).PrintSkuBridgeReady("PING_WMS", 40)), "OK");
  assert.equal(await messageOf(makeWindow(() => null).PrintSkuBridgeReady("PING", 40)), "OK");

  console.log("bridge_ready: 5 helper hỏi lại tiện ích; PING trả lời / im lặng / EXTENSION_RELOADED đều đạt");
})().catch(error => { console.error(error); process.exit(1); });
