// Admin (chỉ desktop, 08/10/2026): khung Cấu hình khớp 3 màn còn lại, thanh trên + tiêu đề bảng dính, chữ đủ tương phản/cỡ ≥ 12 px,
// dải lỗi + trạng thái Extension thống nhất, Cấu hình không còn câu hướng dẫn và tách "Thiết bị này" / "Hệ thống".
// 11/10/2026: menu Admin là các mục nhóm Quản trị trong thanh trái chung (264 px, máy tính ≥ 1024 px), thay thanh bên riêng.
// Run against python -m http.server 8000. Supabase, Edge Function và Extension được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();
const NAV = ['Lệnh in', 'Đồng bộ SKU', 'Đồng bộ Group UID', 'Cấu hình'];
const SCREENS = [['#admin/lenh-in', 'Lệnh in', 'print-jobs-screen'], ['#admin/sku-sync', 'Đồng bộ SKU', 'sku-sync-screen'], ['#admin/group-uid-sync', 'Đồng bộ Group UID', 'group-uid-sync-screen'], ['#admin/cauhinh', 'Cấu hình', null]];

const SKU_CHANGES = {
  skus: { added: Array.from({ length: 60 }, (_, i) => ({ sku: `9000${String(i + 1).padStart(5, '0')}`, after: { product_name: `Chỉ mẫu ${i + 1}/100% Polyester`, category_name: 'Thời Trang (Phụ Liệu)' } })), updated: [] },
  combos: { added: [], updated: [], orphaned: [], excluded: [] }, sourceIssues: [],
};
const SKU_COUNTS = { skuAdded: 60, skuUpdated: 0, comboAdded: 0, comboUpdated: 0, comboOrphaned: 0 };
const SKU_SOURCE = { normalRows: 8500, comboRows: 1000, selectedComboLinks: 410, excludedBreakdown: {}, sourceIssues: 2 };
const GU_COUNTS = { added: 1, updated: 0, unchanged: 5, missing: 3, issues: 1, totalChanges: 1 };
const GU_CHANGES = [{ groupUidCode: '1028260000000050', changeType: 'added', before: null, after: { sku: '900000051', qty: 44, products: [{ sku: '900000051', quantity: 7 }], status: 'Available' }, changedFields: ['group_uid_code'], sourceUpdatedAt: '2026-10-08T01:00:00Z' }];

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
  if (fn) { page.calls.push(`${fn}:${body.action}`); (page.bodies = page.bodies || []).push({ fn, ...body }); }
  if (fn && failOn && failOn.fn === fn && failOn.actions.includes(body.action)) return json({ ok: false, error: { message: 'Không đọc được bảng nguồn (HTTP 500)' } }, 500);
  const ok = data => json({ ok: true, data });
  // sync_auto_v3 (26/10/2026): page.autoConfig = data của auto-config (minExtension, devices) hoặc 'fail' → HTTP 500; không đặt = như cũ.
  if (fn && body.action === 'auto-config' && page.autoConfig === 'fail') return json({ ok: false, error: { message: 'Không đọc được cấu hình (HTTP 500)' } }, 500);
  if (fn && body.action === 'auto-config' && page.autoConfig) return ok(page.autoConfig);
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
// Extension giả (PING / PING_WMS / lấy dữ liệu); o.ping = bản PING trả về (mặc định 0.3.3), window.__extCalls = loại lệnh đã nhận
const fakeExtension = (o = {}) => addEventListener('message', event => {
  const r = event.data; if (!r || r.source !== 'PRINT_SKU_APP') return;
  (window.__extCalls = window.__extCalls || []).push(r.type);
  const data = r.type === 'PING' ? { version: o && 'ping' in o ? o.ping : '0.3.3' } : r.type === 'PING_WMS' ? { version: '0.10.10' } : r.type === 'GET_GROUP_UID_PAGE' ? { page: 1, size: 500, total: 0, totalPages: 1, rows: [] } : { generatedAt: new Date().toISOString(), cutoff: 'x', categories: [], normalRows: [], comboRows: [], sourceCounts: {} };
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

const open = async (browser, { width = 1280, height = 900, ext = true, failOn = null, ping, autoConfig } = {}) => {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
  if (ext) await context.addInitScript(fakeExtension, ping === undefined ? {} : { ping });
  const page = await context.newPage();
  page.errors = []; page.on('pageerror', error => page.errors.push(error.message));
  // Lỗi console (trừ dòng "Failed to load resource" của phản hồi HTTP 500 giả lập)
  page.consoleErrors = []; page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.consoleErrors.push(m.text()); });
  page.autoConfig = autoConfig;
  await mockRoutes(page, failOn);
  return { context, page };
};
const go = async (page, hash) => { await page.goto(BASE + '#home'); await page.goto(BASE + hash); };
const navItems = page => page.evaluate(() => {
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).display !== 'none'; };
  const btns = [...document.querySelectorAll('#app-nav [data-an-hash]')].filter(vis);
  const cs = e => getComputedStyle(e), active = btns.filter(b => b.getAttribute('aria-current') === 'page');
  return { names: btns.map(b => b.getAttribute('aria-label')), active: active.map(b => b.getAttribute('aria-label')), h: Math.round(btns[0].getBoundingClientRect().height), font: cs(btns[0]).fontSize, weights: [...new Set(btns.map(b => `${b.getAttribute('aria-current') === 'page' ? 'on' : 'off'}:${cs(b).fontWeight}`))].sort() };
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
          if (screenId) await page.locator('#' + screenId).waitFor({ state: 'visible' }); else await page.locator('#root aside + div > header h1').waitFor();
          await page.locator('#app-nav [data-an-hash]').first().waitFor();
          await page.waitForTimeout(500);
          const m = await page.evaluate(() => {
            const vis = e => { if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
            const side = [...document.querySelectorAll('#app-nav, .ss-side, #root aside')].find(vis), top = [...document.querySelectorAll('.ss-top, #root aside + div > header')].find(vis);
            const mk = top.querySelector('.ss-top-mark'), mb = mk && mk.getBoundingClientRect();
            return { sideW: Math.round(side.getBoundingClientRect().width), topH: Math.round(top.getBoundingClientRect().height), topPos: getComputedStyle(top).position, title: top.querySelector('h1').textContent.trim(), titleFont: getComputedStyle(top.querySelector('h1')).fontSize, titleWeight: getComputedStyle(top.querySelector('h1')).fontWeight, mark: mb ? `${Math.round(mb.width)}x${Math.round(mb.height)}` : null, markIcon: !!(mk && mk.querySelector('svg')), sub: top.querySelector('.ss-top-sub')?.textContent.trim() || '' };
          });
          const nav = await navItems(page);
          seen.push({ hash, m, nav });
          assert.equal(m.sideW, 264, `${hash}: thanh bên ${m.sideW}`);
          assert.equal(m.topH, 80, `${hash}: thanh trên ${m.topH} (chuẩn thanh trên máy tính 80 px, nền ảnh nhóm)`);
          assert.equal(m.topPos, 'sticky', `${hash}: thanh trên phải dính`);
          assert.equal(m.title, title, `${hash}: tiêu đề`);
          assert.equal(m.titleFont, '18px'); assert.equal(m.titleWeight, '700', `${hash}: tiêu đề phải đậm`);
          assert.equal(m.mark, '38x38', `${hash}: icon module`); assert.equal(m.markIcon, true); assert.notEqual(m.sub, '', `${hash}: thiếu dòng phụ`);
          assert.deepEqual(nav.names, NAV, `${hash}: thứ tự menu`);
          assert.deepEqual(nav.active, [title], `${hash}: đúng một mục đang chọn`);
          assert.equal(nav.h, 48, `${hash}: mục Admin có ô icon 36 px`); assert.equal(nav.font, '16px'); assert.deepEqual(nav.weights, ['off:400', 'on:600'], `${hash}: mục đang mở đậm 600, mục khác 400`);
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
      // Header B (99745a5): chip cũ vẫn tính nhưng ẩn, thay bằng một ô KPI trên thanh trên
      {
        const { context, page } = await open(browser, { width });
        const chips = sel => page.locator(sel + ' .as-chip').allInnerTexts().then(a => a.map(t => t.replace(/\s+/g, ' ').trim()));
        await go(page, '#admin/lenh-in'); await page.locator('#pj-top-chips .as-chip').nth(2).waitFor({ state: 'attached' });
        assert.deepEqual(await chips('#pj-top-chips'), ['5 lệnh hôm nay', '1 đang chờ', '1 lỗi'], 'chip Lệnh in');
        await page.waitForFunction(() => /5 lệnh/.test(document.querySelector('#print-jobs-screen .ss-command-kpi')?.textContent || ''));
        assert.match((await page.locator('#pj-top-sub').innerText()).trim(), /^Cả kho · cập nhật \d{2}:\d{2}$/);
        const jobsBefore = page.calls.filter(c => c === 'print_admin_jobs').length;
        await page.locator('#pj-top-refresh').click();
        await page.waitForTimeout(600);
        assert.ok(page.calls.filter(c => c === 'print_admin_jobs').length > jobsBefore, 'nút làm mới trên thanh trên phải tải lại danh sách');
        assert.equal(await page.locator('#pj-top-refresh svg.pj-svg').count(), 1, 'icon làm mới dùng nét, không tô đặc');

        await go(page, '#admin/sku-sync'); assert.deepEqual(await chips('#sku-top-chips'), [], 'chưa kiểm tra thì chưa có chip');
        await page.locator('#sku-sync-preview').click(); await page.locator('#sku-top-chips .as-chip').nth(1).waitFor({ state: 'attached' });
        assert.deepEqual(await chips('#sku-top-chips'), ['60 thay đổi', '2 cảnh báo'], 'chip Đồng bộ SKU');
        await page.waitForFunction(() => /60 SKU mới/.test(document.querySelector('#sku-sync-screen .ss-command-kpi')?.textContent || ''));
        const hist = page.calls.filter(c => c === 'sku-sync:history').length;
        await page.locator('#sku-top-refresh').click(); await page.waitForTimeout(600);
        assert.ok(page.calls.filter(c => c === 'sku-sync:history').length > hist, 'làm mới SKU phải tải lại lịch sử');

        await go(page, '#admin/group-uid-sync'); assert.deepEqual(await chips('#gu-top-chips'), [], 'chưa đối chiếu thì chưa có chip');
        await page.locator('#gu-run-full').click(); await page.locator('#gu-top-chips .as-chip').nth(1).waitFor({ state: 'attached' });
        assert.deepEqual(await chips('#gu-top-chips'), ['1 thay đổi', '4 cảnh báo'], 'chip Đồng bộ Group UID');
        await page.waitForFunction(() => /1 UID mới/.test(document.querySelector('#group-uid-sync-screen .ss-command-kpi')?.textContent || ''));
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
        for (const hash of ['#admin/lenh-in', '#admin/sku-sync', '#admin/group-uid-sync', '#admin/cauhinh']) {
          await go(page, hash); await page.waitForTimeout(700);
          const m = await page.evaluate(() => { const top = [...document.querySelectorAll('.ss-top, #root aside + div > header')].find(e => e.getBoundingClientRect().width > 0); const chips = top.querySelector('.ss-top-chips'), sub = top.querySelector('.ss-top-sub'); return { h: Math.round(top.getBoundingClientRect().height), chips: chips ? getComputedStyle(chips).display : 'none', sub: getComputedStyle(sub).display, overflow: document.documentElement.scrollWidth > innerWidth }; });
          assert.equal(m.h, 80, hash); assert.equal(m.chips, 'none', hash + ': chip ẩn ở cửa sổ hẹp'); assert.equal(m.sub, 'none', hash + ': dòng phụ ẩn ở cửa sổ hẹp'); assert.equal(m.overflow, false, hash + ': tràn ngang');
        }
        assert.deepEqual(page.errors, []); await context.close();
      }
      console.log(`PASS ${width}px: khung đồng bộ (thanh trái chung 264/thanh trên 64/menu Admin cùng thứ tự), thanh trên + tiêu đề bảng dính, tương phản/cỡ chữ, Cấu hình gọn + nhóm, dải lỗi + Extension thống nhất, thanh trên (icon, tiêu đề đậm, dòng phụ, chip, làm mới)`);
    }

    // ---------- 6) Cổng bản Extension + bảng Máy đồng bộ (sync_auto_v3, 26/10/2026) ----------
    // Hợp đồng Edge auto-config: minExtension {sku, group_uid, cut_adj, storage_risk} = "x.y.z" | null; devices [{device, id4, version, lastSeenAt, lastKind}].
    // Lượt tay gửi extVersion (chỉ khi PING trả đúng dạng x.y.z); dưới mức thì dừng trước khi đọc Inside; bảng máy: đỏ dưới mức, vàng chưa khai báo khi chưa có mức.
    const MIN = v => ({ sku: v, group_uid: v, cut_adj: v, storage_risk: v });
    // Hai bản giả của bảng ca so bản (0.10.10 > 0.10.9 theo từng đoạn số): hằng riêng để commit_gate mục 5 không coi là dòng ghim bản manifest
    const NEW = '0.10.10', OLD = '0.10.9';
    const autoCfg = (minExtension, devices = []) => ({ enabled: true, intervalMinutes: 30, fullWindow: { start: '00:00', end: '05:00' }, thresholds: {}, updatedAt: ago(1), updatedBy: null, minExtension, lastFinishedAt: {}, devices });
    // Máy giả (tên / mã không có thật); holder thừa để kiểm web chỉ hiện #id4
    const DEVICES = [
      { device: 'may-a', id4: 'ab12', version: OLD, lastSeenAt: ago(5), lastKind: 'sku', holder: 'may-a#ab12zz99yy' },
      { device: 'may-b', id4: 'cd34', version: null, lastSeenAt: ago(90), lastKind: 'group_uid' },
      { device: 'may-c', id4: 'ef56', version: NEW, lastSeenAt: ago(1500), lastKind: 'cut_adj' },
    ];
    const skuReady = async page => { await go(page, '#admin/sku-sync'); await page.waitForFunction(() => document.getElementById('sku-sync-connection').dataset.state === 'ok'); await page.waitForFunction(() => !document.getElementById('sku-sync-preview').disabled); };
    const skuRun = async (opts, button = '#sku-sync-preview') => {
      const { context, page } = await open(browser, opts);
      await skuReady(page); await page.evaluate(() => { window.__extCalls = []; });
      await page.locator(button).click();
      await page.waitForFunction(() => { const s = document.getElementById('sku-sync-status'); return s.dataset.tone === 'error' || /Đối chiếu xong/.test(s.textContent); });
      await page.waitForFunction(() => !document.getElementById('sku-sync-preview').disabled);
      const s = page.locator('#sku-sync-status');
      return { context, page, status: (await s.innerText()).trim(), tone: await s.getAttribute('data-tone'), calls: await page.evaluate(() => window.__extCalls), body: (page.bodies || []).filter(b => b.fn === 'sku-sync' && b.action === 'preview').at(-1), errs: () => [...page.errors, ...page.consoleErrors] };
    };
    {
      // (a) preview gửi extVersion = bản PING; PING sai dạng / rỗng → không có khoá
      let r = await skuRun({ ping: '0.10.10', autoConfig: autoCfg(MIN(null)) });
      assert.equal(r.body?.extVersion, '0.10.10', 'preview gửi extVersion = bản PING'); assert.ok(r.calls.includes('GET_SKU_SYNC_DATA'), 'đọc Inside như cũ');
      assert.deepEqual(r.errs(), []); await r.context.close();
      for (const bad of [' 0.10.10', '', '0.10']) {
        r = await skuRun({ ping: bad, autoConfig: autoCfg(MIN(null)) });
        assert.ok(r.body, `PING "${bad}": chưa có mức thì vẫn đối chiếu`); assert.equal('extVersion' in r.body, false, `PING "${bad}": không gửi khoá extVersion`);
        await r.context.close();
      }
      // (b) dưới mức → dừng trước khi đọc Inside, không gọi preview (cả Đọc Inside lẫn Toàn bộ)
      for (const button of ['#sku-sync-preview', '#sku-sync-full']) {
        r = await skuRun({ ping: '0.10.9', autoConfig: autoCfg(MIN('0.10.10')) }, button);
        assert.equal(r.status, 'Cần Extension ≥ 0.10.10 (đang v0.10.9): Reload Extension rồi tải lại tab Inside.', `${button}: câu báo dưới mức`); assert.equal(r.tone, 'error');
        assert.equal(r.body, undefined, `${button}: dưới mức không gọi preview`); assert.equal(r.calls.includes('GET_SKU_SYNC_DATA'), false, `${button}: dưới mức không đọc Inside`);
        assert.deepEqual(r.errs(), []); await r.context.close();
      }
      for (const [ping, min, label] of [['0.10.10', '0.10.10', 'bằng mức'], ['0.10.10', '0.10.9', '0.10.10 > 0.10.9 (so từng đoạn số, không so chuỗi)'], ['0.11.0', '0.10.10', 'đoạn giữa lớn hơn'], ['0.10.9', null, 'mức null = không chặn']]) {
        r = await skuRun({ ping, autoConfig: autoCfg(MIN(min)) });
        assert.equal(r.body?.extVersion, ping, `${label}: chạy như cũ, gửi extVersion`); assert.ok(r.calls.includes('GET_SKU_SYNC_DATA'), `${label}: đọc Inside`);
        await r.context.close();
      }
      r = await skuRun({ ping: '0.9.99', autoConfig: autoCfg(MIN('0.10.10')) });
      assert.match(r.status, /^Cần Extension ≥ 0\.10\.10 \(đang v0\.9\.99\)/, '0.9.99 < 0.10.10 (chuỗi "0.9.99" > "0.10.10" nhưng số nhỏ hơn)'); assert.equal(r.body, undefined); await r.context.close();
      r = await skuRun({ ping: '', autoConfig: autoCfg(MIN('0.10.10')) });
      assert.match(r.status, /^Cần Extension ≥ 0\.10\.10 /, 'có mức mà bản không đọc được → dừng'); assert.equal(r.body, undefined); await r.context.close();
      r = await skuRun({ ping: '0.10.9', autoConfig: autoCfg({ sku: null, group_uid: '0.10.10', cut_adj: null, storage_risk: null }) });
      assert.equal(r.body?.extVersion, '0.10.9', 'mức chỉ đặt cho Group UID: Đồng bộ SKU không chặn'); await r.context.close();
      // auto-config lỗi: không chặn trước (Edge vẫn chặn), nút Máy đồng bộ ẩn, không lỗi console
      r = await skuRun({ ping: '0.10.9', autoConfig: 'fail' });
      assert.equal(r.body?.extVersion, '0.10.9', 'auto-config lỗi: vẫn đối chiếu'); assert.equal(await r.page.locator('#ss-dev-btn').isVisible(), false, 'auto-config lỗi: ẩn nút Máy đồng bộ');
      assert.deepEqual(r.errs(), []); await r.context.close();
    }
    {
      // Review vòng 1 (nhóm W): Admin hạ min_extension bằng SQL lúc tab đang mở. Lượt lỗi nạp lại lịch sử + auto-config (như Group UID):
      // lần bấm đầu còn bị chặn theo cấu hình đã nạp, lần bấm sau dùng mức mới; lỗi khác cũng chỉ nạp lại đúng một lần, không lặp.
      const pressOnce = async page => {
        await page.evaluate(() => { window.__extCalls = []; }); await page.locator('#sku-sync-preview').click();
        await page.waitForFunction(() => { const s = document.getElementById('sku-sync-status'); return (s.dataset.tone === 'error' || /Đối chiếu xong/.test(s.textContent)) && !document.getElementById('sku-sync-preview').disabled; });
        return { status: (await page.locator('#sku-sync-status').innerText()).trim(), calls: await page.evaluate(() => window.__extCalls) };
      };
      const countOf = (page, action) => (page.bodies || []).filter(b => b.fn === 'sku-sync' && b.action === action).length;
      let { context, page } = await open(browser, { ping: OLD, autoConfig: autoCfg(MIN(NEW)) });
      await skuReady(page);
      page.autoConfig = autoCfg(MIN(null)); // SQL hạ mức sau khi trang đã nạp cấu hình
      const before = { preview: countOf(page, 'preview'), cfg: countOf(page, 'auto-config') };
      let p = await pressOnce(page);
      assert.equal(p.status, 'Cần Extension ≥ 0.10.10 (đang v0.10.9): Reload Extension rồi tải lại tab Inside.', 'lần 1: còn chặn theo cấu hình đã nạp');
      assert.equal(countOf(page, 'preview'), before.preview, 'lần 1: không gọi preview'); assert.equal(p.calls.includes('GET_SKU_SYNC_DATA'), false, 'lần 1: không đọc Inside');
      const reloadsAfterBlock = countOf(page, 'auto-config') - before.cfg;
      p = await pressOnce(page);
      assert.match(p.status, /^Đối chiếu xong/, 'lần 2: dùng mức mới (null) nên chạy như cũ'); assert.ok(p.calls.includes('GET_SKU_SYNC_DATA'), 'lần 2: đọc Inside');
      assert.equal(countOf(page, 'preview'), before.preview + 1, 'lần 2: gọi preview'); assert.equal(page.bodies.filter(b => b.fn === 'sku-sync' && b.action === 'preview').at(-1).extVersion, OLD);
      assert.equal(reloadsAfterBlock, 1, 'lần 1 bị chặn: nạp lại auto-config đúng một lần');
      assert.deepEqual([...page.errors, ...page.consoleErrors], []); await context.close();
      // Lỗi khác (preview HTTP 500): nạp lại lịch sử + auto-config đúng một lần rồi dừng
      ({ context, page } = await open(browser, { ping: NEW, autoConfig: autoCfg(MIN(null)), failOn: { fn: 'sku-sync', actions: ['preview'] } }));
      await skuReady(page);
      const base = [countOf(page, 'history'), countOf(page, 'auto-config')];
      p = await pressOnce(page); await page.waitForTimeout(1500);
      assert.match(p.status, /HTTP 500/, 'lỗi preview vẫn hiện câu lỗi gốc sau khi nạp lại');
      assert.deepEqual([countOf(page, 'history') - base[0], countOf(page, 'auto-config') - base[1]], [1, 1], 'lỗi preview: nạp lại lịch sử + auto-config đúng một lần, không lặp');
      assert.deepEqual(page.errors, []); await context.close();
    }
    {
      // (d) bảng Máy đồng bộ: nút gọn trong ô Tự động → pop-up .as-dialog; bàn phím Enter / Space mở, Esc đóng, tiêu điểm về nút
      const { context, page } = await open(browser, { ping: '0.10.10', autoConfig: autoCfg(MIN('0.10.10'), DEVICES) });
      await skuReady(page);
      const btn = page.locator('#ss-strip-auto #ss-dev-btn'), dlg = page.locator('#ss-dev-dialog');
      const rowsOf = () => page.locator('#ss-dev-body tr').evaluateAll(trs => trs.map(tr => ({ state: tr.dataset.dev || '', cells: [...tr.cells].map(td => td.innerText.replace(/\s+/g, ' ').trim()), icons: [...tr.cells].map(td => td.querySelectorAll('svg').length) })));
      const chipsOf = () => page.locator('#ss-dev-mins .as-chip').allInnerTexts().then(a => a.map(t => t.trim()));
      const reload = async (cfg, tone, n = 3) => { page.autoConfig = cfg; await page.locator('#sku-top-refresh').click(); await page.waitForFunction(([t, n]) => { const b = document.getElementById('ss-dev-btn'); return b?.dataset.tone === t && b.querySelector('.as-dev-n')?.textContent === String(n); }, [tone, n]); };
      await btn.waitFor({ state: 'visible' });
      assert.equal(await btn.getAttribute('data-tone'), 'bad', 'có máy dưới mức: nút đỏ'); assert.equal((await btn.locator('.as-dev-n').innerText()).trim(), '3', 'số máy'); assert.equal((await btn.locator('.as-dev-badge').innerText()).trim(), '2', 'huy hiệu: số máy dưới mức');
      assert.equal(await btn.getAttribute('aria-label'), 'Máy đồng bộ: 3 máy, 2 dưới mức tối thiểu'); assert.equal(await btn.getAttribute('aria-haspopup'), 'dialog'); assert.equal(await btn.locator('svg').count(), 1, 'icon máy tính');
      assert.equal(await page.evaluate(() => document.querySelector('#ss-strip-auto button').id), 'ss-auto-toggle', 'nút Tạm dừng vẫn là nút đầu của ô Tự động');
      await btn.focus(); await page.keyboard.press('Enter'); await dlg.waitFor({ state: 'visible' });
      assert.equal(await dlg.evaluate(d => d.tagName === 'DIALOG' && d.classList.contains('as-dialog') && d.open), true, 'pop-up .as-dialog');
      assert.equal(await dlg.getAttribute('aria-labelledby'), 'ss-dev-title'); assert.equal((await page.locator('#ss-dev-title').innerText()).trim(), 'Máy đồng bộ');
      assert.deepEqual(await chipsOf(), ['Tối thiểu ≥ 0.10.10'], 'cùng một mức cho mọi loại: một chip');
      assert.deepEqual((await page.locator('#ss-dev-dialog thead th').allInnerTexts()).map(t => t.trim()), ['Máy', 'Bản', 'Lần cuối', 'Loại']);
      let rows = await rowsOf();
      assert.deepEqual(rows.map(r => r.state), ['bad', 'bad', 'ok'], 'đỏ: dưới mức hoặc chưa khai báo khi có mức');
      assert.equal(rows[0].cells[0], 'may-a #ab12'); assert.equal(rows[0].cells[1], 'v0.10.9'); assert.equal(rows[0].cells[3], 'SKU'); assert.match(rows[0].cells[2], /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \d+ phút trước$/);
      assert.equal(rows[1].cells[1], 'Chưa khai báo'); assert.equal(rows[1].cells[3], 'Group UID'); assert.equal(rows[2].cells[1], 'v0.10.10'); assert.equal(rows[2].cells[3], 'ADJ');
      assert.deepEqual(rows.map(r => r.icons[1]), [1, 1, 0], 'hàng đỏ có icon ở cột Bản (không chỉ màu)');
      assert.equal(/zz99|yy/.test(await dlg.innerText()), false, 'chỉ hiện #id4, không lộ holder');
      const red = await page.locator('#ss-dev-body tr[data-dev="bad"] .as-dev-ver').first().evaluate(v => ({ color: getComputedStyle(v).color, bg: getComputedStyle(v.closest('td')).backgroundColor }));
      assert.equal(red.color, 'rgb(180, 35, 24)', 'chữ bản hàng đỏ = --wms-danger'); assert.notEqual(red.bg, 'rgba(0, 0, 0, 0)', 'hàng đỏ có nền');
      let m = await page.evaluate(textMetrics, '#ss-dev-dialog'); assert.deepEqual(m.low, [], 'pop-up: tương phản'); assert.deepEqual(m.small, [], 'pop-up: chữ ≥ 12 px');
      await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ss-dev-btn', 'Esc đóng: tiêu điểm về nút');
      await page.keyboard.press('Space'); await dlg.waitFor({ state: 'visible' }); await page.locator('#ss-dev-dialog [data-as-close]').click(); await dlg.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'ss-dev-btn', 'nút Đóng: tiêu điểm về nút');
      // Chưa có mức nào (giai đoạn ghi nhận): chưa khai báo = vàng, không chip mức
      await reload(autoCfg(MIN(null), DEVICES), 'warn');
      assert.equal((await btn.locator('.as-dev-badge').innerText()).trim(), '1'); assert.equal(await btn.getAttribute('aria-label'), 'Máy đồng bộ: 3 máy, 1 chưa khai báo bản');
      await btn.click(); await dlg.waitFor({ state: 'visible' }); rows = await rowsOf();
      assert.deepEqual(rows.map(r => r.state), ['ok', 'warn', 'ok'], 'chưa có mức: chưa khai báo = vàng, còn lại thường'); assert.deepEqual(rows.map(r => r.icons[1]), [0, 1, 0]); assert.equal(rows[1].cells[1], 'Chưa khai báo');
      assert.equal(await page.locator('#ss-dev-body tr[data-dev="warn"] .as-dev-ver').evaluate(v => getComputedStyle(v).color), 'rgb(138, 90, 0)', 'vàng = --wms-warning');
      assert.deepEqual(await chipsOf(), [], 'chưa có mức: không chip');
      m = await page.evaluate(textMetrics, '#ss-dev-dialog'); assert.deepEqual(m.low, [], 'pop-up vàng: tương phản');
      await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden' });
      // Mức khác nhau theo loại: áp mức của loại gần nhất, loại không có mức → mức cao nhất; chip liệt kê theo loại
      await reload(autoCfg({ sku: NEW, group_uid: null, cut_adj: '0.10.8', storage_risk: null }, DEVICES.map(d => ({ ...d, version: OLD }))), 'bad');
      await btn.click(); await dlg.waitFor({ state: 'visible' }); rows = await rowsOf();
      assert.deepEqual(rows.map(r => r.state), ['bad', 'bad', 'ok'], 'SKU 0.10.9 < 0.10.10; Group UID không có mức → mức cao nhất 0.10.10; ADJ 0.10.9 ≥ 0.10.8');
      assert.deepEqual(await chipsOf(), ['SKU ≥ 0.10.10', 'ADJ ≥ 0.10.8'], 'mức khác nhau: liệt kê theo loại');
      await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden' });
      // Đủ bản: nút thường, không huy hiệu
      await reload(autoCfg(MIN(NEW), DEVICES.map(d => ({ ...d, version: NEW }))), '');
      assert.equal(await btn.locator('.as-dev-badge').count(), 0); assert.equal(await btn.getAttribute('aria-label'), 'Máy đồng bộ: 3 máy');
      // Không có máy: nút "0" (không mờ bằng opacity), pop-up có trạng thái rỗng
      await reload(autoCfg(MIN(null), []), '', 0);
      assert.equal((await btn.locator('.as-dev-n').innerText()).trim(), '0'); assert.equal(await btn.getAttribute('data-zero'), 'true'); assert.equal(await btn.evaluate(b => getComputedStyle(b).opacity), '1');
      await btn.click(); await dlg.waitFor({ state: 'visible' }); assert.equal((await page.locator('#ss-dev-body').innerText()).trim(), 'Chưa có máy trong 14 ngày');
      await page.keyboard.press('Escape'); await dlg.waitFor({ state: 'hidden' });
      assert.deepEqual([...page.errors, ...page.consoleErrors], []); await context.close();
    }
    // Khối dùng chung chép giống hệt ở hai màn (hai khối script riêng)
    {
      const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
      const copies = [...html.matchAll(/\/\/ >>> bảng Máy đồng bộ[\s\S]*?\/\/ <<< bảng Máy đồng bộ/g)];
      assert.equal(copies.length, 2, 'khối "bảng Máy đồng bộ" có đúng 2 bản (Đồng bộ SKU + Đồng bộ Group UID)');
      assert.equal(copies[0][0], copies[1][0], 'hai bản khối "bảng Máy đồng bộ" phải giống hệt từng ký tự');
      const inside = (id, at) => { const start = html.indexOf(`<script id="${id}">`); return start >= 0 && at > start && at < html.indexOf('</script>', start); };
      assert.ok(inside('sku-sync-admin-script', copies[0].index), 'bản 1 nằm trong sku-sync-admin-script');
      assert.ok(inside('group-uid-sync-admin-script', copies[1].index), 'bản 2 nằm trong group-uid-sync-admin-script');
    }
    console.log('PASS cổng bản Extension (Đồng bộ SKU: extVersion trong preview, dừng trước khi đọc Inside khi dưới mức, so từng đoạn số) + bảng Máy đồng bộ (đỏ / vàng / thường, bàn phím, chỉ #id4) + khối dùng chung giống hệt hai màn');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
