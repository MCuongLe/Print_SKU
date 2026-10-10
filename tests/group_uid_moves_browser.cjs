// Ô LỊCH SỬ GROUP UID trên trang chủ (#group-uid-history): xem không cần đăng nhập, đọc từ WMS chỉ khi là Admin.
// Chạy với python -m http.server 8000; Extension, WMS và Supabase đều giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = "http://127.0.0.1:8000/", SESSION_KEY = "print-sku-admin-session-v1", DAY = 86400000, NOW = Date.now();
const fmt = n => n.toLocaleString("vi-VN");

// --- Dữ liệu WMS giả: 620 lượt (2 trang) + 2 lượt cũ (60 và 200 ngày) ---
const LOCS = ["F0-KHO-503-02-04-01", "F0-KHO-501-01-01-01", "F0-VR-00-00-00-00", "F0-KHO-HM-04-02-01"];
const USERS = ["tuanlq5@hasaki.vn", "nhudty@hasaki.vn", "tamlc@hasaki.vn"];
const WHS = ["WH - MATERIAL - MTG", "WH - SEMI PRODUCT - MTG", "WH - MATERIAL - GARMENT"];
const uidOf = i => `10282606${String(i % 200).padStart(8, "0")}`;
const skuOf = uid => `4225${String(Number(uid.slice(-3)) % 40).padStart(5, "0")}`;
const mk = (i, extra = {}) => ({
  history_id: 100000 + i, group_uid_code: uidOf(i), warehouse_id: 1177 + (i % 7 === 0 ? 1 : i % 11 === 0 ? 162 : 0),
  warehouse: i % 7 === 0 ? WHS[1] : i % 11 === 0 ? WHS[2] : WHS[0],
  action_code: 4, action_name: "Transfer location", from_location: LOCS[(i + 1) % 4], to_location: LOCS[i % 4],
  moved_by: USERS[i % 3], moved_at: new Date(NOW - i * 30 * 60000).toISOString(), ...extra,
});
const wms = Array.from({ length: 620 }, (_, i) => mk(i));
wms.push(mk(7000, { moved_at: new Date(NOW - 60 * DAY).toISOString() }), mk(7001, { moved_at: new Date(NOW - 200 * DAY).toISOString() }));
const vnDate = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
const since = days => Date.parse(`${vnDate(NOW - (days - 1) * DAY)}T00:00:00+07:00`);
const count = pred => wms.filter(pred).length;
const days = n => r => Date.parse(r.moved_at) >= since(n);

const fakeExtension = (data, version) => {
  window.__extCalls = []; window.__wms = data; window.__fail = false;
  addEventListener("message", event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return reply(true, { version });
    if (request.type === "GET_GROUP_UID_MOVES_PAGE") {
      const { page, size, from, to } = request.payload;
      if (window.__fail) return reply(false, null, { message: "Phiên WMS không còn quyền đọc lịch sử chuyển vị trí; hãy đăng nhập lại" });
      const rows = window.__wms.filter(r => Date.parse(r.moved_at) >= Date.parse(from) && Date.parse(r.moved_at) <= Date.parse(to)).sort((a, b) => Date.parse(b.moved_at) - Date.parse(a.moved_at));
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: rows.slice((page - 1) * size, page * size), companyId: null });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

// --- Supabase giả: mô phỏng group_uid_moves_* (đối chiếu logic với supabase/group_uid_moves_v1.sql + v2_lookup.sql) ---
const db = new Map(), reads = new Map(), rpcCalls = [];
function lookup(a) {
  const loc = (a.p_location || "").trim().toLowerCase(), sku = (a.p_sku || "").trim().toLowerCase(), wh = (a.p_warehouse || "").trim(), match = ["to", "from", "any"].includes(a.p_match) ? a.p_match : "to";
  const all = [...db.values()].sort((x, y) => Date.parse(x.moved_at) - Date.parse(y.moved_at) || x.history_id - y.history_id), byUid = new Map();
  all.forEach(r => { if (!byUid.has(r.group_uid_code)) byUid.set(r.group_uid_code, []); byUid.get(r.group_uid_code).push(r); });
  const hit = all.filter(r => (!wh || r.warehouse === wh) && (!a.p_from || Date.parse(r.moved_at) >= Date.parse(a.p_from)) && (!a.p_to || Date.parse(r.moved_at) < Date.parse(a.p_to))
    && (!loc || (match !== "from" && (r.to_location || "").toLowerCase().includes(loc)) || (match !== "to" && (r.from_location || "").toLowerCase().includes(loc)))
    && (!sku || skuOf(r.group_uid_code).toLowerCase().includes(sku)))
    .sort((x, y) => Date.parse(y.moved_at) - Date.parse(x.moved_at) || y.history_id - x.history_id);
  const limit = Math.min(Math.max(a.p_limit || 1000, 1), 5000), force = sku === "big";
  const items = hit.slice(0, force ? 5 : limit).map(r => { const chain = byUid.get(r.group_uid_code), next = chain[chain.indexOf(r) + 1];
    return { id: r.history_id, uid: r.group_uid_code, warehouse: r.warehouse, from: r.from_location, to: r.to_location, by: r.moved_by, at: r.moved_at,
      nextLocation: next?.to_location ?? null, nextAt: next?.moved_at ?? null, sku: skuOf(r.group_uid_code), skuCount: 1, product: `Chỉ mẫu ${skuOf(r.group_uid_code)}` }; });
  return { items, total: force ? 7000 : hit.length, limit, truncated: force || hit.length > limit };
}
function rpc(name, args) {
  if (name === "group_uid_moves_overview" || name === "group_uid_moves_state") {
    const rows = [...db.values()], times = rows.map(r => Date.parse(r.moved_at)), counts = {};
    rows.forEach(r => { counts[r.warehouse] = (counts[r.warehouse] || 0) + 1; });
    const data = { total: rows.length, firstAt: rows.length ? new Date(Math.min(...times)).toISOString() : null, lastAt: rows.length ? new Date(Math.max(...times)).toISOString() : null,
      lastReadAt: reads.size ? new Date(Math.max(...[...reads.values()].map(r => r.at))).toISOString() : null };
    if (name === "group_uid_moves_overview") return { ...data, warehouses: Object.entries(counts).sort().map(([n, c]) => ({ name: n, count: c })) };
    return { ...data, companies: [...reads.entries()].map(([id, r]) => ({ companyId: id, companyName: r.name, lastTo: r.to, readAt: new Date(r.at).toISOString(), rows: r.rows })) };
  }
  if (name === "group_uid_moves_import") {
    let added = 0, changed = 0;
    for (const r of args.p_rows) { const old = db.get(r.history_id); if (!old) added++; else if (JSON.stringify(old) !== JSON.stringify(r)) changed++; db.set(r.history_id, r); }
    return { rows: args.p_rows.length, newRows: added, changedRows: changed, unchangedRows: args.p_rows.length - added - changed };
  }
  if (name === "group_uid_moves_mark_read") { reads.set(args.p_company_id, { name: args.p_company_name, to: args.p_to, at: Date.now(), rows: args.p_rows }); return { companyId: args.p_company_id }; }
  if (name === "group_uid_moves_lookup") return lookup(args);
  throw new Error("RPC chưa giả lập: " + name);
}
const ADMIN_ONLY = new Set(["group_uid_moves_import", "group_uid_moves_mark_read", "group_uid_moves_state"]);

async function mock(page) {
  await page.route("**/*", route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/auth/v1/user")) return json({ id: "00000000-0000-4000-8000-000000000001" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Admin", role: "admin" }]);
    const match = /\/rest\/v1\/rpc\/(group_uid_moves_[a-z_]+)/.exec(url);
    if (match) {
      const headers = route.request().headers(), args = JSON.parse(route.request().postData() || "{}");
      rpcCalls.push({ name: match[1], args, auth: headers.authorization });
      if (ADMIN_ONLY.has(match[1]) && headers.authorization !== "Bearer test-admin-token") return json({ code: "42501", message: `permission denied for function ${match[1]}` }, 401);
      return json({ ok: true, data: rpc(match[1], args), meta: { schemaVersion: 1 } });
    }
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
}
const seed = () => { db.clear(); reads.clear(); rpcCalls.length = 0; wms.forEach(r => db.set(r.history_id, { ...r })); reads.set(0, { name: "Tất cả công ty", to: new Date(NOW).toISOString(), at: NOW, rows: wms.length }); };

async function open(browser, width, { admin }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  await context.addInitScript(`(${fakeExtension.toString()})(${JSON.stringify(wms)}, "0.7.1")`);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mock(page);
  return { context, page, errors };
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [375, 1280]) {
      // ================= Nhân viên kho: xem, không đăng nhập =================
      seed();
      let { context, page, errors } = await open(browser, width, { admin: false });
      await page.goto(BASE + "#home");
      const tile = page.locator("#barcode-uid-history");
      await tile.waitFor({ state: "visible" });
      assert.equal((await tile.innerText()).trim(), "LỊCH SỬ GROUP UID");
      assert.equal(await tile.evaluate(el => el.closest(".barcode-home__group").querySelector("h2").textContent.trim()), "Vận hành kho");
      await tile.click();
      await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => location.hash), "#group-uid-history");
      assert.equal(await tile.isVisible(), false, "trang chủ ẩn khi mở màn lịch sử");
      const total = wms.length, within30 = count(days(30));
      await page.waitForFunction(n => document.getElementById("uh-count").textContent === n, fmt(within30));
      assert.match(await page.locator("#uh-updated-text").innerText(), new RegExp(`^Cập nhật .* · ${fmt(total).replace(".", "\\.")} lượt$`), "dòng Cập nhật: giờ đọc gần nhất và tổng số lượt");
      assert.equal(await page.locator("#uh-admin-tools").isVisible(), false, "người không phải Admin không thấy nút Đọc từ WMS");
      assert.equal(await adminState(page), "false");
      assert.equal(await page.locator("#uh-list .uh-item").count(), 30, "30 thẻ đầu, còn lại bấm Xem thêm");
      assert.match(await page.locator("#uh-more").innerText(), new RegExp(`^Xem thêm \\(${fmt(within30 - 30)}\\)$`));
      const publishable = await page.evaluate(() => window.PrintSkuQueue.publishableKey);
      assert.ok(rpcCalls.length > 0 && rpcCalls.every(c => c.auth === `Bearer ${publishable}`), "xem lịch sử dùng khóa ẩn danh, không dùng phiên Admin");
      assert.deepEqual([...new Set(rpcCalls.map(c => c.name))].sort(), ["group_uid_moves_lookup", "group_uid_moves_overview"], "chỉ gọi hàm đọc");
      assert.equal(rpcCalls.find(c => c.name === "group_uid_moves_lookup").args.p_limit, 1000);
      const firstCard = await page.locator("#uh-list .uh-item").first().innerText();
      assert.match(firstCard, /10282606\d{8}/); assert.match(firstCard, /4225\d{5}/, "có SKU ghép từ Group UID"); assert.match(firstCard, /@hasaki\.vn/, "người cập nhật hiện đầy đủ email");
      assert.match(firstCard, /Còn ở đây/, "lượt mới nhất của UID: còn ở đây");
      await page.locator("#uh-more").click();
      assert.equal(await page.locator("#uh-list .uh-item").count(), 60);
      const khoOptions = await page.locator("#uh-wh option").allInnerTexts();
      assert.equal(khoOptions.length, 4, "Tất cả kho + 3 kho");
      assert.match(khoOptions[1], /^WH - MATERIAL - GARMENT \(\d+\)$/);

      // --- Bộ lọc ---
      const inRange = days(30), lastCall = () => rpcCalls.filter(c => c.name === "group_uid_moves_lookup").at(-1).args;
      const wait = n => page.waitForFunction(v => document.getElementById("uh-count").textContent === v, fmt(n));
      const until = async check => { for (let i = 0; i < 100 && !check(); i++) await page.waitForTimeout(50); assert.ok(check(), "chưa thấy yêu cầu tìm kiếm mong đợi"); };
      await page.locator("#uh-loc").fill("f0-vr"); await wait(count(r => inRange(r) && r.to_location.toLowerCase().includes("f0-vr")));
      assert.match(await page.locator("#uh-list").innerText(), /Trả NCC/, "F0-VR-00-00-00-00 hiện nhãn Trả NCC");
      await page.locator('[data-uh-match="from"]').click(); await until(() => lastCall().p_match === "from"); await wait(count(r => inRange(r) && r.from_location.toLowerCase().includes("f0-vr")));
      await page.locator('[data-uh-match="any"]').click(); await until(() => lastCall().p_match === "any"); await wait(count(r => inRange(r) && (r.from_location + r.to_location).toLowerCase().includes("f0-vr")));
      await page.locator('[data-uh-match="to"]').click(); await page.locator("#uh-loc").fill("503-02");
      await wait(count(r => inRange(r) && r.to_location.includes("503-02")));
      await page.locator("#uh-loc").fill("");
      await page.locator("#uh-sku").fill("42250001"); await wait(count(r => inRange(r) && skuOf(r.group_uid_code).includes("42250001")));
      assert.equal((await page.locator("#uh-list .uh-uid").allInnerTexts()).every(c => skuOf(c.trim()).includes("42250001")), true);
      await page.locator("#uh-sku").fill("");
      await page.locator("#uh-wh").selectOption("WH - MATERIAL - GARMENT"); await wait(count(r => inRange(r) && r.warehouse === "WH - MATERIAL - GARMENT"));
      assert.equal(lastCall().p_warehouse, "WH - MATERIAL - GARMENT");
      assert.equal((await page.locator("#uh-list .uh-meta").allInnerTexts()).every(t => t.includes("WH - MATERIAL - GARMENT")), true, "mọi thẻ đúng kho đã chọn");
      await page.locator("#uh-wh").selectOption("");
      await page.locator('[data-uh-range="7"]').click(); await wait(count(days(7)));
      await page.locator('[data-uh-range="90"]').click(); await wait(count(days(90)));
      await page.locator('[data-uh-range="365"]').click(); await wait(total);
      assert.equal(await page.locator("#uh-dates").isVisible(), false, "ô chọn ngày chỉ hiện khi bấm biểu tượng lịch");
      await page.locator('[data-uh-range="custom"]').click();
      assert.equal(await page.locator("#uh-dates").isVisible(), true);
      await page.locator("#uh-from").fill(vnDate(NOW - 3 * DAY)); await wait(count(r => Date.parse(r.moved_at) >= Date.parse(`${vnDate(NOW - 3 * DAY)}T00:00:00+07:00`)));
      await page.locator("#uh-clear").click(); await wait(within30);
      assert.equal(await page.locator('[data-uh-range="30"]').getAttribute("aria-pressed"), "true", "Xóa bộ lọc về 30 ngày");
      await page.locator("#uh-sku").fill("big");
      await page.waitForFunction(() => /Hiển thị 0 \/ 7\.000/.test(document.getElementById("uh-message").textContent));
      await page.locator("#uh-sku").fill(""); await wait(within30);

      // --- Sao chép UID, quét camera (SKU / vị trí) ---
      const firstUid = (await page.locator("#uh-list .uh-uid").first().innerText()).trim();
      await page.locator("#uh-list .uh-uid").first().click();
      await page.waitForFunction(u => document.getElementById("uh-message").textContent.includes(u), firstUid);
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstUid);
      await page.evaluate(() => { window.__scan = []; window.PrintSkuScanUI.canOpen = () => true; window.PrintSkuScanUI.open = options => window.__scan.push(options); });
      await page.evaluate(() => { location.hash = "#home"; }); await page.waitForFunction(() => document.getElementById("uidhist-screen").hidden);
      await page.evaluate(() => { location.hash = "#group-uid-history"; }); await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      assert.equal(await page.locator("#uh-loc-scan").isVisible(), true, "có nút quét camera khi trình duyệt cho phép");
      await page.locator("#uh-loc-scan").click();
      const locScan = await page.evaluate(() => ({ title: window.__scan[0].title, ok: !!window.__scan[0].check("F0-VR-00-00-00-00"), okLower: !!window.__scan[0].check("f0-kho-503-02-04-01"), bad: !!window.__scan[0].check("khong phai ma vi tri") }));
      assert.deepEqual(locScan, { title: "Quét mã vị trí", ok: true, okLower: true, bad: false });
      await page.evaluate(() => window.__scan[0].onCode("f0-vr-00-00-00-00"));
      assert.equal(await page.locator("#uh-loc").inputValue(), "F0-VR-00-00-00-00", "mã quét điền vào ô Vị trí (chữ hoa)");
      await wait(count(r => inRange(r) && r.to_location.toLowerCase().includes("f0-vr-00-00-00-00")));
      await page.locator("#uh-sku-scan").click();
      const skuScan = await page.evaluate(() => ({ title: window.__scan[1].title, ok: !!window.__scan[1].check("422500001"), bad: !!window.__scan[1].check("12345") }));
      assert.deepEqual(skuScan, { title: "Quét SKU", ok: true, bad: false });
      await page.evaluate(() => window.__scan[1].onCode("422500001"));
      assert.equal(await page.locator("#uh-sku").inputValue(), "422500001");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();

      // ================= Admin: đăng nhập rồi đọc từ WMS =================
      db.clear(); reads.clear(); rpcCalls.length = 0;
      ({ context, page, errors } = await open(browser, width, { admin: true }));
      await page.goto(BASE + "#group-uid-history");
      await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.getElementById("uh-empty").hidden === false);
      assert.equal(await page.locator("#uh-updated-text").innerText(), "Chưa có dữ liệu");
      assert.equal(await page.locator("#uh-admin-tools").isVisible(), true, "Admin thấy nút Đọc từ WMS");
      assert.equal(await adminState(page), "true");
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => /^Đã đọc/.test(document.getElementById("uh-message").textContent));
      assert.equal(db.size, wms.length, "nạp đủ mọi lượt của WMS");
      assert.match(await page.locator("#uh-message").innerText(), new RegExp(`Đã đọc ${fmt(wms.length)} lượt chuyển: ${fmt(wms.length)} mới, 0 cập nhật`));
      let calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE").map(c => c.payload));
      assert.deepEqual(calls.map(c => c.page), [1, 2], "622 lượt = 2 trang 500 dòng");
      assert.ok(calls.every(c => c.companyId === undefined), "WMS không lọc theo công ty: không truyền companyId");
      const span = (Date.parse(calls[0].to) - Date.parse(calls[0].from)) / DAY;
      assert.ok(span > 364.9 && span < 365.1, "lần đầu lấy 365 ngày");
      const adminCalls = rpcCalls.filter(c => ADMIN_ONLY.has(c.name));
      assert.ok(adminCalls.length >= 3 && adminCalls.every(c => c.auth === "Bearer test-admin-token"), "ghi dữ liệu bằng phiên Admin");
      assert.ok(rpcCalls.filter(c => c.name === "group_uid_moves_import").every(c => c.args.p_company_id === 0), "p_company_id = 0: mọi công ty");
      assert.equal(rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length, 1, "ghi mốc một lần");
      await page.waitForFunction(n => document.getElementById("uh-count").textContent === n, fmt(count(days(30))));
      assert.match(await page.locator("#uh-updated-text").innerText(), new RegExp(`${fmt(wms.length).replace(".", "\\.")} lượt$`));
      assert.equal(await page.locator("#uh-run").isEnabled(), true);

      await page.evaluate(() => window.__extCalls.splice(0));
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => /Không có lượt chuyển mới/.test(document.getElementById("uh-message").textContent));
      calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE").map(c => c.payload));
      assert.ok(Math.abs(Date.parse(calls[0].from) - (Date.parse(adminCalls.find(c => c.name === "group_uid_moves_mark_read").args.p_to) - 30 * 60000)) < 1000, "lần sau lùi 30 phút từ mốc đã đọc");
      assert.equal(db.size, wms.length, "đọc chồng không nhân đôi");
      await page.evaluate(id => window.__wms.unshift({ history_id: id, group_uid_code: "1028260600009999", warehouse_id: 1177, warehouse: "WH - MATERIAL - MTG", action_code: 4, action_name: "Transfer location", from_location: "F0-KHO-501-01-01-01", to_location: "F0-KHO-HM-04-02-01", moved_by: "tamlc@hasaki.vn", moved_at: new Date().toISOString() }), 109999999);
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => /1 mới, 0 cập nhật/.test(document.getElementById("uh-message").textContent));
      assert.equal(db.size, wms.length + 1);

      await page.evaluate(() => { window.__fail = true; window.__extCalls.splice(0); });
      const marks = rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length;
      await page.locator("#uh-full").click();
      await page.waitForFunction(() => document.getElementById("uh-message").dataset.tone === "error");
      assert.match(await page.locator("#uh-message").innerText(), /không còn quyền/);
      assert.equal(rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length, marks, "lần đọc lỗi không được ghi mốc");
      assert.equal(await page.locator("#uh-run").isEnabled(), true, "lỗi xong vẫn đọc lại được");
      await page.evaluate(() => { window.__fail = false; window.__extCalls.splice(0); });
      await page.locator("#uh-full").click();
      await page.waitForFunction(() => /Không có lượt chuyển mới/.test(document.getElementById("uh-message").textContent));
      const full = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE")[0].payload);
      assert.ok((Date.parse(full.to) - Date.parse(full.from)) / DAY > 364.9, "nút đồng hồ đọc lại 365 ngày");

      // Thoát quyền Admin: nút đọc biến mất, vẫn xem được
      await page.locator("#uh-admin").click();
      const confirm = page.locator("dialog.whd"); await confirm.waitFor({ state: "visible" });
      await confirm.locator(".whd-ok").click(); await confirm.waitFor({ state: "hidden" });
      assert.equal(await page.locator("#uh-admin-tools").isVisible(), false);
      assert.equal(await adminState(page), "false");
      assert.equal(await page.locator("#uh-list .uh-item").count() > 0, true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("group_uid_moves_browser: ô trang chủ, xem không đăng nhập, bộ lọc, quét camera, Admin đọc từ WMS tăng dần và responsive passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function adminState(page) { return page.locator("#uh-admin").getAttribute("aria-pressed"); }
