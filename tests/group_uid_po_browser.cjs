// IN TEM GROUP UID → tab "Gán WMS": nhập mã PO, đọc Packing List WMS qua Extension, đổi Combo sang SKU Normal, hiện danh sách SKU + số UID (số cuộn),
// tick SKU cần gán rồi Gán Group UID; thiếu UID chờ gán thì báo lỗi. Lot/Roll không cần: tem in trước khi nhận hàng, WMS gán Lot/Roll lúc nhận.
// Tab "Gán tự động" (luồng cũ) phải còn nguyên. Chạy với python -m http.server 8000; Extension và Supabase giả lập.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";

// --- Packing List giả (mỗi dòng một cuộn) ---
const pl = (po, sku, i, extra = {}) => ({ purchase_order: po, shipment: "1001260803118522", sku, product_name: `(Combo) Vải ${sku}/kg`, quantity: 18 + (i % 5) / 10, code: `1148/8-${String(i + 1).padStart(3, "0")}`, batch_code: "1148/8", status: "Approved", delivery: "PARTIAL", group_uid: null, ...extra });
const PO1 = "10012608011632", PO2 = "10012606143838", PO_BIG = "10012600000500", PO_NONE = "10012699999999";
const PO_PART = "10012600000601", PO_DONE = "10012600000602", PO_OLD = "10012600000603";
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
  // Cuộn đã tạo Group UID trên WMS (cột Group UID của Packing List PO) thì không gán tem nữa
  [PO_PART]: Array.from({ length: 5 }, (_, i) => pl(PO_PART, "900000455", i, { group_uid: i < 2 ? String(1028260000000751 + i) : null })),
  [PO_DONE]: Array.from({ length: 3 }, (_, i) => pl(PO_DONE, "900000455", i, { group_uid: String(1028260000000760 + i) })),
  // Extension cũ (≤ 0.10.2) không trả khoá group_uid
  [PO_OLD]: Array.from({ length: 4 }, (_, i) => { const r = pl(PO_OLD, "900000455", i); delete r.group_uid; return r; }),
};
const COMBOS = { "422513455": [{ normal_sku: "422513459", product_name: "Vải Single Normal 422513459", category_name: "Vải", quantity: 1000, available: true }],
  "422494699": [{ normal_sku: "422494704", product_name: "Vải Jersey Normal 422494704", category_name: "Vải", quantity: 1000, available: true }],
  "422427353": ["422500001", "422500002", "422500003"].map(n => ({ normal_sku: n, product_name: `Normal ${n}`, category_name: "Vải", quantity: 1, available: true })) };
COMBOS["900000455"] = [{ normal_sku: "900000459", product_name: "Vải giả Normal 900000459", category_name: "Vải", quantity: 1000, available: true }]; // dữ liệu giả cho các PO Group UID

const fakeExtension = packing => {
  window.__extCalls = []; window.__fail = false; window.__packing = packing;
  addEventListener("message", async event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return reply(true, { version: "0.8.4" });
    if (window.__hold && request.type === "GET_PACKING_LIST_PAGE") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
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
const poRows = page => page.evaluate(() => [...document.querySelectorAll("#uid-po-rows .uid-auto__row")].map(r => ({ sku: r.querySelector('[data-field="sku"]').value, qty: Number(r.querySelector('[data-field="qty"]').value), name: r.querySelector('[data-field="name"]').value })));
const poHelp = page => page.locator("#uid-po-help").innerText();
const run = async (page, text) => { await page.locator("#uid-po-input").fill(text); await page.locator("#uid-po-go").click(); await page.waitForFunction(() => document.getElementById("uid-po-go").dataset.busy !== "true"); };

// Nút đọc nguồn một kiểu .src-read (17/10/2026, khối #hero-standard): lớp, nhãn, title, icon mask ở ::before (không còn svg trong nút), cùng màu / cỡ / bo với nút đọc ở các màn khác.
// spec: id, text ("" = nút chỉ icon), title?, aria?, icon? (src-read--icon), size? (cao/rộng cố định), mate? (id nút/ô cùng hàng phải cao bằng). Trả danh sách điểm lệch (rỗng = đạt).
const srcReadAudit = (page, specs, width) => page.evaluate(async ({ specs, width }) => {
  const mobile = width <= 800, ctl = mobile ? 48 : 52, bad = [];
  for (const spec of specs) {
    const b = document.getElementById(spec.id);
    if (!b) { bad.push(`#${spec.id} không có`); continue; }
    await Promise.all(b.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
    const s = getComputedStyle(b), before = getComputedStyle(b, "::before"), mask = before.maskImage || before.webkitMaskImage, text = b.innerText.trim(), h = parseFloat(s.height), w = parseFloat(s.width), want = spec.size || ctl;
    for (const cls of ["src-read", ...(spec.icon ? ["src-read--icon"] : [])]) if (!b.classList.contains(cls)) bad.push(`#${spec.id} thiếu lớp ${cls}`);
    if (text !== spec.text) bad.push(`#${spec.id} chữ "${text}", cần "${spec.text}"`);
    if (spec.title !== undefined && b.title !== spec.title) bad.push(`#${spec.id} title "${b.title}", cần "${spec.title}"`);
    if (spec.aria && b.getAttribute("aria-label") !== spec.aria) bad.push(`#${spec.id} aria-label "${b.getAttribute("aria-label")}", cần "${spec.aria}"`);
    if (!mask || mask === "none" || before.content === "none") bad.push(`#${spec.id}::before không có icon mask`);
    if (b.querySelector("svg")) bad.push(`#${spec.id} còn svg trong nút (icon phải là mask ::before)`);
    if (Math.abs(h - want) > 1) bad.push(`#${spec.id} cao ${h}px, cần ${want}px`);
    if (spec.icon && Math.abs(w - want) > 1) bad.push(`#${spec.id} rộng ${w}px, nút chỉ icon cần vuông ${want}px`);
    if (spec.mate) { const m = document.getElementById(spec.mate); if (!m || Math.abs(m.getBoundingClientRect().height - h) > 1) bad.push(`#${spec.id} cao ${h}px, #${spec.mate} cao ${m && m.getBoundingClientRect().height}px (cùng hàng phải bằng nhau)`); }
    if (s.fontSize !== "16px" || s.fontWeight !== "600") bad.push(`#${spec.id} chữ ${s.fontSize}/${s.fontWeight}, cần 16px/600`);
    if (s.color !== "rgb(0, 95, 65)") bad.push(`#${spec.id} màu chữ ${s.color}, cần #005F41`);
    if (s.backgroundColor !== "rgb(230, 243, 238)") bad.push(`#${spec.id} nền ${s.backgroundColor}`);
    if (s.borderTopColor !== "rgb(95, 174, 146)") bad.push(`#${spec.id} viền ${s.borderTopColor}`);
    const r = Math.min(parseFloat(s.borderTopLeftRadius), h / 2);
    if (mobile ? Math.abs(r - 12) > 1 : r < h / 2 - 1) bad.push(`#${spec.id} bo ${s.borderTopLeftRadius}`);
  }
  return bad;
}, { specs, width });
const addUids = (page, codes) => page.evaluate(list => window.PrintSkuUid.add(list.map(code => ({ group_uid_code: code, batch_code: null, roll_code: null }))), codes);
const pendingIs = (page, n) => page.waitForFunction(count => document.getElementById("uid-pending-count").textContent === count, String(n));

async function desktop(browser) {
  const { page, errors } = await open(browser, 1280);
  assert.equal(await page.locator("#uid-tab-po").innerText(), "Gán WMS");
  assert.equal(await page.locator("#uid-tab-po").isVisible(), true, "tab Gán WMS hiện trên máy tính");
  await page.locator("#uid-tab-po").click();
  assert.equal(await page.locator("#uid-map-po").isVisible(), true);
  assert.equal(await page.locator("#uid-map-auto").isVisible(), false); assert.equal(await page.locator("#uid-map-manual").isVisible(), false);
  assert.equal(await page.locator("#uid-tab-po").getAttribute("aria-selected"), "true"); assert.equal(await page.locator("#uid-tab-auto").getAttribute("aria-selected"), "false");
  const [inputBox, buttonBox] = await Promise.all([page.locator("#uid-po-input").boundingBox(), page.locator("#uid-po-go").boundingBox()]);
  assert.equal(Math.round(inputBox.y), Math.round(buttonBox.y), "ô PO và nút cùng một hàng");
  assert.ok(inputBox.height >= 44 && buttonBox.height >= 44);
  // Khuôn nút đọc một kiểu (17/10/2026): "Đọc WMS" + icon mask (không còn svg), cao bằng ô Mã PO cùng hàng
  assert.deepEqual(await srcReadAudit(page, [{ id: "uid-po-go", text: "Đọc WMS", title: "Đọc Packing List từ WMS", mate: "uid-po-input" }], 1280), [], "nút Đọc WMS một kiểu");
  assert.equal(await page.locator("#uid-po-input").getAttribute("placeholder"), "Mã PO");
  assert.equal(await page.locator("#uid-po-apply").isDisabled(), true, "chưa có dòng SKU thì chưa gán được");
  const tabs = await page.locator("#uid-tab-manual, #uid-tab-auto, #uid-tab-po").evaluateAll(list => list.map(e => ({ w: Math.round(e.getBoundingClientRect().width), scroll: e.scrollWidth > e.clientWidth })));
  assert.ok(tabs.every(t => !t.scroll), "ba tab không vỡ chữ");

  // Mã PO sai: không gọi WMS
  await run(page, "abc");
  assert.match(await poHelp(page), /Chưa có mã PO hợp lệ/);
  assert.deepEqual(await packingCalls(page), []);

  // PO có Packing List: đổi Combo → Normal, mỗi dòng là một cuộn. Giữ phản hồi Extension để chặn pha "đang đọc": data-busy, "Đang đọc…", khoá nút, icon xoay; đọc xong trả "Đọc WMS"
  const idleMask = await page.locator("#uid-po-go").evaluate(b => getComputedStyle(b, "::before").maskImage);
  await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
  await page.locator("#uid-po-input").fill(PO1); await page.locator("#uid-po-go").click();
  await page.waitForFunction(() => document.getElementById("uid-po-go").dataset.busy === "true");
  assert.equal((await page.locator("#uid-po-go").innerText()).trim(), "Đang đọc…");
  assert.equal(await page.locator("#uid-po-go").isDisabled(), true, "đang đọc: nút khoá");
  assert.equal(await page.locator("#uid-po-go").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
  assert.notEqual(await page.locator("#uid-po-go").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
  await page.evaluate(() => { window.__release(); window.__hold = null; });
  await page.waitForFunction(() => document.getElementById("uid-po-go").dataset.busy !== "true");
  assert.equal((await page.locator("#uid-po-go").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn");
  assert.equal(await page.locator("#uid-po-go").isDisabled(), false);
  assert.deepEqual(await packingCalls(page), [{ purchaseOrders: [PO1], page: 1, size: 500 }]);
  assert.deepEqual(await poRows(page), [
    { sku: "422513459", qty: 53, name: "Vải Single Normal 422513459" },
    { sku: "422494704", qty: 2, name: "Vải Jersey Normal 422494704" },
    { sku: "422280728", qty: 4, name: "Vải warp knit/TIVNHH/300gsm/mét" },
  ]);
  let text = await poHelp(page);
  assert.ok(text.startsWith(`PO ${PO1} · 59 UID · 3 SKU Normal`), text);
  assert.ok(!/chưa chia cuộn/.test(text), "dòng số lượng 1 mã 1 vẫn là một cuộn");
  assert.match(text, /Combo nhiều thành phần: 422427353/);
  assert.match(text, /1 dòng chưa Approved/);
  assert.equal(await page.locator("#uid-po-help").getAttribute("data-tone"), "warn");
  assert.equal(await page.locator("#uid-po-total").innerText(), "59/0", "số UID cần so với UID đang chờ gán");
  assert.equal(await page.locator("#uid-po-total").getAttribute("data-over"), "true");
  const ticks = page.locator("#uid-po-rows .uid-auto__pick input");
  assert.deepEqual(await ticks.evaluateAll(list => list.map(e => e.checked)), [true, true, true], "dòng từ Packing List mặc định đã tick");
  assert.deepEqual(await page.locator("#uid-po-rows input[readonly]").evaluateAll(list => list.map(e => e.dataset.field)), ["sku", "name", "sku", "name", "sku", "name"], "SKU và tên chỉ xem");

  // Thiếu UID chờ gán: báo lỗi, không gán gì
  assert.equal(await page.locator("#uid-po-apply").isDisabled(), false, "nút vẫn bấm được để thấy lỗi");
  await page.locator("#uid-po-apply").click();
  await page.waitForFunction(() => /^Thiếu/.test(document.getElementById("uid-po-help").textContent));
  assert.equal(await poHelp(page), "Thiếu 59 UID chờ gán: cần 59, đang chờ 0");
  assert.equal(await page.locator("#uid-po-help").getAttribute("data-tone"), "error");
  assert.equal(await page.locator("#uid-ready-count").textContent(), "0");

  // Chọn UID New: "Sẽ gán" tự cập nhật; bỏ tick dòng 53 cuộn, chỉ gán 2 + 4 = 6 UID
  const codes = Array.from({ length: 59 }, (_, i) => `1028261014${String(i + 1).padStart(6, "0")}`);
  await addUids(page, codes.slice(0, 6)); await pendingIs(page, 6);
  assert.equal(await page.locator("#uid-po-total").innerText(), "59/6", "thêm UID chờ gán thì tổng tự cập nhật");
  await ticks.nth(0).uncheck();
  assert.equal(await page.locator("#uid-po-total").innerText(), "6/6", "tổng chỉ tính dòng đã tick");
  assert.equal(await page.locator("#uid-po-total").getAttribute("data-over"), "false");
  await page.locator("#uid-po-apply").click();
  await page.waitForFunction(() => document.getElementById("uid-ready-count").textContent === "6");
  assert.equal(await page.locator("#uid-pending-count").textContent(), "0");
  const ready = await page.locator("#uid-ready").innerText();
  assert.ok(ready.includes("422494704") && ready.includes("Vải Jersey Normal 422494704") && ready.includes("422280728"), "tem mang SKU Normal và tên Normal");
  assert.ok(!ready.includes("422513459"), "dòng chưa tick không được gán");
  assert.ok(!/Lot:|Roll:/.test(ready), "không có Lot/Roll: WMS gán lúc nhận hàng");
  assert.equal(await poHelp(page), "Đã gán 6 UID theo 2 dòng SKU");
  assert.match(await page.locator("#uid-status").innerText(), /Đã gán WMS 6 UID theo 2 dòng SKU/);
  assert.deepEqual(await poRows(page), [{ sku: "422513459", qty: 53, name: "Vải Single Normal 422513459" }], "dòng đã gán bị bỏ, dòng chưa tick giữ lại để gán sau");
  assert.equal(await page.locator("#uid-po-total").innerText(), "0/0");

  // Đủ UID rồi tick lại dòng còn lại để gán nốt
  await addUids(page, codes.slice(6)); await pendingIs(page, 53);
  assert.equal(await page.locator("#uid-po-apply").isDisabled(), true, "không tick dòng nào thì chưa gán được");
  await ticks.nth(0).check();
  assert.equal(await page.locator("#uid-po-total").innerText(), "53/53");
  await page.locator("#uid-po-apply").click();
  await page.waitForFunction(() => document.getElementById("uid-ready-count").textContent === "59");
  assert.equal(await page.locator("#uid-pending-count").textContent(), "0");
  assert.deepEqual(await poRows(page), [], "gán hết thì danh sách trống");

  // Nhiều PO một lần, gộp theo SKU Normal; Combo tra Supabase đúng một lần mỗi SKU
  comboCalls.length = 0;
  await run(page, `${PO1}, ${PO2}\n${PO1}`);
  assert.deepEqual((await packingCalls(page)).at(-1), { purchaseOrders: [PO1, PO2], page: 1, size: 500 }, "mã trùng chỉ gửi một lần");
  assert.deepEqual((await poRows(page)).map(r => [r.sku, r.qty]), [["422513459", 53], ["422494704", 142], ["422280728", 4]], "Combo của hai PO cùng Normal thì cộng lại");
  assert.match(await poHelp(page), /^2 PO · 199 UID · 3 SKU Normal/);
  assert.equal(new Set(comboCalls).size, comboCalls.length, "mỗi SKU tra Combo một lần");

  // Chỉnh số UID: nút +/−, gõ số; số 0 thì chưa gán được
  const first = page.locator("#uid-po-rows .uid-auto__row").nth(2);
  await first.locator('[data-action="inc"]').click();
  assert.equal(await first.locator('[data-field="qty"]').inputValue(), "5");
  assert.equal(await page.locator("#uid-po-total").innerText(), "200/0");
  await first.locator('[data-field="qty"]').fill("0");
  assert.equal(await page.locator("#uid-po-apply").isDisabled(), true, "số UID 0 không hợp lệ");
  await first.locator('[data-field="qty"]').fill("4");
  assert.equal(await page.locator("#uid-po-apply").isDisabled(), false);
  assert.equal(await page.locator("#uid-po-total").innerText(), "199/0");

  // Xóa SKU khỏi danh sách: xóa được từng dòng, kể cả dòng cuối; số tổng cập nhật; đọc lại PO thì có lại
  const removeButtons = page.locator('#uid-po-rows [data-action="remove-row"]');
  assert.equal(await removeButtons.count(), 3, "mỗi dòng SKU có nút xóa");
  assert.equal(await removeButtons.first().isDisabled(), false);
  assert.equal(await removeButtons.first().getAttribute("aria-label"), "Xóa SKU 422513459");
  const removeBox = await removeButtons.first().boundingBox();
  assert.ok(removeBox.width >= 40 && removeBox.height >= 40, "nút xóa đủ lớn để bấm");
  await removeButtons.first().click();
  assert.deepEqual((await poRows(page)).map(r => [r.sku, r.qty]), [["422494704", 142], ["422280728", 4]]);
  assert.equal(await page.locator("#uid-po-total").innerText(), "146/0", "xóa SKU thì tổng cập nhật");
  await removeButtons.nth(1).click();
  assert.deepEqual((await poRows(page)).map(r => r.sku), ["422494704"]);
  await removeButtons.first().click();
  assert.deepEqual(await poRows(page), [], "xóa hết được, kể cả dòng cuối");
  assert.equal(await page.locator("#uid-po-apply").isDisabled(), true);
  assert.equal(await page.locator("#uid-po-total").innerText(), "0/0");
  await run(page, `${PO1}, ${PO2}`);
  assert.equal((await poRows(page)).length, 3, "đọc lại PO thì danh sách có lại");
  const third = page.locator("#uid-po-rows .uid-auto__row").nth(2);
  await third.locator('[data-field="qty"]').fill("4");

  // Quá 500 cuộn: giới hạn 500 và báo; Packing List chia 2 trang
  await run(page, PO_BIG);
  assert.deepEqual((await packingCalls(page)).slice(-2).map(c => c.page), [1, 2], "520 dòng = 2 trang");
  assert.deepEqual((await poRows(page)).map(r => [r.sku, r.qty]), [["422513459", 500]]);
  assert.match(await poHelp(page), /1 SKU quá 500 UID, đã giới hạn/);

  // PO chưa có Packing List: báo, giữ nguyên danh sách đang có
  await run(page, PO_NONE);
  assert.match(await poHelp(page), new RegExp(`Chưa có Packing List: ${PO_NONE}`));
  assert.deepEqual((await poRows(page)).map(r => r.sku), ["422513459"], "không có dòng nào thì giữ nguyên");

  // Chỉ lấy cuộn chưa có Group UID: 5 cuộn, 2 cuộn đã có UID → gán 3; báo số cuộn bỏ qua (không phải cảnh báo)
  await run(page, PO_PART);
  assert.deepEqual((await poRows(page)).map(r => [r.sku, r.qty]), [["900000459", 3]], "bỏ cuộn đã có Group UID");
  assert.equal(await poHelp(page), `PO ${PO_PART} · 3 UID · 1 SKU Normal · 2 cuộn đã có Group UID`);
  assert.equal(await page.locator("#uid-po-help").getAttribute("data-tone"), "ok");
  // Mọi cuộn đã có Group UID: không có dòng để gán, giữ danh sách đang có
  await run(page, PO_DONE);
  assert.equal(await poHelp(page), `PO ${PO_DONE}: cả 3 cuộn đã có Group UID`);
  assert.deepEqual((await poRows(page)).map(r => [r.sku, r.qty]), [["900000459", 3]], "không có dòng mới thì giữ nguyên");
  // Extension cũ: vẫn đếm mọi cuộn như trước nhưng báo cần cập nhật
  await run(page, PO_OLD);
  assert.deepEqual((await poRows(page)).map(r => [r.sku, r.qty]), [["900000459", 4]]);
  assert.match(await poHelp(page), /Extension chưa lọc cuộn đã có Group UID, cập nhật 0\.10\.3/);
  assert.equal(await page.locator("#uid-po-help").getAttribute("data-tone"), "warn");

  // Lỗi Extension
  await page.evaluate(() => { window.__fail = true; });
  await run(page, PO1);
  assert.match(await poHelp(page), /Không đọc được Packing List: Phiên WMS không còn quyền/);
  assert.equal(await page.locator("#uid-po-go").isDisabled(), false, "lỗi xong nút dùng lại được");

  // Enter trong ô PO cũng đọc
  await page.evaluate(() => { window.__fail = false; });
  const before = (await packingCalls(page)).length;
  await page.locator("#uid-po-input").fill(PO2); await page.locator("#uid-po-input").press("Enter");
  await page.waitForFunction(n => window.__extCalls.filter(c => c.type === "GET_PACKING_LIST_PAGE").length > n, before);

  assert.deepEqual(errors, []);
  await page.close();
}

// Gán tự động (luồng cũ) còn nguyên: không ô PO, không ô tick, nút khoá khi vượt UID chờ gán, gán xong về một dòng trống
async function legacyAuto(browser) {
  const { page, errors } = await open(browser, 1280);
  await page.locator("#uid-tab-auto").click();
  assert.equal(await page.locator("#uid-map-auto").isVisible(), true); assert.equal(await page.locator("#uid-map-po").isVisible(), false);
  assert.equal(await page.locator("#uid-map-auto .uid-po, #uid-map-auto #uid-po-input, #uid-map-auto .uid-auto__pick").count(), 0, "tab Gán tự động không có ô PO hay ô tick");
  assert.equal(await page.locator("#uid-auto-rows .uid-auto__row").count(), 1);
  assert.equal(await page.locator("#uid-auto-apply").innerText(), "Gán tự động");
  await addUids(page, ["1028261014000001", "1028261014000002"]); await pendingIs(page, 2);
  await page.locator('#uid-auto-rows [data-field="sku"]').fill("422513459");
  await page.waitForFunction(() => document.querySelector('#uid-auto-rows [data-field="name"]').value === "Tên SKU tra từ Supabase");
  assert.equal(await page.locator("#uid-auto-total").innerText(), "1/2");
  await page.locator('#uid-auto-rows [data-field="qty"]').fill("3");
  assert.equal(await page.locator("#uid-auto-total").innerText(), "3/2");
  assert.equal(await page.locator("#uid-auto-apply").isDisabled(), true, "vượt UID chờ gán thì khoá nút như cũ");
  await page.locator('#uid-auto-rows [data-field="qty"]').fill("2");
  assert.equal(await page.locator("#uid-auto-apply").isDisabled(), false);
  await page.locator("#uid-auto-apply").click();
  await page.waitForFunction(() => document.getElementById("uid-ready-count").textContent === "2");
  assert.equal(await page.locator("#uid-pending-count").textContent(), "0");
  assert.match(await page.locator("#uid-status").innerText(), /Đã gán tự động 2 UID theo 1 dòng SKU/);
  assert.deepEqual(await page.locator("#uid-auto-rows .uid-auto__row").evaluateAll(list => list.map(r => [r.querySelector('[data-field="sku"]').value, r.querySelector('[data-field="qty"]').value])), [["", "1"]], "gán xong về một dòng trống");
  // Qua lại giữa ba tab
  await page.locator("#uid-tab-manual").click();
  assert.equal(await page.locator("#uid-map-manual").isVisible(), true); assert.equal(await page.locator("#uid-map-auto").isVisible(), false); assert.equal(await page.locator("#uid-map-po").isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
}

// Đọc từ WMS chỉ cho Admin
async function gate(browser) {
  const { page, errors } = await open(browser, 1280);
  await page.evaluate(() => { window.__admin = false; });
  await page.locator("#uid-tab-po").click();
  await run(page, PO1);
  assert.match(await poHelp(page), /Chưa đăng nhập Admin/);
  assert.equal(await page.evaluate(() => window.__getTokenCalls), 1, "mở hộp đăng nhập Admin dùng chung");
  assert.deepEqual(await packingCalls(page), [], "chưa Admin thì không gọi WMS");
  assert.deepEqual(errors, []);
  await page.close();
  const real = await open(browser, 1280, { stub: false });
  await real.page.locator("#uid-tab-po").click();
  await run(real.page, PO1);
  await real.page.waitForFunction(() => !document.getElementById("admin-auth").hidden);
  assert.deepEqual(await packingCalls(real.page), []);
  await real.page.close();
}

async function narrow(browser, width) {
  const { page, errors } = await open(browser, width);
  assert.equal(await page.locator("#uid-tab-po").isVisible(), width > 800, width > 800 ? "máy tính bảng còn tab Gán WMS" : "điện thoại không có Extension nên ẩn tab Gán WMS");
  const tabs = await page.locator("#uid-tab-manual, #uid-tab-auto").evaluateAll(list => list.map(e => e.scrollWidth > e.clientWidth));
  assert.deepEqual(tabs, [false, false], "hai tab cũ không vỡ chữ");
  if (width > 800) {
    await page.locator("#uid-tab-po").click(); assert.equal(await page.locator("#uid-map-po").isVisible(), true);
    assert.deepEqual(await srcReadAudit(page, [{ id: "uid-po-go", text: "Đọc WMS", title: "Đọc Packing List từ WMS", mate: "uid-po-input" }], width), [], `${width}px: nút Đọc WMS một kiểu`);
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không tràn ngang`);
  assert.deepEqual(errors, []);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await desktop(browser);
    await legacyAuto(browser);
    await gate(browser);
    for (const width of [820, 375]) await narrow(browser, width);
    console.log("group_uid_po_browser: đạt (Gán WMS: Packing List → SKU Normal + số UID, tick, thiếu UID, Admin; Gán tự động cũ còn nguyên; 1280 / 820 / 375)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
