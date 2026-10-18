// Danh mục SKU trên máy dùng chung `window.PrintSkuCatalog` (18/10/2026, docs/plans/2026-10-18-danh-muc-sku-tren-may.md, khối #sku-catalog-script).
//   * mở một màn dùng tên SKU (#worker, #unit-converter, #group-uid, #find-sku) → nạp nền một lần (IndexedDB print-sku-find-sku, dùng chung Tìm SKU);
//   * get(sku) đồng bộ: bản ghi | null (không có) | undefined (chưa nạp); search(q) giống máy chủ: mã bắt đầu bằng q, rồi tên chứa q (q ≥ 3 ký tự);
//   * lần mở sau không tải lại toàn bộ, chỉ hỏi phiên bản sku_catalog_changes(maxUpdatedAt) và ghép phần đổi; patchNames ghi tên mới vào bản trên máy;
//   * chưa có hàm mới (PGRST202) → vẫn nạp toàn bộ như cũ.
// Supabase giả lập, dữ liệu giả 9000009xx. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const T1 = "2026-10-18T01:00:00+00:00", T2 = "2026-10-18T02:00:00+00:00";
const row = (sku, name) => ({ sku, product_name: name, status: "1" });
const settle = ms => new Promise(r => setTimeout(r, ms));

const open = async (browser, srv) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const url = route.request().url(), json = (b, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes("/rest/v1/SKU_Name?") && url.includes("order=sku.asc") && !/[?&]sku=/.test(url)) {
      srv.full++;
      return json(srv.db, 200, { "content-range": `0-${srv.db.length - 1}/${srv.db.length}` });
    }
    if (url.includes("/rest/v1/SKU_Name?")) { srv.single++; return json([]); }
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    if (rpc === "sku_catalog_changes") {
      const body = JSON.parse(route.request().postData() || "{}");
      srv.changes.push(body.p_since ?? null);
      if (srv.noNew) return json({ message: "Could not find the function public.sku_catalog_changes(p_since) in the schema cache", code: "PGRST202" }, 404);
      const version = { activeCount: srv.db.length, maxUpdatedAt: srv.max };
      if (!body.p_since) return json({ ok: true, data: { version, tooMany: true, upserts: [], removed: [] } });
      const d = srv.delta || { upserts: [], removed: [] };
      return json({ ok: true, data: { version, tooMany: false, upserts: d.upserts, removed: d.removed } });
    }
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
  return { context, page, errors };
};
const ready = page => page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
const waitChanges = async srv => { for (let i = 0; i < 100 && !srv.changes.length; i++) await settle(50); };

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    {
      const srv = { db: [row("900000901", "Vải giả Kaki đen"), row("900000902", "Chỉ giả Tex 27 xám"), row("900000911", "Vải giả Kaki trắng"), row("900000950", "Băng gai giả")], max: T1, changes: [], full: 0, single: 0 };
      const { context, page, errors } = await open(browser, srv);
      // 1) Mở In tem SKU: nạp nền một lần
      await page.goto(BASE + "#worker");
      await ready(page);
      assert.equal(srv.full >= 1, true, "lần đầu tải toàn bộ");
      for (let i = 0; i < 60 && srv.changes.length < 2; i++) await new Promise(r => setTimeout(r, 50));
      assert.deepEqual(srv.changes, [null, T1], "lần đầu: hỏi phiên bản trước khi tải + phần đổi phát sinh trong lúc tải (review G6)");
      const got = await page.evaluate(() => {
        const C = window.PrintSkuCatalog;
        return { a: C.get("900000901"), miss: C.get("900000999"), pre: C.search("9000009", 10).map(x => x.sku), name: C.search("kaki", 10).map(x => x.sku), short: C.search("v", 10).length };
      });
      assert.deepEqual(got.a, { sku: "900000901", name: "Vải giả Kaki đen", status: "1" });
      assert.equal(got.miss, null, "mã không có trên máy → null (để màn hỏi máy chủ)");
      assert.deepEqual(got.pre, ["900000901", "900000902", "900000911", "900000950"], "gợi ý theo mã: bắt đầu bằng q, theo thứ tự mã");
      assert.deepEqual(got.name, ["900000901", "900000911"], "gợi ý theo tên (≥ 3 ký tự, không phân biệt hoa thường)");
      assert.equal(got.short, 0, "q < 2 ký tự → không gợi ý");
      // 2) Lần mở sau (màn khác): không tải lại toàn bộ, chỉ hỏi phiên bản kèm maxUpdatedAt
      srv.full = 0; srv.changes.length = 0;
      await page.evaluate(h => history.replaceState(null, "", h), "#unit-converter"); await page.reload(); // một lần vào màn (không kèm hashchange)
      await ready(page); await waitChanges(srv); await settle(300);
      assert.equal(srv.full, 0, "có bản trên máy: không tải toàn bộ");
      assert.deepEqual(srv.changes, [T1], "chỉ hỏi phiên bản");
      // 3) Máy chủ đổi tên + gỡ một SKU → ghép phần đổi, onChange báo
      srv.db = [row("900000901", "Vải giả Kaki đen đậm"), row("900000902", "Chỉ giả Tex 27 xám"), row("900000911", "Vải giả Kaki trắng")];
      srv.max = T2; srv.delta = { upserts: [row("900000901", "Vải giả Kaki đen đậm")], removed: ["900000950"] }; srv.changes.length = 0;
      await page.evaluate(h => history.replaceState(null, "", h), "#group-uid"); await page.reload(); // một lần vào màn (không kèm hashchange)
      await ready(page); await waitChanges(srv);
      await page.waitForFunction(() => window.PrintSkuCatalog.get("900000901")?.name === "Vải giả Kaki đen đậm", null, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.PrintSkuCatalog.get("900000950")), null, "SKU bị gỡ không còn trên máy");
      assert.equal(srv.full, 0, "phần đổi nhỏ: không tải toàn bộ");
      // 4) patchNames (tên máy chủ trả về khi in) → get (RAM) đổi ngay; KHÔNG ghi IndexedDB (co-van Fable, review vòng 3) — lần check() sau lấy tên từ máy chủ
      const patched = await page.evaluate(async () => {
        const C = window.PrintSkuCatalog; let fired = 0; C.onChange(() => { fired++; });
        await C.patchNames([{ sku: "900000902", productName: "Chỉ giả Tex 27 xám nhạt" }]);
        const rec = await new Promise(res => { const r = indexedDB.open("print-sku-find-sku", 1); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("catalog"); g.onsuccess = () => res(g.result); }; });
        return { name: C.get("900000902")?.name, stored: (rec.rows.find(x => x[0] === "900000902") || [])[1], fired };
      });
      assert.deepEqual(patched, { name: "Chỉ giả Tex 27 xám nhạt", stored: "Chỉ giả Tex 27 xám", fired: 1 });
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 5) Chưa có hàm mới (web lên trước migration): vẫn nạp toàn bộ, tra được
    {
      const srv = { noNew: true, db: [row("900000961", "Chỉ giả 1")], max: T1, changes: [], full: 0, single: 0 };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker"); await ready(page);
      assert.equal(await page.evaluate(() => window.PrintSkuCatalog.get("900000961")?.name), "Chỉ giả 1");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("sku_catalog_browser: nạp nền một lần khi mở màn, get/search giống máy chủ, lần sau chỉ hỏi phiên bản + ghép phần đổi, patchNames ghi bản trên máy, chưa có hàm mới vẫn nạp — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
