// RỦI RO LƯU TRỮ · tab "UID tạm" (#storage-risk): Admin đọc báo cáo Import/Export 90 ngày của hai kho Material qua Extension,
// giữ dòng nhập "Tạo UID Temp" do phiếu điều chỉnh. Không lưu Supabase. Chạy với python -m http.server 8000 (đổi bằng BASE);
// Extension/Supabase giả lập bằng dữ liệu tổng hợp (SKU 9000000xx, mã phiếu 1001260000000001), không đọc dữ liệu thật.
//   node tests/storage_risk_temp_browser.cjs        (SRT_SHOTS=<thư mục> để lưu ảnh chụp)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";

// Extension giả: ghi mọi lệnh vào window.__extCalls; options.noGarment = kho Garment không có quyền, options.fail = { LOẠI_LỆNH: "thông báo lỗi" },
// options.edge = thêm dòng tuổi 3 ngày 23 giờ và 2 ngày 23 giờ, options.shortTotal = { mã kho: total WMS báo }, window.__failNow = true để lệnh đọc nhập xuất báo lỗi.
const mockExtension = ({ options }) => {
  window.__extCalls = [];
  const now = Date.now(), iso = ms => `${new Date(ms + 7 * 3600000).toISOString().slice(0, 19)}+07:00`, ago = d => iso(now - d * 86400000);
  const base = { sourceType: "ADJUSTMENT", reason: "Tạo UID Temp", kind: "in", createdBy: "api@hasaki.vn", balance: 100 };
  const moves = {
    1177: [
      { ...base, id: 1, warehouseId: 1177, sku: "900000012", productName: "Vải mẫu hai/Cuộn", qty: 8, sourceCode: "1001260000000012", mappingId: "1001260000000002", createdAt: ago(20) },
      { ...base, id: 2, warehouseId: 1177, sku: "900000011", productName: "Vải mẫu một/Cuộn", qty: 25.5, sourceCode: "1001260000000001", mappingId: "1001260000000003", createdAt: ago(1) },
      { ...base, id: 3, warehouseId: 1177, sku: "900000019", productName: "Nhiễu: xuất", kind: "out", qty: 3, sourceCode: "1001260000000019", createdAt: ago(2) },
      { ...base, id: 4, warehouseId: 1177, sku: "900000018", productName: "Nhiễu: nguồn khác", sourceType: "PURCHASE_ORDER", qty: 4, sourceCode: "1001260000000018", createdAt: ago(2) },
    ],
    1339: [
      { ...base, id: 5, warehouseId: 1339, sku: "900000013", productName: "Sợi mẫu ba/Cuộn", qty: 2, sourceCode: "1001260000000013", mappingId: "1001260000000004", createdAt: ago(5) },
      { ...base, id: 6, warehouseId: 1339, sku: "900000017", productName: "Nhiễu: lý do khác", reason: "Xuất test", qty: 6, sourceCode: "1001260000000017", createdAt: ago(1) },
    ],
  };
  if (options.edge) moves[1177].push(
    { ...base, id: 7, warehouseId: 1177, sku: "900000021", productName: "Vải mẫu biên bốn/Cuộn", qty: 1, sourceCode: "1001260000000021", mappingId: "1001260000000005", createdAt: iso(now - (3 * 24 + 23) * 3600000) },
    { ...base, id: 8, warehouseId: 1177, sku: "900000022", productName: "Vải mẫu biên năm/Cuộn", qty: 1, sourceCode: "1001260000000022", mappingId: "1001260000000006", createdAt: iso(now - (2 * 24 + 23) * 3600000) });
  addEventListener("message", async event => {
    const r = event.data;
    if (!r || r.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: r.type, payload: r.payload });
    if (window.__hold && r.type === "GET_SKU_COUNT_WAREHOUSES") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
    const reply = (ok, data, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok, data, error }, location.origin);
    const p = r.payload || {};
    if (options.fail?.[r.type]) return reply(false, undefined, { code: "MOCK", message: options.fail[r.type] });
    if (window.__failNow && r.type === "GET_STOCK_IMPORT_EXPORT_PAGE") return reply(false, undefined, { code: "MOCK", message: "Phiên WMS hết hạn" });
    if (r.type === "GET_SKU_COUNT_WAREHOUSES") return reply(true, { warehouses: [
      { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty Mastige" },
      ...(options.noGarment ? [] : [{ warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyId: 1005, companyName: "Cty Garment" }]),
    ], missingNames: [] });
    if (r.type === "GET_STOCK_IMPORT_EXPORT_PAGE") { const rows = moves[p.warehouseIds[0]] || []; return reply(true, { page: p.page, size: 500, total: options.shortTotal?.[p.warehouseIds[0]] ?? rows.length, totalPages: 1, rows: p.page === 1 ? rows : [] }); }
    if (r.type === "GET_SKU_COUNT_APPROVED_PAGE") return reply(true, { page: 1, size: 500, total: 0, totalPages: 1, rows: [] });
    if (r.type === "GET_SKU_COUNT_INVENTORY_PAGE") {
      const id = p.warehouseIds[0], at = d => ago(d).slice(0, 19).replace("T", " ");
      return reply(true, { page: 1, size: 500, total: 1, totalPages: 1, rows: [{ warehouseId: id, warehouseName: id === 1177 ? "WH - MATERIAL - MTG" : "WH - MATERIAL - GARMENT", sku: "SKU-KK-1", productName: "Kiểm kê giả", location: "F0-A0-00-00-00-00", qty: 5, total: 5, modified: at(2), created: at(40), uom: "m" }] });
    }
    return reply(true, { version: "0.9.1" });
  });
};

const backend = (route, calls, ctrl = {}) => {
  const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (url.endsWith("/auth/v1/user")) return ctrl.userStatus ? route.fulfill({ status: ctrl.userStatus, contentType: "application/json", body: JSON.stringify({ msg: "mock" }) }) : json({ id: "test-admin" });
  if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
  if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
  calls.push(rpc);
  (ctrl.bodies ||= []).push(route.request().postData() || "");
  if (rpc === "sku_count_save_start") return json({ ok: true, data: { runId: "run-new" } });
  if (rpc === "sku_count_save_chunk") return json({ ok: true, data: { saved: (JSON.parse(route.request().postData() || "{}").p_rows || []).length } });
  if (rpc === "sku_count_save_finish") return json({ ok: true, data: { runId: "run-new", rowCount: 2 } });
  if (rpc === "sku_count_overview") return json({ ok: true, data: { run: null, rows: [] } });
  return json({ ok: true, data: [] });
};

const open = async (browser, { width = 1280, admin = false, options = {}, view = "" } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  if (view) await context.addInitScript(v => localStorage.setItem("sr-tab-dang-mo", v), view);
  await context.addInitScript(mockExtension, { options });
  const page = await context.newPage(), errors = [], rpcs = [], ctrl = {};
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend(route, rpcs, ctrl));
  await page.goto(BASE + "#storage-risk");
  await page.locator("#storage-risk-screen").waitFor({ state: "visible" });
  return { context, page, errors, rpcs, ctrl };
};
// Màn là lớp cố định cuộn trong, nên fullPage không đủ: nới khung nhìn bằng chiều cao nội dung rồi trả lại.
const shot = async (page, name) => {
  if (!process.env.SRT_SHOTS) return;
  const size = page.viewportSize(), height = await page.evaluate(() => document.getElementById("storage-risk-screen").scrollHeight);
  await page.setViewportSize({ width: size.width, height: Math.min(Math.max(height, size.height), 3000) });
  await page.screenshot({ path: `${process.env.SRT_SHOTS}/${name}.png` });
  await page.setViewportSize(size);
};
const skus = page => page.locator("#srt-body tr td:nth-child(3) code").allInnerTexts();
const metricsOf = page => page.evaluate(() => ["total", "mtg", "garment", "recent"].map(k => document.getElementById(`srt-${k}`).textContent));
const rpcSet = rpcs => [...new Set(rpcs.filter(r => r !== "print_queue_status"))];

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
    // ---- 1) Người xem: tab chuyển được, không có nút đọc, không gọi Extension, chỉ đọc bản chụp Kiểm kê ----
    {
      const { context, page, errors, rpcs } = await open(browser);
      assert.equal(await page.locator("#storage-risk-screen").getAttribute("data-view"), "main", "mặc định là Hàng chưa lên kệ");
      assert.equal(await page.locator("#srt-panel").isHidden(), true);
      assert.equal(await page.locator("#sr-strip").isVisible(), true, "nội dung cũ vẫn hiện");
      assert.equal(await page.locator("#srt-tab-main").getAttribute("aria-selected"), "true");
      assert.equal(await page.locator("#srt-subtitle").innerText(), "Hàng chưa lên kệ", "phụ đề thanh trên theo tab chính");
      await page.locator("#srt-tab-temp").click();
      assert.equal(await page.locator("#srt-subtitle").innerText(), "UID tạm", "phụ đề đổi theo tab UID tạm");
      assert.equal(await page.locator("#storage-risk-title").innerText(), "RỦI RO LƯU TRỮ", "tiêu đề giữ nguyên");
      assert.equal(await page.locator("#srt-panel").isVisible(), true);
      assert.equal(await page.locator("#sr-strip").isHidden(), true, "tab UID tạm ẩn nội dung cũ");
      assert.equal(await page.locator("#sr-total").isHidden(), true);
      assert.equal(await page.locator("#srt-tabs").isVisible(), true, "thanh tab luôn hiện");
      assert.equal(await page.locator("#srt-tab-temp").getAttribute("aria-selected"), "true");
      assert.equal(await page.evaluate(() => localStorage.getItem("sr-tab-dang-mo")), "temp", "nhớ tab theo máy");
      assert.equal(await page.locator("#srt-admin-tools").isHidden(), true, "người xem không có nút đọc WMS");
      assert.equal(await page.locator("#srt-run").isHidden(), true);
      assert.equal(await page.locator("#storage-risk-screen .ss-hero").evaluateAll(els => els.every(h => h.getClientRects().length === 0)), true, "1280px: người xem không thấy hero ở cả hai tab (không còn thẻ trắng rỗng)");
      assert.equal(await page.locator("#srt-status").innerText(), "Chỉ Admin đọc được.");
      assert.deepEqual(await metricsOf(page), ["—", "—", "—", "—"], "người xem: dữ liệu rỗng");
      // Thẻ không còn chú thích giải thích (18/10/2026): câu cũ nằm ở title của thẻ
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".ss-metrics[aria-label='Tổng quan UID tạm'] .ss-metric")].map(c => c.querySelectorAll("small").length)), [0, 0, 0, 0], "thẻ UID tạm không còn dòng nhỏ giải thích");
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".ss-metrics[aria-label='Tổng quan UID tạm'] .ss-metric")].map(c => c.title)), ["90 ngày gần nhất", "WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT", "Mới tạo"], "câu giải thích chuyển vào title của thẻ");
      assert.match(await page.locator("#srt-body").innerText(), /Chưa có dữ liệu/);
      await page.reload();
      await page.locator("#srt-panel").waitFor({ state: "visible" });
      assert.equal(await page.locator("#storage-risk-screen").getAttribute("data-view"), "temp", "tải lại vẫn ở tab UID tạm");
      await page.locator("#srt-tab-main").click();
      assert.equal(await page.locator("#sr-strip").isVisible(), true);
      assert.equal(await page.locator("#srt-panel").isHidden(), true, "quay lại tab cũ: ẩn UID tạm");
      assert.equal(await page.locator("#srt-subtitle").innerText(), "Hàng chưa lên kệ", "phụ đề quay lại theo tab chính");
      assert.equal(await page.evaluate(() => localStorage.getItem("sr-tab-dang-mo")), "main");
      assert.equal((await page.evaluate(() => window.__extCalls.filter(c => c.type.startsWith("GET_")))).length, 0, "người xem không đọc WMS qua Extension");
      assert.deepEqual(rpcSet(rpcs), ["sku_count_overview"], "người xem chỉ gọi RPC sku_count_overview");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) Admin: đọc, lọc đúng dòng UID tạm, thẻ lọc, Excel; không ghi Supabase ----
    for (const width of [1280, 375]) {
      const { context, page, errors, rpcs, ctrl } = await open(browser, { width, admin: true, view: "temp" });
      await page.locator("#srt-admin-tools").waitFor({ state: "visible" });
      assert.equal(await page.locator("#srt-run").isVisible(), true);
      assert.equal(await page.locator("#srt-status").innerText(), "Chưa đọc từ WMS.");
      // Khuôn nút đọc một kiểu (17/10/2026): .src-read, nhãn "Đọc WMS", icon mask; điện thoại: nút rộng hết hero
      assert.deepEqual(await srcReadAudit(page, [{ id: "srt-run", classes: ["src-read"], text: "Đọc WMS" }], width), [], `${width}px: nút đọc WMS một kiểu`);
      const layout = await page.evaluate(() => { const hero = document.querySelector("#srt-panel .ss-hero"), s = getComputedStyle(hero); return { inner: hero.getBoundingClientRect().width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth), runW: document.getElementById("srt-run").getBoundingClientRect().width }; });
      if (width === 375) assert.ok(Math.abs(layout.runW - layout.inner) <= 2, `điện thoại: nút rộng hết hero (${layout.runW} / ${layout.inner})`);
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "3");
      assert.deepEqual(await metricsOf(page), ["3", "2", "1", "1"], "tổng 3, MTG 2, GARMENT 1, trong 3 ngày 1");
      assert.match(await page.locator("#srt-status").innerText(), /^Đã đọc 3 dòng tạo UID tạm trong 90 ngày\.$/);
      assert.equal(await page.locator('[data-srt-level="all"] > span').innerText(), "Dòng tạo UID tạm", "nhãn thẻ tổng");
      assert.equal(await page.locator("#srt-subtitle").innerText(), "UID tạm");
      assert.deepEqual(await skus(page), ["900000011", "900000013", "900000012"], "mới nhất trước; dòng nhiễu bị loại");
      assert.equal(await page.locator("#srt-run").isDisabled(), false, "đọc xong dùng lại được nút");
      assert.equal(await page.locator("#srt-wh-main").innerText(), "MTG + GARMENT");
      assert.equal(await page.locator("#srt-scan-main").innerText(), "6 dòng", "số dòng đã quét gồm cả dòng nhiễu");
      assert.equal(await page.locator("#srt-warn").isHidden(), true);
      const calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE"));
      assert.equal(calls.length, 2, "mỗi kho một lượt đọc");
      assert.deepEqual(calls.map(c => [c.payload.warehouseIds[0], c.payload.companyId]), [[1177, 1002], [1339, 1005]]);
      assert.ok(Math.abs((calls[0].payload.to - calls[0].payload.from) / 86400000 - 90) < 0.01, "khoảng đọc 90 ngày");
      assert.ok(calls.every(c => c.payload.page === 1 && c.payload.size === 500));
      assert.deepEqual(rpcSet(rpcs).sort(), ["sku_count_overview", "sku_count_save_chunk", "sku_count_save_finish", "sku_count_save_start"], "chỉ bộ đồng bộ Kiểm kê ghi bản chụp");
      assert.equal(ctrl.bodies.some(body => /9000000|100126000000/.test(body)), false, "dữ liệu UID tạm không lên Supabase");
      const text = await page.locator("#srt-body").innerText();
      assert.match(text, /1001260000000001/, "Mã ADJ"); assert.match(text, /1001260000000003/, "Phiếu gốc"); assert.match(text, /api@hasaki\.vn/);
      assert.match(await page.locator("#srt-body tr").first().innerText(), /Mới · 1 ngày/, "≤ 3 ngày: chip Mới");
      assert.equal(await page.locator('#srt-body tr:nth-child(1) .as-chip[data-tone="bad"]').count(), 1);
      assert.equal(await page.locator('#srt-body tr:nth-child(2) .as-chip[data-tone="warn"]').count(), 1, "≤ 14 ngày: chip cảnh báo");
      assert.equal(await page.locator('#srt-body tr:nth-child(3) td:nth-child(9) .as-chip:not([data-tone])').count(), 1, "còn lại: chip thường");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      if (width === 1280) {
        assert.equal(await page.locator("#srt-head th").count(), 9);
        assert.deepEqual(await page.locator("#srt-head th").allInnerTexts(), ["Kho", "Ngày tạo", "SKU", "Sản phẩm", "Số lượng", "Mã ADJ", "Phiếu gốc", "Người tạo", "Tuổi"]);
        assert.equal(await page.locator(".srt-table").evaluate(t => t.parentElement.scrollWidth <= t.parentElement.clientWidth), true, "bảng vừa khung, không cuộn ngang");
        await page.locator('[data-srt-level="mtg"]').click();
        assert.deepEqual(await skus(page), ["900000011", "900000012"], "bấm thẻ MTG lọc còn 2");
        assert.equal(await page.locator("#srt-list-title").innerText(), "MTG");
        await page.locator('[data-srt-level="garment"]').click();
        assert.deepEqual(await skus(page), ["900000013"]);
        await page.locator('[data-srt-level="recent"]').click();
        assert.deepEqual(await skus(page), ["900000011"], "thẻ Trong 3 ngày");
        await page.locator('[data-srt-level="all"]').click();
        assert.equal((await skus(page)).length, 3);
        await page.locator("#srt-tags .as-facet-btn").first().click();
        assert.match(await page.locator("#srt-tags .as-facet-pop").innerText(), /WH - MATERIAL - MTG/, "facet Kho");
        await page.keyboard.press("Escape");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#srt-tools [data-as-export]").click()]);
        assert.match(download.suggestedFilename(), /^uid-tam-.*\.xlsx$/);
      } else {
        assert.equal(await page.locator(".srt-table thead").isVisible(), false, "điện thoại: bảng thành thẻ");
        const box = await page.locator("#srt-body tr").first().boundingBox();
        assert.ok(box && box.width <= 375, "thẻ nằm trong khung điện thoại");
        assert.equal(await page.locator("#srt-tabs").isVisible(), true);
      }
      await shot(page, `uid-tam-${width}`);
      // Thoát Admin giữa chừng: dữ liệu trong bộ nhớ bị xoá
      await page.evaluate(() => { window.PrintSkuAdminAccess.logout(); });
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "—");
      assert.equal(await page.locator("#srt-admin-tools").isHidden(), true, "thoát Admin: ẩn nút đọc");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3) Thiếu kho: vẫn đọc kho còn lại và báo rõ tên kho thiếu ----
    {
      const { context, page, errors } = await open(browser, { admin: true, view: "temp", options: { noGarment: true } });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "2");
      assert.match(await page.locator("#srt-warn").innerText(), /Chưa đọc được kho: WH - MATERIAL - GARMENT/);
      assert.deepEqual(await metricsOf(page), ["2", "2", "0", "1"]);
      assert.equal(await page.locator('[data-srt-level="garment"]').getAttribute("data-zero"), "true", "thẻ rỗng không lọc được");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 4) Lỗi Extension: báo ở dòng trạng thái riêng, không để dữ liệu cũ gây hiểu nhầm ----
    {
      const { context, page, errors } = await open(browser, { admin: true, view: "temp", options: { fail: { GET_STOCK_IMPORT_EXPORT_PAGE: "Phiên WMS hết hạn" } } });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-status").dataset.tone === "error");
      assert.match(await page.locator("#srt-status").innerText(), /Phiên WMS hết hạn/);
      assert.equal(await page.locator("#srt-total").innerText(), "—");
      assert.equal(await page.locator("#srt-run").isDisabled(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- 5) Lượt đọc lỗi sau lượt đọc thành công: không giữ dữ liệu cũ, không còn gì để xuất Excel ----
    {
      const { context, page, errors } = await open(browser, { admin: true, view: "temp" });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "3");
      assert.equal(await page.locator("#srt-tools [data-as-export]").isEnabled(), true, "đọc xong có nút Excel");
      await page.evaluate(() => { window.__failNow = true; });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-status").dataset.tone === "error");
      assert.match(await page.locator("#srt-status").innerText(), /Phiên WMS hết hạn/);
      assert.deepEqual(await metricsOf(page), ["—", "—", "—", "—"], "lỗi: thẻ về —");
      assert.equal(await page.locator("#srt-read-at").innerText(), "—", "lỗi: dải Đọc lúc về —");
      assert.equal(await page.locator("#srt-scan-main").innerText(), "—");
      assert.match(await page.locator("#srt-body").innerText(), /Chưa có dữ liệu/, "lỗi: bảng rỗng");
      assert.equal(await page.locator("#srt-body tr code").count(), 0);
      assert.equal(await page.locator("#srt-tools").isHidden(), true, "lỗi: ẩn thanh công cụ");
      assert.equal(await page.locator("#srt-tools [data-as-export]").isDisabled(), true, "lỗi: không còn dữ liệu để xuất Excel");
      assert.equal(await page.locator("#srt-run").isDisabled(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 6) Ngưỡng tuổi theo mili giây: 3 ngày 23 giờ không tính "Trong 3 ngày", 2 ngày 23 giờ có tính ----
    {
      const { context, page, errors } = await open(browser, { admin: true, view: "temp", options: { edge: true } });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "5");
      assert.deepEqual(await metricsOf(page), ["5", "4", "1", "2"], "Trong 3 ngày = dòng 1 ngày + dòng 2 ngày 23 giờ");
      await page.locator('[data-srt-level="recent"]').click();
      assert.deepEqual(await skus(page), ["900000011", "900000022"], "dòng 3 ngày 23 giờ không nằm trong Trong 3 ngày");
      const chipOf = sku => page.locator("#srt-body tr").filter({ hasText: sku }).locator("td:nth-child(9) .as-chip");
      assert.match(await chipOf("900000022").innerText(), /Mới · 2 ngày/);
      await page.locator('[data-srt-level="all"]').click();
      assert.equal((await chipOf("900000021").innerText()).trim(), "3 ngày", "hiển thị vẫn lấy phần nguyên ngày, không phải chip Mới");
      assert.equal(await chipOf("900000021").getAttribute("data-tone"), "warn", "3 ngày 23 giờ ≤ 14 ngày: chip cảnh báo");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 7) Kiểm đủ dữ liệu: WMS báo nhiều dòng hơn số đọc được thì thêm cảnh báo, không chặn ----
    {
      const { context, page, errors } = await open(browser, { admin: true, view: "temp", options: { shortTotal: { 1339: 40 } } });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "3");
      assert.equal(await page.locator("#srt-warn").isVisible(), true);
      assert.match(await page.locator("#srt-warn").innerText(), /WH - MATERIAL - GARMENT: WMS báo 40 dòng, đọc được 2/);
      assert.doesNotMatch(await page.locator("#srt-warn").innerText(), /MTG: WMS báo/, "kho đủ dòng không có cảnh báo");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 8) Admin chưa được xác minh (Supabase trả 403): bấm đọc không gọi Extension, không ghi gì ----
    {
      const { context, page, errors, rpcs, ctrl } = await open(browser, { admin: true, view: "temp" });
      await page.locator("#srt-run").waitFor({ state: "visible" });
      ctrl.userStatus = 403;
      const before = rpcs.length;
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-admin-tools").hidden, null, { timeout: 15000 });
      assert.deepEqual(await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").map(c => c.type)), [], "chưa xác minh Admin: không gọi Extension đọc Import/Export");
      assert.deepEqual(await metricsOf(page), ["—", "—", "—", "—"]);
      assert.match(await page.locator("#srt-body").innerText(), /Chưa có dữ liệu/);
      assert.equal(rpcSet(rpcs.slice(before)).some(r => r.startsWith("sku_count_save")), false, "403: không ghi gì lên Supabase");
      assert.equal(await page.locator("#srt-run").isDisabled(), false, "không kẹt ở trạng thái đang đọc");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- 9) Đồng bộ một lần: bấm ở tab Hàng chưa lên kệ cũng đọc UID tạm; bước UID tạm lỗi không đổi kết quả tab cũ ----
    for (const failing of [false, true]) {
      const { context, page, errors, rpcs } = await open(browser, { admin: true, options: failing ? { fail: { GET_STOCK_IMPORT_EXPORT_PAGE: "Phiên WMS hết hạn" } } : {} });
      await page.locator("#sr-run").click();
      await page.waitForFunction(() => /^Đã đồng bộ\./.test(document.getElementById("sr-status").textContent));
      await page.waitForFunction(() => !document.getElementById("sr-run").disabled && !document.getElementById("srt-run").disabled, null, { timeout: 15000 });
      assert.match(await page.locator("#sr-status").innerText(), /^Đã đồng bộ\. (Không có hàng chưa lên kệ\.|\d+ dòng chưa lên kệ\.)$/, "tab cũ giữ câu kết quả của nó");
      assert.equal(await page.locator("#sr-status").getAttribute("data-tone") || "", "", "tab cũ không bị báo lỗi");
      assert.ok(rpcs.includes("sku_count_save_start") && rpcs.includes("sku_count_save_finish"), "Kiểm kê đã lưu bản chụp như cũ");
      const order = await page.evaluate(() => window.__extCalls.map(c => c.type));
      assert.ok(order.indexOf("GET_SKU_COUNT_INVENTORY_PAGE") < order.indexOf("GET_STOCK_IMPORT_EXPORT_PAGE"), "Kiểm kê trước, UID tạm nối tiếp");
      await page.locator("#srt-tab-temp").click();
      if (!failing) {
        assert.deepEqual(await metricsOf(page), ["3", "2", "1", "1"], "chuyển sang tab UID tạm thấy dữ liệu đã đọc");
        assert.match(await page.locator("#srt-status").innerText(), /^Đã đọc 3 dòng tạo UID tạm trong 90 ngày\.$/);
        assert.equal(await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").length), 2, "mỗi kho đọc đúng một lượt");
      } else {
        assert.equal(await page.locator("#srt-status").getAttribute("data-tone"), "error", "lỗi UID tạm chỉ hiện ở tab UID tạm");
        assert.match(await page.locator("#srt-status").innerText(), /Phiên WMS hết hạn/);
        assert.deepEqual(await metricsOf(page), ["—", "—", "—", "—"]);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 10) Bấm Đọc WMS ở tab UID tạm: Kiểm kê + Import/Export, hai nút cùng khoá khi chạy, không đọc UID tạm hai lần ----
    {
      const { context, page, errors, rpcs } = await open(browser, { admin: true, view: "temp" });
      assert.equal((await page.locator("#srt-run").innerText()).trim(), "Đọc WMS");
      await page.evaluate(() => {
        window.__seq = [];
        new MutationObserver(() => window.__seq.push({ t: document.getElementById("srt-status").textContent, a: document.getElementById("srt-run").disabled, b: document.getElementById("sr-run").disabled }))
          .observe(document.getElementById("srt-status"), { childList: true, characterData: true, subtree: true });
      });
      // Đang đọc: giữ phản hồi Extension — nút vừa bấm data-busy + "Đang đọc…" + icon vòng xoay; đọc xong trả "Đọc WMS"
      const idleMask = await page.locator("#srt-run").evaluate(b => getComputedStyle(b, "::before").maskImage);
      assert.equal((await barInfo(page, "srt-run")).content, "none", "rảnh: không có vạch load dưới nút");
      await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
      await page.locator("#srt-run").click();
      await page.waitForFunction(() => document.getElementById("srt-run").dataset.busy === "true");
      assert.equal((await page.locator("#srt-run").innerText()).trim(), "Đang đọc…");
      assert.equal(await page.locator("#srt-run").isDisabled(), true, "đang đọc: nút khoá");
      assert.equal(await page.locator("#srt-run").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
      assert.notEqual(await page.locator("#srt-run").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
      expectBar(await barInfo(page, "srt-run"), "#srt-run đang đọc");
      assert.equal(await page.locator("#sr-run").isDisabled(), true, "nút Hàng chưa lên kệ cũng khoá (bộ đồng bộ của nó là bước đầu của lượt này nên cũng báo đang đọc)");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      await page.waitForFunction(() => document.getElementById("srt-total").textContent === "3" && !document.getElementById("srt-run").disabled && !document.getElementById("sr-run").disabled, null, { timeout: 15000 });
      assert.notEqual(await page.locator("#srt-run").getAttribute("data-busy"), "true");
      assert.equal((await page.locator("#srt-run").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn cũ");
      assert.equal((await barInfo(page, "srt-run")).content, "none", "đọc xong: vạch load mất");
      const seq = await page.evaluate(() => window.__seq);
      const texts = seq.map(x => x.t), sync = texts.indexOf("Đang đồng bộ Hàng chưa lên kệ…"), read = texts.indexOf("Đang đọc UID tạm…");
      assert.ok(sync >= 0 && read > sync, `trạng thái lần lượt: đồng bộ Hàng chưa lên kệ rồi đọc UID tạm (${texts.join(" | ")})`);
      const during = seq.filter(x => /^Đang /.test(x.t));
      assert.ok(during.length >= 2 && during.every(x => x.a && x.b), "đang chạy: cả hai nút đều khoá");
      assert.ok(rpcs.includes("sku_count_save_start") && rpcs.includes("sku_count_save_finish"), "có lưu bản chụp Kiểm kê");
      const types = await page.evaluate(() => window.__extCalls.map(c => c.type));
      assert.equal(types.filter(t => t === "GET_STOCK_IMPORT_EXPORT_PAGE").length, 2, "UID tạm chỉ đọc một lần (mỗi kho một lượt)");
      assert.ok(types.includes("GET_SKU_COUNT_INVENTORY_PAGE"), "có đọc tồn cho Kiểm kê");
      assert.deepEqual(await metricsOf(page), ["3", "2", "1", "1"]);
      assert.match(await page.locator("#sr-status").innerText(), /^Đã đồng bộ\./, "tab Hàng chưa lên kệ cũng có kết quả đồng bộ");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("storage_risk_temp_browser: tab nhớ theo máy + ẩn/hiện nội dung cũ, người xem không đọc/không Extension, Admin đọc 2 kho, lọc UID tạm, thẻ lọc, chip tuổi, Excel, 375px, thiếu kho, lỗi Extension, lượt lỗi xoá dữ liệu cũ, ngưỡng tuổi theo mili giây, cảnh báo thiếu dòng, Admin 403 không gọi Extension, phụ đề theo tab, đồng bộ một lần ở cả hai tab (lỗi UID tạm không đổi tab cũ, hai nút cùng khoá, không đọc hai lần), UID tạm không lên Supabase passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
