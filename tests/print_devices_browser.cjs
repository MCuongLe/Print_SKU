// Thiết bị in (hướng C, 10/10/2026): máy chưa kích hoạt thấy ô KÍCH HOẠT MÁY ở trang chủ, nhập mã chung + tên máy → nhận khoá
// riêng (localStorage tb-khoa), ô biến mất; máy chủ từ chối (ACCESS_DENIED) thì hộp tự mở; màn Admin #admin/thiet-bi có mục menu
// ở mọi thanh bên, liệt kê máy / khoá chung cũ, tạo mã 30 phút, tắt máy (hộp xác nhận), tắt khoá chung.
// Run against python -m http.server 8000. Supabase giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const TOKEN = 'pd_' + 'ab'.repeat(24);
const ago = m => new Date(Date.now() - m * 60000).toISOString();

const mock = (page, state) => page.route('**/*', async route => {
  const url = route.request().url();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
  if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
  const body = JSON.parse(route.request().postData() || '{}');
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (rpc) state.calls.push({ rpc, body });
  const ok = data => json({ ok: true, data });
  const deny = () => json({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Máy này chưa được kích hoạt in' } });
  if (rpc === 'print_queue_status') return body.p_access_token === TOKEN || !state.legacyOff ? ok({ queued: 0, queuedCopies: 0, active: 0, agents: [] }) : deny();
  if (rpc === 'print_device_activate') {
    if (body.p_code !== 'ABCD2345') return json({ ok: false, error: { code: 'INVALID_CODE', message: 'Mã không đúng hoặc đã hết hạn' } });
    return ok({ token: TOKEN, device: { id: 'd-new', name: body.p_name, activatedAt: new Date().toISOString() } });
  }
  if (rpc === 'print_devices_admin') return ok({
    devices: [
      { id: 'd1', name: 'Máy kho 01', enabled: true, activatedAt: ago(600), lastSeenAt: ago(1), lastPrintAt: ago(30), printCount: 42, jobsToday: 5, userAgent: 'Mozilla/5.0 (Linux; Android 12) Chrome' },
      { id: 'd2', name: 'PDA cũ', enabled: false, activatedAt: ago(3000), lastSeenAt: ago(2000), lastPrintAt: null, printCount: 3, jobsToday: 0, userAgent: '' }],
    codes: state.code ? [{ id: 'c1', note: '', createdAt: ago(1), expiresAt: state.code.expiresAt, revokedAt: null, useCount: 1, active: true }] : [],
    legacyKeys: [{ name: 'legacy-public', enabled: !state.legacyOff, createdAt: ago(9000), isPublic: true }], now: new Date().toISOString() });
  if (rpc === 'print_activation_create') { state.code = { id: 'c1', code: 'ABCD-2345', expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), minutes: body.p_minutes }; return ok(state.code); }
  if (rpc === 'print_activation_revoke') { state.code = null; return ok({ id: body.p_id, revoked: true }); }
  if (rpc === 'print_device_set_enabled') return ok({ id: body.p_id, enabled: body.p_enabled });
  if (rpc === 'print_access_key_set_enabled') { state.legacyOff = !body.p_enabled; return ok({ name: body.p_name, enabled: body.p_enabled }); }
  if (rpc === 'sku_combo_lookup') return json([]);
  if (url.includes('/rest/v1/') && !rpc) return json([]);
  return ok({ agents: [], jobs: [], items: [] });
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // --- Nhân viên: trang chủ + hộp kích hoạt (375 px và 1280 px)
    for (const width of [375, 1280]) {
      const context = await browser.newContext({ viewport: { width, height: 812 } });
      const page = await context.newPage();
      const state = { calls: [], code: null, legacyOff: false };
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await mock(page, state);
      await page.goto(BASE + '#home');
      const card = page.locator('#barcode-activate');
      await card.waitFor({ state: 'visible' });
      assert.equal((await card.textContent()).replace(/\s+/g, ' ').trim(), 'KÍCH HOẠT MÁY');
      assert.ok(await card.evaluate(el => el.nextElementSibling?.id === 'barcode-admin'), 'ô kích hoạt đứng trước ô Quản trị');
      assert.equal(await page.evaluate(() => window.PrintSkuQueue.accessToken()), 'public', 'chưa kích hoạt → gửi khoá chuyển tiếp');
      await card.click();
      const dialog = page.locator('#pdv-dialog');
      await dialog.waitFor({ state: 'visible' });
      await page.locator('#pdv-code').fill('abcd2345');
      assert.equal(await page.locator('#pdv-code').inputValue(), 'ABCD-2345', 'mã tự viết hoa + gạch nối');
      await page.locator('#pdv-name').fill('  Máy   thử  ');
      await page.locator('#pdv-ok').click();
      await page.locator('#pdv-status[data-tone="ok"]').waitFor();
      await dialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => localStorage.getItem('tb-khoa')), TOKEN, 'khoá riêng đã lưu');
      assert.equal(await page.evaluate(() => localStorage.getItem('nds-ten-may')), 'Máy thử', 'tên máy gọn, lưu cho Cấu hình');
      assert.equal(await page.evaluate(() => window.PrintSkuQueue.accessToken()), TOKEN);
      assert.equal(await card.isHidden(), true, 'đã kích hoạt → ẩn ô');
      const act = state.calls.find(c => c.rpc === 'print_device_activate');
      assert.equal(act.body.p_code, 'ABCD2345'); assert.equal(act.body.p_name, 'Máy thử');
      // Mã sai → báo lỗi, hộp còn mở
      await page.evaluate(() => { localStorage.removeItem('tb-khoa'); window.PrintSkuDevice.open(); });
      await page.locator('#pdv-code').fill('ZZZZ9999'); await page.locator('#pdv-name').fill('X'); await page.locator('#pdv-ok').click();
      await page.locator('#pdv-status[data-tone="error"]').waitFor();
      assert.match(await page.locator('#pdv-status').textContent(), /không đúng|hết hạn/);
      await page.locator('#pdv-cancel').click();
      // Máy chủ từ chối → hộp tự mở (một lần mỗi phút)
      state.legacyOff = true;
      await page.evaluate(() => window.PrintSkuQueue.queueStatus());
      await dialog.waitFor({ state: 'visible' });
      assert.match(await page.locator('#pdv-status').textContent(), /chưa được kích hoạt/);
      assert.deepEqual(errors, [], 'không lỗi JS');
      console.log(`PASS ${width}px: ô KÍCH HOẠT MÁY, hộp nhập mã, lưu khoá, ẩn ô, mã sai, tự mở khi bị từ chối`);
      await context.close();
    }

    // --- Admin: màn Thiết bị in (desktop)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    // Máy của Admin đã kích hoạt sẵn (nếu không, tắt khoá chung sẽ làm hộp kích hoạt tự mở — đúng hành vi, nhưng che menu trong test).
    await context.addInitScript(({ key, token }) => { sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })); localStorage.setItem('tb-khoa', token); localStorage.setItem('nds-ten-may', 'Máy Admin'); }, { key: SESSION_KEY, token: TOKEN });
    const page = await context.newPage();
    const state = { calls: [], code: null, legacyOff: false };
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await mock(page, state);
    await page.goto(BASE + '#admin/thiet-bi');
    const screen = page.locator('#print-devices-screen');
    await screen.waitFor({ state: 'visible' });
    await page.locator('#pdm-body tr[data-id="d1"]').waitFor();
    assert.equal(await page.locator('#pdm-m-on').textContent(), '1'); assert.equal(await page.locator('#pdm-m-off').textContent(), '1');
    assert.equal(await page.locator('#pdm-m-jobs').textContent(), '5');
    assert.equal((await page.locator('#pdm-legacy-switch').textContent()).trim(), 'Đang bật');
    assert.equal(await page.locator('#pdm-code').isHidden(), true, 'chưa có mã');
    // Thứ tự menu thanh bên tĩnh: Thiết bị in ngay trước Cấu hình
    const names = await page.locator('#print-devices-screen .ss-nav button').allTextContents();
    assert.deepEqual(names.map(t => t.trim()), ['Lệnh in', 'Đồng bộ SKU', 'Đồng bộ Group UID', 'Kiểm kê SKU', 'Thiết bị in', 'Cấu hình']);
    // Tạo mã 30 phút
    await page.locator('#pdm-create').click();
    await page.locator('#pdm-code:not([hidden])').waitFor();
    assert.equal(await page.locator('#pdm-code-text').textContent(), 'ABCD-2345');
    assert.match(await page.locator('#pdm-code-exp').textContent(), /còn (29|30) phút · đã kích hoạt 1 máy/);
    assert.equal(state.calls.find(c => c.rpc === 'print_activation_create').body.p_minutes, 30);
    assert.equal(await page.locator('#pdm-m-codes').textContent(), '1');
    // Tắt máy: hộp xác nhận → RPC
    await page.locator('#pdm-body tr[data-id="d1"] button[data-act="toggle"]').click();
    const whd = page.locator('dialog.whd'); await whd.waitFor({ state: 'visible' });
    assert.match(await whd.locator('.whd-title').textContent(), /Tắt máy Máy kho 01/);
    await whd.locator('.whd-ok').click();
    await page.waitForFunction(() => window.__x = true);
    await page.waitForTimeout(300);
    const off = state.calls.find(c => c.rpc === 'print_device_set_enabled');
    assert.deepEqual(off.body, { p_id: 'd1', p_enabled: false });
    // Bật máy đã tắt: không hỏi
    await page.locator('#pdm-body tr[data-id="d2"] button[data-act="toggle"]').click();
    await page.waitForTimeout(300);
    assert.ok(state.calls.some(c => c.rpc === 'print_device_set_enabled' && c.body.p_id === 'd2' && c.body.p_enabled === true));
    // Thu hồi mã
    await page.locator('#pdm-code-revoke').click();
    await page.locator('#pdm-code[hidden]').waitFor({ state: 'attached' });
    assert.ok(state.calls.some(c => c.rpc === 'print_activation_revoke' && c.body.p_id === 'c1'));
    // Tắt khoá chung: xác nhận → RPC → nhãn đổi
    await page.locator('#pdm-legacy-switch').click();
    await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
    await page.waitForFunction(() => document.getElementById('pdm-legacy-switch').textContent.trim() === 'Đã tắt');
    assert.ok(state.calls.some(c => c.rpc === 'print_access_key_set_enabled' && c.body.p_name === 'legacy-public' && c.body.p_enabled === false));
    // Menu ở màn khác (Lệnh in) và thanh bên React (Cấu hình) có "Thiết bị in" trước "Cấu hình"
    await page.locator('#print-devices-screen .ss-nav [data-admin-hash="#admin/lenh-in"]').click();
    await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
    assert.equal(await screen.isHidden(), true);
    const pj = await page.locator('#print-jobs-screen .ss-nav button').allTextContents();
    assert.deepEqual(pj.map(t => t.trim()).slice(-2), ['Thiết bị in', 'Cấu hình']);
    await page.locator('#print-jobs-screen .ss-nav [data-admin-hash="#admin/cauhinh"]').click();
    await page.locator('#root aside nav [data-print-devices-nav]').waitFor();
    const react = await page.locator('#root aside nav button').allTextContents();
    const idx = react.map(t => t.trim()).indexOf('Thiết bị in');
    assert.ok(idx >= 0 && react[idx + 1].trim() === 'Cấu hình', `React nav: ${react.join(' | ')}`);
    await page.locator('#root aside nav [data-print-devices-nav]').click();
    await screen.waitFor({ state: 'visible' });
    assert.deepEqual(errors, [], 'không lỗi JS');
    console.log('PASS admin 1280px: Thiết bị in — menu, danh sách, tạo/thu hồi mã, tắt/bật máy, tắt khoá chung');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
