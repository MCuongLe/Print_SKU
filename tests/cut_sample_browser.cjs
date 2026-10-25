// KHỐI QUÉT CHUNG của tab 1 · Quét Group UID (#cut-group-uid): công tắc Cắt tự do | Theo PO dùng chung một ô quét. Cắt tự do = luồng cũ.
// Theo PO: Admin (bánh răng) nhập PO → đọc Group UID + ASN qua Extension → chia mẫu (cắt 20% nhỏ nhất, QC 10% lớn nhất, mỗi lot cắt + QC ≥ 30%, còn lại
// lưu trữ) → tạo phiên → nhân viên quét UID (pop-up cắt / QC / lưu trữ, thanh tiến độ theo SKU) → "Chuyển sang Cắt UID" đẩy UID cắt đã quét vào luồng
// Cắt cũ (Tra cứu). Danh sách UID mở từ các chip. Extension + Supabase giả.
// Chạy với python -m http.server 8000; Extension và các hàm Supabase giả lập (mô phỏng đúng hợp đồng của supabase/cut_sample_v1.sql).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
// axe-core chỉ dùng khi test (npm install ở thư mục gốc); không có thì bỏ qua phần kiểm tiếp cận.
let AXE = null;
try { AXE = require.resolve("axe-core/axe.min.js", { paths: [path.join(__dirname, "..")] }); } catch (_) { /* không có axe-core */ }
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const PO = "10012600000777", PO_BIG = "10012600000888", PO_HUGE = "10012600000666", PO_RULE = "10012600000444", PO_EMPTY = "10012600000999", PO_OTHER = "10012600000555";
const ADMIN_TOKEN = "test-admin-token";

// --- Dữ liệu WMS giả (đúng hình dạng sau normalizePoGroupUidPage) ---
const uidRow = (code, sku, lot, roll, qty, extra = {}) => ({
  group_uid_code: String(code), batch_code: lot, roll_code: roll, warehouse: "WH - MATERIAL - MTG", location: "F0-A-01", sku, qty, updated_by: "api@hasaki.vn",
  updated_date: "2026-10-15T11:50:51.000Z", status: "Available", products: sku ? [{ sku, quantity: qty, product_name: `SP ${sku}` }] : [], purchase_order: PO, source_type: "PURCHASE_ORDER", ...extra
});
const A1 = Array.from({ length: 10 }, (_, i) => uidRow(1028260000000001 + i, "900000014", "L1", `1-${i + 1}`, 31000 + i * 1000));
const A2 = [uidRow(1028260000000011, "900000014", "L2", "2-1", 50000)];
const B1 = Array.from({ length: 5 }, (_, i) => uidRow(1028260000000021 + i, "900000015", "L3", `3-${i + 1}`, 60000 + i * 10000));
const INVALID = [
  uidRow(1028260000000031, null, null, null, 0, { status: "New" }),
  uidRow(1028260000000032, null, "L9", "9-1", 100, { products: [{ sku: "900000014", quantity: 40 }, { sku: "900000015", quantity: 60 }] }),
  uidRow(1028260000000033, "900000014", "L1", "1-99", 31500, { status: "Canceled" })
];
const POOL = { [PO]: [...INVALID, ...A1, ...A2, ...B1].map(r => ({ ...r, purchase_order: PO })), [PO_EMPTY]: [],
  [PO_RULE]: [...Array.from({ length: 7 }, (_, i) => uidRow(4028261016000000 + i, "900000015", "R7", `7-${i + 1}`, 60000 + i * 1000, { purchase_order: PO_RULE })),
    ...Array.from({ length: 12 }, (_, i) => uidRow(4028261016000100 + i, "900000015", "R12", `12-${i + 1}`, 70000 + i * 1000, { purchase_order: PO_RULE }))],
  [PO_HUGE]: Array.from({ length: 5100 }, (_, i) => uidRow(3028261016000000 + i, "900000016", `LH${Math.floor(i / 20)}`, String(i), 10000 + i, { purchase_order: PO_HUGE })),
  [PO_BIG]: Array.from({ length: 620 }, (_, i) => uidRow(2028261016000000 + i, "900000016", `LB${Math.floor(i / 20)}`, String(i), 10000 + i, { purchase_order: PO_BIG })) };
const ASNS = { [PO]: [{ asn_id: 60611, asn_number: "1002261015060611", type: "PURCHASE_ORDER", status: "Received", shipment: "1001260618081586", warehouse: "WH - MATERIAL - MTG", created_at: "2026-10-15T11:51:03.000Z" },
  { asn_id: 35563, asn_number: "1002261015035563", type: "PURCHASE_ORDER", status: "Open", shipment: "1001260618081586", warehouse: "WH - MATERIAL - MTG", created_at: "2026-10-15T07:05:23.000Z" }] };
const NAMES = { "900000014": "Vải A đỏ/g", "900000015": "Vải B xanh/mm" };

const fakeExtension = ({ pool, asns }) => {
  window.__extCalls = []; window.__extFail = "";
  addEventListener("message", async event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return window.__extFail === "ping" ? reply(false, null, { message: "Không thấy tab WMS" }) : reply(true, { version: "0.9.2" });
    if (window.__hold && request.type === "GET_PO_GROUP_UID_PAGE") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
    if (window.__extFail === "read") return reply(false, null, { message: "Phiên WMS hết hạn; hãy đăng nhập lại WMS" });
    const { purchaseOrder, page, size } = request.payload || {};
    if (request.type === "GET_PO_ASN_PAGE") {
      const rows = asns[purchaseOrder] || [];
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: rows.slice((page - 1) * size, page * size), sourceRows: rows.length, purchaseOrder });
    }
    if (request.type === "GET_PO_GROUP_UID_PAGE") {
      const rows = pool[purchaseOrder] || [], slice = rows.slice((page - 1) * size, page * size);
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: slice, sourceRows: slice.length, purchaseOrder });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

// --- Supabase giả: trạng thái ở Node, mô phỏng cut_sample_v1.sql ---
const makeServer = () => {
  const sessions = new Map(), items = [], cutRows = new Map(), calls = [];
  let seq = 0;
  const counts = sid => {
    const mine = items.filter(i => i.sid === sid), by = role => mine.filter(i => i.role === role);
    return { total: mine.length, cut: by("cut").length, cutScanned: by("cut").filter(i => i.scannedAt).length, qc: by("qc").length, qcScanned: by("qc").filter(i => i.scannedAt).length,
      store: by("store").length, storeScanned: by("store").filter(i => i.scannedAt).length, pushed: mine.filter(i => i.pushedAt).length };
  };
  const itemJson = i => ({ groupUid: i.groupUid, sku: i.sku, lot: i.lot, roll: i.roll, qty: i.qty, role: i.role, scannedAt: i.scannedAt, scannedBy: i.scannedBy, pushedAt: i.pushedAt });
  const sessionJson = s => ({ id: s.id, po: s.po, asns: s.asns, createdAt: s.createdAt, updatedAt: s.updatedAt, counts: counts(s.id) });
  const fail = (code, message, data) => ({ ok: false, error: { code, message, ...(data ? { data } : {}) } });
  const ok = data => ({ ok: true, data, meta: { schemaVersion: 1 } });
  const isAdmin = headers => headers.authorization === `Bearer ${ADMIN_TOKEN}`;
  const handlers = {
    cut_sample_list: () => ok({ sessions: [...sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(sessionJson) }),
    cut_sample_get: ({ p_session }) => !sessions.has(p_session) ? fail("SESSION_NOT_FOUND", "Phiên lấy mẫu không còn tồn tại") : ok({ session: sessionJson(sessions.get(p_session)), items: items.filter(i => i.sid === p_session).map(itemJson) }),
    cut_sample_scan: ({ p_session, p_group_uid, p_by }) => {
      const code = String(p_group_uid || "").trim();
      if (!code) return fail("INVALID_UID", "Mã Group UID không hợp lệ");
      if (!sessions.has(p_session)) return fail("SESSION_NOT_FOUND", "Phiên lấy mẫu đã bị xóa");
      const item = items.find(i => i.groupUid === code);
      if (!item) return fail("NOT_IN_SESSION", "UID không thuộc phiên lấy mẫu nào");
      if (item.sid !== p_session) return fail("OTHER_SESSION", "UID thuộc phiên của PO khác", { po: sessions.get(item.sid).po, sessionId: item.sid, item: itemJson(item) });
      let result = "already";
      if (!item.scannedAt) { item.scannedAt = new Date().toISOString(); item.scannedBy = p_by || null; result = "scanned"; }
      return ok({ result, item: itemJson(item), counts: counts(p_session) });
    },
    cut_sample_create: ({ p_po, p_asns, p_items }, headers) => {
      if (!isAdmin(headers)) return fail("FORBIDDEN", "Chỉ Admin được tạo phiên lấy mẫu");
      let s = [...sessions.values()].find(x => x.po === p_po);
      const old = s ? items.filter(i => i.sid === s.id) : [];
      const taken = p_items.find(n => items.some(i => i.groupUid === n.groupUid && (!s || i.sid !== s.id)));
      if (taken) return fail("UID_IN_OTHER_SESSION", "Có Group UID đã thuộc phiên của PO khác");
      const replaced = Boolean(s);
      if (!s) { s = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, po: p_po, createdAt: new Date().toISOString() }; sessions.set(s.id, s); }
      s.asns = p_asns; s.updatedAt = new Date().toISOString();
      const keep = new Map(old.map(i => [i.groupUid, i]));
      for (let k = items.length - 1; k >= 0; k -= 1) if (items[k].sid === s.id) items.splice(k, 1);
      let carried = 0;
      for (const n of p_items) {
        const prev = keep.get(n.groupUid), same = prev && prev.role === n.role;
        if (same && prev.scannedAt) carried += 1;
        items.push({ sid: s.id, groupUid: n.groupUid, sku: n.sku, lot: n.lot || "", roll: n.roll || "", qty: n.qty, role: n.role, scannedAt: same ? prev.scannedAt : null, scannedBy: same ? prev.scannedBy : null, pushedAt: same ? prev.pushedAt : null });
      }
      return ok({ session: sessionJson(s), replaced, carried, dropped: Math.max(old.filter(i => i.scannedAt).length - carried, 0) });
    },
    cut_sample_delete: ({ p_session }, headers) => {
      if (!isAdmin(headers)) return fail("FORBIDDEN", "Chỉ Admin được xóa phiên lấy mẫu");
      if (!sessions.has(p_session)) return fail("SESSION_NOT_FOUND", "Phiên lấy mẫu không còn tồn tại");
      const po = sessions.get(p_session).po; sessions.delete(p_session);
      for (let k = items.length - 1; k >= 0; k -= 1) if (items[k].sid === p_session) items.splice(k, 1);
      return ok({ po });
    },
    cut_sample_unscan: ({ p_session, p_group_uid }, headers) => {
      if (!isAdmin(headers)) return fail("FORBIDDEN", "Chỉ Admin được bỏ dấu đã quét");
      const item = items.find(i => i.sid === p_session && i.groupUid === p_group_uid);
      if (!item) return fail("NOT_IN_SESSION", "UID không thuộc phiên này");
      if (item.pushedAt) return fail("ALREADY_PUSHED", "UID đã chuyển sang luồng Cắt UID, không bỏ dấu quét được");
      item.scannedAt = null; item.scannedBy = null;
      return ok({ item: itemJson(item), counts: counts(p_session) });
    },
    cut_sample_confirm: ({ p_session }) => {
      if (!sessions.has(p_session)) return fail("SESSION_NOT_FOUND", "Phiên lấy mẫu đã bị xóa");
      let pushed = 0, marked = 0; const missing = [];
      for (const i of items.filter(x => x.sid === p_session && x.role === "cut" && x.scannedAt && !x.pushedAt)) {
        if (!NAMES[i.sku]) { missing.push(i.groupUid); continue; }
        if (!cutRows.has(i.groupUid)) { cutRows.set(i.groupUid, { sku: i.sku, lot: i.lot, roll: i.roll, name: NAMES[i.sku], status: "pending" }); pushed += 1; }
        i.pushedAt = new Date().toISOString(); marked += 1;
      }
      return ok({ pushed, alreadyCut: Math.max(marked - pushed, 0), missingName: missing, cutUnscanned: items.filter(x => x.sid === p_session && x.role === "cut" && !x.scannedAt).length, counts: counts(p_session) });
    }
  };
  return { sessions, items, cutRows, calls, handlers };
};

async function open(browser, server, width, { admin = true, openSample = true } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.route("**/*", route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    const rpc = /\/rest\/v1\/rpc\/(cut_sample_\w+)/.exec(url);
    if (rpc) {
      const body = route.request().postDataJSON() || {}, headers = route.request().headers();
      server.calls.push({ name: rpc[1], body, auth: headers.authorization });
      const reply = server.handlers[rpc[1]](body, headers);
      if (rpc[1] === "cut_sample_scan" && server.floor === "deny") return json({ ok: false, error: { code: "ACCESS_DENIED", message: "Máy chưa kích hoạt; vào ô KÍCH HOẠT MÁY." } });
      if (rpc[1] === "cut_sample_scan" && server.floor === "warn") return json({ ...reply, accessWarning: true });
      return json(reply);
    }
    if (/\/rest\/v1\/rpc\/cut_group_uid_scan/.test(url)) {
      const uid = route.request().postDataJSON().p_group_uid;
      server.calls.push({ name: "cut_group_uid_scan", body: { uid } });
      server.cutRows.set(uid, { sku: "900000024", lot: "FREE", roll: "9", name: "Vải quét tự do", status: "pending" });
      return json({ ok: true, data: { groupUid: uid, sku: "900000024", productName: "Vải quét tự do", lot: "FREE", roll: "9" } });
    }
    const cut = /\/rest\/v1\/rpc\/(cut_group_uid_list|cut_group_uid_search)/.exec(url);
    if (cut) {
      const items = [...server.cutRows].map(([groupUid, r]) => ({ groupUid, sku: r.sku, productName: r.name, lot: r.lot, roll: r.roll, printStatus: r.status, createdAt: new Date().toISOString(), adjExportedAt: null }));
      server.calls.push({ name: cut[1] });
      return json({ ok: true, data: { items } });
    }
    if (url.includes("/rest/v1/SKU_Name")) {
      const wanted = decodeURIComponent((/sku=in\.\(([^)]*)\)/.exec(url) || [])[1] || "").split(",");
      return json(wanted.filter(s => NAMES[s]).map(s => ({ sku: s, product_name: NAMES[s] })));
    }
    return json({ ok: true, data: { agents: [], jobs: [] } });
  });
  await page.addInitScript(fakeExtension, { pool: POOL, asns: ASNS });
  await page.goto(`${BASE}#cut-group-uid`);
  await page.evaluate(({ admin, token }) => {
    window.__admin = admin;
    window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("hết phiên"); return token; } };
    window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => (window.__admin ? token : ""), getToken: async () => (window.__admin ? token : ""), logout() { window.__admin = false; dispatchEvent(new Event("print-sku-admin-logout")); } };
    dispatchEvent(new Event("print-sku-admin-ready"));
  }, { admin, token: ADMIN_TOKEN });
  await page.waitForSelector("#cut-group-uid-screen:not([hidden])");
  if (openSample) { await page.locator("#cs-mode-po").click(); await page.waitForSelector('#cs-scan[data-mode="po"]'); }
  return { page, errors };
}
// CUT_SAMPLE_SHOTS=<thư mục> → lưu ảnh chụp các màn chính để xem bằng mắt (không bật thì bỏ qua).
const shot = (page, name) => process.env.CUT_SAMPLE_SHOTS ? page.screenshot({ path: `${process.env.CUT_SAMPLE_SHOTS}/${name}.png` }) : Promise.resolve();
const msg = page => page.locator("#cs-message").innerText();
const axeCheck = async (page, label) => {
  if (!AXE) return;
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.addScriptTag({ path: AXE });
  const violations = await page.evaluate(async () => (await axe.run({ include: ["#cut-group-uid-screen"] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] }, resultTypes: ["violations"] })).violations
    .map(v => `${v.id} (${v.impact}): ${v.nodes.map(n => n.target.join(" ") + " " + String(n.html).slice(0, 220) + " " + JSON.stringify((n.any[0] || n.all[0] || {}).data || {})).join(" | ")}`));
  assert.deepEqual(violations, [], `axe · ${label}`);
};
// Hộp thoại của khối: Phiên theo PO (Admin, bánh răng) và Danh sách Group UID (chip). Mở cái này thì đóng cái kia trước.
const closeDialogs = async page => { while (await page.locator("dialog.cs-dlg[open]").count()) { await page.keyboard.press("Escape"); await page.waitForTimeout(60); } };
const openPlans = async page => { if (!(await page.locator("#cs-plans-dialog[open]").count())) { await closeDialogs(page); await page.locator("#cs-manage").click(); await page.waitForSelector("#cs-plans-dialog[open]"); } };
const openList = async (page, role = "todo") => { await closeDialogs(page); await page.locator(`#cs-totals [data-list="${role}"]`).click(); await page.waitForSelector("#cs-list-dialog[open]"); };
const popTitle = page => page.locator("#cs-pop-card h3").innerText();
const TONE_RGB = { cut: "rgb(22, 132, 91)", qc: "rgb(36, 90, 168)", store: "rgb(95, 102, 107)", warn: "rgb(154, 100, 20)", error: "rgb(194, 65, 59)" };
// Dải màu đặc theo loại: đục ngay khi hiện, chữ tiêu đề trắng trên dải, thân thẻ nền trắng.
const assertPopTone = async (page, tone) => {
  const got = await page.evaluate(() => {
    const card = document.getElementById("cs-pop-card"), head = card.querySelector(".cs-pop__head"), h3 = head && head.querySelector("h3");
    return { opacity: getComputedStyle(card).opacity, cardBg: getComputedStyle(card).backgroundColor, headBg: head ? getComputedStyle(head).backgroundColor : null, h3Color: h3 ? getComputedStyle(h3).color : null };
  });
  assert.equal(got.headBg, TONE_RGB[tone], `dải màu đúng tone ${tone}`);
  assert.equal(got.h3Color, "rgb(255, 255, 255)", `tiêu đề chữ trắng trên dải ${tone}`);
  assert.equal(got.opacity, "1", `thẻ đục ngay khi hiện (${tone})`);
  assert.equal(got.cardBg, "rgb(255, 255, 255)", `nền thẻ trắng (${tone})`);
};
const scan = async (page, code, title) => {
  await page.locator("#cut-code").fill(code);
  await page.locator("#cut-code").press("Enter");
  await page.waitForFunction(t => !document.getElementById("cs-pop").hidden && document.querySelector("#cs-pop-card h3")?.textContent === t, title, { timeout: 5000 });
};
const chipsText = page => page.locator('#cs-totals [data-role="cut"], #cs-totals [data-role="qc"], #cs-totals [data-role="store"]').allInnerTexts().then(parts => parts.join(" ").replace(/\s+/g, " ").trim());
const overflowX = page => page.evaluate(() => { const s = document.getElementById("cut-group-uid-screen"); return s.scrollWidth - s.clientWidth; });

// Nút đọc nguồn một kiểu .src-read (17/10/2026, khối #hero-standard): lớp, nhãn, icon mask ở ::before (không còn svg / act-icon--load), cùng màu / cỡ / bo với nút đọc ở các màn khác.
// spec: id, text, mate? (id nút/ô cùng hàng phải cao bằng). Trả danh sách điểm lệch (rỗng = đạt).
const srcReadAudit = (page, specs, width) => page.evaluate(async ({ specs, width }) => {
  const mobile = width <= 800, ctl = mobile ? 48 : 52, bad = [];
  for (const spec of specs) {
    const b = document.getElementById(spec.id);
    if (!b) { bad.push(`#${spec.id} không có`); continue; }
    await Promise.all(b.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
    const s = getComputedStyle(b), before = getComputedStyle(b, "::before"), mask = before.maskImage || before.webkitMaskImage, text = b.innerText.trim(), h = parseFloat(s.height);
    if (!b.classList.contains("src-read")) bad.push(`#${spec.id} thiếu lớp src-read`);
    if (b.classList.contains("act-icon--load")) bad.push(`#${spec.id} còn lớp act-icon--load`);
    if (text !== spec.text) bad.push(`#${spec.id} chữ "${text}", cần "${spec.text}"`);
    if (!mask || mask === "none" || before.content === "none") bad.push(`#${spec.id}::before không có icon mask`);
    if (b.querySelector("svg")) bad.push(`#${spec.id} còn svg trong nút (icon phải là mask ::before)`);
    if (Math.abs(h - ctl) > 1) bad.push(`#${spec.id} cao ${h}px, cần ${ctl}px`);
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
  const server = makeServer(), { page, errors } = await open(browser, server, 1280);

  // Gộp vào thẻ Quét: vẫn 4 tab như cũ, một công tắc Cắt tự do | Theo PO; không còn tab / ô trang chủ / route riêng.
  assert.equal(await page.locator("#cut-group-uid-screen").isVisible(), true);
  assert.deepEqual(await page.locator("#cut-group-uid-screen .cut-tab").evaluateAll(tabs => tabs.map(t => t.id)), ["cut-tab-scan", "cut-tab-data", "cut-tab-print", "cut-tab-adj"]);
  assert.equal(await page.locator("#cut-tab-sample, #cs-panel, #barcode-cut-sample").count(), 0);
  assert.deepEqual(await page.locator(".cs-modebtn").allInnerTexts(), ["Cắt tự do", "Theo PO"]);
  assert.equal(await page.locator("#cs-mode-po").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#cut-add").innerText(), "Quét", "nút quét đổi nhãn khi Theo PO");
  assert.equal(await page.locator("#cs-po-top").isVisible(), true);
  assert.equal(await page.locator("#cut-goto-data").isHidden(), true, "Theo PO ẩn link Tra cứu của luồng cũ");
  // Nhớ chế độ theo máy: ra trang chủ rồi vào lại Cắt Group UID vẫn Theo PO.
  await page.goto(`${BASE}#home`);
  await page.locator("#barcode-cut-uid").click();
  await page.waitForSelector("#cut-group-uid-screen:not([hidden])");
  await page.waitForSelector('#cs-scan[data-mode="po"]');
  assert.equal(await page.locator('#app-nav .an-item[aria-current="page"]').innerText(), "Cắt Group UID", "thanh bên đánh dấu Cắt Group UID");
  // Đổi sang tab khác thì khối quét ẩn, về tab Quét thì khối quét vẫn ở Theo PO.
  await page.locator("#cut-tab-adj").click();
  assert.equal(await page.locator("#cs-scan").isVisible(), false);
  await page.locator("#cut-tab-scan").click();
  assert.equal(await page.locator('#cs-scan[data-mode="po"]').count(), 1);

  // Chưa có phiên: chọn phiên trống, quét báo chưa chọn phiên.
  assert.match(await page.locator("#cs-plan").innerText(), /Chưa có phiên/);
  await scan(page, "1028260000000001", "CHƯA CHỌN PHIÊN THEO PO");
  await page.locator("[data-pop-close]").click();
  assert.equal(await page.locator("#cs-pop").isHidden(), true);

  // Bàn phím ảo khóa như luồng Cắt UID: inputmode none, bật/tắt.
  assert.equal(await page.locator("#cut-code").getAttribute("inputmode"), "none");
  await page.locator("#cut-keyboard").click();
  assert.equal(await page.locator("#cut-code").getAttribute("inputmode"), "text");
  await page.locator("#cut-keyboard").click();
  assert.equal(await page.locator("#cut-code").getAttribute("inputmode"), "none");

  // ---- Admin: đọc PO ----
  assert.equal(await page.locator("#cs-manage").isVisible(), true, "Admin thấy bánh răng quản lý phiên");
  await openPlans(page);
  // Khuôn nút đọc một kiểu (17/10/2026): "Đọc WMS" + icon mask, cao bằng ô Số PO cùng hàng
  assert.deepEqual(await srcReadAudit(page, [{ id: "cs-po-go", text: "Đọc WMS", mate: "cs-po" }], 1280), [], "nút Đọc WMS một kiểu");
  await page.locator("#cs-po").fill("abc");
  await page.locator("#cs-po-go").click();
  assert.match(await msg(page), /Nhập đúng số PO/);
  assert.equal(await page.evaluate(() => window.__extCalls.filter(c => /^GET_PO_/.test(c.type)).length), 0, "PO sai không đọc dữ liệu WMS");

  await page.evaluate(() => { window.__extFail = "ping"; });
  await page.locator("#cs-po").fill(PO);
  await page.locator("#cs-po-go").click();
  await page.waitForFunction(() => /Không đọc được PO/.test(document.getElementById("cs-message").textContent));
  assert.match(await msg(page), /Không thấy tab WMS/);
  await page.evaluate(() => { window.__extFail = "read"; });
  await page.locator("#cs-po-go").click();
  await page.waitForFunction(() => /Phiên WMS hết hạn/.test(document.getElementById("cs-message").textContent));
  assert.equal((await page.locator("#cs-po-go").innerText()).trim(), "Đọc WMS", "lỗi xong trả nhãn, nút dùng lại được");
  assert.equal(await page.locator("#cs-po-go").getAttribute("data-busy"), "false");
  await page.evaluate(() => { window.__extFail = ""; window.__extCalls.length = 0; });

  // Giữ phản hồi Extension để chặn pha "đang đọc": data-busy, "Đang đọc…", khoá nút, icon xoay; đọc xong trả "Đọc WMS"
  const idleMask = await page.locator("#cs-po-go").evaluate(b => getComputedStyle(b, "::before").maskImage);
  await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
  await page.locator("#cs-po-go").click();
  await page.waitForFunction(() => document.getElementById("cs-po-go").dataset.busy === "true");
  assert.equal((await page.locator("#cs-po-go").innerText()).trim(), "Đang đọc…");
  assert.equal(await page.locator("#cs-po-go").isDisabled(), true, "đang đọc: nút khoá");
  assert.equal(await page.locator("#cs-po-go").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
  assert.notEqual(await page.locator("#cs-po-go").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
  await page.evaluate(() => { window.__release(); window.__hold = null; });
  await page.waitForSelector("#cs-preview:not([hidden]) #cs-create");
  await page.waitForFunction(() => document.getElementById("cs-po-go").dataset.busy !== "true");
  assert.equal((await page.locator("#cs-po-go").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn");
  assert.equal(await page.locator("#cs-po-go").isDisabled(), false);
  const preview = (await page.locator("#cs-preview").innerText()).replace(/\s+/g, " ");
  assert.match(preview, /19 UID trong PO/);
  assert.match(preview, /16 UID dùng được/);
  assert.match(preview, /2 ASN · 1 đã nhận · 1 chưa nhận/);
  assert.match(preview, /1 UID chưa nhận/);
  assert.match(preview, /1 UID nhiều SKU/);
  assert.match(preview, /1 UID đã hủy\/đóng/);
  assert.match(preview, /Cắt 4/); assert.match(preview, /QC 2/); assert.match(preview, /Lưu trữ 10/);
  const groupRows = await page.locator("#cs-preview tbody tr").evaluateAll(rows => rows.map(r => [...r.children].map(c => c.textContent.trim())));
  await shot(page, "d-preview");
  await axeCheck(page, "xem trước PO");
  assert.deepEqual(groupRows, [["900000014", "L1", "10", "2", "1", "7", "30%"], ["900000014", "L2", "1", "1", "0", "0", "100%"], ["900000015", "L3", "5", "1", "1", "3", "40%"]]);
  assert.match(preview, /Mẫu 6\/16 · 38%/, "chip tổng mẫu cắt + QC");
  const asnCall = await page.evaluate(() => window.__extCalls.find(c => c.type === "GET_PO_ASN_PAGE").payload);
  assert.deepEqual([asnCall.purchaseOrder, asnCall.size], [PO, 500]);

  // Tạo phiên → server nhận đúng vai trò: cắt = cây nhỏ nhất, QC = cây lớn nhất.
  await page.locator("#cs-create").click();
  await page.waitForFunction(() => /Đã tạo phiên PO/.test(document.getElementById("cs-message").textContent));
  assert.match(await msg(page), /4 cắt · 2 QC · 10 lưu trữ/);
  const created = server.calls.find(c => c.name === "cut_sample_create");
  assert.equal(created.auth, `Bearer ${ADMIN_TOKEN}`);
  assert.equal(created.body.p_po, PO);
  assert.equal(created.body.p_asns.length, 2);
  const role = code => created.body.p_items.find(i => i.groupUid === code)?.role;
  assert.deepEqual(["1028260000000001", "1028260000000002"].map(role), ["cut", "cut"], "L1: 2 cây nhỏ nhất → cắt");
  assert.equal(role("1028260000000010"), "qc", "L1: cây lớn nhất → QC");
  assert.equal(role("1028260000000011"), "cut", "lot 1 cây → chỉ cắt");
  assert.equal(role("1028260000000021"), "cut"); assert.equal(role("1028260000000025"), "qc");
  assert.equal(created.body.p_items.length, 16);
  assert.equal(created.body.p_items.some(i => ["1028260000000031", "1028260000000032", "1028260000000033"].includes(i.groupUid)), false, "UID loại không đưa vào phiên");

  // ---- Tab Quét: tổng, thanh tiến độ theo SKU ----
  assert.equal(await chipsText(page), "Cắt 0/4 QC 0/2 Lưu trữ 0/10");
  assert.equal(await page.locator(".cs-sku").count(), 2);
  assert.match(await page.locator(".cs-sku").first().innerText(), /900000014/);
  assert.equal(await page.locator("#cs-confirm").isDisabled(), true, "chưa quét UID cắt nào thì chưa xác nhận được");

  await scan(page, "1028260000000001", "CẮT GROUP UID NÀY");
  assert.match(await page.locator("#cs-pop-card").innerText(), /900000014/);
  assert.match(await page.locator("#cs-pop-card").innerText(), /31 kg/, "đơn vị g hiện kg");
  assert.equal(await page.locator("#cs-pop-card").getAttribute("data-tone"), "cut");
  await assertPopTone(page, "cut");
  assert.equal(await chipsText(page), "Cắt 1/4 QC 0/2 Lưu trữ 0/10");
  await shot(page, "d-pop-cut");
  await scan(page, "1028260000000010", "CHUYỂN QC TEST");
  await shot(page, "d-pop-qc");
  assert.equal(await page.locator("#cs-pop-card").getAttribute("data-tone"), "qc");
  await assertPopTone(page, "qc");
  await scan(page, "1028260000000005", "CHUYỂN KHO LƯU TRỮ");
  await shot(page, "d-pop-store");
  assert.equal(await page.locator("#cs-pop-card").getAttribute("data-tone"), "store");
  await assertPopTone(page, "store");
  // Quét lại: báo đã quét, giờ quét không đổi.
  await scan(page, "1028260000000001", "ĐÃ QUÉT UID NÀY");
  assert.equal(await page.locator("#cs-pop-card").getAttribute("data-tone"), "warn");
  await shot(page, "d-pop-warn");
  await assertPopTone(page, "warn");
  assert.equal(await chipsText(page), "Cắt 1/4 QC 1/2 Lưu trữ 1/10");
  // UID lạ / thuộc PO khác / mã rỗng sau trim.
  await scan(page, "9999999999999999", "UID KHÔNG THUỘC PHIÊN NÀO");
  await shot(page, "d-pop-error");
  await axeCheck(page, "pop-up lỗi");
  assert.equal(await page.locator("#cs-pop-card").getAttribute("data-tone"), "error");
  await assertPopTone(page, "error");
  assert.equal(await chipsText(page), "Cắt 1/4 QC 1/2 Lưu trữ 1/10", "mã lạ không đổi số liệu");
  // Quét bằng máy quét: mã kèm khoảng trắng đầu/cuối vẫn khớp.
  await scan(page, " 1028260000000002 ", "CẮT GROUP UID NÀY");
  assert.equal(await page.locator("#cut-code").inputValue(), "", "ô quét được xóa sau mỗi lần quét");
  assert.equal(server.calls.filter(c => c.name === "cut_group_uid_scan").length, 0, "Theo PO không chạy luồng quét cũ");

  // Hàng đợi: bắn liên tiếp nhiều mã, không mất mã nào.
  await page.evaluate(() => { const c = document.getElementById("cut-code"); for (const v of ["1028260000000011", "1028260000000021", "1028260000000025"]) { c.value = v; document.getElementById("cut-form").requestSubmit(); } });
  await page.waitForFunction(() => [...document.querySelectorAll('#cs-totals [data-role="cut"], #cs-totals [data-role="qc"], #cs-totals [data-role="store"]')].map(e => e.innerText).join(" ").replace(/\s+/g, " ").trim() === "Cắt 4/4 QC 2/2 Lưu trữ 1/10", null, { timeout: 8000 })
    .catch(async error => { throw new Error(`${error.message}
Tổng hiện tại: ${await chipsText(page)} · tin nhắn: ${await msg(page)} · lỗi trang: ${JSON.stringify(errors)}`); });
  // SKU 900000015 đủ cắt + QC → "Đủ mẫu"; SKU 900000014 còn thiếu.
  const skuCards = await page.locator(".cs-sku").evaluateAll(cards => cards.map(c => ({ sku: c.querySelector(".cs-sku__code").textContent, done: c.dataset.done, text: c.innerText.replace(/\s+/g, " ") })));
  assert.equal(skuCards[0].done, "true", "900000014 đủ cả cắt lẫn QC");
  assert.equal(skuCards[1].done, "true");
  assert.match(skuCards[1].text, /Đủ mẫu/);
  assert.match(skuCards[1].text, /Vải B xanh/);
  const bars = await page.locator('.cs-sku[data-done="true"] [role="progressbar"]').evaluateAll(b => b.map(x => [x.getAttribute("aria-valuenow"), x.getAttribute("aria-valuemax")]));
  assert.deepEqual(bars, [["3", "3"], ["1", "1"], ["1", "1"], ["1", "1"]]);

  await page.locator("[data-pop-close]").click();
  await shot(page, "d-scan-progress");
  await axeCheck(page, "tab Quét có phiên");
  // UID thuộc phiên PO khác (tạo thêm phiên thứ 2 trực tiếp trên server giả).
  server.sessions.set("11111111-1111-4111-8111-111111111111", { id: "11111111-1111-4111-8111-111111111111", po: PO_OTHER, asns: [], createdAt: new Date().toISOString(), updatedAt: "2000-01-01T00:00:00.000Z" });
  server.items.push({ sid: "11111111-1111-4111-8111-111111111111", groupUid: "7777777777777777", sku: "900000014", lot: "Z", roll: "1", qty: 1, role: "cut", scannedAt: null, scannedBy: null, pushedAt: null });
  await scan(page, "7777777777777777", "UID THUỘC PHIÊN PO KHÁC");
  assert.match(await page.locator("#cs-pop-card").innerText(), new RegExp(`PO ${PO_OTHER}`));
  await page.locator("[data-pop-close]").click();

  // ---- Xác nhận đẩy UID cắt đã quét sang luồng Cắt UID ----
  server.cutRows.set("1028260000000002", { sku: "900000014", lot: "L1", roll: "1-2", name: "đã có", status: "pending" }); // đã nằm ở Cắt UID từ trước
  assert.equal(await page.locator("#cs-confirm").isDisabled(), false);
  assert.match(await page.locator("#cs-confirm").innerText(), /Chuyển sang Cắt UID · 4/);
  await page.locator("#cs-confirm").click();
  await page.waitForSelector("dialog.whd[open]");
  assert.match(await page.locator("dialog.whd .whd-title").innerText(), /Chuyển 4 UID sang luồng Cắt UID/);
  await page.locator("dialog.whd .whd-cancel").click();
  assert.equal(server.calls.filter(c => c.name === "cut_sample_confirm").length, 0, "Hủy hộp thoại thì chưa chuyển");
  await page.locator("#cs-confirm").click();
  await page.locator("dialog.whd .whd-ok").click();
  await page.waitForFunction(() => /Đã chuyển 3 UID sang Cắt UID/.test(document.getElementById("cs-message").textContent));
  assert.match(await msg(page), /1 UID đã có sẵn ở Cắt UID/);
  assert.deepEqual([...server.cutRows.keys()].sort(), ["1028260000000001", "1028260000000002", "1028260000000011", "1028260000000021"]);
  assert.equal(server.cutRows.get("1028260000000011").status, "pending");
  assert.equal(await page.locator("#cs-confirm").isDisabled(), true, "đã chuyển hết thì nút xám");
  assert.match(await page.locator("#cs-confirm").innerText(), /Đã chuyển hết UID cắt/);
  // Luồng Cắt cũ thấy 4 UID mới ở Tra cứu (trạng thái pending, như UID quét ở tab Quét); script Cắt UID tải lại khi chuyển xong.
  assert.equal(await page.locator("#cs-goto-cut").isVisible(), true);
  await page.locator("#cs-goto-cut").click();
  await page.waitForSelector('#cut-tab-data[aria-selected="true"]');
  assert.equal(await page.locator("#cs-scan").isVisible(), false);
  await page.waitForFunction(() => document.getElementById("cut-found").textContent === "4");
  assert.deepEqual((await page.locator("#cut-results tr[data-code]").evaluateAll(rows => rows.map(r => r.dataset.code))).sort(), ["1028260000000001", "1028260000000002", "1028260000000011", "1028260000000021"]);
  assert.match(await page.locator("#cut-results").innerText(), /900000014/);
  await page.locator("#cut-tab-scan").click();
  await page.waitForSelector('#cs-scan[data-mode="po"]');

  // ---- Danh sách Group UID (hộp thoại mở từ chip): lọc, tìm, bỏ dấu quét (Admin) ----
  await openList(page);
  assert.equal(await page.locator("#cs-list-sub").innerText(), `PO ${PO} · 16 UID`);
  assert.equal(await page.locator('#cs-totals [data-list="todo"]').innerText(), "16 UID", "chip danh sách ghi tổng số UID");
  const filterCounts = await page.locator("#cs-filters .cs-filter").evaluateAll(b => b.map(x => x.textContent.replace(/\s+/g, " ").trim()));
  await shot(page, "d-list");
  await axeCheck(page, "tab Danh sách");
  assert.deepEqual(filterCounts, ["Chưa quét 9", "Cắt 4", "QC 2", "Lưu trữ 10", "Tất cả 16"]);
  await page.locator('[data-filter="store"]').click();
  assert.equal(await page.locator("#cs-rows tr[data-code]").count(), 10);
  await page.locator("#cs-q").fill("1028260000000005");
  assert.equal(await page.locator("#cs-rows tr[data-code]").count(), 1);
  assert.equal(await page.locator("#cs-rows [data-unscan]").count(), 1, "Admin thấy nút bỏ dấu quét ở UID đã quét chưa chuyển");
  await page.locator("#cs-q").fill("");
  await page.locator('[data-filter="cut"]').click();
  assert.equal(await page.locator("#cs-rows [data-unscan]").count(), 0, "UID cắt đã chuyển sang luồng cũ thì không bỏ quét được");
  await page.locator('[data-filter="store"]').click();
  await page.locator('#cs-rows [data-unscan="1028260000000005"]').click();
  await page.locator("dialog.whd .whd-ok").click();
  await page.waitForFunction(() => /Đã bỏ dấu quét 1028260000000005/.test(document.getElementById("cs-message").textContent));
  assert.equal(server.items.find(i => i.groupUid === "1028260000000005").scannedAt, null);
  assert.equal(await page.locator("#cs-rows [data-unscan]").count(), 0);

  // ---- Tab Phiên: đọc lại cùng PO → thay phiên, giữ dấu quét cùng vai trò ----
  await openPlans(page);
  await shot(page, "d-plans");
  await axeCheck(page, "tab Phiên theo PO");
  assert.equal(await page.locator(".cs-plan").count(), 2);
  await page.locator("#cs-po").fill(PO);
  await page.locator("#cs-po-go").click();
  await page.waitForSelector("#cs-create");
  assert.match(await page.locator("#cs-create").innerText(), new RegExp(`Thay phiên PO ${PO}`));
  assert.match(await page.locator("#cs-preview").innerText(), /giữ dấu quét cùng nhóm/);
  await page.locator("#cs-create").click();
  await page.locator("dialog.whd .whd-ok").click();
  await page.waitForFunction(() => /Đã thay phiên PO/.test(document.getElementById("cs-message").textContent));
  assert.match(await msg(page), /giữ \d+ dấu quét/);
  assert.equal(server.sessions.size, 2, "thay phiên không tạo thêm phiên");

  // PO không có UID: không cho tạo; PO lớn nhiều trang đọc đủ (620 UID, 2 trang).
  await openPlans(page);
  await page.locator("#cs-po").fill(PO_EMPTY);
  await page.locator("#cs-po-go").click();
  await page.waitForFunction(() => /chưa có Group UID dùng được/.test(document.getElementById("cs-message").textContent));
  assert.equal(await page.locator("#cs-create").isDisabled(), true);
  await page.locator("#cs-preview-close").click();
  await page.evaluate(() => { window.__extCalls.length = 0; });
  await page.locator("#cs-po").fill(PO_BIG);
  await page.locator("#cs-po-go").click();
  await page.waitForSelector("#cs-create:not([disabled])");
  assert.match((await page.locator("#cs-preview").innerText()).replace(/\s+/g, " "), /620 UID trong PO/);
  const pages = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_PO_GROUP_UID_PAGE").map(c => c.payload.page));
  assert.deepEqual(pages, [1, 2], "PO 620 UID đọc 2 trang rồi dừng");
  await page.locator("#cs-preview-close").click();
  // PO quá 5.000 UID: đọc đủ 11 trang nhưng không cho tạo phiên (hàm Supabase nhận tối đa 5.000 UID).
  await page.evaluate(() => { window.__extCalls.length = 0; });
  await page.locator("#cs-po").fill(PO_HUGE);
  await page.locator("#cs-po-go").click();
  await page.waitForSelector("#cs-create");
  assert.match((await page.locator("#cs-preview").innerText()).replace(/\s+/g, " "), /Quá 5\.000 UID\/phiên/);
  assert.equal(await page.locator("#cs-create").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_PO_GROUP_UID_PAGE").length), 11, "5.100 UID = 11 trang, trang cuối chưa đầy nên dừng");
  await page.locator("#cs-preview-close").click();

  // Quy tắc 30%: lot 7 cây lấy 3 cây (2 cắt + 1 QC), lot 12 cây lấy 4 cây (3 cắt + 1 QC); đạt ≥ 30% từng lot.
  await page.locator("#cs-po").fill(PO_RULE);
  await page.locator("#cs-po-go").click();
  await page.waitForSelector("#cs-create:not([disabled])");
  const ruleRows = await page.locator("#cs-preview tbody tr").evaluateAll(rows => rows.map(r => [...r.children].map(c => c.textContent.trim())));
  assert.deepEqual(ruleRows, [["900000015", "R12", "12", "3", "1", "8", "33%"], ["900000015", "R7", "7", "2", "1", "4", "43%"]]);
  assert.match((await page.locator("#cs-preview").innerText()).replace(/\s+/g, " "), /Mẫu 7\/19 · 37%/);
  await page.locator("#cs-create").click();
  await page.waitForFunction(() => /Đã tạo phiên PO 10012600000444/.test(document.getElementById("cs-message").textContent));
  const ruleId = [...server.sessions.values()].find(x => x.po === PO_RULE).id, ruleItems = server.items.filter(i => i.sid === ruleId);
  for (const lotCode of ["R7", "R12"]) {
    const lotItems = ruleItems.filter(i => i.lot === lotCode), picked = lotItems.filter(i => i.role !== "store");
    assert.ok(picked.length * 10 >= 3 * lotItems.length, `lot ${lotCode}: ${picked.length}/${lotItems.length} chưa đạt 30%`);
    const cutQty = lotItems.filter(i => i.role === "cut").map(i => i.qty), qcQty = lotItems.filter(i => i.role === "qc").map(i => i.qty), storeQty = lotItems.filter(i => i.role === "store").map(i => i.qty);
    assert.ok(Math.max(...cutQty) < Math.min(...qcQty, ...storeQty), `lot ${lotCode}: cắt là các cây nhỏ nhất`);
    assert.ok(Math.min(...qcQty) > Math.max(...storeQty), `lot ${lotCode}: QC là cây lớn nhất`);
  }
  await openPlans(page);
  await page.locator(`.cs-plan:has-text("PO ${PO_RULE}") [data-delete]`).click();
  await page.locator("dialog.whd .whd-ok").click();
  await page.waitForFunction(() => /Đã xóa phiên PO 10012600000444/.test(document.getElementById("cs-message").textContent));

  // Xóa phiên (Admin).
  await page.locator(`.cs-plan:has-text("PO ${PO_OTHER}") [data-delete]`).click();
  await page.locator("dialog.whd .whd-ok").click();
  await page.waitForFunction(() => /Đã xóa phiên PO/.test(document.getElementById("cs-message").textContent));
  assert.equal(server.sessions.size, 1);

  // Khoá máy (17/10/2026): lệnh GHI gửi p_access_token, lệnh ĐỌC (get/list) không gửi (bản đọc không có tham số này).
  for (const name of ["cut_sample_scan", "cut_sample_confirm"]) {
    const writes = server.calls.filter(c => c.name === name);
    assert.ok(writes.length, `đã gọi ${name}`);
    assert.ok(writes.every(c => c.body.p_access_token === "public"), `${name} gửi p_access_token`);
  }
  for (const name of ["cut_sample_get", "cut_sample_list"]) {
    const reads = server.calls.filter(c => c.name === name);
    assert.ok(reads.length, `đã gọi ${name}`);
    assert.ok(reads.every(c => !("p_access_token" in c.body)), `${name} không gửi p_access_token`);
  }
  // Chọn phiên khác bằng danh sách ở khối quét.
  await closeDialogs(page);
  assert.match(await page.locator("#cs-plan option:checked").innerText(), new RegExp(`PO ${PO}`));
  assert.deepEqual(errors, [], "không có lỗi console");
  await page.close();
}

async function nonAdmin(browser) {
  const server = makeServer(), { page, errors } = await open(browser, server, 1280, { admin: false });
  assert.equal(await page.locator("#cs-manage").isHidden(), true, "người không phải Admin không thấy bánh răng quản lý phiên");
  // Đăng nhập Admin (nút khiên của màn Cắt phát print-sku-admin-ready) → thấy bánh răng, mở được hộp thoại; thoát (print-sku-admin-logout) thì ẩn và đóng hộp thoại.
  await page.evaluate(() => { window.__admin = true; dispatchEvent(new Event("print-sku-admin-ready")); });
  await page.waitForFunction(() => !document.getElementById("cs-manage").hidden);
  await openPlans(page);
  await page.evaluate(() => window.PrintSkuAdminAccess.logout());
  await page.waitForFunction(() => document.getElementById("cs-manage").hidden && !document.getElementById("cs-plans-dialog").open);
  assert.deepEqual(errors, []);
  await page.close();
}

// Luồng cũ: mặc định Cắt tự do, quét đi thẳng cut_group_uid_scan, phần Theo PO ẩn; đổi chế độ không làm hỏng luồng cũ.
async function freeMode(browser) {
  const server = makeServer(), { page, errors } = await open(browser, server, 1280, { openSample: false });
  assert.equal(await page.locator("#cs-scan").getAttribute("data-mode"), "free");
  assert.equal(await page.locator("#cs-mode-free").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#cut-add").innerText(), "Lưu tem");
  assert.equal(await page.locator("#cs-po-top, #cs-po-bottom").evaluateAll(els => els.every(el => getComputedStyle(el).display === "none")), true, "phần Theo PO ẩn khi Cắt tự do");
  await page.locator("#cut-code").fill("1028260000000003");
  await page.locator("#cut-code").press("Enter");
  await page.waitForFunction(() => !document.getElementById("cut-last").hidden);
  assert.match(await page.locator("#cut-last").innerText(), /1028260000000003 · 900000024/);
  await shot(page, "d-free");
  assert.equal(server.calls.filter(c => c.name === "cut_group_uid_scan").length, 1, "Cắt tự do lưu qua luồng cũ");
  assert.equal(server.calls.filter(c => c.name === "cut_sample_scan").length, 0);
  // Sang Theo PO rồi về: thẻ vừa lưu và link Tra cứu của luồng cũ hiện lại, nút về "Lưu tem".
  await page.locator("#cs-mode-po").click();
  assert.equal(await page.locator("#cut-last").isHidden(), true);
  await page.locator("#cs-mode-free").click();
  assert.equal(await page.locator("#cut-last").isVisible(), true);
  assert.equal(await page.locator("#cut-goto-data").isVisible(), true);
  assert.equal(await page.locator("#cut-add").innerText(), "Lưu tem");
  await page.locator("#cut-code").fill("1028260000000004");
  await page.locator("#cut-code").press("Enter");
  await page.waitForFunction(() => /1028260000000004/.test(document.getElementById("cut-last").innerText));
  assert.equal(server.calls.filter(c => c.name === "cut_group_uid_scan").length, 2);
  assert.deepEqual(errors, []);
  await page.close();
}

async function mobile(browser) {
  const server = makeServer(), { page, errors } = await open(browser, server, 375);
  // 4 tab của Cắt Group UID như cũ, nằm trọn trong bề rộng màn hình; công tắc chế độ cũng vừa màn hẹp.
  const tabBoxes = await page.locator("#cut-group-uid-screen .cut-tab").evaluateAll(tabs => tabs.map(t => { const r = t.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), t.scrollWidth - t.clientWidth]; }));
  assert.equal(tabBoxes.length, 4);
  assert.ok(tabBoxes.every(([l, r, over]) => l >= 0 && r <= 375 && over <= 0), `tab nằm trong màn hình: ${JSON.stringify(tabBoxes)}`);
  await shot(page, "m-scan-po");
  // Tạo phiên rồi quét trên màn hẹp.
  await openPlans(page);
  assert.deepEqual(await srcReadAudit(page, [{ id: "cs-po-go", text: "Đọc WMS" }], 375), [], "375px: nút Đọc WMS một kiểu");
  await page.locator("#cs-po").fill(PO);
  await page.locator("#cs-po-go").click();
  await page.waitForSelector("#cs-create:not([disabled])");
  await shot(page, "m-preview");
  await axeCheck(page, "điện thoại · xem trước");
  assert.equal(await overflowX(page), 0, "bản xem trước không tràn ngang");
  const prevRow = await page.locator("#cs-preview tbody tr").first().evaluate(row => getComputedStyle(row).display);
  assert.equal(prevRow, "grid", "bảng xem trước dạng thẻ gọn trên điện thoại");
  await page.locator("#cs-create").click();
  await page.waitForFunction(() => /Đã tạo phiên PO/.test(document.getElementById("cs-message").textContent));
  assert.equal(await overflowX(page), 0);
  assert.equal(await page.locator("#cut-code").isVisible(), true);
  assert.equal(await page.locator("#cut-add").isVisible(), true);
  await scan(page, "1028260000000001", "CẮT GROUP UID NÀY");
  await shot(page, "m-pop");
  const card = await page.locator("#cs-pop-card").boundingBox();
  assert.ok(card.x >= 0 && card.x + card.width <= 375 && card.y >= 0 && card.y + card.height <= 900, "pop-up nằm trọn trong màn hình");
  await page.locator("[data-pop-close]").click();
  assert.equal(await overflowX(page), 0);
  await openList(page);
  await shot(page, "m-list");
  await axeCheck(page, "điện thoại · danh sách");
  assert.equal(await page.locator("#cs-rows tr[data-code]").first().evaluate(row => getComputedStyle(row).display), "grid", "danh sách dạng thẻ gọn");
  assert.equal(await overflowX(page), 0, "danh sách không tràn ngang");
  const rowBox = await page.locator("#cs-rows tr[data-code]").first().boundingBox();
  assert.ok(rowBox.height < 120, `mỗi UID gọn (${Math.round(rowBox.height)}px)`);
  assert.deepEqual(errors, []);
  await page.close();
}

// Khoá máy cho nhóm ghi (17/10/2026): accessWarning → thanh vàng "Máy chưa kích hoạt" (quét vẫn chạy); ACCESS_DENIED → hộp Kích hoạt mở, số liệu không đổi.
async function floorAccess(browser) {
  const server = makeServer(), { page, errors } = await open(browser, server, 1280);
  await openPlans(page);
  await page.locator("#cs-po").fill(PO);
  await page.locator("#cs-po-go").click();
  await page.waitForSelector("#cs-create:not([disabled])");
  await page.locator("#cs-create").click();
  await page.waitForFunction(() => /Đã tạo phiên PO/.test(document.getElementById("cs-message").textContent));
  await closeDialogs(page);
  server.floor = "warn";
  await scan(page, "1028260000000001", "CẮT GROUP UID NÀY");
  await page.locator("#floor-access-bar").waitFor({ state: "visible" });
  assert.match((await page.locator("#floor-access-bar").innerText()).replace(/\s+/g, " "), /Máy chưa kích hoạt/);
  assert.equal(await chipsText(page), "Cắt 1/4 QC 0/2 Lưu trữ 0/10", "accessWarning không chặn: vẫn ghi nhận quét");
  await shot(page, "floor-bar-sample");
  await page.locator("[data-pop-close]").click();
  await page.locator("#floor-access-open").click();
  await page.waitForSelector("#pdv-dialog[open]");
  await page.locator("#pdv-cancel").click();
  server.floor = "deny";
  await page.locator("#cut-code").fill("1028260000000002");
  await page.locator("#cut-code").press("Enter");
  await page.waitForSelector("#pdv-dialog[open]");
  assert.equal(await chipsText(page), "Cắt 1/4 QC 0/2 Lưu trữ 0/10", "ACCESS_DENIED không đổi số liệu");
  assert.deepEqual(errors, []);
  await page.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await desktop(browser); console.log("PASS cut sample · máy tính: đọc PO, chia mẫu, tạo phiên, quét, tiến độ, xác nhận sang Cắt UID, danh sách, thay/xóa phiên");
    await nonAdmin(browser); console.log("PASS cut sample · quyền Admin (bánh răng, hộp thoại)");
    await freeMode(browser); console.log("PASS cut sample · Cắt tự do giữ nguyên luồng cũ, đổi chế độ không ảnh hưởng");
    await mobile(browser); console.log("PASS cut sample · điện thoại 375px");
    await floorAccess(browser); console.log("PASS cut sample · khoá máy: p_access_token cho lệnh ghi, thanh vàng, ACCESS_DENIED mở hộp kích hoạt");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
