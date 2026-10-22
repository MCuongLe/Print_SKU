const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..", "extension", "inside-po-connector");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.10.6");
// Đồng bộ tự động (0.10.0): alarm + storage cho phiên Admin riêng, gọi Edge Supabase, trang Tùy chọn.
assert.ok(manifest.permissions.includes("alarms"));
assert.ok(manifest.permissions.includes("storage"));
assert.ok(manifest.host_permissions.includes("https://ikzhitdqkoatlmkrxuuh.supabase.co/*"));
assert.equal(manifest.options_page, "options.html");
assert.equal(manifest.minimum_chrome_version, "120", "alarm keepalive 30 giây cần Chrome 120+");
assert.match(background, /AUTO_STATUS/);
assert.match(background, /importScripts\("supabase-config.js", "supabase-session.js", "group-uid-snapshot-core.js", "auto-sync.js"\)/);
for (const file of ["supabase-config.js", "supabase-session.js", "group-uid-snapshot-core.js", "auto-sync.js"]) assert.ok(fs.existsSync(path.join(extensionDir, file)), file);
const wmsBridge = fs.readFileSync(path.join(extensionDir, "wms-bridge.js"), "utf8");
assert.match(wmsBridge, /stock-locations\/bins\/count\/v3/);
assert.match(wmsBridge, /ignore_zero_total/);
assert.ok(manifest.content_scripts.some(entry => entry.js.includes("inventory-audit-core.js")));
for (const type of ["GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE"]) assert.match(background, new RegExp(type));
// Kiểm soát công trình: đọc nhập xuất kho qua WMS và tồn app xây dựng qua tab app đã đăng nhập (cùng nguồn gốc, chỉ đọc).
for (const type of ["GET_STOCK_IMPORT_EXPORT_PAGE", "GET_HCM_DATA", "PING_HCM"]) assert.match(background, new RegExp(type));
assert.ok(manifest.host_permissions.includes("https://apps-mastige.inshasaki.com/*"));
const hcmEntry = manifest.content_scripts.find(entry => entry.js.includes("hcm-bridge.js"));
assert.deepEqual(hcmEntry?.matches, ["https://apps-mastige.inshasaki.com/apps/hasaki-construction-management*"], "cầu nối app xây dựng chỉ chạy trong đúng app đó");
const hcmPattern = background.match(/^const HCM_URL_PATTERN = .*;$/m)?.[0];
assert.ok(hcmPattern, "Không tìm thấy HCM_URL_PATTERN");
const hcmBox = { result: null };
vm.runInNewContext(`${hcmPattern}
result = HCM_URL_PATTERN;`, hcmBox);
assert.equal(hcmBox.result.test("https://apps-mastige.inshasaki.com/apps/hasaki-construction-management/#/admin/stock/stock"), true);
assert.equal(hcmBox.result.test("https://apps-mastige.inshasaki.com/apps/hasaki-construction-management#/admin"), true);
assert.equal(hcmBox.result.test("https://apps-mastige.inshasaki.com/apps/hasaki-construction-management-evil/"), false);
assert.equal(hcmBox.result.test("https://evil.example/apps/hasaki-construction-management/"), false);
assert.equal(hcmBox.result.test("https://hasaki-zt.cloudflareaccess.com/cdn-cgi/access/login/apps-mastige.inshasaki.com?redirect_url=%2Fapps%2Fhasaki-construction-management%2F"), false, "trang đăng nhập Cloudflare không phải tab app");
const appBridgeSource = fs.readFileSync(path.join(extensionDir, "app-bridge.js"), "utf8");
for (const type of ["GET_STOCK_IMPORT_EXPORT_PAGE", "GET_HCM_DATA", "PING_HCM"]) assert.match(appBridgeSource, new RegExp(type));

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

  // background.js thật trong vm: lệnh AUTO_* chỉ nhận từ trang của Extension; trang web / content script không gọi được.
  const runBackground = ({ withAccessLevel = true, initial = {} } = {}) => {
    let onMessage, onAlarm, onInstalled, alarmsCreated = [];
    const stored = { ...initial }, order = [];
    const chromeStub = {
      runtime: {
        id: "ext-id", getURL: p => `chrome-extension://ext-id/${p}`, getManifest: () => manifest,
        onMessage: { addListener: fn => { onMessage = fn; } }, onInstalled: { addListener: fn => { onInstalled = fn; } }, onStartup: { addListener: () => {} },
      },
      alarms: { get: async () => null, create: (name, info) => { alarmsCreated.push([name, info]); }, clear: async () => true, onAlarm: { addListener: fn => { onAlarm = fn; } } },
      tabs: { query: async () => [] },
      storage: { local: { get: async key => { order.push("get"); return { [key]: stored[key] }; }, set: async value => Object.assign(stored, value), remove: async key => { delete stored[key]; } } },
    };
    if (withAccessLevel) chromeStub.storage.local.setAccessLevel = async info => { order.push(`access:${info.accessLevel}`); };
    const context = vm.createContext({ chrome: chromeStub, console, setTimeout, clearTimeout, URL, fetch: async () => { throw new Error("không gọi mạng trong test"); } });
    context.self = context;
    context.importScripts = (...files) => { order.push("importScripts"); files.forEach(file => vm.runInContext(fs.readFileSync(path.join(extensionDir, file), "utf8"), context, { filename: file })); };
    vm.runInContext(background, context, { filename: "background.js" });
    // Đối tượng tạo trong vm khác realm: chuyển qua JSON để deepEqual so được.
    const send = (message, sender) => new Promise(resolve => onMessage(message, sender, value => resolve(JSON.parse(JSON.stringify(value)))));
    return { send, stored, alarmsCreated, order, alarm: name => onAlarm({ name }), installed: () => onInstalled() };
  };
  const bg = runBackground();
  await settle();
  // Token Admin ở chrome.storage.local: khoá cho riêng trang Extension trước mọi thao tác storage.
  assert.deepEqual(bg.order.slice(0, 2), ["access:TRUSTED_CONTEXTS", "importScripts"]);
  assert.doesNotThrow(() => bg.alarm("auto-keepalive"), "keepalive khi không có lượt chạy không lỗi");
  const oldChrome = runBackground({ withAccessLevel: false });
  await settle();
  assert.equal(oldChrome.order[0], "importScripts", "Chrome không có setAccessLevel vẫn nạp được");
  assert.equal(JSON.stringify(bg.alarmsCreated), JSON.stringify([["auto-sync", { periodInMinutes: 30 }]]), "SW thức dậy mà chưa có alarm thì tạo lại");
  // Nhịp Admin đã xác minh (auto.interval) dùng lại khi Chrome làm mất alarm / cài lại; giá trị ngoài 15–180 bị kẹp.
  const slow = runBackground({ initial: { "auto.interval": 180 } });
  await settle();
  slow.installed();
  await settle();
  assert.equal(JSON.stringify(slow.alarmsCreated), JSON.stringify([["auto-sync", { periodInMinutes: 180 }], ["auto-sync", { periodInMinutes: 180 }]]), "tạo lại alarm theo nhịp đã lưu, không về 30 phút");
  const odd = runBackground({ initial: { "auto.interval": 5 } });
  await settle();
  assert.equal(JSON.stringify(odd.alarmsCreated), JSON.stringify([["auto-sync", { periodInMinutes: 15 }]]));
  const optionsSender = { id: "ext-id", url: "chrome-extension://ext-id/options.html", tab: { id: 9, url: "chrome-extension://ext-id/options.html" } };
  assert.deepEqual(await bg.send({ type: "AUTO_SET_DEVICE", device: "  may-test-01 " }, optionsSender), { ok: true });
  assert.equal(bg.stored["auto.device"], "may-test-01");
  const status = await bg.send({ type: "AUTO_STATUS" }, { id: "ext-id", url: "chrome-extension://ext-id/options.html" });
  assert.equal(status.ok, true);
  assert.deepEqual([status.signedIn, status.device, status.enabled, status.tabs], [false, "may-test-01", true, { wms: false, inside: false }]);
  assert.deepEqual(await bg.send({ type: "GET_PO" }, optionsSender), { ok: false, error: "Yêu cầu không hợp lệ" }, "trang Tùy chọn chỉ dùng lệnh AUTO_*");
  const webTab = { id: "ext-id", url: "http://localhost:8000/", tab: { id: 3, url: "http://localhost:8000/" } };
  assert.equal((await bg.send({ type: "AUTO_SET_DEVICE", device: "x" }, webTab)).error.code, "INVALID_REQUEST", "tab web không gọi được lệnh AUTO_*");
  const evilTab = { id: "ext-id", url: "https://evil.example/", tab: { id: 4, url: "https://evil.example/" } };
  assert.equal((await bg.send({ type: "AUTO_SIGN_OUT" }, evilTab)).error.code, "FORBIDDEN_ORIGIN");
  assert.equal(bg.stored["auto.device"], "may-test-01");

  // GET_PO (0.10.1): inside-bridge.js thật trong vm với DOM giả theo cột danh sách PO đã đo trên Inside 17/10/2026:
  // # | Code | Vendor | Stock | LastModified | Delivery | Due Date | Status. Rcvd date của biên bản = LastModified (cells[4]).
  const insideBridge = fs.readFileSync(path.join(extensionDir, "inside-bridge.js"), "utf8");
  const runGetPo = ({ listDelivery = "27-02-08|13:46", detailDelivery = "2027-02-08", lastModified = "26-10-15|14:35" } = {}) => {
    let listener;
    const node = (textContent, extra = {}) => ({ textContent, querySelector: () => null, querySelectorAll: () => [], ...extra });
    const editLink = { textContent: "PO-TEST-001", href: "https://inside.example/purchase/order/77/edit" };
    const listRow = {
      cells: ["1", "PO-TEST-001", "CÔNG TY MẪU - Ms Test", "WH - TEST", lastModified, listDelivery, "2026-11-05", "approved"].map(value => node(value)),
      querySelectorAll: () => [editLink],
    };
    const skuLink = { href: "https://inside.example/product/detail-sku?sku=SKU-TEST-1" };
    const itemRow = { cells: [node("1"), node("", { querySelector: sel => sel.includes("detail-sku") ? skuLink : null }), node(""), node("Vải mẫu tổng hợp"), node(""), node(""), node(""), node(""), node("", { querySelector: () => ({ getAttribute: () => "12" }) })] };
    const docs = {
      list: { title: "PO", querySelector: () => null, querySelectorAll: sel => sel === "table tbody tr" ? [listRow] : [] },
      detail: {
        title: "PO",
        querySelector: sel => sel === 'input[name="delivery_date"]' ? (detailDelivery ? { value: detailDelivery } : null) : sel === "#selected_stock_id option:checked" ? node("WH - TEST") : null,
        querySelectorAll: sel => sel === "#po_detail_table_tbody tr" ? [itemRow] : [],
      },
    };
    const win = {};
    const context = {
      window: win, URL, location: { origin: "https://inside.example" },
      chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
      fetch: async url => ({ ok: true, text: async () => String(url).includes("/edit") ? "detail" : "list" }),
      DOMParser: class { parseFromString(html) { return docs[html]; } },
    };
    context.globalThis = context;
    vm.runInNewContext(insideBridge, context);
    return new Promise(resolve => listener({ type: "GET_PO", payload: { poCode: "PO-TEST-001" } }, { id: "ext-id" }, value => resolve(JSON.parse(JSON.stringify(value)))));
  };
  const po = await runGetPo();
  assert.equal(po.ok, true, JSON.stringify(po));
  assert.equal(po.data.lastModified, "2026-10-15", "LastModified \"26-10-15|14:35\" → ngày ISO, bỏ phần giờ");
  assert.equal(po.data.deliveryDate, "2027-02-08", "deliveryDate giữ nguyên cho bên dùng cũ");
  assert.deepEqual([po.data.poId, po.data.vendor, po.data.status, po.data.items.length], ["77", "CÔNG TY MẪU - Ms Test", "approved", 1]);
  assert.equal((await runGetPo({ lastModified: "2026-10-15 14:35:00" })).data.lastModified, "2026-10-15", "dạng ISO có giờ cũng cắt về ngày");
  assert.equal((await runGetPo({ lastModified: "" })).data.lastModified, "", "ô trống → chuỗi rỗng để web rơi về deliveryDate");
  assert.equal((await runGetPo({ detailDelivery: "" })).data.deliveryDate, "2027-02-08", "thiếu ô delivery_date ở chi tiết → dùng cột Delivery của danh sách");

  console.log("inside_po_connector: manifest, allowed origins and app bridge replies passed");
})().catch(error => { console.error(error); process.exit(1); });
