// KIỂM KÊ SKU (ô trang chủ, #inventory-audit): mọi người xem bản chụp đã lưu, chỉ Admin đồng bộ từ WMS.
// Chạy với python -m http.server 8000; WMS/Extension/Supabase đều giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const DAY = 86400000;

const mockExtension = () => addEventListener("message", event => {
  const r = event.data;
  if (!r || r.source !== "PRINT_SKU_APP") return;
  let data;
  if (r.type === "PING_WMS") data = { version: "0.6.1" };
  else if (r.type === "GET_SKU_COUNT_WAREHOUSES") data = { warehouses: [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty Mastige" },
    { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyId: 1005, companyName: "Cty Garment" },
  ], missingNames: [] };
  else if (r.type === "GET_SKU_COUNT_APPROVED_PAGE") data = { page: 1, size: 500, total: 2, totalPages: 1, rows: r.payload.warehouseIds[0] === 1177 ? [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-RECENT", productName: "Vải gần đây", approvedAt: new Date(Date.now() - 10 * 86400000).toISOString(), approvedBy: "manager@hasaki.vn" },
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-OLD", productName: "Vải cũ", approvedAt: new Date(Date.now() - 45 * 86400000).toISOString(), approvedBy: "manager@hasaki.vn" },
  ] : [] };
  else if (r.type === "GET_SKU_COUNT_INVENTORY_PAGE") data = { page: 1, size: 500, total: r.payload.warehouseIds[0] === 1177 ? 2 : 1, totalPages: 1, rows: r.payload.warehouseIds[0] === 1177 ? [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-RECENT", productName: "Vải gần đây", location: "A-01", qty: 5, uom: "m" },
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-OLD", productName: "Vải cũ", location: "A-02", qty: 3, uom: "m" },
  ] : [{ warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", sku: "SKU-NEVER", productName: "Chỉ chưa kiểm", location: "G-01", qty: 2, uom: "cuộn" }] };
  else data = {};
  postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok: true, data }, location.origin);
});

// Bản chụp đã lưu sẵn trên "máy chủ" giả: đủ ba tình trạng. Phân nhóm tính lúc xem nên dùng ngày tương đối.
const seededSnapshot = () => ({
  run: { id: "run-1", readAt: new Date(Date.now() - 3 * 3600000).toISOString(), thresholdDays: 30, rowCount: 3, missing: [], sourceCounts: {},
    warehouses: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyName: "Cty Mastige" }, { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyName: "Cty Garment" }] },
  rows: [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-RECENT", productName: "Vải gần đây", qty: 5, uom: "m", locations: [{ location: "A-01", qty: 5 }], lastApprovedAt: new Date(Date.now() - 10 * DAY).toISOString(), lastApprovedBy: "manager@hasaki.vn" },
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-OLD", productName: "Vải cũ", qty: 3, uom: "m", locations: [{ location: "A-02", qty: 3 }], lastApprovedAt: new Date(Date.now() - 45 * DAY).toISOString(), lastApprovedBy: "manager@hasaki.vn" },
    { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", sku: "SKU-NEVER", productName: "Chỉ chưa kiểm", qty: 2, uom: "cuộn", locations: [{ location: "G-01", qty: 2 }], lastApprovedAt: null, lastApprovedBy: null },
  ],
});

// Máy chủ giả có trạng thái: lưu lượt đồng bộ (start → chunk → finish) và trả lại qua sku_count_overview.
const makeBackend = (initial = null) => {
  const state = { snapshot: initial, pending: null, calls: [] };
  const handle = (route, isAdmin) => {
    const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
    const body = JSON.parse(route.request().postData() || "{}"), bearer = route.request().headers().authorization || "";
    state.calls.push({ rpc, body, admin: /test-admin-token/.test(bearer) });
    if (rpc === "sku_count_overview") return json({ ok: true, data: state.snapshot || { run: null, rows: [] } });
    if (rpc.startsWith("sku_count_save_") && !/test-admin-token/.test(bearer)) return json({ ok: false, error: { code: "FORBIDDEN", message: "Chỉ Admin được đồng bộ kiểm kê" } });
    if (rpc === "sku_count_save_start") { state.pending = { meta: body, rows: [] }; return json({ ok: true, data: { runId: "run-new" } }); }
    if (rpc === "sku_count_save_chunk") { assert.ok(body.p_rows.length >= 1 && body.p_rows.length <= 500, "mỗi đợt ghi 1–500 dòng"); state.pending.rows.push(...body.p_rows); return json({ ok: true, data: { saved: body.p_rows.length } }); }
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

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- 1) Người xem (chưa đăng nhập Admin): xem bản chụp, không có công cụ đồng bộ ----
    for (const width of [1280, 375]) {
      const backend = makeBackend(seededSnapshot());
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(mockExtension);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.getElementById("ia-total").textContent === "3");
      assert.equal(await page.locator("#ia-never").innerText(), "1");
      assert.equal(await page.locator("#ia-recent").innerText(), "1");
      assert.equal(await page.locator("#ia-overdue").innerText(), "1");
      assert.equal(await page.locator("#ia-admin-tools").isHidden(), true, "người xem không có nút đồng bộ WMS");
      assert.equal(await page.locator("#ia-admin").getAttribute("aria-pressed"), "false");
      assert.deepEqual(backend.state.calls.map(c => c.rpc), ["sku_count_overview"], "người xem chỉ đọc bản chụp, không gọi Extension hay ghi");
      assert.equal(backend.state.calls[0].admin, false, "đọc bằng khoá công khai");
      assert.equal(await page.locator("#ia-body tr").count(), 2, "mặc định chỉ hiện SKU cần kiểm kê");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      if (width === 1280) {
        const rows = () => page.locator("#ia-body tr[data-ia-key]"), skus = () => page.locator("#ia-body tr[data-ia-key] code").allInnerTexts();
        assert.deepEqual(await skus(), ["SKU-NEVER", "SKU-OLD"], "chưa kiểm kê đứng trước, rồi đến quá hạn");
        assert.deepEqual(await page.evaluate(() => ["action", "never", "overdue", "recent", "all"].map(k => document.getElementById(`ia-count-${k}`).textContent)), ["2", "1", "1", "1", "3"]);
        assert.equal(await page.locator("#ia-head th").count(), 7, "7 cột");
        assert.equal(await page.locator(".ia-table").evaluate(t => t.parentElement.scrollWidth <= t.parentElement.clientWidth), true, "bảng vừa khung, không cuộn ngang");
        await page.locator('[data-ia-tab="all"]').click();
        assert.equal(await rows().count(), 3);
        await page.locator('button.ss-metric[data-ia-status="recent"]').click();
        assert.deepEqual(await skus(), ["SKU-RECENT"], "bấm thẻ Trong 30 ngày lọc đúng nhóm");
        await page.locator('[data-ia-tab="all"]').click();
        await page.locator("#ia-tools input").fill("vai cu");
        assert.deepEqual(await skus(), ["SKU-OLD"], "tìm không dấu theo tên sản phẩm");
        await page.locator("#ia-tools input").fill("");
        await page.locator('[data-as-sort="qty"]').click();
        assert.deepEqual(await skus(), ["SKU-RECENT", "SKU-OLD", "SKU-NEVER"], "bấm Tồn lần đầu sắp giảm dần");
        await rows().first().click();
        assert.equal(await page.locator("#ia-dialog").evaluate(d => d.open), true, "bấm dòng mở chi tiết");
        assert.equal(await page.locator("#ia-d-title").innerText(), "SKU-RECENT");
        assert.equal((await page.locator("#ia-d-locs").innerText()).includes("A-01"), true);
        await page.keyboard.press("Escape");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#ia-tools [data-as-export]").click()]);
        assert.match(download.suggestedFilename(), /^kiem-ke-sku-.*\.xlsx$/);
        // Mốc 30 ngày tính lúc xem: đổi giờ máy lên 20 ngày thì SKU-RECENT (10 ngày) thành quá hạn mà không cần đồng bộ lại
        await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 21 * 86400000; });
        await page.evaluate(() => window.HasakiInventoryAuditDashboard.load());
        assert.equal(await page.locator("#ia-recent").innerText(), "0", "phân nhóm theo giờ lúc xem");
        assert.equal(await page.locator("#ia-overdue").innerText(), "2");
      } else {
        assert.equal(await page.locator(".ia-table thead").isVisible(), false, "điện thoại: bảng thành thẻ, không có hàng tiêu đề");
        const box = await page.locator("#ia-body tr[data-ia-key]").first().boundingBox();
        assert.ok(box && box.width <= 375, "thẻ nằm trong khung điện thoại");
        assert.equal(await page.locator("#ia-admin").isVisible(), true, "nút đăng nhập Admin ở thanh trên");
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) Chưa có bản đồng bộ nào ----
    {
      const backend = makeBackend(null), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => /Chưa có bản đồng bộ/.test(document.getElementById("ia-status").textContent));
      assert.equal(await page.locator("#ia-total").innerText(), "—");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3) Đường dẫn cũ #admin/kiem-ke chuyển sang màn mới ngay từ đầu trang, không bật hộp đăng nhập Admin ----
    {
      const backend = makeBackend(seededSnapshot()), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#admin/kiem-ke");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => location.hash), "#inventory-audit");
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("admin-auth-lock")), false, "không khoá trang chờ đăng nhập Admin");
      await context.close();
    }

    // ---- 4) Admin: đọc WMS rồi lưu bản chụp; người xem sau đó thấy đúng bản đó ----
    for (const width of [1280, 375]) {
      const backend = makeBackend(null), context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
      await context.addInitScript(mockExtension);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.locator("#ia-admin-tools").waitFor({ state: "visible" });
      assert.equal(await page.locator("#ia-admin").getAttribute("aria-pressed"), "true");
      await page.waitForFunction(() => /WMS sẵn sàng/.test(document.getElementById("ia-connection").textContent));
      await page.locator("#ia-run").click();
      await page.waitForFunction(() => document.getElementById("ia-total").textContent === "3");
      assert.match(await page.locator("#ia-status").innerText(), /Đã đồng bộ.*MTG.*Garment/);
      assert.deepEqual(backend.state.calls.filter(c => c.rpc.startsWith("sku_count_")).map(c => c.rpc),
        ["sku_count_overview", "sku_count_save_start", "sku_count_save_chunk", "sku_count_save_finish", "sku_count_overview"], "đọc → bắt đầu → ghi → chốt → đọc lại");
      assert.equal(backend.state.calls.find(c => c.rpc === "sku_count_save_start").admin, true, "ghi bằng phiên Admin");
      assert.equal(backend.state.calls.at(-1).admin, false, "đọc lại bằng khoá công khai như mọi người");
      const saved = backend.state.snapshot.rows;
      assert.deepEqual(saved.map(r => r.sku).sort(), ["SKU-NEVER", "SKU-OLD", "SKU-RECENT"]);
      assert.equal(saved.find(r => r.sku === "SKU-NEVER").lastApprovedAt, null, "chưa kiểm kê lưu ngày rỗng");
      assert.equal(typeof saved.find(r => r.sku === "SKU-OLD").qty, "number");
      assert.equal(await page.locator("#ia-run").isDisabled(), false, "nút dùng lại được sau khi xong");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("inventory_audit_browser: người xem + Admin đồng bộ, bản chụp lưu qua Supabase giả, mốc 30 ngày tính lúc xem, đường dẫn cũ, thẻ trên điện thoại, lọc/sắp xếp/chi tiết/Excel passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
