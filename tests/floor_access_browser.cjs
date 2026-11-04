// Khoá máy cho nhóm ghi ở xưởng (17/10/2026, giao diện): lệnh GHI của Cấp vải và Xả vải gửi p_access_token (lệnh ĐỌC thì không;
// Xả vải từ 04/11/2026 là luồng mét thực tế → phiếu A4: ghi = xa_vai_measure_save / _delete, đọc = _lookup / _list / _search);
// phản hồi accessWarning → thanh vàng "Máy chưa kích hoạt" (không chặn, nút Kích hoạt mở hộp, tối đa 1 lần/10 phút);
// ACCESS_DENIED → hộp Kích hoạt máy mở, không cập nhật danh sách. Admin: thẻ "Khoá máy xưởng" trong tab Thiết bị (chế độ, bảng 7 ngày
// theo hàm, chuyển chế độ có xác nhận); RPC chưa có thì thẻ ẩn, tab vẫn chạy. Supabase giả lập, chạy với python -m http.server 8000.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const TOKEN = 'pd_' + 'ab'.repeat(24);
const UID = '1028260000000001', SKU = '900000001';
const SHOTS = process.env.FLOOR_SHOTS || '';
const shot = (page, name) => SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png` }) : Promise.resolve();
const ago = m => new Date(Date.now() - m * 60000).toISOString();

const LINE = { id: 'l1', no: 1, sku: SKU, lot: 'L1', roll: '1', groupUid: UID, qtyM: 100, state: 'matched', scannedAt: null, location: 'A-01' };
const PLAN = { id: 'p1', name: 'Đợt thử', status: 'open', scanned: 0, total: 1, matched: 1, qtyTotal: 100, poNo: '10012600000001', createdAt: ago(60) };
// Xả vải theo CONTRACT V2 + V3 (04/11/2026): đơn vị mm nguyên (systemMm / actualMm / p_actual_mm), item có printJobId + itemCode;
// save / list không còn p_sku (gửi p_sku = chữ ký cũ → PostgREST 404).
const XV_ITEM = { groupUid: UID, sku: SKU, itemCode: null, lot: 'L1', roll: '1', systemMm: 60000, actualMm: 59500, measuredAt: ago(10), status: 'pending', printedAt: null, printJobId: null };

// Máy chủ giả: state.mode = 'ok' | 'warn' | 'deny' cho các lệnh GHI; ghi lại mọi lệnh gọi.
const mockFloor = async (page, state) => page.route('**/*', async route => {
  const url = route.request().url();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (!rpc) return json([]);
  const body = route.request().postDataJSON?.() || {};
  state.calls.push({ rpc, body });
  const ok = (data, extra = {}) => json({ ok: true, data, ...extra });
  const write = data => {
    if (state.mode === 'deny') return json({ ok: false, error: { code: 'ACCESS_DENIED', message: 'Máy chưa kích hoạt; vào ô KÍCH HOẠT MÁY.' } });
    return ok(data, state.mode === 'warn' ? { accessWarning: true } : {});
  };
  if (rpc === 'fabric_issue_list') return ok({ plans: [state.plan] });
  if (rpc === 'fabric_issue_get') return ok({ plan: state.plan, lines: [state.line], products: {} });
  if (rpc === 'fabric_issue_scan') {
    const scanned = { ...state.line, scannedAt: new Date().toISOString(), scannedBy: 'Máy thử' };
    return write({ result: 'issued', line: scanned, plan: { ...state.plan, scanned: 1 } });
  }
  const noFn = () => json({ code: 'PGRST202', message: `Could not find the function public.${rpc}` }, 404);
  if (rpc === 'xa_vai_measure_list') return 'p_sku' in body ? noFn() : ok({ items: state.open, total: state.open.length });
  if (rpc === 'xa_vai_measure_search') return ok({ items: [], total: 0, truncated: false });
  if (rpc === 'xa_vai_measure_lookup') return ok({ groupUid: body.p_group_uid, sku: SKU, productName: 'Vải thử', itemCode: null, lot: 'L1', roll: '1', uidStatus: 'Available', systemQty: 1000, systemMm: 60000, state: 'new', actualMm: null, measuredAt: null, printedAt: null, printJobId: null });
  if (rpc === 'xa_vai_measure_save') return 'p_sku' in body ? noFn() : write({ item: { ...XV_ITEM, groupUid: body.p_group_uid, actualMm: body.p_actual_mm }, replaced: false });
  if (rpc === 'xa_vai_measure_delete') { const r = write({ groupUid: body.p_group_uid }); if (state.mode !== 'deny') state.open = []; return r; }
  return json({ ok: true, data: {} });
});

const withToken = (calls, rpc) => calls.filter(c => c.rpc === rpc);
const bar = page => page.locator('#floor-access-bar');
const waitCalls = async (state, rpc, n) => { for (let i = 0; i < 100 && state.calls.filter(c => c.rpc === rpc).length < n; i++) await new Promise(r => setTimeout(r, 50)); assert.ok(state.calls.filter(c => c.rpc === rpc).length >= n, `chờ ${n} lệnh ${rpc}`); };

async function newPage(browser, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(token => { localStorage.setItem('tb-khoa', token); localStorage.setItem('nds-ten-may', 'Máy thử'); }, TOKEN);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  return { context, page, errors };
}

async function capVai(browser) {
  const { context, page, errors } = await newPage(browser);
  const state = { calls: [], mode: 'warn', plan: PLAN, line: LINE, open: [] };
  await mockFloor(page, state);
  await page.goto(BASE + '#cap-vai');
  await page.locator('#cap-vai-screen').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#cap-vai-plan option')?.value === 'p1');
  await page.waitForFunction(() => document.getElementById('cap-vai-total').textContent === '1');
  // Lệnh ĐỌC không mang khoá.
  for (const name of ['fabric_issue_list', 'fabric_issue_get']) {
    const c = withToken(state.calls, name);
    assert.ok(c.length, `đã gọi ${name}`);
    assert.ok(c.every(x => !('p_access_token' in x.body)), `${name} không có p_access_token`);
  }
  assert.equal(await page.evaluate(() => typeof window.PrintSkuFloorAccess?.check), 'function', 'có PrintSkuFloorAccess.check');
  assert.equal(await page.evaluate(() => window.PrintSkuFloorAccess.token()), TOKEN);
  // Pha ghi nhận: quét vẫn thành công + thanh vàng.
  await page.locator('#cap-vai-code').fill(UID);
  await page.locator('#cap-vai-code').press('Enter');
  await page.locator('#cap-vai-pop-title').waitFor();
  assert.match(await page.locator('#cap-vai-pop-title').textContent(), /CẤP GROUP UID NÀY/, 'accessWarning không chặn');
  const scan = withToken(state.calls, 'fabric_issue_scan')[0];
  assert.equal(scan.body.p_access_token, TOKEN, 'fabric_issue_scan gửi khoá máy');
  assert.equal(scan.body.p_group_uid, UID);
  await bar(page).waitFor({ state: 'visible' });
  assert.match((await bar(page).textContent()).replace(/\s+/g, ' ').trim(), /Máy chưa kích hoạt/);
  assert.equal(await bar(page).locator('svg').count() >= 1, true, 'thanh có icon');
  await shot(page, 'floor-bar-capvai');
  // Nút Kích hoạt mở hộp kích hoạt.
  await page.locator('#floor-access-open').click();
  await page.locator('#pdv-dialog').waitFor({ state: 'visible' });
  assert.match(await page.locator('#pdv-status').textContent(), /chưa được kích hoạt/);
  await page.locator('#pdv-cancel').click();
  await page.locator('#pdv-dialog').waitFor({ state: 'hidden' });
  assert.equal(await bar(page).isHidden(), true, 'bấm Kích hoạt thì thanh đóng');
  // Quét tiếp có cảnh báo: trong 10 phút thanh không hiện lại.
  state.line = { ...LINE, id: 'l2' };
  await page.locator('#cap-vai-popup [data-pop-close]').click().catch(() => {});
  await page.locator('#cap-vai-code').fill(UID);
  await page.locator('#cap-vai-code').press('Enter');
  await waitCalls(state, 'fabric_issue_scan', 2);
  await page.waitForTimeout(300);
  assert.equal(await bar(page).isHidden(), true, 'tối đa 1 lần mỗi 10 phút');
  // Pha bắt buộc: ACCESS_DENIED → hộp Kích hoạt mở, không báo cấp.
  state.mode = 'deny';
  await page.evaluate(() => { document.getElementById('cap-vai-pop-card').innerHTML = ''; document.getElementById('cap-vai-popup').hidden = true; });
  await page.locator('#cap-vai-code').fill('1028260000000002');
  await page.locator('#cap-vai-code').press('Enter');
  await page.locator('#pdv-dialog').waitFor({ state: 'visible' });
  assert.doesNotMatch(await page.locator('#cap-vai-pop-card').textContent(), /CẤP GROUP UID NÀY/, 'bị từ chối thì không báo đã cấp');
  assert.deepEqual(errors, [], 'không lỗi JS');
  console.log('PASS cấp vải: p_access_token cho lệnh ghi (đọc không có), thanh vàng accessWarning (1 lần/10 phút, nút Kích hoạt), ACCESS_DENIED mở hộp kích hoạt');
  await context.close();
}

async function xaVai(browser) {
  const { context, page, errors } = await newPage(browser);
  const state = { calls: [], mode: 'warn', plan: PLAN, line: LINE, open: [XV_ITEM] };
  await mockFloor(page, state);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await waitCalls(state, 'xa_vai_measure_list', 1);
  await waitCalls(state, 'xa_vai_measure_search', 1);
  // Lưu mét (ghi nhận): thành công, thanh vàng.
  await page.locator('#xa-vai-code').fill('1028260000000009');
  await page.locator('#xa-vai-code').press('Enter');
  await page.locator('#xa-vai-meters').waitFor({ state: 'visible' });
  await page.locator('#xa-vai-meters').fill('58,5');
  await page.locator('#xa-vai-meters').press('Enter');
  await page.waitForFunction(() => /Đã lưu 1028260000000009/.test(document.getElementById('xa-vai-message').textContent));
  for (const name of ['xa_vai_measure_list', 'xa_vai_measure_search', 'xa_vai_measure_lookup']) {
    const c = withToken(state.calls, name);
    assert.ok(c.length, `đã gọi ${name}`);
    assert.ok(c.every(x => !('p_access_token' in x.body)), `${name} không có p_access_token`);
  }
  const save = withToken(state.calls, 'xa_vai_measure_save')[0];
  assert.equal(save.body.p_access_token, TOKEN, 'xa_vai_measure_save gửi khoá máy');
  assert.equal(save.body.p_group_uid, '1028260000000009');
  assert.equal(save.body.p_actual_mm, 58500, 'ô nhập mét → gửi mm nguyên');
  assert.equal('p_sku' in save.body, false, 'xa_vai_measure_save không gửi p_sku (V3)');
  assert.equal(withToken(state.calls, 'xa_vai_measure_list')[0].body.p_status, 'queue', 'xa_vai_measure_list(p_item_code, p_status)');
  await bar(page).waitFor({ state: 'visible' });
  assert.match(await bar(page).textContent(), /Máy chưa kích hoạt/);
  await page.locator('#floor-access-close').click();
  assert.equal(await bar(page).isHidden(), true, 'nút đóng ẩn thanh');
  // Bị từ chối khi lưu: hộp mở, GIỮ số mét đang nhập.
  state.mode = 'deny';
  await page.locator('#xa-vai-code').fill('1028260000000010');
  await page.locator('#xa-vai-code').press('Enter');
  await page.locator('#xa-vai-meters').waitFor({ state: 'visible' });
  await page.locator('#xa-vai-meters').fill('57');
  await page.locator('#xa-vai-meters').press('Enter');
  await page.locator('#pdv-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => /Máy chưa kích hoạt/.test(document.getElementById('xa-vai-message').textContent));
  assert.equal(await page.locator('#xa-vai-meters').inputValue(), '57', 'bị từ chối thì giữ số mét');
  await page.locator('#pdv-cancel').click();
  // Bị từ chối khi xoá khỏi hàng chờ: danh sách không đổi.
  await page.locator('#xa-vai-tab-queue').click();
  await page.locator('#xa-vai-queue-rows [data-act="delete"]').click();
  const whd = page.locator('dialog.whd'); await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
  await waitCalls(state, 'xa_vai_measure_delete', 1);
  const del = withToken(state.calls, 'xa_vai_measure_delete')[0];
  assert.equal(del.body.p_access_token, TOKEN, 'xa_vai_measure_delete gửi khoá máy');
  await page.waitForFunction(() => /Máy chưa kích hoạt/.test(document.getElementById('xa-vai-message').textContent));
  assert.equal(await page.locator('#xa-vai-queue-rows tr[data-uid]').count(), 1, 'bị từ chối thì hàng chờ không đổi');
  assert.equal(state.calls.some(c => /^xa_vai_(start|end|list_open|search)$/.test(c.rpc)), false, 'web không gọi RPC xả vải cũ');
  assert.deepEqual(errors, [], 'không lỗi JS');
  await context.close();
}

async function admin(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(({ key, token }) => { sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })); localStorage.setItem('tb-khoa', token); localStorage.setItem('nds-ten-may', 'Máy Admin'); }, { key: SESSION_KEY, token: TOKEN });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const state = { calls: [], mode: 'log', summary: 'ok' };
  await page.route('**/*', async route => {
    const url = route.request().url();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
    if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
    const body = route.request().postDataJSON?.() || {};
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc) state.calls.push({ rpc, body, auth: route.request().headers().authorization });
    const ok = data => json({ ok: true, data });
    if (rpc === 'floor_access_summary') {
      if (state.summary === 'missing') return json({ code: 'PGRST202', message: 'Could not find the function public.floor_access_summary' }, 404);
      return ok({ mode: state.mode, since: ago(60 * 24 * 7), updatedAt: ago(1000), items: [
        { fn: 'cut_group_uid_scan', count: 12, withToken: 0, lastAt: ago(5) },
        { fn: 'xa_vai_start', count: 3, withToken: 1, lastAt: ago(300) },
        { fn: 'cut_sample_scan', count: 7, withToken: 2, lastAt: ago(90) }] });
    }
    if (rpc === 'floor_access_set_mode') { state.mode = body.p_mode; return ok({ mode: body.p_mode }); }
    if (rpc === 'print_devices_admin') return ok({ devices: [{ id: 'd1', name: 'Máy kho 01', enabled: true, activatedAt: ago(600), lastSeenAt: ago(1), lastPrintAt: ago(30), printCount: 42, jobsToday: 5, userAgent: '' }], codes: [], legacyKeys: [], now: new Date().toISOString() });
    if (url.includes('/rest/v1/') && !rpc) return json([]);
    return ok({ agents: [], jobs: [], items: [] });
  });
  await page.goto(BASE + '#admin/lenh-in/thiet-bi');
  await page.locator('#pdm-panel').waitFor({ state: 'visible' });
  const card = page.locator('#pdm-floor');
  await card.waitFor({ state: 'visible' });
  assert.match((await card.locator('h2').textContent()).trim(), /Khoá máy xưởng/);
  assert.equal((await page.locator('#pdm-floor-mode').textContent()).trim(), 'Ghi nhận');
  assert.equal(await page.locator('#pdm-floor-mode .ss-badge').getAttribute('data-status'), 'expired', 'Ghi nhận = chip xám');
  const rows = await page.locator('#pdm-floor-body tr').evaluateAll(trs => trs.map(tr => [...tr.children].map(td => td.textContent.trim().replace(/\s+/g, ' '))));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => [r[0], r[1], r[2]]), [['Quét cắt', '12', '0'], ['Quét lấy mẫu', '7', '2'], ['Bắt đầu xả vải', '3', '1']], 'nhãn tiếng Việt, xếp theo số lần giảm dần');
  assert.ok(rows.every(r => r[3] && r[3] !== '—'), 'có lần cuối');
  assert.equal(await page.locator('#pdm-floor-set').textContent().then(t => t.trim()), 'Chuyển sang Bắt buộc');
  await shot(page, 'floor-admin-card-log');
  // Chuyển Bắt buộc: có hộp xác nhận; huỷ thì không gọi RPC.
  await page.locator('#pdm-floor-set').click();
  const whd = page.locator('dialog.whd'); await whd.waitFor({ state: 'visible' });
  await whd.locator('.whd-cancel').click();
  assert.equal(state.calls.filter(c => c.rpc === 'floor_access_set_mode').length, 0, 'huỷ thì chưa đổi');
  await page.locator('#pdm-floor-set').click();
  await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
  await page.waitForFunction(() => document.getElementById('pdm-floor-mode').textContent.trim() === 'Bắt buộc');
  const set = state.calls.find(c => c.rpc === 'floor_access_set_mode');
  assert.equal(set.body.p_mode, 'enforce');
  assert.equal(set.auth, 'Bearer test-admin-token', 'RPC Admin dùng Bearer Admin');
  assert.equal(await page.locator('#pdm-floor-mode .ss-badge').getAttribute('data-status'), 'completed', 'Bắt buộc = chip xanh');
  assert.equal((await page.locator('#pdm-floor-set').textContent()).trim(), 'Chuyển sang Ghi nhận');
  await shot(page, 'floor-admin-card-enforce');
  await page.locator('#pdm-floor-set').click();
  await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
  await page.waitForFunction(() => document.getElementById('pdm-floor-mode').textContent.trim() === 'Ghi nhận');
  assert.equal(state.calls.filter(c => c.rpc === 'floor_access_set_mode').pop().body.p_mode, 'log');
  assert.equal(state.calls.find(c => c.rpc === 'floor_access_summary').auth, 'Bearer test-admin-token');
  // RPC chưa có (PGRST202): thẻ ẩn, tab vẫn chạy.
  state.summary = 'missing';
  await page.reload();
  await page.locator('#pdm-body tr[data-pdm-id="d1"]').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await card.isHidden(), true, 'RPC chưa có thì thẻ ẩn');
  assert.deepEqual(errors, [], 'không lỗi JS');
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    await capVai(browser);
    await xaVai(browser);
    console.log('PASS xả vải: p_access_token cho lưu/xoá mét (đọc không có), thanh vàng, bị từ chối giữ số mét và hàng chờ');
    await admin(browser);
    console.log('PASS admin: thẻ Khoá máy xưởng — chế độ, bảng 7 ngày, chuyển chế độ có xác nhận, RPC chưa có thì ẩn');
  } finally { await browser.close(); }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
