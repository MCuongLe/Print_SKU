// Admin (chỉ desktop, 08/10/2026): khung Cấu hình khớp 3 màn còn lại, thanh trên + tiêu đề bảng dính, chữ đủ tương phản/cỡ ≥ 12 px,
// dải lỗi + trạng thái Extension thống nhất, Cấu hình không còn câu hướng dẫn và tách "Thiết bị này" / "Hệ thống".
// Run against python -m http.server 8000. Supabase, Edge Function và Extension được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const NAV = ['Lệnh in', 'Đồng bộ SKU', 'Đồng bộ Group UID', 'Kiểm kê SKU', 'Cấu hình'];
const SCREENS = [['#admin/lenh-in', 'Lệnh in', 'print-jobs-screen'], ['#admin/sku-sync', 'Đồng bộ SKU', 'sku-sync-screen'], ['#admin/group-uid-sync', 'Đồng bộ Group UID', 'group-uid-sync-screen'], ['#admin/kiem-ke', 'Kiểm kê SKU', 'inventory-audit-screen'], ['#admin/cauhinh', 'Cấu hình', null]];

const SKU_CHANGES = {
  skus: { added: Array.from({ length: 60 }, (_, i) => ({ sku: `9000${String(i + 1).padStart(5, '0')}`, after: { product_name: `Chỉ mẫu ${i + 1}/100% Polyester`, category_name: 'Thời Trang (Phụ Liệu)' } })), updated: [] },
  combos: { added: [], updated: [], orphaned: [], excluded: [] }, sourceIssues: [],
};
const SKU_COUNTS = { skuAdded: 60, skuUpdated: 0, comboAdded: 0, comboUpdated: 0, comboOrphaned: 0 };
const SKU_SOURCE = { normalRows: 8500, comboRows: 1000, selectedComboLinks: 410, excludedBreakdown: {}, sourceIssues: 2 };
const GU_COUNTS = { added: 1, updated: 0, unchanged: 5, missing: 3, issues: 1, totalChanges: 1 };
const GU_CHANGES = [{ groupUidCode: '1028261006000050', changeType: 'added', before: null, after: { sku: '422439472', qty: 44, products: [{ sku: '422439472', quantity: 7 }], status: 'Available' }, changedFields: ['group_uid_code'], sourceUpdatedAt: '2026-10-08T01:00:00Z' }];

// failOn: { fn: 'sku-sync' | 'group-uid-sync', actions: [...] } → trả lỗi 500 cho các action đó
const mockRoutes = (page, failOn = null) => page.route('**/*', async route => {
  const url = route.request().url();
  page.calls = page.calls || [];
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
  if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
  const body = JSON.parse(route.request().postData() || '{}');
  const fn = url.match(/\/functions\/v1\/([a-z-]+)/)?.[1];
  if (fn) page.calls.push(`${fn}:${body.action}`);
  if (fn && failOn && failOn.fn === fn && failOn.actions.includes(body.action)) return json({ ok: false, error: { message: 'Không đọc được bảng nguồn (HTTP 500)' } }, 500);
  const ok = data => json({ ok: true, data });
  if (fn === 'sku-sync') {
    if (body.action === 'history') return ok({ runs: [{ id: 'run-done', status: 'completed', created_at: ago(120), completed_at: ago(119), change_counts: {} }], lastSuccessAt: ago(119), lastSnapshotAt: ago(120) });
    if (body.action === 'preview') return ok({ runId: 'run-fresh', status: 'previewed', sourceCounts: SKU_SOURCE, changeCounts: SKU_COUNTS, changes: SKU_CHANGES });
  }
  if (fn === 'group-uid-sync') {
    if (body.action === 'history') return ok({ state: { last_successful_incremental_at: ago(90), last_successful_full_at: ago(1200) }, runs: [] });
    if (body.action === 'prepare') return ok({ runId: 'r', mode: body.mode, status: 'running', rangeFrom: null, rangeTo: new Date().toISOString() });
    if (body.action === 'ingest') return ok({ runId: 'r', page: 1, pageCount: 1, totalPages: 1 });
    if (body.action === 'preview') return ok({ runId: 'r', mode: 'full', status: 'previewed', rangeTo: new Date().toISOString(), pageCount: 1, sourceCount: 6, changeCounts: GU_COUNTS, verification: { previousFullCount: 6, fullDropPercent: 0 }, changes: GU_CHANGES });
    if (body.action === 'detail') return ok({ id: 'r', runId: 'r', mode: 'full', status: 'previewed', range_to: new Date().toISOString(), page_count: 1, source_count: 6, change_counts: GU_COUNTS, changes: GU_CHANGES });
  }
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (rpc) page.calls.push(rpc);
  if (rpc === 'print_queue_status') return ok({ queued: 1, queuedCopies: 2, active: 0, agents: [] });
  if (rpc === 'print_admin_jobs') return ok({ day: '2026-10-08', today: '2026-10-08', oldestDay: '2026-10-05', summary: { jobs: 5, copies: 22, failed: 1, active: 1 }, counts: { all: 0, sku: 0, group_uid: 0, other: 0 }, jobs: [] });
  if (url.includes('/rest/v1/') && !rpc) return json([]);
  return ok({ agents: [], jobs: [], items: [] });
});
// Extension giả (PING / PING_WMS / lấy dữ liệu)
const fakeExtension = () => addEventListener('message', event => {
  const r = event.data; if (!r || r.source !== 'PRINT_SKU_APP') return;
  const data = r.type === 'PING' ? { version: '0.3.3' } : r.type === 'PING_WMS' ? { version: '0.4.2' } : r.type === 'GET_GROUP_UID_PAGE' ? { page: 1, size: 500, total: 0, totalPages: 1, rows: [] } : { generatedAt: new Date().toISOString(), cutoff: 'x', categories: [], normalRows: [], comboRows: [], sourceCounts: {} };
  postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: r.requestId, ok: true, data }, location.origin);
});

// Đo tương phản + cỡ chữ của mọi chữ đang hiện trong vùng gốc (chạy trong trang qua page.evaluate)
const textMetrics = function (sel) {
  const parse = c => { const m = String(c).match(/-?[\d.]+/g); if (!m) return [0, 0, 0, 0]; const v = m.map(Number); if (/^color\(/.test(c)) return [v[0] * 255, v[1] * 255, v[2] * 255, v.length > 3 ? v[3] : 1]; return v.length < 4 ? [...v, 1] : v; };
  const L = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = e => { let c = [255, 255, 255]; const chain = []; for (let n = e; n; n = n.parentElement) chain.push(n); for (const n of chain.reverse()) { const cs = getComputedStyle(n); if (cs.backgroundImage !== "none") return null; const p = parse(cs.backgroundColor); const al = p[3]; if (al > 0) c = c.map((v, i) => v * (1 - al) + p[i] * al); } return c; };
  const root = document.querySelector(sel); const out = { low: [], small: [] };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t; (t = walker.nextNode());) {
    const txt = t.textContent.trim(); const el = t.parentElement; if (!txt || !el) continue;
    const bx = el.getBoundingClientRect(); if (!bx.width || !bx.height) continue; const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.opacity === "0") continue;
    const fs = parseFloat(cs.fontSize); if (fs < 12) out.small.push(fs + "px «" + txt.slice(0, 24) + "»");
    const bg = bgOf(el); if (!bg) continue; const fg = parse(cs.color); const ratio = (Math.max(L(fg), L(bg)) + 0.05) / (Math.min(L(fg), L(bg)) + 0.05);
    const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) out.low.push(ratio.toFixed(2) + ":1 «" + txt.slice(0, 24) + "»");
  }
  return out;
};

const open = async (browser, { width = 1280, ext = true, failOn = null } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
  if (ext) await context.addInitScript(fakeExtension);
  const page = await context.newPage();
  page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
  await mockRoutes(page, failOn);
  return { context, page };
};
const go = async (page, hash) => { await page.goto(BASE + '#home'); await page.goto(BASE + hash); };
const navItems = page => page.evaluate(() => {
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== 'none'; };
  const nav = [...document.querySelectorAll('nav')].find(n => vis(n) && n.querySelector('button') && /Đồng bộ SKU|Lệnh in/.test(n.textContent) && n.getBoundingClientRect().width < 400);
  const btns = [...nav.querySelectorAll('button')].filter(vis);
  const cs = e => getComputedStyle(e);
  return { names: btns.map(b => b.textContent.trim()), active: btns.filter(b => b.getAttribute('aria-current') === 'page' || b.classList.contains('bg-brand-light')).map(b => b.textContent.trim()), h: Math.round(btns[0].getBoundingClientRect().height), font: cs(btns[0]).fontSize, weight: cs(btns[0]).fontWeight };
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 1440]) {
      // ---------- 1) Khung đồng bộ giữa 4 màn ----------
      {
        const { context, page } = await open(browser, { width });
        const seen = [];
        for (const [hash, title, screenId] of SCREENS) {
          await go(page, hash);
          if (screenId) await page.locator('#' + screenId).waitFor({ state: 'visible' }); else await page.locator('#root aside nav button', { hasText: 'Đồng bộ Group UID' }).waitFor();
          await page.waitForTimeout(500);
          const m = await page.evaluate(() => {
            const vis = e => { if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
            const side = [...document.querySelectorAll('.ss-side, #root aside')].find(vis), top = [...document.querySelectorAll('.ss-top, #root aside + div > header')].find(vis);
            const mk = top.querySelector('.ss-top-mark'), mb = mk && mk.getBoundingClientRect();
            return { sideW: Math.round(side.getBoundingClientRect().width), topH: Math.round(top.getBoundingClientRect().height), topPos: getComputedStyle(top).position, title: top.querySelector('h1').textContent.trim(), titleFont: getComputedStyle(top.querySelector('h1')).fontSize, titleWeight: getComputedStyle(top.querySelector('h1')).fontWeight, mark: mb ? `${Math.round(mb.width)}x${Math.round(mb.height)}` : null, markIcon: !!(mk && mk.querySelector('svg')), sub: top.querySelector('.ss-top-sub')?.textContent.trim() || '' };
          });
          const nav = await navItems(page);
          seen.push({ hash, m, nav });
          assert.equal(m.sideW, 276, `${hash}: thanh bên ${m.sideW}`);
          assert.equal(m.topH, 64, `${hash}: thanh trên ${m.topH}`);
          assert.equal(m.topPos, 'sticky', `${hash}: thanh trên phải dính`);
          assert.equal(m.title, title, `${hash}: tiêu đề`);
          assert.equal(m.titleFont, '18px'); assert.equal(m.titleWeight, '700', `${hash}: tiêu đề phải đậm`);
          assert.equal(m.mark, '38x38', `${hash}: icon module`); assert.equal(m.markIcon, true); assert.notEqual(m.sub, '', `${hash}: thiếu dòng phụ`);
          assert.deepEqual(nav.names, NAV, `${hash}: thứ tự menu`);
          assert.deepEqual(nav.active, [title], `${hash}: đúng một mục đang chọn`);
          assert.equal(nav.h, 50); assert.equal(nav.font, '16px'); assert.equal(nav.weight, '600');
        }
        // thanh trên vẫn ở đỉnh; trong popup chi tiết, hàng tiêu đề bảng dính ở đỉnh vùng cuộn của popup
        await go(page, '#admin/sku-sync'); await page.locator('#sku-sync-preview').click();
        await page.waitForFunction(() => document.getElementById('ss-sku-added').textContent !== '0');
        await page.locator('[data-change-kind="sku-added"]').click(); await page.locator('#ss-dialog').waitFor({ state: 'visible' });
        await page.waitForFunction(() => document.querySelectorAll('#ss-change-body tr').length > 20);
        await page.evaluate(() => { document.querySelector('#ss-dialog .as-d-body').scrollTop = 600; });
        await page.waitForTimeout(250);
        const sticky = await page.evaluate(() => { const top = [...document.querySelectorAll('.ss-top')].find(e => e.getBoundingClientRect().width > 0); const body = document.querySelector('#ss-dialog .as-d-body'), th = document.querySelector('#ss-change-head th'); return { topY: Math.round(top.getBoundingClientRect().top), bodyY: Math.round(body.getBoundingClientRect().top), thY: Math.round(th.getBoundingClientRect().top), thPos: getComputedStyle(th).position, scrolled: body.scrollTop }; });
        assert.equal(sticky.topY, 0, 'thanh trên mất khi cuộn'); assert.equal(sticky.thPos, 'sticky'); assert.ok(sticky.scrolled > 0, 'vùng cuộn của popup phải cuộn được'); assert.equal(sticky.thY, sticky.bodyY, `tiêu đề bảng phải dính ở đỉnh popup (thấy ${sticky.thY}, vùng cuộn ${sticky.bodyY})`);
        assert.deepEqual(page.errors, []); await context.close();
      }

      // ---------- 2) Cấu hình: nội dung + nhóm ----------
      {
        const { context, page } = await open(browser, { width });
        await go(page, '#admin/cauhinh'); await page.locator('#root main h3').first().waitFor();
        const text = await page.locator('#root main').innerText();
        for (const gone of ['không mang sang được', 'Gõ SKU ở màn in tem', 'Đổi mẫu chỉ áp', 'Apps Script quyết định', 'Gõ lại SKU cũ', 'Tên này hiện trong hàng đợi', 'Bấm In là gửi được']) assert.equal(text.includes(gone), false, `còn câu hướng dẫn: ${gone}`);
        const order = await page.evaluate(() => [...document.querySelectorAll('#root main .adm-group, #root main h3')].map(e => e.textContent.trim()));
        assert.deepEqual(order, ['Thiết bị này', 'Tên máy', 'Quyền in', 'Mẫu tem', 'Sổ tay SKU của máy này', 'Hệ thống', 'Danh mục SKU', 'Trần một lệnh in · chỉ đọc'], 'thứ tự nhóm/thẻ trong Cấu hình');
        assert.match(text, /mã khoá/);
        assert.equal((await page.locator('#root aside + div > header h1').innerText()).trim(), 'Cấu hình');
        const m = await page.evaluate(textMetrics, '#root aside + div > main');
        assert.deepEqual(m.low, [], 'chữ thiếu tương phản trong Cấu hình'); assert.deepEqual(m.small, [], 'chữ < 12 px trong Cấu hình');
        assert.deepEqual(page.errors, []); await context.close();
      }

      // ---------- 3) Tương phản + cỡ chữ trên các dashboard ----------
      {
        const { context, page } = await open(browser, { width });
        await go(page, '#admin/sku-sync'); await page.locator('#sku-sync-preview').click(); await page.waitForFunction(() => document.getElementById('ss-sku-added').textContent !== '0');
        await page.locator('[data-change-kind="sku-added"]').click(); await page.waitForFunction(() => document.querySelectorAll('#ss-change-body tr').length > 20); // popup chi tiết đang mở: đo cả popup
        let m = await page.evaluate(textMetrics, '#sku-sync-screen'); assert.deepEqual(m.low, [], 'SKU: thiếu tương phản'); assert.deepEqual(m.small, [], 'SKU: chữ < 12 px');
        await page.keyboard.press('Escape'); await page.locator('#ss-history-btn').click(); await page.locator('#ss-hist-dialog').waitFor({ state: 'visible' });
        m = await page.evaluate(textMetrics, '#sku-sync-screen'); assert.deepEqual(m.low, [], 'SKU lịch sử: thiếu tương phản'); assert.deepEqual(m.small, [], 'SKU lịch sử: chữ < 12 px');
        await go(page, '#admin/group-uid-sync'); await page.locator('#gu-run-full').click(); await page.waitForFunction(() => /Đối chiếu xong/.test(document.getElementById('gu-status').textContent));
        await page.locator('[data-gu-kind="added"]').click(); await page.locator('#gu-dialog').waitFor({ state: 'visible' });
        m = await page.evaluate(textMetrics, '#group-uid-sync-screen'); assert.deepEqual(m.low, [], 'Group UID: thiếu tương phản'); assert.deepEqual(m.small, [], 'Group UID: chữ < 12 px');
        await page.keyboard.press('Escape'); await page.locator('#gu-history-btn').click(); await page.locator('#gu-hist-dialog').waitFor({ state: 'visible' });
        m = await page.evaluate(textMetrics, '#group-uid-sync-screen'); assert.deepEqual(m.low, [], 'Group UID lịch sử: thiếu tương phản'); assert.deepEqual(m.small, [], 'Group UID lịch sử: chữ < 12 px');
        await go(page, '#admin/lenh-in'); await page.locator('#print-jobs-screen').waitFor({ state: 'visible' }); await page.waitForTimeout(600);
        m = await page.evaluate(textMetrics, '#print-jobs-screen'); assert.deepEqual(m.low, [], 'Lệnh in: thiếu tương phản'); assert.deepEqual(m.small, [], 'Lệnh in: chữ < 12 px');
        assert.deepEqual(page.errors, []); await context.close();
      }

      // ---------- 5) Chip tóm tắt + nút làm mới trên thanh trên ----------
      {
        const { context, page } = await open(browser, { width });
        const chips = sel => page.locator(sel + ' .as-chip').allInnerTexts().then(a => a.map(t => t.replace(/\s+/g, ' ').trim()));
        await go(page, '#admin/lenh-in'); await page.locator('#pj-top-chips .as-chip').nth(2).waitFor();
        assert.deepEqual(await chips('#pj-top-chips'), ['5 lệnh hôm nay', '1 đang chờ', '1 lỗi'], 'chip Lệnh in');
        assert.match((await page.locator('#pj-top-sub').innerText()).trim(), /^Cả kho · cập nhật \d{2}:\d{2}$/);
        const jobsBefore = page.calls.filter(c => c === 'print_admin_jobs').length;
        await page.locator('#pj-top-refresh').click();
        await page.waitForTimeout(600);
        assert.ok(page.calls.filter(c => c === 'print_admin_jobs').length > jobsBefore, 'nút làm mới trên thanh trên phải tải lại danh sách');
        assert.equal(await page.locator('#pj-top-refresh svg.pj-svg').count(), 1, 'icon làm mới dùng nét, không tô đặc');

        await go(page, '#admin/sku-sync'); assert.deepEqual(await chips('#sku-top-chips'), [], 'chưa kiểm tra thì chưa có chip');
        await page.locator('#sku-sync-preview').click(); await page.locator('#sku-top-chips .as-chip').nth(1).waitFor();
        assert.deepEqual(await chips('#sku-top-chips'), ['60 thay đổi', '2 cảnh báo'], 'chip Đồng bộ SKU');
        const hist = page.calls.filter(c => c === 'sku-sync:history').length;
        await page.locator('#sku-top-refresh').click(); await page.waitForTimeout(600);
        assert.ok(page.calls.filter(c => c === 'sku-sync:history').length > hist, 'làm mới SKU phải tải lại lịch sử');

        await go(page, '#admin/group-uid-sync'); assert.deepEqual(await chips('#gu-top-chips'), [], 'chưa đối chiếu thì chưa có chip');
        await page.locator('#gu-run-full').click(); await page.locator('#gu-top-chips .as-chip').nth(1).waitFor();
        assert.deepEqual(await chips('#gu-top-chips'), ['1 thay đổi', '4 cảnh báo'], 'chip Đồng bộ Group UID');
        const gh = page.calls.filter(c => c === 'group-uid-sync:history').length;
        await page.locator('#gu-top-refresh').click(); await page.waitForTimeout(600);
        assert.ok(page.calls.filter(c => c === 'group-uid-sync:history').length > gh, 'làm mới Group UID phải tải lại lịch sử');
        assert.deepEqual(page.errors, []); await context.close();
      }

      // ---------- 4a) Dải lỗi máy chủ ----------
      for (const [fn, hash, run, status] of [['sku-sync', '#admin/sku-sync', '#sku-sync-preview', '#sku-sync-status'], ['group-uid-sync', '#admin/group-uid-sync', '#gu-run-full', '#gu-status']]) {
        const { context, page } = await open(browser, { width, failOn: { fn, actions: ['preview', 'prepare'] } });
        await go(page, hash); await page.locator(run).waitFor();
        await page.locator(run).click();
        await page.waitForFunction(s => document.querySelector(s).dataset.tone === 'error', status);
        const info = await page.evaluate(s => { const e = document.querySelector(s); const cs = getComputedStyle(e); return { text: e.textContent.trim(), bg: cs.backgroundColor, color: cs.color, icon: getComputedStyle(e, '::before').content, live: e.getAttribute('aria-live') }; }, status);
        assert.match(info.text, /HTTP 500/); assert.notEqual(info.bg, 'rgba(0, 0, 0, 0)'); assert.equal(info.color, 'rgb(143, 47, 42)'); assert.notEqual(info.icon, 'none'); assert.equal(info.live, 'assertive');
        await page.waitForFunction(r => !document.querySelector(r).disabled, run); // nút chạy lại được sau lỗi
        await context.close();
      }

      // ---------- 4b) Không có Extension: hai màn báo giống nhau (dải lỗi, không "Sẵn sàng") ----------
      for (const [hash, status, connection] of [['#admin/sku-sync', '#sku-sync-status', '#sku-sync-connection'], ['#admin/group-uid-sync', '#gu-status', '#gu-connection']]) {
        const { context, page } = await open(browser, { width, ext: false });
        await go(page, hash);
        await page.waitForFunction(s => document.querySelector(s).dataset.tone === 'error', status, { timeout: 20000 }); // PING chờ ~6 giây rồi báo lỗi
        const info = await page.evaluate(([s, c]) => ({ text: document.querySelector(s).textContent.trim(), tone: document.querySelector(s).dataset.tone, pill: document.querySelector(c).textContent.trim() }), [status, connection]);
        assert.equal(info.tone, 'error', `${hash}: phải là dải lỗi`); assert.match(info.text, /Extension/); assert.equal(/Sẵn sàng/.test(info.text), false, `${hash}: không được báo "Sẵn sàng" khi chưa có Extension`); assert.match(info.pill, /Chưa kết nối/);
        await context.close();
      }
      if (width === 1280) {
        const { context, page } = await open(browser, { width: 1024 });
        for (const hash of ['#admin/lenh-in', '#admin/sku-sync', '#admin/group-uid-sync', '#admin/kiem-ke', '#admin/cauhinh']) {
          await go(page, hash); await page.waitForTimeout(700);
          const m = await page.evaluate(() => { const top = [...document.querySelectorAll('.ss-top, #root aside + div > header')].find(e => e.getBoundingClientRect().width > 0); const chips = top.querySelector('.ss-top-chips'), sub = top.querySelector('.ss-top-sub'); return { h: Math.round(top.getBoundingClientRect().height), chips: chips ? getComputedStyle(chips).display : 'none', sub: getComputedStyle(sub).display, overflow: document.documentElement.scrollWidth > innerWidth }; });
          assert.equal(m.h, 64, hash); assert.equal(m.chips, 'none', hash + ': chip ẩn ở cửa sổ hẹp'); assert.equal(m.sub, 'none', hash + ': dòng phụ ẩn ở cửa sổ hẹp'); assert.equal(m.overflow, false, hash + ': tràn ngang');
        }
        assert.deepEqual(page.errors, []); await context.close();
      }
      console.log(`PASS ${width}px: khung đồng bộ (276/64/menu cùng thứ tự), thanh trên + tiêu đề bảng dính, tương phản/cỡ chữ, Cấu hình gọn + nhóm, dải lỗi + Extension thống nhất, thanh trên (icon, tiêu đề đậm, dòng phụ, chip, làm mới)`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
