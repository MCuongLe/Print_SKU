// Cổng in chung: máy chủ đặt lại tên SKU theo database (print_name_from_db_v1) và trả data.renamed (18/10/2026,
// docs/plans/2026-10-18-danh-muc-sku-tren-may.md, Việc 4). PrintSkuQueue.enqueue — đường in của MỌI màn (cả bundle React qua lệnh pr_them):
//   * renamed có dòng → danh mục trên máy nhận tên mới (PrintSkuCatalog.patchNames), sự kiện print-sku-names-updated, thông báo ngắn
//     "Tên đã cập nhật" kèm mã SKU (role=status, tự ẩn);
//   * lệnh trùng / không đổi tên / máy chủ chưa có migration (không có renamed) → không thông báo.
// Supabase giả lập, dữ liệu giả 9000009xx. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const CATALOG = [{ sku: "900000901", product_name: "Tên cũ trên máy", status: "1" }, { sku: "900000902", product_name: "Chỉ giả", status: "1" }];

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage(), errors = [], srv = { reply: null };
      page.on("pageerror", e => errors.push(e.message));
      await page.route("**/*", route => {
        const url = route.request().url(), json = (b, headers = {}) => route.fulfill({ contentType: "application/json", headers, body: JSON.stringify(b) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes("/rest/v1/SKU_Name?") && url.includes("order=sku.asc")) return json(CATALOG, { "content-range": `0-1/2` });
        if (url.includes("/rpc/sku_catalog_changes")) return json({ ok: true, data: { version: { activeCount: 2, maxUpdatedAt: "2026-10-18T01:00:00+00:00" }, tooMany: true, upserts: [], removed: [] } });
        if (url.includes("/rpc/print_enqueue")) return json(srv.reply);
        if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
        return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
      });
      await page.goto(BASE + "#worker");
      await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
      const send = () => page.evaluate(async () => {
        window.__renamedEvents = window.__renamedEvents || [];
        if (!window.__listening) { window.__listening = true; addEventListener("print-sku-names-updated", e => window.__renamedEvents.push(e.detail)); }
        const r = await window.PrintSkuQueue.enqueue({ type: "sku", copies: 1, requestedBy: "test", payload: { items: [{ sku: "900000901", productName: "Tên cũ trên máy", quantity: "2", printedDate: "18-10-26", copies: 1 }] } });
        return r?.ok;
      });
      const note = page.locator("#sku-name-note");
      // 1) Máy chủ chưa có migration (không có renamed) → không thông báo
      srv.reply = { ok: true, data: { id: "job-1", status: "queued", duplicate: false } };
      assert.equal(await send(), true);
      await page.waitForTimeout(300);
      assert.equal(await note.isVisible().catch(() => false), false, "không có renamed → không thông báo");
      // 2) Máy chủ thay tên → thông báo + danh mục trên máy + sự kiện
      srv.reply = { ok: true, data: { id: "job-2", status: "queued", duplicate: false, renamed: [{ sku: "900000901", productName: "Tên đúng trên database" }] } };
      assert.equal(await send(), true);
      await note.waitFor({ state: "visible", timeout: 3000 });
      const text = (await note.innerText()).replace(/\s+/g, " ").trim();
      assert.match(text, /Tên đã cập nhật/);
      assert.match(text, /900000901/);
      assert.equal(await note.getAttribute("role"), "status");
      await page.waitForFunction(() => window.PrintSkuCatalog.get("900000901")?.name === "Tên đúng trên database", null, { timeout: 3000 });
      assert.deepEqual(await page.evaluate(() => window.__renamedEvents.at(-1)), [{ sku: "900000901", productName: "Tên đúng trên database" }]);
      const box = await note.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width, `${width}px: thông báo nằm trong màn`);
      // Codex ảnh (18/10/2026): không đè thanh đáy (nút In tem) — đáy thông báo cao hơn vùng 80 px cuối màn
      assert.ok(box.y + box.height <= height - 80, `${width}px: thông báo nằm trên thanh đáy (đáy ở ${Math.round(box.y + box.height)} / ${height})`);
      // 3) Lệnh trùng → không thông báo lại
      await page.evaluate(() => { const n = document.getElementById("sku-name-note"); if (n) n.hidden = true; });
      srv.reply = { ok: true, data: { id: "job-2", status: "queued", duplicate: true, renamed: [] } };
      assert.equal(await send(), true);
      await page.waitForTimeout(300);
      assert.equal(await note.isVisible(), false, "lệnh trùng → không thông báo");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("print_renamed_browser: cổng in chung — renamed → thông báo 'Tên đã cập nhật' + danh mục trên máy + sự kiện; không có renamed / lệnh trùng → không thông báo — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
