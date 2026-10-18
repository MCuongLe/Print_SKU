// 4 màn tra tên SKU từ danh mục trên máy (18/10/2026, docs/plans/2026-10-18-danh-muc-sku-tren-may.md, Việc 3): IN TEM SKU (gõ mã + gợi ý),
// ô quét IN TEM SKU (PrintSkuScanUI), CHUYỂN ĐỔI ĐƠN VỊ, GÁN tự động ở IN TEM GROUP UID.
//   * mã có trên máy → hiện tên ngay, KHÔNG gọi SKU_Name?sku=eq / like / ilike;
//   * mã không có trên máy → hỏi máy chủ như cũ (SKU vừa đồng bộ vẫn tìm thấy);
//   * danh mục chưa nạp xong → hỏi máy chủ như cũ, không chặn gõ.
// Supabase + camera giả lập, dữ liệu giả 9000009xx. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const row = (sku, name) => ({ sku, product_name: name, status: "1" });
const CATALOG = [row("900000901", "Vải giả Kaki đen"), row("900000902", "Chỉ giả Tex 27 xám")];
const SERVER = { "900000977": "Băng gai giả mới đồng bộ", "900000901": "Vải giả Kaki đen (máy chủ)" };
const fakeScanner = () => {
  const install = () => {
    const S = window.PrintSkuScanner; if (!S) return false;
    window.__tracks = [];
    window.PrintSkuScanner = { ...S, gl: () => true, k0: () => true, Jp: async () => ({ doc: async () => (window.__code ? { ma: window.__code } : null) }),
      ev: async () => { const c = document.createElement("canvas"); c.width = 640; c.height = 480; const g = c.getContext("2d"); setInterval(() => { g.fillStyle = "#456"; g.fillRect(0, 0, 640, 480); }, 100); const stream = c.captureStream(10); window.__tracks.push(...stream.getTracks()); return stream; } };
    return true;
  };
  const t = setInterval(() => { if (install()) clearInterval(t); }, 20);
};

const open = async (browser, srv) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(fakeScanner);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const url = decodeURIComponent(route.request().url()), json = (b, headers = {}) => route.fulfill({ contentType: "application/json", headers, body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes("/rest/v1/SKU_Name?")) {
      const eq = url.match(/[?&]sku=eq\.([^&]+)/)?.[1];
      if (eq) { srv.eq.push(eq); return json(SERVER[eq] ? [{ sku: eq, product_name: SERVER[eq] }] : []); }
      if (/=(like|ilike)\./.test(url)) { srv.like++; return json([]); }
      if (url.includes("order=sku.asc")) {
        if (srv.slowFull) await new Promise(r => setTimeout(r, srv.slowFull));
        return json(CATALOG, { "content-range": `0-${CATALOG.length - 1}/${CATALOG.length}` });
      }
      return json([]);
    }
    if (url.includes("/rpc/sku_catalog_changes")) return json({ ok: true, data: { version: { activeCount: CATALOG.length, maxUpdatedAt: "2026-10-18T01:00:00+00:00" }, tooMany: true, upserts: [], removed: [] } });
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
  return { context, page, errors };
};
const eqOf = (srv, code) => srv.eq.filter(c => c === code).length;
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    {
      const srv = { eq: [], like: 0 };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker");
      await page.locator("#f-sku").waitFor();
      await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
      // 1) IN TEM SKU: gõ mã có trên máy → tên ngay, không hỏi máy chủ (cả tra mã lẫn gợi ý)
      await page.locator("#f-sku").fill("900000901");
      await page.waitForFunction(() => document.getElementById("f-pn").value === "Vải giả Kaki đen", null, { timeout: 5000 });
      assert.equal(eqOf(srv, "900000901"), 0, "In tem SKU: mã có trên máy → không gọi sku=eq");
      assert.equal(srv.like, 0, "In tem SKU: gợi ý khi gõ lấy trên máy → không gọi like/ilike");
      // 2) mã không có trên máy → hỏi máy chủ
      await page.locator("#f-sku").fill("900000977");
      await page.waitForFunction(() => document.getElementById("f-pn").value === "Băng gai giả mới đồng bộ", null, { timeout: 5000 });
      assert.equal(eqOf(srv, "900000977") >= 1, true, "In tem SKU: mã không có trên máy → hỏi máy chủ");
      // 3) Ô quét IN TEM SKU: quét mã có trên máy → nhận ngay, không hỏi máy chủ
      await page.evaluate(() => { window.__code = "900000902"; window.PrintSkuScanUI.open({ title: "Quét mã SKU", typeLabel: "Gõ tay mã SKU", typeFocus: "#f-sku" }); });
      await page.waitForFunction(() => /Chỉ giả Tex 27 xám/.test(document.querySelector(".pss")?.textContent || ""), null, { timeout: 8000 });
      assert.equal(eqOf(srv, "900000902"), 0, "Ô quét: mã có trên máy → không gọi sku=eq");
      await page.evaluate(() => { window.__code = ""; });
      await settle(800);
      // 4) CHUYỂN ĐỔI ĐƠN VỊ
      srv.eq.length = 0;
      await page.goto(BASE + "#home");
      await page.locator("#barcode-unit-converter").click();
      await page.locator("#unit-converter-screen").waitFor({ state: "visible" });
      await page.locator("#uc-code").fill("900000901"); await page.locator("#uc-code-form").press("Enter");
      await page.waitForFunction(() => document.getElementById("uc-picked-name")?.textContent === "Vải giả Kaki đen", null, { timeout: 5000 })
        .catch(async () => { throw new Error(`Chuyển đổi đơn vị chưa có tên: picked="${await page.locator("#uc-picked-name").textContent()}" pss=${await page.locator(".pss").count()} hash=${await page.evaluate(() => location.hash)} msg="${await page.evaluate(() => document.getElementById("uc-message")?.textContent)}" eq=${srv.eq.join(",")}`); });
      assert.equal(eqOf(srv, "900000901"), 0, "Chuyển đổi đơn vị: mã có trên máy → không gọi sku=eq");
      // 5) IN TEM GROUP UID · Gán tự động
      await page.goto(BASE + "#group-uid");
      await page.locator("#uid-tab-auto").click();
      await page.locator('#uid-auto-rows [data-field="sku"]').fill("900000902");
      await page.waitForFunction(() => document.querySelector('#uid-auto-rows [data-field="name"]')?.value === "Chỉ giả Tex 27 xám", null, { timeout: 5000 })
        .catch(async e => { throw new Error(`Gán tự động chưa có tên: name="${await page.locator('#uid-auto-rows [data-field="name"]').inputValue()}" sku="${await page.locator('#uid-auto-rows [data-field="sku"]').inputValue()}" dialog=${await page.locator(".pss:visible, dialog[open]").count()} eq=${srv.eq.join(",")}`); });
      assert.equal(eqOf(srv, "900000902"), 0, "Gán tự động: mã có trên máy → không gọi sku=eq");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 6) Danh mục chưa nạp xong → hỏi máy chủ, không chặn gõ
    {
      const srv = { eq: [], like: 0, slowFull: 4000 };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker");
      await page.locator("#f-sku").waitFor();
      await page.locator("#f-sku").fill("900000901");
      await page.waitForFunction(() => document.getElementById("f-pn").value === "Vải giả Kaki đen (máy chủ)", null, { timeout: 5000 });
      assert.equal(eqOf(srv, "900000901") >= 1, true, "chưa nạp xong → hỏi máy chủ");
      assert.equal(await page.evaluate(() => window.PrintSkuCatalog.ready()), false, "danh mục vẫn đang nạp nền");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("sku_catalog_screens_browser: In tem SKU (gõ mã + gợi ý), ô quét, Chuyển đổi đơn vị, Gán tự động Group UID tra tên trên máy không gọi máy chủ; mã không có / chưa nạp xong → hỏi máy chủ — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
