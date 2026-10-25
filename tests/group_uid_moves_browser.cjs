// Ô LỊCH SỬ GROUP UID trên trang chủ (#group-uid-history): xem không cần đăng nhập, đọc từ WMS chỉ khi là Admin.
// Giao diện cùng khung Đồng bộ Group UID: dải thông tin + thẻ số liệu; bảng lượt chuyển và bộ lọc mở trong popup.
// Chạy với python -m http.server 8000; Extension, WMS và Supabase đều giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/", SESSION_KEY = "print-sku-admin-session-v1", DAY = 86400000, NOW = Date.now();
const fmt = n => n.toLocaleString("vi-VN");

// --- Dữ liệu WMS giả: 620 lượt (2 trang) + 2 lượt cũ (60 và 200 ngày) ---
const LOCS = ["F0-KHO-503-02-04-01", "F0-KHO-501-01-01-01", "F0-VR-00-00-00-00", "F0-KHO-HM-04-02-01"];
const USERS = ["nguoidung1@example.com", "nguoidung2@example.com", "nguoidung3@example.com"];
const WHS = ["WH - MATERIAL - MTG", "WH - SEMI PRODUCT - MTG", "WH - MATERIAL - GARMENT"];
const uidOf = i => `10282606${String(i % 200).padStart(8, "0")}`;
const skuOf = uid => `4225${String(Number(uid.slice(-3)) % 40).padStart(5, "0")}`;
const mk = (i, extra = {}) => ({
  history_id: 100000 + i, group_uid_code: uidOf(i), warehouse_id: 1177 + (i % 7 === 0 ? 1 : i % 11 === 0 ? 162 : 0),
  warehouse: i % 7 === 0 ? WHS[1] : i % 11 === 0 ? WHS[2] : WHS[0],
  action_code: 4, action_name: "Transfer location", from_location: LOCS[(i + 1) % 4], to_location: LOCS[i % 4],
  moved_by: USERS[i % 3], moved_at: new Date(NOW - i * 30 * 60000).toISOString(), ...extra,
});
const wms = Array.from({ length: 620 }, (_, i) => mk(i));
wms.push(mk(7000, { moved_at: new Date(NOW - 60 * DAY).toISOString() }), mk(7001, { moved_at: new Date(NOW - 200 * DAY).toISOString() }));
const vnDate = ms => new Date(ms + 7 * 3600000).toISOString().slice(0, 10);
const since = days => Date.parse(`${vnDate(NOW - (days - 1) * DAY)}T00:00:00+07:00`);
const count = pred => wms.filter(pred).length;
const days = n => r => Date.parse(r.moved_at) >= since(n);

const fakeExtension = (data, version) => {
  window.__extCalls = []; window.__wms = data; window.__fail = false;
  addEventListener("message", async event => {
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP") return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    if (window.__hold && request.type === "GET_GROUP_UID_MOVES_PAGE") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
    if (window.__hold2 && request.type === "GET_GROUP_UID_MOVES_PAGE" && request.payload.page === 2) await window.__hold2; // giữ trang 2 để đo tiến độ sau trang 1
    const reply = (ok, body, error) => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === "PING" || request.type === "PING_WMS") return reply(true, { version });
    if (request.type === "GET_GROUP_UID_MOVES_PAGE") {
      const { page, size, from, to } = request.payload;
      if (window.__fail) return reply(false, null, { message: "Phiên WMS không còn quyền đọc lịch sử chuyển vị trí; hãy đăng nhập lại" });
      const rows = window.__wms.filter(r => Date.parse(r.moved_at) >= Date.parse(from) && Date.parse(r.moved_at) <= Date.parse(to)).sort((a, b) => Date.parse(b.moved_at) - Date.parse(a.moved_at));
      return reply(true, { page, size, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / size)), rows: rows.slice((page - 1) * size, page * size), companyId: null });
    }
    reply(false, null, { message: "Loại yêu cầu chưa giả lập" });
  });
};

// --- Supabase giả: mô phỏng group_uid_moves_* (đối chiếu logic với supabase/group_uid_moves_v1.sql + v2_lookup.sql) ---
const db = new Map(), reads = new Map(), rpcCalls = [], comboCalls = [];
// Liên kết Combo → Normal giả (sku_combo_lookup): 900000035 có 1 Normal, 900000050 có 3 Normal, còn lại không phải Combo.
const comboRows = sku => ({
  "900000035": [["900000068", 914]],
  "900000050": [["900000065", 1], ["900000066", 2], ["900000067", 1]],
}[sku] || []).map(([normal, quantity]) => ({ normal_sku: normal, product_name: `Chỉ mẫu ${normal}`, category_name: "Phụ liệu", quantity, available: true }));
function lookup(a) {
  const loc = (a.p_location || "").trim().toLowerCase(), sku = (a.p_sku || "").trim().toLowerCase(), wh = (a.p_warehouse || "").trim(), match = ["to", "from", "any"].includes(a.p_match) ? a.p_match : "to";
  const all = [...db.values()].sort((x, y) => Date.parse(x.moved_at) - Date.parse(y.moved_at) || x.history_id - y.history_id), byUid = new Map();
  all.forEach(r => { if (!byUid.has(r.group_uid_code)) byUid.set(r.group_uid_code, []); byUid.get(r.group_uid_code).push(r); });
  const hit = all.filter(r => (!wh || r.warehouse === wh) && (!a.p_from || Date.parse(r.moved_at) >= Date.parse(a.p_from)) && (!a.p_to || Date.parse(r.moved_at) < Date.parse(a.p_to))
    && (!loc || (match !== "from" && (r.to_location || "").toLowerCase().includes(loc)) || (match !== "to" && (r.from_location || "").toLowerCase().includes(loc)))
    && (!sku || skuOf(r.group_uid_code).toLowerCase().includes(sku)))
    .sort((x, y) => Date.parse(y.moved_at) - Date.parse(x.moved_at) || y.history_id - x.history_id);
  const limit = Math.min(Math.max(a.p_limit || 1000, 1), 5000), force = sku === "big";
  const items = hit.slice(0, force ? 5 : limit).map(r => { const chain = byUid.get(r.group_uid_code), next = chain[chain.indexOf(r) + 1];
    return { id: r.history_id, uid: r.group_uid_code, warehouse: r.warehouse, from: r.from_location, to: r.to_location, by: r.moved_by, at: r.moved_at,
      nextLocation: next?.to_location ?? null, nextAt: next?.moved_at ?? null, sku: skuOf(r.group_uid_code), skuCount: 1, product: `Chỉ mẫu ${skuOf(r.group_uid_code)}` }; });
  return { items, total: force ? 7000 : hit.length, limit, truncated: force || hit.length > limit };
}
function rpc(name, args) {
  if (name === "group_uid_moves_overview" || name === "group_uid_moves_state") {
    const rows = [...db.values()], times = rows.map(r => Date.parse(r.moved_at)), counts = {};
    rows.forEach(r => { counts[r.warehouse] = (counts[r.warehouse] || 0) + 1; });
    const data = { total: rows.length, firstAt: rows.length ? new Date(Math.min(...times)).toISOString() : null, lastAt: rows.length ? new Date(Math.max(...times)).toISOString() : null,
      lastReadAt: reads.size ? new Date(Math.max(...[...reads.values()].map(r => r.at))).toISOString() : null };
    if (name === "group_uid_moves_overview") return { ...data, warehouses: Object.entries(counts).sort().map(([n, c]) => ({ name: n, count: c })) };
    return { ...data, companies: [...reads.entries()].map(([id, r]) => ({ companyId: id, companyName: r.name, lastTo: r.to, readAt: new Date(r.at).toISOString(), rows: r.rows })) };
  }
  if (name === "group_uid_moves_import") {
    let added = 0, changed = 0;
    for (const r of args.p_rows) { const old = db.get(r.history_id); if (!old) added++; else if (JSON.stringify(old) !== JSON.stringify(r)) changed++; db.set(r.history_id, r); }
    return { rows: args.p_rows.length, newRows: added, changedRows: changed, unchangedRows: args.p_rows.length - added - changed };
  }
  if (name === "group_uid_moves_mark_read") { reads.set(args.p_company_id, { name: args.p_company_name, to: args.p_to, at: Date.now(), rows: args.p_rows }); return { companyId: args.p_company_id }; }
  if (name === "group_uid_moves_lookup") return lookup(args);
  throw new Error("RPC chưa giả lập: " + name);
}
const ADMIN_ONLY = new Set(["group_uid_moves_import", "group_uid_moves_mark_read", "group_uid_moves_state"]);

async function mock(page) {
  await page.route("**/*", route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/auth/v1/user")) return json({ id: "00000000-0000-4000-8000-000000000001" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Admin", role: "admin" }]);
    if (url.includes("/rest/v1/rpc/sku_combo_lookup")) {
      const sku = JSON.parse(route.request().postData() || "{}").p_sku; comboCalls.push(sku);
      return json(comboRows(sku));
    }
    const match = /\/rest\/v1\/rpc\/(group_uid_moves_[a-z_]+)/.exec(url);
    if (match) {
      const headers = route.request().headers(), args = JSON.parse(route.request().postData() || "{}");
      rpcCalls.push({ name: match[1], args, auth: headers.authorization });
      if (ADMIN_ONLY.has(match[1]) && headers.authorization !== "Bearer test-admin-token") return json({ code: "42501", message: `permission denied for function ${match[1]}` }, 401);
      return json({ ok: true, data: rpc(match[1], args), meta: { schemaVersion: 1 } });
    }
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
}
const seed = () => { db.clear(); reads.clear(); rpcCalls.length = 0; wms.forEach(r => db.set(r.history_id, { ...r })); reads.set(0, { name: "Tất cả công ty", to: new Date(NOW).toISOString(), at: NOW, rows: wms.length }); };

async function open(browser, width, { admin }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  await context.addInitScript(`(${fakeExtension.toString()})(${JSON.stringify(wms)}, "0.7.1")`);
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await mock(page);
  return { context, page, errors };
}

// Nút đọc nguồn một kiểu .src-read (17/10/2026, khối #hero-standard): lớp, nhãn, icon mask ở ::before (không còn svg trong nút), cùng màu/cỡ/bo với nút đọc ở màn đồng bộ. Trả danh sách điểm lệch (rỗng = đạt).
const srcReadAudit = (page, specs, width) => page.evaluate(async ({ specs, width }) => {
  const mobile = width <= 800, ctl = mobile ? 48 : 52, bad = [];
  for (const spec of specs) {
    const b = document.getElementById(spec.id);
    if (!b) { bad.push(`#${spec.id} không có`); continue; }
    await Promise.all(b.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
    const s = getComputedStyle(b), before = getComputedStyle(b, "::before"), mask = before.maskImage || before.webkitMaskImage, text = b.innerText.trim(), h = parseFloat(s.height), w = parseFloat(s.width), all = spec.classes.includes("src-read--all");
    for (const cls of spec.classes) if (!b.classList.contains(cls)) bad.push(`#${spec.id} thiếu lớp ${cls}`);
    if (b.classList.contains("ss-primary")) bad.push(`#${spec.id} còn lớp ss-primary`);
    if (text !== spec.text) bad.push(`#${spec.id} chữ "${text}", cần "${spec.text}"`);
    if (spec.title !== undefined && b.title !== spec.title) bad.push(`#${spec.id} title "${b.title}", cần "${spec.title}"`);
    if (spec.aria && b.getAttribute("aria-label") !== spec.aria) bad.push(`#${spec.id} aria-label "${b.getAttribute("aria-label")}", cần "${spec.aria}"`);
    if (!mask || mask === "none" || before.content === "none") bad.push(`#${spec.id}::before không có icon mask`);
    if (b.querySelector("svg")) bad.push(`#${spec.id} còn svg trong nút (icon phải là mask ::before)`);
    // Nút trong dải mốc giờ / hàng tab (spec.strip, 18/10/2026, khối #strip-read): máy tính gọn 36 chữ 14/600, điện thoại tròn 44 chỉ icon
    const want = spec.strip ? (mobile ? 44 : 36) : ctl;
    if (Math.abs(h - want) > 1) bad.push(`#${spec.id} cao ${h}px, cần ${want}px`);
    if ((spec.classes.includes("src-read--icon") || (spec.strip && mobile)) && Math.abs(w - want) > 1) bad.push(`#${spec.id} rộng ${w}px, nút chỉ icon cần vuông ${want}px`);
    const fs = spec.strip ? "14px" : "16px";
    if (s.fontSize !== fs || s.fontWeight !== "600") bad.push(`#${spec.id} chữ ${s.fontSize}/${s.fontWeight}, cần ${fs}/600`);
    if (s.color !== "rgb(0, 95, 65)") bad.push(`#${spec.id} màu chữ ${s.color}, cần #005F41`);
    if (s.backgroundColor !== (all ? "rgb(255, 255, 255)" : "rgb(230, 243, 238)")) bad.push(`#${spec.id} nền ${s.backgroundColor}`);
    if (s.borderTopColor !== "rgb(95, 174, 146)") bad.push(`#${spec.id} viền ${s.borderTopColor}`);
    const r = Math.min(parseFloat(s.borderTopLeftRadius), h / 2);
    if (mobile && !spec.strip ? Math.abs(r - 12) > 1 : r < h / 2 - 1) bad.push(`#${spec.id} bo ${s.borderTopLeftRadius}`);
  }
  return bad;
}, { specs, width });

// Dòng load dưới nút đang chạy (18/10/2026, khối #hero-standard): vạch 3 px bo tròn ở ::after của nút, nằm dưới mép nút, không bị cắt hay chồng (điểm giữa vạch trỏ về chính nút);
// không có tiến độ thật (--p) → đoạn 38 % trượt qua lại; có --p (0–1) → tô theo % bề rộng nút. Trả về thông số đo được.
const barInfo = (page, id) => page.evaluate(id => {
  const b = document.getElementById(id), s = getComputedStyle(b, "::after"), r = b.getBoundingClientRect();
  const h = parseFloat(s.height) || 0, w = parseFloat(s.width) || 0, top = r.top + b.clientTop + (parseFloat(s.top) || 0), left = r.left + b.clientLeft + (parseFloat(s.left) || 0);
  const token = s.backgroundSize.split(",")[0].trim().split(" ")[0], fillOfTrack = token.endsWith("%") ? parseFloat(token) / 100 : w ? parseFloat(token) / w : NaN;
  const hit = h ? document.elementFromPoint(left + w / 2, top + h / 2) : null;
  return { content: s.content, position: s.position, height: h, track: w, btn: r.width, below: top >= r.bottom - 0.5, hit: hit === b, fillOfTrack, fill: fillOfTrack * w, animated: s.animationName !== "none", p: b.style.getPropertyValue("--p") };
}, id);
const expectBar = (info, tag, ratio) => {
  assert.equal(info.content, '""', `${tag}: không có vạch load dưới nút (::after content ${info.content})`);
  assert.equal(info.position, "absolute", `${tag}: vạch phải nằm tuyệt đối dưới nút`);
  assert.equal(info.height, 3, `${tag}: vạch cao ${info.height}px, cần 3px`);
  assert.ok(info.below, `${tag}: vạch phải nằm dưới mép nút`);
  assert.ok(info.hit, `${tag}: vạch bị cắt hoặc bị phần tử khác chồng lên`);
  assert.ok(Math.abs(info.track / info.btn - 1) <= 0.03, `${tag}: nền vạch rộng ${info.track.toFixed(1)}px, cần bằng bề rộng nút ${info.btn.toFixed(1)}px`);
  if (ratio === undefined) { assert.ok(info.animated, `${tag}: chưa có tiến độ thật thì đoạn vạch phải trượt qua lại`); assert.ok(Math.abs(info.fillOfTrack - 0.38) < 0.01, `${tag}: đoạn trượt chiếm ${(info.fillOfTrack * 100).toFixed(1)}%, cần 38%`); }
  else assert.ok(Math.abs(info.fill / info.btn - ratio) <= 0.05, `${tag}: vạch ${(info.fill / info.btn * 100).toFixed(1)}% bề rộng nút, cần ≈ ${ratio * 100}% ± 5%`);
};

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [375, 1280]) {
      // ================= Nhân viên kho: xem, không đăng nhập =================
      seed();
      let { context, page, errors } = await open(browser, width, { admin: false });
      await page.goto(BASE + "#home");
      const tile = page.locator("#barcode-uid-history");
      await tile.waitFor({ state: "visible" });
      assert.equal((await tile.innerText()).trim(), "LỊCH SỬ GROUP UID");
      assert.equal(await tile.evaluate(el => el.closest(".barcode-home__group").querySelector("h2").textContent.trim()), "Vận hành kho");
      await tile.click();
      await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => location.hash), "#group-uid-history");
      assert.equal(await tile.isVisible(), false, "trang chủ ẩn khi mở màn lịch sử");
      const total = wms.length, within30 = count(days(30));
      await page.waitForFunction(n => document.getElementById("uh-count").textContent === n, fmt(within30));
      assert.equal(await page.locator("#uh-total").innerText(), `${fmt(total)} lượt`, "dải thông tin: tổng số lượt đã lưu");
      assert.match(await page.locator("#uh-read-at").innerText(), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/, "dải thông tin: giờ đọc WMS gần nhất");
      assert.equal(await page.locator("#uh-wh-count").innerText(), "3");
      assert.equal(await page.locator("#uh-admin-tools").isVisible(), false, "người không phải Admin không thấy nút Đọc WMS");
      assert.equal(await page.locator("#uidhist-screen .ss-hero").evaluate(h => h.getClientRects().length), 0, `${width}px: người xem không thấy hero (không còn thẻ trắng rỗng)`);
      assert.equal(await adminState(page), "false");
      assert.equal(await page.locator("#uh-dialog").isVisible(), false, "danh sách nằm trong popup, chưa mở");
      assert.deepEqual(await page.locator("#uh-chips .as-tag").allInnerTexts(), ["30 ngày"], "chip bộ lọc mặc định");
      assert.equal(await page.locator("#uh-filter-count").isVisible(), false);
      const publishable = await page.evaluate(() => window.PrintSkuQueue.publishableKey);
      assert.ok(rpcCalls.length > 0 && rpcCalls.every(c => c.auth === `Bearer ${publishable}`), "xem lịch sử dùng khóa ẩn danh, không dùng phiên Admin");
      assert.deepEqual([...new Set(rpcCalls.map(c => c.name))].sort(), ["group_uid_moves_lookup", "group_uid_moves_overview"], "chỉ gọi hàm đọc");
      assert.equal(rpcCalls.find(c => c.name === "group_uid_moves_lookup").args.p_limit, 1000);

      // --- Thẻ số liệu (cùng kiểu Đồng bộ Group UID) → popup bảng ---
      const lookupRows = lookup({ p_from: new Date(since(30)).toISOString(), p_limit: 1000 }).items;
      const nowCount = lookupRows.filter(r => !r.nextLocation).length, vrCount = lookupRows.filter(r => r.to === "F0-VR-00-00-00-00").length;
      assert.equal(await page.locator("#uh-m-now").innerText(), fmt(nowCount));
      assert.equal(await page.locator("#uh-m-moved").innerText(), fmt(within30 - nowCount));
      assert.equal(await page.locator("#uh-m-vr").innerText(), fmt(vrCount));
      await page.locator('[data-uh-kind="all"]').click();
      const dialog = page.locator("#uh-dialog"), rows = page.locator("#uh-body tr");
      await dialog.waitFor({ state: "visible" });
      assert.equal(await rows.count(), 50, "50 dòng mỗi trang");
      assert.match(await page.locator("#uh-pager").innerText(), new RegExp(`Hiển thị 1–50 / ${fmt(within30).replace(".", "\\.")}`));
      const firstRow = await rows.first().innerText();
      assert.match(firstRow, /10282606\d{8}/); assert.match(firstRow, /4225\d{5}/, "có SKU ghép từ Group UID"); assert.match(firstRow, /@example\.com/, "người cập nhật hiện đầy đủ email");
      assert.match(firstRow, /Còn ở đây/, "lượt mới nhất của UID: còn ở đây");
      await page.locator('#uh-pager [data-as-page="1"]').click();
      assert.match(await page.locator("#uh-pager").innerText(), /Hiển thị 51–100/);
      await page.locator('[data-uh-tab="vr"]').click();
      assert.equal(await page.locator("#uh-d-title").innerText(), "Chuyển vào Trả NCC");
      assert.equal(await rows.count(), Math.min(50, vrCount));
      assert.equal((await page.locator("#uh-body").innerText()).includes("Trả NCC"), true, "F0-VR-00-00-00-00 hiện nhãn Trả NCC");
      await page.locator('[data-uh-tab="now"]').click();
      assert.equal((await rows.allInnerTexts()).every(t => t.includes("Còn ở đây")), true, "tab Còn ở đây");
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.locator('[data-uh-kind="moved"]').click(); await dialog.waitFor({ state: "visible" });
      assert.equal(await page.locator('[data-uh-tab="moved"]').getAttribute("aria-selected"), "true", "bấm thẻ mở đúng tab");
      assert.equal((await rows.allInnerTexts()).every(t => t.includes("Đã chuyển tiếp")), true);
      await page.locator("#uh-dialog [data-as-close]").click(); await dialog.waitFor({ state: "hidden" });

      // --- Bộ lọc (popup) ---
      const inRange = days(30), lastCall = () => rpcCalls.filter(c => c.name === "group_uid_moves_lookup").at(-1).args;
      const wait = n => page.waitForFunction(v => document.getElementById("uh-count").textContent === v, fmt(n));
      const until = async check => { for (let i = 0; i < 100 && !check(); i++) await page.waitForTimeout(50); assert.ok(check(), "chưa thấy yêu cầu tìm kiếm mong đợi"); };
      const filter = page.locator("#uh-filter"), openFilter = async () => { await page.locator("#uh-filter-open").click(); await filter.waitFor({ state: "visible" }); };
      const closeFilter = async () => { await filter.locator(".ss-primary[data-as-close]").click(); await filter.waitFor({ state: "hidden" }); };
      await page.locator("#uh-loc").fill("f0-vr"); await wait(count(r => inRange(r) && r.to_location.toLowerCase().includes("f0-vr")));
      assert.deepEqual(await page.locator("#uh-chips .as-tag").allInnerTexts(), ["30 ngày", "Đến vị trí"]);
      await openFilter();
      await page.locator('[data-uh-match="from"]').click(); await until(() => lastCall().p_match === "from"); await wait(count(r => inRange(r) && r.from_location.toLowerCase().includes("f0-vr")));
      await page.locator('[data-uh-match="any"]').click(); await until(() => lastCall().p_match === "any"); await wait(count(r => inRange(r) && (r.from_location + r.to_location).toLowerCase().includes("f0-vr")));
      await page.locator('[data-uh-match="to"]').click(); await closeFilter();
      await page.locator("#uh-loc").fill("503-02");
      await wait(count(r => inRange(r) && r.to_location.includes("503-02")));
      await page.locator("#uh-loc").fill("");
      await page.locator("#uh-sku").fill("42250001"); await wait(count(r => inRange(r) && skuOf(r.group_uid_code).includes("42250001")));
      await page.locator("#uh-view").click(); await dialog.waitFor({ state: "visible" });
      assert.equal((await page.locator("#uh-body code[data-copy]").allInnerTexts()).every(c => skuOf(c.trim()).includes("42250001")), true);
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.locator("#uh-sku").fill("");
      await openFilter();
      const khoOptions = await page.locator("#uh-wh option").allInnerTexts();
      assert.equal(khoOptions.length, 4, "Tất cả kho + 3 kho");
      assert.match(khoOptions[1], /^WH - MATERIAL - GARMENT \(\d+\)$/);
      await page.locator("#uh-wh").selectOption("WH - MATERIAL - GARMENT"); await wait(count(r => inRange(r) && r.warehouse === "WH - MATERIAL - GARMENT"));
      assert.equal(lastCall().p_warehouse, "WH - MATERIAL - GARMENT");
      await page.locator('[data-uh-range="7"]').click(); await wait(count(r => days(7)(r) && r.warehouse === "WH - MATERIAL - GARMENT"));
      await closeFilter();
      assert.deepEqual(await page.locator("#uh-chips .as-tag").allInnerTexts(), ["7 ngày", "MATERIAL - GARMENT"], "chip hiện bộ lọc đang dùng");
      assert.equal(await page.locator("#uh-filter-count").innerText(), "2", "số bộ lọc đã đổi trên nút Bộ lọc");
      await page.locator('[data-uh-kind="all"]').click(); await dialog.waitFor({ state: "visible" });
      assert.equal((await page.locator("#uh-body tr td:nth-child(2) em").allInnerTexts()).every(t => t === "MATERIAL - GARMENT"), true, "mọi dòng đúng kho đã chọn");
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.locator("#uh-chips .as-tag").first().click(); await filter.waitFor({ state: "visible" });
      await page.locator("#uh-wh").selectOption("");
      await page.locator('[data-uh-range="90"]').click(); await wait(count(days(90)));
      await page.locator('[data-uh-range="365"]').click(); await wait(total);
      assert.equal(await page.locator("#uh-dates").isVisible(), false, "ô chọn ngày chỉ hiện khi bấm biểu tượng lịch");
      await page.locator('[data-uh-range="custom"]').click();
      assert.equal(await page.locator("#uh-dates").isVisible(), true);
      await page.locator("#uh-from").fill(vnDate(NOW - 3 * DAY)); await wait(count(r => Date.parse(r.moved_at) >= Date.parse(`${vnDate(NOW - 3 * DAY)}T00:00:00+07:00`)));
      await page.locator("#uh-clear").click(); await wait(within30);
      assert.equal(await page.locator('[data-uh-range="30"]').getAttribute("aria-pressed"), "true", "Xóa bộ lọc về 30 ngày");
      await closeFilter();
      assert.equal(await page.locator("#uh-filter-count").isVisible(), false);
      await page.locator("#uh-sku").fill("big");
      await page.waitForFunction(() => /Hiển thị 0 \/ 7\.000/.test(document.getElementById("uh-message").textContent));
      await page.locator("#uh-sku").fill(""); await wait(within30);

      // --- SKU Combo: dán mã Combo thì gợi ý SKU Normal (Group UID lưu theo SKU Normal) ---
      const picker = page.locator("dialog.sku-combo-dialog"), lookups = () => rpcCalls.filter(c => c.name === "group_uid_moves_lookup");
      const setRange = async days => { await openFilter(); await page.locator(`[data-uh-range="${days}"]`).click(); await closeFilter(); };
      const calls0 = comboCalls.length;
      await page.locator("#uh-sku").fill("42250001");
      await wait(count(r => inRange(r) && skuOf(r.group_uid_code).includes("42250001")));
      assert.equal(comboCalls.length, calls0, "mã chưa đủ 9 số thì không tra Combo");
      await page.locator("#uh-sku").fill("900000035");
      await picker.waitFor({ state: "visible" });
      assert.equal(await picker.locator(".sku-combo-code").innerText(), "900000035");
      assert.equal((await picker.locator("h2").innerText()).trim(), "Chọn SKU Normal để tra cứu");
      assert.match(await picker.locator(".sku-combo-note-text").innerText(), /Group UID lưu theo SKU Normal/);
      assert.equal(await picker.locator(".sku-combo-option").count(), 1);
      assert.match(await picker.locator(".sku-combo-option").first().innerText(), /900000068/);
      await picker.locator(".sku-combo-option").first().click();
      await picker.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.getElementById("uh-sku").value === "900000068");
      await until(() => lookups().at(-1).args.p_sku === "900000068");
      await page.waitForFunction(() => /SKU Combo 900000035 → SKU Normal 900000068/.test(document.getElementById("uh-message").textContent));
      await wait(count(r => inRange(r) && skuOf(r.group_uid_code).includes("900000068")));
      // Đã chọn Normal: đổi khoảng ngày chạy lại tìm kiếm không hỏi lại
      const asked = comboCalls.length;
      await setRange(90); await wait(count(r => Date.parse(r.moved_at) >= since(90) && skuOf(r.group_uid_code).includes("900000068")));
      assert.equal(comboCalls.length, asked, "mã đã chọn không hỏi lại"); assert.equal(await picker.count(), 0);
      await setRange(30); await wait(count(r => inRange(r) && skuOf(r.group_uid_code).includes("900000068")));
      // Combo nhiều Normal: huỷ thì không tìm và tự chạy lại không hỏi lại; Enter hỏi lại rồi chọn Normal thứ hai
      await page.locator("#uh-sku").fill("900000050");
      await picker.waitFor({ state: "visible" });
      assert.equal(await picker.locator(".sku-combo-option").count(), 3, "Combo có 3 Normal");
      const searches = lookups().length;
      await picker.locator(".sku-combo-close").click(); await picker.waitFor({ state: "detached" });
      assert.equal(await page.locator("#uh-sku").inputValue(), "900000050", "huỷ giữ nguyên mã đã nhập");
      await setRange(7); await page.waitForTimeout(700);
      assert.equal(await picker.count(), 0, "đã huỷ thì tìm tự động không bật lại hộp chọn");
      assert.equal(lookups().length, searches, "huỷ thì không gửi lượt tìm");
      await page.locator("#uh-sku").press("Enter"); await picker.waitFor({ state: "visible" });
      await picker.locator(".sku-combo-option").nth(1).click(); await picker.waitFor({ state: "detached" });
      await page.waitForFunction(() => document.getElementById("uh-sku").value === "900000066");
      await dialog.waitFor({ state: "visible" }); await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await setRange(30);
      // 9 số nhưng không phải Combo: tra một lần, không hộp chọn, tìm bình thường
      await page.locator("#uh-sku").fill("900000069"); await until(() => lookups().at(-1).args.p_sku === "900000069");
      assert.equal(comboCalls.at(-1), "900000069"); assert.equal(await picker.count(), 0);
      await page.locator("#uh-sku").fill(""); await wait(within30);

      // --- Sao chép UID trong popup, quét camera (SKU / vị trí) mở thẳng kết quả ---
      await page.locator('[data-uh-kind="all"]').click(); await dialog.waitFor({ state: "visible" });
      const firstUid = (await page.locator("#uh-body code[data-copy]").first().innerText()).trim();
      await page.locator("#uh-body code[data-copy]").first().click();
      await page.waitForFunction(() => document.querySelector("#uh-body code.copied"));
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstUid);
      await page.evaluate(() => { window.__scan = []; window.PrintSkuScanUI.canOpen = () => true; window.PrintSkuScanUI.open = options => window.__scan.push(options); });
      await page.evaluate(() => { location.hash = "#home"; }); await page.waitForFunction(() => document.getElementById("uidhist-screen").hidden);
      assert.equal(await dialog.isVisible(), false, "rời màn thì popup đóng");
      await page.evaluate(() => { location.hash = "#group-uid-history"; }); await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      assert.equal(await page.locator("#uh-loc-scan").isVisible(), true, "có nút quét camera khi trình duyệt cho phép");
      await page.locator("#uh-loc-scan").click();
      const locScan = await page.evaluate(() => ({ title: window.__scan[0].title, ok: !!window.__scan[0].check("F0-VR-00-00-00-00"), okLower: !!window.__scan[0].check("f0-kho-503-02-04-01"), bad: !!window.__scan[0].check("khong phai ma vi tri") }));
      assert.deepEqual(locScan, { title: "Quét mã vị trí", ok: true, okLower: true, bad: false });
      // Gõ tay trỏ về đúng ô (typeFocus) và bấm được nút bàn phím trong khay của ô (khung quét chuẩn 18/10/2026)
      const typeTarget = i => page.evaluate(i => { const o = window.__scan[i], input = document.querySelector(o.typeFocus), kb = document.querySelector(`.scan-field__tools > button[aria-controls="${input?.id}"]`); return { id: input?.id, kb: !!kb, inField: !!input?.closest(".scan-field"), pressed: kb?.getAttribute("aria-pressed") }; }, i);
      assert.deepEqual(await typeTarget(0), { id: "uh-loc", kb: true, inField: true, pressed: "true" }, "Gõ tay về ô Vị trí");
      await page.evaluate(() => window.__scan[0].onCode("f0-vr-00-00-00-00"));
      assert.equal(await page.locator("#uh-loc").inputValue(), "F0-VR-00-00-00-00", "mã quét điền vào ô Vị trí (chữ hoa)");
      await dialog.waitFor({ state: "visible" });
      await wait(count(r => inRange(r) && r.to_location.toLowerCase().includes("f0-vr-00-00-00-00")));
      assert.equal(await page.locator("#uh-note").innerText(), `${fmt(count(r => inRange(r) && r.to_location === "F0-VR-00-00-00-00"))} dòng`, "quét xong mở thẳng popup kết quả");
      await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
      await page.locator("#uh-sku-scan").click();
      const skuScan = await page.evaluate(() => ({ title: window.__scan[1].title, ok: !!window.__scan[1].check("900000065"), bad: !!window.__scan[1].check("12345") }));
      assert.deepEqual(skuScan, { title: "Quét SKU", ok: true, bad: false });
      assert.deepEqual(await typeTarget(1), { id: "uh-sku", kb: true, inField: true, pressed: "true" }, "Gõ tay về ô SKU");
      await page.evaluate(() => window.__scan[1].onCode("900000065"));
      assert.equal(await page.locator("#uh-sku").inputValue(), "900000065");
      await dialog.waitFor({ state: "visible" }); await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();

      // ================= Admin: đăng nhập rồi đọc từ WMS =================
      db.clear(); reads.clear(); rpcCalls.length = 0;
      ({ context, page, errors } = await open(browser, width, { admin: true }));
      await page.goto(BASE + "#group-uid-history");
      await page.locator("#uidhist-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.getElementById("uh-read-at").textContent === "Chưa có dữ liệu");
      assert.equal(await page.locator("#uh-count").innerText(), "0");
      assert.equal(await page.locator('[data-uh-kind="all"]').getAttribute("data-zero"), "true", "thẻ rỗng mờ đi, bấm không mở popup");
      assert.equal(await page.locator("#uh-admin-tools").isVisible(), true, "Admin thấy nút Đọc WMS");
      assert.equal(await adminState(page), "true");
      // Khuôn nút đọc một kiểu (17/10/2026): uh-run = .src-read "Đọc WMS"; uh-full = .src-read--all chỉ icon (title nêu phạm vi); cùng một hàng; điện thoại: nút Đọc WMS giãn hết phần còn lại của hero
      assert.deepEqual(await srcReadAudit(page, [
        { id: "uh-run", strip: true, classes: ["src-read"], text: "Đọc WMS" },
        { id: "uh-full", strip: true, classes: ["src-read", "src-read--all", "src-read--icon"], text: "", aria: "Đọc lại 365 ngày", title: "Đọc lại 365 ngày" },
      ], width), [], `${width}px: nút đọc WMS một kiểu`);
      // Bố cục mới (18/10/2026, khối #strip-read): không còn thẻ hero; nhóm nút nằm trong ô đầu dải mốc giờ. Chi tiết cỡ / vị trí / chấm trạng thái: tests/strip_read_browser.cjs.
      assert.equal(await page.locator("#uh-admin-tools").evaluate(t => t.parentElement.classList.contains("as-strip__lead")), true, "nút đọc nằm trong dải mốc giờ");
      // Đang đọc khi chưa có dữ liệu: dải thông tin + thẻ số liệu hiện "—" (không "Chưa có dữ liệu", không số 0, thẻ không mờ, bấm không mở popup); đọc xong (ở đây: lỗi) mới hiện trạng thái rỗng thật
      const figures = () => page.evaluate(() => ({ text: ["uh-read-at", "uh-total", "uh-wh-count", "uh-count", "uh-m-now", "uh-m-moved", "uh-m-vr"].map(id => document.getElementById(id).textContent).join(" | "), zero: [...document.querySelectorAll("[data-uh-kind]")].map(b => b.dataset.zero).join(",") }));
      await page.evaluate(() => { window.__fail = true; window.__hold = new Promise(resolve => { window.__release = resolve; }); });
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => document.getElementById("uh-run").dataset.busy === "true");
      assert.deepEqual(await figures(), { text: "— | — | — | — | — | — | —", zero: "false,false,false,false" }, `${width}px: đang đọc không hiện trạng thái rỗng / số 0`);
      await page.locator('[data-uh-kind="all"]').click();
      assert.equal(await page.locator("#uh-dialog").evaluate(d => d.open), false, "thẻ đang chờ (—) không mở popup");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      await page.waitForFunction(() => document.getElementById("uh-message").dataset.tone === "error");
      assert.deepEqual(await figures(), { text: "Chưa có dữ liệu | 0 lượt | 0 | 0 | 0 | 0 | 0", zero: "true,true,true,true" }, `${width}px: đọc xong mới hiện trạng thái rỗng thật`);
      await page.evaluate(() => { window.__fail = false; window.__extCalls.splice(0); });
      // Đang đọc: giữ phản hồi Extension — nút vừa bấm data-busy + "Đang đọc…" (nút icon: chỉ đổi icon vòng xoay); nút kia chỉ khoá, không data-busy; đọc xong trả "Đọc WMS"
      const idleMask = await page.locator("#uh-run").evaluate(b => getComputedStyle(b, "::before").maskImage), idleFullMask = await page.locator("#uh-full").evaluate(b => getComputedStyle(b, "::before").maskImage);
      assert.equal((await barInfo(page, "uh-run")).content, "none", "rảnh: không có vạch load dưới nút");
      assert.equal(await page.locator("#uh-progress").evaluate(n => n.getClientRects().length), 0, "rảnh: thanh tiến độ rời không hiện");
      await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); window.__hold2 = new Promise(resolve => { window.__release2 = resolve; }); });
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => document.getElementById("uh-run").dataset.busy === "true");
      assert.equal((await page.locator("#uh-run").innerText()).trim(), "Đang đọc…");
      expectBar(await barInfo(page, "uh-run"), `${width}px #uh-run đang đọc (chưa có trang nào: đoạn 38 % trượt qua lại)`);
      assert.equal(await page.locator("#uh-progress").evaluate(n => n.getClientRects().length), 0, "đang đọc: thanh tiến độ rời chạy ngang màn không còn hiện");
      assert.equal((await barInfo(page, "uh-full")).content, "none", "nút icon chỉ khoá, không có vạch");
      assert.equal(await page.locator("#uh-run").isDisabled(), true, "đang đọc: nút khoá");
      assert.equal(await page.locator("#uh-run").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
      assert.notEqual(await page.locator("#uh-run").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
      assert.equal(await page.locator("#uh-full").isDisabled(), true);
      assert.notEqual(await page.locator("#uh-full").getAttribute("data-busy"), "true", "nút icon chỉ khoá khi nút kia đang đọc");
      assert.equal(await page.locator("#uh-full").evaluate(b => getComputedStyle(b, "::before").maskImage), idleFullMask, "nút icon giữ icon history");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      // Tiến độ thật theo trang (18/10/2026): 622 lượt = 2 trang, trang 2 còn bị giữ → sau trang 1/2 vạch dưới nút tô ≈ 50 % bề rộng nút (biến --p)
      await page.waitForFunction(() => document.getElementById("uh-run").style.getPropertyValue("--p") === "0.5");
      await page.waitForTimeout(400);
      expectBar(await barInfo(page, "uh-run"), `${width}px #uh-run sau trang 1/2`, 0.5);
      assert.equal(await page.locator("#uh-progress").evaluate(n => n.getClientRects().length), 0, "tiến độ thật: thanh rời vẫn không hiện");
      await page.evaluate(() => { window.__release2(); window.__hold2 = null; });
      await page.waitForFunction(() => /^Đã đọc/.test(document.getElementById("uh-message").textContent));
      await page.waitForFunction(() => document.getElementById("uh-run").dataset.busy !== "true");
      assert.equal((await page.locator("#uh-run").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn cũ");
      assert.equal((await barInfo(page, "uh-run")).content, "none", "đọc xong: vạch load mất");
      assert.equal(await page.locator("#uh-run").evaluate(b => b.style.getPropertyValue("--p")), "", "đọc xong: bỏ biến --p");
      assert.equal(db.size, wms.length, "nạp đủ mọi lượt của WMS");
      assert.match(await page.locator("#uh-message").innerText(), new RegExp(`Đã đọc ${fmt(wms.length)} lượt chuyển: ${fmt(wms.length)} mới, 0 cập nhật`));
      let calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE").map(c => c.payload));
      assert.deepEqual(calls.map(c => c.page), [1, 2], "622 lượt = 2 trang 500 dòng");
      assert.ok(calls.every(c => c.companyId === undefined), "WMS không lọc theo công ty: không truyền companyId");
      const span = (Date.parse(calls[0].to) - Date.parse(calls[0].from)) / DAY;
      assert.ok(span > 364.9 && span < 365.1, "lần đầu lấy 365 ngày");
      const adminCalls = rpcCalls.filter(c => ADMIN_ONLY.has(c.name));
      assert.ok(adminCalls.length >= 3 && adminCalls.every(c => c.auth === "Bearer test-admin-token"), "ghi dữ liệu bằng phiên Admin");
      assert.ok(rpcCalls.filter(c => c.name === "group_uid_moves_import").every(c => c.args.p_company_id === 0), "p_company_id = 0: mọi công ty");
      assert.equal(rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length, 1, "ghi mốc một lần");
      await page.waitForFunction(n => document.getElementById("uh-count").textContent === n, fmt(count(days(30))));
      assert.equal(await page.locator("#uh-total").innerText(), `${fmt(wms.length)} lượt`);
      assert.equal(await page.locator("#uh-run").isEnabled(), true);

      await page.evaluate(() => window.__extCalls.splice(0));
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => /Không có lượt chuyển mới/.test(document.getElementById("uh-message").textContent));
      calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE").map(c => c.payload));
      assert.ok(Math.abs(Date.parse(calls[0].from) - (Date.parse(adminCalls.find(c => c.name === "group_uid_moves_mark_read").args.p_to) - 30 * 60000)) < 1000, "lần sau lùi 30 phút từ mốc đã đọc");
      assert.equal(db.size, wms.length, "đọc chồng không nhân đôi");
      await page.evaluate(id => window.__wms.unshift({ history_id: id, group_uid_code: "1028260000000999", warehouse_id: 1177, warehouse: "WH - MATERIAL - MTG", action_code: 4, action_name: "Transfer location", from_location: "F0-KHO-501-01-01-01", to_location: "F0-KHO-HM-04-02-01", moved_by: "nguoidung3@example.com", moved_at: new Date().toISOString() }), 109999999);
      await page.locator("#uh-run").click();
      await page.waitForFunction(() => /1 mới, 0 cập nhật/.test(document.getElementById("uh-message").textContent));
      assert.equal(db.size, wms.length + 1);

      await page.evaluate(() => { window.__fail = true; window.__extCalls.splice(0); });
      const marks = rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length;
      // Nút icon "Đọc lại 365 ngày" đang đọc: chính nó mang data-busy (icon vòng xoay), nút Đọc WMS chỉ khoá và giữ nhãn
      await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
      await page.locator("#uh-full").click();
      await page.waitForFunction(() => document.getElementById("uh-full").dataset.busy === "true");
      assert.equal(await page.locator("#uh-full").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "nút icon: vòng xoay khi đang đọc");
      expectBar(await barInfo(page, "uh-full"), `${width}px #uh-full đang đọc (nút chỉ icon)`);
      assert.equal((await barInfo(page, "uh-run")).content, "none", "nút Đọc WMS chỉ khoá, không có vạch");
      assert.notEqual(await page.locator("#uh-full").evaluate(b => getComputedStyle(b, "::before").maskImage), idleFullMask, "nút icon: icon đổi khác lúc rảnh");
      assert.equal(await page.locator("#uh-run").isDisabled(), true);
      assert.notEqual(await page.locator("#uh-run").getAttribute("data-busy"), "true", "nút Đọc WMS chỉ khoá khi nút icon đang đọc");
      assert.equal((await page.locator("#uh-run").innerText()).trim(), "Đọc WMS", "nút Đọc WMS giữ nhãn");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      await page.waitForFunction(() => document.getElementById("uh-message").dataset.tone === "error");
      assert.notEqual(await page.locator("#uh-full").getAttribute("data-busy"), "true", "xong thì bỏ trạng thái đọc");
      assert.match(await page.locator("#uh-message").innerText(), /không còn quyền/);
      assert.equal(rpcCalls.filter(c => c.name === "group_uid_moves_mark_read").length, marks, "lần đọc lỗi không được ghi mốc");
      assert.equal(await page.locator("#uh-run").isEnabled(), true, "lỗi xong vẫn đọc lại được");
      await page.evaluate(() => { window.__fail = false; window.__extCalls.splice(0); });
      await page.locator("#uh-full").click();
      await page.waitForFunction(() => /Không có lượt chuyển mới/.test(document.getElementById("uh-message").textContent));
      const full = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_MOVES_PAGE")[0].payload);
      assert.ok((Date.parse(full.to) - Date.parse(full.from)) / DAY > 364.9, "nút đồng hồ đọc lại 365 ngày");

      // Thoát quyền Admin: nút đọc biến mất, vẫn xem được
      await page.locator("#uh-admin").click();
      const confirm = page.locator("dialog.whd"); await confirm.waitFor({ state: "visible" });
      await confirm.locator(".whd-ok").click(); await confirm.waitFor({ state: "hidden" });
      assert.equal(await page.locator("#uh-admin-tools").isVisible(), false);
      assert.equal(await adminState(page), "false");
      assert.notEqual(await page.locator("#uh-count").innerText(), "0");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("group_uid_moves_browser: ô trang chủ, xem không đăng nhập, thẻ số liệu → popup bảng (tab, trang, sao chép), popup bộ lọc + chip, SKU Combo gợi ý SKU Normal, quét camera mở kết quả, Admin đọc từ WMS tăng dần và responsive passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

async function adminState(page) { return page.locator("#uh-admin").getAttribute("aria-pressed"); }
