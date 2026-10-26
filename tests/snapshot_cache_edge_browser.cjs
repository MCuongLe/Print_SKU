// Cache trên máy (18/10/2026, docs/plans/2026-10-18-cache-phien-ban.md): các kịch bản biên Codex vòng 2–3 đã báo, chạy trên mã đã sửa.
//   V2-2 / V3-3: màn đang có dữ liệu, vào lại khi mất mạng → bản trên máy (cũ hơn) không vẽ đè, có nhãn "Bản lưu trên máy lúc";
//                UID tạm mở lần đầu khi mất mạng, cache cùng runId → vẫn hiện nhãn.
//   V2-3: UID tạm, Admin đọc WMS lỗi → chuyển tab trong màn vẫn giữ câu lỗi; về trang chủ rồi vào lại → nạp lại bản lưu.
//   V2-4 / V3-1: Tìm SKU, tab khác cập nhật IndexedDB "catalog" (thêm 900000899) → vào lại màn tìm được SKU mới (chỉ mục dựng lại).
//   V2-1 / V3-2: hai màn dùng chung khoá "sku_count" chồng nhau (Kiểm kê chậm, Hàng chưa lên kệ mất mạng / nhanh) → cache giữ bản
//                máy chủ mới nhất, lượt lỗi không chặn lượt cũ ghi, phản hồi muộn không ghi lùi.
// Supabase / Extension giả lập, dữ liệu giả (SKU 9000000xx / 9000008xx). Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
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
const settle = ms => new Promise(r => setTimeout(r, ms));

// Extension giả (rút gọn từ storage_risk_temp_browser.cjs): window.__failNow = true → lệnh đọc nhập xuất báo lỗi.
const mockExtension = () => {
  addEventListener("message", event => {
    const r = event.data;
    if (!r || r.source !== "PRINT_SKU_APP") return;
    const reply = (ok, data, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok, data, error }, location.origin);
    const p = r.payload || {};
    if (window.__failNow && r.type === "GET_STOCK_IMPORT_EXPORT_PAGE") return reply(false, undefined, { code: "MOCK", message: "Phiên WMS hết hạn" });
    if (r.type === "GET_SKU_COUNT_WAREHOUSES") return reply(true, { warehouses: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty giả" }], missingNames: [] });
    if (r.type === "GET_STOCK_IMPORT_EXPORT_PAGE") return reply(true, { page: p.page, size: 500, total: 0, totalPages: 1, rows: [] });
    if (r.type === "GET_SKU_COUNT_APPROVED_PAGE") return reply(true, { page: 1, size: 500, total: 0, totalPages: 1, rows: [] });
    if (r.type === "GET_SKU_COUNT_INVENTORY_PAGE") return reply(true, { page: 1, size: 500, total: 1, totalPages: 1, rows: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "900000010", productName: "Vải giả 0", location: "F0-A0-00-00-00-00", qty: 5, total: 5, modified: "2026-10-16 08:00:00", created: "2026-09-01 08:00:00", uom: "m" }] });
    return reply(true, { version: "0.10.9" });
  });
};

// Supabase giả. srv.offline: *_snapshot/_overview mất mạng. srv.skuSeq: hàng đợi phản hồi cho từng lời gọi sku_count_snapshot
// ({ delay, data } hoặc { abort: true }); hết hàng đợi thì trả theo srv.sku như máy chủ thật.
const open = async (browser, srv, { admin = false, view = "" } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  if (view) await context.addInitScript(v => { if (!sessionStorage.getItem("view-seeded")) { localStorage.setItem("sr-tab-dang-mo", v); sessionStorage.setItem("view-seeded", "1"); } }, view);
  await context.addInitScript(mockExtension);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  srv.calls ||= []; srv.done ||= [];
  await page.route("**/*", async route => {
    const url = route.request().url(), json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
    const body = JSON.parse(route.request().postData() || "{}");
    srv.calls.push({ rpc, body });
    if (rpc === "sku_count_snapshot" && srv.skuSeq?.length) {
      const step = srv.skuSeq.shift();
      if (step.delay) await settle(step.delay);
      srv.done.push({ rpc, step: step.name });
      if (step.abort) return route.abort("internetdisconnected");
      return json({ ok: true, data: { unchanged: false, ...step.data } });
    }
    if (srv.offline && /_(snapshot|overview)$/.test(rpc)) return route.abort("internetdisconnected");
    if (rpc === "sku_count_snapshot") return json({ ok: true, data: body.p_known_run_id && body.p_known_run_id === srv.sku.run.id ? { unchanged: true, runId: srv.sku.run.id } : { unchanged: false, ...srv.sku } });
    if (rpc === "uid_temp_snapshot") return json({ ok: true, data: body.p_known_run_id && body.p_known_run_id === srv.temp.run.id ? { unchanged: true, runId: srv.temp.run.id } : { unchanged: false, ...srv.temp } });
    if (rpc === "sku_count_overview") return json({ ok: true, data: srv.sku });
    if (rpc === "uid_temp_overview") return json({ ok: true, data: srv.temp });
    if (rpc === "sku_count_save_start") return json({ ok: true, data: { runId: "run-new" } });
    if (rpc === "sku_count_save_chunk") return json({ ok: true, data: { saved: (body.p_rows || []).length } });
    if (rpc === "sku_count_save_finish") return json({ ok: true, data: { runId: "run-new", rowCount: 1 } });
    return json({ ok: true, data: { agents: [], jobs: [] } });
  });
  return { context, page, errors };
};
const idbGet = (page, db, key) => page.evaluate(([db, key]) => new Promise((res, rej) => {
  const r = indexedDB.open(db, 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get(key); g.onsuccess = () => { r.result.close(); res(g.result ?? null); }; g.onerror = () => rej(g.error); };
  r.onerror = () => rej(r.error);
}), [db, key]);
const idbPut = (page, db, key, value) => page.evaluate(([db, key, value]) => new Promise((res, rej) => {
  const r = indexedDB.open(db, 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => { const tx = r.result.transaction("kv", "readwrite"); tx.objectStore("kv").put(value, key); tx.oncomplete = () => { r.result.close(); res(); }; tx.onerror = () => rej(tx.error); };
  r.onerror = () => rej(r.error);
}), [db, key, value]);
const waitText = (page, id, text, timeout = 10000) => page.waitForFunction(([id, t]) => document.getElementById(id)?.textContent === t, [id, text], { timeout });
const waitLabel = (page, id, timeout = 15000) => page.waitForFunction(id => /Bản lưu trên máy lúc/.test(document.getElementById(id)?.textContent || ""), id, { timeout });
const hash = async (page, h) => { await page.evaluate(h => { location.hash = h; }, h); await settle(200); };
const results = [];
const step = async (name, fn) => {
  try { await fn(); results.push(`PASS ${name}`); }
  catch (error) { results.push(`FAIL ${name}: ${String(error.message).split("\n").slice(0, 4).join(" | ")}`); process.exitCode = 1; }
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- V2-2 (Kiểm kê): màn hiện run-b (5), bản trên máy cũ hơn (run-a, 3) → vào lại khi mất mạng: giữ 5 + nhãn ----
    await step("V2-2 Kiểm kê: vào lại khi mất mạng không vẽ đè bản cũ, có nhãn", async () => {
      const srv = { sku: skuRun("run-b", 5), temp: tempRun("tmp-a", 2) };
      const { context, page, errors } = await open(browser, srv);
      try {
        await page.goto(BASE + "#inventory-audit"); await waitText(page, "ia-total", "5");
        await settle(300);
        await idbPut(page, "print-sku-cache", "sku_count", { schema: 1, savedAt: Date.now() - 3600000, data: skuRun("run-a", 3) });
        await hash(page, "#home"); srv.offline = true; await hash(page, "#inventory-audit");
        await waitLabel(page, "ia-status");
        assert.equal(await page.locator("#ia-total").innerText(), "5", "mất mạng: giữ dữ liệu đang hiện (5), không vẽ đè bản trên máy (3)");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V2-2 (Hàng chưa lên kệ): như trên ----
    await step("V2-2 Hàng chưa lên kệ: vào lại khi mất mạng không vẽ đè bản cũ, có nhãn", async () => {
      const srv = { sku: skuRun("run-b", 5), temp: tempRun("tmp-a", 2) };
      const { context, page, errors } = await open(browser, srv, { view: "main" });
      try {
        await page.goto(BASE + "#storage-risk"); await waitText(page, "sr-total", "5");
        await settle(300);
        await idbPut(page, "print-sku-cache", "sku_count", { schema: 1, savedAt: Date.now() - 3600000, data: skuRun("run-a", 3) });
        await hash(page, "#home"); srv.offline = true; await hash(page, "#storage-risk");
        await waitLabel(page, "sr-status");
        assert.equal(await page.locator("#sr-total").innerText(), "5", "mất mạng: giữ dữ liệu đang hiện (5), không vẽ đè bản trên máy (3)");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V2-2 (UID tạm): màn hiện tmp-b (4), cache tmp-a (2) → vào lại khi mất mạng: giữ 4 + nhãn ----
    await step("V2-2 UID tạm: vào lại khi mất mạng không vẽ đè bản cũ, có nhãn", async () => {
      const srv = { sku: skuRun("run-a", 3), temp: tempRun("tmp-b", 4) };
      const { context, page, errors } = await open(browser, srv, { view: "temp" });
      try {
        await page.goto(BASE + "#storage-risk"); await waitText(page, "srt-total", "4");
        await settle(300);
        await idbPut(page, "print-sku-cache", "uid_temp:v2", { schema: 1, savedAt: Date.now() - 3600000, data: tempRun("tmp-a", 2) });
        await hash(page, "#home"); srv.offline = true; await hash(page, "#storage-risk");
        await waitLabel(page, "srt-status");
        assert.equal(await page.locator("#srt-total").innerText(), "4", "mất mạng: giữ dữ liệu đang hiện (4), không vẽ đè bản trên máy (2)");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V3-3: UID tạm mở lần đầu (tải lại trang) khi mất mạng, cache cùng runId → hiện bản trên máy + nhãn ----
    await step("V3-3 UID tạm: mở lần đầu khi mất mạng, cache cùng runId vẫn có nhãn", async () => {
      const srv = { sku: skuRun("run-a", 3), temp: tempRun("tmp-a", 2) };
      const { context, page, errors } = await open(browser, srv, { view: "temp" });
      try {
        await page.goto(BASE + "#storage-risk"); await waitText(page, "srt-total", "2");
        await settle(300);
        srv.offline = true; await page.reload();
        await waitLabel(page, "srt-status");
        assert.equal(await page.locator("#srt-total").innerText(), "2");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V2-3: UID tạm, Admin đọc WMS lỗi → đổi tab giữ câu lỗi; về trang chủ rồi vào lại → nạp lại bản lưu ----
    await step("V2-3 UID tạm: đọc WMS lỗi, chuyển tab giữ lỗi, vào lại màn nạp lại bản lưu", async () => {
      const srv = { sku: skuRun("run-a", 3), temp: tempRun("tmp-a", 2) };
      const { context, page, errors } = await open(browser, srv, { admin: true, view: "temp" });
      try {
        await page.goto(BASE + "#storage-risk"); await waitText(page, "srt-total", "2");
        await page.locator("#srt-run").waitFor({ state: "visible" });
        await page.evaluate(() => { window.__failNow = true; });
        await page.locator("#srt-run").click();
        await page.waitForFunction(() => document.getElementById("srt-status").dataset.tone === "error", null, { timeout: 20000 });
        assert.match(await page.locator("#srt-status").innerText(), /Phiên WMS hết hạn/);
        assert.equal(await page.locator("#srt-total").innerText(), "—", "lỗi: màn về —");
        await page.waitForFunction(() => !document.getElementById("srt-run").disabled);
        // Đổi tab trong màn (không rời màn): giữ câu lỗi, không tự nạp bản lưu
        const before = srv.calls.filter(c => c.rpc === "uid_temp_snapshot").length;
        await page.locator("#srt-tab-main").click(); await page.locator("#srt-tab-temp").click(); await settle(800);
        assert.match(await page.locator("#srt-status").innerText(), /Phiên WMS hết hạn/, "chuyển tab: giữ câu lỗi");
        assert.equal(srv.calls.filter(c => c.rpc === "uid_temp_snapshot").length, before, "chuyển tab: không nạp bản lưu");
        // Về trang chủ rồi vào lại màn: nạp lại bản lưu
        await hash(page, "#home"); await hash(page, "#storage-risk");
        await waitText(page, "srt-total", "2", 10000).catch(() => { throw new Error(`vào lại màn: chưa nạp lại bản lưu (srt-total vẫn khác "2")`); });
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V2-4 / V3-1: Tìm SKU, tab khác cập nhật IndexedDB → vào lại màn tìm được SKU mới ----
    await step("V2-4/V3-1 Tìm SKU: tab khác cập nhật cache, vào lại màn tìm được 900000899", async () => {
      const T1 = "2026-10-18T01:00:00+00:00", T2 = "2026-10-18T02:00:00+00:00";
      const row = (sku, name) => ({ sku, product_name: name, status: "1" });
      const fsk = { db: [row("900000801", "Vải giả A"), row("900000802", "Vải giả B"), row("900000803", "Vải giả C")], max: T1, changes: [] };
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.route("**/*", async route => {
        const url = route.request().url(), json = (b, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes("/rest/v1/SKU_Name?")) return json(fsk.db, 200, { "content-range": `0-${fsk.db.length - 1}/${fsk.db.length}` });
        const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
        if (rpc === "sku_catalog_changes") {
          const body = JSON.parse(route.request().postData() || "{}"); fsk.changes.push(body.p_since ?? null);
          const version = { activeCount: fsk.db.length, maxUpdatedAt: fsk.max };
          return json({ ok: true, data: body.p_since ? { version, tooMany: false, upserts: [], removed: [] } : { version, tooMany: true, upserts: [], removed: [] } });
        }
        if (rpc === "sku_combo_lookup") return json([]);
        return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
      });
      try {
        await page.goto(BASE + "#find-sku");
        await page.waitForFunction(() => /Danh mục 3 SKU/.test(document.getElementById("fsk-catalog")?.textContent || ""), null, { timeout: 15000 });
        await settle(500);
        const cached = await idbGet(page, "print-sku-find-sku", "catalog");
        assert.ok(cached?.rows?.length === 3, "bản trên máy ban đầu 3 SKU");
        // Tab khác: máy chủ có thêm 900000899, tab đó đã ghép vào IndexedDB với phiên bản mới
        fsk.db.push(row("900000899", "Vải giả mới tab khác")); fsk.max = T2;
        await idbPut(page, "print-sku-find-sku", "catalog", { at: cached.at, checkedAt: Date.now(), rows: [...cached.rows, ["900000899", "Vải giả mới tab khác", "1"]], version: { activeCount: 4, maxUpdatedAt: T2 } });
        fsk.changes.length = 0;
        await hash(page, "#home"); await hash(page, "#find-sku");
        for (let i = 0; i < 100 && !fsk.changes.length; i++) await settle(50);
        assert.deepEqual(fsk.changes, [T2], "vào lại màn: hỏi phiên bản theo bản trên máy mới");
        await page.waitForFunction(() => /Danh mục 4 SKU/.test(document.getElementById("fsk-catalog")?.textContent || ""), null, { timeout: 15000 });
        await settle(800);
        await page.locator("#fsk-tab-scan").click();
        await page.locator("#fsk-code").fill("900000899"); await page.locator("#fsk-code-form").press("Enter");
        const found = await page.locator('#fsk-results .fsk-card[data-sku="900000899"]').waitFor({ timeout: 6000 }).then(() => true, () => false);
        const shown = await page.locator("#fsk-results .fsk-card").evaluateAll(cards => cards.map(c => c.dataset.sku));
        assert.ok(found, `tìm 900000899 sau khi vào lại: chỉ mục chưa dựng lại (thẻ đang hiện: ${JSON.stringify(shown)})`);
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V2-1 / V3-2 (a): Kiểm kê lượt 1 chậm (máy chủ trả run-b), Hàng chưa lên kệ lượt 2 mất mạng → cache giữ run-b ----
    await step("V2-1/V3-2 khoá sku_count: lượt chậm thành công + lượt sau mất mạng → cache giữ bản lượt chậm", async () => {
      const srv = { sku: skuRun("run-a", 3), temp: tempRun("tmp-a", 1) };
      const { context, page, errors } = await open(browser, srv, { view: "main" });
      try {
        await page.goto(BASE + "#inventory-audit"); await waitText(page, "ia-total", "3");
        await settle(300);
        assert.equal((await idbGet(page, "print-sku-cache", "sku_count"))?.data?.run?.id, "run-a");
        await page.goto(BASE + "#home"); await page.reload(); await settle(500);
        srv.calls.length = 0; srv.done.length = 0;
        srv.sku = skuRun("run-b", 4);
        srv.skuSeq = [{ name: "luot1-cham", delay: 1500, data: skuRun("run-b", 4) }, { name: "luot2-mat-mang", abort: true }];
        await page.evaluate(() => { location.hash = "#inventory-audit"; }); await settle(150);
        await page.evaluate(() => { location.hash = "#storage-risk"; });
        for (let i = 0; i < 160 && srv.done.length < 2; i++) await settle(50);
        assert.equal(srv.done.length, 2, `cả hai lượt đã gọi máy chủ (đã gọi: ${JSON.stringify(srv.calls.map(c => c.rpc))})`);
        await settle(1000);
        const got = await idbGet(page, "print-sku-cache", "sku_count");
        assert.equal(got?.data?.run?.id, "run-b", "lượt mất mạng không được chặn lượt chậm ghi bản máy chủ hợp lệ");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
    // ---- V2-1 / V3-2 (b): lượt 1 chậm trả run-b, lượt 2 nhanh trả run-c → phản hồi muộn không ghi lùi, cache = run-c ----
    await step("V2-1/V3-2 khoá sku_count: phản hồi muộn không ghi lùi bản mới hơn", async () => {
      const srv = { sku: skuRun("run-a", 3), temp: tempRun("tmp-a", 1) };
      const { context, page, errors } = await open(browser, srv, { view: "main" });
      try {
        await page.goto(BASE + "#inventory-audit"); await waitText(page, "ia-total", "3");
        await settle(300);
        await page.goto(BASE + "#home"); await page.reload(); await settle(500);
        srv.calls.length = 0; srv.done.length = 0;
        srv.sku = skuRun("run-c", 6);
        srv.skuSeq = [{ name: "luot1-cham", delay: 1500, data: skuRun("run-b", 4) }, { name: "luot2-nhanh", data: skuRun("run-c", 6) }];
        await page.evaluate(() => { location.hash = "#inventory-audit"; }); await settle(150);
        await page.evaluate(() => { location.hash = "#storage-risk"; });
        for (let i = 0; i < 160 && srv.done.length < 2; i++) await settle(50);
        assert.equal(srv.done.length, 2, "cả hai lượt đã gọi máy chủ");
        await settle(1000);
        const got = await idbGet(page, "print-sku-cache", "sku_count");
        assert.equal(got?.data?.run?.id, "run-c", "phản hồi muộn (run-b) không được ghi lùi bản mới hơn (run-c)");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
  results.forEach(r => console.log(r));
  console.log(process.exitCode ? "snapshot_cache_edge_browser: FAILED" : "snapshot_cache_edge_browser: passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
