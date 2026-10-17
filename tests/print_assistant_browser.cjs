// TRỢ LÝ IN (ô trang chủ, #assistant): câu nói → số phiếu IT + số bản → thẻ xác nhận → người bấm In. Chỉ Admin; máy in = khoá máy đã kích hoạt.
// Bộ phân tích tất định chạy trước (đủ số phiếu thì không gọi Edge); Edge print-assistant, HasakiSkuIt (đọc/in phiếu IT), Admin, Supabase đều giả lập.
// Chạy với python -m http.server 8000 (đổi bằng BASE, ví dụ http://127.0.0.1:8001/).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SHOTS = process.env.SHOTS || "";

const IT = "100000001", IT_404 = "100000404", IT_EXT = "100000500", EMAIL = "admin-test@example.com", DEVICE = "tb-khoa-test";
const SLIP = { number: IT, id: 1, status: "In-progress", type: "Normal", fromWarehouse: "WH - MATERIAL - MTG", toWarehouse: "SF - TEST Q12", createdBy: "nguoi.tao@example.com", createdAt: "2026-10-17T09:00:00.000Z", totalItems: 3 };
const ROWS = [
  { sku: "900000001", name: "Nhãn giả một", quantity: 2, unit: "pcs", known: true, flag: null, copies: 1 },
  { sku: "900000002", name: "Chỉ giả hai", quantity: 1500, unit: "mm", known: true, flag: null, copies: 1 },
  { sku: "900000003", name: "Hàng ngừng giả", quantity: 5, unit: "pcs", known: false, flag: "Không có trong danh mục", copies: 1 },
];

// Cổng phiếu IT giả (cài sau khi trang tải để không bị khối thật ghi đè)
const fakeGate = ({ slip, rows, it404, itExt }) => {
  window.__calls = { read: [], enqueue: [], build: [] };
  window.HasakiSkuIt = {
    MAX_COPIES: 200, MAX_SKU_PER_JOB: 30,
    readSlip: async number => {
      window.__calls.read.push(number);
      if (number === it404) throw new Error(`Không tìm thấy phiếu IT ${number}`);
      if (number === itExt) throw new Error("Extension phản hồi quá lâu; kiểm tra tab WMS rồi thử lại");
      return { slip: { ...slip, number }, rows: rows.map(row => ({ ...row })) };
    },
    buildItems: list => { window.__calls.build.push(list.map(row => ({ sku: row.sku, copies: row.copies }))); return list.filter(row => row.known && row.copies >= 1).map(row => ({ sku: row.sku, productName: row.name, quantity: String(row.quantity), printedDate: "2026-10-17", copies: row.copies })); },
    enqueue: async (items, options) => { window.__calls.enqueue.push({ items, options }); if (window.__enqueueFail) throw Object.assign(new Error(window.__enqueueFail.message), { jobIds: window.__enqueueFail.jobIds, labels: window.__enqueueFail.labels }); return { jobIds: ["job0001a-aaaa-4000-8000-000000000001"], labels: items.reduce((sum, item) => sum + item.copies, 0) }; },
  };
};
const fakeSpeech = () => {
  window.SpeechRecognition = class { start() { this.started = true; setTimeout(() => { this.onresult?.({ results: [[{ transcript: "IT 100000001 3 bản" }]] }); this.onend?.(); }, 30); } stop() { this.onend?.(); } };
  window.__lang = () => "";
};

async function open(browser, width, { admin = true, speech = true, edge = { mode: "ok" } } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [], edgeCalls = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  await page.route("**/*", route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.includes("/functions/v1/print-assistant")) {
      const body = JSON.parse(route.request().postData() || "{}");
      edgeCalls.push({ body, headers: route.request().headers() });
      if (edge.mode === "503") return json({ ok: false, error: { code: "NO_AI_KEY", message: "Thiếu khoá AI" } }, 503);
      if (/phiếu nhập kho/.test(body.message)) return json({ ok: true, data: { intent: "print_it", itNumber: null, copies: null, reply: "Cho tôi số phiếu IT.", needs: ["it_number"] }, meta: { model: "claude-opus-5-5", inputTokens: 1, outputTokens: 1 } });
      return json({ ok: true, data: { intent: "other", itNumber: null, copies: null, reply: "Hiện tôi chỉ in tem theo phiếu IT", needs: [] }, meta: {} });
    }
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: {} });
  });
  if (speech) await page.addInitScript(fakeSpeech); else await page.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  await page.goto(BASE + "#home");
  await page.locator("#home-assistant").waitFor({ state: "attached" });
  await page.evaluate(({ admin, email, gate }) => {
    window.__admin = admin; window.__getTokenCalls = 0;
    window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("Phiên Admin đã hết hạn. Hãy đăng nhập lại."); return "t"; }, user: () => ({ email }) };
    window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => window.__admin ? "t" : "", isAuthorized: () => window.__admin, getToken: async () => { window.__getTokenCalls++; return window.__admin ? "t" : ""; } };
    localStorage.removeItem("tb-khoa");
  }, { admin, email: EMAIL });
  await page.evaluate(fakeGate, { slip: SLIP, rows: ROWS, it404: IT_404, itExt: IT_EXT });
  return { page, context, errors, edgeCalls };
}
// Ô TRỢ LÝ IN ẩn ở ≤ 800px (chỉ Admin, như nút Phiếu IT): khi ô ẩn thì mở màn bằng hash như người dùng gõ URL.
const enter = async page => { const tile = page.locator("#home-assistant"); if (await tile.isVisible()) await tile.click(); else await page.evaluate(() => { location.hash = "#assistant"; }); await page.locator("#assistant-screen").waitFor({ state: "visible" }); };
const bubbles = page => page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].map(el => ({ from: el.dataset.from, tone: el.dataset.tone || "", text: el.textContent })));
const lastBot = async page => (await bubbles(page)).filter(b => b.from === "bot").pop();
const send = async (page, text) => { await page.locator("#pa-input").fill(text); await page.locator("#pa-input").press("Enter"); };
const waitCard = page => page.locator("#pa-confirm").waitFor({ state: "visible" });
const rowsOf = page => page.evaluate(() => [...document.querySelectorAll("#pa-confirm .pa-row")].map(row => ({ sku: row.querySelector(".pa-main b").textContent, on: row.querySelector("[data-pa-on]").checked, disabled: row.querySelector("[data-pa-on]").disabled, copies: row.querySelector("[data-pa-n]").value, flag: row.querySelector(".pa-flag")?.textContent || "", qty: row.querySelector(".pa-qty").textContent })));
const calls = page => page.evaluate(() => window.__calls);
const noOverflow = page => page.evaluate(() => {
  const over = [...document.querySelectorAll("#assistant-screen *")].filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && (b.right > innerWidth + 1 || b.left < -1); }).map(el => el.id || el.className);
  return { page: document.documentElement.scrollWidth <= innerWidth, screen: document.getElementById("assistant-screen").scrollWidth <= innerWidth, over: over.slice(0, 5) };
});
const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };

async function desktop(browser) {
  const { page, context, errors, edgeCalls } = await open(browser, 1280);
  // Ô trang chủ nhóm In tem → màn
  const tile = page.locator("#home-assistant");
  assert.equal((await tile.innerText()).trim(), "TRỢ LÝ IN");
  assert.equal(await tile.evaluate(el => el.closest(".barcode-home__group").dataset.tone), "print", "ô nằm trong nhóm In tem");
  assert.equal(await tile.evaluate(el => el.querySelector("svg") !== null && el.querySelector(".barcode-choice__icon").getAttribute("aria-hidden") === "true"), true, "icon Lucide inline");
  await enter(page);
  assert.equal(await page.evaluate(() => location.hash), "#assistant");
  assert.equal(await page.locator("#barcode-home").isHidden(), true, "trang chủ ẩn khi mở trợ lý");
  assert.equal((await page.locator("#pa-title").innerText()).trim(), "TRỢ LÝ IN");
  assert.equal(await page.locator("#pa-input").getAttribute("placeholder"), "IT 123456, 2 bản");
  await page.waitForFunction(() => document.getElementById("pa-chip-admin").dataset.tone === "new");
  assert.equal((await page.locator("#pa-chip-admin").innerText()).trim(), "Admin");
  assert.equal((await page.locator("#pa-chip-wms").innerText()).trim(), "WMS · Chưa kiểm");
  assert.equal((await page.locator("#pa-chip-device").innerText()).trim(), "Máy chưa kích hoạt");
  assert.equal(await page.locator("#pa-chip-device").getAttribute("data-tone"), "bad");
  assert.equal(await page.locator("#pa-login").isHidden(), true, "đã Admin: không có nút đăng nhập");
  assert.equal(await page.locator("#pa-input").isDisabled(), false);
  assert.equal(await page.locator("#pa-mic").isVisible(), true, "có SpeechRecognition: hiện nút mic");

  // "IT 100000001 2 bản": bộ phân tích tất định, KHÔNG gọi Edge
  await send(page, `IT ${IT} 2 bản`);
  await waitCard(page);
  assert.equal(edgeCalls.length, 0, "đủ số phiếu: không gọi Edge");
  assert.deepEqual((await calls(page)).read, [IT]);
  assert.equal((await bubbles(page))[0].text, `IT ${IT} 2 bản`);
  assert.deepEqual((await bubbles(page)).map(b => b.from), ["user", "bot"], "bong bóng người dùng rồi 'Đang đọc'");
  assert.match((await bubbles(page))[1].text, new RegExp(`Đang đọc phiếu IT ${IT}`));
  const head = await page.locator("#pa-confirm .pa-c-head").innerText();
  assert.ok(head.includes(`IT ${IT}`) && head.includes("WH - MATERIAL - MTG") && head.includes("SF - TEST Q12"), head);
  assert.equal(await page.locator("#pa-confirm .pa-route svg").count(), 1, "mũi tên kho đi → kho đến là icon");
  assert.deepEqual(await rowsOf(page), [
    { sku: "900000001", on: true, disabled: false, copies: "2", flag: "", qty: "2 pcs" },
    { sku: "900000002", on: true, disabled: false, copies: "2", flag: "", qty: "1500 mm" },
    { sku: "900000003", on: false, disabled: true, copies: "2", flag: "Không có trong danh mục", qty: "5 pcs" },
  ]);
  assert.equal(await page.locator("#pa-copies").inputValue(), "2");
  assert.equal(await page.locator("#pa-total").innerText(), "4 tem · 2 SKU");
  assert.equal((await page.locator("#pa-chip-wms").innerText()).trim(), "WMS · Đang mở");
  assert.equal(await page.locator("#pa-print").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(0, 95, 65)", "nút In đặc #005F41");

  // Chưa kích hoạt máy: khoá nút In + chữ "Máy chưa kích hoạt"
  assert.equal(await page.locator("#pa-print").isDisabled(), true);
  assert.equal((await page.locator("#pa-device").innerText()).trim(), "Máy chưa kích hoạt");
  assert.equal(await page.locator("#pa-device").getAttribute("data-tone"), "bad");

  // Bộ đếm chung áp cho mọi dòng đang tick; dòng đổi riêng giữ nguyên
  await page.locator("#pa-copies-inc").click();
  assert.equal(await page.locator("#pa-copies").inputValue(), "3");
  assert.equal(await page.locator("#pa-total").innerText(), "6 tem · 2 SKU");
  assert.deepEqual((await rowsOf(page)).map(r => r.copies), ["3", "3", "2"], "dòng không tick giữ nguyên");
  await page.locator('#pa-confirm .pa-row[data-i="0"] [data-pa-n]').fill("5");
  assert.equal(await page.locator("#pa-total").innerText(), "8 tem · 2 SKU");
  assert.equal(await page.locator("#pa-copies").inputValue(), "3", "đổi riêng một dòng không đổi bộ đếm chung");
  await page.locator('#pa-confirm .pa-row[data-i="0"] [data-pa-n]').fill("999");
  await page.locator('#pa-confirm .pa-row[data-i="0"] [data-pa-n]').press("Tab");
  assert.equal(await page.locator('#pa-confirm .pa-row[data-i="0"] [data-pa-n]').inputValue(), "200", "kẹp 200");
  await page.locator('#pa-confirm .pa-row[data-i="0"] [data-pa-n]').fill("5");
  await page.locator('#pa-confirm .pa-row[data-i="1"] [data-pa-on]').uncheck();
  assert.equal(await page.locator("#pa-total").innerText(), "5 tem · 1 SKU");
  await page.locator('#pa-confirm .pa-row[data-i="1"] [data-pa-on]').check();
  assert.equal(await page.locator("#pa-total").innerText(), "8 tem · 2 SKU");
  await page.locator("#pa-copies").fill("1");
  assert.equal(await page.locator("#pa-total").innerText(), "2 tem · 2 SKU", "gõ số bản chung áp lại cho mọi dòng tick");
  await page.locator("#pa-copies").fill("3");
  await page.locator('#pa-confirm .pa-row[data-i="0"] [data-pa-n]').fill("5");
  assert.equal(await page.locator("#pa-total").innerText(), "8 tem · 2 SKU");
  await shot(page, "assistant-1280-confirm.png");

  // Có khoá máy: In → enqueue đúng items + requestedBy, bong bóng "Đã gửi"
  await page.evaluate(key => { localStorage.setItem("tb-khoa", key); dispatchEvent(new Event("focus")); }, DEVICE);
  assert.equal((await page.locator("#pa-device").innerText()).trim(), "Máy in sẵn sàng");
  assert.equal((await page.locator("#pa-chip-device").innerText()).trim(), "Máy in sẵn sàng");
  assert.equal(await page.locator("#pa-print").isDisabled(), false);
  await page.locator("#pa-print").click();
  await page.waitForFunction(() => document.querySelectorAll("#pa-confirm").length === 0);
  const sent = (await calls(page)).enqueue;
  assert.equal(sent.length, 1, "một lần enqueue");
  assert.deepEqual(sent[0].items.map(i => `${i.sku}|${i.copies}|${i.quantity}|${i.productName}`), ["900000001|5|2|Nhãn giả một", "900000002|3|1500|Chỉ giả hai"]);
  assert.equal(sent[0].options.requestedBy, `tro-ly:${EMAIL}`);
  assert.deepEqual((await calls(page)).build[0], [{ sku: "900000001", copies: 5 }, { sku: "900000002", copies: 3 }], "chỉ dòng đang tick vào buildItems");
  const done = await lastBot(page);
  assert.match(done.text, /^Đã gửi 8 tem, 1 lệnh · job0001a$/);
  assert.equal(done.tone, "");
  assert.equal(edgeCalls.length, 0);

  // Câu tự do → Edge (có nhớ lịch sử, ngữ cảnh), reply hiện thành bong bóng; trả lời số phiếu trần → đọc, không gọi Edge lần nữa
  await send(page, "in giúp tem phiếu nhập kho");
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Cho tôi số phiếu IT."));
  assert.equal(edgeCalls.length, 1);
  assert.equal(edgeCalls[0].body.message, "in giúp tem phiếu nhập kho");
  assert.deepEqual(edgeCalls[0].body.context, { hasWms: true, deviceActive: true });
  assert.ok(Array.isArray(edgeCalls[0].body.history) && edgeCalls[0].body.history.length <= 6 && edgeCalls[0].body.history.every(t => ["user", "assistant"].includes(t.role) && t.text.length <= 300));
  assert.equal(edgeCalls[0].headers.authorization, "Bearer t");
  assert.match(edgeCalls[0].headers.apikey, /^sb_publishable_/);
  assert.equal(edgeCalls[0].headers["content-type"], "application/json");
  assert.equal((await page.locator("#pa-confirm").count()), 0, "chưa có số phiếu thì chưa mở thẻ");
  await send(page, IT);
  await waitCard(page);
  assert.equal(edgeCalls.length, 1, "số phiếu trần sau khi trợ lý hỏi: không gọi Edge");
  assert.deepEqual((await calls(page)).read, [IT, IT]);
  assert.equal(await page.locator("#pa-total").innerText(), "2 tem · 2 SKU", "không nói số bản: mặc định 1");
  await page.locator("#pa-cancel").click();
  assert.equal(await page.locator("#pa-confirm").count(), 0);
  assert.equal((await lastBot(page)).text, "Đã huỷ.");
  assert.equal((await calls(page)).enqueue.length, 1, "Huỷ không in");

  // Số bản nhiều cách nói; số phiếu có/không từ khoá
  for (const [text, labels] of [["x3 IT 100000001", "6 tem"], ["phiếu 100000001 mỗi mã 4 tem", "8 tem"], ["IT100000001 7 ban", "14 tem"], ["100000001 phiếu IT 2x", "4 tem"]]) {
    await send(page, text); await waitCard(page);
    assert.equal((await page.locator("#pa-total").innerText()).split(" · ")[0], labels, text);
    await page.locator("#pa-cancel").click();
  }
  assert.equal(edgeCalls.length, 1, "các câu có số phiếu không gọi Edge");
  // Số phiếu phải đứng sát từ khoá: SKU/số lượng trong câu không bị đọc nhầm thành phiếu
  const readsParse = (await calls(page)).read.length;
  await send(page, `in SKU 900000001 theo phiếu IT ${IT}`);
  await waitCard(page);
  assert.deepEqual((await calls(page)).read.slice(readsParse), [IT], "đọc phiếu sát từ khoá, không đọc mã SKU 900000001");
  assert.equal(edgeCalls.length, 1);
  await page.locator("#pa-cancel").click();
  await send(page, "phiếu 100000001 và 100000002");
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Hiện tôi chỉ in tem theo phiếu IT"));
  assert.equal(edgeCalls.length, 2, "hai dãy cùng sát từ khoá: không đoán, gửi Edge");
  assert.equal(edgeCalls[1].body.message, "phiếu 100000001 và 100000002");
  assert.equal((await calls(page)).read.length, readsParse + 1);
  const reads = (await calls(page)).read.length;
  await send(page, "300000001 cho tôi biết");
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Hiện tôi chỉ in tem theo phiếu IT"));
  assert.equal(edgeCalls.length, 3, "dãy số không kèm từ khoá IT/phiếu: hỏi Edge");
  assert.equal((await calls(page)).read.length, reads);

  // Lỗi đọc phiếu: đúng thông điệp; lỗi Extension → chip WMS "Không có tab"
  await send(page, `phiếu ${IT_404}`);
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Không tìm thấy phiếu IT 100000404"));
  assert.equal((await lastBot(page)).tone, "bad");
  assert.equal((await page.locator("#pa-chip-wms").innerText()).trim(), "WMS · Đang mở", "lỗi nghiệp vụ không đổi chip WMS");
  await send(page, `IT ${IT_EXT}`);
  await page.waitForFunction(() => document.getElementById("pa-chip-wms").dataset.tone === "bad");
  assert.equal((await page.locator("#pa-chip-wms").innerText()).trim(), "WMS · Không có tab");
  assert.match((await lastBot(page)).text, /Extension phản hồi quá lâu/);
  assert.equal(await page.locator("#pa-send").isDisabled(), false, "lỗi xong dùng lại được");

  // Cổng chưa sẵn sàng (bản cũ)
  await page.evaluate(() => { window.__gate = window.HasakiSkuIt; window.HasakiSkuIt = undefined; });
  await send(page, `IT ${IT}`);
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Cổng in phiếu IT chưa sẵn sàng; tải lại trang."));
  await page.evaluate(() => { window.HasakiSkuIt = window.__gate; });

  // Mic: một lần nghe, điền ô nhập, không tự gửi
  const before = (await bubbles(page)).length, readsBefore = (await calls(page)).read.length;
  await page.locator("#pa-mic").click();
  await page.waitForFunction(() => document.getElementById("pa-input").value === "IT 100000001 3 bản");
  assert.equal(await page.locator("#pa-mic").getAttribute("aria-pressed"), "false");
  assert.equal((await bubbles(page)).length, before, "mic không tự gửi");
  assert.equal((await calls(page)).read.length, readsBefore);
  await page.locator("#pa-input").press("Enter");
  await waitCard(page);
  assert.equal(await page.locator("#pa-total").innerText(), "6 tem · 2 SKU");
  await page.locator("#pa-cancel").click();

  await context.close();
  assert.deepEqual(errors, []);
}

async function edgeDown(browser) {
  const { page, context, errors, edgeCalls } = await open(browser, 1280, { edge: { mode: "503" } });
  await enter(page);
  await page.waitForFunction(() => document.getElementById("pa-chip-admin").dataset.tone === "new");
  await send(page, "xin chào");
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.dataset.tone === "bad"));
  assert.equal((await lastBot(page)).text, "Trợ lý AI tạm nghỉ; gõ: IT <số phiếu> [N bản]");
  assert.equal(edgeCalls.length, 1);
  // Vẫn gõ được lệnh trực tiếp khi Edge nghỉ
  await send(page, `IT ${IT} 2 bản`);
  await waitCard(page);
  assert.equal(edgeCalls.length, 1);
  await page.locator("#pa-cancel").click();
  // Edge nghỉ + câu có hai số phiếu đều sát từ khoá: không đoán, hỏi lại; trả lời số trần thì đọc phiếu đó
  await send(page, "phiếu 100000001 và 100000002 2 bản");
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Số phiếu IT là số nào?"));
  assert.equal(edgeCalls.length, 2);
  assert.deepEqual((await calls(page)).read, [IT], "chưa đọc phiếu nào thêm");
  await send(page, "100000002");
  await waitCard(page);
  assert.deepEqual((await calls(page)).read, [IT, "100000002"]);
  assert.equal(await page.locator("#pa-total").innerText(), "4 tem · 2 SKU", "số bản 2 giữ từ câu trước");
  await page.locator("#pa-cancel").click();
  // Tối đa 20 lượt trong bộ nhớ
  for (let i = 0; i < 12; i++) { await send(page, `xin chào ${i}`); await page.waitForFunction(() => !document.getElementById("pa-send").disabled && document.querySelector("#pa-thread .pa-msg:last-child")?.dataset.from === "bot"); }
  assert.equal((await bubbles(page)).length, 20, "giữ tối đa 20 bong bóng");
  // Quay lại trang chủ
  await page.locator("#pa-back").dispatchEvent("click"); // máy tính: nút WH-MATERIAL ẩn (thanh trái thay), handler vẫn về #home
  await page.locator("#barcode-home").waitFor({ state: "visible" });
  assert.equal(await page.locator("#assistant-screen").isHidden(), true);
  assert.deepEqual(errors, []);
  await context.close();
}

async function noSpeech(browser) {
  const { page, context, errors } = await open(browser, 1280, { speech: false });
  await enter(page);
  assert.equal(await page.locator("#pa-mic").isHidden(), true, "không có SpeechRecognition: ẩn nút mic");
  assert.deepEqual(errors, []);
  await context.close();
}

// Chưa đăng nhập Admin: màn vẫn mở, chip đỏ, ô nhập khoá, nút đăng nhập; đăng nhập xong mở khoá
async function gate(browser) {
  const { page, context, errors, edgeCalls } = await open(browser, 1280, { admin: false });
  await enter(page);
  await page.waitForFunction(() => document.getElementById("pa-chip-admin").textContent.includes("Chưa đăng nhập"));
  assert.equal(await page.locator("#pa-chip-admin").getAttribute("data-tone"), "bad");
  assert.equal(await page.locator("#pa-input").isDisabled(), true, "ô nhập khoá");
  assert.equal(await page.locator("#pa-send").isDisabled(), true);
  assert.equal(await page.locator("#pa-mic").isDisabled(), true);
  const login = page.locator("#pa-login");
  assert.equal(await login.isVisible(), true);
  assert.equal((await login.innerText()).trim(), "Đăng nhập Admin");
  await login.click();
  await page.waitForFunction(() => window.__getTokenCalls === 1);
  assert.equal(await page.locator("#pa-input").isDisabled(), true, "chưa đăng nhập được thì vẫn khoá");
  await page.evaluate(() => { window.__admin = true; dispatchEvent(new Event("print-sku-admin-ready")); });
  await page.waitForFunction(() => !document.getElementById("pa-input").disabled);
  assert.equal(await login.isHidden(), true);
  assert.equal((await page.locator("#pa-chip-admin").innerText()).trim(), "Admin");
  // Hết phiên giữa chừng: đăng xuất → khoá lại
  await page.evaluate(() => { window.__admin = false; dispatchEvent(new Event("print-sku-admin-logout")); });
  await page.waitForFunction(() => document.getElementById("pa-input").disabled);
  assert.equal(edgeCalls.length, 0);
  assert.deepEqual(errors, []);
  await context.close();
}

// In: nonce theo thẻ (bấm lại không tạo lệnh trùng), gửi một phần rồi lỗi, phiên Admin hết hạn đúng lúc bấm In
async function printFlows(browser) {
  const { page, context, errors } = await open(browser, 1280);
  await enter(page);
  await page.waitForFunction(() => document.getElementById("pa-chip-admin").dataset.tone === "new");
  await page.evaluate(key => { localStorage.setItem("tb-khoa", key); dispatchEvent(new Event("focus")); }, DEVICE);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const pressPrint = async () => { const n = (await calls(page)).enqueue.length + 1; await page.locator("#pa-print").click(); await page.waitForFunction(n => window.__calls.enqueue.length >= n, n); };

  // Lỗi trước khi có lệnh nào: giữ thẻ, bấm lại cùng nonceBase; đổi số bản thì nonceBase mới
  await send(page, `IT ${IT} 2 bản`); await waitCard(page);
  await page.evaluate(() => { window.__enqueueFail = { message: "Mất kết nối hàng đợi", jobIds: [], labels: 0 }; });
  await pressPrint();
  await page.waitForFunction(() => [...document.querySelectorAll("#pa-thread .pa-msg")].some(el => el.textContent === "Mất kết nối hàng đợi"));
  assert.equal(await page.locator("#pa-confirm").count(), 1, "chưa có lệnh nào được gửi: giữ thẻ để thử lại");
  assert.equal((await lastBot(page)).tone, "bad");
  await pressPrint();
  await page.waitForFunction(() => window.__calls.enqueue.length === 2);
  let sent = (await calls(page)).enqueue;
  assert.match(sent[0].options.nonceBase, UUID);
  assert.equal(sent[1].options.nonceBase, sent[0].options.nonceBase, "bấm In lại cùng thẻ: cùng nonceBase");
  await page.locator("#pa-copies-inc").click();
  await pressPrint();
  await page.waitForFunction(() => window.__calls.enqueue.length === 3);
  sent = (await calls(page)).enqueue;
  assert.notEqual(sent[2].options.nonceBase, sent[0].options.nonceBase, "đổi số bản: lô mới, nonceBase mới");
  assert.match(sent[2].options.nonceBase, UUID);

  // Gửi một phần rồi lỗi: bong bóng nêu số đã gửi + lỗi, ĐÓNG thẻ (không in lại phần đã gửi), gợi ý đọc lại phiếu
  await page.evaluate(() => { window.__enqueueFail = { message: "Khoá máy không hợp lệ", jobIds: ["job0001a-aaaa-4000-8000-000000000001"], labels: 30 }; });
  await pressPrint();
  await page.waitForFunction(() => !document.getElementById("pa-confirm"));
  const partial = await lastBot(page);
  assert.equal(partial.text, `Đã gửi 30 tem, 1 lệnh; lệnh còn lại lỗi: Khoá máy không hợp lệ Đọc lại phiếu IT ${IT} để in phần còn lại.`);
  assert.equal(partial.tone, "bad");
  await page.evaluate(() => { window.__enqueueFail = null; });

  // Phiên Admin hết hạn giữa lúc thẻ mở: không gọi enqueue, chip đỏ, khoá ô nhập + nút In, hiện nút đăng nhập
  await send(page, `IT ${IT}`); await waitCard(page);
  const enqueuesBefore = (await calls(page)).enqueue.length;
  await page.evaluate(() => { window.__admin = false; });
  await page.locator("#pa-print").click();
  await page.waitForFunction(() => document.getElementById("pa-input").disabled);
  assert.equal((await lastBot(page)).text, "Phiên Admin đã hết hạn; đăng nhập lại.");
  assert.equal((await lastBot(page)).tone, "bad");
  assert.equal((await calls(page)).enqueue.length, enqueuesBefore, "hết phiên: không gửi lệnh in");
  assert.equal(await page.locator("#pa-chip-admin").getAttribute("data-tone"), "bad");
  assert.equal((await page.locator("#pa-chip-admin").innerText()).trim(), "Chưa đăng nhập");
  assert.equal(await page.locator("#pa-send").isDisabled(), true);
  assert.equal(await page.locator("#pa-print").isDisabled(), true);
  assert.equal(await page.locator("#pa-login").isVisible(), true);
  assert.deepEqual(errors, []);
  await context.close();
}

async function narrow(browser, width) {
  const { page, context, errors } = await open(browser, width);
  // Trang chủ: ô mới nằm trong khuôn lưới, không làm trang chủ tràn ngang
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px: trang chủ không tràn ngang`);
  assert.equal(await page.locator("#home-assistant").isVisible(), width > 800, `${width}px: ô TRỢ LÝ IN ${width > 800 ? "hiện" : "ẩn (chỉ máy tính)"}`);
  await enter(page);
  await page.waitForFunction(() => document.getElementById("pa-chip-admin").dataset.tone === "new");
  let fit = await noOverflow(page);
  assert.deepEqual(fit, { page: true, screen: true, over: [] }, `${width}px: màn trợ lý tràn ngang (rỗng)`);
  await page.evaluate(key => localStorage.setItem("tb-khoa", key), DEVICE);
  await send(page, `IT ${IT} 2 bản`);
  await waitCard(page);
  await page.locator("#pa-confirm").scrollIntoViewIfNeeded();
  fit = await noOverflow(page);
  assert.deepEqual(fit, { page: true, screen: true, over: [] }, `${width}px: thẻ xác nhận tràn ngang`);
  const box = await page.locator("#pa-confirm").boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `${width}px: thẻ nằm trong màn`);
  for (const id of ["pa-print", "pa-cancel", "pa-copies-inc", "pa-copies-dec"]) { const b = await page.locator(`#${id}`).boundingBox(); assert.ok(b.height >= 44 && b.width >= 44, `${width}px: ${id} đủ lớn để chạm (${b.width}×${b.height})`); }
  const sizes = await page.evaluate(() => [...document.querySelectorAll("#assistant-screen *")].filter(el => { const b = el.getBoundingClientRect(); return b.width && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()); }).map(el => parseFloat(getComputedStyle(el).fontSize)).filter(s => s > 0 && ![12, 13, 14, 16, 18, 22, 28].includes(s)));
  assert.deepEqual(sizes, [], `${width}px: cỡ chữ ngoài thang`);
  await shot(page, `assistant-${width}-confirm.png`);
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await desktop(browser);
    await edgeDown(browser);
    await noSpeech(browser);
    await gate(browser);
    await printFlows(browser);
    for (const width of [820, 375]) await narrow(browser, width);
    console.log("print_assistant_browser: đạt (ô TRỢ LÝ IN, bộ phân tích tất định không gọi Edge, thẻ xác nhận, số bản chung/riêng, khoá máy, In → enqueue, Edge tự do/503, mic, Admin, 20 lượt; 1280 / 820 / 375)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
