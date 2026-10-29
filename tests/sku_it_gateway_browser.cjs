// Cổng window.HasakiSkuIt (17/10/2026, dùng cho TRỢ LÝ IN): readSlip đọc phiếu IT qua Extension + đối chiếu danh mục,
// buildItems dựng item y như nút Phiếu IT → hàng chờ React → lệnh in, enqueue chia ≤ 100 SKU / ≤ 500 tem mỗi lệnh,
// máy chưa kích hoạt (khoá "public") thì báo lỗi trước khi gọi Supabase. Extension và Supabase giả lập; dữ liệu giả.
//   BASE=http://127.0.0.1:8000/ node tests/sku_it_gateway_browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";

const IT = "100000001";
const ITEMS = [
  { sku: "900000001", name: "Hàng giả 1 (tên WMS)", quantity: 2, unit: "pcs" },
  { sku: "900000002", name: "Hàng giả 2 (tên WMS)", quantity: 170000, unit: "mm" },
  { sku: "900000003", name: "Hàng giả 3 (tên WMS)", quantity: 1.5, unit: null },
  { sku: "900000009", name: "Hàng giả ngừng (tên WMS)", quantity: 5, unit: "pcs" },
];
const SLIP = { number: IT, id: 7000001, status: "In-progress", type: "Normal", fromWarehouse: "KHO GIẢ A", toWarehouse: "KHO GIẢ B", description: "ghi chú giả", createdBy: "nguoi.tao@example.com", createdAt: "2026-10-17T01:00:00.000Z", totalItems: ITEMS.length, items: ITEMS, generatedAt: "2026-10-17T01:00:01.000Z" };
const CATALOG = new Map(ITEMS.slice(0, 3).map(item => [item.sku, item.name.replace(" (tên WMS)", " · danh mục")]));

const fakeExtension = slip => {
  window.__extCalls = [];
  addEventListener("message", event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (/^PING/.test(request.type)) return reply(true, { version: "0.12.5" });
    if (request.type === "GET_INTERNAL_TRANSFER") return request.payload.number === slip.number ? reply(true, slip) : reply(false, null, { code: "INTERNAL_TRANSFER_READ_FAILED", message: `Không tìm thấy phiếu IT ${request.payload.number}` });
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [], enqueued = [];
    let enqueueMode = "ok";
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
      const url = route.request().url(), json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      if (url.startsWith(BASE)) return route.continue();
      const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
      if (rpc === "print_enqueue") {
        const body = JSON.parse(route.request().postData() || "{}");
        enqueued.push(body);
        if (enqueueMode === "inactive") return json({ ok: false, error: { code: "SKU_INACTIVE", message: "SKU đã ngừng hoạt động, không in tem mới: 900000002" } });
        if (enqueueMode === "second-fails" && enqueued.length === 2) return json({ ok: false, error: { code: "ACCESS_DENIED", message: "Khoá máy không hợp lệ" } });
        return json({ ok: true, data: { id: `99999999-0000-4000-8000-${String(enqueued.length).padStart(12, "0")}`, status: "queued", duplicate: false } });
      }
      if (rpc === "print_job_status") return json({ ok: true, data: { status: "completed" } });
      if (rpc === "print_queue_status") return json({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: [] } });
      if (rpc) return json([]);
      if (url.includes("/rest/v1/SKU_Name")) {
        const inList = decodeURIComponent(url).match(/sku=in\.\((.*)\)/)?.[1];
        const skus = inList ? inList.split(",").map(s => s.replace(/"/g, "")) : [];
        return json(skus.filter(s => CATALOG.has(s)).map(s => ({ sku: s, product_name: CATALOG.get(s) })));
      }
      if (url.includes("/rest/v1/")) return json([]);
      return json({ ok: true, data: {} });
    });
    await page.addInitScript(fakeExtension, SLIP);
    await page.addInitScript(() => { try { localStorage.setItem("tb-khoa", "tb-khoa-test"); } catch (_) {} });
    await page.goto(BASE + "#worker");
    await page.locator("#f-sku").waitFor();
    await page.evaluate(() => {
      window.__admin = true;
      window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("hết phiên"); return "t"; } };
      window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => window.__admin ? "t" : "", getToken: async () => window.__admin ? "t" : "", logout: () => { window.__admin = false; } };
      dispatchEvent(new Event("print-sku-admin-ready"));
    });

    // API đúng hợp đồng
    const api = await page.evaluate(() => ({ keys: Object.keys(window.HasakiSkuIt).sort(), max: window.HasakiSkuIt.MAX_COPIES, perJob: window.HasakiSkuIt.MAX_SKU_PER_JOB, frozen: Object.isFrozen(window.HasakiSkuIt) }));
    assert.deepEqual(api, { keys: ["MAX_COPIES", "MAX_SKU_PER_JOB", "buildItems", "enqueue", "readSlip"], max: 200, perJob: 100, frozen: true });

    // readSlip: số phiếu sai và chưa Admin báo đúng câu, không gọi WMS
    const fail = expr => page.evaluate(expr).then(() => "", error => error.message);
    assert.match(await fail(() => window.HasakiSkuIt.readSlip("IT-12")), /Số phiếu IT không hợp lệ\./);
    await page.evaluate(() => { window.__admin = false; });
    assert.match(await fail(() => window.HasakiSkuIt.readSlip("100000001")), /Chưa đăng nhập Admin\./);
    await page.evaluate(() => { window.__admin = true; });
    assert.equal(await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_INTERNAL_TRANSFER").length), 0, "chưa Admin / số sai thì không gọi WMS");

    // readSlip đọc đúng phiếu: dòng có cờ danh mục, số bản mặc định 1
    const read = await page.evaluate(number => window.HasakiSkuIt.readSlip(` ${number} `), IT);
    assert.deepEqual(read.slip, { number: IT, id: 7000001, status: "In-progress", type: "Normal", fromWarehouse: "KHO GIẢ A", toWarehouse: "KHO GIẢ B", createdBy: "nguoi.tao@example.com", createdAt: "2026-10-17T01:00:00.000Z", totalItems: 4, description: "ghi chú giả" });
    assert.deepEqual(read.rows, [
      { sku: "900000001", name: "Hàng giả 1 · danh mục", quantity: 2, unit: "pcs", known: true, flag: null, copies: 1 },
      { sku: "900000002", name: "Hàng giả 2 · danh mục", quantity: 170000, unit: "mm", known: true, flag: null, copies: 1 },
      { sku: "900000003", name: "Hàng giả 3 · danh mục", quantity: 1.5, unit: null, known: true, flag: null, copies: 1 },
      { sku: "900000009", name: "Hàng giả ngừng (tên WMS)", quantity: 5, unit: "pcs", known: false, flag: "Không có trong danh mục", copies: 1 },
    ]);
    assert.equal(read.note, "");
    assert.deepEqual(await page.evaluate(() => window.__extCalls.map(c => c.type).filter(t => t !== "PING")), ["PING_WMS", "GET_INTERNAL_TRANSFER"]);
    assert.match(await fail(() => window.HasakiSkuIt.readSlip("100000002")), /Không tìm thấy phiếu IT 100000002/);

    // buildItems y hệt item nút Phiếu IT → hàng chờ React → lệnh in (cùng phiếu, số bản 1/3/1, bỏ dòng ngừng)
    await page.locator("#root .skit-open").click();
    await page.locator("#sku-it-input").fill(IT); await page.locator("#sku-it-load").click();
    await page.waitForFunction(() => document.querySelectorAll("#sku-it-list .skit__item").length === 4);
    const second = page.locator("#sku-it-list .skit__item").nth(1);
    await second.locator('[data-step="1"]').click(); await second.locator('[data-step="1"]').click();
    await page.locator("#sku-it-add").click();
    await page.waitForFunction(() => document.querySelector("#root main ul.divide-y")?.children.length === 3);
    await page.locator("#root button.act-icon--print").first().click();
    for (let i = 0; i < 50 && !enqueued.length; i++) await page.waitForTimeout(100);
    assert.equal(enqueued.length, 1, "nút Phiếu IT gửi một lệnh in");
    const viaButton = enqueued[0].p_payload.items;
    const viaGateway = await page.evaluate(rows => window.HasakiSkuIt.buildItems(rows), read.rows.map((row, i) => ({ ...row, copies: i === 1 ? 3 : 1 })));
    assert.deepEqual(viaGateway, viaButton, "buildItems khớp item lệnh in của nút Phiếu IT");
    assert.match(viaGateway[0].printedDate, /^\d{2}\/\d{2}\/\d{2}$/);
    assert.deepEqual(viaGateway.map(item => item.quantity), ["2", "170000", "1.5"], "số lượng theo phiếu dạng chuỗi");
    // Dòng on=false hoặc copies 0 bị bỏ; copies > 200 báo lỗi
    assert.equal((await page.evaluate(rows => window.HasakiSkuIt.buildItems(rows), [{ ...read.rows[0], on: false }, { ...read.rows[1], copies: 0 }, read.rows[2]])).length, 1);
    assert.match(await page.evaluate(rows => { try { window.HasakiSkuIt.buildItems(rows); return ""; } catch (e) { return e.message; } }, [{ ...read.rows[0], copies: 201 }]), /Số bản in mỗi SKU từ 1 đến 200/);
    enqueued.length = 0;

    // enqueue 101 SKU → 2 lệnh (100 + 1), mỗi lệnh nonce UUID riêng, khoá máy đúng, requestedBy ≤ 100
    const many = Array.from({ length: 101 }, (_, i) => ({ sku: `900001${String(i).padStart(3, "0")}`, productName: `Hàng giả ${i}`, quantity: "10", printedDate: "17/10/26", copies: 1 }));
    const longBy = `tro-ly:${"a".repeat(120)}@example.com`;
    const sent = await page.evaluate(([items, by]) => window.HasakiSkuIt.enqueue(items, { requestedBy: by }), [many, longBy]);
    assert.deepEqual(sent, { jobIds: ["99999999-0000-4000-8000-000000000001", "99999999-0000-4000-8000-000000000002"], labels: 101 });
    assert.equal(enqueued.length, 2);
    assert.deepEqual(enqueued.map(job => [job.p_type, job.p_payload.items.length, job.p_copies]), [["sku", 100, 100], ["sku", 1, 1]]);
    assert.ok(enqueued.every(job => job.p_access_token === "tb-khoa-test" && job.p_requested_by === longBy.slice(0, 100) && /^[0-9a-f-]{36}$/.test(job.p_nonce)));
    assert.notEqual(enqueued[0].p_nonce, enqueued[1].p_nonce);
    assert.deepEqual(enqueued[0].p_payload.items[0], many[0]);
    enqueued.length = 0;

    // nonceBase: nonce ổn định theo lô (`${base}-${chỉ số lệnh}`), gọi lại cùng base cho cùng nonce → print_enqueue upsert, không tạo lệnh trùng
    const base = "11111111-2222-4333-8444-555555555555";
    await page.evaluate(([items, nonceBase]) => window.HasakiSkuIt.enqueue(items, { requestedBy: "tro-ly", nonceBase }), [many, base]);
    await page.evaluate(([items, nonceBase]) => window.HasakiSkuIt.enqueue(items, { requestedBy: "tro-ly", nonceBase }), [many, base]);
    assert.deepEqual(enqueued.map(job => job.p_nonce), [`${base}-0`, `${base}-1`, `${base}-0`, `${base}-1`], "cùng nonceBase → cùng nonce theo từng lệnh");
    enqueued.length = 0;

    // ≤ 500 tem mỗi lệnh: 3 SKU × 200 bản → 400 + 200
    const heavy = many.slice(0, 3).map(item => ({ ...item, copies: 200 }));
    assert.deepEqual((await page.evaluate(items => window.HasakiSkuIt.enqueue(items, { requestedBy: "tro-ly:admin-test@example.com" }), heavy)).labels, 600);
    assert.deepEqual(enqueued.map(job => [job.p_payload.items.length, job.p_copies]), [[2, 400], [1, 200]]);
    enqueued.length = 0;

    // Lệnh bị từ chối: SKU_INACTIVE → lỗi mang thông điệp RPC; lệnh 2 lỗi → lỗi kèm mã lệnh 1 đã gửi
    enqueueMode = "inactive";
    const inactive = await page.evaluate(items => window.HasakiSkuIt.enqueue(items, {}).then(() => null, e => ({ message: e.message, code: e.code, jobIds: e.jobIds })), many.slice(0, 2));
    assert.deepEqual(inactive, { message: "SKU đã ngừng hoạt động, không in tem mới: 900000002", code: "SKU_INACTIVE", jobIds: [] });
    enqueued.length = 0; enqueueMode = "second-fails";
    const partial = await page.evaluate(items => window.HasakiSkuIt.enqueue(items, {}).then(() => null, e => ({ message: e.message, code: e.code, jobIds: e.jobIds, labels: e.labels })), many);
    assert.deepEqual(partial, { message: "Khoá máy không hợp lệ", code: "ACCESS_DENIED", jobIds: ["99999999-0000-4000-8000-000000000001"], labels: 100 });
    enqueued.length = 0; enqueueMode = "ok";

    // Máy chưa kích hoạt (khoá trống hoặc "public") → báo đúng câu, không gọi Supabase
    for (const key of ["public", ""]) {
      await page.evaluate(value => localStorage.setItem("tb-khoa", value), key);
      assert.equal(await page.evaluate(items => window.HasakiSkuIt.enqueue(items, {}).then(() => "", e => e.message), many.slice(0, 1)), "Máy này chưa kích hoạt in; vào ô KÍCH HOẠT MÁY trước.");
    }
    assert.equal(enqueued.length, 0, "chưa kích hoạt thì không gọi print_enqueue");
    await page.evaluate(() => localStorage.setItem("tb-khoa", "tb-khoa-test"));
    assert.equal(await page.evaluate(() => window.HasakiSkuIt.enqueue([], {}).then(() => "", e => e.message)), "Chưa có SKU nào để in.");

    assert.deepEqual(errors, []);
    await context.close();
    console.log("sku_it_gateway_browser: đạt (HasakiSkuIt: readSlip + danh mục, buildItems = item nút Phiếu IT, enqueue chia 100 SKU / 500 tem, khoá public, lỗi RPC)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
