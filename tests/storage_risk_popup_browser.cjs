// RỦI RO LƯU TRỮ · pop-up nguồn (26/10/2026, docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md việc 2.2 + 2.4):
//   * Hàng chưa lên kệ: bấm dòng (kể cả ô SKU), Enter, Space mở pop-up nguồn của cặp SKU × vị trí — các lần chuyển vào (loại chuyển tiếng
//     Việt, số lượng, người, giờ, vị trí nguồn, Group UID hoặc "Group UID #id"), phiếu nhập gần nhất; nhánh "Không có nguồn trong lịch sử
//     đọc được" và "Chưa có dữ liệu nguồn"; nút sao chép SKU nằm trong pop-up (bấm SKU trên bảng không còn sao chép).
//   * UID tạm: bấm dòng, Enter, Space mở pop-up phiếu gốc — IT / ADJ / Lệnh sản xuất / không tìm thấy, các dòng cùng phiếu; mã trên bảng vẫn sao chép.
//   * Người ngoài Admin đọc bằng khoá công khai và thấy email đã che (máy chủ che, N1185); Admin đọc WMS thì nguồn Hàng chưa lên kệ lưu phần trước @.
//   * 390 px: pop-up không tràn ngang; rời màn thì pop-up đóng.
// Máy chủ tĩnh cổng 8000 (đổi bằng BASE); Supabase / Extension giả lập bằng dữ liệu giả (SKU 9000000xx, UID 1028260000000xxx).
//   node tests/storage_risk_popup_browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const DAY = 86400000;
const MTG = { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyName: "Cty Mastige" };
const GARMENT = { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyName: "Cty Garment" };
const wms = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const iso = ms => new Date(ms).toISOString();

// Bản chụp Kiểm kê có nguồn: đủ (chuyển vào + phiếu nhập), rỗng, chưa đọc, chỉ phiếu nhập.
const skuSnapshot = () => {
  const now = Date.now(), ago = d => now - d * DAY;
  const move = (type, qty, by, days, from, uidId, uid) => ({ kind: "move", type, qty, by, at: iso(ago(days)), from, uid, uidId });
  const rows = [
    { ...MTG, sku: "900000051", productName: "Vải nguồn đủ/Cotton", qty: 12, uom: "m", locations: [{ location: "F0-A0-00-00-00-00", qty: 12, modified: wms(ago(40)), created: wms(ago(60)), movesTotal: 25, sources: [
      move("EDIT_UID_GROUP", 1.5, "cat", 2, "F0-KHO-01-01-01-01", 7001, "1028260000000701"),
      move("", 2, "chuyen", 3, "F0-KHO-02-01-01-01", 7002, ""),
      move("XYZ_NEW", 1, "", 4, "F0-PO-00-00-00-00", null, ""),
      move("RE_PO", 3, "nhan", 5, "F0-PO-00-00-00-00", null, ""),
      { kind: "in", type: "PURCHASE_ORDER", code: "1001260000000040", mapping: "10012600000040", reason: "", by: "nhan", at: iso(ago(6)), qty: 50 },
    ] }] },
    { ...MTG, sku: "900000052", productName: "Dây không nguồn", qty: 5, uom: "m", locations: [{ location: "F0-AJ-00-00-00-00", qty: 5, modified: wms(ago(10)), sources: [] }] },
    { ...GARMENT, sku: "900000053", productName: "Sợi chưa đọc nguồn", qty: 3, uom: "cuộn", locations: [{ location: "F0-VR-00-00-00-00", qty: 3, modified: wms(ago(3)) }] },
    { ...MTG, sku: "900000054", productName: "Chỉ nhập ADJ", qty: 1, uom: "cuộn", locations: [{ location: "F0-IT-00-00-00-00", qty: 1, modified: wms(ago(1)), sources: [
      { kind: "in", type: "ADJUSTMENT", code: "1001260000000042", mapping: "100052600000042", reason: "Điều chỉnh kiểm kê", by: "kk", at: iso(ago(8)), qty: 2 },
    ] }] },
  ].map(r => ({ ...r, lastApprovedAt: null, lastApprovedBy: null }));
  return { run: { id: "run-1", readAt: new Date(now - 3600000).toISOString(), thresholdDays: 30, rowCount: rows.length, missing: [], warehouses: [MTG, GARMENT], sourceCounts: { stockRows: 4, approvedRows: 0, heldTotal: 0, held: [] } }, rows };
};
// Bản lưu UID tạm: phiếu gốc 3 loại + không tìm thấy. Máy chủ che origin.by / createdBy cho người ngoài Admin.
const tempSnapshot = admin => {
  const now = Date.now(), who = email => (admin ? email : email.split("@")[0]);
  const row = (sku, name, origin, mappingId, hours) => ({ wh: "mtg", warehouseName: MTG.warehouseName, sku, productName: name, qty: 2, sourceCode: `100126000000${sku.slice(-4)}`, mappingId, createdBy: who("api@example.test"), createdAt: iso(now - hours * 3600000), origin });
  return {
    run: { id: "tmp-1", readAt: new Date(now - 3600000).toISOString(), warehouses: [MTG], warn: [], scanned: 40, pages: 1, rangeDays: 90, rowCount: 4 },
    rows: [
      row("900000061", "Vải gốc IT", { type: "INTERNAL_TRANSFER", code: "1004260000000061", reason: "", by: who("duyet@example.test"), at: iso(now - 30 * 3600000), from: MTG.warehouseName, to: "KHO NHẬN GIẢ", lines: [{ sku: "900000061", qty: 25.5 }, { sku: "900000064", qty: 3 }] }, "1004260000000061", 2),
      row("900000062", "Vải gốc ADJ", { type: "ADJUSTMENT", code: "1004260000000062", reason: "Xuất test", by: who("kho@example.test"), at: iso(now - 40 * 3600000), from: MTG.warehouseName, to: "", lines: [{ sku: "900000062", qty: 8 }] }, "1004260000000062", 3),
      row("900000063", "Vải gốc lệnh SX", { type: "WORK_ORDER", code: "1004260000000063", reason: "", by: who("sx@example.test"), at: iso(now - 50 * 3600000), from: MTG.warehouseName, to: "XƯỞNG GIẢ", lines: [{ sku: "900000063", qty: 2 }] }, "1004260000000063", 4),
      row("900000065", "Vải không có phiếu gốc", null, "1004260000000065", 5),
    ],
    history: [],
  };
};

// Extension giả cho lượt Admin đọc WMS (sr-run): 1 cặp SKU × vị trí ảo, Import/Export có phiếu nhập, Transfer Location History có email đầy đủ.
const mockExtension = () => {
  window.__extCalls = [];
  addEventListener("message", event => {
    const r = event.data;
    if (!r || r.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: r.type, payload: r.payload });
    const now = Date.now(), wmsTime = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 19).replace("T", " "), p = r.payload || {};
    let data = { version: window.__extVersion || "0.12.1" }; // PING / PING_WMS; __extVersion giả lập Extension cũ
    if (r.type === "GET_SKU_COUNT_WAREHOUSES") data = { warehouses: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty Mastige" }], missingNames: [] };
    else if (r.type === "GET_SKU_COUNT_APPROVED_PAGE") data = { page: 1, size: 500, total: 0, totalPages: 1, rows: [] };
    else if (r.type === "GET_SKU_COUNT_INVENTORY_PAGE") data = { page: 1, size: 500, total: 1, totalPages: 1, rows: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "900000071", productName: "Vải đọc nguồn", location: "F0-A0-00-00-00-00", qty: 4, total: 4, modified: wmsTime(now - 12 * 86400000), created: wmsTime(now - 30 * 86400000), uom: "m" }] };
    else if (r.type === "GET_STOCK_IMPORT_EXPORT_PAGE") data = { page: 1, size: 500, total: 1, totalPages: 1, rows: [{ id: 9, warehouseId: 1177, sku: "900000071", kind: "in", qty: 4, sourceType: "PURCHASE_ORDER", sourceCode: "1001260000000071", mappingId: "10012600000071", reason: "", createdBy: "nhan@example.test", approvedBy: "duyet@example.test", createdAt: wmsTime(now - 20 * 86400000) }] };
    else if (r.type === "GET_TRANSFER_BIN_PAGE") data = { page: 1, size: p.size, total: 1, totalPages: 1, sourceRows: 1, rows: [{ id: 1, sku: p.sku, qty: 4, from: "F0-KHO-03-01-01-01", to: p.binIn, type: "EDIT_UID_GROUP", by: "cat@example.test", at: wmsTime(now - 12 * 86400000), uidId: 7101, uid: "1028260000000711" }] };
    postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok: true, data }, location.origin);
  });
  // Bộ nhớ tạm giả: ghi lại mọi lần sao chép
  window.__copied = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.__copied.push(text); } } });
};

const makeBackend = () => {
  const state = { sku: skuSnapshot(), pending: null, calls: [] };
  const handle = route => {
    const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1]?.replace(/_snapshot$/, "_overview");
    if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
    const body = JSON.parse(route.request().postData() || "{}"), admin = /test-admin-token/.test(route.request().headers().authorization || "");
    state.calls.push({ rpc, admin });
    if (rpc === "sku_count_overview") return json({ ok: true, data: state.sku });
    if (rpc === "uid_temp_overview") return json({ ok: true, data: tempSnapshot(admin) });
    if (rpc === "sku_count_save_start") { state.pending = { meta: body, rows: [] }; return json({ ok: true, data: { runId: "run-new" } }); }
    if (rpc === "sku_count_save_chunk") { state.pending.rows.push(...body.p_rows); return json({ ok: true, data: { saved: body.p_rows.length } }); }
    if (rpc === "sku_count_save_finish") {
      const p = state.pending; state.pending = null;
      state.sku = { run: { id: "run-new", readAt: new Date().toISOString(), thresholdDays: 30, rowCount: p.rows.length, missing: p.meta.p_missing, sourceCounts: p.meta.p_source_counts, warehouses: p.meta.p_warehouses },
        rows: p.rows.map(r => ({ warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, sku: r.sku, productName: r.product_name || "", qty: r.qty, uom: r.uom || "", locations: r.locations, lastApprovedAt: r.last_approved_at, lastApprovedBy: r.last_approved_by })) };
      return json({ ok: true, data: { runId: "run-new", rowCount: p.rows.length } });
    }
    if (rpc === "uid_temp_save") return json({ ok: true, data: { runId: "tmp-2", rowCount: (body.p_rows || []).length } });
    return json({ ok: true, data: [] });
  };
  return { state, handle };
};

const open = async (browser, { width = 1280, admin = false, view = "main", extVersion = "" } = {}) => {
  const backend = makeBackend(), context = await browser.newContext({ viewport: { width, height: 900 } });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  if (extVersion) await context.addInitScript(v => { window.__extVersion = v; }, extVersion);
  await context.addInitScript(v => localStorage.setItem("sr-tab-dang-mo", v), view);
  await context.addInitScript(mockExtension);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
  await page.goto(BASE + "#storage-risk");
  await page.locator("#storage-risk-screen").waitFor({ state: "visible" });
  return { backend, context, page, errors };
};
const isOpen = (page, id) => page.evaluate(id => Boolean(document.getElementById(id)?.open), id);
const closeDialog = async (page, id) => { await page.keyboard.press("Escape"); await page.waitForFunction(id => !document.getElementById(id).open, id); };
// Không tràn ngang: pop-up nằm trong khung nhìn và nội dung không rộng hơn pop-up.
const fits = (page, id) => page.evaluate(id => {
  const d = document.getElementById(id), r = d.getBoundingClientRect(), body = d.querySelector(".as-d-body");
  const wide = [...d.querySelectorAll("*")].filter(el => el.getBoundingClientRect().right > r.right + 1).map(el => el.className || el.tagName);
  return { left: r.left >= -1, right: r.right <= innerWidth + 1, scroll: body.scrollWidth <= body.clientWidth + 1, wide: wide.slice(0, 3) };
}, id);

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- 1) Hàng chưa lên kệ (người xem): bấm dòng / ô SKU / bàn phím mở pop-up nguồn ----
    for (const width of [1280, 390]) {
      const { backend, context, page, errors } = await open(browser, { width });
      await page.waitForFunction(() => document.getElementById("sr-total").textContent === "4");
      const row = sku => page.locator("#sr-body tr", { hasText: sku });
      // Bấm ô SKU: mở pop-up, không sao chép (Đ2)
      await row("900000051").locator("code").first().click();
      await page.waitForFunction(() => document.getElementById("sr-dialog")?.open === true);
      assert.deepEqual(await page.evaluate(() => window.__copied), [], `${width}px: bấm SKU trên bảng không sao chép nữa`);
      assert.equal(await page.locator("#sr-d-title").innerText(), "900000051");
      const body = await page.locator("#sr-dialog").innerText();
      for (const want of ["F0-A0-00-00-00-00", "Cắt / sửa Group UID", "Chuyển tay", "XYZ_NEW", "Nhập PO", "1028260000000701", "Group UID #7002", "F0-KHO-01-01-01-01", "cat", "chuyen", "Phiếu nhập gần nhất", "PO", "1001260000000040", "10012600000040", "25"]) assert.ok(body.includes(want), `${width}px: pop-up nguồn có "${want}"\n${body}`);
      assert.doesNotMatch(body, /@/, `${width}px: không có email đầy đủ`);
      assert.equal(await page.locator("#sr-dialog .sr-src").count(), 4, "4 lần chuyển vào");
      // Nút sao chép SKU trong pop-up
      await page.locator("#sr-d-copy").click();
      await page.waitForFunction(() => window.__copied.length === 1);
      assert.deepEqual(await page.evaluate(() => window.__copied), ["900000051"], "nút sao chép SKU trong pop-up");
      if (width === 390) {
        const f = await fits(page, "sr-dialog");
        assert.deepEqual([f.left, f.right, f.scroll], [true, true, true], `390px: pop-up không tràn ngang (${f.wide.join(", ")})`);
      }
      await closeDialog(page, "sr-dialog");
      // Nhánh rỗng, chưa đọc, chỉ phiếu nhập
      await row("900000052").locator("td").nth(2).click();
      await page.waitForFunction(() => document.getElementById("sr-dialog").open);
      assert.match(await page.locator("#sr-dialog").innerText(), /Không có nguồn trong lịch sử đọc được/);
      await closeDialog(page, "sr-dialog");
      await row("900000053").locator("td").nth(2).click();
      await page.waitForFunction(() => document.getElementById("sr-dialog").open);
      assert.match(await page.locator("#sr-dialog").innerText(), /Chưa có dữ liệu nguồn/);
      await closeDialog(page, "sr-dialog");
      await row("900000054").locator("td").nth(2).click();
      await page.waitForFunction(() => document.getElementById("sr-dialog").open);
      const only = await page.locator("#sr-dialog").innerText();
      assert.match(only, /Không có lần chuyển vào/, "không có lần chuyển vào nhưng có phiếu nhập");
      assert.match(only, /ADJ/); assert.match(only, /Điều chỉnh kiểm kê/);
      await closeDialog(page, "sr-dialog");
      // Bàn phím: Enter và Space trên dòng đang focus
      for (const key of ["Enter", " "]) {
        await row("900000052").focus();
        await page.keyboard.press(key === " " ? "Space" : key);
        await page.waitForFunction(() => document.getElementById("sr-dialog").open);
        assert.equal(await page.locator("#sr-d-title").innerText(), "900000052", `phím ${key === " " ? "Space" : key} mở pop-up`);
        await closeDialog(page, "sr-dialog");
      }
      assert.equal(await row("900000052").getAttribute("tabindex"), "0", "dòng nhận focus bằng Tab");
      assert.equal(await page.locator("#sr-head th").count(), 7, "không thêm cột");
      // Rời màn: pop-up đóng
      await row("900000051").locator("td").nth(2).click();
      await page.waitForFunction(() => document.getElementById("sr-dialog").open);
      await page.evaluate(() => { location.hash = "#home"; });
      await page.waitForFunction(() => !document.getElementById("sr-dialog").open);
      assert.deepEqual([...new Set(backend.state.calls.map(c => c.rpc))].filter(r => r !== "print_queue_status").sort(), ["sku_count_overview"], "người xem chỉ đọc bản chụp công khai");
      assert.ok(backend.state.calls.every(c => !c.admin), "người xem đọc bằng khoá công khai");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) UID tạm (người xem): phiếu gốc 3 loại + không tìm thấy; email người duyệt đã che ----
    for (const width of [1280, 390]) {
      const { backend, context, page, errors } = await open(browser, { width, view: "temp" });
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "4");
      const row = sku => page.locator("#srt-body tr", { hasText: sku });
      await row("900000061").locator("td").nth(3).click();
      await page.waitForFunction(() => document.getElementById("srt-dialog")?.open === true);
      assert.equal(await page.locator("#srt-d-title").innerText(), "900000061");
      const it = await page.locator("#srt-dialog").innerText();
      for (const want of ["IT", "1004260000000061", "KHO NHẬN GIẢ", "duyet", "900000064", "25,5", "Các dòng cùng phiếu"]) assert.ok(it.includes(want), `${width}px: phiếu gốc IT có "${want}"\n${it}`);
      assert.doesNotMatch(it, /@/, "người ngoài Admin không thấy email đầy đủ");
      if (width === 390) {
        const f = await fits(page, "srt-dialog");
        assert.deepEqual([f.left, f.right, f.scroll], [true, true, true], `390px: pop-up không tràn ngang (${f.wide.join(", ")})`);
      }
      await closeDialog(page, "srt-dialog");
      await row("900000062").locator("td").nth(3).click();
      await page.waitForFunction(() => document.getElementById("srt-dialog").open);
      const adj = await page.locator("#srt-dialog").innerText();
      assert.match(adj, /ADJ/); assert.match(adj, /Xuất test/); assert.match(adj, /1004260000000062/);
      await closeDialog(page, "srt-dialog");
      await row("900000063").locator("td").nth(3).click();
      await page.waitForFunction(() => document.getElementById("srt-dialog").open);
      const wo = await page.locator("#srt-dialog").innerText();
      assert.match(wo, /Lệnh sản xuất/); assert.match(wo, /XƯỞNG GIẢ/);
      await closeDialog(page, "srt-dialog");
      // Không tìm thấy phiếu gốc: Space trên dòng
      await row("900000065").focus();
      await page.keyboard.press("Space");
      await page.waitForFunction(() => document.getElementById("srt-dialog").open);
      const none = await page.locator("#srt-dialog").innerText();
      assert.match(none, /Không tìm thấy phiếu gốc/); assert.match(none, /1004260000000065/);
      await closeDialog(page, "srt-dialog");
      await row("900000062").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.getElementById("srt-dialog").open);
      assert.equal(await page.locator("#srt-d-title").innerText(), "900000062", "Enter mở pop-up");
      await closeDialog(page, "srt-dialog");
      // Mã trên bảng UID tạm vẫn bấm để sao chép, không mở pop-up
      await row("900000061").locator("td:nth-child(3) code").click();
      await page.waitForFunction(() => window.__copied.length === 1);
      assert.equal(await isOpen(page, "srt-dialog"), false, "bấm mã sao chép, không mở pop-up");
      assert.equal(await page.locator("#srt-head th").count(), 9, "không thêm cột");
      assert.ok(backend.state.calls.filter(c => c.rpc === "uid_temp_overview").every(c => !c.admin), "người xem đọc bằng khoá công khai");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3) Admin: UID tạm thấy email đầy đủ; đọc WMS (sr-run) lưu nguồn chỉ phần trước @ rồi pop-up hiện nguồn mới ----
    {
      const { backend, context, page, errors } = await open(browser, { admin: true, view: "temp" });
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "4");
      await page.locator("#srt-body tr", { hasText: "900000061" }).locator("td").nth(3).click();
      await page.waitForFunction(() => document.getElementById("srt-dialog").open);
      assert.match(await page.locator("#srt-dialog").innerText(), /duyet@example\.test/, "Admin thấy email đầy đủ (gửi phiên Admin)");
      await closeDialog(page, "srt-dialog");
      await page.locator("#srt-tab-main").click();
      await page.locator("#sr-run").click();
      await page.waitForFunction(() => /^Đã đồng bộ\./.test(document.getElementById("sr-status").textContent), null, { timeout: 20000 });
      await page.waitForFunction(() => !document.getElementById("sr-run").disabled, null, { timeout: 20000 });
      // Câu kết quả nêu số cặp đã đọc nguồn (review 26/10/2026); đủ cặp, không lý do → không cảnh báo
      assert.equal(await page.locator("#sr-status").innerText(), "Đã đồng bộ. 1 dòng chưa lên kệ · nguồn 1/1 cặp.");
      assert.equal(await page.locator("#sr-status").getAttribute("data-tone") || "", "", "đủ nguồn: không cảnh báo");
      const saved = backend.state.sku.rows.find(r => r.sku === "900000071").locations[0];
      assert.deepEqual(saved.sources.map(s => [s.kind, s.by]), [["move", "cat"], ["in", "duyet"]], "nguồn lưu phần trước @ (bản chụp ai cũng xem)");
      const calls = await page.evaluate(() => window.__extCalls.map(c => c.type));
      assert.equal(calls.filter(t => t === "GET_STOCK_IMPORT_EXPORT_PAGE").length, 1, "Import/Export đọc một lần cho cả Kiểm kê và UID tạm");
      assert.equal(calls.filter(t => t === "GET_TRANSFER_BIN_PAGE").length, 1, "một lời gọi cho một cặp SKU × vị trí ảo");
      await page.locator("#sr-body tr", { hasText: "900000071" }).locator("td").nth(2).click();
      await page.waitForFunction(() => document.getElementById("sr-dialog").open);
      const text = await page.locator("#sr-dialog").innerText();
      for (const want of ["Cắt / sửa Group UID", "1028260000000711", "F0-KHO-03-01-01-01", "cat", "1001260000000071"]) assert.ok(text.includes(want), `pop-up sau khi đọc có "${want}"\n${text}`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 4) Admin với Extension < 0.12.0 (cầu nối cũ im lặng với GET_TRANSFER_BIN_PAGE tới hết 30 giây): kiểm PING_WMS rồi bỏ bước nguồn
    //      ngay, Kiểm kê vẫn lưu (không có nguồn), câu kết quả cảnh báo số cặp + lý do (review 26/10/2026) ----
    {
      const { backend, context, page, errors } = await open(browser, { admin: true, extVersion: "0.11.0" });
      await page.waitForFunction(() => document.getElementById("sr-total").textContent === "4");
      const started = Date.now();
      await page.locator("#sr-run").click();
      await page.waitForFunction(() => /^Đã đồng bộ\./.test(document.getElementById("sr-status").textContent), null, { timeout: 20000 });
      assert.ok(Date.now() - started < 15000, "không chờ hết giờ của lệnh mới");
      assert.equal(await page.locator("#sr-status").innerText(), "Đã đồng bộ. 1 dòng chưa lên kệ · nguồn 0/1 cặp: cần Extension ≥ 0.12.0.");
      assert.equal(await page.locator("#sr-status").getAttribute("data-tone"), "warn", "thiếu nguồn: cảnh báo, không phải lỗi");
      const calls = await page.evaluate(() => window.__extCalls.map(c => c.type));
      assert.ok(calls.includes("PING_WMS"), "kiểm phiên bản Extension trước khi đọc nguồn");
      assert.equal(calls.includes("GET_TRANSFER_BIN_PAGE"), false, "Extension cũ: không gửi lệnh đọc chuyển vị trí");
      assert.equal("sources" in backend.state.sku.rows.find(r => r.sku === "900000071").locations[0], false, "cặp chưa đọc không có khoá sources");
      await page.waitForFunction(() => !document.getElementById("sr-run").disabled, null, { timeout: 20000 });
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("storage_risk_popup_browser: Hàng chưa lên kệ bấm dòng/SKU/Enter/Space mở pop-up nguồn (loại chuyển tiếng Việt, Group UID #id, phiếu nhập, nhánh rỗng / chưa đọc, sao chép SKU trong pop-up), UID tạm phiếu gốc IT/ADJ/Lệnh sản xuất/không tìm thấy, che email người ngoài Admin, Admin đọc WMS lưu phần trước @ + câu kết quả nêu số cặp có nguồn, Extension < 0.12.0 bỏ bước nguồn ngay (cảnh báo), 390px không tràn, rời màn đóng pop-up passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
