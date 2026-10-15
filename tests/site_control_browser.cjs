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
  addEventListener("message", event => {
    const r = event.data;
    if (!r || r.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: r.type, payload: r.payload });
    const reply = (ok, data, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok, data, error }, location.origin);
    const p = r.payload || {};
    if (options.fail?.[r.type]) return reply(false, undefined, { code: "MOCK", message: options.fail[r.type] });
    switch (r.type) {
      case "GET_HCM_DATA": return reply(true, p.resource === "stock"
        ? { resource: "stock", rows: fixture.stock, total: fixture.stock.length, generatedAt: new Date(Date.now() - 120000).toISOString() }
        : { resource: "wmsImports", rows: fixture.imports, total: fixture.imports.length, generatedAt: new Date().toISOString() });
      case "GET_SKU_COUNT_WAREHOUSES": return reply(true, { warehouses: options.noWarehouse ? [] : [fixture.warehouse], missingNames: options.noWarehouse ? ["OFFICE - 130 AP CHANH - MTG"] : [] });
      case "GET_SKU_COUNT_INVENTORY_PAGE": return reply(true, { page: 1, size: 500, total: fixture.inventory.length, totalPages: 1, rows: fixture.inventory });
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

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- 1) Người xem (chưa đăng nhập Admin): không có công cụ, không gọi Extension ----
    {
      const { context, page, errors } = await open(browser, { admin: false });
      assert.equal(await page.locator("#sc-admin-tools").isHidden(), true, "người xem không có nút Đối chiếu");
      assert.equal(await page.locator("#sc-admin").getAttribute("aria-pressed"), "false");
      assert.equal(await page.locator("#sc-total").innerText(), "—");
      assert.equal((await page.evaluate(() => window.__extCalls.filter(c => c.type !== "PING"))).length, 0, "không đọc WMS hay app khi chưa là Admin");
      assert.equal(await page.locator("#barcode-site-control").count(), 1, "ô trang chủ có mặt");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) Admin: đối chiếu đủ ba nội dung, desktop rồi điện thoại ----
    for (const width of [1280, 375]) {
      const { context, page, errors, supabase } = await open(browser, { width });
      await page.locator("#sc-admin-tools").waitFor({ state: "visible" });
      await page.waitForFunction(() => /WMS và app xây dựng/.test(document.getElementById("sc-connection").textContent));
      await page.locator("#sc-run").click();
      await page.waitForFunction(() => document.getElementById("sc-total").textContent === "4");
      assert.match(await page.locator("#sc-status").innerText(), /Đã đối chiếu 4 SKU tại OFFICE - 130 AP CHANH - MTG/);
      assert.deepEqual(await page.evaluate(() => ["sc-stock", "sc-in", "sc-out"].map(id => document.getElementById(id).textContent)), ["2", "1", "2"], "lệch tồn / nhập / xuất");
      assert.deepEqual(await page.evaluate(() => ["stock", "in", "out"].map(k => document.getElementById(`sc-count-${k}`).textContent)), ["2", "1", "2"]);
      assert.match(await page.locator("#sc-total-sub").innerText(), /1 SKU chưa lên kệ/);
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
      if (width === 1280) {
        const skus = () => page.locator("#sc-body tr[data-sc-key] code").allInnerTexts();
        assert.deepEqual(await skus(), ["900000002", "900000003", "900000001", "900000004"], "tồn lệch xếp trước, theo độ lệch giảm dần");
        assert.equal(await page.locator("#sc-head th").count(), 7);
        assert.equal(await page.locator("#sc-body tr[data-sc-key]").first().innerText().then(t => /Chưa lên kệ/.test(t) && /Lệch/.test(t)), true, "SKU nằm ở vị trí ảo có nhãn Chưa lên kệ");
        assert.equal((await page.locator("#sc-body").innerText()).includes("999999999"), false, "SKU ngoài danh sách app không vào bảng");
        await page.locator('.as-tab[data-sc-tab="in"]').click();
        assert.deepEqual(await skus(), ["900000004", "900000001", "900000002", "900000003"], "tab Nhập: SKU thiếu dòng nhập ở app đứng đầu");
        assert.match(await page.locator("#sc-body tr[data-sc-key]").first().innerText(), /WMS có, app thiếu 1/);
        await page.locator('.as-tab[data-sc-tab="out"]').click();
        assert.deepEqual(await skus(), ["900000002", "900000003", "900000001", "900000004"], "tab Xuất: lệch nhiều nhất trước");
        assert.match(await page.locator('#sc-body tr[data-sc-key="900000003"]').innerText(), /83/, "xuất kiểm kê hiện ở cột WMS khác, không tính vào so sánh");
        await page.locator('button.ss-metric[data-sc-tab="stock"]').click();
        assert.equal(await page.locator('.as-tab[data-sc-tab="stock"]').getAttribute("aria-selected"), "true", "bấm thẻ Lệch tồn chuyển sang tab Tồn kho");
        await page.locator("#sc-tags .as-tag", { hasText: "Lệch" }).click();
        assert.deepEqual(await skus(), ["900000002", "900000003"], "lọc chỉ SKU lệch");
        await page.locator("#sc-tags .as-tag", { hasText: "Lệch" }).click();
        await page.locator("#sc-tools input").fill("cu tram");
        assert.deepEqual(await skus(), ["900000002"], "tìm không dấu theo tên sản phẩm");
        await page.locator("#sc-tools input").fill("");
        await page.locator('#sc-body tr[data-sc-key="900000002"]').click();
        assert.equal(await page.locator("#sc-dialog").evaluate(d => d.open), true, "bấm dòng mở chi tiết");
        assert.equal(await page.locator("#sc-d-title").innerText(), "900000002");
        const detail = await page.locator("#sc-dialog").innerText();
        assert.ok(detail.includes("F0-A0-00-00-00-00") && detail.includes("Chưa lên kệ"), "chi tiết liệt kê vị trí và nhãn chưa lên kệ");
        await page.keyboard.press("Escape");
        await page.locator('.as-tab[data-sc-tab="in"]').click();
        await page.locator('#sc-body tr[data-sc-key="900000004"]').click();
        assert.ok((await page.locator("#sc-dialog").innerText()).includes("P4B"), "chi tiết nêu dòng nhập WMS mà app chưa có");
        await page.keyboard.press("Escape");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#sc-tools [data-as-export]").click()]);
        assert.match(download.suggestedFilename(), /^kiem-soat-cong-trinh-in-.*\.xlsx$/);
      } else {
        assert.equal(await page.locator(".sc-table thead").isVisible(), false, "điện thoại: bảng thành thẻ");
        const box = await page.locator("#sc-body tr[data-sc-key]").first().boundingBox();
        assert.ok(box && box.width <= 375, "thẻ nằm trong khung điện thoại");
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.equal(await page.locator("#sc-run").isDisabled(), false, "nút dùng lại được sau khi xong");
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
    console.log("site_control_browser: người xem + Admin đối chiếu tồn/nhập/xuất, lệnh Extension đúng kho và kỳ, không đụng Supabase, lọc/tìm/chi tiết/Excel, thẻ trên điện thoại, các lỗi kết nối passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
