// KIỂM SOÁT CÔNG TRÌNH (ô trang chủ, #site-control): Admin đọc tồn + nhập xuất từ app xây dựng (qua tab app) và WMS (qua tab WMS),
// đối chiếu ngay trên trình duyệt, không lưu gì lên Supabase. Chạy với python -m http.server 8000; Extension giả, không đọc dữ liệu thật.
//   node tests/site_control_browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";

// Dữ liệu giả (SKU 9000000xx là giả): đủ bốn tình huống — khớp, tồn lệch + chưa lên kệ, xuất lệch + xuất kiểm kê, thiếu dòng nhập ở app.
const FIXTURE = {
  warehouse: { warehouseId: 1151, warehouseName: "OFFICE - 130 AP CHANH - MTG", companyId: 1002, companyName: "Cty Mastige" },
  stock: [
    { sku: "900000001", name: "Xi măng mẫu/Bao 50kg", unit: "bao", inStock: 89, qtyImported: 340, qtyExported: 251, issuesDetail: [{ time: "2026-08-27T04:43:19Z", qty: 10, ref: "2. Ép cọc đại trà", who: "Công nhân A" }] },
    { sku: "900000002", name: "Cừ tràm mẫu/Cây", unit: "cây", inStock: 0, qtyImported: 192, qtyExported: 192 },
    { sku: "900000003", name: "Thép mẫu/Kg", unit: "kg", inStock: 603, qtyImported: 950, qtyExported: 347 },
    { sku: "900000004", name: "Cát mẫu/m3", unit: "m3", inStock: 0, qtyImported: 235, qtyExported: 235 },
  ],
  imports: [
    { sku: "900000001", type: "Imp", quantity: 340, sourceCode: "P1", createdAt: "2026-07-02 09:00:00", fileName: "f1.xlsx" },
    { sku: "900000002", type: "Imp", quantity: 192, sourceCode: "P2", createdAt: "2026-07-03 09:00:00" },
    { sku: "900000003", type: "Imp", quantity: 950, sourceCode: "P3", createdAt: "2026-07-04 09:00:00" },
    { sku: "900000004", type: "Imp", quantity: 235, sourceCode: "P4", createdAt: "2026-07-05 09:00:00" },
  ],
  inventory: [
    { warehouseId: 1151, sku: "900000001", location: "F01-WH2-501-01-01-01", qty: 89, uom: "bao" },
    { warehouseId: 1151, sku: "900000002", location: "F0-A0-00-00-00-00", qty: 192, uom: "cây" },
    { warehouseId: 1151, sku: "900000003", location: "F01-WH2-501-01-01-01", qty: 467, uom: "kg" },
    { warehouseId: 1151, sku: "999999999", location: "F01-WH2-501-01-01-01", qty: 5, uom: "cái" },
  ],
  moves: [
    { sku: "900000001", kind: "in", qty: 340, sourceCode: "P1", createdAt: "2026-07-02T09:00:00+07:00" },
    { sku: "900000001", kind: "out", qty: 251, reason: "Xuất sử dụng", sourceType: "ADJUSTMENT", createdAt: "2026-09-01T09:00:00+07:00" },
    { sku: "900000002", kind: "in", qty: 192, sourceCode: "P2", createdAt: "2026-07-03T09:00:00+07:00" },
    { sku: "900000003", kind: "in", qty: 950, sourceCode: "P3", createdAt: "2026-07-04T09:00:00+07:00" },
    { sku: "900000003", kind: "out", qty: 400, reason: "Xuất sử dụng", createdAt: "2026-09-02T09:00:00+07:00" },
    { sku: "900000003", kind: "out", qty: 83, reason: "WMS điều chỉnh kiểm kê", createdAt: "2026-09-03T09:00:00+07:00" },
    { sku: "900000004", kind: "in", qty: 235, sourceCode: "P4", createdAt: "2026-07-05T09:00:00+07:00" },
    { sku: "900000004", kind: "in", qty: 15, sourceCode: "P4B", sourceType: "PURCHASE_ORDER", createdAt: "2026-10-10T09:00:00+07:00" },
    { sku: "900000004", kind: "out", qty: 235, reason: "Xuất sử dụng", createdAt: "2026-09-04T09:00:00+07:00" },
    { sku: "999999999", kind: "in", qty: 99, sourceCode: "PX" },
  ],
};

// Extension giả chạy trong trang: ghi mọi lệnh vào window.__extCalls; options.fail = { LOẠI_LỆNH: "thông báo lỗi" }, options.noWarehouse = true.
const mockExtension = ({ fixture, options }) => {
  window.__extCalls = [];
  addEventListener("message", async event => {
    const r = event.data;
    if (!r || r.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: r.type, payload: r.payload });
    if (window.__hold && r.type === "GET_SKU_COUNT_WAREHOUSES") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
    if (window.__hold2 && r.type === "GET_SKU_COUNT_INVENTORY_PAGE" && (r.payload || {}).page === 2) await window.__hold2; // giữ trang 2 để đo tiến độ sau trang 1 (window.__two = tồn kho đọc 2 trang)
    const reply = (ok, data, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok, data, error }, location.origin);
    const p = r.payload || {};
    if (options.fail?.[r.type]) return reply(false, undefined, { code: "MOCK", message: options.fail[r.type] });
    switch (r.type) {
      case "GET_HCM_DATA": return reply(true, p.resource === "stock"
        ? { resource: "stock", rows: fixture.stock, total: fixture.stock.length, generatedAt: new Date(Date.now() - 120000).toISOString() }
        : { resource: "wmsImports", rows: fixture.imports, total: fixture.imports.length, generatedAt: new Date().toISOString() });
      case "GET_SKU_COUNT_WAREHOUSES": return reply(true, { warehouses: options.noWarehouse ? [] : [fixture.warehouse], missingNames: options.noWarehouse ? ["OFFICE - 130 AP CHANH - MTG"] : [] });
      case "GET_SKU_COUNT_INVENTORY_PAGE": return reply(true, { page: p.page || 1, size: 500, total: fixture.inventory.length, totalPages: window.__two ? 2 : 1, rows: p.page > 1 ? [] : fixture.inventory });
      case "GET_STOCK_IMPORT_EXPORT_PAGE": return reply(true, { page: p.page, size: 500, total: fixture.moves.length, totalPages: 1, rows: p.page === 1 ? fixture.moves : [] });
      default: return reply(true, { version: "0.9.0" });
    }
  });
};

const backend = route => {
  const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
  if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
  return json(url.includes("/rest/v1/") && !url.includes("/rpc/") ? [] : { ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [] } });
};

const open = async (browser, { width = 1280, admin = true, options = {} } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  await context.addInitScript(mockExtension, { fixture: FIXTURE, options });
  const page = await context.newPage(), errors = [], supabase = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    if (/\/rest\/v1\/rpc\/(?!print_queue_status)/.test(url)) supabase.push(url);
    return backend(route);
  });
  await page.goto(BASE + "#site-control");
  await page.locator("#site-control-screen").waitFor({ state: "visible" });
  return { context, page, errors, supabase };
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
// không có tiến độ thật (--p) → đoạn 38 % trượt qua lại; có --p (0–1) → tô theo % bề rộng nút. Trả về thông số đo được.
const barInfo = (page, id) => page.evaluate(id => {
  const b = document.getElementById(id), s = getComputedStyle(b, "::after"), r = b.getBoundingClientRect();
  const h = parseFloat(s.height) || 0, w = parseFloat(s.width) || 0, top = r.top + b.clientTop + (parseFloat(s.top) || 0), left = r.left + b.clientLeft + (parseFloat(s.left) || 0);
  const token = s.backgroundSize.split(",")[0].trim().split(" ")[0], fillOfTrack = token.endsWith("%") ? parseFloat(token) / 100 : w ? parseFloat(token) / w : NaN;
  const hit = h ? document.elementFromPoint(left + w / 2, top + h / 2) : null;
  return { content: s.content, position: s.position, height: h, track: w, btn: r.width, below: top >= r.bottom - 0.5, hit: hit === b, fillOfTrack, fill: fillOfTrack * w, animated: s.animationName !== "none", p: b.style.getPropertyValue("--p") };
}, id);
const expectBar = (info, tag, ratio) => {
  assert.equal(info.content, '""', `${tag}: không có vạch load dưới nút (::after content ${info.content})`);
  assert.equal(info.position, "absolute", `${tag}: vạch phải nằm tuyệt đối dưới nút`);
  assert.equal(info.height, 3, `${tag}: vạch cao ${info.height}px, cần 3px`);
  assert.ok(info.below, `${tag}: vạch phải nằm dưới mép nút`);
  assert.ok(info.hit, `${tag}: vạch bị cắt hoặc bị phần tử khác chồng lên`);
  assert.ok(Math.abs(info.track / info.btn - 1) <= 0.03, `${tag}: nền vạch rộng ${info.track.toFixed(1)}px, cần bằng bề rộng nút ${info.btn.toFixed(1)}px`);
  if (ratio === undefined) { assert.ok(info.animated, `${tag}: chưa có tiến độ thật thì đoạn vạch phải trượt qua lại`); assert.ok(Math.abs(info.fillOfTrack - 0.38) < 0.01, `${tag}: đoạn trượt chiếm ${(info.fillOfTrack * 100).toFixed(1)}%, cần 38%`); }
  else assert.ok(Math.abs(info.fill / info.btn - ratio) <= 0.05, `${tag}: vạch ${(info.fill / info.btn * 100).toFixed(1)}% bề rộng nút, cần ≈ ${ratio * 100}% ± 5%`);
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- 1) Người xem (chưa đăng nhập Admin): không có công cụ, không gọi Extension ----
    {
      const { context, page, errors } = await open(browser, { admin: false });
      assert.equal(await page.locator("#sc-admin-tools").isHidden(), true, "người xem không có nút đọc WMS");
      assert.equal(await page.locator("#site-control-screen .ss-hero").evaluate(h => h.getClientRects().length), 0, "1280px: người xem không thấy hero (không còn thẻ trắng rỗng)");
      assert.equal(await page.locator("#sc-admin").getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator("#sc-total").innerText(), "—");
      // Thẻ không còn chú thích giải thích (18/10/2026): câu cũ nằm ở title của thẻ; chỉ #sc-total-sub còn (số liệu "N SKU chưa lên kệ"), trống khi chưa có
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#site-control-screen .ia-metrics .ss-metric")].map(c => [...c.querySelectorAll("small")].map(s => s.id || "(không id)").join("|"))), ["sc-total-sub", "", "", ""], "chỉ ô đầu còn dòng nhỏ (số liệu), ba ô kia không có dòng nhỏ");
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#site-control-screen .ia-metrics .ss-metric")].map(c => c.title)), ["SKU trong app", "Tồn app khác tồn WMS", "Nhập app khác nhập WMS", "Xuất app khác xuất WMS"], "câu giải thích chuyển vào title của thẻ");
      assert.equal(await page.locator("#sc-total-sub").textContent(), "", "chưa đọc: không hiện câu \"SKU trong app\"");
      assert.equal(await page.locator("#sc-total-sub").evaluate(s => s.getClientRects().length), 0, "chưa đọc: dòng nhỏ trống không chiếm chỗ");
      assert.equal((await page.evaluate(() => window.__extCalls.filter(c => c.type !== "PING"))).length, 0, "không đọc WMS hay app khi chưa là Admin");
      assert.equal(await page.locator("#barcode-site-control").count(), 1, "ô trang chủ có mặt");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) Admin: đối chiếu rồi xem danh sách trong popup (không có bảng nằm sẵn), desktop rồi điện thoại ----
    for (const width of [1280, 375]) {
      const { context, page, errors, supabase } = await open(browser, { width });
      await page.locator("#sc-admin-tools").waitFor({ state: "visible" });
      await page.waitForFunction(() => /WMS và app xây dựng/.test(document.getElementById("sc-connection").textContent));
      // Chưa đối chiếu: các ô làm mờ và bấm không mở popup
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("button.ss-metric[data-sc-open]")].map(b => b.dataset.zero)), ["true", "true", "true", "true"]);
      await page.locator('button.ss-metric[data-sc-open="stock"]').first().click();
      assert.equal(await page.locator("#sc-list-dialog").evaluate(d => d.open), false, "chưa có kết quả thì ô không mở popup");
      // Khuôn nút đọc một kiểu (17/10/2026): .src-read, nhãn "Đọc WMS" (title nêu phạm vi), icon mask; máy tính: trạng thái Extension bên trái nút trên một hàng; điện thoại: nút rộng hết hero, cột đảo như cũ
      assert.deepEqual(await srcReadAudit(page, [{ id: "sc-run", classes: ["src-read"], text: "Đọc WMS", title: "Đọc WMS và app xây dựng" }], width), [], `${width}px: nút đọc WMS một kiểu`);
      const layout = await page.evaluate(() => {
        const hero = document.querySelector("#site-control-screen .ss-hero"), s = getComputedStyle(hero), box = hero.getBoundingClientRect(), c = document.getElementById("sc-connection").getBoundingClientRect(), b = document.getElementById("sc-run").getBoundingClientRect();
        return { inner: box.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth), runW: b.width, rowGap: Math.abs((c.top + c.height / 2) - (b.top + b.height / 2)), connRight: c.right, runLeft: b.left, runBottom: b.bottom, connTop: c.top };
      });
      if (width === 1280) { assert.ok(layout.connRight <= layout.runLeft + 1, "trạng thái Extension bên trái nút đọc"); assert.ok(layout.rowGap <= 4, `cùng một hàng (lệch ${layout.rowGap}px)`); }
      else { assert.ok(Math.abs(layout.runW - layout.inner) <= 2, `điện thoại: nút rộng hết hero (${layout.runW} / ${layout.inner})`); assert.ok(layout.runBottom <= layout.connTop, "điện thoại: nút trên, trạng thái Extension dưới (cột đảo)"); }
      // Đang đọc: giữ phản hồi Extension — data-busy, nhãn "Đang đọc…", icon đổi sang vòng xoay (động); đọc xong trả "Đọc WMS"
      const idleMask = await page.locator("#sc-run").evaluate(b => getComputedStyle(b, "::before").maskImage);
      assert.equal((await barInfo(page, "sc-run")).content, "none", "rảnh: không có vạch load dưới nút");
      assert.equal(await page.locator("#sc-progress").evaluate(n => n.getClientRects().length), 0, "rảnh: thanh tiến độ rời không hiện");
      await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
      await page.locator("#sc-run").click();
      await page.waitForFunction(() => document.getElementById("sc-run").dataset.busy === "true");
      assert.equal((await page.locator("#sc-run").innerText()).trim(), "Đang đọc…");
      assert.equal(await page.locator("#sc-run").isDisabled(), true, "đang đọc: nút khoá");
      assert.equal(await page.locator("#sc-run").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
      assert.notEqual(await page.locator("#sc-run").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
      expectBar(await barInfo(page, "sc-run"), `${width}px #sc-run đang đọc (chưa có trang nào: đoạn 38 % trượt qua lại)`);
      assert.equal(await page.locator("#sc-progress").evaluate(n => n.getClientRects().length), 0, "đang đọc: thanh tiến độ rời chạy ngang màn không còn hiện");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      await page.waitForFunction(() => document.getElementById("sc-total").textContent === "4");
      await page.waitForFunction(() => document.getElementById("sc-run").dataset.busy !== "true");
      assert.equal((await page.locator("#sc-run").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn cũ");
      assert.equal((await barInfo(page, "sc-run")).content, "none", "đọc xong: vạch load mất");
      assert.match(await page.locator("#sc-status").innerText(), /Đã đối chiếu 4 SKU tại OFFICE - 130 AP CHANH - MTG/);
      assert.equal(await page.locator("#sc-list-dialog").evaluate(d => d.open), false, "đối chiếu xong không tự mở popup");
      assert.equal(await page.locator("#site-control-screen .ia-content > .ss-panel").count(), 0, "không còn bảng nằm sẵn trên màn");
      assert.deepEqual(await page.evaluate(() => ["sc-stock", "sc-in", "sc-out"].map(id => document.getElementById(id).textContent)), ["2", "1", "2"], "lệch tồn / nhập / xuất");
      assert.deepEqual(await page.evaluate(() => ["stock", "in", "out"].map(k => document.getElementById(`sc-count-${k}`).textContent)), ["2", "1", "2"]);
      assert.match(await page.locator("#sc-total-sub").innerText(), /1 SKU chưa lên kệ/);
      assert.equal(await page.locator("#site-control-screen .ia-metrics .ss-metric").first().getAttribute("title"), "SKU trong app", "title của thẻ không bị ghi đè khi có số liệu");
      // Lệnh gửi sang Extension: app đọc stock + wmsImports; WMS đúng kho/công ty; kỳ bắt đầu 0 giờ ngày dòng nhập đầu tiên (giờ Việt Nam)
      const calls = await page.evaluate(() => window.__extCalls.filter(c => c.type !== "PING"));
      const names = calls.map(c => c.type + (c.payload.resource ? `:${c.payload.resource}` : ""));
      for (const wanted of ["PING_WMS", "PING_HCM", "GET_HCM_DATA:stock", "GET_HCM_DATA:wmsImports", "GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_INVENTORY_PAGE", "GET_STOCK_IMPORT_EXPORT_PAGE"]) assert.ok(names.includes(wanted), `thiếu lệnh ${wanted}`);
      assert.deepEqual(calls.find(c => c.type === "GET_SKU_COUNT_WAREHOUSES").payload.warehouseNames, ["OFFICE - 130 AP CHANH - MTG"]);
      const inv = calls.find(c => c.type === "GET_SKU_COUNT_INVENTORY_PAGE").payload, mov = calls.find(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").payload;
      assert.deepEqual([inv.warehouseIds, inv.companyId, mov.warehouseIds, mov.companyId], [[1151], 1002, [1151], 1002]);
      assert.equal(new Date(mov.from).toISOString(), "2026-07-01T17:00:00.000Z", "kỳ bắt đầu 0 giờ 02/07/2026 giờ Việt Nam");
      assert.ok(mov.to >= mov.from, "kỳ có điểm cuối");
      assert.deepEqual(supabase, [], "không lưu hay đọc gì từ Supabase");
      const skus = () => page.locator("#sc-body tr[data-sc-key] code").allInnerTexts();
      const openTile = async (tab, diff) => { await page.locator(`button.ss-metric[data-sc-open="${tab}"][data-sc-diff="${diff}"]`).click(); await page.locator("#sc-list-dialog").waitFor({ state: "visible" }); };
      // Ô Lệch tồn: popup mở sẵn với bộ lọc Lệch, tồn lệch nhiều nhất trước
      await openTile("stock", 1);
      assert.equal(await page.locator("#sc-l-title").innerText(), "Tồn kho");
      assert.equal(await page.locator('#sc-tags .as-tag[data-as-tag="diff"]').getAttribute("aria-pressed"), "true", "ô lệch mở với bộ lọc Lệch bật sẵn");
      assert.deepEqual(await skus(), ["900000002", "900000003"]);
      assert.equal(await page.locator("#sc-head th").count(), 7);
      assert.equal(await page.locator("#sc-body tr[data-sc-key]").first().innerText().then(t => /Chưa lên kệ/.test(t) && /Lệch/.test(t)), true, "SKU nằm ở vị trí ảo có nhãn Chưa lên kệ");
      // Chuyển tab ngay trong popup, bộ lọc giữ nguyên
      await page.locator('.as-tab[data-sc-tab="in"]').click();
      assert.deepEqual(await skus(), ["900000004"], "tab Nhập: chỉ SKU thiếu dòng nhập ở app");
      assert.match(await page.locator("#sc-body tr[data-sc-key]").first().innerText(), /WMS có, app thiếu 1/);
      await page.locator('.as-tab[data-sc-tab="out"]').click();
      assert.deepEqual(await skus(), ["900000002", "900000003"], "tab Xuất: hai SKU xuất lệch");
      assert.match(await page.locator('#sc-body tr[data-sc-key="900000003"]').innerText(), /83/, "xuất kiểm kê hiện ở cột WMS khác, không tính vào so sánh");
      await page.locator('#sc-tags .as-tag[data-as-tag="diff"]').click();
      assert.deepEqual(await skus(), ["900000002", "900000003", "900000001", "900000004"], "tắt lọc Lệch thì thấy cả SKU khớp, lệch trước");
      assert.equal((await page.locator("#sc-body").innerText()).includes("999999999"), false, "SKU ngoài danh sách app không vào bảng");
      // Chi tiết xếp chồng trên popup danh sách; Esc đóng chi tiết, popup danh sách còn
      await page.locator('#sc-body tr[data-sc-key="900000002"]').click();
      assert.equal(await page.locator("#sc-dialog").evaluate(d => d.open), true, "bấm dòng mở chi tiết");
      assert.equal(await page.locator("#sc-list-dialog").evaluate(d => d.open), true, "popup danh sách vẫn mở bên dưới");
      assert.equal(await page.locator("#sc-d-title").innerText(), "900000002");
      const detail = await page.locator("#sc-dialog").innerText();
      assert.ok(detail.includes("F0-A0-00-00-00-00") && detail.includes("Chưa lên kệ"), "chi tiết liệt kê vị trí và nhãn chưa lên kệ");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#sc-dialog").evaluate(d => d.open), false);
      assert.equal(await page.locator("#sc-list-dialog").evaluate(d => d.open), true, "Esc chỉ đóng chi tiết");
      if (width === 1280) {
        await page.locator('.as-tab[data-sc-tab="in"]').click();
        await page.locator('#sc-body tr[data-sc-key="900000004"]').click();
        assert.ok((await page.locator("#sc-dialog").innerText()).includes("P4B"), "chi tiết nêu dòng nhập WMS mà app chưa có");
        await page.keyboard.press("Escape");
        await page.locator("#sc-tools input").fill("cat mau");
        assert.deepEqual(await skus(), ["900000004"], "tìm không dấu theo tên sản phẩm");
        await page.locator("#sc-tools input").fill("");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#sc-tools [data-as-export]").click()]);
        assert.match(download.suggestedFilename(), /^kiem-soat-cong-trinh-in-.*\.xlsx$/);
      } else {
        assert.equal(await page.locator(".sc-table thead").isVisible(), false, "điện thoại: bảng trong popup thành thẻ");
        const box = await page.locator("#sc-body tr[data-sc-key]").first().boundingBox();
        assert.ok(box && box.width <= 375, "thẻ nằm trong khung điện thoại");
        const sheet = await page.locator("#sc-list-dialog").boundingBox();
        assert.ok(sheet && sheet.width <= 375 && sheet.x >= 0, "popup là tờ trượt vừa khung điện thoại");
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#sc-list-dialog").evaluate(d => d.open), false, "Esc đóng popup danh sách");
      // Ô SKU theo dõi: mở đủ mọi dòng, không lọc sẵn
      await openTile("stock", 0);
      assert.equal(await page.locator('#sc-tags .as-tag[data-as-tag="diff"]').getAttribute("aria-pressed"), "false");
      assert.equal((await skus()).length, 4);
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.equal(await page.locator("#sc-run").isDisabled(), false, "nút dùng lại được sau khi xong");
      // Tiến độ thật theo trang (18/10/2026): tồn kho WMS đọc 2 trang, trang 2 bị giữ → sau trang 1/2 vạch dưới nút tô ≈ 50 % bề rộng nút (biến --p); đọc xong thì vạch mất
      await page.evaluate(() => { window.__two = true; window.__hold2 = new Promise(resolve => { window.__release2 = resolve; }); });
      await page.locator("#sc-run").click();
      await page.waitForFunction(() => document.getElementById("sc-run").style.getPropertyValue("--p") === "0.5");
      await page.waitForTimeout(400);
      expectBar(await barInfo(page, "sc-run"), `${width}px #sc-run sau trang 1/2`, 0.5);
      assert.equal(await page.locator("#sc-progress").evaluate(n => n.getClientRects().length), 0, "tiến độ thật: thanh rời vẫn không hiện");
      await page.evaluate(() => { window.__release2(); window.__hold2 = null; });
      await page.waitForFunction(() => document.getElementById("sc-run").dataset.busy !== "true");
      await page.evaluate(() => { window.__two = false; });
      assert.equal((await barInfo(page, "sc-run")).content, "none", "đọc xong: vạch load mất");
      assert.equal(await page.locator("#sc-run").evaluate(b => b.style.getPropertyValue("--p")), "", "đọc xong: bỏ biến --p");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3) Lỗi: thiếu tab app xây dựng, thiếu quyền kho, app hết phiên; không đọc dữ liệu khi chưa đủ điều kiện ----
    {
      const { context, page, errors } = await open(browser, { options: { fail: { PING_HCM: "Hãy mở tab app xây dựng và đăng nhập trước" } } });
      await page.locator("#sc-admin-tools").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.getElementById("sc-connection").dataset.state === "error");
      assert.match(await page.locator("#sc-connection").innerText(), /Chưa kết nối app xây dựng/);
      await page.locator("#sc-run").click();
      await page.waitForFunction(() => document.getElementById("sc-status").dataset.tone === "error");
      assert.match(await page.locator("#sc-status").innerText(), /tab app xây dựng/);
      assert.equal((await page.evaluate(() => window.__extCalls.filter(c => c.type.startsWith("GET_")))).length, 0, "chưa nối được app thì không đọc gì");
      assert.equal(await page.locator("#sc-total").innerText(), "—");
      assert.equal(await page.locator("#sc-run").isDisabled(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      const { context, page } = await open(browser, { options: { noWarehouse: true } });
      await page.locator("#sc-admin-tools").waitFor({ state: "visible" });
      await page.locator("#sc-run").click();
      await page.waitForFunction(() => document.getElementById("sc-status").dataset.tone === "error");
      assert.match(await page.locator("#sc-status").innerText(), /không có quyền xem OFFICE - 130 AP CHANH - MTG/);
      assert.equal(await page.locator("#sc-total").innerText(), "—", "không hiện kết quả khi không xác định được kho");
      await context.close();
    }
    {
      const { context, page } = await open(browser, { options: { fail: { GET_HCM_DATA: "Phiên app xây dựng đã hết hạn; hãy đăng nhập lại trong tab app" } } });
      await page.locator("#sc-admin-tools").waitFor({ state: "visible" });
      await page.locator("#sc-run").click();
      await page.waitForFunction(() => document.getElementById("sc-status").dataset.tone === "error");
      assert.match(await page.locator("#sc-status").innerText(), /hết hạn/);
      assert.equal(await page.locator("#sc-total").innerText(), "—");
      await context.close();
    }

    // ---- 4) Logic đối chiếu: khớp từng dòng nhập, SKU ngoài app bị bỏ, xuất khác tách riêng ----
    {
      const { context, page } = await open(browser, { admin: false });
      const out = await page.evaluate(fixture => {
        const r = window.HasakiSiteControl.reconcile({ stock: fixture.stock, imports: fixture.imports, inventory: fixture.inventory, moves: fixture.moves });
        return { n: r.rows.length, summary: r.summary, rows: Object.fromEntries(r.rows.map(x => [x.sku, { st: x.status, sd: x.stockDiff, id: x.inDiff, od: x.outDiff, un: x.unplaced, miss: x.missingInApp.map(l => `${l.source}:${l.qty}`), other: x.wmsOutOther }])) };
      }, FIXTURE);
      assert.equal(out.n, 4);
      assert.deepEqual(out.summary, { total: 4, stock: 2, in: 1, out: 2, flowOnly: 1, clean: 1, unplaced: 1 });
      assert.deepEqual(out.rows["900000002"], { st: { stock: "diff", in: "ok", out: "diff" }, sd: -192, id: 0, od: 192, un: 192, miss: [], other: 0 });
      assert.deepEqual(out.rows["900000003"], { st: { stock: "diff", in: "ok", out: "diff" }, sd: 136, id: 0, od: -53, un: 0, miss: [], other: 83 });
      assert.deepEqual(out.rows["900000004"].miss, ["P4B:15"]);
      assert.deepEqual(out.rows["900000001"].st, { stock: "ok", in: "ok", out: "ok" });
      await context.close();
    }
    console.log("site_control_browser: người xem + Admin đối chiếu, danh sách tồn/nhập/xuất trong popup (ô số liệu mở popup, chi tiết xếp chồng), lệnh Extension đúng kho và kỳ, không đụng Supabase, lọc/tìm/Excel, tờ trượt trên điện thoại, các lỗi kết nối passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
