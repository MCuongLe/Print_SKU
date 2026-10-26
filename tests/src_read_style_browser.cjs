// Nút đọc dữ liệu nguồn (Inside / WMS) MỘT KIỂU: 14 nút `.src-read` thường (không `--all`, không `--icon`) ở 12 màn / hộp khác nhau phải có cùng nền, màu chữ,
// viền, bo, cỡ + đậm chữ, icon mask ::before và cùng độ cao (= --ui-ctl, và bằng ô nhập / nút cùng hàng). Khuôn ở khối <style id="hero-standard"> (17/10/2026).
// Chạy với python -m http.server 8000 (hoặc cổng khác + BASE=http://127.0.0.1:<cổng>/); Admin, Extension và Supabase đều giả lập, không đụng dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";

// Mỗi mục: màn (hash) + việc cần làm để nút hiện + id nút + id nút/ô cùng hàng (mate) phải cao bằng.
const SCREENS = [
  { name: "Đồng bộ SKU", hash: "#admin/sku-sync", wait: "#sku-sync-screen", id: "sku-sync-preview" },
  { name: "Đồng bộ Group UID", hash: "#admin/group-uid-sync", wait: "#group-uid-sync-screen", id: "gu-run-incremental" },
  { name: "Kiểm kê SKU", hash: "#inventory-audit", wait: "#inventory-audit-screen", id: "ia-run", strip: true },
  { name: "Rủi ro lưu trữ · Hàng chưa lên kệ", hash: "#storage-risk", wait: "#storage-risk-screen", id: "sr-run", strip: true },
  { name: "Rủi ro lưu trữ · UID tạm", hash: "#storage-risk", wait: "#storage-risk-screen", tab: "temp", id: "srt-run", strip: true },
  { name: "Kiểm soát công trình", hash: "#site-control", wait: "#site-control-screen", id: "sc-run", strip: true },
  { name: "Lịch sử Group UID", hash: "#group-uid-history", wait: "#uidhist-screen", id: "uh-run", strip: true },
  { name: "IN TEM GROUP UID · Thêm Group UID", hash: "#group-uid", wait: "#uid-screen", id: "uid-wms-open", mate: "uid-import" },
  { name: "IN TEM GROUP UID · Gán WMS", hash: "#group-uid", wait: "#uid-screen", prep: async page => { await page.locator("#uid-tab-po").click(); }, id: "uid-po-go", mate: "uid-po-input" },
  { name: "IN TEM SKU · Phiếu IT", hash: "#worker", wait: "#f-sku", prep: async page => { await page.evaluate(() => document.getElementById("sku-it").showModal()); }, id: "sku-it-load", mate: "sku-it-input" },
  { name: "CẮT GROUP UID · Đối chiếu ADJ", hash: "#cut-group-uid", wait: "#cut-group-uid-screen:not([hidden])", prep: async page => { await page.locator("#cut-tab-adj").click(); }, id: "cut-adj-wms", mate: "cut-adj-upload" },
  { name: "CẮT GROUP UID · Theo PO", hash: "#cut-group-uid", wait: "#cut-group-uid-screen:not([hidden])", admin: "stub", id: "cs-po-go", mate: "cs-po",
    prep: async page => { await page.locator("#cs-mode-po").click(); await page.locator("#cs-manage").waitFor({ state: "visible" }); await page.locator("#cs-manage").click(); await page.waitForSelector("#cs-plans-dialog[open]"); } },
  // 21/10/2026 (người dùng: "các nút lấy dữ liệu từ WMS hoặc Inside cần chuẩn hoá giống như các trang")
  { name: "LỰA UID BLOCKED · Danh sách", hash: "#uid-block", wait: "#uid-block-screen:not([hidden])", prep: async page => { await page.locator('[data-ub-tab="list"]').click(); await page.locator("#ub-wms").waitFor({ state: "visible" }); }, id: "ub-wms" },
  { name: "KIỂM TRA ĐẦU VÀO · Mã PO", hash: "#inspection", wait: "#ins-screen:not([hidden])", id: "ins-fetch-po", mate: "ins-po-lookup" },
];

// Nút nằm trong dải mốc giờ / hàng tab (18/10/2026, khối #strip-read): cùng màu / viền / icon / vạch load, nhưng cỡ gọn 36, chữ 14 — so cỡ với nhau, không so với nút 52 của màn đồng bộ.
const STRIP = new Set(SCREENS.filter(x => x.strip).map(x => x.id));

const fakeExtension = () => addEventListener("message", event => {
  const request = event.data;
  if (!request || request.source !== "PRINT_SKU_APP") return;
  postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok: true, data: { version: "0.10.9" } }, location.origin);
});

// Supabase / Edge giả tối thiểu: đủ để màn dựng xong và hiện công cụ Admin, không cần dữ liệu thật.
const mockBackend = page => page.route("**/*", route => {
  const url = route.request().url(), json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith("/auth/v1/user")) return json({ id: "00000000-0000-4000-8000-000000000001" });
  if (url.includes("/rest/v1/user_roles")) return json([{ username: "Admin", role: "admin" }]);
  if (url.includes("/functions/v1/")) return json({ ok: true, data: { runs: [], state: {}, enabled: false } });
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
  if (rpc === "cut_sample_list") return json({ ok: true, data: { sessions: [] } });
  if (rpc === "sku_count_overview") return json({ ok: true, data: { run: null, rows: [] } });
  if (rpc && /^cut_group_uid_/.test(rpc)) return json({ ok: true, data: { items: [] } });
  if (rpc === "sku_combo_lookup") return json([]);
  if (url.includes("/rest/v1/") && !rpc) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [] } });
});

// Đọc kiểu tính toán của một nút: màu, viền, bo thực (bo tối đa nửa chiều cao), chữ, icon mask, cao, cao ô cùng hàng,
// bề rộng lúc rảnh và lúc đang đọc (đổi nhãn sang "Đang đọc…" như setBusy: nhãn trong .src-read__t + data-busy + khoá) — nút không được nhảy rộng (giữ chỗ nhãn bận, 18/10/2026).
const readStyle = (page, id, mate) => page.evaluate(async ({ id, mate }) => {
  const b = document.getElementById(id);
  // Dòng load dưới nút đang chạy (18/10/2026): ép data-busy="true" tạm thời rồi đo ::after — vạch 3 px bo tròn nằm dưới mép nút, rộng bằng nút, không bị cắt hay chồng
  // (điểm giữa vạch trỏ về chính nút: không có cha overflow:hidden cắt, không có phần tử nào đè), chưa có tiến độ thật (--p) → đoạn 38 % trượt qua lại; trả lại trạng thái cũ sau khi đo.
  const barProbe = b => {
    const was = { busy: b.dataset.busy, disabled: b.disabled };
    b.dataset.busy = "true"; b.disabled = true;
    const s = getComputedStyle(b, "::after"), r = b.getBoundingClientRect(), h = parseFloat(s.height) || 0, w = parseFloat(s.width) || 0;
    const top = r.top + b.clientTop + (parseFloat(s.top) || 0), left = r.left + b.clientLeft + (parseFloat(s.left) || 0), token = s.backgroundSize.split(",")[0].trim().split(" ")[0];
    const hit = h ? document.elementFromPoint(left + w / 2, top + h / 2) : null;
    const out = { content: s.content, position: s.position, height: h, track: w, btn: r.width, below: top >= r.bottom - 0.5, hit: hit === b, hitTag: hit ? `${hit.tagName.toLowerCase()}${hit.id ? "#" + hit.id : ""}` : null, fillOfTrack: token.endsWith("%") ? parseFloat(token) / 100 : NaN, animated: s.animationName !== "none", p: b.style.getPropertyValue("--p") };
    if (was.busy === undefined) delete b.dataset.busy; else b.dataset.busy = was.busy; b.disabled = was.disabled;
    return out;
  };
  const busyWidths = b => {
    const t = b && b.querySelector(".src-read__t");
    if (!t) return { idleWidth: null, busyWidth: null };
    const idleWidth = b.getBoundingClientRect().width, was = { text: t.textContent, busy: b.dataset.busy, disabled: b.disabled };
    t.textContent = "Đang đọc…"; b.dataset.busy = "true"; b.disabled = true;
    const busyWidth = b.getBoundingClientRect().width;
    t.textContent = was.text; if (was.busy === undefined) delete b.dataset.busy; else b.dataset.busy = was.busy; b.disabled = was.disabled;
    return { idleWidth, busyWidth };
  };
  if (!b) return { id, missing: true };
  await Promise.all(b.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
  const s = getComputedStyle(b), before = getComputedStyle(b, "::before"), h = parseFloat(s.height), m = mate && document.getElementById(mate);
  return {
    id, visible: b.getClientRects().length > 0, classes: [...b.classList], svg: Boolean(b.querySelector("svg")),
    backgroundColor: s.backgroundColor, color: s.color, borderColor: [s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].join(" "),
    borderWidth: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].join(" "),
    radius: `${Math.min(parseFloat(s.borderTopLeftRadius), h / 2)}/${h / 2}`, fontSize: s.fontSize, fontWeight: s.fontWeight, fontFamily: s.fontFamily,
    mask: before.maskImage || before.webkitMaskImage, content: before.content, height: h, ctl: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-ctl")),
    mateHeight: m ? m.getBoundingClientRect().height : null,
    ...busyWidths(b),
    bar: barProbe(b),
  };
}, { id, mate });

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const bad = [], styles = []; let reduced = null;
  try {
    for (const spec of SCREENS) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
      if (spec.tab) await context.addInitScript(v => localStorage.setItem("sr-tab-dang-mo", v), spec.tab);
      await context.addInitScript(fakeExtension);
      const page = await context.newPage();
      await mockBackend(page);
      await page.goto(BASE + spec.hash);
      await page.locator(spec.wait).first().waitFor({ state: "visible" });
      if (spec.admin === "stub") await page.evaluate(() => {
        window.PrintSkuAdminAuth = { accessToken: async () => "test-admin-token" };
        window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => "test-admin-token", getToken: async () => "test-admin-token", logout() {} };
        dispatchEvent(new Event("print-sku-admin-ready"));
      });
      if (spec.prep) await spec.prep(page);
      try {
        await page.locator(`#${spec.id}`).waitFor({ state: "visible", timeout: 8000 });
        // Nút đang khoá lúc màn tải xong số liệu đầu tiên (màu ngoài trạng thái rảnh): chờ rảnh rồi mới đo
        await page.waitForFunction(id => { const b = document.getElementById(id); return b && !b.disabled && b.dataset.busy !== "true"; }, spec.id, { timeout: 10000 });
        await page.waitForTimeout(300);
      } catch (_) { /* nút không hiện / không rảnh: readStyle + kiểm tra bên dưới báo */ }
      const style = await readStyle(page, spec.id, spec.mate);
      style.disabled = await page.locator(`#${spec.id}`).isDisabled().catch(() => null);
      styles.push({ ...style, screen: spec.name });
      await context.close();
    }
    // prefers-reduced-motion (18/10/2026): vạch load đứng yên — không animation (quy tắc chung `*, :before, :after { animation: none !important }` của gói Tailwind), vẫn 3 px dưới nút,
    // và khi chưa có tiến độ thật thì là một vạch đặc một màu (không phải đoạn 38 % đứng lệch trái như đang kẹt ở giữa chừng)
    {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page = await context.newPage();
      await mockBackend(page);
      await page.goto(BASE + "#inventory-audit");
      await page.locator("#ia-run").waitFor({ state: "visible" });
      reduced = await page.evaluate(() => {
        const b = document.getElementById("ia-run"), was = { busy: b.dataset.busy, disabled: b.disabled };
        b.dataset.busy = "true"; b.disabled = true;
        const a = getComputedStyle(b, "::after"), icon = getComputedStyle(b, "::before"), out = { content: a.content, height: a.height, animation: a.animationName, backgroundColor: a.backgroundColor, backgroundImage: a.backgroundImage, iconAnimation: icon.animationName };
        if (was.busy === undefined) delete b.dataset.busy; else b.dataset.busy = was.busy; b.disabled = was.disabled;
        return out;
      });
      await context.close();
    }
  } finally { await browser.close(); }

  // 1) Từng nút: hiện, đúng lớp, không còn svg, có icon mask, chữ 16/600, cao đúng --ui-ctl (52 ở 1280) và bằng ô cùng hàng
  for (const s of styles) {
    const tag = `#${s.id} (${s.screen})`;
    if (s.missing) { bad.push(`${tag} không có trong trang`); continue; }
    if (!s.visible) bad.push(`${tag} không hiện`);
    if (s.disabled) bad.push(`${tag} vẫn khoá sau 10 giây (không đo được trạng thái rảnh)`);
    if (!s.classes.includes("src-read")) bad.push(`${tag} thiếu lớp src-read`);
    if (s.classes.includes("src-read--all") || s.classes.includes("src-read--icon")) bad.push(`${tag} là biến thể --all/--icon, không thuộc nhóm nút thường`);
    if (s.svg) bad.push(`${tag} còn svg trong nút (icon phải là mask ::before)`);
    if (!s.mask || s.mask === "none" || s.content === "none") bad.push(`${tag} ::before không có icon mask`);
    if (s.ctl !== 52) bad.push(`${tag} --ui-ctl = ${s.ctl}, cần 52 ở 1280 px`);
    if (STRIP.has(s.id)) { if (Math.abs(s.height - 36) > 1) bad.push(`${tag} cao ${s.height}px, cần 36px (nút trong dải)`); }
    else if (Math.abs(s.height - s.ctl) > 1) bad.push(`${tag} cao ${s.height}px, cần --ui-ctl (${s.ctl}px)`);
    if (s.mateHeight !== null && Math.abs(s.height - s.mateHeight) > 1) bad.push(`${tag} cao ${s.height}px nhưng ô/nút cùng hàng cao ${s.mateHeight}px`);
    // Giữ chỗ nhãn bận: đổi "Đọc …" ↔ "Đang đọc…" không làm nút đổi bề rộng (ô nhập cạnh nó không co giãn theo)
    if (s.idleWidth === null) { if (["sku-it-load", "gu-run-incremental"].includes(s.id)) bad.push(`${tag} không có span .src-read__t để đổi nhãn bận`); }
    else if (Math.abs(s.busyWidth - s.idleWidth) > 1) bad.push(`${tag} rộng ${s.idleWidth.toFixed(1)}px lúc rảnh nhưng ${s.busyWidth.toFixed(1)}px khi "Đang đọc…" (nhảy ${(s.busyWidth - s.idleWidth).toFixed(1)}px)`);
  }
  // 1b) Vạch load dưới nút đang chạy: ở cả 12 nút, không bị cắt / đè, rộng bằng nút, đoạn trượt 38 % khi chưa có tiến độ
  for (const s of styles) {
    if (s.missing) continue;
    const tag = `#${s.id} (${s.screen})`, b = s.bar;
    if (b.content !== '""') { bad.push(`${tag} đang đọc: không có vạch load dưới nút (::after content ${b.content})`); continue; }
    if (b.position !== "absolute") bad.push(`${tag} vạch ${b.position}, cần absolute`);
    if (b.height !== 3) bad.push(`${tag} vạch cao ${b.height}px, cần 3px`);
    if (!b.below) bad.push(`${tag} vạch không nằm dưới mép nút`);
    if (!b.hit) bad.push(`${tag} vạch bị cắt hoặc bị ${b.hitTag} chồng lên`);
    if (Math.abs(b.track / b.btn - 1) > 0.03) bad.push(`${tag} nền vạch ${b.track.toFixed(1)}px ≠ bề rộng nút ${b.btn.toFixed(1)}px`);
    if (!b.animated) bad.push(`${tag} đoạn vạch không trượt khi chưa có tiến độ thật`);
    if (!(Math.abs(b.fillOfTrack - 0.38) < 0.01)) bad.push(`${tag} đoạn trượt ${(b.fillOfTrack * 100).toFixed(1)}%, cần 38%`);
    if (b.p !== "") bad.push(`${tag} có biến --p ${b.p} khi chưa có tiến độ`);
  }
  // 1c) prefers-reduced-motion: vạch tĩnh, icon không xoay
  if (reduced.content !== '""' || reduced.height !== "3px") bad.push(`reduced-motion: vạch ${reduced.content} cao ${reduced.height}, cần 3px`);
  if (reduced.animation !== "none") bad.push(`reduced-motion: vạch còn animation ${reduced.animation}, cần đứng yên`);
  if (reduced.iconAnimation !== "none") bad.push(`reduced-motion: icon còn xoay (${reduced.iconAnimation})`);
  if (reduced.backgroundImage !== "none" || reduced.backgroundColor !== "rgb(127, 203, 177)") bad.push(`reduced-motion: chưa có tiến độ thật thì vạch phải đặc một màu #7fcbb1 (nền ${reduced.backgroundColor}, ảnh nền ${String(reduced.backgroundImage).slice(0, 40)})`);
  const short = value => String(value).length > 90 ? `…${String(value).slice(-70)}` : String(value);
  // 2) Cả 12 nút khớp nhau từng thuộc tính (so với nút đầu tiên) — một kiểu
  const ref = styles.find(s => !s.missing && !STRIP.has(s.id)), stripRef = styles.find(s => !s.missing && STRIP.has(s.id));
  for (const s of styles) {
    if (s.missing || s === ref) continue;
    for (const key of ["backgroundColor", "color", "borderColor", "borderWidth", "radius", "fontSize", "fontWeight", "fontFamily", "mask", "height"]) {
      const base = STRIP.has(s.id) && ["radius", "fontSize", "height"].includes(key) ? stripRef : ref;
      if (s === base) continue;
      if (s[key] !== base[key]) bad.push(`#${s.id} (${s.screen}) ${key} = ${short(s[key])} ≠ #${base.id} (${base.screen}) ${short(base[key])}`);
    }
  }
  assert.equal(styles.length, SCREENS.length, `đủ ${SCREENS.length} nút`);
  assert.equal(styles.filter(s => s.idleWidth !== null).length >= 2, true, "ít nhất hai nút có nhãn bận để đo bề rộng");
  assert.equal(bad.length, 0, `nút đọc nguồn chưa một kiểu (${bad.length} điểm lệch):\n  ${bad.join("\n  ")}`);
  console.log(`src_read_style_browser: đạt (12 nút đọc cùng một kiểu ở 1280 px: nền ${ref.backgroundColor}, chữ ${ref.color} ${ref.fontSize}/${ref.fontWeight}, viền ${ref.borderColor.split(") ")[0]}), cao ${ref.height}px)`);
})().catch(error => { console.error(error); process.exit(1); });
