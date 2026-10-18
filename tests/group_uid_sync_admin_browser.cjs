// Dashboard Group UID: hai chế độ, preview, bảng thay đổi, apply và responsive.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/", SESSION_KEY = "print-sku-admin-session-v1", RUN = "33333333-3333-4333-8333-333333333333";
const changes = [
  { groupUidCode: "1028260000000050", changeType: "added", before: null, after: { sku: null, qty: 44, products: [{ sku: "900000004", quantity: 7, product_name: "Chỉ mẫu A" }, { sku: "900000007", quantity: 17 }], status: "Available", batch_code: "LOT-A1", roll_code: "R-07", warehouse: "WH - MATERIAL - MTG", location: "F0-KHO-501-01-01", updated_by: "creator@hasaki.vn", updated_date: "2026-10-08T01:00:00Z" }, changedFields: ["group_uid_code"], sourceUpdatedAt: "2026-10-08T01:00:00Z" },
  { groupUidCode: "1028260000000049", changeType: "updated", before: { qty: 3000, status: "Available", batch_code: "LOT-OLD", roll_code: "R-01", sku: "900000003", updated_by: "old@hasaki.vn" }, after: { qty: 3180, status: "Allocated", batch_code: "LOT-NEW", roll_code: "R-01", sku: "900000003", updated_by: "old@hasaki.vn" }, changedFields: ["qty", "status"], sourceUpdatedAt: "2026-10-08T01:01:00Z" },
];
const counts = { added: 1, updated: 1, unchanged: 0, missing: 0, issues: 0, totalChanges: 2 };
const warnCounts = { ...counts, missing: 3, issues: 1, skippedCanceled: 7 };
let scenario = "normal", cancelCalls = 0, ingestBodies = [], autoEnabled = true, autoBodies = [];
// Giữ phản hồi prepare của Edge để chặn được pha "đang đọc" (nút đổi nhãn, icon vòng xoay); đặt lại null để thả.
let hold = null;
// Khuôn hero (17/10/2026, khối #hero-standard): thanh lệnh gọn một hàng, h2 vẫn trong DOM nhưng ẩn kiểu sr-only (rộng ≤ 1 px),
// nút đọc nguồn một kiểu .src-read (icon mask ở ::before), nhóm ghi đẩy sang phải. Trả về danh sách điểm lệch (rỗng = đạt).
const heroAudit = (page, screenSel, specs) => page.evaluate(({ screenSel, specs }) => {
  const bad = [], hero = document.querySelector(`${screenSel} .ss-hero`), box = hero.getBoundingClientRect();
  const h2 = hero.querySelector("h2"), h2w = h2.getBoundingClientRect().width;
  if (h2w > 1) bad.push(`h2 hero rộng ${Math.round(h2w)}px, cần ≤ 1px (ẩn kiểu sr-only)`);
  if (!h2.textContent.trim()) bad.push("h2 hero không còn trong DOM");
  const buttons = [...hero.querySelectorAll("button")], tops = buttons.map(b => Math.round(b.getBoundingClientRect().top));
  if (new Set(tops).size !== 1) bad.push(`nút hero không cùng một hàng (top ${tops.join(", ")})`);
  if (box.height > 96) bad.push(`hero cao ${Math.round(box.height)}px, cần thanh lệnh gọn ≤ 96px`);
  if (buttons[0].getBoundingClientRect().left - box.left > 40) bad.push("nút đọc đầu tiên không nằm sát trái hero");
  if (box.right - buttons.at(-1).getBoundingClientRect().right > 40) bad.push("nhóm ghi không được đẩy sang phải hero");
  for (const spec of specs) {
    const b = document.getElementById(spec.id), before = getComputedStyle(b, "::before"), mask = before.maskImage || before.webkitMaskImage;
    for (const cls of spec.classes || []) if (!b.classList.contains(cls)) bad.push(`#${spec.id} thiếu lớp ${cls}`);
    if (b.innerText.trim() !== spec.text) bad.push(`#${spec.id} chữ "${b.innerText.trim()}", cần "${spec.text}"`);
    if (spec.title && b.title !== spec.title) bad.push(`#${spec.id} title "${b.title}", cần "${spec.title}"`);
    if (spec.aria && b.getAttribute("aria-label") !== spec.aria) bad.push(`#${spec.id} aria-label "${b.getAttribute("aria-label")}", cần "${spec.aria}"`);
    if (!mask || mask === "none" || before.content === "none") bad.push(`#${spec.id}::before không có icon mask`);
  }
  return bad;
}, { screenSel, specs });
const HERO_SPECS = [
  { id: "gu-run-incremental", classes: ["src-read"], text: "Đọc WMS", title: "Đọc thay đổi mới từ WMS" },
  { id: "gu-run-full", classes: ["src-read", "src-read--all"], text: "Toàn bộ", title: "Đối chiếu toàn bộ dữ liệu WMS" },
  { id: "gu-cancel", classes: ["ss-secondary"], text: "Hủy", aria: "Hủy xem trước", title: "Hủy xem trước" },
  { id: "gu-apply", classes: ["ss-primary"], text: "Cập nhật" },
];
// Dưới hero (18/10/2026, khối #hero-standard): dải mốc giờ + dải Tự động là bề mặt phẳng lùi sau hero (không bóng, nền không phải trắng thuần, ô cũ vẫn vàng);
// ô số liệu phân tầng: số 0 phẳng + chữ xám đủ tương phản (không dùng opacity), thay đổi > 0 viền/nền xanh nhạt + số đậm #005F41, cảnh báo giữ vàng, ô nguồn trung tính.
// Trả về danh sách điểm lệch (rỗng = đạt). `needAlert`: trạng thái đang xem phải có ít nhất một ô cảnh báo.
const belowHeroAudit = (page, screenSel, stripIds, needAlert) => page.evaluate(async ({ screenSel, stripIds, needAlert }) => {
  await Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
  const bad = [], rgb = c => c.match(/[\d.]+/g).map(Number), same = (a, b) => a === b;
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const effBg = el => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if ((c.length < 4 ? 1 : c[3]) > 0.99) return c; } return [255, 255, 255]; };
  const contrast = (fg, bg) => { const a = lum(rgb(fg)), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  for (const id of stripIds) {
    const strip = document.getElementById(id), s = getComputedStyle(strip);
    if (s.boxShadow !== "none") bad.push(`#${id} còn box-shadow: ${s.boxShadow}`);
    if (s.backgroundColor === "rgb(255, 255, 255)") bad.push(`#${id} nền trắng thuần, cần nền nhẹ lùi sau hero`);
    for (const cell of strip.querySelectorAll('[data-stale="true"]')) if (getComputedStyle(cell).backgroundColor !== "rgb(255, 250, 235)") bad.push(`#${id} ô cũ mất nền vàng: ${getComputedStyle(cell).backgroundColor}`);
  }
  const sel = x => [...document.querySelectorAll(`${screenSel} ${x}`)];
  const zero = sel('button.ss-metric[data-zero="true"]'), change = sel('button.ss-metric[data-zero="false"]:not([data-alert="true"])'), alert = sel('button.ss-metric[data-alert="true"]'), source = sel("div.ss-metric");
  if (!zero.length) bad.push("không có ô số 0 để kiểm");
  if (!change.length) bad.push("không có ô thay đổi > 0 để kiểm");
  if (needAlert && !alert.length) bad.push("không có ô cảnh báo để kiểm");
  if (!source.length) bad.push("không có ô nguồn để kiểm");
  const name = el => `"${el.querySelector("span").textContent.trim()}"`;
  for (const el of zero) {
    const s = getComputedStyle(el), num = getComputedStyle(el.querySelector("strong")), label = getComputedStyle(el.querySelector("span")), bg = effBg(el);
    if (s.boxShadow !== "none") bad.push(`ô 0 ${name(el)} còn box-shadow`);
    if (s.opacity !== "1" || num.opacity !== "1") bad.push(`ô 0 ${name(el)} dùng opacity ${s.opacity}/${num.opacity} (phải dùng màu xám đủ tương phản)`);
    if (contrast(num.color, bg) < 4.5) bad.push(`ô 0 ${name(el)} số ${num.color} trên nền ${bg} tương phản ${contrast(num.color, bg).toFixed(2)} < 4.5`);
    if (contrast(label.color, bg) < 4.5) bad.push(`ô 0 ${name(el)} nhãn ${label.color} trên nền ${bg} tương phản ${contrast(label.color, bg).toFixed(2)} < 4.5`);
  }
  const z = zero[0] && getComputedStyle(zero[0]), zNum = zero[0] && getComputedStyle(zero[0].querySelector("strong"));
  for (const el of change) {
    const s = getComputedStyle(el), num = getComputedStyle(el.querySelector("strong"));
    if (num.color !== "rgb(0, 95, 65)") bad.push(`ô thay đổi ${name(el)} số ${num.color}, cần #005F41`);
    if (Number(num.fontWeight) < 600) bad.push(`ô thay đổi ${name(el)} số đậm ${num.fontWeight}, cần ≥ 600`);
    if (z && same(s.borderTopColor, z.borderTopColor)) bad.push(`ô thay đổi ${name(el)} viền ${s.borderTopColor} trùng viền ô số 0`);
    if (z && same(s.backgroundColor, z.backgroundColor)) bad.push(`ô thay đổi ${name(el)} nền ${s.backgroundColor} trùng nền ô số 0`);
    if (zNum && same(num.color, zNum.color)) bad.push(`ô thay đổi ${name(el)} số cùng màu ô số 0 (${num.color})`);
    if (contrast(num.color, effBg(el)) < 4.5) bad.push(`ô thay đổi ${name(el)} số tương phản ${contrast(num.color, effBg(el)).toFixed(2)} < 4.5`);
    if (contrast(getComputedStyle(el.querySelector("span")).color, effBg(el)) < 4.5) bad.push(`ô thay đổi ${name(el)} nhãn tương phản thấp`);
  }
  for (const el of alert) if (getComputedStyle(el).backgroundColor !== "rgb(255, 250, 235)") bad.push(`ô cảnh báo ${name(el)} mất nền vàng: ${getComputedStyle(el).backgroundColor}`);
  for (const el of source) {
    const s = getComputedStyle(el), num = getComputedStyle(el.querySelector("strong"));
    if (s.boxShadow !== "none") bad.push(`ô nguồn ${name(el)} còn box-shadow`);
    if (s.backgroundColor !== "rgb(255, 255, 255)") bad.push(`ô nguồn ${name(el)} nền ${s.backgroundColor}, cần trung tính (trắng)`);
    if (num.color === "rgb(0, 95, 65)") bad.push(`ô nguồn ${name(el)} số xanh thương hiệu, cần trung tính`);
  }
  return bad;
}, { screenSel, stripIds, needAlert });
// Lưới dải không rơi ô lẻ: dải nào có từ 2 ô thì không có hàng chỉ một ô, không ô tràn khỏi dải; `oneRowId` (nếu có) phải nằm đúng một hàng (5 ô Group UID từ 1280 px).
const layoutAudit = (page, stripIds, oneRowId) => page.evaluate(({ stripIds, oneRowId }) => {
  const bad = [], rows = nodes => { const map = new Map(); for (const n of nodes) { const k = Math.round(n.getBoundingClientRect().top); map.set(k, (map.get(k) || 0) + 1); } return map; };
  for (const id of stripIds) {
    const strip = document.getElementById(id), box = strip.getBoundingClientRect(), kids = [...strip.children], map = rows(kids);
    if (kids.length > 1) for (const [top, count] of map) if (count === 1) bad.push(`#${id}: ô lẻ một mình một hàng (top ${top})`);
    for (const c of kids) if (c.getBoundingClientRect().right > box.right + 1) bad.push(`#${id}: ô tràn khỏi dải`);
    const rowRight = new Map(); for (const c of kids) { const r = c.getBoundingClientRect(), k = Math.round(r.top); rowRight.set(k, Math.max(rowRight.get(k) || 0, r.right)); }
    for (const [top, right] of rowRight) if (box.right - right > 3) bad.push(`#${id}: hàng top ${top} chưa phủ hết dải, còn trống ${Math.round(box.right - right)}px`);
    if (id === oneRowId && map.size !== 1) bad.push(`#${id}: ${kids.length} ô không nằm một hàng (${[...map].map(([top, n]) => `${n} ô ở top ${top}`).join("; ")})`);
  }
  return bad;
}, { stripIds, oneRowId });
const WHS = ["WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT", "WH - SEMI PRODUCT - MTG"];
const MANY = Array.from({ length: 120 }, (_, i) => ({ groupUidCode: `1028260000${String(i).padStart(6, "0")}`, changeType: "updated", before: { qty: 1000 + i, status: "Available", location: `A-${i}`, warehouse: WHS[i % 3] }, after: { qty: 1180 + i, status: "Allocated", location: `B-${i}`, warehouse: WHS[i % 3] }, changedFields: i % 2 ? ["qty", "status"] : ["qty", "location"], sourceUpdatedAt: new Date(Date.UTC(2026, 9, 8, 1, 0, i)).toISOString() }));
// Một dòng (i = 7) đổi cả QC: before null -> after "Passed" (trường qc_status của Group UID).
MANY[7].before.qc_status = null; MANY[7].after.qc_status = "Passed"; MANY[7].changedFields = ["qty", "status", "qc_status"];
const manyCounts = { added: 0, updated: 120, unchanged: 1880, missing: 0, issues: 0, totalChanges: 120 };

// WMS thật (đo 16/10/2026): danh sách xếp theo id giảm dần; to_updated_at chỉ có hiệu lực khi có cả from_updated_at; api-clinic tạo 1 UID/phút.
// Kịch bản (window.__guScenario): "insert" (toàn bộ) = UID mới chen lên đầu giữa lúc đọc: trang 2 tổng 4 và lặp UID cuối trang 1, đọc lại đầu danh sách thấy UID mới;
// "full-drift" = tổng WMS không bao giờ khớp số UID duy nhất; "inc-once"/"inc-always" (lấy thay đổi) = UID vừa sửa rơi khỏi khung nên trang 2 báo tổng 2 thay vì 3,
// lần đọc đầu (once) hoặc mọi lần (always).
const fakeExtension = () => addEventListener("message", event => {
  const request = event.data;
  if (!request || request.source !== "PRINT_SKU_APP") return;
  const row = (code, qty) => ({ group_uid_code: code, sku: "900000002", qty, status: "Available", updated_date: "2026-10-08T01:00:00Z" }), r = n => row("102826000000000" + n, n);
  const pageData = payload => {
    const mode = window.__guScenario || "normal";
    (window.__guReads = window.__guReads || []).push({ page: payload.page, ...(payload.from ? { from: payload.from } : {}), ...(payload.to ? { to: payload.to } : {}) });
    if (mode === "normal") return { page: 1, size: 500, total: 2, totalPages: 1, rows: [
      { group_uid_code: "1028260000000050", sku: "900000002", qty: 7429, status: "Available", updated_date: "2026-10-08T01:00:00Z" },
      { group_uid_code: "1028260000000049", sku: "900000003", qty: 3180, status: "Allocated", updated_date: "2026-10-08T01:01:00Z" },
    ] };
    if (payload.page === 1) window.__guP1 = (window.__guP1 || 0) + 1;
    if (mode === "insert") return payload.page === 2 ? { page: 2, size: 500, total: 4, totalPages: 2, rows: [r(2), r(1)] }
      : window.__guP1 === 1 ? { page: 1, size: 500, total: 3, totalPages: 2, rows: [r(3), r(2)] } : { page: 1, size: 500, total: 4, totalPages: 1, rows: [r(4), r(3)] };
    if (mode === "full-drift") return payload.page === 2 ? { page: 2, size: 500, total: 4, totalPages: 2, rows: [r(2), r(1)] } : { page: 1, size: 500, total: 5, totalPages: 2, rows: [r(3), r(2)] };
    const leaving = mode === "inc-always" || window.__guP1 === 1;
    return payload.page === 1 ? { page: 1, size: 500, total: 3, totalPages: 2, rows: [r(3), r(2)] } : { page: 2, size: 500, total: leaving ? 2 : 3, totalPages: 2, rows: [r(1)] };
  };
  const data = request.type === "PING" || request.type === "PING_WMS" ? { version: "0.4.2" } : request.type === "GET_GROUP_UID_PAGE" ? pageData(request.payload || {}) : null;
  postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok: Boolean(data), data, error: data ? null : { message: "Loại yêu cầu chưa giả lập" } }, location.origin);
});

async function mock(page) {
  await page.route("**/*", async route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/auth/v1/user")) return json({ id: "00000000-0000-4000-8000-000000000001" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Admin", role: "admin" }]);
    if (url.includes("/functions/v1/group-uid-sync")) {
      const body = JSON.parse(route.request().postData() || "{}"), ok = data => json({ ok: true, data });
      if (body.action === "history") return ok({ state: { last_successful_incremental_at: "2026-10-08T00:00:00Z", last_successful_full_at: "2026-10-07T00:00:00Z" }, runs: [{ id: "44444444-4444-4444-8444-444444444444", mode: "full", status: "failed", error_message: "Admin hủy bản xem trước", created_at: "2026-10-08T01:00:00Z", source_count: 2, change_counts: {}, range_to: "2026-10-08T01:00:00Z" }, { id: "55555555-5555-4555-8555-555555555555", mode: "incremental", status: "previewed", created_at: "2026-10-08T01:30:00Z", source: "auto", device: "may-test", autoHold: "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000", source_count: 3512, change_counts: { added: 3000, updated: 512 }, range_from: "2026-10-08T00:00:00Z", range_to: "2026-10-08T01:30:00Z" }] });
      if (body.action === "auto-config") { if (body.set && typeof body.set.enabled === "boolean") autoEnabled = body.set.enabled; autoBodies.push(body); return ok({ enabled: autoEnabled, intervalMinutes: 30, fullWindow: { start: "00:00", end: "05:00" }, thresholds: {}, updatedAt: "2026-10-08T01:00:00Z" }); }
      if (body.action === "prepare" && hold) await hold;
      if (body.action === "prepare") return ok({ runId: RUN, mode: body.mode, status: "running", rangeFrom: body.mode === "incremental" ? "2026-10-07T23:30:00Z" : null, rangeTo: "2026-10-08T02:00:00Z" });
      if (body.action === "ingest") { ingestBodies.push(body); return ok({ runId: RUN, page: body.page, pageCount: 1, totalPages: body.totalPages }); }
      if (body.action === "preview") return ok(scenario === "many" ? { runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2000, changeCounts: manyCounts, verification: { previousFullCount: 0, fullDropPercent: 0 }, changes: MANY } : scenario === "warn"
        ? { runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2, changeCounts: warnCounts, verification: { previousFullCount: 30000, fullDropPercent: 5 }, changes }
        : { runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2, changeCounts: counts, verification: { previousFullCount: 2, fullDropPercent: 0 }, changes });
      // Lượt tự động bị giữ lại (held, sync_auto_v1): detail trả status held + autoHold.
      if (body.action === "detail" && body.runId === "55555555-5555-4555-8555-555555555555") return ok({ id: body.runId, runId: body.runId, mode: "full", status: "held", autoHold: "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000", source: "auto", device: "may-test", range_to: "2026-10-08T02:00:00Z", page_count: 1, source_count: 2, change_counts: counts, changes: [], error_message: null });
      if (body.action === "detail") return ok({ id: RUN, runId: RUN, mode: "full", status: "previewed", range_to: "2026-10-08T02:00:00Z", page_count: 1, source_count: 2, change_counts: counts, changes: (scenario === "many" ? MANY : changes).filter(row => !body.changeType || row.changeType === body.changeType) });
      if (body.action === "apply") return ok({ runId: RUN, status: "completed", verification: { verified: 2, databaseCount: 28468 } });
      if (body.action === "cancel") { cancelCalls += 1; return ok({ id: RUN, status: "failed" }); }
    }
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
}

(async()=>{
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{
    for(const width of [1280,375]){
      const context=await browser.newContext({viewport:{width,height:900},permissions:["clipboard-read","clipboard-write"]});
      await context.addInitScript(key=>sessionStorage.setItem(key,JSON.stringify({access_token:"test-admin-token",refresh_token:"test-refresh-token"})),SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));await mock(page);
      await page.goto(BASE+"#admin/group-uid-sync");await page.locator("#group-uid-sync-screen").waitFor({state:"visible"});
      await page.waitForFunction(()=>document.getElementById("gu-strip-full").dataset.stale==="true");assert.match(await page.locator("#gu-last-full-rel").innerText(),/quá 24 giờ, nên chạy toàn bộ$/,"toàn bộ cũ hơn 24 giờ phải cảnh báo");assert.equal(await page.locator("#gu-strip-full").evaluate(e=>getComputedStyle(e).backgroundColor),"rgb(255, 250, 235)","thẻ toàn bộ cũ có nền vàng nhạt");
      if(width===1280)assert.deepEqual(await heroAudit(page,"#group-uid-sync-screen",HERO_SPECS),[],"khuôn hero (thanh lệnh gọn một hàng, nút .src-read)");
      // Đồng bộ tự động (17/10/2026): dải đọc auto-config; Tạm dừng gửi set.enabled=false rồi đổi chữ, Tiếp tục gửi true
      await page.locator("#gu-auto-strip").waitFor({state:"visible"});assert.match(await page.locator("#gu-auto-text").innerText(),/^Lượt gần nhất: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} · may-test$/);assert.equal(await page.locator("#gu-auto-strip").getAttribute("data-stale"),"false");
      assert.equal((await page.locator("#gu-auto-toggle").innerText()).trim(),"Tạm dừng");assert.equal(await page.locator("#gu-auto-strip svg").count(),2,"dải tự động có icon đầu dải và icon nút");
      await page.locator("#gu-auto-toggle").click();await page.waitForFunction(()=>document.getElementById("gu-auto-strip").dataset.stale==="true");assert.deepEqual(autoBodies.at(-1),{action:"auto-config",set:{enabled:false}});assert.equal((await page.locator("#gu-auto-note").innerText()).trim(),"Admin đã tạm dừng");assert.equal((await page.locator("#gu-auto-toggle").innerText()).trim(),"Tiếp tục");
      await page.locator("#gu-auto-toggle").click();await page.waitForFunction(()=>document.getElementById("gu-auto-strip").dataset.stale==="false");assert.deepEqual(autoBodies.at(-1),{action:"auto-config",set:{enabled:true}});assert.equal((await page.locator("#gu-auto-toggle").innerText()).trim(),"Tạm dừng");
      // Đang đọc: nút vừa bấm có data-busy="true", nhãn "Đang đọc…", icon đổi sang mũi tên vòng xoay; nút kia chỉ khoá, giữ nhãn
      const idleMask=await page.locator("#gu-run-full").evaluate(b=>getComputedStyle(b,"::before").maskImage);let release;hold=new Promise(resolve=>{release=resolve});
      await page.locator("#gu-run-full").click();await page.waitForFunction(()=>document.getElementById("gu-run-full").dataset.busy==="true");
      assert.equal((await page.locator("#gu-run-full").innerText()).trim(),"Đang đọc…");assert.equal(await page.locator("#gu-run-full").evaluate(b=>getComputedStyle(b,"::before").maskImage!=="none"&&getComputedStyle(b,"::before").animationName!=="none"),true,"icon vòng xoay khi đang đọc");assert.notEqual(await page.locator("#gu-run-full").evaluate(b=>getComputedStyle(b,"::before").maskImage),idleMask,"icon khác lúc rảnh");
      assert.equal(await page.locator("#gu-run-incremental").isDisabled(),true);assert.notEqual(await page.locator("#gu-run-incremental").getAttribute("data-busy"),"true");assert.equal((await page.locator("#gu-run-incremental").innerText()).trim(),"Đọc WMS");
      release();hold=null;await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      assert.notEqual(await page.locator("#gu-run-full").getAttribute("data-busy"),"true");assert.equal((await page.locator("#gu-run-full").innerText()).trim(),"Toàn bộ","đọc xong trả nhãn cũ");
      assert.deepEqual(await page.evaluate(()=>window.__guReads),[{page:1},{page:1}],"toàn bộ: không gửi from/to (WMS bỏ qua to khi thiếu from); đọc 1 trang rồi đọc lại đầu danh sách để xác nhận tổng");assert.equal(ingestBodies.length,1);assert.equal(ingestBodies[0].total,2);
      assert.equal((await page.locator("#gu-source").innerText()).trim(),"2");assert.equal((await page.locator("#gu-added").innerText()).trim(),"1");assert.equal((await page.locator("#gu-updated").innerText()).trim(),"1");assert.equal(await page.locator("#gu-apply").isEnabled(),true);
      assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),false,"xem trước xong không tự mở popup");
      if(width===1280){assert.deepEqual(await belowHeroAudit(page,"#group-uid-sync-screen",["gu-strip","gu-auto-strip"],false),[],"dưới hero: dải phẳng, ô số liệu phân tầng (0 xám phẳng, thay đổi xanh, nguồn trung tính)");assert.deepEqual(await layoutAudit(page,["gu-strip","gu-auto-strip"],"gu-strip"),[],"1280 px: dải 5 ô nằm một hàng")}
      assert.equal(await page.locator("#gu-apply").getAttribute("data-count"),"2","nút Cập nhật ghi số thay đổi");assert.equal((await page.locator("#gu-apply").innerText()).trim(),"Cập nhật","nhãn nút cố định; số thay đổi nằm ở huy hiệu (17/10/2026)");assert.equal(await page.locator("#gu-apply").evaluate(b=>getComputedStyle(b,"::after").content),'"2"',"huy hiệu ::after ghi số thay đổi");assert.equal(await page.locator('[data-gu-kind="missing"]').getAttribute("data-zero"),"true");await page.locator('[data-gu-kind="missing"]').click();await page.waitForTimeout(150);assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),false,"ô 0 dòng không mở popup");
      await page.locator('[data-gu-kind="added"]').click();await page.locator("#gu-dialog").waitFor({state:"visible"});assert.equal((await page.locator("#gu-change-title").innerText()).trim(),"UID mới");assert.equal(await page.locator("#gu-dialog .as-d-mark svg").count(),1);
      assert.match(await page.locator("#gu-change-body").innerText(),/900000004 × 7/);assert.match(await page.locator("#gu-change-body").innerText(),/creator@hasaki\.vn/,"UID mới ghi người cập nhật");
      // Bấm mã Group UID: hộp chi tiết SKU / Batch (Lot) / Roll (không còn sao chép khi bấm mã)
      await page.locator("#gu-change-body .gu-uid-open").first().click();const uidBox=page.locator("#gu-uid-dialog");await uidBox.waitFor({state:"visible"});
      assert.equal((await page.locator("#gu-uid-title").innerText()).trim(),"1028260000000050");assert.equal((await page.locator("#gu-uid-sub").innerText()).trim(),"UID mới");
      const uidText=await page.locator("#gu-uid-body").innerText();assert.match(uidText,/900000004\s*×\s*7/);assert.match(uidText,/Chỉ mẫu A/,"tên sản phẩm");assert.match(uidText,/900000007\s*×\s*17/,"UID nhiều SKU hiện đủ từng SKU");
      assert.match(uidText,/BATCH \(LOT\)\s*LOT-A1/i);assert.match(uidText,/ROLL\s*R-07/i);assert.match(uidText,/WH - MATERIAL - MTG/);assert.match(uidText,/F0-KHO-501-01-01/);assert.match(uidText,/44/);assert.match(uidText,/Available/);assert.doesNotMatch(uidText,/Trước:/,"UID mới không có bản trước");
      await page.locator("#gu-uid-copy").click();await page.waitForFunction(()=>document.getElementById("gu-uid-copy").title==="Đã sao chép");assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),"1028260000000050","nút sao chép trong hộp chi tiết");
      await page.keyboard.press("Escape");await uidBox.waitFor({state:"hidden"});assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),true,"Esc chỉ đóng hộp chi tiết UID, danh sách thay đổi vẫn mở");
      await page.locator('.as-tab[data-gu-tab="updated"]').click();await page.waitForFunction(()=>document.getElementById("gu-change-title").textContent==="UID cập nhật");assert.match(await page.locator("#gu-change-body").innerText(),/3\.000|3000/);assert.match(await page.locator("#gu-change-body").innerText(),/3\.180|3180/);assert.match(await page.locator("#gu-change-body").innerText(),/old@hasaki\.vn/,"cột Cập nhật WMS ghi người cập nhật kể cả khi người cập nhật không đổi");assert.equal(await page.locator("#gu-change-body .as-diff .as-k",{hasText:"Người cập nhật"}).count(),0,"người cập nhật không đổi thì không hiện thành dòng so sánh");assert.equal(await page.locator("#gu-change-body .as-by").count(),1);
      await page.locator("#gu-change-body .gu-uid-open").first().focus();await page.keyboard.press("Enter");await uidBox.waitFor({state:"visible"});
      const updText=await page.locator("#gu-uid-body").innerText();assert.match(updText,/BATCH \(LOT\)\s*LOT-NEW\s*Trước: LOT-OLD/i,"Lot đổi thì ghi giá trị trước");assert.match(updText,/ROLL\s*R-01/i);assert.doesNotMatch(updText,/ROLL\s*R-01\s*Trước/i,"Roll không đổi thì không ghi dòng trước");assert.match(updText,/3\.180|3180/);assert.match(updText,/Trước: 3\.000|Trước: 3000/);assert.match(updText,/Allocated/);assert.match(updText,/Trước: Available/);
      await page.keyboard.press("Escape");await uidBox.waitFor({state:"hidden"});
      await page.keyboard.press("Escape");await page.locator("#gu-dialog").waitFor({state:"hidden"});assert.equal(await page.locator("#gu-warn").isHidden(),true,"không có cảnh báo khi dữ liệu bình thường");assert.equal(await page.locator("#gu-cancel").isEnabled(),true);
      await page.locator("#gu-apply").click();const confirm=page.locator("dialog.whd");await confirm.waitFor({state:"visible"});assert.match(await confirm.locator(".whd-title").innerText(),/^Cập nhật 2 UID vào Supabase$/);assert.deepEqual(await confirm.locator(".whd-facts li").allInnerTexts(),["1 UID mới","1 UID cập nhật"]);await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Hoàn tất/.test(document.getElementById("gu-status").textContent));
      assert.equal(await page.locator("#gu-cancel").isDisabled(),true,"đã cập nhật xong thì không còn gì để hủy");assert.match(await page.locator("#gu-history").textContent(),/Đã hủy/);
      assert.equal(await page.locator("#gu-history").isVisible(),false,"lịch sử gọn: bảng chỉ mở khi bấm");assert.match(await page.locator("#gu-hist-count").innerText(),/lượt$/);await page.locator("#gu-history-btn").click();await page.locator("#gu-hist-dialog").waitFor({state:"visible"});assert.match(await page.locator("#gu-hist-note").innerText(),/lượt gần nhất$/);assert.deepEqual((await page.locator('#gu-history tr[data-gu-run="55555555-5555-4555-8555-555555555555"] .as-auto-chips .as-chip').allInnerTexts()).map(t=>t.trim()),["Tự động · may-test","Chờ Admin"]);assert.equal(await page.locator('#gu-history tr[data-gu-run="55555555-5555-4555-8555-555555555555"] .as-chip[data-tone="warn"]').getAttribute("title"),"Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000");assert.equal(await page.locator('#gu-history tr[data-gu-run="44444444-4444-4444-8444-444444444444"] .as-auto-chips').count(),0,"lượt bấm tay không có chip tự động");
      // Mở lượt held từ lịch sử: hiện lý do giữ lại + gợi ý chạy lại, nút Cập nhật khoá
      await page.locator('#gu-history tr[data-gu-run="55555555-5555-4555-8555-555555555555"]').click();if(await page.locator("#gu-hist-dialog").isVisible()){await page.keyboard.press("Escape");await page.locator("#gu-hist-dialog").waitFor({state:"hidden"})}
      await page.waitForFunction(()=>/Giữ lại \(tự động\)/.test(document.getElementById("gu-status").textContent));assert.equal((await page.locator("#gu-status").innerText()).trim(),"Giữ lại (tự động): 3.512 thay đổi vượt ngưỡng 3.000. Lượt này không cập nhật được; bấm Toàn bộ để có bản mới.");assert.equal(await page.locator("#gu-status").getAttribute("data-tone"),"warn");assert.equal(await page.locator("#gu-apply").isDisabled(),true,"lượt held không cập nhật được");assert.equal(await page.locator("#gu-cancel").isDisabled(),true);
      scenario="warn";cancelCalls=0;await page.locator("#gu-run-full").click();await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      assert.match(await page.locator("#gu-status").innerText(),/bỏ qua 7 UID Canceled quá 180 ngày/,"UID Canceled quá hạn: chỉ đếm, không nạp (group_uid_canceled_purge_v1)");
      assert.equal(await page.locator("#gu-warn").isVisible(),true);const warn=await page.locator("#gu-warn").innerText();assert.match(warn,/giảm 5%/);assert.match(warn,/3 UID thiếu trên WMS/);assert.match(warn,/1 UID có dữ liệu WMS cũ hơn database/);await page.locator('#gu-warn [data-gu-tab="missing"]').click();await page.locator("#gu-dialog").waitFor({state:"visible"});assert.equal((await page.locator("#gu-change-title").innerText()).trim(),"Thiếu trên WMS");await page.keyboard.press("Escape");await page.locator("#gu-dialog").waitFor({state:"hidden"});
      await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-cancel").click();await confirm.waitFor({state:"hidden"});assert.equal(cancelCalls,0,"Giữ lại thì không hủy");assert.equal(await page.locator("#gu-cancel").isEnabled(),true);
      await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Đã hủy bản xem trước/.test(document.getElementById("gu-status").textContent));
      assert.equal(cancelCalls,1);assert.equal(await page.locator("#gu-apply").isDisabled(),true);assert.equal(await page.locator("#gu-cancel").isDisabled(),true);assert.equal(await page.locator("#gu-warn").isHidden(),true);assert.equal((await page.locator("#gu-source").innerText()).trim(),"0");assert.match(await page.locator("#gu-change-body").innerText(),/Chưa có dữ liệu đối chiếu/);scenario="normal";
      scenario="many";await page.locator("#gu-run-full").click();await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      await page.locator('[data-gu-kind="updated"]').click();await page.locator("#gu-dialog").waitFor({state:"visible"});assert.equal(await page.locator("#gu-dialog .as-tab").count(),4);assert.match(await page.locator('#gu-dialog .as-tab[aria-selected="true"]').textContent(),/120/);
      assert.equal(await page.locator("#gu-bar i").count()>=2,true,"thanh cơ cấu có từ 2 đoạn");assert.match(await page.locator("#gu-legend").innerText(),/Không đổi/);assert.match(await page.locator("#gu-legend").innerText(),/%/);assert.equal(await page.locator(".gu-note").count(),0,"không còn câu giải thích");
      assert.equal((await page.locator("#gu-pager").innerText()).includes("Hiển thị 1–50 / 120"),true);assert.equal(await page.locator("#gu-change-body tr").count(),50);
      await page.locator('#gu-pager [data-as-page="1"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("Hiển thị 51–100 / 120"),true);
      const rowText=await page.locator("#gu-change-body tr").first().innerText();for(const part of ["Số lượng","+180"])assert.equal(rowText.includes(part),true,part);assert.equal(rowText.includes("updated_date"),false);
      await page.locator("#gu-tools input").fill("000050");assert.equal(await page.locator("#gu-change-body tr").count(),1);assert.equal((await page.locator("#gu-change-note").innerText()).trim(),"1 / 120 dòng");await page.locator("#gu-tools input").fill("");
      await page.locator('[data-as-tag="loc"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 60"),true);await page.locator('[data-as-tag="loc"]').click();
      // Tag QC: chỉ dòng đổi qc_status xuất hiện; dòng đó hiện nhãn "QC" và chip "Passed"
      assert.equal(await page.locator('[data-as-tag="qc"]').count(),1,"có tag QC");await page.locator('[data-as-tag="qc"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 1"),true,"lọc QC còn 1 dòng");
      {const qcRow=await page.locator("#gu-change-body tr").first().innerText();assert.equal(qcRow.includes("QC"),true,"dòng hiện nhãn QC");assert.equal(qcRow.includes("Passed"),true,"dòng hiện chip Passed");assert.equal(await page.locator('#gu-change-body tr .as-chip[data-tone="new"]').count()>=1,true,"Passed là chip tone new")}
      await page.locator('[data-as-tag="qc"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 120"),true,"bỏ tag QC trả về đủ 120");
      // Cột Kho + bộ lọc Kho (chọn nhiều, có số đếm), chip cũ đổi tên "Đổi kho"
      assert.deepEqual(await page.locator("#gu-change-head th").allInnerTexts(),["Group UID","Kho","Thay đổi","Cập nhật WMS"]);
      assert.equal((await page.locator("#gu-change-body tr").first().locator("td").nth(1).innerText()).includes("WH - "),true,"mỗi dòng hiện kho");
      await page.locator('[data-as-facet="wh"] .as-facet-btn').click();
      assert.equal(await page.locator(".as-facet-pop").isVisible(),true);assert.equal(await page.locator(".as-opt").count(),3);
      for(const n of await page.locator(".as-opt b").allInnerTexts())assert.equal(n.trim(),"40","mỗi kho 40 dòng");
      await page.locator('.as-opt:has-text("MATERIAL - GARMENT") input').check();
      assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 40"),true);assert.equal(await page.locator(".as-facet-pop").isVisible(),true,"chọn xong danh sách vẫn mở");
      assert.equal((await page.locator(".as-facet-btn").innerText()).includes("1"),true,"nút Kho hiện số kho đã chọn");
      await page.keyboard.press("Escape");assert.equal(await page.locator(".as-facet-pop").count(),0,"Esc đóng danh sách kho");assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),true,"Esc chỉ đóng danh sách, không đóng cửa sổ");
      assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 40"),true,"bộ lọc kho còn hiệu lực sau khi đóng");
      await page.locator('[data-as-tag="loc"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 20"),true,"kho GARMENT và đổi vị trí = 20");await page.locator('[data-as-tag="loc"]').click();
      await page.locator('[data-as-facet="wh"] .as-facet-btn').click();assert.deepEqual(await page.locator(".as-opt b").allInnerTexts(),["40","40","40"]);
      await page.locator('.as-opt:has-text("SEMI PRODUCT") input').check();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 80"),true,"chọn 2 kho = 80");
      await page.locator("[data-as-clear]").click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 120"),true,"Xóa chọn trả về đủ 120");await page.keyboard.press("Escape");
      await page.locator("#gu-tools input").fill("semi product");assert.equal((await page.locator("#gu-change-note").innerText()).trim(),"40 / 120 dòng","ô tìm tìm được cả theo tên kho");await page.locator("#gu-tools input").fill("");
            await page.locator('[data-as-sort="wms"]').click();assert.equal(await page.locator("#gu-change-head th[aria-sort=descending]").count(),1);assert.equal((await page.locator("#gu-change-body code").first().innerText()).trim().endsWith("000119"),true,"mới nhất đứng đầu");
      const [download]=await Promise.all([page.waitForEvent("download"),page.locator("#gu-tools [data-as-export]").click()]);assert.match(download.suggestedFilename(),/^group-uid-updated-.*\.xlsx$/);const book=require("./xlsx_read.cjs").readXlsx(require("node:fs").readFileSync(await download.path()));assert.equal(book.table.length,121,"tiêu đề + 120 dòng");assert.equal(book.table[0].includes("Kho"),true,"Excel có cột Kho");assert.equal(book.table[0].includes("Người cập nhật"),true);assert.equal(JSON.stringify(book.table).includes("WH - SEMI PRODUCT - MTG"),true);assert.match(book.table[1][0],/^\d{16}$/,"Group UID là chữ 16 số, không thành số khoa học");
      await page.keyboard.press("Escape");await page.locator("#gu-dialog").waitFor({state:"hidden"});
      await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Đã hủy bản xem trước/.test(document.getElementById("gu-status").textContent));scenario="normal";
      // WMS đổi dữ liệu giữa lúc đọc. Toàn bộ: UID mới chen lên đầu chỉ làm lặp, đọc lại đầu danh sách cho đủ, KHÔNG đọc lại cả lượt; tổng không bao giờ khớp thì dừng sau 3 lượt
      const cancelPreview=async()=>{await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Đã hủy bản xem trước/.test(document.getElementById("gu-status").textContent))};
      const scenarioRun=async(name,button)=>{cancelCalls=0;ingestBodies=[];await page.evaluate(n=>{window.__guScenario=n;window.__guReads=[];window.__guP1=0},name);await page.locator(button).click()};
      const reads=()=>page.evaluate(()=>window.__guReads),done=()=>page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent)),stopped=()=>page.waitForFunction(()=>/phiên đã dừng để tránh thiếu UID/.test(document.getElementById("gu-status").textContent));
      scenario="normal";
      await scenarioRun("insert","#gu-run-full");await done();
      assert.deepEqual(ingestBodies.map(b=>[b.page,b.totalPages,b.total,b.rows.length]),[[1,1,4,4]],"4 UID duy nhất (lặp bị gộp, UID mới ở đầu danh sách được thêm), tổng 4");assert.deepEqual((await reads()).map(x=>x.page),[1,2,1],"đọc trang 1, 2 rồi đọc lại đầu danh sách");assert.equal(cancelCalls,0);await cancelPreview();
      await scenarioRun("full-drift","#gu-run-full");await stopped();
      assert.match(await page.locator("#gu-status").innerText(),/WMS đổi dữ liệu trong lúc đọc [(]tổng 5 → 4 · 3 UID duy nhất[)]; phiên đã dừng để tránh thiếu UID/);assert.equal(ingestBodies.length,0,"không khớp thì không gửi gì lên Supabase");assert.equal(cancelCalls,1,"phiên bị hủy");assert.equal((await reads()).length,21,"3 lượt x (2 trang + 5 lần đọc lại đầu danh sách)");assert.equal(await page.locator("#gu-apply").isDisabled(),true);
      // Lấy thay đổi: khung from–to (đóng băng UID mới), kiểm tổng mọi trang, lệch thì đọc lại với mốc to mới
      await scenarioRun("normal","#gu-run-incremental");await done();
      assert.deepEqual(await reads(),[{page:1,from:"2026-10-07T23:30:00Z",to:"2026-10-08T02:00:00Z"}]);assert.deepEqual(ingestBodies.map(b=>[b.page,b.total,b.rows.length]),[[1,2,2]]);await cancelPreview();
      await scenarioRun("inc-once","#gu-run-incremental");await done();
      const incReads=await reads();assert.equal(incReads.length,4,"2 trang x 2 lượt đọc");assert.equal(incReads[0].to,"2026-10-08T02:00:00Z");assert.notEqual(incReads[2].to,"2026-10-08T02:00:00Z","đọc lại dùng mốc to mới");assert.equal(incReads[2].from,"2026-10-07T23:30:00Z");
      assert.deepEqual(ingestBodies.map(b=>[b.page,b.total,b.rows.length]),[[1,3,3]],"chỉ đưa lên bản nhất quán: 3 UID, tổng 3");assert.equal(cancelCalls,0);await cancelPreview();
      await scenarioRun("inc-always","#gu-run-incremental");await stopped();
      assert.match(await page.locator("#gu-status").innerText(),/WMS đổi dữ liệu trong lúc đọc [(]tổng 3 → 2 · 3 UID duy nhất[)]/);assert.equal(ingestBodies.length,0);assert.equal(cancelCalls,1);assert.equal((await reads()).length,6,"3 lượt x 2 trang");
      await page.evaluate(()=>{window.__guScenario="normal"});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}px: Group UID full/preview/detail/apply, cảnh báo, hủy xem trước, responsive`);
    }
    // 1024 → 1440 px (Admin chỉ xét máy tính; 1024 hẹp nhất còn thanh trái 264): hero vẫn một hàng; sau khi đọc có kết quả: dải phẳng, ô số liệu phân tầng,
    // dải mốc 5 ô không có ô lẻ một mình một hàng ở 1024–1279 px (trước khối #hero-standard: 4 + 1 ở 1100 px) và nằm một hàng từ 1280 px.
    for(const width of [1024,1100,1199,1440]){
      const context=await browser.newContext({viewport:{width,height:800}});
      await context.addInitScript(key=>sessionStorage.setItem(key,JSON.stringify({access_token:"test-admin-token",refresh_token:"test-refresh-token"})),SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page=await context.newPage();await mock(page);
      await page.goto(BASE+"#admin/group-uid-sync");await page.locator("#group-uid-sync-screen").waitFor({state:"visible"});
      await page.waitForFunction(()=>document.getElementById("gu-strip-full").dataset.stale==="true");
      assert.deepEqual(await heroAudit(page,"#group-uid-sync-screen",HERO_SPECS),[],`hero ${width} px một hàng`);
      assert.deepEqual(await layoutAudit(page,["gu-strip","gu-auto-strip"],width>=1280?"gu-strip":null),[],`${width} px: dải 5 ô không ô lẻ`);
      await page.locator("#gu-run-full").click();await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      assert.deepEqual(await belowHeroAudit(page,"#group-uid-sync-screen",["gu-strip","gu-auto-strip"],false),[],`${width} px dưới hero: dải phẳng, ô số liệu phân tầng`);
      assert.deepEqual(await layoutAudit(page,["gu-strip","gu-auto-strip"],width>=1280?"gu-strip":null),[],`${width} px sau khi đọc: dải 5 ô không ô lẻ`);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"không tràn ngang");
      await context.close();console.log(`PASS ${width}px: hero một hàng, dải phẳng, ô số liệu phân tầng, dải 5 ô không ô lẻ, không tràn ngang`);
    }
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
