const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..", "extension", "inside-po-connector");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.12.1");
// Đồng bộ tự động (0.10.0): alarm + storage cho phiên Admin riêng, gọi Edge Supabase, trang Tùy chọn.
assert.ok(manifest.permissions.includes("alarms"));
assert.ok(manifest.permissions.includes("storage"));
assert.ok(manifest.host_permissions.includes("https://ikzhitdqkoatlmkrxuuh.supabase.co/*"));
assert.equal(manifest.options_page, "options.html");
// 0.10.7: icon Extension mang dấu "!" khi đồng bộ tự động ngừng; không có popup để bấm icon mở trang Tùy chọn (action.onClicked).
assert.equal(manifest.action?.default_popup, undefined);
assert.match(background, /chrome\.action\?\.onClicked\?\.addListener/);
// 0.10.7 (G4): bỏ tab Chrome đã cho ngủ, ưu tiên tab tải xong rồi tab dùng gần nhất.
{
  const source = background.match(/^function pickTab[\s\S]*?\r?\n}\r?\n/m)?.[0];
  assert.ok(source, "Không tìm thấy pickTab");
  const box = { result: null };
  vm.runInNewContext(`${source}\nresult = pickTab;`, box);
  const tabs = [
    { id: 1, url: "https://wms.inshasaki.com/a", lastAccessed: 30, discarded: true, status: "unloaded" },
    { id: 2, url: "https://wms.inshasaki.com/b", lastAccessed: 20, status: "loading" },
    { id: 3, url: "https://wms.inshasaki.com/c", lastAccessed: 10, status: "complete" },
  ];
  assert.equal(box.result(tabs, /^https:\/\/wms\.inshasaki\.com\//).id, 3);
  assert.equal(box.result(tabs.slice(0, 2), /^https:\/\/wms\.inshasaki\.com\//).id, 2, "chỉ còn tab đang tải thì vẫn dùng");
  assert.equal(box.result(tabs.slice(0, 1), /^https:\/\/wms\.inshasaki\.com\//), null, "chỉ có tab đang ngủ → coi như không có tab");
}
assert.equal(manifest.minimum_chrome_version, "120", "alarm keepalive 30 giây cần Chrome 120+");
assert.match(background, /AUTO_STATUS/);
// 26/10/2026: cut-source-core.js (ghép nguồn phiếu ADJ / IT cho Cut) nạp trước cut-adj-core.js, lõi Đối chiếu ADJ gọi nó sau khi nạp Cut.
assert.match(background, /importScripts\("supabase-config.js", "supabase-session.js", "group-uid-snapshot-core.js", "cut-source-core.js", "cut-adj-core.js", "storage-risk-core.js", "auto-sync.js"\)/);
for (const file of ["supabase-config.js", "supabase-session.js", "group-uid-snapshot-core.js", "cut-source-core.js", "cut-adj-core.js", "storage-risk-core.js", "auto-sync.js"]) assert.ok(fs.existsSync(path.join(extensionDir, file)), file);
const wmsBridge = fs.readFileSync(path.join(extensionDir, "wms-bridge.js"), "utf8");
assert.match(wmsBridge, /stock-locations\/bins\/count\/v3/);
assert.match(wmsBridge, /ignore_zero_total/);
assert.ok(manifest.content_scripts.some(entry => entry.js.includes("inventory-audit-core.js")));
for (const type of ["GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE"]) assert.match(background, new RegExp(type));
// Kiểm soát công trình: đọc nhập xuất kho qua WMS và tồn app xây dựng qua tab app đã đăng nhập (cùng nguồn gốc, chỉ đọc).
for (const type of ["GET_STOCK_IMPORT_EXPORT_PAGE", "GET_HCM_DATA", "PING_HCM"]) assert.match(background, new RegExp(type));
// Số phiếu ADJ / IT cho nguồn Cut (GET_WMS_DOC_INFO): cùng có ở WMS_READ_TYPES (background), allow-list app-bridge và bảng readers của wms-bridge.
assert.match(background.match(/^const WMS_READ_TYPES = \[.*\];$/m)?.[0] || "", /"GET_WMS_DOC_INFO"/);
assert.ok(manifest.host_permissions.includes("https://apps-mastige.inshasaki.com/*"));
const hcmEntry = manifest.content_scripts.find(entry => entry.js.includes("hcm-bridge.js"));
assert.deepEqual(hcmEntry?.matches, ["https://apps-mastige.inshasaki.com/apps/hasaki-construction-management*"], "cầu nối app xây dựng chỉ chạy trong đúng app đó");
// 0.11.0: Inside Garment (garment.inshasaki.com) cùng phần mềm Inside — cầu nối đọc PO chạy ở đó, bộ đọc SKU thì không.
assert.ok(manifest.host_permissions.includes("https://garment.inshasaki.com/*"));
const mastigeInsideEntry = manifest.content_scripts.find(entry => entry.matches.includes("https://inside.mastige.vn/*"));
assert.deepEqual(mastigeInsideEntry?.matches, ["https://inside.mastige.vn/*"], "bộ đọc SKU chỉ chạy ở Inside Mastige");
assert.deepEqual(mastigeInsideEntry?.js, ["sku-sync-core.js", "inside-bridge.js"]);
const garmentInsideEntry = manifest.content_scripts.find(entry => entry.matches.includes("https://garment.inshasaki.com/*"));
assert.deepEqual(garmentInsideEntry?.matches, ["https://garment.inshasaki.com/*"]);
assert.deepEqual(garmentInsideEntry?.js, ["inside-bridge.js"], "Garment không nạp bộ đọc SKU");
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
for (const type of ["GET_STOCK_IMPORT_EXPORT_PAGE", "GET_HCM_DATA", "PING_HCM", "GET_WMS_DOC_INFO"]) assert.match(appBridgeSource, new RegExp(`"${type}"`));
assert.match(wmsBridge, /GET_WMS_DOC_INFO: readDocInfo,/);

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
  const globToRegExp = pattern => new RegExp("^" + pattern.split("*").map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  const runBackground = ({ withAccessLevel = true, initial = {}, tabs = [], failFirst = false } = {}) => {
    let onMessage, onAlarm, onInstalled, alarmsCreated = [];
    const stored = { ...initial }, order = [], sent = [], injected = [], attempted = new Set();
    const chromeStub = {
      runtime: {
        id: "ext-id", getURL: p => `chrome-extension://ext-id/${p}`, getManifest: () => manifest,
        onMessage: { addListener: fn => { onMessage = fn; } }, onInstalled: { addListener: fn => { onInstalled = fn; } }, onStartup: { addListener: () => {} },
      },
      alarms: { get: async () => null, create: (name, info) => { alarmsCreated.push([name, info]); }, clear: async () => true, onAlarm: { addListener: fn => { onAlarm = fn; } } },
      tabs: {
        query: async ({ url }) => tabs.filter(tab => globToRegExp(String(url)).test(tab.url)),
        // failFirst: lần gửi đầu tới mỗi tab lỗi như tab mở trước khi Reload Extension (chưa có bridge) → background bơm lại bằng executeScript.
        sendMessage: async (id, message) => {
          if (failFirst && !attempted.has(id)) { attempted.add(id); throw new Error("Could not establish connection. Receiving end does not exist."); }
          sent.push({ id, message: JSON.parse(JSON.stringify(message)) });
          return { ok: true, data: { echoedFromTab: id } };
        },
      },
      scripting: { executeScript: async ({ target, files }) => { injected.push({ tabId: target.tabId, files: [...files] }); } },
      storage: { local: { get: async key => { order.push("get"); return { [key]: stored[key] }; }, set: async value => Object.assign(stored, value), remove: async key => { delete stored[key]; } } },
    };
    if (withAccessLevel) chromeStub.storage.local.setAccessLevel = async info => { order.push(`access:${info.accessLevel}`); };
    const context = vm.createContext({ chrome: chromeStub, console, setTimeout, clearTimeout, URL, fetch: async () => { throw new Error("không gọi mạng trong test"); } });
    context.self = context;
    context.importScripts = (...files) => { order.push("importScripts"); files.forEach(file => vm.runInContext(fs.readFileSync(path.join(extensionDir, file), "utf8"), context, { filename: file })); };
    vm.runInContext(background, context, { filename: "background.js" });
    // Đối tượng tạo trong vm khác realm: chuyển qua JSON để deepEqual so được.
    const send = (message, sender) => new Promise(resolve => onMessage(message, sender, value => resolve(JSON.parse(JSON.stringify(value)))));
    return { send, stored, sent, injected, context, alarmsCreated, order, alarm: name => onAlarm({ name }), installed: () => onInstalled() };
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

  // 0.11.0: GET_PO chọn tab theo site (mastige | garment, mặc định mastige); đồng bộ SKU luôn đọc tab Inside Mastige, không bao giờ tab Garment.
  {
    const mastigeTab = { id: 11, url: "https://inside.mastige.vn/purchase/order", status: "complete" };
    const garmentTab = { id: 12, url: "https://garment.inshasaki.com/purchase/order", status: "complete" };
    const web = { id: "ext-id", url: "http://localhost:8000/#inspection", tab: { id: 3, url: "http://localhost:8000/#inspection" } };
    const run = async (tabs, message, options = {}) => { const target = runBackground({ tabs, ...options }); await settle(); const reply = await target.send(message, web); return { reply, sent: target.sent, injected: target.injected }; };
    const po = (payload = {}) => ({ type: "GET_PO", payload: { poCode: "100000001", ...payload } });

    const garment = await run([mastigeTab, garmentTab], po({ site: "garment" }));
    assert.equal(garment.reply.ok, true, JSON.stringify(garment.reply));
    assert.deepEqual(garment.sent, [{ id: 12, message: { type: "GET_PO", payload: { poCode: "100000001", site: "garment" } } }], "site garment → tab Garment, bridge nhận kèm site");
    const mastige = await run([mastigeTab, garmentTab], po());
    assert.deepEqual(mastige.sent, [{ id: 11, message: { type: "GET_PO", payload: { poCode: "100000001", site: "mastige" } } }], "không có site (web cũ) → Inside Mastige như trước");
    const noGarmentTab = await run([mastigeTab], po({ site: "garment" }));
    assert.deepEqual([noGarmentTab.reply.ok, noGarmentTab.reply.error.code, noGarmentTab.sent.length], [false, "INSIDE_TAB_MISSING", 0], "chỉ có tab Mastige: không đọc nhầm PO Mastige cho yêu cầu Garment");
    assert.match(noGarmentTab.reply.error.message, /Inside Garment/);
    const noMastigeTab = await run([garmentTab], po());
    assert.deepEqual([noMastigeTab.reply.error.code, noMastigeTab.sent.length], ["INSIDE_TAB_MISSING", 0], "chỉ có tab Garment: yêu cầu Mastige không rơi sang Garment");
    assert.match(noMastigeTab.reply.error.message, /Inside Mastige/);
    const asleep = await run([{ ...garmentTab, discarded: true }], po({ site: "garment" }));
    assert.equal(asleep.reply.error.code, "INSIDE_TAB_MISSING", "tab Garment đang ngủ bị bỏ như các tab khác");
    for (const site of ["evil", "GARMENT", "", null, 7, ["garment"]]) {
      const bad = await run([mastigeTab, garmentTab], po({ site }));
      assert.deepEqual([bad.reply.ok, bad.reply.error.code, bad.sent.length], [false, "INVALID_SITE", 0], `site ${JSON.stringify(site)} không hợp lệ`);
    }

    const sync = await run([mastigeTab, garmentTab], { type: "GET_SKU_SYNC_DATA", payload: { full: true, site: "garment" } });
    assert.deepEqual(sync.sent.map(item => item.id), [11], "đồng bộ SKU luôn đọc tab Mastige, kể cả khi payload xin site garment");
    const syncOnlyGarment = await run([garmentTab], { type: "GET_SKU_SYNC_DATA", payload: { full: true } });
    assert.deepEqual([syncOnlyGarment.reply.error.code, syncOnlyGarment.sent.length], ["INSIDE_TAB_MISSING", 0], "chỉ có tab Garment: không đọc SKU từ đó");
    // Bơm lại cầu nối (tab mở trước khi Reload): Garment chỉ nạp inside-bridge.js, bộ đọc SKU chỉ vào tab Mastige.
    const reinjectGarment = await run([mastigeTab, garmentTab], po({ site: "garment" }), { failFirst: true });
    assert.equal(reinjectGarment.reply.ok, true, JSON.stringify(reinjectGarment.reply));
    assert.deepEqual(reinjectGarment.injected, [{ tabId: 12, files: ["inside-bridge.js"] }], "bơm lại vào tab Garment không kèm sku-sync-core.js");
    const reinjectMastige = await run([mastigeTab, garmentTab], po(), { failFirst: true });
    assert.deepEqual(reinjectMastige.injected, [{ tabId: 11, files: ["sku-sync-core.js", "inside-bridge.js"] }], "tab Mastige giữ danh sách cũ");
    const reinjectSync = await run([mastigeTab, garmentTab], { type: "GET_SKU_SYNC_DATA", payload: { full: true, site: "garment" } }, { failFirst: true });
    assert.deepEqual(reinjectSync.injected.map(item => item.tabId), [11], "đồng bộ SKU chỉ bơm vào tab Mastige");
    // Payload đồng bộ SKU chỉ giữ full / cutoff (bridge chỉ đọc hai khoá này); site và khoá lạ bị bỏ.
    assert.deepEqual(sync.sent.map(item => item.message), [{ type: "GET_SKU_SYNC_DATA", payload: { full: true } }], "full + site garment → chỉ { full: true }");
    const syncCutoff = await run([mastigeTab], { type: "GET_SKU_SYNC_DATA", payload: { cutoff: "2026-10-25T00:00:00.000Z", site: "garment", extra: 1 } });
    assert.deepEqual(syncCutoff.sent.map(item => item.message.payload), [{ cutoff: "2026-10-25T00:00:00.000Z" }]);
    const syncEmpty = await run([mastigeTab], { type: "GET_SKU_SYNC_DATA" });
    assert.deepEqual(syncEmpty.sent.map(item => item.message.payload), [{}], "không payload → {}");
    // Đồng bộ tự động gọi findInsideTab() không đối số = Inside Mastige, không bao giờ tab Garment.
    const autoGarmentOnly = runBackground({ tabs: [garmentTab] });
    await settle();
    assert.equal(await autoGarmentOnly.context.findInsideTab(), null, "findInsideTab() không thấy tab Garment");
    const autoBoth = runBackground({ tabs: [garmentTab, mastigeTab] });
    await settle();
    assert.equal((await autoBoth.context.findInsideTab()).id, 11);
    assert.equal((await autoBoth.context.findInsideTab("garment")).id, 12);
    assert.equal(await autoBoth.context.findInsideTab("evil"), null);
  }

  // GET_PO (0.10.1): inside-bridge.js thật trong vm với DOM giả theo cột danh sách PO đã đo trên Inside 17/10/2026:
  // # | Code | Vendor | Stock | LastModified | Delivery | Due Date | Status. Rcvd date của biên bản = LastModified (cells[4]).
  const insideBridge = fs.readFileSync(path.join(extensionDir, "inside-bridge.js"), "utf8");
  const runGetPo = ({ listDelivery = "27-02-08|13:46", detailDelivery = "2027-02-08", lastModified = "26-10-15|14:35", vendor = "CÔNG TY MẪU - Ms Test", host = "inside.mastige.vn", type = "GET_PO", payload = { poCode: "PO-TEST-001" }, fetched = [] } = {}) => {
    let listener;
    const node = (textContent, extra = {}) => ({ textContent, querySelector: () => null, querySelectorAll: () => [], ...extra });
    const poCode = payload.poCode || "PO-TEST-001";
    const editLink = { textContent: poCode, href: "https://inside.example/purchase/order/77/edit" };
    const listRow = {
      cells: ["1", poCode, vendor, "WH - TEST", lastModified, listDelivery, "2026-11-05", "approved"].map(value => node(value)),
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
      window: win, URL, location: { hostname: host, origin: `https://${host}` },
      chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
      fetch: async url => { fetched.push(String(url)); return { ok: true, text: async () => String(url).includes("/edit") ? "detail" : "list" }; },
      DOMParser: class { parseFromString(html) { return docs[html]; } },
    };
    context.globalThis = context;
    vm.runInNewContext(insideBridge, context);
    return new Promise(resolve => listener({ type, payload }, { id: "ext-id" }, value => resolve(JSON.parse(JSON.stringify(value)))));
  };
  const po = await runGetPo();
  assert.equal(po.ok, true, JSON.stringify(po));
  assert.equal(po.data.lastModified, "2026-10-15", "LastModified \"26-10-15|14:35\" → ngày ISO, bỏ phần giờ");
  assert.equal(po.data.deliveryDate, "2027-02-08", "deliveryDate giữ nguyên cho bên dùng cũ");
  assert.deepEqual([po.data.poId, po.data.vendor, po.data.status, po.data.items.length], ["77", "CÔNG TY MẪU - Ms Test", "approved", 1]);
  assert.equal((await runGetPo({ lastModified: "2026-10-15 14:35:00" })).data.lastModified, "2026-10-15", "dạng ISO có giờ cũng cắt về ngày");
  assert.equal((await runGetPo({ lastModified: "" })).data.lastModified, "", "ô trống → chuỗi rỗng để web rơi về deliveryDate");
  assert.equal((await runGetPo({ detailDelivery: "" })).data.deliveryDate, "2027-02-08", "thiếu ô delivery_date ở chi tiết → dùng cột Delivery của danh sách");

  // 0.11.0: Inside Garment — cùng bridge, site nhận diện theo tên miền của tab và trả kèm trong dữ liệu PO.
  // Cột danh sách PO Garment đã đo 26/10/2026 trùng vị trí Mastige (Code, Vendor, Stock, LastModified, Delivery, Due Date, Status).
  const garmentHost = "garment.inshasaki.com";
  assert.equal(po.data.site, "mastige", "tab Inside Mastige → site mastige");
  const garmentPo = await runGetPo({ host: garmentHost, payload: { poCode: "100000001", site: "garment" } });
  assert.equal(garmentPo.ok, true, JSON.stringify(garmentPo));
  assert.deepEqual([garmentPo.data.site, garmentPo.data.poId, garmentPo.data.lastModified, garmentPo.data.items.length], ["garment", "77", "2026-10-15", 1]);
  assert.equal((await runGetPo({ payload: { poCode: "PO-TEST-001", site: "mastige" } })).data.site, "mastige", "payload site mastige trên tab Mastige");
  assert.equal((await runGetPo({ payload: { poCode: "PO-TEST-001" } })).ok, true, "thiếu site = mastige (web cũ)");
  const mismatches = [
    { host: garmentHost, payload: { poCode: "100000001", site: "mastige" } },
    { host: garmentHost, payload: { poCode: "100000001" } },
    { payload: { poCode: "PO-TEST-001", site: "garment" } },
    { host: "inside.example", payload: { poCode: "PO-TEST-001", site: "mastige" } },
  ];
  for (const options of mismatches) {
    const fetched = [];
    const reply = await runGetPo({ ...options, fetched });
    assert.deepEqual([reply.ok, reply.error?.code, fetched.length], [false, "SITE_MISMATCH", 0], `tab ${options.host || "mastige"} + ${JSON.stringify(options.payload)}: bridge không đọc PO của site khác`);
  }
  // Đồng bộ SKU chỉ ở Inside Mastige: tab Garment từ chối trước khi gọi mạng.
  const garmentFetched = [];
  const garmentSync = await runGetPo({ host: garmentHost, type: "GET_SKU_SYNC_DATA", payload: { full: true }, fetched: garmentFetched });
  assert.deepEqual([garmentSync.ok, garmentSync.error?.code, garmentFetched.length], [false, "SKU_SYNC_SITE_FORBIDDEN", 0]);
  const mastigeSync = await runGetPo({ type: "GET_SKU_SYNC_DATA", payload: { full: true } });
  assert.equal(mastigeSync.error?.code, "SKU_SYNC_READ_FAILED", "tab Mastige không bị cổng site chặn (vm không nạp sku-sync-core nên lỗi ở bộ đọc)");
  // Ô NCC: Inside Garment có dòng "- <tên>" (không có phần trước dấu gạch, 3/50 dòng đo 26/10) → bỏ "- " đầu; dạng "<tên> - <liên hệ>" giữ nguyên.
  assert.equal((await runGetPo({ host: garmentHost, payload: { poCode: "100000001", site: "garment" }, vendor: "- Hộ kinh doanh Mẫu" })).data.vendor, "Hộ kinh doanh Mẫu");
  assert.equal((await runGetPo({ vendor: "  -   Công ty B  " })).data.vendor, "Công ty B");
  assert.equal((await runGetPo({ vendor: "Công ty C - Ms Test" })).data.vendor, "Công ty C - Ms Test");
  assert.equal((await runGetPo({ vendor: "Công ty - D" })).data.vendor, "Công ty - D", "chỉ bỏ dấu gạch ở ĐẦU chuỗi");
  assert.equal((await runGetPo({ vendor: "-Công ty E" })).data.vendor, "-Công ty E", "gạch dính liền chữ không phải dạng '- <tên>'");

  console.log("inside_po_connector: manifest, allowed origins and app bridge replies passed");
})().catch(error => { console.error(error); process.exit(1); });
