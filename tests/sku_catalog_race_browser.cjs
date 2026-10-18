// Danh mục SKU trên máy — các trường hợp review vòng 1 (18/10/2026, docs/plans/2026-10-18-danh-muc-sku-tren-may.md, Việc 5):
//   G1  TÌM SKU: phần đổi đến ĐÚNG LÚC đang dựng chỉ mục (20.000 SKU) → dựng lại, tìm được SKU mới;
//   G3  chưa có bản trên máy + tải toàn bộ lỗi → get() gọi nhiều lần KHÔNG tải lại liên tục (giãn nhịp);
//   G4  IN TEM SKU: gợi ý trên máy rỗng → hỏi máy chủ như cũ (SKU mới đồng bộ vẫn gợi ý được);
//   G6  vừa tải toàn bộ → hỏi phần đổi phát sinh trong lúc tải (maxUpdatedAt) một lần.
// Supabase giả lập, dữ liệu giả 9xxxxxxxx. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const T1 = "2026-10-18T01:00:00+00:00";
const BIG = Array.from({ length: 20000 }, (_, i) => ({ sku: `9100${String(i).padStart(5, "0")}`, product_name: `Vải giả số ${i}`, status: "1" }));
const settle = ms => new Promise(r => setTimeout(r, ms));

const open = async (browser, srv) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const req = route.request(), url = decodeURIComponent(req.url()), json = (b, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes("/rest/v1/SKU_Name?") && url.includes("order=sku.asc") && !/[?&]sku=/.test(url) && !/=(like|ilike)\./.test(url)) {
      srv.full++;
      if (srv.fullFail) return json({ message: "lỗi giả" }, 503);
      const [from, to] = String(req.headers().range || "0-999").split("-").map(Number);
      // dropOnce: lượt tải toàn bộ đầu tiên thiếu một dòng (giả lập trang bị trượt khi dữ liệu đổi giữa chừng)
      const src = srv.dropOnce && srv.full === 1 ? srv.db.slice(0, -1) : srv.db, rows = src.slice(from, to + 1);
      return json(rows, 200, { "content-range": `${from}-${from + rows.length - 1}/${srv.db.length}` });
    }
    if (url.includes("/rest/v1/SKU_Name?")) {
      if (/=(like|ilike)\./.test(url)) { srv.like.push(url); return json(srv.likeRows || []); }
      return json([]);
    }
    if (url.includes("/rpc/sku_catalog_changes")) {
      const body = JSON.parse(req.postData() || "{}"); srv.changes.push(body.p_since ?? null);
      if (srv.slowChanges) await new Promise(r => setTimeout(r, srv.slowChanges));
      const version = { activeCount: srv.db.length, maxUpdatedAt: srv.max || T1 };
      if (!body.p_since) return json({ ok: true, data: { version, tooMany: true, upserts: [], removed: [] } });
      const d = srv.delta || { upserts: [], removed: [] };
      return json({ ok: true, data: { version, tooMany: false, upserts: d.upserts, removed: d.removed } });
    }
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
  return { context, page, errors };
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // G6 + G1
    {
      const srv = { db: BIG.slice(), changes: [], full: 0, like: [] };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#find-sku");
      await page.waitForFunction(() => /Danh mục 20\.000 SKU/.test(document.getElementById("fsk-catalog")?.textContent || ""), null, { timeout: 60000 });
      for (let i = 0; i < 100 && srv.changes.length < 2; i++) await settle(50);
      assert.deepEqual(srv.changes, [null, T1], "G6: vừa tải toàn bộ → hỏi phần đổi phát sinh trong lúc tải một lần");
      // G1: có SKU mới, phần đổi về ngay lúc Tìm SKU đang dựng chỉ mục 20.000 dòng sau khi tải lại trang
      const fresh = { sku: "900000977", product_name: "Băng gai giả mới đồng bộ", status: "1" };
      srv.db.push(fresh); srv.max = "2026-10-18T02:00:00+00:00"; srv.delta = { upserts: [fresh], removed: [] };
      await page.reload();
      await page.waitForFunction(() => window.PrintSkuCatalog?.get("900000977")?.name === "Băng gai giả mới đồng bộ", null, { timeout: 30000 });
      await page.waitForFunction(() => /Danh mục 20\.001 SKU/.test(document.getElementById("fsk-catalog")?.textContent || ""), null, { timeout: 30000 })
        .catch(async () => { throw new Error(`G1: chỉ mục Tìm SKU chưa dựng lại sau phần đổi — nhãn: ${await page.locator("#fsk-catalog").textContent()}`); });
      assert.deepEqual(errors, []);
      await context.close();
    }
    // G3: chưa có bản trên máy + tải toàn bộ lỗi → get() nhiều lần không tải lại liên tục
    {
      const srv = { db: BIG.slice(0, 10), changes: [], full: 0, like: [], fullFail: true };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#home");
      await page.evaluate(async () => { for (let i = 0; i < 5; i++) { window.PrintSkuCatalog.get("900000901"); await new Promise(r => setTimeout(r, 300)); } });
      await settle(500);
      assert.ok(srv.full <= 1, `G3: tải lỗi → không thử lại liên tục (đã gọi ${srv.full} lần)`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // G4: IN TEM SKU — gợi ý trên máy rỗng → hỏi máy chủ
    {
      const srv = { db: BIG.slice(0, 50), changes: [], full: 0, like: [], likeRows: [{ sku: "900000977", product_name: "Băng gai giả mới đồng bộ" }] };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker");
      await page.locator("#f-sku").waitFor();
      await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
      await page.locator("#f-sku").fill("9000009");
      for (let i = 0; i < 60 && !srv.like.length; i++) await settle(50);
      assert.ok(srv.like.length >= 1, "G4: gợi ý trên máy rỗng → hỏi máy chủ (like)");
      srv.like.length = 0;
      await page.locator("#f-sku").fill("910000001");
      await settle(800);
      assert.equal(srv.like.length, 0, "G4: gợi ý trên máy có kết quả → không hỏi máy chủ");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // Vòng 2 · Codex 2: tải toàn bộ thiếu dòng (trượt trang) → số SKU lệch activeCount → tải lại ngay, không lưu bản thiếu
    {
      const srv = { db: BIG.slice(0, 30), changes: [], full: 0, like: [], dropOnce: true };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker");
      await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
      await page.waitForFunction(() => window.PrintSkuCatalog.info().count === 30, null, { timeout: 5000 })
        .catch(async () => { throw new Error(`vòng 2: bản thiếu dòng vẫn được dùng (count=${await page.evaluate(() => window.PrintSkuCatalog.info().count)}, tải ${srv.full} lần)`); });
      assert.deepEqual(errors, []);
      await context.close();
    }
    // Vòng 3 (co-van Fable, hướng B): vá tên khi in chỉ trong RAM, KHÔNG ghi IndexedDB (lần check() sau tự lấy tên đúng vì sku-sync đóng dấu
    // updated_at) → tab giữ bản cũ không ghi lùi được bản mới hơn do tab khác ghi
    {
      const srv = { db: BIG.slice(0, 20), changes: [], full: 0, like: [] };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker");
      await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
      await settle(500);
      const out = await page.evaluate(async () => {
        const idb = (mode, fn) => new Promise((res, rej) => { const r = indexedDB.open("print-sku-find-sku", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", mode), st = tx.objectStore("kv"), q = fn(st); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }; });
        const cur = await idb("readonly", st => st.get("catalog"));
        // "Tab khác" ghi bản mới hơn: phiên bản sau + thêm SKU 900000977
        const newer = { at: cur.at, checkedAt: cur.checkedAt + 1000, version: { activeCount: cur.rows.length + 1, maxUpdatedAt: "2026-10-18T09:00:00+00:00" }, rows: [...cur.rows, ["900000977", "Băng gai giả mới đồng bộ", "1"]] };
        await idb("readwrite", st => st.put(newer, "catalog"));
        // Tab này (bản cũ trong RAM) vá tên khi in
        await window.PrintSkuCatalog.patchNames([{ sku: cur.rows[0][0], productName: "Tên vá khi in" }]);
        const after = await idb("readonly", st => st.get("catalog"));
        const ramName = window.PrintSkuCatalog.get(cur.rows[0][0])?.name;
        await window.PrintSkuCatalog.check(); // lần kiểm kế: nhận bản mới hơn tab khác đã ghi
        return { has977: after.rows.some(r => r[0] === "900000977"), patched: after.rows.find(r => r[0] === cur.rows[0][0])[1], version: after.version.maxUpdatedAt, ramName, ram977AfterCheck: Boolean(window.PrintSkuCatalog.get("900000977")) };
      });
      assert.deepEqual(out,
        { has977: true, patched: "Vải giả số 0", version: "2026-10-18T09:00:00+00:00", ramName: "Tên vá khi in", ram977AfterCheck: true }, "đĩa giữ bản mới hơn, tên vá chỉ trong RAM, lần kiểm sau nhận bản mới");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // Vòng 3 (co-van Fable, hướng B ii): ghi IndexedDB đọc–so–ghi trong một giao dịch — tab khác ghi bản mới hơn TRONG LÚC check() chờ
    // máy chủ thì check() không ghi lùi, mà nhận bản trên đĩa
    {
      const srv = { db: BIG.slice(0, 20), changes: [], full: 0, like: [] };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#worker");
      await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
      await settle(500);
      srv.slowChanges = 1200;
      const out = await page.evaluate(async () => {
        const idb = (mode, fn) => new Promise((res, rej) => { const r = indexedDB.open("print-sku-find-sku", 1); r.onsuccess = () => { const tx = r.result.transaction("kv", mode), st = tx.objectStore("kv"), q = fn(st); tx.oncomplete = () => res(q && q.result); tx.onerror = () => rej(tx.error); }; });
        const cur = await idb("readonly", st => st.get("catalog"));
        const pending = window.PrintSkuCatalog.check();
        await new Promise(r => setTimeout(r, 300)); // check() đang chờ máy chủ
        const newer = { at: cur.at, checkedAt: Date.now(), version: { activeCount: cur.rows.length + 1, maxUpdatedAt: "2026-10-18T09:00:00+00:00" }, rows: [...cur.rows, ["900000977", "Băng gai giả mới đồng bộ", "1"]] };
        await idb("readwrite", st => st.put(newer, "catalog"));
        await pending;
        const after = await idb("readonly", st => st.get("catalog"));
        return { disk977: after.rows.some(r => r[0] === "900000977"), diskVersion: after.version.maxUpdatedAt, ram977: Boolean(window.PrintSkuCatalog.get("900000977")) };
      });
      assert.deepEqual(out, { disk977: true, diskVersion: "2026-10-18T09:00:00+00:00", ram977: true }, "check() không ghi lùi bản tab khác vừa ghi, và nhận bản đó");
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("sku_catalog_race_browser: vừa tải toàn bộ hỏi phần đổi một lần, phần đổi lúc đang dựng chỉ mục được dựng lại, tải lỗi không thử lại liên tục, gợi ý trên máy rỗng thì hỏi máy chủ — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
