// Thiết bị in (hướng C, 10–11/10/2026): máy chưa kích hoạt thấy ô KÍCH HOẠT MÁY ở trang chủ, nhập mã chung + tên máy → nhận khoá
// riêng (localStorage tb-khoa), ô biến mất; máy chủ từ chối (ACCESS_DENIED) thì hộp tự mở. Admin: tab "Thiết bị" trong màn Lệnh in
// (#admin/lenh-in/thiet-bi; route cũ #admin/thiet-bi chuyển hướng): thẻ số lọc, tạo/chép/thu hồi mã 30 phút, bảng UI.createList
// (tìm, sắp xếp, CSV), popup máy (lệnh in hôm nay, đổi tên, tắt có xác nhận), khoá chung cũ; cột Nguồn của Lệnh in hiện tên máy.
// Run against python -m http.server 8000. Supabase giả lập, không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const TOKEN = 'pd_' + 'ab'.repeat(24);
const ago = m => new Date(Date.now() - m * 60000).toISOString();
const JOB = { id: 'aaaa1111-0000-4000-8000-000000000001', type: 'sku', kind: 'sku', status: 'completed', copies: 6, itemCount: 2, first: { sku: '900000001', productName: 'Vải mẫu A/100% Cotton' }, source: 'Máy kho', deviceId: 'd1', deviceName: 'Máy kho 01', createdAt: ago(30), completedAt: ago(29) };

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
  if (rpc === 'print_admin_jobs') return ok({ day: '2026-10-11', today: '2026-10-11', device: body.p_device || null, oldestDay: '2026-10-08', summary: { jobs: 1, copies: 6, failed: 0, active: 0 }, counts: { all: 1, sku: 1, group_uid: 0, other: 0 }, jobs: body.p_device && body.p_device !== 'd1' ? [] : [JOB] });
  if (rpc === 'print_admin_job') return ok({ ...JOB, items: [{ index: 0, sku: '900000001', productName: 'Vải mẫu A', copies: 6 }], reprints: [], reprint: { allowed: true, partial: false } });
  if (rpc === 'print_devices_admin') return ok({
    devices: [
      { id: 'd1', name: state.d1name || 'Máy kho 01', enabled: state.d1on !== false, activatedAt: ago(600), lastSeenAt: ago(1), lastPrintAt: ago(30), printCount: 42, jobsToday: 5, userAgent: 'Mozilla/5.0 (Linux; Android 12) Chrome' },
      { id: 'd2', name: 'PDA cũ', enabled: false, activatedAt: ago(3000), lastSeenAt: ago(2000), lastPrintAt: null, printCount: 3, jobsToday: 0, userAgent: '' }],
    codes: state.code ? [{ id: 'c1', note: '', createdAt: ago(1), expiresAt: state.code.expiresAt, revokedAt: null, useCount: 1, active: true }] : [],
    legacyKeys: [{ name: 'legacy-public', enabled: !state.legacyOff, createdAt: ago(9000), isPublic: true }], now: new Date().toISOString() });
  if (rpc === 'print_activation_create') { state.code = { id: 'c1', code: 'ABCD-2345', expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), minutes: body.p_minutes }; return ok(state.code); }
  if (rpc === 'print_activation_revoke') { state.code = null; return ok({ id: body.p_id, revoked: true }); }
  if (rpc === 'print_device_set_enabled') { if (body.p_id === 'd1') state.d1on = body.p_enabled; return ok({ id: body.p_id, enabled: body.p_enabled }); }
  if (rpc === 'print_device_rename') { if (body.p_id === 'd1') state.d1name = body.p_name; return ok({ id: body.p_id, name: body.p_name }); }
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
      await page.evaluate(() => { localStorage.removeItem('tb-khoa'); window.PrintSkuDevice.open(); });
      await page.locator('#pdv-code').fill('ZZZZ9999'); await page.locator('#pdv-name').fill('X'); await page.locator('#pdv-ok').click();
      await page.locator('#pdv-status[data-tone="error"]').waitFor();
      assert.match(await page.locator('#pdv-status').textContent(), /không đúng|hết hạn/);
      await page.locator('#pdv-cancel').click();
      state.legacyOff = true;
      await page.evaluate(() => window.PrintSkuQueue.queueStatus());
      await dialog.waitFor({ state: 'visible' });
      assert.match(await page.locator('#pdv-status').textContent(), /chưa được kích hoạt/);
      assert.deepEqual(errors, [], 'không lỗi JS');
      console.log(`PASS ${width}px: ô KÍCH HOẠT MÁY, hộp nhập mã, lưu khoá, ẩn ô, mã sai, tự mở khi bị từ chối`);
      await context.close();
    }

    // --- Admin: tab Thiết bị trong Lệnh in (desktop)
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(({ key, token }) => { sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })); localStorage.setItem('tb-khoa', token); localStorage.setItem('nds-ten-may', 'Máy Admin'); }, { key: SESSION_KEY, token: TOKEN });
    const page = await context.newPage();
    const state = { calls: [], code: null, legacyOff: false };
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await mock(page, state);
    // Route cũ chuyển hướng sang tab
    await page.goto(BASE + '#admin/thiet-bi');
    await page.waitForFunction(() => location.hash === '#admin/lenh-in/thiet-bi');
    const screen = page.locator('#print-jobs-screen'), panel = page.locator('#pdm-panel');
    await screen.waitFor({ state: 'visible' }); await panel.waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-pj-tab="devices"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#pj-jobs-panel').isHidden(), true, 'phần Lệnh in ẩn khi ở tab Thiết bị');
    assert.equal(await page.locator('#print-jobs-screen .pj-stats').isHidden(), true);
    assert.equal((await page.locator('#print-jobs-heading').textContent()).trim(), 'Thiết bị in');
    // Menu Admin (nhóm Quản trị ở thanh trái chung) về 5 mục, không còn "Thiết bị in"
    await page.locator('#app-nav [data-an-hash]').first().waitFor();
    const names = await page.locator('#app-nav [data-an-hash]').evaluateAll(list => list.map(b => b.getAttribute('aria-label')));
    assert.deepEqual(names, ['Lệnh in', 'Đồng bộ SKU', 'Đồng bộ Group UID', 'Kiểm kê SKU', 'Cấu hình']);
    await page.locator('#pdm-body tr[data-pdm-id="d1"]').waitFor();
    assert.equal(await page.locator('#pdm-m-on').textContent(), '1'); assert.equal(await page.locator('#pdm-m-off').textContent(), '1');
    assert.equal(await page.locator('#pdm-m-jobs').textContent(), '5');
    assert.equal(await page.locator('#pj-tab-devices-count').textContent(), '1', 'số máy đang bật trên tab');
    assert.equal((await page.locator('#pdm-this').textContent()).trim(), 'Máy Admin');
    assert.equal(await page.locator('#pdm-codebox').isHidden(), true, 'chưa có mã');
    assert.equal(await page.locator('#pdm-legacy').getAttribute('aria-pressed'), 'true');
    // Thẻ số lọc bảng
    await page.locator('button.ss-metric[data-pdm-filter="off"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#pdm-body tr[data-pdm-id]').length === 1);
    assert.equal(await page.locator('#pdm-body tr[data-pdm-id]').getAttribute('data-pdm-id'), 'd2');
    assert.equal((await page.locator('#pdm-list-title').textContent()).trim(), 'Máy đã tắt');
    await page.locator('button.ss-metric[data-pdm-filter="all"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#pdm-body tr[data-pdm-id]').length === 2);
    // Bộ công cụ chung: tìm + CSV có mặt
    assert.equal(await page.locator('#pdm-tools').isHidden(), false, 'bộ công cụ bảng hiện');
    // Tạo mã 30 phút → chép → thu hồi
    await page.locator('#pdm-create').click();
    await page.locator('#pdm-codebox:not([hidden])').waitFor();
    assert.equal(await page.locator('#pdm-code-text').textContent(), 'ABCD-2345');
    assert.match(await page.locator('#pdm-code-sub').textContent(), /Còn (29|30) phút .* đã kích hoạt 1 máy/);
    assert.equal(state.calls.find(c => c.rpc === 'print_activation_create').body.p_minutes, 30);
    assert.equal(await page.locator('#pdm-m-codes').textContent(), '1');
    await page.locator('#pdm-code-revoke').click();
    await page.locator('#pdm-codebox[hidden]').waitFor({ state: 'attached' });
    assert.ok(state.calls.some(c => c.rpc === 'print_activation_revoke' && c.body.p_id === 'c1'));
    // Popup máy: lệnh in hôm nay của máy, đổi tên, tắt có xác nhận, mở lệnh in sẵn có
    await page.locator('#pdm-body tr[data-pdm-id="d1"]').click();
    const dlg = page.locator('#pdm-dialog'); await dlg.waitFor({ state: 'visible' });
    assert.equal((await page.locator('#pdm-d-title').textContent()).trim(), 'Máy kho 01');
    await page.locator('#pdm-d-jobs [data-pdm-job]').waitFor();
    assert.ok(state.calls.some(c => c.rpc === 'print_admin_jobs' && c.body.p_device === 'd1'), 'lọc lệnh in theo máy');
    assert.equal((await page.locator('#pdm-d-jobs-count').textContent()).trim(), '1');
    await page.locator('#pdm-d-rename').fill('Máy kho 01 - quầy'); await page.locator('#pdm-d-save').click();
    await page.waitForFunction(() => document.getElementById('pdm-d-title').textContent.trim() === 'Máy kho 01 - quầy');
    assert.ok(state.calls.some(c => c.rpc === 'print_device_rename' && c.body.p_name === 'Máy kho 01 - quầy'));
    await page.locator('#pdm-d-toggle').click();
    const whd = page.locator('dialog.whd'); await whd.waitFor({ state: 'visible' });
    assert.match(await whd.locator('.whd-title').textContent(), /Tắt máy/);
    await whd.locator('.whd-ok').click();
    await page.waitForFunction(() => document.getElementById('pdm-d-toggle').textContent.trim() === 'Bật máy');
    assert.ok(state.calls.some(c => c.rpc === 'print_device_set_enabled' && c.body.p_id === 'd1' && c.body.p_enabled === false));
    await page.locator('#pdm-d-jobs [data-pdm-job]').click();
    await page.locator('#pj-dialog').waitFor({ state: 'visible' });
    assert.ok(state.calls.some(c => c.rpc === 'print_admin_job'), 'mở popup lệnh in sẵn có từ popup máy');
    await page.locator('#pj-d-close').click(); await page.locator('#pj-dialog').waitFor({ state: 'hidden' });
    await page.locator('#pdm-dialog [data-as-close]').click(); await dlg.waitFor({ state: 'hidden' });
    // Tắt khoá chung: xác nhận → RPC → nhãn đổi
    await page.locator('#pdm-legacy').click();
    await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
    await page.waitForFunction(() => document.getElementById('pdm-legacy').getAttribute('aria-pressed') === 'false');
    assert.ok(state.calls.some(c => c.rpc === 'print_access_key_set_enabled' && c.body.p_name === 'legacy-public' && c.body.p_enabled === false));
    // Chuyển tab Lệnh in bằng bàn phím và chuột: hash đổi, phần Lệnh in hiện, cột Nguồn hiện tên máy
    await page.locator('[data-pj-tab="devices"]').focus(); await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => location.hash === '#admin/lenh-in');
    await page.locator('#pj-jobs-panel').waitFor({ state: 'visible' });
    assert.equal(await panel.isHidden(), true);
    assert.equal((await page.locator('#print-jobs-heading').textContent()).trim(), 'Lệnh in');
    await page.locator('#pj-list .pj-row[data-job]').waitFor();
    assert.match(await page.locator('#pj-list .pj-row[data-job] .pj-src').textContent(), /Máy kho 01/, 'Nguồn = tên máy');
    await page.locator('[data-pj-tab="devices"]').click();
    await page.waitForFunction(() => location.hash === '#admin/lenh-in/thiet-bi');
    await panel.waitFor({ state: 'visible' });
    // Thanh bên React (Cấu hình; máy tính ẩn vì đã có thanh trái chung) không có "Thiết bị in"
    await page.locator('#app-nav [data-an-hash="#admin/cauhinh"]').click();
    await page.locator('#root aside nav button').first().waitFor({ state: 'attached' });
    const react = (await page.locator('#root aside nav button').allTextContents()).map(t => t.trim());
    assert.ok(!react.includes('Thiết bị in'), `React nav: ${react.join(' | ')}`);
    assert.deepEqual(errors, [], 'không lỗi JS');
    console.log('PASS admin 1280px: tab Thiết bị trong Lệnh in — route cũ chuyển hướng, thẻ số lọc, mã 30 phút, popup máy, tắt khoá chung, Nguồn = tên máy');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
