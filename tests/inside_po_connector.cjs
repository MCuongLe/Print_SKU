const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..", "extension", "inside-po-connector");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.7.0");
const wmsBridge = fs.readFileSync(path.join(extensionDir, "wms-bridge.js"), "utf8");
assert.match(wmsBridge, /stock-locations\/bins\/count\/v3/);
assert.match(wmsBridge, /ignore_zero_total/);
assert.ok(manifest.content_scripts.some(entry => entry.js.includes("inventory-audit-core.js")));
for (const type of ["GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE"]) assert.match(background, new RegExp(type));

const appMatches = manifest.content_scripts.find(entry => entry.js.includes("app-bridge.js"))?.matches || [];
assert.ok(appMatches.includes("http://localhost/*"));
assert.ok(appMatches.includes("http://127.0.0.1/*"));
assert.ok(appMatches.includes("https://mcuongle.github.io/Print_SKU/*"));

const patternLine = background.match(/^const APP_URL_PATTERN = .*;$/m)?.[0];
assert.ok(patternLine, "Không tìm thấy APP_URL_PATTERN");
const sandbox = { result: null };
vm.runInNewContext(`${patternLine}\nresult = APP_URL_PATTERN;`, sandbox);

assert.equal(sandbox.result.test("http://localhost:8000/#inspection"), true);
assert.equal(sandbox.result.test("http://127.0.0.1:8000/#inspection"), true);
assert.equal(sandbox.result.test("https://mcuongle.github.io/Print_SKU/#inspection"), true);
assert.equal(sandbox.result.test("https://evil.example/Print_SKU/#inspection"), false);
assert.equal(sandbox.result.test("https://mcuongle.github.io/Other_App/#inspection"), false);

// Cầu nối trong tab app phải luôn trả lời: khi extension vừa Reload, sendMessage ném lỗi ngay (cầu nối "mồ côi")
// và trang chỉ còn cách chờ hết hạn nếu cầu nối im lặng.
const appBridge = fs.readFileSync(path.join(extensionDir, "app-bridge.js"), "utf8");
const runBridge = chromeStub => {
  const posted = [];
  let handler;
  const win = { addEventListener: (type, fn) => { if (type === "message") handler = fn; }, postMessage: (data, origin) => posted.push({ data, origin }) };
  vm.runInNewContext(appBridge, { window: win, chrome: chromeStub, location: { hostname: "localhost", pathname: "/", origin: "http://localhost:8000" } });
  return { posted, send: data => handler({ source: win, origin: "http://localhost:8000", data }) };
};
const request = { source: "PRINT_SKU_APP", type: "GET_PO", requestId: "r1", payload: { poCode: "123" } };
const settle = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const ok = runBridge({ runtime: { sendMessage: async () => ({ ok: true, data: { version: "x" } }) } });
  ok.send(request);
  await settle();
  assert.deepEqual(ok.posted.map(item => [item.data.requestId, item.data.ok, item.data.data]), [["r1", true, { version: "x" }]]);

  const orphaned = runBridge({ runtime: { sendMessage: () => { throw new Error("Extension context invalidated."); } } });
  orphaned.send(request);
  await settle();
  assert.deepEqual(orphaned.posted.map(item => [item.data.requestId, item.data.ok, item.data.error.code]), [["r1", false, "EXTENSION_RELOADED"]]);

  const rejected = runBridge({ runtime: { sendMessage: () => Promise.reject(new Error("no receiver")) } });
  rejected.send(request);
  await settle();
  assert.deepEqual(rejected.posted.map(item => [item.data.ok, item.data.error.code]), [[false, "EXTENSION_UNAVAILABLE"]]);

  const unknown = runBridge({ runtime: { sendMessage: async () => ({ ok: true }) } });
  unknown.send({ ...request, type: "SOMETHING_ELSE" });
  await settle();
  assert.equal(unknown.posted.length, 0, "yêu cầu lạ không được chuyển tiếp");

  console.log("inside_po_connector: manifest, allowed origins and app bridge replies passed");
})().catch(error => { console.error(error); process.exit(1); });
