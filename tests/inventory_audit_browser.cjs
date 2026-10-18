// KIỂM KÊ SKU (ô trang chủ, #inventory-audit): mọi người xem bản chụp đã lưu, chỉ Admin đồng bộ từ WMS.
// Chạy với python -m http.server 8000; WMS/Extension/Supabase đều giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const DAY = 86400000;
// Bốn thẻ số liệu (SKU có tồn kho / Chưa kiểm kê / Quá 30 ngày / Trong 30 ngày): nền, viền, màu số — chờ chuyển màu xong mới đo
const cardTones = page => page.evaluate(() => Promise.all([...document.querySelectorAll("#inventory-audit-screen .ia-metrics .ss-metric")].map(async card => {
  await Promise.all(card.getAnimations().map(a => a.finished.catch(() => {})));
  const s = getComputedStyle(card);
  return { bg: s.backgroundColor, border: s.borderTopColor, ink: getComputedStyle(card.querySelector("strong")).color };
})));
const RED = "rgb(165, 55, 48)", AMBER = "rgb(139, 97, 0)";

const mockExtension = () => addEventListener("message", async event => {
  const r = event.data;
  if (!r || r.source !== "PRINT_SKU_APP") return;
  if (window.__hold && r.type === "GET_SKU_COUNT_WAREHOUSES") await window.__hold; // giữ phản hồi để chặn được pha "đang đọc"
  if (window.__hold2 && /^GET_SKU_COUNT_(APPROVED|INVENTORY)_PAGE$/.test(r.type) && r.payload.page === 2) await window.__hold2; // giữ trang 2 để đo tiến độ sau trang 1 (window.__two = mỗi lần đọc có 2 trang)
  const more = r.payload && r.payload.page > 1; // trang 2 (chỉ khi window.__two) không có dòng nào thêm
  let data;
  if (r.type === "PING_WMS") data = { version: "0.6.1" };
  else if (r.type === "GET_SKU_COUNT_WAREHOUSES") data = { warehouses: [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty Mastige" },
    { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyId: 1005, companyName: "Cty Garment" },
  ], missingNames: [] };
  else if (r.type === "GET_SKU_COUNT_APPROVED_PAGE") data = { page: more ? 2 : 1, size: 500, total: 2, totalPages: window.__two ? 2 : 1, rows: more ? [] : r.payload.warehouseIds[0] === 1177 ? [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-RECENT", productName: "Vải gần đây", approvedAt: new Date(Date.now() - 10 * 86400000).toISOString(), approvedBy: "manager@hasaki.vn" },
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-OLD", productName: "Vải cũ", approvedAt: new Date(Date.now() - 45 * 86400000).toISOString(), approvedBy: "manager@hasaki.vn" },
  ] : [] };
  else if (r.type === "GET_SKU_COUNT_INVENTORY_PAGE") data = { page: more ? 2 : 1, size: 500, total: r.payload.warehouseIds[0] === 1177 ? 2 : 1, totalPages: window.__two ? 2 : 1, rows: more ? [] : r.payload.warehouseIds[0] === 1177 ? [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-RECENT", productName: "Vải gần đây", location: "A-01", qty: 5, uom: "m" },
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-OLD", productName: "Vải cũ", location: "A-02", qty: 3, uom: "m" },
  ] : [{ warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", sku: "SKU-NEVER", productName: "Chỉ chưa kiểm", location: "G-01", qty: 2, uom: "cuộn" }] };
  else data = {};
  postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok: true, data }, location.origin);
});

// Bản chụp đã lưu sẵn trên "máy chủ" giả: đủ ba tình trạng. Phân nhóm tính lúc xem nên dùng ngày tương đối.
const seededSnapshot = () => ({
  run: { id: "run-1", readAt: new Date(Date.now() - 3 * 3600000).toISOString(), thresholdDays: 30, rowCount: 3, missing: [], sourceCounts: {},
    warehouses: [{ warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyName: "Cty Mastige" }, { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyName: "Cty Garment" }] },
  rows: [
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-RECENT", productName: "Vải gần đây", qty: 5, uom: "m", locations: [{ location: "A-01", qty: 5 }], lastApprovedAt: new Date(Date.now() - 10 * DAY).toISOString(), lastApprovedBy: "manager@hasaki.vn" },
    { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "SKU-OLD", productName: "Vải cũ", qty: 3, uom: "m", locations: [{ location: "A-02", qty: 3 }], lastApprovedAt: new Date(Date.now() - 45 * DAY).toISOString(), lastApprovedBy: "manager@hasaki.vn" },
    { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", sku: "SKU-NEVER", productName: "Chỉ chưa kiểm", qty: 2, uom: "cuộn", locations: [{ location: "G-01", qty: 2 }], lastApprovedAt: null, lastApprovedBy: null },
  ],
});

// Máy chủ giả có trạng thái: lưu lượt đồng bộ (start → chunk → finish) và trả lại qua sku_count_overview.
const makeBackend = (initial = null) => {
  const state = { snapshot: initial, pending: null, calls: [] };
  const handle = (route, isAdmin) => {
    const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    if (!rpc) return json(url.includes("/rest/v1/") ? [] : { ok: true, data: [] });
    const body = JSON.parse(route.request().postData() || "{}"), bearer = route.request().headers().authorization || "";
    state.calls.push({ rpc, body, admin: /test-admin-token/.test(bearer) });
    if (rpc === "sku_count_overview") return json({ ok: true, data: state.snapshot || { run: null, rows: [] } });
    if (rpc.startsWith("sku_count_save_") && !/test-admin-token/.test(bearer)) return json({ ok: false, error: { code: "FORBIDDEN", message: "Chỉ Admin được đồng bộ kiểm kê" } });
    if (rpc === "sku_count_save_start") { state.pending = { meta: body, rows: [] }; return json({ ok: true, data: { runId: "run-new" } }); }
    if (rpc === "sku_count_save_chunk") { assert.ok(body.p_rows.length >= 1 && body.p_rows.length <= 500, "mỗi đợt ghi 1–500 dòng"); state.pending.rows.push(...body.p_rows); return json({ ok: true, data: { saved: body.p_rows.length } }); }
    if (rpc === "sku_count_save_finish") {
      const p = state.pending; state.pending = null;
      state.snapshot = { run: { id: "run-new", readAt: new Date().toISOString(), thresholdDays: 30, rowCount: p.rows.length, missing: p.meta.p_missing, sourceCounts: p.meta.p_source_counts, warehouses: p.meta.p_warehouses },
        rows: p.rows.map(r => ({ warehouseId: r.warehouse_id, warehouseName: r.warehouse_name, sku: r.sku, productName: r.product_name || "", qty: r.qty, uom: r.uom || "", locations: r.locations, lastApprovedAt: r.last_approved_at, lastApprovedBy: r.last_approved_by })) };
      return json({ ok: true, data: { runId: "run-new", rowCount: p.rows.length } });
    }
    return json({ ok: true, data: [] });
  };
  return { state, handle };
};

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
    // ---- 1) Người xem (chưa đăng nhập Admin): xem bản chụp, không có công cụ đồng bộ ----
    for (const width of [1280, 375]) {
      const backend = makeBackend(seededSnapshot());
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(mockExtension);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.getElementById("ia-total").textContent === "3");
      assert.equal(await page.locator("#ia-never").innerText(), "1");
      assert.equal(await page.locator("#ia-recent").innerText(), "1");
      assert.equal(await page.locator("#ia-overdue").innerText(), "1");
      const tones = await cardTones(page);
      assert.ok(tones[1].ink === RED && tones[1].bg !== tones[0].bg, `${width}px: Chưa kiểm kê > 0 tô đỏ`);
      assert.ok(tones[2].ink === AMBER && tones[2].bg !== tones[0].bg, `${width}px: Quá 30 ngày > 0 tô vàng`);
      // Thẻ không còn chú thích giải thích (18/10/2026): câu cũ nằm ở title của thẻ; chỉ thẻ đầu còn dòng nhỏ mang số liệu ("N đơn vị In-BIN")
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#inventory-audit-screen .ia-metrics .ss-metric")].map(c => [...c.querySelectorAll("small")].map(s => s.id || "(không id)").join("|"))), ["ia-total-qty", "", "", ""], `${width}px: chỉ thẻ đầu còn dòng nhỏ (số liệu), ba thẻ kia không có dòng nhỏ`);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#inventory-audit-screen .ia-metrics .ss-metric")].map(c => c.title)), ["In-BIN > 0", "Không có lần APPROVED", "Lần gần nhất > 30 ngày", "Lần gần nhất ≤ 30 ngày"], `${width}px: câu giải thích chuyển vào title của thẻ`);
      assert.equal(await page.locator("#ia-total-qty").innerText(), "10 đơn vị In-BIN", `${width}px: dòng nhỏ mang số liệu vẫn còn`);
      assert.equal(await page.locator("#ia-admin-tools").isHidden(), true, "người xem không có nút đồng bộ WMS");
      assert.equal(await page.locator("#inventory-audit-screen .ss-hero").evaluate(h => h.getClientRects().length), 0, `${width}px: người xem không thấy hero (không còn thẻ trắng rỗng)`);
      assert.equal(await page.locator("#ia-admin").getAttribute("aria-pressed"), "false");
      // App In SKU (#root) luôn chạy nền, hỏi print_queue_status lúc tải và mỗi 15 giây ở mọi màn — chỉ đọc, không thuộc Kiểm kê.
      const reads = backend.state.calls.filter(c => c.rpc !== "print_queue_status");
      assert.deepEqual(reads.map(c => c.rpc), ["sku_count_overview"], "người xem chỉ đọc bản chụp, không gọi Extension hay ghi");
      assert.equal(reads[0].admin, false, "đọc bằng khoá công khai");
      assert.equal(await page.locator("#ia-body tr").count(), 2, "mặc định chỉ hiện SKU cần kiểm kê");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      if (width === 1280) {
        const rows = () => page.locator("#ia-body tr[data-ia-key]"), skus = () => page.locator("#ia-body tr[data-ia-key] code").allInnerTexts();
        assert.deepEqual(await skus(), ["SKU-NEVER", "SKU-OLD"], "chưa kiểm kê đứng trước, rồi đến quá hạn");
        assert.deepEqual(await page.evaluate(() => ["action", "never", "overdue", "recent", "all"].map(k => document.getElementById(`ia-count-${k}`).textContent)), ["2", "1", "1", "1", "3"]);
        assert.equal(await page.locator("#ia-head th").count(), 7, "7 cột");
        assert.equal(await page.locator(".ia-table").evaluate(t => t.parentElement.scrollWidth <= t.parentElement.clientWidth), true, "bảng vừa khung, không cuộn ngang");
        await page.locator('[data-ia-tab="all"]').click();
        assert.equal(await rows().count(), 3);
        await page.locator('button.ss-metric[data-ia-status="recent"]').click();
        assert.deepEqual(await skus(), ["SKU-RECENT"], "bấm thẻ Trong 30 ngày lọc đúng nhóm");
        await page.locator('[data-ia-tab="all"]').click();
        await page.locator("#ia-tools input").fill("vai cu");
        assert.deepEqual(await skus(), ["SKU-OLD"], "tìm không dấu theo tên sản phẩm");
        await page.locator("#ia-tools input").fill("");
        await page.locator('[data-as-sort="qty"]').click();
        assert.deepEqual(await skus(), ["SKU-RECENT", "SKU-OLD", "SKU-NEVER"], "bấm Tồn lần đầu sắp giảm dần");
        await rows().first().click();
        assert.equal(await page.locator("#ia-dialog").evaluate(d => d.open), true, "bấm dòng mở chi tiết");
        assert.equal(await page.locator("#ia-d-title").innerText(), "SKU-RECENT");
        assert.equal((await page.locator("#ia-d-locs").innerText()).includes("A-01"), true);
        await page.keyboard.press("Escape");
        const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#ia-tools [data-as-export]").click()]);
        assert.match(download.suggestedFilename(), /^kiem-ke-sku-.*\.xlsx$/);
        // Mốc 30 ngày tính lúc xem: đổi giờ máy lên 20 ngày thì SKU-RECENT (10 ngày) thành quá hạn mà không cần đồng bộ lại
        await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 21 * 86400000; });
        await page.evaluate(() => window.HasakiInventoryAuditDashboard.load());
        assert.equal(await page.locator("#ia-recent").innerText(), "0", "phân nhóm theo giờ lúc xem");
        assert.equal(await page.locator("#ia-overdue").innerText(), "2");
      } else {
        assert.equal(await page.locator(".ia-table thead").isVisible(), false, "điện thoại: bảng thành thẻ, không có hàng tiêu đề");
        const box = await page.locator("#ia-body tr[data-ia-key]").first().boundingBox();
        assert.ok(box && box.width <= 375, "thẻ nằm trong khung điện thoại");
        assert.equal(await page.locator("#ia-admin").isVisible(), true, "nút đăng nhập Admin ở thanh trên");
      }
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 2) Chưa có bản đồng bộ nào ----
    {
      const backend = makeBackend(null), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.waitForFunction(() => /Chưa có bản đồng bộ/.test(document.getElementById("ia-status").textContent));
      assert.equal(await page.locator("#ia-total").innerText(), "—");
      assert.equal(await page.locator("#ia-total-qty").textContent(), "", "chưa có bản chụp: không hiện câu giải thích \"In-BIN > 0\"");
      assert.equal(await page.locator("#ia-total-qty").evaluate(s => s.getClientRects().length), 0, "chưa có bản chụp: dòng nhỏ trống không chiếm chỗ");
      // Chưa có bản chụp: bốn thẻ trung tính như thẻ SKU có tồn kho (nền, viền), số không đỏ/vàng — chỉ tô khi đã có dữ liệu và số > 0
      const tones = await cardTones(page);
      assert.deepEqual(tones.map(t => `${t.bg} / ${t.border}`), Array(4).fill(`${tones[0].bg} / ${tones[0].border}`), "chưa có bản chụp: bốn thẻ cùng nền/viền trung tính");
      assert.deepEqual(tones.filter(t => t.ink === RED || t.ink === AMBER), [], "chưa có bản chụp: số không tô đỏ/vàng");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---- 3) Đường dẫn cũ #admin/kiem-ke chuyển sang màn mới ngay từ đầu trang, không bật hộp đăng nhập Admin ----
    {
      const backend = makeBackend(seededSnapshot()), context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await context.newPage();
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#admin/kiem-ke");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => location.hash), "#inventory-audit");
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains("admin-auth-lock")), false, "không khoá trang chờ đăng nhập Admin");
      await context.close();
    }

    // ---- 4) Admin: đọc WMS rồi lưu bản chụp; người xem sau đó thấy đúng bản đó ----
    for (const width of [1280, 375]) {
      const backend = makeBackend(null), context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
      await context.addInitScript(mockExtension);
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", route => route.request().url().startsWith(BASE) ? route.continue() : backend.handle(route));
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#inventory-audit-screen").waitFor({ state: "visible" });
      await page.locator("#ia-admin-tools").waitFor({ state: "visible" });
      assert.equal(await page.locator("#ia-admin").getAttribute("aria-pressed"), "true");
      await page.waitForFunction(() => /WMS sẵn sàng/.test(document.getElementById("ia-connection").textContent));
      // Khuôn nút đọc một kiểu (17/10/2026): .src-read, nhãn "Đọc WMS", icon mask; máy tính: trạng thái Extension bên trái nút trên cùng một hàng; điện thoại: nút rộng hết hero, cột đảo như cũ
      assert.deepEqual(await srcReadAudit(page, [{ id: "ia-run", strip: true, classes: ["src-read"], text: "Đọc WMS" }], width), [], `${width}px: nút đọc WMS một kiểu`);
      // Bố cục mới (18/10/2026, khối #strip-read): không còn thẻ hero; nhóm nút nằm trong ô đầu dải mốc giờ. Chi tiết cỡ / vị trí / chấm trạng thái: tests/strip_read_browser.cjs.
      assert.equal(await page.locator("#ia-admin-tools").evaluate(t => t.parentElement.classList.contains("as-strip__lead")), true, "nút đọc nằm trong dải mốc giờ");
      // Đang đọc: giữ phản hồi Extension để chặn pha bận — data-busy, nhãn "Đang đọc…", icon đổi sang vòng xoay (động); đọc xong trả "Đọc WMS"
      const idleMask = await page.locator("#ia-run").evaluate(b => getComputedStyle(b, "::before").maskImage);
      assert.equal((await barInfo(page, "ia-run")).content, "none", "rảnh: không có vạch load dưới nút");
      assert.equal(await page.locator("#ia-progress").evaluate(n => n.getClientRects().length), 0, "rảnh: thanh tiến độ rời không hiện");
      await page.evaluate(() => { window.__hold = new Promise(resolve => { window.__release = resolve; }); });
      await page.locator("#ia-run").click();
      await page.waitForFunction(() => document.getElementById("ia-run").dataset.busy === "true");
      assert.equal((await page.locator("#ia-run").innerText()).trim(), "Đang đọc…");
      assert.equal(await page.locator("#ia-run").isDisabled(), true, "đang đọc: nút khoá");
      assert.equal(await page.locator("#ia-run").evaluate(b => getComputedStyle(b, "::before").animationName !== "none"), true, "icon vòng xoay khi đang đọc");
      assert.notEqual(await page.locator("#ia-run").evaluate(b => getComputedStyle(b, "::before").maskImage), idleMask, "icon đổi khác lúc rảnh");
      expectBar(await barInfo(page, "ia-run"), `${width}px #ia-run đang đọc (chưa có trang nào: đoạn 38 % trượt qua lại)`);
      assert.equal(await page.locator("#ia-progress").evaluate(n => n.getClientRects().length), 0, "đang đọc: thanh tiến độ rời chạy ngang màn không còn hiện");
      await page.evaluate(() => { window.__release(); window.__hold = null; });
      await page.waitForFunction(() => document.getElementById("ia-total").textContent === "3");
      await page.waitForFunction(() => document.getElementById("ia-run").dataset.busy !== "true");
      assert.equal((await page.locator("#ia-run").innerText()).trim(), "Đọc WMS", "đọc xong trả nhãn cũ");
      assert.equal((await barInfo(page, "ia-run")).content, "none", "đọc xong: vạch load mất");
      assert.match(await page.locator("#ia-status").innerText(), /Đã đồng bộ.*MTG.*Garment/);
      assert.deepEqual(backend.state.calls.filter(c => c.rpc.startsWith("sku_count_")).map(c => c.rpc),
        ["sku_count_overview", "sku_count_save_start", "sku_count_save_chunk", "sku_count_save_finish", "sku_count_overview"], "đọc → bắt đầu → ghi → chốt → đọc lại");
      assert.equal(backend.state.calls.find(c => c.rpc === "sku_count_save_start").admin, true, "ghi bằng phiên Admin");
      assert.equal(backend.state.calls.filter(c => c.rpc.startsWith("sku_count_")).at(-1).admin, false, "đọc lại bằng khoá công khai như mọi người");
      const saved = backend.state.snapshot.rows;
      assert.deepEqual(saved.map(r => r.sku).sort(), ["SKU-NEVER", "SKU-OLD", "SKU-RECENT"]);
      assert.equal(saved.find(r => r.sku === "SKU-NEVER").lastApprovedAt, null, "chưa kiểm kê lưu ngày rỗng");
      assert.equal(typeof saved.find(r => r.sku === "SKU-OLD").qty, "number");
      assert.equal(await page.locator("#ia-run").isDisabled(), false, "nút dùng lại được sau khi xong");
      // Tiến độ thật theo trang (18/10/2026): mỗi lần đọc 2 trang, trang 2 bị giữ → sau trang 1/2 vạch dưới nút tô ≈ 50 % bề rộng nút (biến --p); đọc xong thì vạch mất
      await page.evaluate(() => { window.__two = true; window.__hold2 = new Promise(resolve => { window.__release2 = resolve; }); });
      await page.locator("#ia-run").click();
      await page.waitForFunction(() => document.getElementById("ia-run").style.getPropertyValue("--p") === "0.5");
      await page.waitForTimeout(400);
      expectBar(await barInfo(page, "ia-run"), `${width}px #ia-run sau trang 1/2`, 0.5);
      assert.equal(await page.locator("#ia-progress").evaluate(n => n.getClientRects().length), 0, "tiến độ thật: thanh rời vẫn không hiện");
      await page.evaluate(() => { window.__release2(); window.__hold2 = null; });
      await page.waitForFunction(() => document.getElementById("ia-run").dataset.busy !== "true");
      await page.evaluate(() => { window.__two = false; });
      assert.equal((await barInfo(page, "ia-run")).content, "none", "đọc xong: vạch load mất");
      assert.equal(await page.locator("#ia-run").evaluate(b => b.style.getPropertyValue("--p")), "", "đọc xong: bỏ biến --p");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}px không được tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("inventory_audit_browser: người xem + Admin đồng bộ, bản chụp lưu qua Supabase giả, mốc 30 ngày tính lúc xem, đường dẫn cũ, thẻ trên điện thoại, lọc/sắp xếp/chi tiết/Excel passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
