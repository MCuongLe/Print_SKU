// Chuyển mục Admin mượt (11/10/2026): đã xác nhận Admin trong phiên và token JWT còn hạn thì bấm menu hiện màn mới ngay khung hình kế
// tiếp (trước đây chờ 2 lượt gọi mạng kiểm quyền nên lộ nền đen 0,2–0,6 giây); quay lại Đồng bộ SKU / Group UID không khoá nút, tải lại
// ngầm; token hết hạn thì vẫn kiểm lại qua mạng. Icon "Kiểm kê SKU" trong menu màn Cấu hình (React) đúng cỡ (20 px theo thang icon), không thành khối đen.
// Supabase, Edge Function và Extension đều giả lập (trễ 300 ms). Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = expSec => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '00000000-0000-0000-0000-000000000001', exp: expSec })}.sig`;
const ago = m => new Date(Date.now() - m * 60000).toISOString();
const fakeExtension = () => addEventListener('message', event => {
  const r = event.data; if (!r || r.source !== 'PRINT_SKU_APP') return;
  postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: r.requestId, ok: true, data: { version: '0.7.1', rows: [], total: 0, totalPages: 1, page: 1 } }, location.origin);
});

async function open(browser, token) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(t => sessionStorage.setItem('print-sku-admin-session-v1', JSON.stringify({ access_token: t, refresh_token: 'r' })), token);
  await context.addInitScript(fakeExtension);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    await new Promise(resolve => setTimeout(resolve, 300));
    if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
    if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Admin', role: 'admin' }]);
    if (/\/functions\/v1\//.test(url)) return json({ ok: true, data: { runs: [], lastSuccessAt: ago(100), lastSnapshotAt: ago(100), state: { last_successful_incremental_at: ago(90), last_successful_full_at: ago(900) } } });
    if (url.includes('print_admin_jobs')) return json({ ok: true, data: { day: '2026-10-11', today: '2026-10-11', oldestDay: '2026-10-08', summary: { jobs: 0, copies: 0, failed: 0, active: 0 }, counts: { all: 0, sku: 0, group_uid: 0, other: 0 }, jobs: [] } });
    if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [], devices: [] } });
  });
  return { context, page, errors };
}

// Bấm mục menu, đợi hashchange rồi đo ở khung hình vẽ kế tiếp: màn nào đang phủ giữa màn hình, thanh tiến trình có chạy không
const clickAndMeasure = (page, label) => page.evaluate(async text => {
  const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const btn = [...document.querySelectorAll('.ss-side nav button, #root aside nav button')].find(b => vis(b) && b.textContent.trim() === text);
  const changed = new Promise(resolve => { addEventListener('hashchange', resolve, { once: true }); setTimeout(resolve, 1000); });
  btn.click();
  await changed;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const hit = document.elementFromPoint(760, 420), screen = hit && hit.closest('.ss-screen, #root');
  return { screen: screen ? (screen.id || 'root') : (hit ? hit.tagName : 'none'), busy: [...document.querySelectorAll('.ss-progress[data-busy=true]')].filter(vis).length };
}, label);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // --- Token còn hạn: chuyển mục không chờ mạng ---
    let { context, page, errors } = await open(browser, jwt(Math.floor(Date.now() / 1000) + 3600));
    await page.goto(BASE + '#admin/lenh-in');
    await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    for (const [label, id] of [['Đồng bộ SKU', 'sku-sync-screen'], ['Đồng bộ Group UID', 'group-uid-sync-screen'], ['Kiểm kê SKU', 'inventory-audit-screen'], ['Cấu hình', 'root'], ['Lệnh in', 'print-jobs-screen']]) {
      const m = await clickAndMeasure(page, label);
      assert.equal(m.screen, id, `${label}: khung hình đầu đã là màn mới (thấy ${m.screen}, không được lộ nền)`);
      await page.waitForTimeout(700);
    }
    const fast = await page.evaluate(async () => { const t = performance.now(); await window.PrintSkuAdminAccess.getToken(); return performance.now() - t; });
    assert.ok(fast < 50, `đã là Admin + token còn hạn: getToken trả ngay, không chờ mạng (${Math.round(fast)} ms)`);

    // Quay lại màn đã mở: không khoá nút / không chạy thanh tải
    for (const [label, id] of [['Đồng bộ SKU', 'sku-sync-screen'], ['Cấu hình', 'root'], ['Đồng bộ SKU', 'sku-sync-screen'], ['Đồng bộ Group UID', 'group-uid-sync-screen'], ['Lệnh in', 'print-jobs-screen'], ['Đồng bộ Group UID', 'group-uid-sync-screen']]) {
      const m = await clickAndMeasure(page, label);
      assert.equal(m.screen, id);
      if (id !== 'root' && id !== 'print-jobs-screen') assert.equal(m.busy, 0, `${label}: quay lại không khoá nút, tải lại ngầm`);
      await page.waitForTimeout(500);
    }
    assert.equal(await page.locator('#sku-sync-preview').isDisabled(), false);

    // Icon menu "Kiểm kê SKU" trong màn Cấu hình (React)
    await clickAndMeasure(page, 'Cấu hình');
    const icon = await page.evaluate(() => { const b = [...document.querySelectorAll('#root aside nav button')].find(e => e.textContent.trim() === 'Kiểm kê SKU'); const s = b.querySelector('svg').getBoundingClientRect(); return { w: Math.round(s.width), h: Math.round(s.height), btn: Math.round(b.getBoundingClientRect().height), fill: getComputedStyle(b.querySelector('svg')).fill }; });
    assert.deepEqual([icon.w, icon.h], [20, 20], 'icon Kiểm kê SKU 20 px (thang icon đợt 3)');
    assert.equal(icon.fill, 'none', 'icon nét, không tô đen');
    const ref = await page.evaluate(() => Math.round([...document.querySelectorAll('#root aside nav button')].find(e => e.textContent.trim() === 'Cấu hình').getBoundingClientRect().height));
    assert.equal(icon.btn, ref, 'dòng Kiểm kê SKU cao bằng các mục khác');
    assert.deepEqual(errors, []);
    await context.close();

    // --- Token hết hạn: vẫn kiểm lại qua mạng trước khi hiện màn ---
    ({ context, page, errors } = await open(browser, jwt(Math.floor(Date.now() / 1000) - 60)));
    await page.goto(BASE + '#admin/lenh-in');
    await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
    await page.waitForTimeout(800);
    const slow = await page.evaluate(async () => { const t = performance.now(); const token = await window.PrintSkuAdminAccess.getToken(); return { ms: performance.now() - t, ok: Boolean(token) }; });
    assert.ok(slow.ms >= 250 && slow.ok, `token hết hạn: getToken kiểm quyền lại qua mạng (${Math.round(slow.ms)} ms)`);
    await page.locator('.ss-side nav button:visible', { hasText: 'Đồng bộ SKU' }).click();
    await page.locator('#sku-sync-screen').waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS 1280px: chuyển mục Admin hiện màn mới ngay khung hình kế tiếp, getToken không chờ mạng khi token còn hạn, quay lại không khoá nút, token hết hạn vẫn kiểm lại, icon Kiểm kê SKU 20 px');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
