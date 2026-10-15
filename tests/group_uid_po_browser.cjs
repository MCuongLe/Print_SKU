// IN TEM GROUP UID → Gán tự động → Mã PO: đọc Packing List WMS qua Extension, đổi Combo sang SKU Normal, điền sẵn SKU + số UID (số cuộn).
// Lot/Roll không cần: tem in trước khi nhận hàng, WMS gán Lot/Roll lúc nhận. Chạy với python -m http.server 8000; Extension và Supabase giả lập.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = "http://127.0.0.1:8000/";

// --- Packing List giả (mỗi dòng một cuộn) ---
const pl = (po, sku, i, extra = {}) => ({ purchase_order: po, shipment: "1001260803118522", sku, product_name: `(Combo) Vải ${sku}/kg`, quantity: 18 + (i % 5) / 10, code: `1148/8-${String(i + 1).padStart(3, "0")}`, batch_code: "1148/8", status: "Approved", delivery: "PARTIAL", ...extra });
const PO1 = "10012608011632", PO2 = "10012606143838", PO_BIG = "10012600000500", PO_NONE = "10012699999999";
const data = {
  [PO1]: [
    ...Array.from({ length: 53 }, (_, i) => pl(PO1, "422513455", i)),
    ...Array.from({ length: 2 }, (_, i) => pl(PO1, "422494699", i, { quantity: 1, code: "1", batch_code: i ? "590/9" : "591/9" })), // PO thật 10012610099966: 2 cây vải, mỗi cây một dòng số lượng 1 mã "1"
    pl(PO1, "422513455", 60, { status: "Draft" }), // chưa Approved
    ...Array.from({ length: 3 }, (_, i) => pl(PO1, "422427353", i)), // Combo nhiều thành phần
    ...Array.from({ length: 4 }, (_, i) => pl(PO1, "422280728", i, { product_name: "Vải warp knit/TIVNHH/300gsm/mét", quantity: 60 + i })), // SKU Normal sẵn
  ],
  [PO2]: Array.from({ length: 140 }, (_, i) => pl(PO2, "422494699", i, { code: String(i + 1), batch_code: "187/9" })),
  [PO_BIG]: Array.from({ length: 520 }, (_, i) => pl(PO_BIG, "422513455", i)),
};
const COMBOS = { "422513455": [{ normal_sku: "422513459", product_name: "Vải Single Normal 422513459", category_name: "Vải", quantity: 1000, available: true }],
  "422494699": [{ normal_sku: "422494704", product_name: "Vải Jersey Normal 422494704", category_name: "Vải", quantity: 1000, available: true }],
  "422427353": ["422500001", "422500002", "422500003"].map(n => ({ normal_sku: n, product_name: `Normal ${n}`, category_name: "Vải", quantity: 1, available: true })) };

const fakeExtension = packing => {
  window.__extCalls = []; window.__fail = false; window.__packing = packing;
  addEventListener("message", event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return reply(true, { version: "0.8.4" });
    if (request.type === "GET_PACKING_LIST_PAGE") {
      if (window.__fail) return reply(false, null, { message: "Phiên WMS không còn quyền đọc Packing List; hãy đăng nhập lại" });
      const { purchaseOrders, page, size } = request.payload;
      const rows = purchaseOrders.flatMap(po => window.__packing[po] || []);
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: rows.slice((page - 1) * size, page * size), sourceRows: rows.length, purchaseOrders });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

const comboCalls = [];
async function open(browser, width, { stub = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/rpc/sku_combo_lookup")) { const sku = route.request().postDataJSON().p_sku; comboCalls.push(sku); return json(COMBOS[sku] || []); }
    if (url.endsWith("/rpc/group_uid_lookup")) return json([]);
    if (url.includes("/rest/v1/SKU_Name")) return json([{ product_name: "Tên SKU tra từ Supabase" }]);
    return json({ ok: true, data: { agents: [], jobs: [] } });
  });
  await page.addInitScript(fakeExtension, data);
  await page.goto(`${BASE}#group-uid`);
  if (stub) await page.evaluate(() => {
    window.__admin = true; window.__getTokenCalls = 0;
    window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("hết phiên"); return "test-admin-token"; } };
    window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => window.__admin ? "t" : "", getToken: async () => { window.__getTokenCalls++; return window.__admin ? "t" : ""; } };
  });
  return { page, errors };
}
const packingCalls = page => page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_PACKING_LIST_PAGE").map(c => c.payload));
const autoRows = page => page.evaluate(() => [...document.querySelectorAll("#uid-auto-rows .uid-auto__row")].map(r => ({ sku: r.querySelector('[data-field="sku"]').value, qty: Number(r.querySelector('[data-field="qty"]').value), name: r.querySelector('[data-field="name"]').value })));
const help = page => page.locator("#uid-auto-help").innerText();
const run = async (page, text) => { await page.locator("#uid-po-input").fill(text); await page.locator("#uid-po-go").click(); await page.waitForFunction(() => document.getElementById("uid-po-go").dataset.busy !== "true"); };

async function desktop(browser) {
  const { page, errors } = await open(browser, 1280);
  await page.locator("#uid-tab-auto").click();
  assert.equal(await page.locator("#uid-po-box").isVisible(), true, "ô nhập PO nằm trong tab Gán tự động");
  const [inputBox, buttonBox] = await Promise.all([page.locator("#uid-po-input").boundingBox(), page.locator("#uid-po-go").boundingBox()]);
  assert.equal(Math.round(inputBox.y), Math.round(buttonBox.y), "ô PO và nút cùng một hàng");
  assert.ok(inputBox.height >= 44 && buttonBox.height >= 44);
  assert.equal(await page.locator("#uid-po-input").getAttribute("placeholder"), "Mã PO");

  // Mã PO sai: không gọi WMS
  await run(page, "abc");
  assert.match(await help(page), /Chưa có mã PO hợp lệ/);
  assert.deepEqual(await packingCalls(page), []);

  // PO có Packing List: đổi Combo → Normal, đếm cuộn
  await run(page, PO1);
  assert.deepEqual(await packingCalls(page), [{ purchaseOrders: [PO1], page: 1, size: 500 }]);
  assert.deepEqual(await autoRows(page), [
    { sku: "422513459", qty: 53, name: "Vải Single Normal 422513459" },
    { sku: "422494704", qty: 2, name: "Vải Jersey Normal 422494704" },
    { sku: "422280728", qty: 4, name: "Vải warp knit/TIVNHH/300gsm/mét" },
  ]);
  let text = await help(page);
  assert.ok(text.startsWith(`PO ${PO1} · 59 UID · 3 SKU Normal`), text);
  assert.ok(!/chưa chia cuộn/.test(text), "dòng số lượng 1 mã 1 vẫn là một cuộn");
  assert.match(text, /Combo nhiều thành phần: 422427353/);
  assert.match(text, /1 dòng chưa Approved/);
  assert.equal(await page.locator("#uid-auto-help").getAttribute("data-tone"), "warn");
  assert.equal(await page.locator("#uid-auto-total").innerText(), "59/0", "tổng số UID cần so với UID đang chờ gán");
  const ticks = page.locator("#uid-auto-rows .uid-auto__pick input");
  assert.equal(await ticks.count(), 3);
  assert.deepEqual(await ticks.evaluateAll(list => list.map(e => e.checked)), [true, true, true], "dòng từ Packing List mặc định đã tick");
  assert.equal(await page.locator("#uid-auto-total").getAttribute("data-over"), "true", "thiếu UID thì số tổng báo đỏ");

  // Thiếu UID chờ gán: báo lỗi, không gán gì
  assert.equal(await page.locator("#uid-auto-apply").isDisabled(), false, "nút vẫn bấm được để thấy lỗi");
  await page.locator("#uid-auto-apply").click();
  await page.waitForFunction(() => /^Thiếu/.test(document.getElementById("uid-auto-help").textContent));
  assert.equal(await help(page), "Thiếu 59 UID chờ gán: cần 59, đang chờ 0");
  assert.equal(await page.locator("#uid-auto-help").getAttribute("data-tone"), "error");
  assert.equal(await page.locator("#uid-ready-count").textContent(), "0");

  // Chọn UID New rồi tick SKU cần gán: bỏ tick dòng 53 cuộn, chỉ gán 2 + 4 = 6 UID
  const codes = Array.from({ length: 59 }, (_, i) => `1028261014${String(i + 1).padStart(6, "0")}`);
  await page.evaluate(list => window.PrintSkuUid.add(list.map(code => ({ group_uid_code: code, batch_code: null, roll_code: null }))), codes.slice(0, 6));
  await page.waitForFunction(() => document.getElementById("uid-pending-count").textContent === "6");
  await ticks.nth(0).uncheck();
  assert.equal(await page.locator("#uid-auto-total").innerText(), "6/6", "tổng chỉ tính dòng đã tick");
  assert.equal(await page.locator("#uid-auto-total").getAttribute("data-over"), "false");
  await page.locator("#uid-auto-apply").click();
  await page.waitForFunction(() => document.getElementById("uid-ready-count").textContent === "6");
  assert.equal(await page.locator("#uid-pending-count").textContent(), "0");
  let ready = await page.locator("#uid-ready").innerText();
  assert.ok(ready.includes("422494704") && ready.includes("Vải Jersey Normal 422494704") && ready.includes("422280728"), "tem mang SKU Normal và tên Normal");
  assert.ok(!ready.includes("422513459"), "dòng chưa tick không được gán");
  assert.ok(!/Lot:|Roll:/.test(ready), "không có Lot/Roll: WMS gán lúc nhận hàng");
  assert.match(await page.locator("#uid-status").innerText(), /Đã gán tự động 6 UID theo 2 dòng SKU/);
  assert.deepEqual(await autoRows(page), [{ sku: "422513459", qty: 53, name: "Vải Single Normal 422513459" }], "dòng đã gán bị bỏ, dòng chưa tick giữ lại để gán sau");
  assert.deepEqual(await ticks.evaluateAll(list => list.map(e => e.checked)), [false]);

  // Đủ UID rồi tick lại dòng còn lại để gán nốt
  await page.evaluate(list => window.PrintSkuUid.add(list.map(code => ({ group_uid_code: code, batch_code: null, roll_code: null }))), codes.slice(6));
  await page.waitForFunction(() => document.getElementById("uid-pending-count").textContent === "53");
  assert.equal(await page.locator("#uid-auto-apply").isDisabled(), true, "không tick dòng nào thì chưa gán được");
  await ticks.nth(0).check();
  assert.equal(await page.locator("#uid-auto-total").innerText(), "53/53");
  await page.locator("#uid-auto-apply").click();
  await page.waitForFunction(() => document.getElementById("uid-ready-count").textContent === "59");
  assert.equal(await page.locator("#uid-pending-count").textContent(), "0");
  assert.deepEqual(await autoRows(page), [{ sku: "", qty: 1, name: "" }], "gán hết thì còn một dòng trống");

  // Nhiều PO một lần, gộp theo SKU Normal; Combo tra Supabase đúng một lần mỗi SKU
  comboCalls.length = 0;
  await run(page, `${PO1}, ${PO2}\n${PO1}`);
  assert.deepEqual((await packingCalls(page)).at(-1), { purchaseOrders: [PO1, PO2], page: 1, size: 500 }, "mã trùng chỉ gửi một lần");
  const two = await autoRows(page);
  assert.deepEqual(two.map(r => [r.sku, r.qty]), [["422513459", 53], ["422494704", 142], ["422280728", 4]], "Combo của hai PO cùng Normal thì cộng lại");
  assert.match(await help(page), /^2 PO · 199 UID · 3 SKU Normal/);
  assert.equal(new Set(comboCalls).size, comboCalls.length, "mỗi SKU tra Combo một lần");

  // Quá 500 cuộn: giới hạn 500 và báo; Packing List chia 2 trang
  await run(page, PO_BIG);
  assert.deepEqual((await packingCalls(page)).slice(-2).map(c => c.page), [1, 2], "520 dòng = 2 trang");
  assert.deepEqual((await autoRows(page)).map(r => [r.sku, r.qty]), [["422513459", 500]]);
  assert.match(await help(page), /1 SKU quá 500 UID, đã giới hạn/);

  // PO chưa có Packing List: báo, giữ nguyên danh sách đang có
  await run(page, PO_NONE);
  assert.match(await help(page), new RegExp(`Chưa có Packing List: ${PO_NONE}`));
  assert.deepEqual((await autoRows(page)).map(r => r.sku), ["422513459"], "không có dòng nào thì giữ nguyên");

  // Lỗi Extension
  await page.evaluate(() => { window.__fail = true; });
  await run(page, PO1);
  assert.match(await help(page), /Không đọc được Packing List: Phiên WMS không còn quyền/);
  assert.equal(await page.locator("#uid-po-go").isDisabled(), false, "lỗi xong nút dùng lại được");

  // Enter trong ô PO cũng đọc
  await page.evaluate(() => { window.__fail = false; });
  const before = (await packingCalls(page)).length;
  await page.locator("#uid-po-input").fill(PO2); await page.locator("#uid-po-input").press("Enter");
  await page.waitForFunction(n => window.__extCalls.filter(c => c.type === "GET_PACKING_LIST_PAGE").length > n, before);

  assert.deepEqual(errors, []);
  await page.close();
}

// Đọc từ WMS chỉ cho Admin
async function gate(browser) {
  const { page, errors } = await open(browser, 1280);
  await page.evaluate(() => { window.__admin = false; });
  await page.locator("#uid-tab-auto").click();
  await run(page, PO1);
  assert.match(await help(page), /Chưa đăng nhập Admin/);
  assert.equal(await page.evaluate(() => window.__getTokenCalls), 1, "mở hộp đăng nhập Admin dùng chung");
  assert.deepEqual(await packingCalls(page), [], "chưa Admin thì không gọi WMS");
  assert.deepEqual(errors, []);
  await page.close();
  const real = await open(browser, 1280, { stub: false });
  await real.page.locator("#uid-tab-auto").click();
  await run(real.page, PO1);
  await real.page.waitForFunction(() => !document.getElementById("admin-auth").hidden);
  assert.deepEqual(await packingCalls(real.page), []);
  await real.page.close();
}

async function narrow(browser, width) {
  const { page, errors } = await open(browser, width);
  await page.locator("#uid-tab-auto").click();
  assert.equal(await page.locator("#uid-po-box").isVisible(), width > 800, width > 800 ? "máy tính bảng còn ô PO" : "điện thoại không có Extension nên ẩn ô PO");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không tràn ngang`);
  assert.deepEqual(errors, []);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await desktop(browser);
    await gate(browser);
    for (const width of [820, 375]) await narrow(browser, width);
    console.log("group_uid_po_browser: đạt (Packing List → SKU Normal + số UID, Admin, 1280 / 820 / 375)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
