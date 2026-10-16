// IN TEM SKU · Phiếu IT: nhập số phiếu IT → Extension đọc phiếu trên WMS → chọn SKU, chỉnh số bản (mặc định 1) → thêm vào danh sách chờ in của React
// (số lượng giữ đúng theo phiếu), In tem gửi lệnh như cũ. Chỉ Admin. Extension và Supabase giả lập; chạy với python -m http.server 8000.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";

const IT = "1007261015013137", IT_BIG = "1007261013010714", IT_NONE = "1007260101000001";
const head = (number, items) => ({ number, id: 8121626, status: "In-progress", type: "Normal", fromWarehouse: "WH - MATERIAL - MTG", toWarehouse: "SF - HIEP THANH Q12", description: "outsource_order 45 IT_OUT", createdBy: "nguoi.tao@example.com", createdAt: "2026-10-15T09:38:39.000Z", totalItems: items.length, items, generatedAt: "2026-10-15T10:00:00.000Z" });
const ITEMS = [
  { sku: "422499599", name: "Nhãn care xé (tên WMS)", quantity: 2, unit: "pcs" },
  { sku: "422292974", name: "Chỉ may astra C8154 (tên WMS)", quantity: 170000, unit: "mm" },
  { sku: "422386182", name: "Vải Rib 1x1 (tên WMS)", quantity: 42, unit: "g" },
  { sku: "422386183", name: "Vải lẻ", quantity: 1.5, unit: null },
  { sku: "422999999", name: "SKU đã ngừng (tên WMS)", quantity: 5, unit: "pcs" },
];
const BIG = Array.from({ length: 35 }, (_, i) => ({ sku: `4225${String(i).padStart(5, "0")}`, name: `Hàng ${i}`, quantity: 100 + i, unit: "mm" }));
const DATA = { [IT]: head(IT, ITEMS), [IT_BIG]: head(IT_BIG, BIG) };
// Danh mục (SKU_Name chỉ trả SKU đang hoạt động): 422999999 không có
const CATALOG = new Map([...ITEMS.slice(0, 4), ...BIG].map(item => [item.sku, `${item.name.replace(" (tên WMS)", "")} · danh mục`]));

const fakeExtension = data => {
  window.__extCalls = []; window.__fail = false;
  addEventListener("message", event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (/^PING/.test(request.type)) return reply(true, { version: "0.9.1" });
    if (request.type === "GET_INTERNAL_TRANSFER") {
      if (window.__fail) return reply(false, null, { code: "INTERNAL_TRANSFER_READ_FAILED", message: "Phiên WMS không còn quyền đọc phiếu IT; hãy đăng nhập lại" });
      const found = data[request.payload.number];
      return found ? reply(true, found) : reply(false, null, { code: "INTERNAL_TRANSFER_READ_FAILED", message: `Không tìm thấy phiếu IT ${request.payload.number}` });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

async function open(browser, width, { stub = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [], enqueued = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc === "sku_combo_lookup") return json([]);
    if (rpc === "print_enqueue") { enqueued.push(JSON.parse(route.request().postData() || "{}")); return json({ ok: true, data: { id: "99999999-0000-4000-8000-000000000001", status: "queued", duplicate: false } }); }
    if (rpc === "print_job_status") return json({ ok: true, data: { id: "99999999-0000-4000-8000-000000000001", status: "completed", copies: 6 } });
    if (rpc === "print_queue_status") return json({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: [] } });
    if (url.includes("/rest/v1/SKU_Name")) {
      const decoded = decodeURIComponent(url), inList = decoded.match(/sku=in\.\((.*)\)/)?.[1], eq = decoded.match(/sku=eq\.([^&]+)/)?.[1];
      const skus = inList ? inList.split(",").map(s => s.replace(/"/g, "")) : eq ? [eq] : [];
      return json(skus.filter(s => CATALOG.has(s)).map(s => ({ sku: s, product_name: CATALOG.get(s) })));
    }
    if (url.includes("/rest/v1/") && !rpc) return json([]);
    return json({ ok: true, data: {} });
  });
  await page.addInitScript(fakeExtension, DATA);
  await page.goto(BASE + "#worker");
  await page.locator("#f-sku").waitFor();
  if (stub) await page.evaluate(() => {
    window.__admin = true; window.__getTokenCalls = 0;
    window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("hết phiên"); return "t"; } };
    window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => window.__admin ? "t" : "", logout: () => { window.__admin = false; dispatchEvent(new Event("print-sku-admin-logout")); },
      getToken: async () => { window.__getTokenCalls++; return window.__admin ? "t" : ""; } };
    dispatchEvent(new Event("print-sku-admin-ready"));
  });
  return { page, context, errors, enqueued };
}
const itCalls = page => page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_INTERNAL_TRANSFER").map(c => c.payload.number));
const status = page => page.locator("#sku-it-status").innerText();
const rows = page => page.evaluate(() => [...document.querySelectorAll("#sku-it-list .skit__item")].map(r => ({ sku: r.querySelector(".skit__main b").textContent, name: r.querySelector(".skit__name").textContent, qty: r.querySelector(".skit__qty").innerText.replace(/\s+/g, " ").trim(), copies: r.querySelector('[data-field="copies"]').value, on: r.querySelector('[data-field="on"]').checked, flag: r.querySelector(".skit__tag")?.textContent || "" })));
const reactCount = page => page.evaluate(() => document.querySelector("#root main ul.divide-y")?.children.length || 0);
const read = async (page, number) => { await page.locator("#sku-it-input").fill(number); await page.locator("#sku-it-load").click(); await page.waitForFunction(() => document.getElementById("sku-it-load").dataset.busy !== "true" && document.getElementById("sku-it-status").textContent); };

async function desktop(browser) {
  const { page, context, errors, enqueued } = await open(browser, 1280);
  const openButton = page.locator("#root main > section p.items-baseline .skit-open");
  await openButton.waitFor();
  assert.equal(await openButton.isVisible(), true, "nút Phiếu IT ở thẻ 1 trên máy tính");
  assert.equal((await openButton.innerText()).trim(), "Phiếu IT");
  assert.ok((await openButton.boundingBox()).height >= 44);
  await openButton.click();
  assert.equal(await page.locator("#sku-it").evaluate(d => d.open), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "sku-it-input");
  assert.equal(await page.locator("#sku-it-input").getAttribute("placeholder"), "Số phiếu IT");
  assert.equal(await page.locator("#sku-it-add").isDisabled(), true);

  // Số phiếu sai: không gọi Extension
  await page.locator("#sku-it-input").fill("IT-12"); await page.locator("#sku-it-load").click();
  assert.match(await status(page), /Số phiếu IT không hợp lệ/);
  assert.deepEqual(await itCalls(page), []);

  // Đọc phiếu: SKU + số lượng giữ đúng theo phiếu, số bản mặc định 1, tên theo danh mục; SKU không có trong danh mục bỏ tick
  await read(page, ` ${IT} `);
  assert.deepEqual(await itCalls(page), [IT]);
  const info = await page.locator("#sku-it-info").innerText();
  assert.ok(info.includes(`IT ${IT}`) && info.includes("WH - MATERIAL - MTG") && info.includes("SF - HIEP THANH Q12") && info.includes("In-progress") && info.includes("5 dòng"), info);
  assert.deepEqual(await rows(page), [
    { sku: "422499599", name: "Nhãn care xé · danh mục", qty: "2 pcs", copies: "1", on: true, flag: "" },
    { sku: "422292974", name: "Chỉ may astra C8154 · danh mục", qty: "170000 mm", copies: "1", on: true, flag: "" },
    { sku: "422386182", name: "Vải Rib 1x1 · danh mục", qty: "42 g", copies: "1", on: true, flag: "" },
    { sku: "422386183", name: "Vải lẻ · danh mục", qty: "1.5", copies: "1", on: true, flag: "" },
    { sku: "422999999", name: "SKU đã ngừng (tên WMS)", qty: "5 pcs", copies: "1", on: false, flag: "Không có trong danh mục" },
  ]);
  assert.match(await status(page), /Đã đọc 5 dòng · 1 SKU không có trong danh mục \(bỏ tick\)/);
  assert.equal(await page.locator("#sku-it-status").getAttribute("data-tone"), "warn");
  assert.equal(await page.locator("#sku-it-sum").innerText(), "4 SKU · 4 bản in");
  assert.equal(await page.locator("#sku-it-room").innerText(), "Danh sách còn chỗ 30 SKU");
  assert.equal(await page.locator("#sku-it-add").innerText(), "Thêm 4 SKU vào danh sách");
  assert.equal(await page.locator("#sku-it-all").evaluate(e => e.indeterminate), true);

  // Chỉnh số bản: nút +, gõ số; số 0 thì chưa thêm được
  const second = page.locator("#sku-it-list .skit__item").nth(1);
  await second.locator('[data-step="1"]').click(); await second.locator('[data-step="1"]').click();
  assert.equal(await second.locator('[data-field="copies"]').inputValue(), "3");
  assert.equal(await page.locator("#sku-it-sum").innerText(), "4 SKU · 6 bản in");
  await second.locator('[data-field="copies"]').fill("0");
  assert.equal(await page.locator("#sku-it-add").isDisabled(), true, "số bản 0 không hợp lệ");
  await second.locator('[data-field="copies"]').fill("3");
  await second.locator('[data-step="-1"]').click(); await second.locator('[data-step="1"]').click();
  assert.equal(await second.locator('[data-field="copies"]').inputValue(), "3");

  // Thêm vào danh sách chờ in của React (cùng dạng nút Thêm vào danh sách), đóng tấm
  await page.locator("#sku-it-add").click();
  assert.equal(await page.locator("#sku-it").evaluate(d => d.open), false);
  await page.waitForFunction(() => document.querySelector("#root main ul.divide-y")?.children.length === 4);
  const queue = await page.evaluate(() => [...document.querySelectorAll("#root main .skq-list > .skq-item")].map(li => `${li.querySelector("b").textContent}|${li.querySelector(".skq-meta").innerText.replace(/\s+/g, " ").trim()}`));
  assert.deepEqual(queue, ["422499599|2 1 bản", "422292974|170000 3 bản", "422386182|42 1 bản", "422386183|1.5 1 bản"], "số lượng in lên tem giữ đúng theo phiếu IT");
  assert.match(await page.locator("#root").innerText(), new RegExp(`Đã thêm 4 SKU từ phiếu IT ${IT}`));

  // In tem như cũ: lệnh in mang đúng SKU, tên danh mục, số lượng theo phiếu và số bản
  await page.locator("#root button.act-icon--print").first().click();
  await page.waitForFunction(() => /Đã gửi|đã gửi|Đã in|Đang in|hàng đợi/i.test(document.getElementById("root").innerText)).catch(() => {});
  await page.waitForTimeout(500);
  assert.equal(enqueued.length, 1, "gửi đúng một lệnh in");
  const sent = JSON.stringify(enqueued[0]);
  assert.ok(sent.includes("422292974") && sent.includes("170000") && sent.includes("Chỉ may astra C8154 · danh mục"), sent.slice(0, 400));
  assert.ok(!sent.includes("422999999"), "SKU bỏ tick không vào lệnh in");

  // Phiếu lớn hơn chỗ còn trống (một lệnh tối đa 30 SKU): báo lỗi, không thêm; bỏ bớt thì thêm được
  await page.waitForFunction(() => (document.querySelector("#root main ul.divide-y")?.children.length || 0) === 0).catch(() => {});
  const before = await reactCount(page);
  await openButton.click();
  await read(page, IT_BIG);
  assert.equal((await rows(page)).length, 35);
  assert.equal(await page.locator("#sku-it-sum").innerText(), "35 SKU · 35 bản in");
  await page.locator("#sku-it-add").click();
  assert.match(await status(page), new RegExp(`Danh sách chỉ còn chỗ ${30 - before} SKU \\(một lệnh in tối đa 30 SKU\\)`));
  assert.equal(await page.locator("#sku-it-status").getAttribute("data-tone"), "error");
  assert.equal(await page.locator("#sku-it").evaluate(d => d.open), true, "lỗi thì giữ tấm mở");
  assert.equal(await reactCount(page), before);
  await page.locator("#sku-it-all").uncheck();
  assert.equal(await page.locator("#sku-it-add").isDisabled(), true);
  for (const i of [0, 1]) await page.locator("#sku-it-list .skit__item").nth(i).locator('[data-field="on"]').check();
  await page.locator("#sku-it-add").click();
  await page.waitForFunction(n => document.querySelector("#root main ul.divide-y")?.children.length === n, before + 2);

  // Mở lại: dòng đã thêm bị bỏ khỏi tấm, dòng chưa thêm còn lại
  await openButton.click();
  assert.equal((await rows(page)).length, 33);
  await page.locator(".uid-sheet__close[data-skit]").click();

  // Không tìm thấy phiếu / lỗi Extension
  await openButton.click();
  await read(page, IT_NONE);
  assert.match(await status(page), new RegExp(`Không tìm thấy phiếu IT ${IT_NONE}`));
  await page.evaluate(() => { window.__fail = true; });
  await read(page, IT);
  assert.match(await status(page), /Phiên WMS không còn quyền đọc phiếu IT/);
  assert.equal(await page.locator("#sku-it-status").getAttribute("data-tone"), "error");
  assert.equal(await page.locator("#sku-it-load").isDisabled(), false, "lỗi xong nút dùng lại được");
  await page.evaluate(() => { window.__fail = false; });
  // Enter trong ô cũng đọc
  const count = (await itCalls(page)).length;
  await page.locator("#sku-it-input").fill(IT); await page.locator("#sku-it-input").press("Enter");
  await page.waitForFunction(n => window.__extCalls.filter(c => c.type === "GET_INTERNAL_TRANSFER").length > n, count);
  await page.keyboard.press("Escape");

  // React vẽ lại thẻ 1 (gõ SKU) thì nút vẫn còn
  await page.locator("#f-sku").fill("SKU-TEST");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#root .skit-open").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
}

// Đọc phiếu IT chỉ cho Admin: khiên Admin ở thanh trên (như các màn khác); chưa đăng nhập thì Phiếu IT không mở, hộp đăng nhập hiện lên, đăng nhập xong tự mở
async function gate(browser) {
  const { page, context, errors } = await open(browser, 1280);
  await page.locator("#root .skit-open").waitFor();
  const shield = page.locator("#root > header #sku-admin");
  assert.equal(await shield.count(), 1, "khiên Admin ở thanh trên IN TEM SKU");
  assert.equal(await shield.evaluate(e => e.classList.contains("uid-topbar__admin") && e.parentElement.tagName === "DIV" && e.previousElementSibling.tagName === "SPAN"), true, "đặt sau ô máy in, cùng lớp với các màn khác");
  assert.equal(await shield.getAttribute("aria-pressed"), "true", "đã là Admin: khiên xanh");
  assert.equal(await shield.getAttribute("aria-label"), "Đang là Admin · bấm để thoát");
  const look = await shield.evaluate(e => ({ back: getComputedStyle(e).backgroundColor, check: getComputedStyle(e.querySelector(".uid-topbar__admin-check")).display, w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height), svg: Math.round(e.querySelector("svg").getBoundingClientRect().width) }));
  assert.equal(look.back, "rgb(0, 95, 65)"); assert.notEqual(look.check, "none"); assert.ok(look.w >= 40 && look.h >= 40); assert.equal(look.svg, 20);
  const box = await shield.boundingBox(), pill = await page.locator("#root > header > div > h1 + span").boundingBox();
  assert.ok(pill.x + pill.width <= box.x + 1, "máy in và khiên không đè nhau");
  // Thoát Admin bằng khiên: hỏi lại, khiên về trắng
  await shield.click();
  const confirm = page.locator("dialog.whd"); await confirm.waitFor({ state: "visible" });
  await confirm.locator(".whd-ok").click(); await confirm.waitFor({ state: "hidden" });
  assert.equal(await shield.getAttribute("aria-pressed"), "false"); assert.equal(await shield.getAttribute("aria-label"), "Đăng nhập Admin");
  // Chưa Admin: Phiếu IT không mở, hộp đăng nhập dùng chung được gọi, không gọi Extension
  await page.locator("#root .skit-open").click();
  await page.waitForFunction(() => window.__getTokenCalls === 1);
  assert.equal(await page.locator("#sku-it").evaluate(d => d.open), false, "chưa Admin: không mở Phiếu IT");
  assert.deepEqual(await itCalls(page), [], "chưa Admin thì không gọi WMS");
  // Đăng nhập xong (khiên xanh lại) thì Phiếu IT tự mở
  await page.evaluate(() => { window.__admin = true; dispatchEvent(new Event("print-sku-admin-ready")); });
  await page.waitForFunction(() => document.getElementById("sku-it").open);
  assert.equal(await shield.getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Escape");
  // Đăng nhập Admin ở nơi khác (không có yêu cầu mở Phiếu IT) không được tự bật Phiếu IT
  await page.evaluate(() => { window.__admin = false; dispatchEvent(new Event("print-sku-admin-logout")); });
  await shield.click();
  await page.waitForFunction(() => window.__getTokenCalls === 2);
  await page.evaluate(() => { window.__admin = true; dispatchEvent(new Event("print-sku-admin-ready")); });
  assert.equal(await page.locator("#sku-it").evaluate(d => d.open), false);
  assert.equal(await shield.getAttribute("aria-pressed"), "true");
  // Hết phiên giữa chừng: đọc phiếu → đóng tấm, hỏi đăng nhập lại, không gọi WMS
  await page.locator("#root .skit-open").click();
  await page.evaluate(() => { window.__admin = false; });
  await page.locator("#sku-it-input").fill(IT); await page.locator("#sku-it-load").click();
  await page.waitForFunction(() => window.__getTokenCalls === 3);
  assert.equal(await page.locator("#sku-it").evaluate(d => d.open), false, "đóng tấm để hộp đăng nhập hiện lên trên");
  assert.deepEqual(await itCalls(page), []);
  // React vẽ lại thanh trên thì khiên vẫn còn đúng một cái
  await page.locator("#f-sku").fill("SKU-TEST");
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#root #sku-admin").count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
  const real = await open(browser, 1280, { stub: false });
  await real.page.locator("#root .skit-open").waitFor();
  assert.equal(await real.page.locator("#sku-admin").getAttribute("aria-pressed"), "false", "chưa đăng nhập: khiên trắng");
  await real.page.locator("#root .skit-open").click();
  await real.page.waitForFunction(() => !document.getElementById("admin-auth").hidden);
  assert.equal(await real.page.locator("#sku-it").evaluate(d => d.open), false);
  assert.deepEqual(await itCalls(real.page), []);
  await real.context.close();
}

async function narrow(browser, width) {
  const { page, context, errors } = await open(browser, width);
  await page.locator("#root .skit-open").waitFor({ state: "attached" });
  assert.equal(await page.locator("#root .skit-open").isVisible(), width > 800, width > 800 ? "máy tính bảng thấy nút Phiếu IT" : "điện thoại không có Extension nên ẩn nút");
  const shieldBox = await page.locator("#root > header #sku-admin").boundingBox();
  assert.ok(shieldBox && shieldBox.width >= 40 && shieldBox.x + shieldBox.width <= width, "khiên Admin hiện ở mọi khổ, nằm trong màn hình");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không tràn ngang`);
  if (width > 800) {
    await page.locator("#root .skit-open").click(); await read(page, IT);
    const fit = await page.evaluate(() => { const d = document.getElementById("sku-it").getBoundingClientRect(); return [...document.querySelectorAll("#sku-it .skit__item > *, #sku-it-add")].filter(e => e.getBoundingClientRect().right > d.right + 1).length; });
    assert.equal(fit, 0, "không phần tử nào tràn khỏi tấm");
  }
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await desktop(browser);
    await gate(browser);
    for (const width of [820, 375]) await narrow(browser, width);
    console.log("sku_it_browser: đạt (Phiếu IT → danh sách chờ in: số lượng theo phiếu, số bản mặc định 1, danh mục, giới hạn 30 SKU, Admin; 1280 / 820 / 375)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
