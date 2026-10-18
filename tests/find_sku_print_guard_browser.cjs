// TÌM SKU: danh mục trên máy + kiểm phiên bản, chốt chặn tên khi in (18/10/2026, docs/plans/2026-10-18-cache-phien-ban.md).
//   A. Danh mục: lần đầu sku_catalog_changes(null) → tooMany → tải toàn bộ SKU_Name; lần sau gửi maxUpdatedAt đang giữ, máy chủ trả
//      phần đổi (upserts / removed) → ghép vào bản trên máy, KHÔNG tải lại toàn bộ; số SKU sau ghép lệch activeCount → tải toàn bộ;
//      chưa có hàm mới (PGRST202) → chạy như cũ (12 giờ tải lại).
//   B. In: trước khi gửi lệnh đọc lại tên từ SKU_Name (Supabase luôn đúng) → tên khác thì in theo tên database và sửa dòng chờ in;
//      SKU không còn (ngừng / xoá) hoặc mất mạng → KHÔNG gửi lệnh.
// Supabase giả lập, dữ liệu giả 9000008xx. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const T1 = "2026-10-18T01:00:00+00:00", T2 = "2026-10-18T02:00:00+00:00";
const row = (sku, name) => ({ sku, product_name: name, status: "1" });

const open = async (browser, srv, queue) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (queue) await context.addInitScript(q => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("fsk-queue-v1", JSON.stringify(q)); sessionStorage.setItem("seeded", "1"); } }, queue);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const url = route.request().url(), json = (b, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes("/rest/v1/SKU_Name?")) {
      const inList = decodeURIComponent(url).match(/sku=in\.\(([^)]*)\)/)?.[1];
      if (inList != null) {
        srv.guard.push(inList);
        if (srv.guardOffline) return route.abort("internetdisconnected");
        const want = inList.split(",").map(s => s.replace(/"/g, ""));
        return json(srv.db.filter(r => want.includes(r.sku)).map(r => ({ sku: r.sku, product_name: r.product_name })));
      }
      srv.full++;
      const rows = srv.catalog || srv.db; // srv.catalog: danh mục tải về còn tên cũ (giả lập bản trên máy chưa kịp đổi)
      return json(rows, 200, { "content-range": `0-${rows.length - 1}/${rows.length}` });
    }
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
    if (rpc === "print_enqueue") { srv.enqueued.push(JSON.parse(route.request().postData() || "{}")); return json({ ok: true, data: { id: "job-gia-1" } }); }
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
  return { context, page, errors };
};
const note = page => page.locator("#fsk-catalog").innerText();
const waitNote = (page, re) => page.waitForFunction(src => new RegExp(src).test(document.getElementById("fsk-catalog")?.textContent || ""), re.source, { timeout: 15000 });
const settle = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // ---- A. Danh mục: kiểm phiên bản, ghép phần đổi ----
    {
      const srv = { db: [row("900000801", "Vải giả A"), row("900000802", "Vải giả B"), row("900000803", "Vải giả C")], max: T1, changes: [], guard: [], full: 0, enqueued: [] };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#find-sku");
      await waitNote(page, /Danh mục 3 SKU/);
      assert.equal(srv.full >= 1, true, "lần đầu tải toàn bộ");
      await settle(300);
      assert.deepEqual(srv.changes, [null], "lần đầu hỏi phiên bản với p_since null");
      // Máy chủ đổi: A đổi tên, C ngừng, thêm D → lần sau chỉ nhận phần đổi
      srv.db = [row("900000801", "Vải giả A mới"), row("900000802", "Vải giả B"), row("900000804", "Vải giả D")];
      srv.max = T2; srv.delta = { upserts: [row("900000801", "Vải giả A mới"), row("900000804", "Vải giả D")], removed: ["900000803"] };
      srv.full = 0; srv.changes.length = 0;
      await page.reload();
      await page.waitForFunction(() => true);
      for (let i = 0; i < 100 && !srv.changes.length; i++) await settle(50);
      assert.equal(srv.changes[0], T1, "lần sau gửi maxUpdatedAt đang giữ");
      await settle(800);
      assert.equal(srv.full, 0, "có phần đổi nhỏ: không tải lại toàn bộ");
      const cached = await page.evaluate(() => new Promise(res => { const r = indexedDB.open("print-sku-find-sku", 1); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("catalog"); g.onsuccess = () => res(g.result); }; }));
      assert.deepEqual(cached.rows.map(r => r.join("|")).sort(), ["900000801|Vải giả A mới|1", "900000802|Vải giả B|1", "900000804|Vải giả D|1"], "đã ghép: đổi tên, bỏ SKU ngừng, thêm SKU mới");
      assert.equal(cached.version.maxUpdatedAt, T2, "lưu phiên bản mới");
      assert.match(await note(page), /Danh mục 3 SKU/);
      // Vào lại màn trong cùng phiên (không tải lại trang): hỏi phiên bản một lần
      srv.delta = null; srv.changes.length = 0;
      await page.evaluate(() => { location.hash = "#home"; }); await settle(200);
      await page.evaluate(() => { location.hash = "#find-sku"; });
      for (let i = 0; i < 100 && !srv.changes.length; i++) await settle(50);
      assert.deepEqual(srv.changes, [T2], "vào lại màn: kiểm phiên bản");
      // Không đổi: chỉ 1 lời gọi nhỏ, không tải toàn bộ
      srv.delta = null; srv.changes.length = 0;
      await page.reload();
      for (let i = 0; i < 100 && !srv.changes.length; i++) await settle(50);
      await settle(500);
      assert.deepEqual(srv.changes, [T2]); assert.equal(srv.full, 0, "không đổi: không tải toàn bộ");
      // Ghép xong mà số SKU lệch activeCount (bỏ sót) → tải toàn bộ cho chắc
      srv.db.push(row("900000805", "Vải giả E")); srv.delta = { upserts: [], removed: [] }; srv.changes.length = 0;
      await page.reload();
      await waitNote(page, /Danh mục 4 SKU/);
      assert.ok(srv.full >= 1, "số SKU lệch → tải toàn bộ");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- A2. Chưa có hàm mới: chạy như cũ (bản trên máy dùng tới 12 giờ) ----
    {
      const srv = { noNew: true, db: [row("900000811", "Chỉ giả 1")], max: T1, changes: [], guard: [], full: 0, enqueued: [] };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#find-sku"); await waitNote(page, /Danh mục 1 SKU/);
      srv.full = 0; await page.reload(); await waitNote(page, /Danh mục 1 SKU/); await settle(800);
      assert.equal(srv.full, 0, "PGRST202: dùng bản trên máy như cũ");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---- B. In: chốt chặn tên ----
    const item = (id, sku, pn) => ({ id, sku, pn, unit: "m", quantity: 2, copies: 1, status: "pending", jobId: null, nonce: null, error: "", addedAt: Date.now() });
    const queue = [item("q1", "900000821", "Tên cũ trên máy"), item("q2", "900000822", "Băng giả")];
    const toPrint = async page => { await page.goto(BASE + "#find-sku"); await page.locator("#fsk-tab-print").click(); await page.locator("#fsk-print").click(); };
    {
      // B1. Tên khác → in theo tên database, sửa dòng chờ in
      const srv = { db: [row("900000821", "Tên đúng trên database"), row("900000822", "Băng giả")], catalog: [row("900000821", "Tên cũ trên máy"), row("900000822", "Băng giả")], max: T1, changes: [], guard: [], full: 0, enqueued: [] };
      const { context, page, errors } = await open(browser, srv, queue);
      await toPrint(page);
      for (let i = 0; i < 100 && !srv.enqueued.length; i++) await settle(50);
      assert.equal(srv.guard.length, 1, "đọc lại tên một lần trước khi in");
      assert.equal(srv.enqueued.length, 1, "vẫn in");
      const names = srv.enqueued[0].p_payload.items.map(i => `${i.sku}|${i.productName}`);
      assert.deepEqual(names, ["900000821|Tên đúng trên database", "900000822|Băng giả"], "in theo tên database");
      assert.match(await page.locator("#fsk-list").innerText(), /Tên đúng trên database/, "dòng chờ in đổi theo tên database");
      await page.waitForFunction(() => document.getElementById("fsk-message")?.dataset.tone === "ok");
      assert.match(await page.locator("#fsk-message").innerText(), /dùng tên mới trên máy chủ cho 900000821/, "báo đã thay tên");
      assert.match(await page.locator('#fsk-list .cut-row[data-id="q1"]').innerText(), /Tên đã cập nhật/, "nhãn trên dòng đổi tên");
      // Tên mới ghi vào danh mục trên máy (mốc checkedAt mới → lần vào màn sau dựng lại chỉ mục)
      const cachedName = () => page.evaluate(() => new Promise(res => { const r = indexedDB.open("print-sku-find-sku", 1); r.onsuccess = () => { const g = r.result.transaction("kv").objectStore("kv").get("catalog"); g.onsuccess = () => res(((g.result?.rows || []).find(x => x[0] === "900000821") || [])[1] || null); }; }));
      let name = null;
      for (let i = 0; i < 50 && name !== "Tên đúng trên database"; i++) { name = await cachedName(); if (name !== "Tên đúng trên database") await settle(100); }
      assert.equal(name, "Tên đúng trên database", "danh mục trên máy nhận tên database");
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // B2. SKU không còn trong danh mục (ngừng / xoá) → không in
      const srv = { db: [row("900000821", "Tên cũ trên máy")], max: T1, changes: [], guard: [], full: 0, enqueued: [] };
      const { context, page, errors } = await open(browser, srv, queue);
      await toPrint(page);
      await page.waitForFunction(() => /900000822/.test(document.getElementById("fsk-message")?.textContent || ""), null, { timeout: 10000 });
      await settle(300);
      assert.equal(srv.enqueued.length, 0, "SKU không còn → không gửi lệnh");
      assert.match(await page.locator('#fsk-list .cut-row[data-id="q2"]').innerText(), /SKU không còn/, "đánh dấu đúng dòng SKU không còn");
      assert.equal(await page.locator('#fsk-list .cut-row[data-id="q2"] input').isDisabled(), true, "dòng SKU không còn: bỏ chọn, khoá ô chọn");
      assert.equal(await page.locator('#fsk-list .cut-row[data-id="q1"] input').isChecked(), true, "dòng còn in được vẫn chọn");
      assert.equal(await page.locator('#fsk-list .cut-row[data-id="q2"]').getAttribute("data-status"), "failed");
      assert.equal(await page.locator('#fsk-list .cut-row[data-id="q1"]').getAttribute("data-status"), "pending", "dòng còn lại giữ nguyên");
      assert.equal(await page.locator("#fsk-message").getAttribute("data-tone"), "error");
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // B3. Mất mạng khi đọc lại tên → không in
      const srv = { guardOffline: true, db: [row("900000821", "Tên cũ trên máy"), row("900000822", "Băng giả")], max: T1, changes: [], guard: [], full: 0, enqueued: [] };
      const { context, page, errors } = await open(browser, srv, queue);
      await toPrint(page);
      await page.waitForFunction(() => document.getElementById("fsk-message")?.dataset.tone === "error", null, { timeout: 10000 });
      assert.match(await page.locator("#fsk-message").innerText(), /Chưa kiểm được tên SKU/);
      assert.equal(srv.enqueued.length, 0, "mất mạng → không gửi lệnh");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("find_sku_print_guard_browser: danh mục kiểm phiên bản + ghép phần đổi (không tải toàn bộ), lệch số SKU tải toàn bộ, chưa có hàm mới chạy như cũ; in theo tên database, SKU không còn / mất mạng thì không in — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
