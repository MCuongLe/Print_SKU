// Lịch sử Group UID (tab "Lịch sử di chuyển" trong #admin/group-uid-sync): đọc WMS qua Extension giả lập, nạp/tìm qua RPC Supabase giả lập, bộ lọc, bảng, CSV.
// Chạy với python -m http.server 8000; Extension, WMS và Supabase đều giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const BASE = "http://127.0.0.1:8000/", SESSION_KEY = "print-sku-admin-session-v1", DAY = 86400000, NOW = Date.now();

// --- Dữ liệu WMS giả: công ty 1001 trống, 1002 có 2 trang (620 dòng), 1005 vài dòng ---
const LOCS = ["F0-KHO-503-02-04-01", "F0-KHO-501-01-01-01", "F0-VR-00-00-00-00", "F0-KHO-HM-04-02-01"];
const USERS = ["tuanlq5@hasaki.vn", "nhudty@hasaki.vn", "tamlc@hasaki.vn"];
const uidOf = i => `10282606${String(i % 200).padStart(8, "0")}`;
const skuOf = uid => `4225${String(Number(uid.slice(-3)) % 40).padStart(5, "0")}`;
const mk = (i, company, extra = {}) => ({
  history_id: company * 100000 + i, group_uid_code: uidOf(i), warehouse_id: company === 1002 ? (i % 7 ? 1177 : 1178) : 1339,
  warehouse: company === 1002 ? (i % 7 ? "WH - MATERIAL - MTG" : "WH - SEMI PRODUCT - MTG") : "WH - MATERIAL - GARMENT",
  action_code: 4, action_name: "Transfer location", from_location: LOCS[(i + 1) % 4], to_location: LOCS[i % 4],
  moved_by: USERS[i % 3], moved_at: new Date(NOW - i * 30 * 60000).toISOString(), ...extra,
});
const wms = { 1001: [], 1002: Array.from({ length: 620 }, (_, i) => mk(i, 1002)), 1005: Array.from({ length: 12 }, (_, i) => mk(i + 900, 1005)) };
// Hai dòng cũ để thử bộ chọn 90 ngày / 1 năm (cách đây 60 và 200 ngày).
wms[1002].push(mk(7000, 1002, { moved_at: new Date(NOW - 60 * DAY).toISOString() }), mk(7001, 1002, { moved_at: new Date(NOW - 200 * DAY).toISOString() }));
const vnDate = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
const since = days => Date.parse(`${vnDate(NOW - (days - 1) * DAY)}T00:00:00+07:00`);
const expected = (pred, rows = Object.values(wms).flat()) => rows.filter(pred).length;

const fakeExtension = (data, version) => {
  window.__extCalls = []; window.__wms = data; window.__fail = 0;
  addEventListener("message", event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return reply(true, { version });
    if (request.type === "GET_WMS_COMPANIES") return reply(true, { companies: [
      { companyId: 1001, companyCode: "hasaki", companyName: "Cty CP Hasaki Vietnam" }, { companyId: 1002, companyCode: "mastige", companyName: "Cty Mastige" }, { companyId: 1005, companyCode: "garment", companyName: "Cty Garment" }] });
    if (request.type === "GET_GROUP_UID_MOVES_PAGE") {
      const { companyId, page, size, from, to } = request.payload;
      if (window.__fail === companyId) return reply(false, null, { message: "Phiên WMS không còn quyền đọc lịch sử chuyển vị trí; hãy đăng nhập lại" });
      const rows = (window.__wms[companyId] || []).filter(r => Date.parse(r.moved_at) >= Date.parse(from) && Date.parse(r.moved_at) <= Date.parse(to)).sort((a, b) => Date.parse(b.moved_at) - Date.parse(a.moved_at));
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: rows.slice((page - 1) * size, page * size), companyId });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

// --- Supabase giả: bảng + RPC mô phỏng group_uid_moves_* (đối chiếu logic với supabase/group_uid_moves_v1.sql) ---
const db = new Map(), reads = new Map(), rpcCalls = [];
function search(a) {
  const loc = (a.p_location || "").trim().toLowerCase(), sku = (a.p_sku || "").trim().toLowerCase(), match = ["to", "from", "any"].includes(a.p_match) ? a.p_match : "to";
  const all = [...db.values()].sort((x, y) => Date.parse(x.moved_at) - Date.parse(y.moved_at) || x.history_id - y.history_id), byUid = new Map();
  all.forEach(r => { if (!byUid.has(r.group_uid_code)) byUid.set(r.group_uid_code, []); byUid.get(r.group_uid_code).push(r); });
  const hit = all.filter(r => (!a.p_from || Date.parse(r.moved_at) >= Date.parse(a.p_from)) && (!a.p_to || Date.parse(r.moved_at) < Date.parse(a.p_to))
    && (!loc || (match !== "from" && (r.to_location || "").toLowerCase().includes(loc)) || (match !== "to" && (r.from_location || "").toLowerCase().includes(loc)))
    && (!sku || skuOf(r.group_uid_code).toLowerCase().includes(sku)))
    .sort((x, y) => Date.parse(y.moved_at) - Date.parse(x.moved_at) || y.history_id - x.history_id);
  const limit = Math.min(Math.max(a.p_limit || 5000, 1), 5000), forceTruncate = sku === "big";
  const items = hit.slice(0, limit).map(r => { const chain = byUid.get(r.group_uid_code), next = chain[chain.indexOf(r) + 1];
    return { id: r.history_id, uid: r.group_uid_code, warehouse: r.warehouse, from: r.from_location, to: r.to_location, by: r.moved_by, at: r.moved_at,
      nextLocation: next?.to_location ?? null, nextAt: next?.moved_at ?? null, sku: skuOf(r.group_uid_code), skuCount: 1, product: `Chỉ mẫu ${skuOf(r.group_uid_code)}`, currentLocation: null }; });
  return { items, total: forceTruncate ? 7000 : hit.length, limit, truncated: forceTruncate || hit.length > limit };
}
function rpc(name, args) {
  if (name === "group_uid_moves_state") {
    const rows = [...db.values()], times = rows.map(r => Date.parse(r.moved_at));
    return { total: rows.length, firstAt: rows.length ? new Date(Math.min(...times)).toISOString() : null, lastAt: rows.length ? new Date(Math.max(...times)).toISOString() : null,
      lastReadAt: reads.size ? new Date(Math.max(...[...reads.values()].map(r => r.at))).toISOString() : null,
      companies: [...reads.entries()].map(([id, r]) => ({ companyId: id, companyName: r.name, lastTo: r.to, readAt: new Date(r.at).toISOString(), rows: r.rows })) };
  }
  if (name === "group_uid_moves_import") {
    let added = 0, changed = 0;
    for (const r of args.p_rows) { const old = db.get(r.history_id); if (!old) added++; else if (JSON.stringify(old) !== JSON.stringify(r)) changed++; db.set(r.history_id, r); }
    return { rows: args.p_rows.length, newRows: added, changedRows: changed, unchangedRows: args.p_rows.length - added - changed };
  }
  if (name === "group_uid_moves_mark_read") { reads.set(args.p_company_id, { name: args.p_company_name, to: args.p_to, at: Date.now(), rows: args.p_rows }); return { companyId: args.p_company_id }; }
  if (name === "group_uid_moves_search") return search(args);
  throw new Error("RPC chưa giả lập: " + name);
}

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
      return json({ ok: true, data: rpc(match[1], args), meta: { schemaVersion: 1 } });
    }
    if (url.includes("/functions/v1/group-uid-sync")) return json({ ok: true, data: { state: {}, runs: [] } });
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1280, 375]) {
      db.clear(); reads.clear(); rpcCalls.length = 0;
      const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
      await context.addInitScript(`(${fakeExtension.toString()})(${JSON.stringify(wms)}, "0.7.0")`);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await mock(page);
      await page.goto(BASE + "#admin/group-uid-sync");
      await page.locator("#group-uid-sync-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => /sẵn sàng/.test(document.getElementById("gu-connection").textContent));
      // --- Hai tab trong một màn: Đồng bộ (mặc định) và Lịch sử di chuyển ---
      assert.deepEqual(await page.locator(".gu-main-tabs .as-tab").allInnerTexts().then(t => t.map(x => x.trim())), ["Đồng bộ", "Lịch sử di chuyển"]);
      assert.equal(await page.locator('[data-gu-main-tab="sync"]').getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#gu-run-incremental").isVisible(), true, "tab Đồng bộ mở sẵn");
      assert.equal(await page.locator("#gu-panel-moves").isVisible(), false);
      assert.equal(await page.locator("#gm-top-chips").isVisible(), false);
      assert.deepEqual(await page.locator("#group-uid-sync-screen .ss-nav button").allInnerTexts().then(t => t.map(x => x.trim())),
        ["Lệnh in", "Đồng bộ SKU", "Đồng bộ Group UID", "Kiểm kê SKU", "Cấu hình"], "không thêm mục menu: Lịch sử nằm trong màn Đồng bộ Group UID");
      assert.equal(await page.locator("#gu-panel-sync .ss-hero h2").innerText(), "Đối chiếu dữ liệu WMS");
      await page.locator('[data-gu-main-tab="moves"]').click();
      assert.equal(await page.locator('[data-gu-main-tab="moves"]').getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#gu-panel-moves").isVisible(), true);
      assert.equal(await page.locator("#gu-panel-sync").isVisible(), false, "đổi tab ẩn khung Đồng bộ");
      assert.equal(await page.locator("#gu-run-incremental").isVisible(), false);
      assert.equal(await page.locator("#gu-top-refresh").isVisible(), false, "nút tải lại của tab Đồng bộ ẩn");
      assert.equal(await page.locator("#gm-top-refresh").isVisible(), true);
      assert.equal(await page.locator("#group-uid-sync-screen .ss-top-sub").innerText(), "WMS · chuyển vị trí");
      await page.waitForFunction(() => /Không có lượt chuyển/.test(document.getElementById("gm-status").textContent));
      assert.equal(await page.locator("#gm-total").innerText(), "0");
      assert.equal(await page.locator("#gm-next-from").innerText(), "365 ngày gần nhất", "chưa đọc lần nào thì lần đầu lấy 365 ngày");

      // --- Đọc lần đầu: mọi công ty, 365 ngày, nhiều trang ---
      await page.locator("#gm-run").click();
      await page.waitForFunction(() => /^Đã đọc/.test(document.getElementById("gm-status").textContent));
      const total = wms[1002].length + wms[1005].length, within30 = expected(r => Date.parse(r.moved_at) >= since(30));
      assert.equal(db.size, total, "nạp đủ mọi dòng của các công ty");
      assert.match(await page.locator("#gm-status").innerText(), new RegExp(`Đã đọc ${total} lượt chuyển: ${total} mới, 0 cập nhật`));
      const calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE").map(c => c.payload));
      assert.deepEqual([...new Set(calls.map(c => c.companyId))].sort(), [1001, 1002, 1005], "đọc từng công ty, không bỏ công ty nào");
      assert.deepEqual(calls.filter(c => c.companyId === 1002).map(c => c.page), [1, 2], "công ty 1002 có 2 trang 500 dòng");
      const first = calls.find(c => c.companyId === 1002), spanDays = (Date.parse(first.to) - Date.parse(first.from)) / DAY;
      assert.ok(spanDays > 364.9 && spanDays < 365.1, "lần đầu lấy 365 ngày");
      assert.ok(rpcCalls.filter(c => c.name === "group_uid_moves_import").every(c => c.auth === "Bearer test-admin-token"), "RPC dùng phiên Admin, không dùng khóa ẩn danh");
      assert.equal(rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length, 3, "ghi mốc cho từng công ty");
      assert.equal(await page.locator("#gm-total").innerText(), String(total).replace(/\B(?=(\d{3})+(?!\d))/g, "."));
      assert.match(await page.locator("#gm-companies").innerText(), /Mastige.*Garment/);
      assert.equal(await page.locator("#gm-m-moves").innerText(), String(within30), "mặc định xem 30 ngày gần nhất");
      assert.equal(await page.locator("#gm-run").isEnabled(), true);

      assert.match(await page.locator("#gm-top-chips").innerText(), /\d+ lượt chuyển/, "chip tổng lượt chuyển trên thanh trên");
      if (width === 1280) {
        const rows = () => page.locator("#gm-body tr[data-ia-key], #gm-body tr").filter({ has: page.locator("code") });
        assert.equal(await page.locator("#gm-pager").innerText().then(t => t.includes(`/ ${within30}`)), true, "bảng phân trang 50 dòng");
        assert.equal(await rows().count(), 50);
        assert.equal(await page.locator("#gm-head th").count(), 6);
        assert.equal(await page.locator(".gm-table").evaluate(t => t.parentElement.scrollWidth <= t.parentElement.clientWidth), true, "bảng vừa khung, không cuộn ngang");
        const firstRow = await rows().first().innerText();
        assert.match(firstRow, /10282606\d{8}/);
        assert.match(firstRow, /4225\d{5}/, "có SKU ghép từ Group UID");
        assert.match(await page.locator("#gm-body").innerText(), /Còn ở đây/, "lượt chuyển mới nhất của UID: còn ở đây");
        const all = Object.values(wms).flat(), moved = r => all.some(o => o.group_uid_code === r.group_uid_code && Date.parse(o.moved_at) > Date.parse(r.moved_at));
        await page.locator('[data-as-facet="now"] .as-facet-btn').click();
        await page.locator(".as-opt", { hasText: "Đã chuyển tiếp" }).click();
        assert.equal((await page.locator("#gm-pager").innerText()).includes(`/ ${expected(r => Date.parse(r.moved_at) >= since(30) && moved(r))}`), true, "lọc Hiện tại: đã chuyển tiếp");
        assert.doesNotMatch(await page.locator("#gm-body").innerText(), /Còn ở đây/);
        assert.match(await page.locator("#gm-body").innerText(), /Đã chuyển tiếp/, "lượt cũ hơn của cùng UID: đã chuyển tiếp");
        await page.locator("[data-as-clear]").click();
        await page.locator("#gm-list-title").click();
        assert.equal(await page.locator(".as-facet-pop").count(), 0, "bấm ra ngoài đóng danh sách lọc");

        // --- Bộ lọc vị trí: Đến / Từ / Cả hai + nhãn Trả NCC ---
        const inRange = r => Date.parse(r.moved_at) >= since(30);
        await page.locator("#gm-loc").fill("f0-vr");
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => inRange(r) && r.to_location.toLowerCase().includes("f0-vr")));
        assert.match(await page.locator("#gm-body").innerText(), /Trả NCC/, "F0-VR-00-00-00-00 hiện nhãn Trả NCC");
        await page.locator('[data-gm-match="from"]').click();
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => inRange(r) && r.from_location.toLowerCase().includes("f0-vr")));
        await page.locator('[data-gm-match="any"]').click();
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => inRange(r) && (r.from_location + r.to_location).toLowerCase().includes("f0-vr")));
        await page.locator('[data-gm-match="to"]').click();
        await page.locator("#gm-loc").fill("503-02");
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => inRange(r) && r.to_location.includes("503-02")));
        assert.equal(await page.locator("#gm-m-locs").innerText(), "1", "chỉ một vị trí đích khớp");

        // --- Bộ lọc SKU + khoảng ngày + Kho (facet) ---
        await page.locator("#gm-loc").fill("");
        await page.locator("#gm-sku").fill("42250001");
        const skuRows = r => skuOf(r.group_uid_code).includes("42250001");
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => inRange(r) && skuRows(r)));
        assert.equal((await page.locator("#gm-body code").allInnerTexts()).every(c => skuOf(c.trim()).includes("42250001")), true);
        await page.locator("#gm-sku").fill("");
        await page.locator('[data-gm-range="7"]').click();
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => Date.parse(r.moved_at) >= since(7)));
        await page.locator('[data-gm-range="90"]').click();
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), expected(r => Date.parse(r.moved_at) >= since(90)));
        await page.locator('[data-gm-range="365"]').click();
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), total);
        assert.equal(await page.locator("#gm-from").inputValue() < await page.locator("#gm-to").inputValue(), true, "bộ chọn ngày hiện khoảng đang lọc");
        await page.locator("#gm-from").fill(new Date(NOW - 3 * DAY + 7 * 3600000).toISOString().slice(0, 10));
        await page.waitForFunction(() => document.querySelector('[data-gm-range][aria-pressed="true"]') === null);
        await page.locator("#gm-clear").click();
        await page.waitForFunction(n => document.getElementById("gm-m-moves").textContent === String(n), within30);
        assert.equal(await page.locator('[data-gm-range="30"]').getAttribute("aria-pressed"), "true", "Xóa bộ lọc về 30 ngày");

        await page.locator('[data-as-facet="wh"] .as-facet-btn').click();
        assert.equal(await page.locator(".as-opt").count(), 3, "lọc Kho: MTG Material, MTG Semi, Garment Material");
        await page.locator(".as-opt", { hasText: "GARMENT" }).click();
        assert.equal((await page.locator("#gm-pager").innerText()).includes(`/ ${expected(r => r.warehouse.includes("GARMENT") && inRange(r))}`), true);
        await page.locator("[data-as-clear]").click();
        await page.locator("#gm-list-title").click();
        assert.equal(await page.locator(".as-facet-pop").count(), 0, "bấm ra ngoài đóng danh sách lọc");

        // --- Sắp xếp, tìm không dấu, xuất CSV ---
        await page.locator('[data-as-sort="at"]').click();
        const asc = await page.locator("#gm-head th[aria-sort]").evaluateAll(list => list.find(th => th.querySelector('[data-as-sort="at"]')).getAttribute("aria-sort"));
        assert.equal(asc, "descending", "Thời điểm sắp mới nhất trước ngay lần bấm đầu");
        await page.locator("#gm-tools input").fill("tamlc");
        await page.waitForFunction(() => /\/ \d+/.test(document.getElementById("gm-pager").textContent));
        assert.equal((await page.locator("#gm-body .gm-by").allInnerTexts()).every(t => t === "tamlc"), true);
        await page.locator("#gm-tools input").fill("");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#gm-tools [data-as-export]").click()]);
        assert.equal(download.suggestedFilename().startsWith("lich-su-group-uid-"), true);
        const csv = fs.readFileSync(await download.path(), "utf8");
        assert.equal(csv.charCodeAt(0), 0xfeff);
        assert.equal(csv.trim().split(String.fromCharCode(13, 10)).length, within30 + 1, "tiêu đề + đủ dòng đang lọc");
        assert.equal(csv.split(String.fromCharCode(13, 10))[0].includes('"Đến vị trí"'), true);

        // --- Cảnh báo cắt bớt khi quá 5.000 dòng ---
        await page.locator("#gm-sku").fill("big");
        await page.waitForFunction(() => document.getElementById("gm-warn").textContent.includes("5.000"));
        assert.equal(await page.locator("#gm-m-sub").innerText(), "Hiển thị 0 / 7.000");
        await page.locator("#gm-sku").fill("");
        await page.waitForFunction(() => document.getElementById("gm-warn").hidden === true);

        // --- Đọc tăng dần: chỉ lấy phần mới, nạp chồng không nhân đôi ---
        await page.locator("#gm-run").click();
        await page.waitForFunction(() => /không có thay đổi/.test(document.getElementById("gm-status").textContent));
        const incremental = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE").slice(-3).map(c => c.payload));
        const lastTo = Date.parse(first.to), gap = Date.parse(incremental.find(c => c.companyId === 1002).from) - (lastTo - 30 * 60000);
        assert.ok(Math.abs(gap) < 120000, "lần sau lùi 30 phút từ mốc đọc trước");
        assert.equal(db.size, total, "đọc chồng không nhân đôi");
        await page.evaluate(id => window.__wms[1002].unshift({ history_id: id, group_uid_code: "1028260600009999", warehouse_id: 1177, warehouse: "WH - MATERIAL - MTG", action_code: 4, action_name: "Transfer location", from_location: "F0-KHO-501-01-01-01", to_location: "F0-KHO-HM-04-02-01", moved_by: "tamlc@hasaki.vn", moved_at: new Date().toISOString() }), 109999999);
        await page.locator("#gm-run").click();
        await page.waitForFunction(() => /1 mới, 0 cập nhật/.test(document.getElementById("gm-status").textContent));
        assert.equal(db.size, total + 1, "dòng mới được nạp");

        // --- Một công ty lỗi: các công ty còn lại vẫn nạp, có cảnh báo ---
        await page.evaluate(() => { window.__fail = 1005; });
        await page.locator("#gm-full").click();
        await page.waitForFunction(() => /công ty lỗi/.test(document.getElementById("gm-status").textContent));
        assert.match(await page.locator("#gm-warn").innerText(), /Garment.*không còn quyền/);
        assert.equal(rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").at(-1).args.p_company_id, 1002, "công ty lỗi không được ghi mốc đọc");
        await page.evaluate(() => { window.__fail = 0; window.__extCalls = []; });
        // Quay lại tab Đồng bộ: khung, nút và chip trên thanh trên trở lại như cũ
        await page.locator('[data-gu-main-tab="sync"]').click();
        assert.equal(await page.locator("#gu-run-incremental").isVisible(), true);
        assert.equal(await page.locator("#gu-panel-moves").isVisible(), false);
        assert.equal(await page.locator("#gu-top-refresh").isVisible(), true);
        assert.equal(await page.locator("#gm-top-chips").isVisible(), false);
        assert.equal(await page.locator("#group-uid-sync-screen .ss-top-sub").innerText(), "WMS → Supabase");
        assert.match(await page.locator("#gu-connection").innerText(), /sẵn sàng/, "chip kết nối WMS dùng chung hai tab");
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("group_uid_moves_browser: đọc WMS theo công ty, nạp tăng dần, lọc vị trí/SKU/ngày/kho, sắp xếp, CSV và responsive passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
