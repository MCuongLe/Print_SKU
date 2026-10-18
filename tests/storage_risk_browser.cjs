// RỦI RO LƯU TRỮ · Hàng chưa lên kệ (#storage-risk): mọi người xem bản chụp Kiểm kê đã lưu, chỉ Admin đồng bộ từ WMS.
// Chạy với python -m http.server 8000; WMS/Extension/Supabase đều giả lập bằng dữ liệu tổng hợp, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const DAY = 86400000;
const MTG = { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyName: "Cty Mastige" };
const GARMENT = { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyName: "Cty Garment" };
// Giờ WMS (+07:00) dạng "YYYY-MM-DD HH:mm:ss" cho một mốc thời gian tuyệt đối.
const wms = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 19).replace("T", " ");

const mockExtension = () => addEventListener("message", async event => {
  const r = event.data;
  if (!r || r.source !== "PRINT_SKU_APP") return;
  if (window.__hold && r.type === "GET_SKU_COUNT_WAREHOUSES") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
  const now = Date.now(), wmsTime = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 19).replace("T", " ");
  let data;
  if (r.type === "PING_WMS") data = { version: "0.8.1" };
  else if (r.type === "GET_SKU_COUNT_WAREHOUSES") data = { warehouses: [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty Mastige" },
    { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyId: 1005, companyName: "Cty Garment" },
  ], missingNames: [] };
  else if (r.type === "GET_SKU_COUNT_APPROVED_PAGE") data = { page: 1, size: 500, total: 0, totalPages: 1, rows: [] };
  else if (r.type === "GET_SKU_COUNT_INVENTORY_PAGE") data = r.payload.warehouseIds[0] === 1177
    ? { page: 1, size: 500, total: 2, totalPages: 1, rows: [
      { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-A0", productName: "Vải chờ lên kệ", location: "F0-A0-00-00-00-00", qty: 4, total: 4, modified: wmsTime(now - 12 * 86400000), created: wmsTime(now - 300 * 86400000), uom: "m" },
      { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-KE", productName: "Vải trên kệ", location: "F0-KHO-511-09-01-01", qty: 9, total: 12, modified: wmsTime(now - 90 * 86400000), created: wmsTime(now - 90 * 86400000), uom: "m" },
    ] }
    : { page: 1, size: 500, total: 1, totalPages: 1, rows: [
      { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", sku: "SKU-HELD", productName: "Sợi giữ chỗ", location: "F0-AJ-00-00-00-00", qty: 0, total: 6, modified: wmsTime(now - 2 * 86400000), created: wmsTime(now - 200 * 86400000), uom: "cuộn" },
    ] };
  else data = {};
  postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok: true, data }, location.origin);
});

// Bản chụp có đủ ba mức, vị trí lạ, vùng ảo mới đánh số (TF-02), dòng chưa có ngày, dòng chỉ có ngày tạo (bản chụp cũ), dòng tạo từ lâu nhưng vừa sửa (SKU-PICK) và dòng giữ chỗ trong sourceCounts.
const snapshot = (over = {}) => {
  const now = Date.now(), at = days => wms(now - days * DAY);
  const rows = [
    { ...MTG, sku: "SKU-SHELF-1", productName: "Vải A/Cotton", qty: 100, uom: "m", locations: [{ location: "F0-KHO-511-09-01-01", qty: 90 }, { location: "F0-A0-00-00-00-00", qty: 10, modified: at(40), created: at(300) }] },
    { ...MTG, sku: "SKU-AJ", productName: "Dây thun", qty: 5, uom: "m", locations: [{ location: "F0-AJ-00-00-00-00", qty: 5, total: 8, modified: at(10), created: at(100) }] },
    { ...MTG, sku: "SKU-VR", productName: "Vải trả NCC", qty: 3, uom: "m", locations: [{ location: "F0-VR-00-00-00-00", qty: 3, since: at(3) }] },
    { ...MTG, sku: "SKU-IT", productName: "Chỉ IT", qty: 1, uom: "cuộn", locations: [{ location: "F0-IT-00-00-00-00", qty: 1 }] },
    { ...MTG, sku: "SKU-TF", productName: "Phụ liệu qua TF", qty: 7, uom: "cái", locations: [{ location: "F0-TF-00-00-00-02", qty: 7, modified: at(1), created: at(50) }] },
    { ...GARMENT, sku: "SKU-ODD", productName: "Sợi lạ", qty: 2, uom: "cuộn", locations: [{ location: "F1-VP-01-01-01-01", qty: 2, modified: at(1) }] },
    { ...MTG, sku: "SKU-PICK", productName: "Keo dựng/5S", qty: 430, uom: "mm", locations: [{ location: "F0-A0-00-00-00-00", qty: 430, modified: at(0.01), created: at(311) }] },
    { ...GARMENT, sku: "SKU-OK", productName: "Sợi trên kệ", qty: 4, uom: "cuộn", locations: [{ location: "F0-KHO-505-11-03-01", qty: 4 }] },
  ].map(r => ({ ...r, lastApprovedAt: null, lastApprovedBy: null }));
  return {
    run: { id: "run-1", readAt: new Date(now - 3 * 3600000).toISOString(), thresholdDays: 30, rowCount: rows.length, missing: [], warehouses: [MTG, GARMENT],
      sourceCounts: { stockRows: 11, approvedRows: 0, heldTotal: 2, held: [
        { ...GARMENT, sku: "SKU-HELD", productName: "Sợi giữ chỗ", uom: "cuộn", location: "F0-AJ-00-00-00-00", total: 6, modified: at(2), created: at(200) },
        { ...GARMENT, sku: "SKU-HELD-KE", productName: "Sợi giữ chỗ trên kệ", uom: "cuộn", location: "F0-KHO-505-11-03-01", total: 3, modified: at(2) },
      ] }, ...over.run },
    rows,
  };
};

const makeBackend = (initial = null) => {
  const state = { snapshot: initial, pending: null, calls: [] };
  const handle = (route) => {
    const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
    const body = JSON.parse(route.request().postData() || "{}"), bearer = route.request().headers().authorization || "";
    state.calls.push({ rpc, body, admin: /test-admin-token/.test(bearer) });
    if (rpc === "sku_count_overview") return json({ ok: true, data: state.snapshot || { run: null, rows: [] } });
    if (rpc === "sku_count_save_start") { state.pending = { meta: body, rows: [] }; return json({ ok: true, data: { runId: "run-new" } }); }
    if (rpc === "sku_count_save_chunk") { state.pending.rows.push(...body.p_rows); return json({ ok: true, data: { saved: body.p_rows.length } }); }
    if (rpc === "sku_count_save_finish") {
      const p = state.pending; state.pending = null;
      state.snapshot = { run: { id: "run-new", readAt: new Date().toISOString(), thresholdDays: 30, rowCount: p.rows.length, missing: p.meta.p_missing, sourceCounts: p.meta.p_source_counts, warehouses: p.meta.p_warehouses },
        rows: p.rows.map(r => ({ warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, sku: r.sku, productName: r.product_name || "", qty: r.qty, uom: r.uom || "", locations: r.locations, lastApprovedAt: r.last_approved_at, lastApprovedBy: r.last_approved_by })) };
      return json({ ok: true, data: { runId: "run-new", rowCount: p.rows.length } });
    }
    return json({ ok: true, data: [] });
  };
  return { state, handle };
};

const open = async (browser, { width = 1280, admin = false, data = null } = {}) => {
  const backend = makeBackend(data), context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  await context.addInitScript(mockExtension);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
  await page.goto(BASE + "#storage-risk");
  await page.locator("#storage-risk-screen").waitFor({ state: "visible" });
  return { backend, context, page, errors };
};

// Nút đọc nguồn một kiểu .src-read (17/10/2026, khối #hero-standard): lớp, nhãn, icon mask ở ::before (không còn svg trong nút), cùng màu/cỡ/bo với nút đọc ở màn đồng bộ. Trả danh sách điểm lệch (rỗng = đạt).
const srcReadAudit = (page, specs, width) => page.evaluate(async ({ specs, width }) => {
  const mobile = width <= 800, ctl = mobile ? 48 : 52, bad = [];
  for (const spec of specs) {
    const b = document.getElementById(spec.id);
    if (!b) { bad.push(`#${spec.id} không có`); continue; }
    await Promise.all(b.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
    const s = getComputedStyle(b), before = getComputedStyle(b, "::before"), mask = before.maskImage || before.webkitMaskImage, text = b.innerText.trim(), h = parseFloat(s.height), w = parseFloat(s.width), all = spec.classes.includes("src-read--all");
    for (const cls of spec.classes) if (!b.classList.contains(cls)) bad.push(`#${spec.id} thiếu lớp ${cls}`);
    if (b.classList.contains("ss-primary")) bad.push(`#${spec.id} còn lớp ss-primary`);
    if (text !== spec.text) bad.push(`#${spec.id} chữ "${text}", cần "${spec.text}"`);
    if (spec.title !== undefined && b.title !== spec.title) bad.push(`#${spec.id} title "${b.title}", cần "${spec.title}"`);
    if (spec.aria && b.getAttribute("aria-label") !== spec.aria) bad.push(`#${spec.id} aria-label "${b.getAttribute("aria-label")}", cần "${spec.aria}"`);
    if (!mask || mask === "none" || before.content === "none") bad.push(`#${spec.id}::before không có icon mask`);
    if (b.querySelector("svg")) bad.push(`#${spec.id} còn svg trong nút (icon phải là mask ::before)`);
    if (Math.abs(h - ctl) > 1) bad.push(`#${spec.id} cao ${h}px, cần ${ctl}px`);
    if (spec.classes.includes("src-read--icon") && Math.abs(w - ctl) > 1) bad.push(`#${spec.id} rộng ${w}px, nút chỉ icon cần vuông ${ctl}px`);
    if (s.fontSize !== "16px" || s.fontWeight !== "600") bad.push(`#${spec.id} chữ ${s.fontSize}/${s.fontWeight}, cần 16px/600`);
    if (s.color !== "rgb(0, 95, 65)") bad.push(`#${spec.id} màu chữ ${s.color}, cần #005F41`);
    if (s.backgroundColor !== (all ? "rgb(255, 255, 255)" : "rgb(230, 243, 238)")) bad.push(`#${spec.id} nền ${s.backgroundColor}`);
    if (s.borderTopColor !== "rgb(95, 174, 146)") bad.push(`#${spec.id} viền ${s.borderTopColor}`);
    const r = Math.min(parseFloat(s.borderTopLeftRadius), h / 2);
    if (mobile ? Math.abs(r - 12) > 1 : r < h / 2 - 1) bad.push(`#${spec.id} bo ${s.borderTopLeftRadius}`);
  }
  return bad;
}, { specs, width });

// Dòng load dưới nút đang chạy (18/10/2026, khối #hero-standard): vạch 3 px bo tròn ở ::after của nút, nằm dưới mép nút, không bị cắt hay chồng (điểm giữa vạch trỏ về chính nút);
// màn này không có tiến độ theo trang → đoạn 38 % trượt qua lại. Trả về thông số đo được.
const barInfo = (page, id) => page.evaluate(id => {
  const b = document.getElementById(id), s = getComputedStyle(b, "::after"), r = b.getBoundingClientRect();
  const h = parseFloat(s.height) || 0, w = parseFloat(s.width) || 0, top = r.top + b.clientTop + (parseFloat(s.top) || 0), left = r.left + b.clientLeft + (parseFloat(s.left) || 0);
  const token = s.backgroundSize.split(",")[0].trim().split(" ")[0], fillOfTrack = token.endsWith("%") ? parseFloat(token) / 100 : w ? parseFloat(token) / w : NaN;
  const hit = h ? document.elementFromPoint(left + w / 2, top + h / 2) : null;
  return { content: s.content, position: s.position, height: h, track: w, btn: r.width, below: top >= r.bottom - 0.5, hit: hit === b, fillOfTrack, animated: s.animationName !== "none" };
}, id);
const expectBar = (info, tag) => {
  assert.equal(info.content, '""', `${tag}: không có vạch load dưới nút (::after content ${info.content})`);
  assert.equal(info.position, "absolute", `${tag}: vạch phải nằm tuyệt đối dưới nút`);
  assert.equal(info.height, 3, `${tag}: vạch cao ${info.height}px, cần 3px`);
  assert.ok(info.below, `${tag}: vạch phải nằm dưới mép nút`);
  assert.ok(info.hit, `${tag}: vạch bị cắt hoặc bị phần tử khác chồng lên`);
  assert.ok(Math.abs(info.track / info.btn - 1) <= 0.03, `${tag}: nền vạch rộng ${info.track.toFixed(1)}px, cần bằng bề rộng nút ${info.btn.toFixed(1)}px`);
  assert.ok(info.animated, `${tag}: chưa có tiến độ thật thì đoạn vạch phải trượt qua lại`);
  assert.ok(Math.abs(info.fillOfTrack - 0.38) < 0.01, `${tag}: đoạn trượt chiếm ${(info.fillOfTrack * 100).toFixed(1)}%, cần 38%`);
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- 1) Người xem: phân loại, mức, bộ lọc, Excel, không có dấu vết màn Combo cũ ----
    for (const width of [1280, 375]) {
      const { backend, context, page, errors } = await open(browser, { width, data: snapshot() });
      await page.waitForFunction(() => document.getElementById("sr-total").textContent === "8");
      assert.deepEqual(await page.evaluate(() => ["high", "mid", "low"].map(k => document.getElementById(`sr-${k}`).textContent)), ["2", "2", "4"]);
      assert.equal(await page.locator("#sr-cover-main").innerText(), "11 dòng tồn", "đối soát: mọi dòng tồn đều được phân loại, kể cả giữ chỗ");
      assert.equal(await page.locator("#sr-cover-sub").innerText(), "3 kệ · 7 ảo · 1 lạ");
      const baseWarn = await page.locator("#sr-warn").innerText();
      assert.match(baseWarn, /1 dòng chưa có Modified date, tính tạm theo ngày tạo/, "SKU-VR chỉ có ngày tạo (bản chụp cũ) phải được nêu");
      assert.match(baseWarn, /1 dòng chưa có ngày\b/, "SKU-IT không có ngày nào");
      assert.doesNotMatch(baseWarn, /Chưa đọc được kho|Bản chụp đã cũ|Lệch/, "bản chụp đủ 2 kho, mới, khớp số dòng: không có cảnh báo khác");
      assert.equal(await page.locator("#sr-admin-tools").isHidden(), true, "người xem không có nút đồng bộ WMS");
      assert.equal(await page.locator("#storage-risk-screen .ss-hero").evaluateAll(els => els.map(h => h.getClientRects().length)).then(a => a.every(n => n === 0)), true, `${width}px: người xem không thấy hero (không còn thẻ trắng rỗng)`);
      assert.deepEqual([...new Set(backend.state.calls.map(c => c.rpc).filter(r => r !== "print_queue_status"))], ["sku_count_overview"], "chỉ đọc bản chụp, không gọi Extension, không còn RPC Combo");
      assert.equal(backend.state.calls.find(c => c.rpc === "sku_count_overview").admin, false, "đọc bằng khoá công khai");
      assert.equal(await page.locator("[data-storage-risk], #storage-risk-detail, #storage-risk-total").count(), 0, "màn Combo cũ đã bị gỡ");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      const skus = () => page.locator("#sr-body tr code").allInnerTexts();
      assert.deepEqual(await skus(), ["SKU-SHELF-1", "SKU-ODD", "SKU-AJ", "SKU-IT", "SKU-VR", "SKU-HELD", "SKU-TF", "SKU-PICK"], "cao → cần xử lý → theo dõi, trong mỗi mức ngày lâu nhất lên trước");
      if (width === 1280) {
        assert.equal(await page.locator("#sr-head th").count(), 7);
        assert.equal(await page.locator(".sr-table").evaluate(t => t.parentElement.scrollWidth <= t.parentElement.clientWidth), true, "bảng vừa khung, không cuộn ngang");
        const text = await page.locator("#sr-body").innerText();
        assert.match(text, /F0-A0-00-00-00-00/);
        assert.match(text, /F0-TF-00-00-00-02/, "vùng ảo có bin đánh số (TF-02) vẫn được bắt");
        assert.match(text, /Vị trí lạ/);
        assert.match(text, /Chưa rõ ngày/, "dòng chưa có ngày không bị coi là an toàn");
        assert.match(text, /\+3 giữ chỗ/, "phần giữ chỗ trong vị trí được hiện riêng");
        const pick = await page.locator("#sr-body tr", { hasText: "SKU-PICK" }).innerText();
        assert.match(pick, /Theo dõi/, "tạo từ 311 ngày trước nhưng vừa sửa: tính theo Modified date nên chỉ là Theo dõi");
        assert.match(pick, /0 ngày/);
        assert.doesNotMatch(pick, /Rủi ro cao/);
        assert.match(await page.locator("#sr-body tr", { hasText: "SKU-VR" }).innerText(), /3 ngày · ngày tạo/, "dòng chỉ có ngày tạo ghi rõ đang tính theo ngày tạo");
        assert.match(text, /90 trên kệ/, "hiện phần đã lên kệ của cùng SKU");
        assert.doesNotMatch(text, /SKU-OK|F0-KHO-511-09-01-01|SKU-HELD-KE/, "hàng đã trên kệ (kể cả giữ chỗ trên kệ) không nằm trong màn này");
        await page.locator('[data-sr-tab="high"]').click();
        assert.deepEqual(await skus(), ["SKU-SHELF-1", "SKU-ODD"]);
        await page.locator('button.ss-metric[data-sr-level="low"]').click();
        assert.deepEqual(await skus(), ["SKU-VR", "SKU-HELD", "SKU-TF", "SKU-PICK"], "bấm thẻ Theo dõi lọc đúng nhóm");
        await page.locator('[data-sr-tab="all"]').click();
        await page.locator("#sr-tools input").fill("tra ncc");
        assert.deepEqual(await skus(), ["SKU-VR"], "tìm không dấu theo tên sản phẩm");
        await page.locator("#sr-tools input").fill("");
        await page.locator('[data-as-sort="sr_qty"]').click();
        assert.deepEqual(await skus(), ["SKU-PICK", "SKU-SHELF-1", "SKU-TF", "SKU-HELD", "SKU-AJ", "SKU-VR", "SKU-ODD", "SKU-IT"], "bấm Số lượng lần đầu sắp giảm dần (hàng giữ chỗ tính theo tổng)");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#sr-tools [data-as-export]").click()]);
        assert.match(download.suggestedFilename(), /^hang-chua-len-ke-.*\.xlsx$/);
        // Mức tính lúc xem: đẩy giờ máy lên 21 ngày thì dòng 10 ngày thành rủi ro cao mà không cần đồng bộ lại
        await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 21 * 86400000; });
        await page.evaluate(() => window.HasakiStorageRisk.load());
        assert.deepEqual(await page.evaluate(() => ["high", "mid", "low"].map(k => document.getElementById(`sr-${k}`).textContent)), ["3", "5", "0"], "mức tính theo giờ lúc xem: AJ 31 ngày thành cao, VR/HELD/TF/PICK vào cần xử lý");
        assert.match(await page.locator("#sr-warn").innerText(), /Bản chụp đã cũ/, "quá 24 giờ thì cảnh báo bản chụp cũ");
      } else {
        assert.equal(await page.locator(".sr-table thead").isVisible(), false, "điện thoại: bảng thành thẻ");
        const box = await page.locator("#sr-body tr").first().boundingBox();
        assert.ok(box && box.width <= 375, "thẻ nằm trong khung điện thoại");
        assert.equal(await page.locator("#sr-admin").isVisible(), true, "nút đăng nhập Admin ở thanh trên");
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) Phân loại vị trí: chỉ kệ thật mới được loại, mọi thứ lạ đều bị giữ lại ----
    {
      const { context, page, errors } = await open(browser, { data: snapshot() });
      const kinds = await page.evaluate(codes => codes.map(c => window.HasakiStorageRisk.classifyLocation(c).kind), [
        "F0-KHO-511-09-01-01", "F0-KHO-507A-06-02-01", "F0-KHO-HM-04-02-01", "F0-XV-KE1-09-04-01", "F0-CAT-QC-01-01-01", "F0-BAIXE-ĐG-01-01-01", "f0-baixe-đg-01-01-01",
        "F0-A0-00-00-00-00", "F0-TF-00-00-00-05", "F0-NEW-00-00-00-00",
        "F0-ZZZ-01-01-01-01", "F1-VP-01-01-01-01", "F0-KHO-00-01-01-01", "F0-KHO-511-09-01", "F0-KHO-511-09-01-0X", "", "Chưa có vị trí"]);
      assert.deepEqual(kinds, ["shelf", "shelf", "shelf", "shelf", "shelf", "shelf", "shelf", "virtual", "virtual", "virtual", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3) Cảnh báo: thiếu kho, bản chụp cũ, lệch số dòng, thiếu ngày; không bao giờ thành "0 rủi ro" im lặng ----
    {
      const old = snapshot({ run: { readAt: new Date(Date.now() - 30 * 3600000).toISOString(), warehouses: [MTG], sourceCounts: { stockRows: 99, heldTotal: 0, held: [] } } });
      const { context, page, errors } = await open(browser, { data: old });
      await page.waitForFunction(() => document.getElementById("sr-total").textContent !== "—");
      const warn = await page.locator("#sr-warn").innerText();
      assert.match(warn, /Chưa đọc được kho: WH - MATERIAL - GARMENT/, "bản chụp thiếu một kho phải báo rõ");
      assert.match(warn, /Bản chụp đã cũ/);
      assert.match(warn, /Lệch \d+ dòng/, "số dòng đã lưu không khớp số dòng WMS đã đọc");
      assert.match(warn, /dòng chưa có ngày\b/, "dòng thiếu ngày được nêu số lượng");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 4) Bản chụp sạch và chưa có bản chụp ----
    {
      const clean = { run: snapshot().run, rows: [{ ...MTG, sku: "SKU-OK", productName: "Trên kệ", qty: 1, uom: "m", locations: [{ location: "F0-KHO-511-09-01-01", qty: 1 }], lastApprovedAt: null, lastApprovedBy: null }] };
      clean.run.sourceCounts = { stockRows: 1, heldTotal: 0, held: [] };
      const { context, page } = await open(browser, { data: clean });
      await page.waitForFunction(() => /Không có hàng chưa lên kệ/.test(document.getElementById("sr-status").textContent));
      assert.equal(await page.locator("#sr-total").innerText(), "0");
      assert.match(await page.locator("#sr-body").innerText(), /Không có hàng chưa lên kệ/);
      await context.close();
      const none = await open(browser, { data: null });
      await none.page.waitForFunction(() => /Chưa có bản đồng bộ/.test(document.getElementById("sr-status").textContent));
      assert.equal(await none.page.locator("#sr-total").innerText(), "—");
      await none.context.close();
    }

    // ---- 5) Admin: đồng bộ bằng bộ đọc Kiểm kê; bản chụp lưu kèm ngày vào vị trí, tổng mọi trạng thái và dòng giữ chỗ ----
    for (const width of [1280, 375]) {
      const { backend, context, page, errors } = await open(browser, { width, admin: true, data: null });
      await page.locator("#sr-admin-tools").waitFor({ state: "visible" });
      assert.equal(await page.locator("#sr-admin").getAttribute("aria-pressed"), "true");
      // Khuôn nút đọc một kiểu (17/10/2026): .src-read, nhãn "Đọc WMS", icon mask; điện thoại: nút rộng hết hero
      assert.deepEqual(await srcReadAudit(page, [{ id: "sr-run", classes: ["src-read"], text: "Đọc WMS" }], width), [], `${width}px: nút đọc WMS một kiểu`);
      const layout = await page.evaluate(() => { const hero = document.querySelector("#storage-risk-screen .ss-hero"), s = getComputedStyle(hero); return { inner: hero.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth), runW: document.getElementById("sr-run").getBoundingClientRect().width }; });
      if (width === 375) assert.ok(Math.abs(layout.runW - layout.inner) <= 2, `điện thoại: nút rộng hết hero (${layout.runW} / ${layout.inner})`);
      // Đang đọc: giữ phản hồi Extension — nút vừa bấm data-busy + "Đang đọc…" + icon vòng xoay; nút UID tạm chỉ khoá (không data-busy); đọc xong trả "Đọc WMS"
      const idleMask = await page.locator("#sr-run").evaluate(b => getComputedStyle(b, "::before").maskImage);
      assert.equal((await barInfo(page, "sr-run")).content, "none", "rảnh: không có vạch load dưới nút");
      await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
      await page.locator("#sr-run").click();
      await page.waitForFunction(() => document.getElementById("sr-run").dataset.busy === "true");
      assert.equal((await page.locator("#sr-run").innerText()).trim(), "Đang đọc…");
      assert.equal(await page.locator("#sr-run").isDisabled(), true, "đang đọc: nút khoá");
      assert.equal(await page.locator("#sr-run").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
      assert.notEqual(await page.locator("#sr-run").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
      expectBar(await barInfo(page, "sr-run"), `${width}px #sr-run đang đọc`);
      assert.equal((await barInfo(page, "srt-run")).content, "none", "nút UID tạm chỉ khoá, không có vạch");
      assert.equal(await page.locator("#srt-run").isDisabled(), true, "nút UID tạm khoá khi nút này đang đọc");
      assert.notEqual(await page.locator("#srt-run").getAttribute("data-busy"), "true", "nút UID tạm chỉ khoá, không mang data-busy");
      assert.equal((await page.locator("#srt-run").evaluate(b => b.textContent)).trim(), "Đọc WMS", "nút UID tạm giữ nhãn");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      await page.waitForFunction(() => document.getElementById("sr-total").textContent === "2");
      assert.match(await page.locator("#sr-status").innerText(), /Đã đồng bộ\. 2 dòng chưa lên kệ/);
      const start = backend.state.calls.find(c => c.rpc === "sku_count_save_start");
      assert.equal(start.admin, true, "ghi bằng phiên Admin");
      assert.equal(start.body.p_source_counts.stockRows, 3, "số dòng WMS đã đọc: 2 ở MTG + 1 giữ chỗ ở Garment");
      assert.equal(start.body.p_source_counts.heldTotal, 1);
      assert.deepEqual(start.body.p_source_counts.held.map(h => [h.sku, h.location, h.total]), [["SKU-HELD", "F0-AJ-00-00-00-00", 6]], "hàng giữ chỗ không bị bỏ lặng lẽ");
      const saved = backend.state.snapshot.rows;
      assert.deepEqual(saved.map(r => r.sku).sort(), ["SKU-A0", "SKU-KE"], "Kiểm kê vẫn chỉ lưu SKU có In-BIN > 0");
      const ke = saved.find(r => r.sku === "SKU-KE").locations[0];
      assert.equal(ke.total, 12, "lưu tổng mọi trạng thái khi khác In-BIN");
      const a0 = saved.find(r => r.sku === "SKU-A0").locations[0];
      assert.match(a0.modified, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "lưu Modified date của dòng tồn");
      assert.match(a0.created, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "lưu kèm ngày tạo");
      assert.notEqual(a0.modified, a0.created);
      assert.match(start.body.p_source_counts.held[0].modified, /^\d{4}-\d{2}-\d{2} /, "dòng giữ chỗ cũng giữ Modified date");
      assert.equal(backend.state.calls.filter(c => c.rpc === "sku_count_overview").at(-1).admin, false, "đọc lại bằng khoá công khai như mọi người");
      await page.waitForFunction(() => !document.getElementById("sr-run").disabled, null, { timeout: 15000 }); // nút mở lại khi bước đọc UID tạm nối tiếp cũng xong
      assert.equal(await page.locator("#sr-run").isDisabled(), false, "nút dùng lại được sau khi xong");
      assert.notEqual(await page.locator("#sr-run").getAttribute("data-busy"), "true");
      assert.equal((await page.locator("#sr-run").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn cũ");
      assert.equal((await barInfo(page, "sr-run")).content, "none", "đọc xong: vạch load mất");
      const texts = (await page.locator("#sr-body tr code").allInnerTexts()).sort();
      assert.deepEqual(texts, ["SKU-A0", "SKU-HELD"], "màn mới hiện đúng hàng chưa lên kệ vừa đồng bộ, gồm cả hàng giữ chỗ");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("storage_risk_browser: phân loại kệ thật/vùng ảo/vị trí lạ, mức 7/30 ngày tính lúc xem, giữ chỗ, cảnh báo thiếu kho/cũ/lệch, Admin đồng bộ qua Kiểm kê, bảng/thẻ điện thoại, Excel passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
