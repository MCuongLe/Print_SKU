// Dashboard kiểm kê: chạy với python -m http.server 8000; WMS/Extension/Supabase đều giả lập, không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";

const mockExtension = () => addEventListener("message", event => {
  const r = event.data;
  if (!r || r.source !== "PRINT_SKU_APP") return;
  let data;
  if (r.type === "PING_WMS") data = { version: "0.6.0" };
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

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
      await context.addInitScript(mockExtension);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => {
        const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
        if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
        return json({ ok: true, data: [] });
      });
      await page.goto(BASE + "#admin/kiem-ke");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.locator("#ia-run").click();
      await page.waitForFunction(() => document.getElementById("ia-total").textContent === "3");
      assert.equal(await page.locator("#ia-never").innerText(), "1");
      assert.equal(await page.locator("#ia-recent").innerText(), "1");
      assert.equal(await page.locator("#ia-overdue").innerText(), "1");
      assert.match(await page.locator("#ia-status").innerText(), /MTG.*Garment/);
      assert.equal(await page.locator("#ia-body tr").count(), 2, "mặc định chỉ hiện SKU cần kiểm kê");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${width}px không được tràn ngang`);
      if (width === 1280) {
        const rows = () => page.locator("#ia-body tr[data-ia-key]"), skus = () => page.locator("#ia-body tr[data-ia-key] code").allInnerTexts();
        assert.deepEqual(await skus(), ["SKU-NEVER", "SKU-OLD"], "chưa kiểm kê đứng trước, rồi đến quá hạn");
        assert.deepEqual(await page.evaluate(() => ["action", "never", "overdue", "recent", "all"].map(k => document.getElementById(`ia-count-${k}`).textContent)), ["2", "1", "1", "1", "3"]);
        assert.match(await page.locator("#ia-run").evaluate(el => getComputedStyle(el).display), /flex/, "nút đọc WMS có icon cùng hàng với chữ");
        assert.equal(await page.locator("#ia-head th").count(), 7, "7 cột, không còn cột Chi tiết");
        assert.equal(await page.locator(".ia-table").evaluate(t => t.parentElement.scrollWidth <= t.parentElement.clientWidth), true, "bảng vừa khung, không cuộn ngang");
        await page.locator('[data-ia-tab="all"]').click();
        assert.equal(await page.locator('[data-ia-tab="all"]').getAttribute("aria-selected"), "true");
        assert.equal(await rows().count(), 3);
        await page.locator('button.ss-metric[data-ia-status="recent"]').click();
        assert.deepEqual(await skus(), ["SKU-RECENT"], "bấm thẻ Trong 30 ngày lọc đúng nhóm");
        assert.equal(await page.locator("#ia-list-title").innerText(), "Trong 30 ngày");
        await page.locator('[data-ia-tab="all"]').click();
        await page.locator("#ia-tools input").fill("vai cu");
        assert.deepEqual(await skus(), ["SKU-OLD"], "tìm không dấu theo tên sản phẩm");
        await page.locator("#ia-tools input").fill("");
        await page.locator('[data-as-facet="wh"] .as-facet-btn').click();
        assert.equal(await page.locator(".as-opt").count(), 2, "lọc Kho có đúng hai kho");
        await page.locator(".as-opt", { hasText: "GARMENT" }).click();
        assert.deepEqual(await skus(), ["SKU-NEVER"], "lọc theo kho GARMENT");
        await page.locator("[data-as-clear]").click();
        assert.equal(await rows().count(), 3);
        await page.keyboard.press("Escape");
        await page.locator('[data-as-sort="qty"]').click();
        assert.deepEqual(await skus(), ["SKU-RECENT", "SKU-OLD", "SKU-NEVER"], "bấm Tồn lần đầu sắp giảm dần");
        await rows().first().click();
        assert.equal(await page.locator("#ia-dialog").evaluate(d => d.open), true, "bấm dòng mở chi tiết");
        assert.equal(await page.locator("#ia-d-title").innerText(), "SKU-RECENT");
        assert.equal(await page.locator("#ia-d-locs .ia-locrow").count(), 1);
        assert.equal((await page.locator("#ia-d-locs").innerText()).includes("A-01"), true);
        assert.equal(await page.locator("#ia-dialog").evaluate(d => d.offsetHeight < 600), true, "hộp chi tiết co theo nội dung");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#ia-dialog").evaluate(d => d.open), false);
        await rows().nth(1).focus();
        await page.keyboard.press("Enter");
        assert.equal(await page.locator("#ia-d-title").innerText(), "SKU-OLD", "Enter trên dòng mở chi tiết");
        await page.keyboard.press("Escape");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#ia-tools [data-as-export]").click()]);
        assert.equal(download.suggestedFilename().startsWith("kiem-ke-sku-"), true);
        const csv = require("node:fs").readFileSync(await download.path(), "utf8");
        assert.equal(csv.charCodeAt(0), 0xfeff);
        assert.equal(csv.trim().split(String.fromCharCode(13, 10)).length, 4, "tiêu đề + 3 dòng");
        assert.equal(csv.includes("SKU-NEVER") && csv.includes("Chưa kiểm kê"), true);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("inventory_audit_browser: two companies, 3 statuses, tabs, filters, sort, detail dialog, CSV and responsive layout passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
