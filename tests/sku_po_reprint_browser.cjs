// IN TEM SKU: in lại tem có PO khi thêm SKU đã nhận theo PO, trên mẫu tem SKU gộp v3 (23/10/2026,
// docs/plans/2026-10-23-in-lai-tem-sku-po.md + docs/plans/2026-10-23-gop-tem-sku-mot-mau.md).
//   * SKU một PO → chọn sẵn (không pop-up), chip PO; SKU nhiều PO → pop-up chỉ số PO, mới nhất trên; chưa có PO → tem thường;
//     Hủy → không thêm; tra lỗi → Thử lại / In tem thường / Hủy; đổi ô SKU lúc đang tra → không ghi PO cho SKU cũ.
//   * In: MỘT lệnh; có agent 'sku:v3' → template 3, item có PO mang po + receivedDate (database) + số lượng người dùng nhập;
//     agent cũ: tem không PO → template 1 như trước, có PO → báo lỗi, không gửi; mất phản hồi rồi bấm lại → cùng nonce (không in trùng).
// Supabase giả lập, dữ liệu giả (SKU 9000009xx, PO 1001260000xxxx). Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const CATALOG = [
  { sku: "900000911", product_name: "Chỉ giả một PO", status: "1" },
  { sku: "900000912", product_name: "Chỉ giả hai PO", status: "1" },
  { sku: "900000913", product_name: "Chỉ giả chưa có PO", status: "1" },
];
const POS = {
  "900000911": [{ po: "10012600000011", receivedDate: "22/10/2026" }],
  "900000912": [{ po: "10012600000022", receivedDate: "23/10/2026" }, { po: "10012600000021", receivedDate: "20/10/2026" }, { po: "PO SAI MẪU QUÁ HAI MƯƠI KÝ TỰ", receivedDate: "" }],
};

const mock = (srv, BASE) => route => {
  const req = route.request(), url = req.url(), json = (b, status = 200, headers = {}) => route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(b) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.includes("/rest/v1/SKU_Name?") && url.includes("order=sku.asc")) return json(CATALOG, 200, { "content-range": `0-2/3` });
  if (url.includes("/rpc/sku_catalog_changes")) return json({ ok: true, data: { version: { activeCount: 3, maxUpdatedAt: "2026-10-23T01:00:00+00:00" }, tooMany: true, upserts: [], removed: [] } });
  if (url.includes("/rpc/sku_combo_lookup")) return json([]);
  if (url.includes("/rpc/sku_po_lookup")) {
    if (srv.lookupFail) return json({ message: "lỗi" }, 500);
    const skus = req.postDataJSON().p_skus;
    if (srv.lookupDelay) return new Promise(resolve => setTimeout(resolve, srv.lookupDelay)).then(() => json({ ok: true, data: { items: skus.map(sku => ({ sku, pos: POS[sku] || [] })) } }));
    return json({ ok: true, data: { items: skus.map(sku => ({ sku, pos: POS[sku] || [] })) } });
  }
  if (url.includes("/rpc/print_queue_status") && srv.statusDenied) return json({ ok: false, error: { code: "ACCESS_DENIED", message: "Máy này chưa được cấp quyền in" } });
  if (url.includes("/rpc/print_queue_status")) return json({ ok: true, data: { queued: 0, queuedCopies: 0, agents: [{ id: "may-test", lastSeenAt: new Date().toISOString(), capabilities: srv.caps, printer: {} }] } });
  if (url.includes("/rpc/print_enqueue")) {
    const body = req.postDataJSON();
    srv.enqueues.push(body);
    if (srv.dropOnce) { srv.dropOnce = false; srv.seen.set(body.p_nonce, `job-${++srv.n}`); return route.abort("connectionreset"); } // máy chủ đã nhận, phản hồi mất
    if (srv.seen.has(body.p_nonce)) return json({ ok: true, data: { id: srv.seen.get(body.p_nonce), status: "queued", duplicate: true } });
    const id = `job-${++srv.n}`; srv.seen.set(body.p_nonce, id);
    return json({ ok: true, data: { id, status: "queued", duplicate: false } });
  }
  if (url.includes("/rpc/print_job_status")) { srv.statusIds.push(req.postDataJSON().p_job_id); return json({ ok: true, data: { status: "completed" } }); }
  if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => { try { localStorage.setItem("tb-khoa", "khoa-test-0001"); } catch (_) {} });
    const page = await context.newPage(), errors = [];
    const srv = { enqueues: [], statusIds: [], caps: ["sku:v1", "sku:v2", "sku:v3"], lookupFail: false, lookupDelay: 0, dropOnce: false, seen: new Map(), n: 0 };
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", mock(srv, BASE));
    await page.goto(BASE + "#worker");
    await page.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true && window.PrintSkuPo, null, { timeout: 15000 });

    const rows = () => page.locator(".skq-list .skq-item").count();
    const add = async (sku, { qty = "", dialog = null } = {}) => {
      await page.locator("#f-sku").fill(sku);
      await page.waitForFunction(() => document.getElementById("f-pn")?.value.trim() && !/Đang đối chiếu tên/.test(document.getElementById("root").innerText), null, { timeout: 5000 });
      await page.waitForTimeout(400); // tên lấy từ lần in trước: bundle còn đối chiếu danh mục một nhịp
      if (qty) await page.locator("#f-sl").fill(qty);
      await page.locator("#sku-add-to-list").click();
      if (dialog) { await page.locator(".sku-po-dialog").waitFor({ state: "visible", timeout: 5000 }); await dialog(); }
    };
    // Đủ n dòng VÀ hết animation chibi in: lệnh vào hàng chờ thì danh sách xoá ngay, nhưng hộp modal còn bật tick ~0,7 s
    // và khoá form (trang inert) — gõ ô SKU lúc đó sẽ mất, như người dùng phải chờ hộp đóng.
    const waitRows = async n => {
      await page.waitForFunction(count => document.querySelectorAll(".skq-list .skq-item").length === count, n, { timeout: 5000 });
      await page.locator("#print-chibi-overlay").waitFor({ state: "hidden", timeout: 5000 });
    };
    const chipOf = sku => page.locator(".skq-list .skq-item", { hasText: sku }).locator(".skq-po");
    const print = () => page.locator("#root button.act-icon--print.pbtn--compact").click();

    // SKU nhiều PO: pop-up chỉ số PO, mới nhất trên cùng, không hiện ngày nhận; PO sai mẫu agent bị bỏ
    await add("900000912", { qty: "1200", dialog: async () => {
      assert.deepEqual(await page.locator(".sku-po-dialog .sku-po-option").allInnerTexts(), ["10012600000022", "10012600000021"], "PO mới nhất trên cùng, bỏ PO sai mẫu");
      assert.doesNotMatch(await page.locator(".sku-po-dialog").innerText(), /\d{2}\/\d{2}\/\d{4}|lần/, "không hiện ngày nhận / số lần in");
      if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/po-popup-1280.png` });
      await page.locator(".sku-po-dialog .sku-po-option", { hasText: "10012600000021" }).click();
    } });
    await waitRows(1);
    assert.equal((await chipOf("900000912").innerText()).trim(), "PO 10012600000021");
    await add("900000911", { qty: "50" });
    await waitRows(2);
    assert.equal(await page.locator(".sku-po-dialog").count(), 0, "một PO → không pop-up");
    assert.equal((await chipOf("900000911").innerText()).trim(), "PO 10012600000011");
    await add("900000913", { qty: "7" });
    await waitRows(3);
    assert.equal(await chipOf("900000913").count(), 0);
    // Hủy → không thêm
    await add("900000912", { dialog: () => page.locator(".sku-po-dialog .sku-combo-action--ghost").click() });
    await page.waitForTimeout(400);
    assert.equal(await rows(), 3, "Hủy thì không thêm dòng");

    // Agent cũ (chưa sku:v3) + có PO → báo lỗi, không gửi
    srv.caps = ["sku:v1", "sku:v2"];
    await print();
    await page.waitForFunction(() => /cần agent 0\.10\.2/.test(document.body.innerText), null, { timeout: 5000 });
    assert.equal(srv.enqueues.length, 0);

    // Có sku:v3: MỘT lệnh template 3; mất phản hồi → bấm lại cùng nonce → máy chủ trả lệnh cũ (không in trùng), danh sách xoá
    srv.caps = ["sku:v1", "sku:v2", "sku:v3"];
    srv.dropOnce = true;
    await print();
    await page.waitForFunction(() => document.querySelector("#root button.act-icon--print.pbtn--compact")?.dataset.printState !== "sending", null, { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
    assert.equal(srv.enqueues.length, 1, "lần 1 đã tới máy chủ (phản hồi mất)");
    assert.equal(await rows(), 3, "lỗi mơ hồ: danh sách còn nguyên");
    await print();
    await waitRows(0);
    assert.equal(srv.enqueues.length, 2);
    const [first, second] = srv.enqueues;
    assert.equal(first.p_template_version, 3);
    assert.equal(second.p_nonce, first.p_nonce, "bấm lại sau mất phản hồi dùng lại nonce cũ");
    assert.deepEqual(first.p_payload.items.map(i => [i.sku, i.po || "", i.receivedDate || "", i.quantity, i.copies]), [
      ["900000912", "10012600000021", "20/10/2026", "1200", 1],
      ["900000911", "10012600000011", "22/10/2026", "50", 1],
      ["900000913", "", "", "7", 1],
    ], "một lệnh: tem có PO mang PO + ngày + số lượng, tem không PO giữ như cũ");
    assert.ok(!("po" in first.p_payload.items[2]), "tem không PO không có khoá po");
    assert.doesNotMatch(await page.locator("body").innerText(), /vừa gửi rồi/, "lần bấm lại sau lỗi không báo trùng");
    await page.waitForTimeout(1500);
    assert.ok(srv.statusIds.includes("job-1"), `hỏi trạng thái lệnh: ${srv.statusIds}`);
    assert.equal(await page.evaluate(() => window.PrintSkuPo.get("900000912")), null, "gửi xong thì bỏ lựa chọn PO");

    // Không PO → template 1 dù đã có agent v3 (mọi agent nhận; tem giống hệt v3) và không cần hỏi trạng thái máy in
    await add("900000913");
    await waitRows(1);
    await print();
    await waitRows(0);
    assert.equal(srv.enqueues.at(-1).p_template_version, 1, "không PO → v1");

    // Cùng SKU đã có dòng với PO khác → chặn (dòng cũ không bị đổi PO)
    await add("900000912", { dialog: () => page.locator(".sku-po-dialog .sku-po-option", { hasText: "10012600000021" }).click() });
    await waitRows(1);
    await add("900000912", { dialog: () => page.locator(".sku-po-dialog .sku-po-option", { hasText: "10012600000022" }).click() });
    await page.locator(".whd-ok").waitFor({ state: "visible", timeout: 5000 });
    assert.match(await page.locator(".whd-ok").locator("xpath=ancestor::*[self::dialog or @role='dialog'][1]").innerText(), /SKU đã có trong danh sách[\s\S]*PO 10012600000021/);
    await page.locator(".whd-ok").click();
    await page.waitForTimeout(300);
    assert.equal(await rows(), 1, "không thêm dòng");
    assert.equal((await page.evaluate(() => window.PrintSkuPo.get("900000912")))?.po, "10012600000021", "dòng cũ giữ PO cũ");
    // Cùng SKU cùng PO → cho thêm
    await add("900000912", { dialog: () => page.locator(".sku-po-dialog .sku-po-option", { hasText: "10012600000021" }).click() });
    await waitRows(2);
    // Máy chưa được cấp quyền (ACCESS_DENIED khi hỏi trạng thái) → báo đúng, không báo "cần agent"
    srv.statusDenied = true;
    await print();
    await page.waitForFunction(() => /chưa được cấp quyền in/.test(document.body.innerText), null, { timeout: 5000 });
    assert.doesNotMatch(await page.locator("body").innerText(), /cần agent 0\.10\.2/);
    srv.statusDenied = false;
    assert.equal(await page.locator("#pdv-dialog").evaluate(d => d.open), true, "lỗi quyền → mở hộp kích hoạt máy");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.getElementById("pdv-dialog")?.open);
    await page.waitForTimeout(300);
    await print(); // hết lỗi quyền → gửi được, danh sách xoá
    await waitRows(0);
    const twoRows = srv.enqueues.at(-1);
    assert.deepEqual(twoRows.p_payload.items.map(i => [i.sku, i.po]), [["900000912", "10012600000021"], ["900000912", "10012600000021"]], "hai dòng cùng SKU cùng PO");

    // Đổi ô SKU trong lúc đang tra PO → không ghi PO cho SKU cũ, không thêm dòng
    srv.lookupDelay = 1500;
    await page.locator("#f-sku").fill("900000911");
    await page.waitForFunction(() => document.getElementById("f-pn")?.value.trim(), null, { timeout: 5000 });
    await page.locator("#sku-add-to-list").click();
    await page.waitForTimeout(200);
    await page.locator("#f-sku").fill("900000913");
    await page.waitForTimeout(2000);
    srv.lookupDelay = 0;
    assert.equal(await page.evaluate(() => window.PrintSkuPo.get("900000911")), null, "SKU cũ không bị ghi PO");
    assert.equal(await rows(), 0);

    // Tra PO lỗi → pop-up lỗi: In tem thường thêm dòng không PO
    srv.lookupFail = true;
    await add("900000912", { dialog: async () => {
      assert.match(await page.locator(".sku-po-dialog h2").innerText(), /Chưa tra được PO/);
      assert.equal(await page.locator(".sku-po-dialog .sku-combo-action--primary").innerText(), "Thử lại");
      await page.locator(".sku-po-dialog .sku-combo-action--secondary").click();
    } });
    await waitRows(1);
    assert.equal(await chipOf("900000912").count(), 0, "In tem thường → không PO");
    srv.lookupFail = false;
    assert.deepEqual(errors, []);
    await context.close();

    // 390 px: pop-up vừa màn (ảnh cho review)
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.addInitScript(() => { try { localStorage.setItem("tb-khoa", "khoa-test-0001"); } catch (_) {} });
    const p2 = await phone.newPage();
    await p2.route("**/*", mock({ enqueues: [], statusIds: [], caps: ["sku:v3"], seen: new Map(), n: 0 }, BASE));
    await p2.goto(BASE + "#worker");
    await p2.waitForFunction(() => window.PrintSkuCatalog?.ready?.() === true, null, { timeout: 15000 });
    await p2.locator("#f-sku").fill("900000912");
    await p2.waitForFunction(() => document.getElementById("f-pn")?.value.trim(), null, { timeout: 5000 });
    await p2.locator("#sku-add-to-list").click();
    await p2.locator(".sku-po-dialog").waitFor({ state: "visible", timeout: 5000 });
    const box = await p2.locator(".sku-po-dialog").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 390, "390px: pop-up nằm trong màn");
    if (process.env.SHOTS) await p2.screenshot({ path: `${process.env.SHOTS}/po-popup-390.png` });
    await phone.close();
    console.log("sku_po_reprint_browser: một PO chọn sẵn, nhiều PO pop-up (chỉ số PO, mới nhất trên, bỏ PO sai mẫu), chưa có PO tem thường, Hủy, tra lỗi, đổi ô lúc tra, một lệnh v3 kèm số lượng, agent cũ (v1 / chặn có PO), mất phản hồi bấm lại cùng nonce, 390px passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
