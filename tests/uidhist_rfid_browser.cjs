// LỊCH SỬ GROUP UID · Tiến độ dán A5000 (28/10/2026): công tắc Chuyển vị trí | Tiến độ A5000, mỗi dãy kệ một lưới khoang × tầng, mỗi ô là một bin
// có % UID đã dán A5000 (xong = mọi UID tồn của bin có A5000; A3000 là mã cũ, chưa tính xong). Ai cũng xem, khoá ẩn danh, không phiên Admin.
// Supabase giả lập đúng khoá của hàm group_uid_rfid_progress (supabase/rfid_progress_v1.sql, mẫu dạng đã đối chiếu bằng SELECT chỉ đọc 28/10/2026);
// bin giả F0-KHO-501-01-01-01…, Group UID giả 1028260000000xxx, không dữ liệu thật.
// Bấm một ô → pop-up Group UID của bin chưa dán A5000 (RPC group_uid_rfid_bin_uids: chưa dán trước, mã cũ A3000 sau; tìm / lọc / Excel).
//   node tests/uidhist_rfid_browser.cjs   (máy chủ tĩnh cổng 8000, đổi bằng BASE)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { readXlsx } = require("./xlsx_read.cjs");
const path = require("node:path");

let AXE = null;
try { AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(__dirname, "..")] }); } catch (_) { /* chưa npm install: bỏ qua phần axe (a11y_axe_browser cũng yêu cầu axe-core) */ }
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SHOTS = process.env.SHOTS || "";   // thư mục ghi ảnh chụp 375 / 1280 (tuỳ chọn)
const NOW = Date.now(), MIN = 60000, DAY = 86400000;
const bin = (location, total, done, other = 0) => ({ location, total, done, other });
const rack = (name, bins) => ({ rack: name, total: bins.reduce((n, b) => n + b.total, 0), done: bins.reduce((n, b) => n + b.done, 0), other: bins.reduce((n, b) => n + b.other, 0), bins });
const wh = (name, warehouse, racks) => ({ name, warehouse, total: racks.reduce((n, r) => n + r.total, 0), done: racks.reduce((n, r) => n + r.done, 0), other: racks.reduce((n, r) => n + r.other, 0), racks });
const data = (syncedAt = new Date(NOW - 5 * MIN).toISOString()) => ({
  prefix: "A5000", otherPrefixes: ["A3000"], syncedAt, fullAt: new Date(NOW - 8 * 3600000).toISOString(),
  warehouses: [
    wh("MTG", "WH - MATERIAL - MTG", [
      rack("501", [bin("F0-KHO-501-01-01-01", 12, 12), bin("F0-KHO-501-02-01-01", 12, 11, 1), bin("F0-KHO-501-03-01-01", 10, 0, 4), bin("F0-KHO-501-01-02-01", 8, 0), bin("F0-KHO-501-03-02-01", 250, 249)]),
      rack("507A", [bin("F0-KHO-507A-03-01-01", 5, 5)]),
      rack("HM", [bin("F0-KHO-HM-01-01-01", 3, 3), bin("F0-KHO-HM-01-01-02", 2, 1)]),
    ]),
    wh("GARMENT", "WH - MATERIAL - GARMENT", [rack("501", [bin("F0-KHO-501-11-01-01", 10, 10), bin("F0-KHO-501-12-01-01", 10, 5)])]),
  ],
});

// Group UID chưa dán A5000 của các bin được hỏi: bin có `other` UID mang mã cũ (A3000 + 7 số), còn lại chưa có RFID
const fakeBinReply = args => {
  const w = data().warehouses.find(x => x.name === args.p_warehouse), bins = w.racks.flatMap(r => r.bins).filter(b => args.p_locations.includes(b.location)), items = [];
  let seq = 0;
  for (const b of bins) {
    const left = b.total - b.done;
    for (let i = 0; i < left; i++) {
      const old = i >= left - b.other; seq++;
      items.push({ groupUid: `1028260000000${String(seq).padStart(3, "0")}`, location: b.location, sku: "900000001", lot: "L1", roll: String(i + 1), qty: 100 + i, status: "Available",
        rfid: old ? `A3000${String(seq).padStart(7, "0")}` : null, state: old ? "old" : "none", updatedAt: new Date(NOW - 3600000).toISOString() });
    }
  }
  items.sort((a, b) => (a.state === "old") - (b.state === "old") || a.location.localeCompare(b.location) || a.groupUid.localeCompare(b.groupUid));
  return { warehouse: args.p_warehouse, locations: args.p_locations, total: bins.reduce((n, b) => n + b.total, 0), done: bins.reduce((n, b) => n + b.done, 0), open: items.length, items, limit: 500, truncated: false };
};

async function open(browser, width, opts = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage(), errors = [], calls = [], binCalls = [], state = { fail: false, binFail: false, payload: opts.payload || data() };
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  await page.route("**/*", route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    const name = /\/rest\/v1\/rpc\/([a-z_0-9]+)/.exec(url)?.[1];
    if (name === "group_uid_rfid_progress") {
      calls.push({ body: route.request().postData(), auth: route.request().headers().authorization });
      return state.fail ? json({ message: "mất mạng giả" }, 503) : json({ ok: true, data: state.payload, meta: { updatedAt: new Date(NOW).toISOString(), schemaVersion: 1 } });
    }
    if (name === "group_uid_rfid_bin_uids") {
      const args = JSON.parse(route.request().postData() || "{}");
      binCalls.push({ args, auth: route.request().headers().authorization });
      return state.binFail ? json({ message: "mất mạng giả" }, 503) : json({ ok: true, data: fakeBinReply(args), meta: { updatedAt: new Date(NOW).toISOString(), schemaVersion: 1 } });
    }
    if (name === "group_uid_moves_overview") return json({ ok: true, data: { total: 0, firstAt: null, lastAt: null, lastReadAt: null, warehouses: [] } });
    if (name === "group_uid_moves_lookup") return json({ ok: true, data: { items: [], total: 0, limit: 1000, truncated: false } });
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
  return { context, page, errors, calls, binCalls, state };
}
const shot = async (page, name) => { if (!SHOTS) return; await page.screenshot({ path: path.join(SHOTS, name), fullPage: true }); await page.evaluate(() => scrollTo(0, 0)); await page.screenshot({ path: path.join(SHOTS, name.replace(/\.png$/, "-top.png")) }); };
const texts = (page, selector) => page.locator(selector).allInnerTexts().then(list => list.map(t => t.replace(/\s+/g, " ").trim()));
const kpi = (page, key) => page.locator(`#uh-rfid-kpi [data-k="${key}"] strong`).innerText();
const cell = (page, rackName, key) => page.locator(`.uh-cell[data-rack="${rackName}"][data-key="${key}"]`).first();

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [375, 1280]) {
      const mobile = width <= 760;
      const { context, page, errors, calls, binCalls, state: fake } = await open(browser, width);
      await page.goto(BASE + "#group-uid-history");
      await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      // --- Mặc định vẫn là lịch sử chuyển vị trí; phần Tiến độ chưa gọi hàm ---
      assert.equal(await page.locator("#uidhist-screen").getAttribute("data-uh-view"), "move");
      assert.equal(await page.locator("#uh-rfid").isVisible(), false, "mặc định chưa hiện Tiến độ A5000");
      assert.equal(await page.locator(".uh-search").isVisible(), true, "mặc định hiện ô tìm lịch sử");
      assert.equal(calls.length, 0, "chưa mở Tiến độ thì chưa gọi group_uid_rfid_progress");
      assert.deepEqual(await texts(page, ".uh-views .as-tag"), ["Chuyển vị trí", "Tiến độ A5000"]);
      for (const b of await page.locator(".uh-views .as-tag").all()) assert.ok((await b.boundingBox()).height >= 44, "công tắc xem ≥ 44px");

      await shot(page, `move-${width}.png`);
      // --- Mở Tiến độ A5000 ---
      await page.locator('[data-uh-view="rfid"]').click();
      await page.locator("#uh-rfid .uh-rack").first().waitFor();
      assert.equal(calls.length, 1, "mở Tiến độ gọi hàm đúng một lần");
      const publishable = await page.evaluate(() => window.PrintSkuQueue.publishableKey);
      assert.equal(calls[0].auth, `Bearer ${publishable}`, "xem bằng khoá ẩn danh, không dùng phiên Admin");
      assert.equal(calls[0].body, "{}", "hàm không tham số");
      assert.equal(await page.locator("#uidhist-screen").getAttribute("data-uh-view"), "rfid");
      for (const sel of ["#uh-strip", ".uh-search", ".uh-metrics"]) assert.equal(await page.locator(sel).isVisible(), false, `${sel} ẩn ở Tiến độ A5000`);
      assert.equal(await page.evaluate(() => localStorage.getItem("uh-view-v1")), "rfid", "nhớ chế độ xem theo máy");
      assert.equal(await page.locator("#uidhist-screen .uid-topbar__name span").innerText(), "Tiến độ A5000", "phụ đề thanh trên theo chế độ xem");
      assert.deepEqual(await texts(page, "#uh-rfid-wh .as-tag"), ["MTG 93%", "GARMENT 75%"], "công tắc kho kèm % hoàn thành");
      // Số liệu MTG: 302 UID, 281 A5000 (93%), 5 A3000, 16 chưa dán; ô xong 2/7 (501: 5 ô, 507A: 1 ô, HM: 1 ô gộp 2 bin)
      assert.equal(await kpi(page, "pct"), "93%");
      assert.equal(await kpi(page, "cells"), "2 / 7");
      assert.equal(await kpi(page, "done"), "281");
      assert.equal(await kpi(page, "old"), "5");
      assert.equal(await kpi(page, "none"), "16");
      assert.equal((await texts(page, '#uh-rfid-kpi [data-k="old"] span'))[0], "Còn mã A3000");
      assert.deepEqual(await texts(page, "#uh-rfid-legend li"), ["100% A5000", "Đang dán", "Còn mã A3000", "Chưa dán", "Trống"]);
      // Dãy theo thứ tự máy chủ trả (số tăng dần rồi dãy chữ — thứ tự này do SQL xếp, kiểm ở rfid_progress_sql)
      assert.deepEqual(await texts(page, ".uh-rack h2"), ["Dãy 501", "Dãy 507A", "Dãy HM"]);
      assert.equal((await texts(page, ".uh-rack__meta"))[0], "5 ô · 1 trống · 3 khoang × 2 tầng");
      assert.equal((await texts(page, ".uh-rack__sum"))[0], "93% 272/292", "tổng dãy 501: 272/292 = 93%");
      // Lưới: tầng cao ở trên, khoang tăng dần; ô trống nét đứt
      assert.deepEqual(await texts(page, ".uh-rack:nth-of-type(1) .uh-grid__axis"), ["T02", "T01", "K01", "K02", "K03"]);
      assert.equal(await page.locator('.uh-rack:nth-of-type(1) .uh-cell[data-state="empty"]').count(), 1, "dãy 501 có đúng 1 ô trống (khoang 02 · tầng 02)");
      const state = async (r, key) => ({ state: await cell(page, r, key).getAttribute("data-state"), text: (await cell(page, r, key).innerText()).replace(/\s+/g, " ").trim() });
      assert.deepEqual(await state("501", "1|1"), { state: "full", text: "01·01 100%" });
      assert.deepEqual(await state("501", "2|1"), { state: "part", text: "02·01 92%" });
      assert.deepEqual(await state("501", "3|1"), { state: "old", text: "03·01 0%" }, "chỉ có mã cũ A3000, chưa có A5000");
      assert.deepEqual(await state("501", "1|2"), { state: "none", text: "01·02 0%" });
      assert.deepEqual(await state("501", "3|2"), { state: "part", text: "03·02 99%" }, "249/250 = 99,6% hiện 99%, không làm tròn lên 100%");
      assert.deepEqual(await state("HM", "1|1"), { state: "part", text: "01·01 80%" }, "hai bin cùng khoang + tầng (ô 01, 02) gộp một ô");
      assert.equal(await cell(page, "501", "2|1").getAttribute("aria-label"), "02·01 92% · dãy 501 · khoang 02 · tầng 01 · 11/12 UID", "tên truy cập bắt đầu bằng chữ hiện trên ô (axe label-content-name-mismatch)");
      // Bấm ô → pop-up Group UID chưa dán A5000 của bin (một bin: 11/12 đã dán, còn 1 UID mang mã cũ A3000)
      const dialog = page.locator("#uh-rfid-dialog"), closeDialog = () => dialog.locator("[data-as-close]").first().click().then(() => dialog.waitFor({ state: "hidden" }));
      const bodyRows = () => page.locator("#uh-rfid-body tr:not(:has(.ss-empty))");
      await cell(page, "501", "2|1").click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll("#uh-rfid-body tr:not(:has(td.ss-empty))").length > 0);
      assert.equal(binCalls.length, 1);
      assert.deepEqual(binCalls[0].args, { p_warehouse: "MTG", p_locations: ["F0-KHO-501-02-01-01"] });
      assert.equal(binCalls[0].auth, `Bearer ${publishable}`, "pop-up đọc bằng khoá ẩn danh");
      assert.equal(await page.locator("#uh-rfid-d-title").innerText(), "F0-KHO-501-02-01-01");
      assert.equal(await page.locator("#uh-rfid-sum").innerText(), "11/12 UID đã dán A5000 · còn 1");
      assert.equal(await page.locator("#uh-rfid-head th").count(), 7, "một bin: 7 cột, không cột Bin");
      assert.deepEqual(await texts(page, "#uh-rfid-body tr"), ["1028260000000001 Mã cũ A30000000001 900000001 L1 1 100"]);
      assert.equal(await page.locator("#uh-rfid-body code[data-copy]").count(), 2, "Group UID và RFID bấm để sao chép");
      if (mobile) assert.ok(await dialog.evaluate(d => d.scrollWidth <= d.clientWidth + 1), "pop-up không tràn ngang ở 375px");
      await closeDialog();
      // Bin chưa dán nhiều: 10 UID, 6 chưa có RFID (trước) rồi 4 mã cũ (sau); chip lọc theo tình trạng
      await cell(page, "501", "3|1").click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll("#uh-rfid-body tr:not(:has(td.ss-empty))").length === 10);
      assert.equal(await page.locator("#uh-rfid-sum").innerText(), "0/10 UID đã dán A5000 · còn 10");
      assert.deepEqual(await texts(page, "#uh-rfid-body .as-chip"), [...Array(6).fill("Chưa dán"), ...Array(4).fill("Mã cũ")], "chưa dán trước, mã cũ sau");
      // Xuất Excel: đủ 10 UID chưa dán, mã 16 số giữ nguyên dạng chữ
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#uh-rfid-tools [data-as-export]").click()]);
      assert.match(download.suggestedFilename(), /^chua-dan-a5000-F0-KHO-501-03-01-01.*\.xlsx$/);
      const { table } = readXlsx(fs.readFileSync(await download.path()));
      assert.deepEqual(table[0], ["Group UID", "Tình trạng", "RFID", "SKU", "Lot", "Roll", "Số lượng", "Vị trí", "Trạng thái WMS", "Cập nhật"]);
      assert.equal(table.length, 11, "đầu bảng + 10 UID");
      assert.deepEqual(table[1].slice(0, 5), ["1028260000000001", "Chưa dán", "", "900000001", "L1"]);
      assert.deepEqual(table[10].slice(0, 3), ["1028260000000010", "Mã cũ", "A30000000010"]);
      await page.locator('#uh-rfid-tags [data-as-tag="old"]').click();
      assert.equal(await bodyRows().count(), 4, "lọc Mã cũ còn 4 UID");
      assert.ok((await texts(page, "#uh-rfid-body tr")).every(t => /A3000\d{7}/.test(t)));
      await closeDialog();
      // Ô gộp hai bin (cùng khoang + tầng): tên pop-up theo dãy, thêm cột Bin
      await cell(page, "HM", "1|1").click();
      await dialog.waitFor({ state: "visible" });
      await page.waitForFunction(() => document.querySelectorAll("#uh-rfid-body tr:not(:has(td.ss-empty))").length > 0);
      assert.deepEqual(binCalls.at(-1).args, { p_warehouse: "MTG", p_locations: ["F0-KHO-HM-01-01-01", "F0-KHO-HM-01-01-02"] });
      assert.equal(await page.locator("#uh-rfid-d-title").innerText(), "Dãy HM · khoang 01 · tầng 01");
      assert.equal(await page.locator("#uh-rfid-sum").innerText(), "4/5 UID đã dán A5000 · còn 1");
      assert.equal(await page.locator("#uh-rfid-head th").count(), 8, "ô gộp nhiều bin có cột Bin");
      assert.match((await texts(page, "#uh-rfid-body tr"))[0], /F0-KHO-HM-01-01-02$/);
      await closeDialog();
      // Bin đã dán đủ: danh sách rỗng, nói rõ
      await cell(page, "501", "1|1").click();
      await dialog.waitFor({ state: "visible" });
      await page.locator("#uh-rfid-body .ss-empty").filter({ hasText: "Mọi UID của bin đã dán A5000." }).waitFor();
      assert.equal(await page.locator("#uh-rfid-sum").innerText(), "12/12 UID đã dán A5000");
      await closeDialog();
      // Lỗi tải danh sách: báo + Thử lại, rồi tải được
      fake.binFail = true;
      await cell(page, "501", "2|1").click();
      await page.locator('#uh-rfid-sum[data-tone="error"]').waitFor();
      assert.match(await page.locator("#uh-rfid-sum").innerText(), /^Không tải được danh sách UID: /);
      assert.equal(await page.locator("#uh-rfid-sum .ps-retry").count(), 1, "có nút Thử lại");
      fake.binFail = false;
      await page.locator("#uh-rfid-sum .ps-retry").click();
      await page.waitForFunction(() => document.querySelectorAll("#uh-rfid-body tr:not(:has(td.ss-empty))").length === 1);
      assert.equal(await page.locator("#uh-rfid-sum").getAttribute("data-tone"), null, "tải được thì hết báo lỗi");
      await closeDialog();
      assert.equal(await page.locator(".uh-rack__sel").count(), 0, "không còn dòng chọn ô (đã thay bằng pop-up)");
      // Lọc ô
      await page.locator('[data-uh-rfid-filter="open"]').click();
      assert.equal(await cell(page, "501", "1|1").getAttribute("data-dim"), "true", "Chưa xong: ô đã xong 100% bị mờ");
      assert.equal(await cell(page, "501", "2|1").getAttribute("data-dim"), null);
      await page.locator('[data-uh-rfid-filter="done"]').click();
      assert.equal(await cell(page, "501", "1|1").getAttribute("data-dim"), null);
      assert.equal(await cell(page, "501", "2|1").getAttribute("data-dim"), "true", "Đã xong: ô chưa xong bị mờ");
      await page.locator('[data-uh-rfid-filter="all"]').click();
      assert.equal(await page.locator('.uh-cell[data-dim="true"]').count(), 0);
      // axe-core cho khung Tiến độ: đủ bốn màu trạng thái + ô trống + ô được chọn, rồi bộ lọc làm mờ ô (tương phản chữ ở ô mờ)
      if (AXE) {
        await page.addScriptTag({ path: AXE });
        const scan = tag => page.evaluate(async tags => (await axe.run(document.getElementById("uh-rfid"), { runOnly: { type: "tag", values: tags } })).violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`), TAGS);
        assert.deepEqual(await scan(), [], `${width}px: axe lỗi ở khung Tiến độ`);
        await page.locator('[data-uh-rfid-filter="open"]').click();
        assert.deepEqual(await scan(), [], `${width}px: axe lỗi khi lọc Chưa xong (ô mờ)`);
        await page.locator('[data-uh-rfid-filter="all"]').click();
        await cell(page, "501", "3|1").click();
        await page.waitForFunction(() => document.querySelectorAll("#uh-rfid-body tr:not(:has(td.ss-empty))").length === 10);
        const scanDialog = await page.evaluate(async tags => (await axe.run(document.getElementById("uh-rfid-dialog"), { runOnly: { type: "tag", values: tags } })).violations.map(v => `${v.id}: ${v.nodes.slice(0, 3).map(n => n.target.join(" ")).join(" | ")}`), TAGS);
        assert.deepEqual(scanDialog, [], `${width}px: axe lỗi ở pop-up UID chưa dán`);
        await shot(page, `rfid-${width}-dialog.png`);
        await closeDialog();
      }
      // Giờ cập nhật (bản chụp mới, không cảnh báo)
      assert.match(await page.locator("#uh-rfid-time").innerText(), /^Cập nhật \d{2}:\d{2} \d{2}\/\d{2} · 5 phút trước$/);
      assert.notEqual(await page.locator("#uh-rfid-time").getAttribute("data-tone"), "warn");
      assert.match(await page.locator("#uh-rfid-time").getAttribute("title"), /^Đối chiếu toàn bộ gần nhất \d{2}:\d{2} \d{2}\/\d{2}$/);
      await shot(page, `rfid-${width}-mtg.png`);
      // Đổi kho: không gọi lại hàm, nhớ kho theo máy
      await page.locator('[data-uh-rfid-wh="GARMENT"]').click();
      assert.equal(calls.length, 1, "đổi kho không gọi lại");
      assert.equal(await kpi(page, "pct"), "75%");
      assert.deepEqual(await texts(page, ".uh-rack__meta"), ["2 ô · 2 khoang × 1 tầng"]);
      assert.deepEqual(await texts(page, ".uh-grid__axis"), ["T01", "K11", "K12"], "khoang Garment đánh số từ 11, không ép từ 01");
      assert.equal(await page.evaluate(() => localStorage.getItem("uh-rfid-wh-v1")), "GARMENT");
      await shot(page, `rfid-${width}-garment.png`);
      // Cỡ vùng bấm + không tràn ngang trang
      const small = await page.evaluate(() => [...document.querySelectorAll("#uh-rfid button, #uh-rfid .uh-cell[data-key]")].filter(b => b.getClientRects().length).map(b => { const r = b.getBoundingClientRect(); return [b.className || b.id, Math.round(r.width), Math.round(r.height)]; }).filter(([, w, h]) => h < 44 || w < 44));
      assert.deepEqual(small, [], `${width}px: vùng bấm < 44px`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${width}px: trang không được tràn ngang`);
      // Về Chuyển vị trí rồi vào lại trong 2 phút: không gọi lại
      await page.locator('[data-uh-view="move"]').click();
      assert.equal(await page.locator("#uh-rfid").isVisible(), false);
      assert.equal(await page.locator(".uh-search").isVisible(), true, "lịch sử chuyển vị trí trở lại");
      assert.equal(await page.evaluate(() => localStorage.getItem("uh-view-v1")), "move");
      assert.equal(await page.locator("#uidhist-screen .uid-topbar__name span").innerText(), "Chuyển vị trí");
      await page.locator('[data-uh-view="rfid"]').click();
      assert.equal(calls.length, 1, "vào lại trong 2 phút dùng bản đã tải");
      // Tải lại trang: nhớ chế độ xem + kho
      await page.reload();
      await page.locator("#uh-rfid .uh-rack").first().waitFor();
      assert.equal(await page.locator('#uh-rfid-wh [aria-pressed="true"] span').innerText(), "GARMENT");
      assert.equal(calls.length, 2, "trang mới tải lại hàm một lần");
      // Nút tải lại
      await page.locator("#uh-rfid-reload").click();
      await page.waitForFunction(() => !document.getElementById("uh-rfid-reload").disabled);
      assert.equal(calls.length, 3);
      assert.deepEqual(errors, [], `${width}px: không lỗi console`);
      await context.close();

      // --- Bản chụp cũ > 24 giờ: cảnh báo vàng ---
      const old = await open(browser, width, { payload: data(new Date(NOW - 3 * DAY).toISOString()) });
      await old.page.addInitScript(() => localStorage.setItem("uh-view-v1", "rfid"));
      await old.page.goto(BASE + "#group-uid-history");
      await old.page.locator("#uh-rfid .uh-rack").first().waitFor();
      assert.equal(await old.page.locator("#uh-rfid-time").getAttribute("data-tone"), "warn");
      assert.match(await old.page.locator("#uh-rfid-time").innerText(), /· 3 ngày trước$/);
      await old.context.close();

      // --- Lỗi tải: báo + Thử lại, rồi tải được ---
      const bad = await open(browser, width);
      bad.state.fail = true;
      await bad.page.addInitScript(() => localStorage.setItem("uh-view-v1", "rfid"));
      await bad.page.goto(BASE + "#group-uid-history");
      await bad.page.locator('#uh-rfid-msg[data-tone="error"]').waitFor();
      assert.match(await bad.page.locator("#uh-rfid-msg").innerText(), /^Không tải được tiến độ A5000: /);
      assert.equal(await bad.page.locator("#uh-rfid-msg .ps-retry").count(), 1, "có nút Thử lại cho lần tải");
      assert.equal(await bad.page.locator("#uh-rfid .uh-rack").count(), 0);
      bad.state.fail = false;
      await bad.page.locator("#uh-rfid-msg .ps-retry").click();
      await bad.page.locator("#uh-rfid .uh-rack").first().waitFor();
      assert.equal(await bad.page.locator("#uh-rfid-msg").innerText(), "", "tải được thì xoá báo lỗi");
      assert.equal(await kpi(bad.page, "pct"), "93%");
      assert.deepEqual(bad.errors, []);
      await bad.context.close();
    }
    // --- Kho chưa có UID trên kệ ---
    const empty = await open(browser, 1280, { payload: { prefix: "A5000", otherPrefixes: [], syncedAt: null, fullAt: null, warehouses: [wh("MTG", "WH - MATERIAL - MTG", []), wh("GARMENT", "WH - MATERIAL - GARMENT", [])] } });
    await empty.page.addInitScript(() => localStorage.setItem("uh-view-v1", "rfid"));
    await empty.page.goto(BASE + "#group-uid-history");
    await empty.page.locator(".uh-rfid__empty").waitFor();
    assert.equal(await kpi(empty.page, "pct"), "0%");
    assert.equal((await texts(empty.page, ".uh-rfid__empty"))[0], "Chưa có UID trên kệ MTG.");
    assert.equal(await empty.page.locator("#uh-rfid-time").innerText(), "Chưa có dữ liệu");
    assert.equal((await texts(empty.page, '#uh-rfid-kpi [data-k="old"] span'))[0], "Còn mã cũ", "không có tiền tố mã khác thì ghi chung Còn mã cũ");
    assert.deepEqual(empty.errors, []);
    await empty.context.close();
    console.log("uidhist_rfid_browser: công tắc xem, lưới khoang × tầng, % theo bin (A5000 xong, A3000 mã cũ), lọc, chọn ô, nhớ kho / chế độ, lỗi + Thử lại, 375 + 1280 passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
