// Cache trên máy + kiểm phiên bản cho bản lưu Supabase (18/10/2026, docs/plans/2026-10-18-cache-phien-ban.md, khối #snapshot-cache-script).
// Kiểm kê SKU và Rủi ro lưu trữ (tab Hàng chưa lên kệ) dùng chung một bản lưu (sku_count_snapshot), tab UID tạm dùng uid_temp_snapshot:
//   * lần đầu: gửi p_known_run_id = null, nhận bản đầy đủ, lưu IndexedDB;
//   * lần sau (tải lại / màn khác dùng chung): gửi mã đang có, máy chủ trả {unchanged:true} → hiện từ cache, mỗi lần mở đúng 1 lần gọi;
//   * máy chủ có lượt mới → thay cache; mất mạng → hiện bản trên máy + "Bản lưu trên máy lúc …";
//   * chưa có hàm mới (chạy trước migration, PGRST202) → lùi về hàm cũ *_overview; IndexedDB bị chặn → vẫn chạy (không cache).
// Supabase giả lập, dữ liệu giả. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const iso = h => new Date(Date.now() - h * 3600000).toISOString();
const skuRun = (id, n) => ({
  run: { id, readAt: iso(2), warehouses: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyName: "Cty giả" }], missing: [], sourceCounts: { stockRows: n, approvedRows: 0, heldTotal: 0, held: [] }, thresholdDays: 30, rowCount: n },
  rows: Array.from({ length: n }, (_, i) => ({ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: `9000000${String(10 + i)}`, productName: `Vải giả ${i}`, qty: 5, uom: "m", locations: [{ location: "F0-A0-00-00-00-00", qty: 5 }], lastApprovedAt: null, lastApprovedBy: null })),
});
const tempRun = (id, n) => ({
  run: { id, readAt: iso(3), warehouses: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG" }], warn: [], scanned: 20, pages: 1, rangeDays: 90, rowCount: n },
  rows: Array.from({ length: n }, (_, i) => ({ wh: "mtg", warehouseName: "WH - MATERIAL - MTG", sku: `9000000${String(40 + i)}`, productName: `Giả ${i}`, qty: 1, sourceCode: "", mappingId: "", createdBy: "", createdAt: iso(30) })),
  history: [{ id, readAt: iso(3), rowCount: n }],
});

const open = async (browser, srv, { noIdb = false } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (noIdb) await context.addInitScript(() => { Object.defineProperty(window, "indexedDB", { configurable: true, get: () => { throw new Error("IndexedDB bị chặn"); } }); });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const url = route.request().url(), json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
    const body = JSON.parse(route.request().postData() || "{}");
    srv.calls.push({ rpc, body });
    if (srv.offline && /_(snapshot|overview)$/.test(rpc)) return route.abort("internetdisconnected");
    if (srv.overviewOffline && /_overview$/.test(rpc)) return route.abort("internetdisconnected");
    const missing = { message: `Could not find the function public.${rpc}(p_known_run_id) in the schema cache`, code: "PGRST202" };
    if (rpc === "sku_count_snapshot") {
      if (srv.noNew) return json(missing, 404);
      return json({ ok: true, data: body.p_known_run_id && body.p_known_run_id === srv.sku.run.id ? { unchanged: true, runId: srv.sku.run.id } : { unchanged: false, ...srv.sku } });
    }
    if (rpc === "uid_temp_snapshot") {
      if (srv.noNew) return json(missing, 404);
      return json({ ok: true, data: body.p_known_run_id && body.p_known_run_id === srv.temp.run.id ? { unchanged: true, runId: srv.temp.run.id } : { unchanged: false, ...srv.temp } });
    }
    if (rpc === "sku_count_overview") return json({ ok: true, data: srv.sku });
    if (rpc === "uid_temp_overview") return json({ ok: true, data: srv.temp });
    return json({ ok: true, data: { agents: [], jobs: [] } });
  });
  return { context, page, errors };
};
const goto = async (page, hash, sel, text) => {
  await page.goto(BASE + "#" + hash);
  await page.waitForFunction(([s, t]) => document.getElementById(s)?.textContent === t, [sel, text], { timeout: 10000 });
};
const last = (srv, rpc) => srv.calls.filter(c => c.rpc === rpc).at(-1);
// Màn hiện cache ngay rồi mới gọi máy chủ → chờ lời gọi tới mock rồi mới đọc.
const waitCall = async (srv, rpc) => {
  for (let i = 0; i < 100 && !last(srv, rpc); i++) await new Promise(r => setTimeout(r, 50));
  return last(srv, rpc);
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- 1) Kiểm kê: lần đầu tải đủ; tải lại gửi mã đang có, máy chủ "không đổi" → vẫn hiện đủ dữ liệu từ cache ----
    {
      const srv = { calls: [], sku: skuRun("run-a", 3), temp: tempRun("tmp-a", 2) };
      const { context, page, errors } = await open(browser, srv);
      await goto(page, "inventory-audit", "ia-total", "3");
      assert.equal(last(srv, "sku_count_snapshot").body.p_known_run_id, null, "lần đầu: chưa có mã");
      assert.equal(srv.calls.filter(c => c.rpc === "sku_count_overview").length, 0, "không gọi hàm cũ khi có hàm mới");
      srv.calls.length = 0;
      await goto(page, "inventory-audit", "ia-total", "3");
      await page.reload(); await page.waitForFunction(() => document.getElementById("ia-total")?.textContent === "3");
      await page.waitForTimeout(400);
      const kk = srv.calls.filter(c => c.rpc === "sku_count_snapshot");
      assert.ok(kk.length >= 1 && kk.every(c => c.body.p_known_run_id === "run-a"), "tải lại: gửi mã lượt đang có");
      assert.equal(await page.locator("#ia-status").innerText(), "Đã tải 3 SKU.", "không đổi: vẫn hiện đủ từ cache");
      // Rủi ro lưu trữ dùng chung bản lưu → mở màn cũng gửi mã đang có
      srv.calls.length = 0;
      await goto(page, "storage-risk", "sr-total", "3");
      assert.equal((await waitCall(srv, "sku_count_snapshot")).body.p_known_run_id, "run-a", "Hàng chưa lên kệ dùng chung cache Kiểm kê");
      // ---- 2) Có lượt mới → thay cache, lần sau gửi mã mới ----
      srv.sku = skuRun("run-b", 5);
      await page.goto(BASE + "#inventory-audit"); await page.reload();
      await page.waitForFunction(() => document.getElementById("ia-total")?.textContent === "5");
      srv.calls.length = 0;
      await page.reload(); await page.waitForFunction(() => document.getElementById("ia-total")?.textContent === "5");
      assert.equal((await waitCall(srv, "sku_count_snapshot")).body.p_known_run_id, "run-b", "cache đã thay bằng lượt mới");
      // ---- 3) Mất mạng: hiện bản trên máy + nhãn ----
      srv.offline = true;
      await page.reload();
      await page.waitForFunction(() => /Bản lưu trên máy lúc/.test(document.getElementById("ia-status")?.textContent || ""), null, { timeout: 15000 });
      assert.equal(await page.locator("#ia-total").innerText(), "5", "mất mạng: vẫn hiện dữ liệu trên máy");
      assert.equal(await page.locator("#ia-status").getAttribute("data-tone"), "offline", "nhãn mất mạng dạng dải cảnh báo");
      srv.offline = false;
      // ---- 3b) Vào lại màn trong cùng phiên (không tải lại trang): vẫn hỏi phiên bản, thấy lượt mới ----
      await page.reload(); await page.waitForFunction(() => document.getElementById("ia-status")?.textContent === "Đã tải 5 SKU.");
      srv.sku = skuRun("run-c", 6); srv.calls.length = 0;
      await page.evaluate(() => { location.hash = "#home"; }); await page.waitForTimeout(200);
      await page.evaluate(() => { location.hash = "#inventory-audit"; });
      await page.waitForFunction(() => document.getElementById("ia-total")?.textContent === "6");
      assert.equal((await waitCall(srv, "sku_count_snapshot")).body.p_known_run_id, "run-b", "vào lại màn: gửi mã đang có");
      // ---- 3c) Chưa có hàm mới + mất mạng khi lùi hàm cũ: vẫn hiện bản trên máy ----
      srv.noNew = true; srv.overviewOffline = true;
      await page.reload();
      await page.waitForFunction(() => /Bản lưu trên máy lúc/.test(document.getElementById("ia-status")?.textContent || ""), null, { timeout: 15000 });
      assert.equal(await page.locator("#ia-total").innerText(), "6", "PGRST202 + mất mạng: dùng bản trên máy");
      srv.noNew = false; srv.overviewOffline = false;
      // ---- 4) UID tạm: cùng cách ----
      srv.calls.length = 0;
      await page.goto(BASE + "#storage-risk");
      await page.locator("#srt-tab-temp").click();
      await page.waitForFunction(() => document.getElementById("srt-total")?.textContent === "2");
      assert.equal(last(srv, "uid_temp_snapshot").body.p_known_run_id, null);
      srv.calls.length = 0;
      await page.reload(); await page.waitForFunction(() => document.getElementById("srt-total")?.textContent === "2");
      assert.equal((await waitCall(srv, "uid_temp_snapshot")).body.p_known_run_id, "tmp-a", "UID tạm: tải lại gửi mã đang có");
      assert.equal(srv.calls.filter(c => c.rpc === "uid_temp_overview").length, 0);
      // Vào lại tab UID tạm (không tải lại trang): hỏi phiên bản, thấy lượt mới
      srv.temp = tempRun("tmp-b", 4); srv.calls.length = 0;
      await page.locator("#srt-tab-main").click(); await page.locator("#srt-tab-temp").click();
      await page.waitForFunction(() => document.getElementById("srt-total")?.textContent === "4");
      assert.equal((await waitCall(srv, "uid_temp_snapshot")).body.p_known_run_id, "tmp-a", "vào lại tab: gửi mã đang có");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- 5) Chưa có hàm mới (web lên trước migration): lùi về hàm cũ, vẫn hiện dữ liệu ----
    {
      const srv = { calls: [], noNew: true, sku: skuRun("run-c", 4), temp: tempRun("tmp-c", 1) };
      const { context, page, errors } = await open(browser, srv);
      await goto(page, "inventory-audit", "ia-total", "4");
      assert.ok(srv.calls.some(c => c.rpc === "sku_count_overview"), "PGRST202 → gọi sku_count_overview");
      await page.goto(BASE + "#storage-risk"); await page.locator("#srt-tab-temp").click();
      await page.waitForFunction(() => document.getElementById("srt-total")?.textContent === "1");
      assert.ok(srv.calls.some(c => c.rpc === "uid_temp_overview"), "PGRST202 → gọi uid_temp_overview");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- 6) IndexedDB bị chặn: vẫn chạy, mỗi lần gửi mã null ----
    {
      const srv = { calls: [], sku: skuRun("run-d", 2), temp: tempRun("tmp-d", 0) };
      const { context, page, errors } = await open(browser, srv, { noIdb: true });
      await goto(page, "inventory-audit", "ia-total", "2");
      await page.reload(); await page.waitForFunction(() => document.getElementById("ia-total")?.textContent === "2");
      assert.ok(srv.calls.filter(c => c.rpc === "sku_count_snapshot").every(c => c.body.p_known_run_id === null), "không có cache thì không gửi mã");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("snapshot_cache_browser: lần đầu tải đủ, lần sau gửi mã + 'không đổi' dùng cache, Kiểm kê / Hàng chưa lên kệ dùng chung, lượt mới thay cache, mất mạng hiện bản trên máy, UID tạm cùng cách, chưa có hàm mới lùi hàm cũ, IndexedDB bị chặn vẫn chạy — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
