// IN TEM GROUP UID → "Lấy từ WMS": đọc Group UID trạng thái New của 2 kho MTG / Garment qua Extension,
// lọc kho / ngày tạo / người tạo, chọn rồi thêm vào danh sách in.
// Chạy với python -m http.server 8000; Extension và Supabase đều giả lập, không đụng WMS hay dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/", DAY = 86400000, NOW = Date.now();

// --- Dữ liệu WMS giả: 620 UID New (mỗi giờ một UID, 2 trang) + 2 UID cũ (40 và 90 ngày) ---
const USERS = ["nguoidung1@example.com", "nguoidung2@example.com", "nguoidung3@example.com"];
const uidOf = i => `10282606${String(i).padStart(8, "0")}`;
const mk = (i, at = NOW - i * 3600000) => ({
  group_uid_code: uidOf(i), warehouse_id: i % 3 === 0 ? 1177 : 1339, warehouse: i % 3 === 0 ? "WH - MATERIAL - MTG" : "WH - MATERIAL - GARMENT",
  type: "Roll", created_by: USERS[i % 3], created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString(),
  location: null, batch_code: `LOT-${String(i % 50).padStart(3, "0")}`, roll_code: `R${String(i % 90).padStart(3, "0")}`,
});
const wms = Array.from({ length: 620 }, (_, i) => mk(i));
wms.push(mk(7000, NOW - 40 * DAY), mk(7001, NOW - 90 * DAY));
// Một đợt tạo: 5 UID cùng phút, cùng người tạo (tuanlq5) ở MTG, cách 5 giờ trước
const BATCH_AT = Math.floor((NOW - 5 * 3600000) / 60000) * 60000 + 5000;
for (let k = 0; k < 5; k++) wms.push({ ...mk(8000 + k, BATCH_AT + k * 1000), created_by: USERS[0], warehouse_id: 1177, warehouse: "WH - MATERIAL - MTG" });
const stampVn = ms => { const d = new Date(ms + 7 * 3600000), p = n => String(n).padStart(2, "0"); return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const BATCH_KEY = `${stampVn(BATCH_AT)} · ${USERS[0]}`;
const vnDate = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10), vnStart = day => Date.parse(`${day}T00:00:00+07:00`);
const sinceDays = n => vnStart(vnDate(NOW - (n - 1) * DAY));
const created = r => Date.parse(r.created_at);
const expect = ({ whs = [1177, 1339], from = null, to = null, by = "" } = {}) => wms.filter(r => whs.includes(r.warehouse_id)
  && (from === null || created(r) >= from) && (to === null || created(r) < to) && (!by || r.created_by === by));

const fakeExtension = data => {
  window.__extCalls = []; window.__wms = data; window.__fail = false;
  addEventListener("message", async event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return reply(true, { version: "0.8.3" });
    if (window.__hold && request.type === "GET_GROUP_UID_NEW_PAGE") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
    if (request.type === "GET_GROUP_UID_NEW_PAGE") {
      const { warehouseIds, page, size, from, to } = request.payload;
      if (window.__fail) return reply(false, null, { message: "Phiên WMS không còn quyền đọc Group UID; hãy đăng nhập lại" });
      const rows = window.__wms.filter(r => warehouseIds.includes(r.warehouse_id) && (!from || Date.parse(r.updated_at) >= Date.parse(from)) && (!to || Date.parse(r.updated_at) <= Date.parse(to)))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: rows.slice((page - 1) * size, page * size), sourceRows: rows.length, warehouseIds });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

const lookups = [];
async function open(browser, width, { stub = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/rpc/group_uid_lookup")) {
      const { p_codes } = route.request().postDataJSON(); lookups.push(p_codes);
      // UID kết thúc bằng 5 đã có SKU trong hệ thống: vào thẳng danh sách "sẵn sàng in"
      return json(p_codes.filter(code => code.endsWith("5")).map(code => ({ group_uid_code: code, sku: "000123456", product_name: "Vải thử nghiệm", lot: "LOT-SB", roll: "009" })));
    }
    return json({ ok: true, data: { agents: [], jobs: [] } });
  });
  await page.addInitScript(fakeExtension, wms);
  await page.goto(`${BASE}#group-uid`);
  // Phiên Admin giả (đọc từ WMS chỉ cho Admin): __admin quyết định accessToken thành công hay báo hết phiên; getToken thật sự mở hộp đăng nhập nên chỉ đếm lượt gọi.
  if (stub) await page.evaluate(() => {
    window.__admin = true; window.__getTokenCalls = 0;
    window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("Phiên Admin đã hết hạn. Hãy đăng nhập lại."); return "test-admin-token"; } };
    window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => window.__admin ? "test-admin-token" : "", logout: () => { window.__admin = false; dispatchEvent(new Event("print-sku-admin-logout")); },
      getToken: async () => { window.__getTokenCalls++; return window.__admin ? "test-admin-token" : ""; } };
    dispatchEvent(new Event("print-sku-admin-ready"));
  });
  return { page, errors };
}
const loggedIn = page => page.evaluate(() => { window.__admin = true; dispatchEvent(new Event("print-sku-admin-ready")); });
const isOpen = page => page.locator("#uid-wms").evaluate(d => d.open);
const calls = (page, type) => page.evaluate(t => window.__extCalls.filter(c => c.type === t).map(c => c.payload), type);
const listed = page => page.locator("#uid-wms-list .uid-wms__item").count();
const totalText = page => page.locator("#uid-wms-total").innerText();
const ready = page => page.waitForFunction(() => /Đã đọc|Không|Phiên/.test(document.getElementById("uid-wms-status").textContent) && document.getElementById("uid-wms-load").dataset.busy !== "true");

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

async function desktop(browser) {
  const { page, errors } = await open(browser, 1280);
  assert.equal(await page.locator("#uid-wms-open").isVisible(), true, "nút Lấy từ WMS hiện trên máy tính");
  assert.equal(await page.locator("#uid-import").isVisible(), true, "nút Nhập Excel vẫn còn");
  const [excel, wmsBtn] = await Promise.all([page.locator("#uid-import").boundingBox(), page.locator("#uid-wms-open").boundingBox()]);
  assert.equal(Math.round(excel.y), Math.round(wmsBtn.y), "hai nút cùng một hàng");
  assert.ok(excel.height >= 44 && wmsBtn.height >= 44, "nút đủ cao để bấm");
  // Khuôn nút đọc một kiểu (17/10/2026): "Đọc WMS" + icon mask, cao bằng nút Nhập Excel cùng hàng, hai nút chia đều hàng
  assert.deepEqual(await srcReadAudit(page, [{ id: "uid-wms-open", text: "Đọc WMS", title: "Đọc Group UID New từ WMS", mate: "uid-import" }], 1280), [], "nút Đọc WMS một kiểu");
  assert.ok(Math.abs(excel.width - wmsBtn.width) <= 1, `hai nút chia đều hàng (${excel.width} / ${wmsBtn.width})`);
  // Nhập Excel dùng được không trông như bị khoá: chữ #005F41 như Đọc WMS, viền ≥ 3:1 trên nền nút; chỉ nhạt khi disabled
  const excelLook = () => page.locator("#uid-import").evaluate(async b => {
    await Promise.all(b.getAnimations().map(a => a.finished.catch(() => {})));
    const s = getComputedStyle(b), rgb = v => v.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => c.map(v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, c) => { const [x, y] = [lum(rgb(a)), lum(rgb(c))].sort((p, q) => q - p); return Math.round((x + 0.05) / (y + 0.05) * 100) / 100; };
    return { color: s.color, opacity: s.opacity, border: ratio(s.borderTopColor, s.backgroundColor) };
  });
  const excelIdle = await excelLook();
  assert.equal(excelIdle.color, "rgb(0, 95, 65)", "Nhập Excel dùng được: chữ #005F41 như Đọc WMS");
  assert.equal(excelIdle.opacity, "1", "Nhập Excel dùng được: không mờ");
  assert.ok(excelIdle.border >= 3, `Nhập Excel dùng được: viền đủ tương phản (${excelIdle.border}:1)`);
  await page.locator("#uid-import").evaluate(b => { b.disabled = true; });
  assert.ok(Number((await excelLook()).opacity) < 1, "Nhập Excel khoá: nhạt đi");
  await page.locator("#uid-import").evaluate(b => { b.disabled = false; });

  // Mở hộp: tự đọc, mặc định cả 2 kho và 7 ngày
  await page.locator("#uid-wms-open").click();
  await ready(page);
  assert.equal(await page.locator("#uid-wms").evaluate(d => d.open), true);
  let pages = await calls(page, "GET_GROUP_UID_NEW_PAGE");
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0].warehouseIds, [1177, 1339]);
  assert.equal(pages[0].page, 1); assert.equal(pages[0].size, 500);
  assert.equal(Date.parse(pages[0].from), sinceDays(7));
  const week = expect({ from: sinceDays(7) });
  assert.match(await totalText(page), new RegExp(`Tổng ${week.length.toLocaleString("vi-VN").replace(/\./g, "\\.")} UID New`));
  assert.equal(await listed(page), 60, "danh sách hiện 60 dòng đầu, còn lại bấm Xem thêm");
  assert.equal(await page.locator("#uid-wms-more").isVisible(), true);
  const first = await page.locator("#uid-wms-list .uid-wms__item").first().innerText();
  assert.ok(first.includes(uidOf(0)) && first.includes("MTG") && first.includes(USERS[0]) && first.includes("LOT-000") && first.includes("R000"), "dòng đầu = UID mới nhất, có kho, người tạo, Lot, Roll");
  await page.locator("#uid-wms-more").click();
  assert.equal(await listed(page), 120);

  // Lọc kho: bỏ MTG chỉ còn Garment (lọc ngay trên dữ liệu đã tải, không gọi lại WMS)
  await page.locator('[data-wms-wh="1177"]').click();
  assert.equal(await page.locator('[data-wms-wh="1177"]').getAttribute("aria-pressed"), "false");
  assert.match(await totalText(page), new RegExp(`Tổng ${String(expect({ whs: [1339], from: sinceDays(7) }).length)} UID New`));
  assert.equal((await calls(page, "GET_GROUP_UID_NEW_PAGE")).length, 1, "lọc kho không gọi lại WMS");
  await page.locator('[data-wms-wh="1339"]').click(); // kho cuối cùng không bỏ được
  assert.equal(await page.locator('[data-wms-wh="1339"]').getAttribute("aria-pressed"), "true");
  await page.locator('[data-wms-wh="1177"]').click();

  // Lọc ngày: Hôm nay nằm trong khoảng đã tải nên không gọi lại; 30 ngày và Tất cả phải đọc thêm
  await page.locator('[data-wms-range="1"]').click();
  assert.match(await totalText(page), new RegExp(`Tổng ${expect({ from: sinceDays(1) }).length} UID New`));
  assert.equal((await calls(page, "GET_GROUP_UID_NEW_PAGE")).length, 1);
  await page.locator('[data-wms-range="30"]').click(); await ready(page);
  pages = await calls(page, "GET_GROUP_UID_NEW_PAGE");
  assert.equal(pages.length, 3, "30 ngày = 620 UID nên đọc 2 trang"); assert.equal(Date.parse(pages[1].from), sinceDays(30)); assert.deepEqual(pages.slice(1).map(p => p.page), [1, 2]);
  assert.match(await totalText(page), new RegExp(`Tổng ${expect({ from: sinceDays(30) }).length.toLocaleString("vi-VN").replace(/\./g, "\\.")} UID New`));
  await page.locator('[data-wms-range="all"]').click(); await ready(page);
  pages = await calls(page, "GET_GROUP_UID_NEW_PAGE");
  assert.equal(pages.length, 5, "Tất cả = 622 UID nên đọc 2 trang"); assert.equal(pages[3].from, null);
  assert.deepEqual(pages.slice(3).map(p => p.page), [1, 2]);
  assert.match(await totalText(page), new RegExp(`Tổng ${wms.length} UID New`));
  await page.locator('[data-wms-range="7"]').click();
  assert.equal((await calls(page, "GET_GROUP_UID_NEW_PAGE")).length, 5, "thu hẹp lại khoảng ngày không gọi lại");

  // Ngày tùy chọn
  await page.locator('[data-wms-range="custom"]').click();
  assert.equal(await page.locator("#uid-wms-dates").isVisible(), true);
  const [fromDay, toDay] = [vnDate(NOW - 5 * DAY), vnDate(NOW - 3 * DAY)];
  await page.locator("#uid-wms-from").fill(fromDay); await page.locator("#uid-wms-to").fill(toDay);
  const custom = expect({ from: vnStart(fromDay), to: vnStart(toDay) + DAY });
  assert.match(await totalText(page), new RegExp(`Tổng ${custom.length} UID New`));
  assert.ok(custom.length > 0 && custom.every(r => created(r) >= vnStart(fromDay) && created(r) < vnStart(toDay) + DAY));

  // Người tạo: tuỳ chọn có số lượng, chọn thì lọc
  await page.locator('[data-wms-range="7"]').click();
  const options = await page.locator("#uid-wms-by option").allInnerTexts();
  assert.equal(options.length, 4, "Tất cả + 3 người tạo");
  const mine = USERS[1], byCount = expect({ from: sinceDays(7), by: mine }).length;
  assert.ok(options.some(text => text.startsWith(mine) && text.includes(`(${byCount})`)));
  await page.locator("#uid-wms-by").selectOption(mine);
  assert.match(await totalText(page), new RegExp(`Tổng ${byCount} UID New`));
  assert.ok((await page.locator("#uid-wms-list .uid-wms__meta").allInnerTexts()).every(text => !text.includes("@") || text.includes(mine)));

  // Đợt tạo = cùng phút + cùng người tạo, đúng dòng "dd/mm/yyyy hh:mm · email" dưới mỗi UID; lọc người tạo thu hẹp danh sách đợt
  assert.ok(!(await page.locator("#uid-wms-batch option").allInnerTexts()).some(text => text.startsWith(BATCH_KEY)), "đợt của người khác không hiện khi đã lọc người tạo");
  await page.locator("#uid-wms-by").selectOption("");
  const batchOptions = await page.locator("#uid-wms-batch option").allInnerTexts();
  assert.ok(batchOptions[0].startsWith("Tất cả đợt tạo"));
  assert.ok(batchOptions.includes(`${BATCH_KEY} (5)`), "đợt có đúng 5 UID cùng phút");
  assert.ok(batchOptions.length > 20 && batchOptions.indexOf(`${BATCH_KEY} (5)`) < batchOptions.length / 2, "đợt mới nhất xếp trước");
  await page.locator("#uid-wms-batch").selectOption(BATCH_KEY);
  assert.match(await totalText(page), /Tổng 5 UID New/);
  assert.equal(await listed(page), 5);
  assert.ok((await page.locator("#uid-wms-list .uid-wms__meta").allInnerTexts()).filter(text => text.includes("@")).every(text => text.includes(BATCH_KEY)), "mọi dòng thuộc đúng đợt");
  await page.locator("#uid-wms-all").check();
  assert.equal(await page.locator("#uid-wms-add").innerText(), "Thêm 5 vào danh sách");
  await page.locator("#uid-wms-all").uncheck();
  await page.locator("#uid-wms-by").selectOption(mine);
  assert.equal(await page.locator("#uid-wms-batch").inputValue(), "", "đổi người tạo khác đợt: bỏ chọn đợt");
  await page.locator("#uid-wms-by").selectOption("");
  await page.locator("#uid-wms-batch").selectOption(BATCH_KEY);
  await page.locator('[data-wms-wh="1177"]').click(); // bỏ MTG: đợt MTG không còn nên tự bỏ chọn
  assert.equal(await page.locator("#uid-wms-batch").inputValue(), "");
  await page.locator('[data-wms-wh="1177"]').click();
  await page.locator("#uid-wms-by").selectOption(mine);

  // Chọn tất cả (cả phần chưa hiển thị) rồi thêm vào danh sách in
  const wanted = expect({ from: sinceDays(7), by: mine });
  await page.locator("#uid-wms-all").check();
  assert.equal((await page.locator("#uid-wms-picked").innerText()).replace(/\D/g, ""), String(wanted.length));
  assert.equal(await page.locator("#uid-wms-add").innerText(), `Thêm ${wanted.length} vào danh sách`);
  await page.locator("#uid-wms-list .uid-wms__item input").first().uncheck();
  assert.equal((await page.locator("#uid-wms-picked").innerText()).replace(/\D/g, ""), String(wanted.length - 1));
  assert.equal(await page.locator("#uid-wms-all").evaluate(e => e.indeterminate), true);
  await page.locator("#uid-wms-all").check();
  lookups.length = 0;
  await page.locator("#uid-wms-add").click();
  assert.equal(await page.locator("#uid-wms").evaluate(d => d.open), false, "thêm xong đóng hộp");
  const shown = n => page.waitForFunction(total => Number(document.getElementById("uid-pending-count").textContent) + Number(document.getElementById("uid-ready-count").textContent) === total, n);
  await shown(wanted.length);
  assert.deepEqual(lookups.flat().sort(), wanted.map(r => r.group_uid_code).sort(), "tra Supabase đúng các UID đã chọn");
  const withSku = wanted.filter(r => r.group_uid_code.endsWith("5")).length;
  assert.equal(await page.locator("#uid-ready-count").textContent(), String(withSku));
  assert.equal(await page.locator("#uid-pending-count").textContent(), String(wanted.length - withSku));
  const pendingRows = await page.locator("#uid-pending").innerText();
  const noSku = wanted.find(r => !r.group_uid_code.endsWith("5"));
  assert.ok(pendingRows.includes(noSku.group_uid_code) || (await page.evaluate(() => document.getElementById("uid-pending").textContent)).includes(noSku.batch_code), "UID chưa có SKU vào Chưa gán SKU");
  const lotShown = await page.evaluate(() => document.getElementById("uid-pending").textContent + document.getElementById("uid-ready").textContent);
  assert.ok(lotShown.includes("LOT-SB"), "UID đã có SKU giữ Lot/Roll của hệ thống");
  assert.ok(lotShown.includes(noSku.batch_code), "UID chưa có SKU lấy Lot của WMS làm gợi ý");

  // Mở lại: UID đã thêm hiện "Đã có", khoá ô chọn, Chọn tất cả không chọn lại
  await page.locator("#uid-wms-open").click();
  assert.equal(await page.locator("#uid-wms-list .uid-wms__tag").first().innerText(), "Đã có");
  assert.equal(await page.locator("#uid-wms-list .uid-wms__item[data-have] input").first().isDisabled(), true);
  assert.equal((await page.locator("#uid-wms-picked").innerText()).replace(/\D/g, ""), "0");
  await page.locator("#uid-wms-by").selectOption("");
  await page.locator("#uid-wms-all").check();
  assert.equal((await page.locator("#uid-wms-picked").innerText()).replace(/\D/g, ""), String(week.length - wanted.length), "chỉ chọn UID chưa có");
  await page.locator("#uid-wms-all").uncheck();
  assert.equal(await page.locator("#uid-wms-add").isDisabled(), true);

  // Nút tải lại chỉ icon (cùng kiểu .src-read, vuông 44 trong thanh bộ lọc): giữ icon refresh; đang đọc → data-busy, khoá nút, icon xoay; đọc xong trả lại
  assert.deepEqual(await srcReadAudit(page, [{ id: "uid-wms-load", text: "", aria: "Tải lại từ WMS", icon: true, size: 44 }], 1280), [], "nút tải lại một kiểu");
  assert.equal(await page.locator("#uid-wms-load").getAttribute("title"), "Tải lại từ WMS");
  await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
  await page.locator("#uid-wms-load").click();
  await page.waitForFunction(() => document.getElementById("uid-wms-load").dataset.busy === "true");
  assert.equal(await page.locator("#uid-wms-load").isDisabled(), true, "đang đọc: nút khoá");
  assert.equal(await page.locator("#uid-wms-load").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
  await page.evaluate(() => { window.__release(); window.__hold = null; });
  await ready(page);
  assert.equal(await page.locator("#uid-wms-load").evaluate(b => getComputedStyle(b, "::before").animationName), "none", "đọc xong hết xoay");

  // Lỗi từ Extension: báo lỗi, giữ dữ liệu đã tải
  await page.evaluate(() => { window.__fail = true; });
  await page.locator("#uid-wms-load").click(); await ready(page);
  assert.equal(await page.locator("#uid-wms-status").getAttribute("data-tone"), "error");
  assert.match(await page.locator("#uid-wms-status").innerText(), /đăng nhập lại/);
  assert.ok(await listed(page) > 0, "lỗi không làm mất dữ liệu đã tải");
  await page.evaluate(() => { window.__fail = false; });
  await page.locator("#uid-wms-load").click(); await ready(page);
  assert.equal(await page.locator("#uid-wms-status").getAttribute("data-tone"), null);

  // Bàn phím: Esc đóng hộp
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#uid-wms").evaluate(d => d.open), false);
  assert.deepEqual(errors, []);
  await page.close();
}

async function narrow(browser, width) {
  const { page, errors } = await open(browser, width);
  const phone = width <= 800;
  assert.equal(await page.locator("#uid-wms-open").isVisible(), !phone, phone ? "điện thoại không có Extension nên ẩn nút" : "máy tính bảng thấy nút");
  const excel = await page.locator("#uid-import").boundingBox();
  if (phone) assert.ok(excel.width > width - 80, "nút Nhập Excel chiếm cả hàng khi nút WMS ẩn");
  // Bố cục hộp vẫn phải vừa màn hẹp (mở bằng mã, vì nút ẩn trên điện thoại)
  await page.evaluate(() => document.getElementById("uid-wms-open").click());
  await ready(page);
  const fit = await page.evaluate(() => {
    const dialog = document.getElementById("uid-wms").getBoundingClientRect(), box = element => element.getBoundingClientRect();
    return { dialogWidth: Math.round(dialog.width), viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll("#uid-wms .uid-wms__chip, #uid-wms select, #uid-wms .uid-wms__load, #uid-wms-add")].filter(e => box(e).right > dialog.right + 1 || box(e).left < dialog.left - 1).map(e => e.id || e.className),
      small: [...document.querySelectorAll("#uid-wms button, #uid-wms select, #uid-wms input[type=date]")].filter(e => e.offsetParent && box(e).height < 44).map(e => e.id || e.className) };
  });
  assert.ok(fit.dialogWidth <= fit.viewport && !fit.overflow, `hộp vừa màn hình ${width}`);
  assert.deepEqual(await srcReadAudit(page, [{ id: "uid-wms-load", text: "", icon: true, size: phone ? 48 : 44 }], width), [], `${width}px: nút tải lại một kiểu`);
  assert.deepEqual(fit.clipped, [], "không phần tử nào tràn khỏi hộp");
  assert.deepEqual(fit.small, [], "mục bấm cao tối thiểu 44px");
  assert.deepEqual(errors, []);
  await page.close();
}

// Đọc từ WMS chỉ dành cho Admin: chưa có phiên thì không mở tấm, không gọi Extension, mở hộp đăng nhập; đăng nhập xong tự mở; hết phiên giữa chừng thì đóng tấm.
async function gate(browser) {
  const { page, errors } = await open(browser, 1280);
  await page.evaluate(() => { window.__admin = false; });
  await page.locator("#uid-wms-open").click();
  await page.waitForFunction(() => window.__getTokenCalls === 1);
  assert.equal(await isOpen(page), false, "chưa đăng nhập Admin: không mở tấm");
  assert.deepEqual(await page.evaluate(() => window.__extCalls.map(c => c.type).filter(t => t !== "PING")), [], "chưa đăng nhập Admin: không gọi Extension");
  await page.evaluate(() => dispatchEvent(new Event("print-sku-admin-ready")));
  await page.waitForFunction(() => window.__getTokenCalls === 2);
  assert.equal(await isOpen(page), false, "chưa có phiên (accessToken vẫn từ chối): vẫn đóng, hỏi đăng nhập lại");
  await loggedIn(page); await ready(page);
  assert.equal(await isOpen(page), true, "đăng nhập xong tự mở tấm");
  assert.equal((await calls(page, "GET_GROUP_UID_NEW_PAGE")).length, 1);
  // Hết phiên giữa chừng: tải lại → đóng tấm, mở hộp đăng nhập, không gọi thêm WMS
  await page.evaluate(() => { window.__admin = false; });
  await page.locator("#uid-wms-load").click();
  await page.waitForFunction(() => window.__getTokenCalls === 3);
  assert.equal(await isOpen(page), false, "hết phiên: đóng tấm");
  assert.equal((await calls(page, "GET_GROUP_UID_NEW_PAGE")).length, 1, "hết phiên: không gọi thêm WMS");
  await loggedIn(page);
  assert.equal(await isOpen(page), true, "đăng nhập lại: mở lại tấm");
  assert.ok(await listed(page) > 0, "dữ liệu đã tải vẫn còn");
  // Đăng nhập Admin ở nơi khác (không có yêu cầu mở tấm) không được tự bật tấm
  await page.keyboard.press("Escape");
  await loggedIn(page);
  assert.equal(await isOpen(page), false);
  assert.deepEqual(errors, []);
  await page.close();
  // Không giả lập: hộp đăng nhập Admin thật của trang hiện ra
  const real = await open(browser, 1280, { stub: false });
  await real.page.locator("#uid-wms-open").click();
  await real.page.waitForFunction(() => !document.getElementById("admin-auth").hidden);
  assert.equal(await isOpen(real.page), false);
  assert.deepEqual(await real.page.evaluate(() => window.__extCalls.map(c => c.type).filter(t => t !== "PING")), []);
  await real.page.close();
}

// Khiên Admin ở thanh trên (cùng Cắt Group UID, Lịch sử Group UID, Kiểm kê SKU…): trắng khi chưa đăng nhập, xanh có dấu tick khi là Admin, bấm khi là Admin thì hỏi thoát.
async function shield(browser, width) {
  const { page, errors } = await open(browser, width);
  const button = page.locator("#uid-admin"), state = () => button.getAttribute("aria-pressed");
  assert.equal(await state(), "true", "đã là Admin: khiên xanh");
  assert.equal(await button.getAttribute("aria-label"), "Đang là Admin · bấm để thoát");
  const box = await button.boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44 && box.x + box.width <= width, "khiên đủ 44 px và nằm trong màn hình");
  const look = await button.evaluate(e => ({ back: getComputedStyle(e).backgroundColor, check: getComputedStyle(e.querySelector(".uid-topbar__admin-check")).display, size: e.querySelector("svg").getBoundingClientRect().width }));
  assert.equal(look.back, "rgb(0, 95, 65)", "nền xanh thương hiệu như các màn khác"); assert.notEqual(look.check, "none", "có dấu tick"); assert.equal(look.size, 20);
  await button.click();
  const confirm = page.locator("dialog.whd"); await confirm.waitFor({ state: "visible" });
  await confirm.locator(".whd-ok").click(); await confirm.waitFor({ state: "hidden" });
  assert.equal(await state(), "false", "thoát Admin: khiên trắng");
  assert.equal(await button.getAttribute("aria-label"), "Đăng nhập Admin");
  await button.click(); // chưa là Admin: mở hộp đăng nhập dùng chung (ở đây chỉ đếm lượt gọi)
  await page.waitForFunction(() => window.__getTokenCalls === 1);
  await loggedIn(page);
  assert.equal(await state(), "true", "đăng nhập xong: khiên xanh");
  const name = await page.locator("#uid-title").boundingBox(), pill = await page.locator("#uid-printer-pill").boundingBox();
  const apart = (a, b) => a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 || a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1;
  assert.ok(apart(name, pill) && apart(name, box) && apart(pill, box), "tên màn · máy in · khiên không đè nhau");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "không tràn ngang");
  assert.deepEqual(errors, []);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await desktop(browser);
    await gate(browser);
    for (const width of [1280, 390]) await shield(browser, width);
    for (const width of [820, 375]) await narrow(browser, width);
    console.log("group_uid_wms_picker_browser: đạt (1280 / 820 / 375, cổng Admin)");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
