// THEO DÕI XẢ VẢI → tab "Phiếu IT" (05/11/2026, docs/plans/2026-11-05-xa-vai-theo-phieu-it.md): Admin đọc phiếu IT qua Extension (GET_XA_VAI_IT, ≥ 0.12.6),
// mã hàng tách từ ghi chú (sửa được), Lưu đợt (xa_vai_it_save bằng JWT Admin); mọi người xem đợt + tiến độ + UID; quét UID của đợt → pop-up có mã hàng của
// đợt; In A4 điền sẵn mã hàng khi mọi UID đã chọn cùng một đợt. Supabase + Extension giả lập, dữ liệu giả (SKU 9000000xx, UID 1028260000000xxx).
//   python -m http.server 8000; node tests/xa_vai_it_browser.cjs   (cổng khác: BASE=http://127.0.0.1:<cổng>/)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const TOKEN = 'it_' + 'ab'.repeat(24);
const uid = n => `10282600000${String(n).padStart(5, '0')}`;
const IT = '1007260000000001', IT_NEW = '1007260000000002';
const now = () => new Date().toISOString();

const seedBatch = () => ({
  itNumber: IT, itemCode: 'CWSH02', description: 'định mức xả vải mã CWSH02', status: 'Closed', loadedAt: now(), uidCount: 2, measuredCount: 1, printedCount: 0,
  lines: [{ sku: '900000001', name: 'Vải thử 1/mm', unit: 'mm', requestedQty: 150000, deliveredQty: 180000, deliveredMm: 180000, uidCount: 2, uidMm: 180000, measuredCount: 1, printedCount: 0, actualMm: 90000, systemMm: 90000 }],
  uids: [{ groupUid: uid(1), sku: '900000001', lot: 'L1', roll: 'R1', wmsMm: 90000, state: 'pending', actualMm: 90000 }, { groupUid: uid(2), sku: '900000001', lot: 'L1', roll: 'R2', wmsMm: 90000, state: 'new' }],
});
// Phản hồi Extension theo hợp đồng GET_XA_VAI_IT (mẫu thật 05/11/2026, giá trị giả).
const EXT_IT = {
  number: IT_NEW, id: 8000002, mappingId: '10022600000002', status: 'Closed', fromWarehouse: 'WH - MATERIAL - MTG', toWarehouse: 'WH - SEMI PRODUCT - MTG',
  description: 'định mức xả vải mã swsh09', createdAt: '2026-11-04T01:46:10.000Z',
  lines: [{ sku: '900000002', name: 'Vải thử 2/mm', unit: 'mm', requestedQty: 632000, deliveredQty: 756071 }, { sku: '900000003', name: 'Vải thử 3/mm', unit: 'mm', requestedQty: 100000, deliveredQty: 100000 }],
  uids: [{ groupUid: uid(11), sku: '900000002', lot: 'L2', roll: 'R1', qty: 300000, rfid: 'A50000000011', status: 'Available', location: 'F0-A0-00-00-00-00' },
    { groupUid: uid(12), sku: '900000002', lot: 'L2', roll: 'R2', qty: 286071, rfid: null, status: 'Available', location: 'F0-A0-00-00-00-00' },
    { groupUid: uid(13), sku: '900000003', lot: 'L3', roll: 'R1', qty: 100000, rfid: null, status: 'Available', location: 'F0-A0-00-00-00-00' }],
  uidTotal: 3, skipped: { otherSource: 0, badCode: 0, multiSku: 0, otherSku: 0 }, generatedAt: now(),
};

const fakeExtension = data => {
  window.__extCalls = [];
  addEventListener('message', event => {
    const request = event.data;
    if (!request || request.source !== 'PRINT_SKU_APP') return;
    window.__extCalls.push({ type: request.type, payload: request.payload });
    const reply = (ok, body, error) => postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: request.requestId, ok, data: body, error }, location.origin);
    if (/^PING/.test(request.type)) return reply(true, { version: window.__extVersion || '0.12.6' });
    if (request.type === 'GET_XA_VAI_IT') return request.payload.number === data.number ? reply(true, data) : reply(false, null, { code: 'INTERNAL_TRANSFER_READ_FAILED', message: `Không tìm thấy phiếu IT ${request.payload.number}` });
    reply(false, null, { message: 'Loại yêu cầu chưa giả lập' });
  });
};

function mock(page, s) {
  return page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith(BASE)) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/auth/v1/token')) return json({ access_token: 'test-admin-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600 });
    if (url.includes('/auth/v1/user')) return json({ id: '00000000-0000-4000-8000-000000000001', email: 'admin@test.vn' });
    if (url.includes('/rest/v1/user_roles')) return json([{ username: 'admin', role: 'admin' }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (!rpc) return json([]);
    const body = request.postDataJSON?.() || {};
    s.calls.push({ rpc, body, auth: request.headers().authorization });
    const ok = data => json({ ok: true, data });
    const { uids: _u, ...head } = s.batch;
    if (rpc === 'xa_vai_it_list' && s.listFail) return json({ message: 'lỗi máy chủ giả lập' }, 500);
    if (rpc === 'xa_vai_it_list') { const items = [head, ...s.saved.map(b => b.listItem)].filter(b => !(s.deletedIts || []).includes(b.itNumber)); return ok({ items, total: items.length }); }
    if (rpc === 'xa_vai_it_delete') {
      if (request.headers().authorization !== 'Bearer test-admin-token') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Chỉ Admin được xoá đợt xả' } });
      s.deletedIts = [...(s.deletedIts || []), body.p_it_number];
      return ok({ itNumber: body.p_it_number, itemCode: 'CWSH02', uidCount: 2, measuredCount: 1 });
    }
    if (rpc === 'xa_vai_it_get') {
      if (body.p_it_number === IT) return ok({ ...head, uids: s.batch.uids });
      const hit = s.saved.find(b => b.p_batch.itNumber === body.p_it_number);
      return hit ? ok({ ...hit.listItem, uids: [] }) : json({ ok: false, error: { code: 'NOT_FOUND', message: 'Chưa nạp phiếu IT này' } });
    }
    if (rpc === 'xa_vai_it_of_uids') {
      const map = new Map(s.batch.uids.map(u => [u.groupUid, { itNumber: IT, itemCode: s.batch.itemCode }]));
      for (const b of s.saved) for (const u of b.p_batch.uids) map.set(u.groupUid, { itNumber: b.p_batch.itNumber, itemCode: b.p_batch.itemCode });
      return ok({ items: body.p_uids.filter(u => map.has(u)).map(u => ({ groupUid: u, ...map.get(u) })) });
    }
    if (rpc === 'xa_vai_it_save') {
      if (s.saveDelayMs) await new Promise(r => setTimeout(r, s.saveDelayMs));
      if (request.headers().authorization !== 'Bearer test-admin-token') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Chỉ Admin được nạp phiếu IT' } });
      const b = body.p_batch;
      s.saved.push({ p_batch: b, listItem: { itNumber: b.itNumber, itemCode: b.itemCode, description: b.description, loadedAt: now(), uidCount: b.uids.length, measuredCount: 0, printedCount: 0,
        lines: b.lines.map(l => ({ ...l, deliveredMm: l.deliveredQty, uidCount: b.uids.filter(u => u.sku === l.sku).length, measuredCount: 0, actualMm: null })) } });
      return ok({ itNumber: b.itNumber, itemCode: b.itemCode, created: true, uidsAdded: b.uids.length, uidsTotal: b.uids.length });
    }
    // Đợt 2: trạng thái UID với các đợt; gắn / báo / đóng đợt / mục ngoài phiếu.
    if (rpc === 'xa_vai_it_check') {
      const u = String(body.p_group_uid);
      if (s.batch.uids.some(x => x.groupUid === u)) return ok({ groupUid: u, sku: '900000001', state: 'in_batch' });
      return ok({ groupUid: u, sku: '900000009', ...(s.checks?.[u] || { state: 'free' }) });
    }
    if (rpc === 'xa_vai_it_attach' && s.attachError) { s.attached = [...(s.attached || []), body]; const e = s.attachError; s.attachError = null; return json({ ok: false, error: e }); }
    if (rpc === 'xa_vai_it_attach') { s.attached = [...(s.attached || []), body]; return ok({ itNumber: body.p_it_number, itemCode: body.p_it_number === IT ? 'CWSH02' : 'SWSH09', attached: true }); }
    if (rpc === 'xa_vai_it_report') { s.reports = [...(s.reports || []), body]; return ok({ reported: true, state: 'other_sku' }); }
    if (rpc === 'xa_vai_it_set_status') {
      if (request.headers().authorization !== 'Bearer test-admin-token') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Chỉ Admin' } });
      s.batch.batchStatus = body.p_status; return ok({ itNumber: body.p_it_number, status: body.p_status });
    }
    if (rpc === 'xa_vai_it_report_delete') {
      if (request.headers().authorization !== 'Bearer test-admin-token') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Chỉ Admin được xoá mục Ngoài đợt xả' } });
      // Chỉ xoá dòng có giờ quét cuối khớp bản web đang thấy (lượt quét mới giữ lại).
      const want = new Map(body.p_items.map(x => [x.groupUid, x.lastAt])), before = s.outside.outside.length;
      s.outside.outside = s.outside.outside.filter(x => want.get(x.groupUid) !== x.lastAt); s.outside.outsideTotal = s.outside.outside.length;
      const deleted = before - s.outside.outside.length;
      return ok({ deleted, requested: want.size, stale: want.size - deleted });
    }
    if (rpc === 'xa_vai_it_outside') return ok(s.outside || { attached: [], outside: [], attachedTotal: 0, outsideTotal: 0 });
    if (rpc === 'xa_vai_measure_save' && s.saveError) { const e = s.saveError; if (s.saveErrorOnce) s.saveError = null; return json({ ok: false, error: e }); }
    if (rpc === 'xa_vai_measure_lookup') {
      const u = String(body.p_group_uid);
      return ok({ groupUid: u, sku: '900000001', productName: 'Vải thử 1/mm', itemCode: null, lot: 'L1', roll: 'R9', uidStatus: 'Available', systemQty: 90000, systemMm: 90000, state: 'new', actualMm: null, measuredAt: null, printedAt: null, printJobId: null });
    }
    if (rpc === 'xa_vai_measure_list') return ok({ items: s.queue.map(u => ({ groupUid: u, sku: '900000001', itemCode: null, lot: 'L1', roll: 'R1', systemMm: 90000, actualMm: 90000, measuredAt: now(), status: 'pending', printedAt: null, printJobId: null })), total: s.queue.length });
    if (rpc === 'xa_vai_measure_search') return ok({ items: [], total: 0, truncated: false });
    if (rpc === 'print_queue_status') return ok({ queued: 0, queuedA4: 0, agents: [] });
    return ok({});
  });
}

const calls = (s, rpc) => s.calls.filter(c => c.rpc === rpc);
const msg = page => page.locator('#xa-vai-message').innerText();
// XV_IT_SHOTS=<thư mục> thì chụp tab Phiếu IT ở từng khổ (không bắt buộc; ảnh cho vòng review giao diện).
const shot = async (page, name) => { if (process.env.XV_IT_SHOTS) await page.screenshot({ path: `${process.env.XV_IT_SHOTS}/${name}.png`, fullPage: true }); };

// Pop-up UID mới chưa lưu (06/11/2026): Esc không đóng; nút X hỏi "Bỏ không lưu?" → bấm Bỏ.
const discardUid = async (page, { tap = false } = {}) => {
  const x = page.locator('#xa-vai-uid-close');
  if (tap) await x.tap(); else await x.click();
  await page.locator('dialog.whd').waitFor({ state: 'visible' });
  assert.equal(await page.locator('dialog.whd').getAttribute('data-tone'), 'danger');
  if (tap) await page.locator('dialog.whd .whd-ok').tap(); else await page.locator('dialog.whd .whd-ok').click();
  await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'hidden' });
};
async function open(browser, width, s, { ext = EXT_IT } = {}) {
  const mobile = width < 768;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 800 : 900 }, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(token => localStorage.setItem('tb-khoa', token), TOKEN);
  await context.addInitScript(fakeExtension, ext);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { errors.push(`hộp trình duyệt: ${d.message()}`); d.dismiss(); });
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  return { context, page, errors };
}
async function login(page) {
  await page.locator('#xa-vai-admin').click();
  await page.locator('#admin-auth').waitFor({ state: 'visible' });
  // Hộp đăng nhập xoá trống ô ngay sau khi mở (bất đồng bộ): điền lại tới khi giá trị giữ được rồi mới bấm (đo 05/11: báo "Nhập đầy đủ email…").
  for (let i = 0; i < 20; i += 1) {
    await page.locator('#admin-auth-email').fill('admin@test.vn');
    await page.locator('#admin-auth-password').fill('mat-khau-thu');
    await page.waitForTimeout(100);
    if (await page.locator('#admin-auth-email').inputValue() === 'admin@test.vn' && await page.locator('#admin-auth-password').inputValue() === 'mat-khau-thu') break;
  }
  await page.locator('#admin-auth-submit').click();
  try { await page.locator('#admin-auth').waitFor({ state: 'hidden', timeout: 8000 }); } catch (e) { throw new Error('Đăng nhập Admin kẹt: ' + (await page.locator('#admin-auth').innerText()).replace(/\s+/g, ' ').slice(0, 300)); }
  await page.waitForFunction(() => document.querySelector('#xa-vai-admin').getAttribute('aria-pressed') === 'true');
}
// Không tràn ngang trong thẻ (khổ điện thoại).
const noOverflow = async (page, sel) => {
  const over = await page.evaluate(s => { const el = document.querySelector(s); return el ? el.scrollWidth - el.clientWidth : -1; }, sel);
  assert.ok(over >= 0 && over <= 1, `${sel} không tràn ngang (${over})`);
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      // ---------- 1. Mọi người xem đợt + tiến độ + UID; chưa Admin không có ô đọc phiếu ----------
      {
        const s = { batch: seedBatch(), saved: [], calls: [], queue: [] };
        const { context, page, errors } = await open(browser, width, s);
        await page.waitForFunction(() => document.getElementById('xa-vai-it-count').textContent === '1');
        await page.locator('#xa-vai-tab-it').click();
        assert.equal(await page.locator('#xa-vai-screen [data-panel="it"]').isVisible(), true);
        assert.equal(await page.locator('#xa-vai-screen [data-panel="scan"]').isVisible(), false, 'mỗi tab một thẻ');
        assert.equal(await page.locator('#xa-vai-it-form').isVisible(), false, 'chưa Admin: không có ô đọc phiếu');
        const card = page.locator(`.xv-it-card[data-it="${IT}"]`);
        await card.waitFor({ state: 'visible' });
        assert.equal((await card.locator('.xv-it-card__code').innerText()).trim(), 'CWSH02');
        assert.equal((await card.locator('.xv-it-card__head .xv-state').innerText()).trim(), '1 / 2 UID');
        const cells = await card.locator('tbody tr').first().locator('td').allInnerTexts();
        assert.equal(cells[1].replace(/\s+/g, ' ').trim(), '1 / 2');
        assert.match(cells[2], /90,00/); assert.match(cells[3], /180,00 m/);
        assert.equal(await card.locator('.xv-it-bar > i').getAttribute('style'), 'width:50%');
        assert.equal(await card.locator('tbody td').first().getAttribute('data-label'), 'SKU', 'nhãn ô cho bảng dạng thẻ trên điện thoại');
        await card.locator('details summary').click();
        await card.locator('.xv-it-uids__body tbody tr').nth(1).waitFor();
        const states = await card.locator('.xv-it-uids__body .xv-state').allInnerTexts();
        assert.deepEqual(states.map(t => t.trim()), ['Chờ in', 'Chưa nhập']);
        assert.equal(calls(s, 'xa_vai_it_get').length, 1, 'mở UID tải đúng một lần');
        await shot(page, `list-${width}`);
        if (width < 768) await noOverflow(page, '#xa-vai-screen [data-panel="it"]');
        assert.deepEqual(errors, []);
        await context.close();
      }

      // ---------- 2. Admin đọc phiếu → xem trước (mã hàng tách từ ghi chú, thiếu UID) → Lưu đợt ----------
      {
        const s = { batch: seedBatch(), saved: [], calls: [], queue: [] };
        const { context, page, errors } = await open(browser, width, s);
        await page.locator('#xa-vai-tab-it').click();
        await login(page);
        const form = page.locator('#xa-vai-it-form'), input = page.locator('#xa-vai-it-number'), read = page.locator('#xa-vai-it-read');
        assert.equal(await form.isVisible(), true, 'Admin: có ô đọc phiếu');
        assert.equal((await read.innerText()).trim(), 'Đọc WMS');
        await input.fill('12345');
        await read.click();
        assert.match(await msg(page), /16 chữ số/);
        assert.equal(await page.evaluate(() => window.__extCalls.filter(c => c.type === 'GET_XA_VAI_IT').length), 0, 'số sai: không gọi Extension');

        await input.fill(` ${IT_NEW} `);
        await input.press('Enter');
        const preview = page.locator('#xa-vai-it-preview');
        await preview.waitFor({ state: 'visible' });
        assert.equal(await page.locator('#xa-vai-it-code').inputValue(), 'SWSH09', 'mã hàng tách từ ghi chú, viết hoa');
        const rows = await preview.locator('tbody tr').evaluateAll(trs => trs.map(tr => [...tr.cells].map(td => td.innerText.replace(/\s+/g, ' ').trim())));
        assert.equal(rows.length, 2);
        assert.match(rows[0][0], /^900000002/); assert.equal(rows[0][1], '756,07 m'); assert.equal(rows[0][2], '2'); assert.equal(rows[0][3], '586,07 m'); assert.equal(rows[0][4], '170,00 m');
        assert.equal(rows[1][4], '—', 'đủ UID: không báo thiếu');
        assert.match(await msg(page), /Phiếu 1007260000000002 · 2 SKU · 3 UID · SWSH09/);
        assert.equal((await page.locator('#xa-vai-it-save').innerText()).trim(), 'Lưu đợt · 3 UID');
        await shot(page, `preview-${width}`);
        if (width < 768) await noOverflow(page, '#xa-vai-screen [data-panel="it"]');

        // Mã hàng sai mẫu: báo trong khung, không gửi.
        await page.locator('#xa-vai-it-code').fill('SW/09');
        await page.locator('#xa-vai-it-save').click();
        assert.match(await page.locator('#xa-vai-it-code-err').innerText(), /Mã hàng chỉ gồm/);
        assert.equal(calls(s, 'xa_vai_it_save').length, 0);
        await page.locator('#xa-vai-it-code').fill('swsh09b');
        assert.equal(await page.locator('#xa-vai-it-code').inputValue(), 'SWSH09B', 'tự viết hoa');
        await page.locator('#xa-vai-it-save').click();
        await preview.waitFor({ state: 'hidden' });
        const save = calls(s, 'xa_vai_it_save');
        assert.equal(save.length, 1);
        assert.equal(save[0].auth, 'Bearer test-admin-token', 'lưu bằng phiên Admin');
        const b = save[0].body.p_batch;
        assert.equal(b.itNumber, IT_NEW); assert.equal(b.itemCode, 'SWSH09B'); assert.equal(b.mappingId, '10022600000002');
        assert.deepEqual(b.lines.map(l => [l.sku, l.deliveredQty, l.requestedQty]), [['900000002', 756071, 632000], ['900000003', 100000, 100000]]);
        assert.deepEqual(b.uids.map(u => [u.groupUid, u.sku, u.qty]), [[uid(11), '900000002', 300000], [uid(12), '900000002', 286071], [uid(13), '900000003', 100000]]);
        await page.waitForFunction(() => /Đã lưu đợt SWSH09B · 3 UID/.test(document.getElementById('xa-vai-message').textContent));
        await page.locator(`.xv-it-card[data-it="${IT_NEW}"]`).waitFor();
        assert.equal(await page.locator(`.xv-it-card[data-it="${IT_NEW}"] details`).getAttribute('open'), '', 'đợt vừa lưu mở sẵn UID');
        assert.equal(await input.inputValue(), '', 'lưu xong xoá ô số phiếu');
        // Đọc lại phiếu đã lưu: giữ mã hàng Admin đã sửa (SWSH09B), không lấy lại mã từ ghi chú (SWSH09).
        await input.fill(IT_NEW);
        await read.click();
        await preview.waitFor({ state: 'visible' });
        assert.equal(await page.locator('#xa-vai-it-code').inputValue(), 'SWSH09B');
        assert.match(await msg(page), /đã có đợt/);
        assert.equal((await page.locator('#xa-vai-it-count').innerText()).trim(), '2');
        if (width >= 768) {
          // Review 06/11: đang Lưu đợt thì nút Xoá không gửi (Xoá commit trước lượt Lưu đang bay thì Lưu tạo lại đợt).
          s.saveDelayMs = 1500;
          await page.locator('#xa-vai-it-save').click();
          await page.locator(`.xv-it-card[data-it="${IT}"] [data-it-act="delete"]`).click();
          assert.equal(await page.locator('dialog.whd[open]').count(), 0, 'đang lưu: không mở hộp xoá');
          await page.waitForFunction(() => /Đã lưu đợt SWSH09B/.test(document.getElementById('xa-vai-message').textContent));
          assert.equal(calls(s, 'xa_vai_it_delete').length, 0);
          s.saveDelayMs = 0;
          // Xoá xong mà tải lại danh sách lỗi: thẻ rời màn ngay, câu báo không nói "đã tải lại".
          s.listFail = true;
          const countBefore = Number((await page.locator('#xa-vai-it-count').innerText()).trim());
          const gone = page.locator(`.xv-it-card[data-it="${IT}"]`);
          await gone.locator('[data-it-act="delete"]').click();
          await page.locator('dialog.whd .whd-ok').click();
          await gone.waitFor({ state: 'detached' });
          await page.waitForFunction(() => /Đã xoá đợt CWSH02 · IT 1007260000000001 · 2 UID · bấm tab Phiếu IT để tải lại/.test(document.getElementById('xa-vai-message').textContent));
          assert.equal(Number((await page.locator('#xa-vai-it-count').innerText()).trim()), countBefore - 1, 'bớt một đợt trên màn');
          s.listFail = false;
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    }

    // ---------- 3. Extension cũ: báo Reload, không gửi GET_XA_VAI_IT ----------
    {
      const s = { batch: seedBatch(), saved: [], calls: [], queue: [] };
      const { context, page, errors } = await open(browser, 1280, s);
      await page.evaluate(() => { window.__extVersion = '0.12.5'; });
      await page.locator('#xa-vai-tab-it').click();
      await login(page);
      await page.locator('#xa-vai-it-number').fill(IT_NEW);
      await page.locator('#xa-vai-it-read').click();
      await page.waitForFunction(() => /cần Extension 0\.12\.6/.test(document.getElementById('xa-vai-message').textContent));
      assert.equal(await page.evaluate(() => window.__extCalls.filter(c => c.type === 'GET_XA_VAI_IT').length), 0);
      assert.equal((await page.locator('#xa-vai-it-read').innerText()).trim(), 'Đọc WMS', 'hết bận');
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---------- 4. Phiếu chưa xuất: xem trước được, không cho lưu ----------
    {
      const s = { batch: seedBatch(), saved: [], calls: [], queue: [] };
      const notOut = { ...EXT_IT, lines: EXT_IT.lines.map(l => ({ ...l, deliveredQty: 0 })), uids: [], uidTotal: 0 };
      const { context, page, errors } = await open(browser, 1280, s, { ext: notOut });
      await page.locator('#xa-vai-tab-it').click();
      await login(page);
      await page.locator('#xa-vai-it-number').fill(IT_NEW);
      await page.locator('#xa-vai-it-read').click();
      await page.locator('#xa-vai-it-preview').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#xa-vai-it-save').isDisabled(), true);
      assert.match(await page.locator('#xa-vai-it-preview').innerText(), /Phiếu chưa xuất hoặc chưa có Group UID/);
      // Thoát Admin: bỏ bản nháp và ô đọc phiếu.
      await page.locator('#xa-vai-admin').click();
      await page.locator('dialog.whd .whd-ok').click();
      await page.locator('#xa-vai-it-preview').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#xa-vai-it-form').isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ---------- 5. Quét UID của đợt → pop-up có mã hàng; In A4 điền sẵn mã của đợt, lẫn đợt thì không ----------
    for (const width of [1280, 375]) {
      const s = { batch: seedBatch(), saved: [], calls: [], queue: [uid(1), uid(2)] };
      const { context, page, errors } = await open(browser, width, s);
      await page.locator('#xa-vai-code').click();
      await page.keyboard.type(uid(2));
      await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'visible' });
      await page.waitForFunction(() => /Mã hàng\s*CWSH02/.test(document.getElementById('xa-vai-uid').innerText));
      await shot(page, `popup-${width}`);
      assert.equal(await page.locator('#xa-vai-uid dd[title]').filter({ hasText: 'CWSH02' }).getAttribute('title'), `Phiếu IT ${IT}`);
      await discardUid(page);

      await page.locator('#xa-vai-tab-queue').click();
      await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(2)}"]`).waitFor();
      await page.locator('#xa-vai-print').click();
      await page.locator('#xa-vai-mh-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'CWSH02', 'mọi UID cùng đợt: điền sẵn mã hàng của đợt');
      await page.locator('#xa-vai-mh-cancel').click();
      await page.locator('#xa-vai-mh-dialog').waitFor({ state: 'hidden' });

      // Thêm UID ngoài đợt vào hàng chờ: không điền mã của đợt (máy chưa nhớ mã nào → trống).
      s.queue.push(uid(30));
      await page.locator('#xa-vai-reload').click();
      await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(30)}"]`).waitFor();
      await page.locator('#xa-vai-print').click();
      await page.locator('#xa-vai-mh-dialog').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), '', 'lẫn UID ngoài đợt: không điền mã của đợt');
      await page.locator('#xa-vai-mh-cancel').click();
      assert.deepEqual(errors, []);
      await context.close();
    }
    // ---------- 6. Đợt 2: cùng SKU ngoài phiếu (chọn đợt, gắn rồi lưu), khác SKU bị chặn + báo, đóng đợt, mục Ngoài phiếu ----------
    for (const width of [1280, 375]) {
      const s = { batch: { ...seedBatch(), batchStatus: 'open', outsideCount: 1 }, saved: [], calls: [], queue: [],
        checks: { [uid(40)]: { state: 'same_sku', batches: [{ itNumber: IT, itemCode: 'CWSH02' }, { itNumber: IT_NEW, itemCode: 'SWSH09' }] }, [uid(41)]: { state: 'other_sku', openItems: ['CWSH02'] } },
        outside: { attached: [{ groupUid: uid(39), sku: '900000001', itNumber: IT, itemCode: 'CWSH02', addedAt: now(), device: 'may-test-01', state: 'pending' }],
          outside: [{ groupUid: uid(41), sku: '900000009', lastAt: now(), scanCount: 2, device: 'may-test-01', openItems: 'CWSH02' }], attachedTotal: 1, outsideTotal: 1 } };
      const { context, page, errors } = await open(browser, width, s);
      // Tab Quét (06/11/2026): tiến độ đợt Đang xả — đã lưu / tổng UID, "Còn n", mở "Chưa quét" ra đúng UID chưa có mét.
      const prog = page.locator(`#xa-vai-itprog .xv-itprog__card[data-it="${IT}"]`);
      await prog.waitFor();
      assert.match((await prog.innerText()).replace(/\s+/g, ' '), /CWSH02 IT 1007260000000001 1 \/ 2 UID Còn 1/);
      assert.equal(await prog.getAttribute('data-left'), 'true');
      // Theo SKU: mỗi SKU có UID một dòng "đã lưu / tổng" + Còn n / Đủ.
      assert.deepEqual((await prog.locator('.xv-itprog__sku').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').trim()), ['SKU 900000001 1 / 2 Còn 1']);
      await prog.locator('summary').click();
      await prog.locator('.xv-itprog__list li').first().waitFor();
      assert.deepEqual(await prog.locator('.xv-itprog__list b').allInnerTexts(), [uid(2)], 'chỉ UID chưa có mét');
      await shot(page, `scan-prog-${width}`);
      // Tải tiến độ lỗi: giữ số cũ + dòng "Chưa cập nhật tiến độ"; tải lại được thì dòng mất.
      s.listFail = true;
      await page.locator('#xa-vai-tab-queue').click(); await page.locator('#xa-vai-tab-scan').click();
      await page.locator('#xa-vai-itprog .xv-itprog__stale').waitFor();
      assert.equal(await prog.isVisible(), true, 'lỗi tải: giữ thẻ cũ');
      s.listFail = false;
      await page.locator('#xa-vai-tab-queue').click(); await page.locator('#xa-vai-tab-scan').click();
      await page.locator('#xa-vai-itprog .xv-itprog__stale').waitFor({ state: 'detached' });
      if (width < 768) await noOverflow(page, '#xa-vai-screen [data-panel="scan"]');
      // Cùng SKU, hai đợt đang xả: pop-up "Ngoài phiếu", chọn đợt thứ hai, lưu → gắn đúng đợt TRƯỚC rồi mới lưu mét.
      await page.locator('#xa-vai-code').click();
      await page.keyboard.type(uid(40));
      await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'visible' });
      await page.waitForFunction(() => /Ngoài phiếu/.test(document.getElementById('xa-vai-uid').innerText));
      assert.equal(await page.locator('#xa-vai-it-pickrow').isVisible(), true, 'nhiều đợt: có ô chọn đợt');
      await page.locator('#xa-vai-it-pick').selectOption(IT_NEW);
      await page.waitForFunction(() => /Mã hàng\s*SWSH09/.test(document.getElementById('xa-vai-uid').innerText));
      await shot(page, `out-same-${width}`);
      await page.locator('#xa-vai-meters').fill('88,5');
      await page.locator('#xa-vai-save').click();
      await page.waitForFunction(() => /Đã lưu .* ngoài phiếu SWSH09/.test(document.getElementById('xa-vai-message').textContent));
      assert.deepEqual(s.attached.map(a => [a.p_group_uid, a.p_it_number]), [[uid(40), IT_NEW]]);
      assert.ok(s.attached[0].p_access_token, 'gắn bằng khoá máy');
      const order = s.calls.map(c => c.rpc).filter(r => r === 'xa_vai_it_attach' || r === 'xa_vai_measure_save');
      assert.deepEqual(order, ['xa_vai_it_attach', 'xa_vai_measure_save'], 'gắn trước, lưu sau');

      // Khác SKU: pop-up cảnh báo, không có ô mét, báo vận hành kho; máy quét bắn UID kế → pop-up đóng, tra UID mới.
      const saves = calls(s, 'xa_vai_measure_save').length;
      await page.locator('#xa-vai-code').click();
      await page.keyboard.type(uid(41));
      await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'visible' });
      await page.waitForFunction(() => /Ngoài đợt xả/.test(document.getElementById('xa-vai-uid').innerText));
      assert.equal(await page.locator('#xa-vai-meter-form').isVisible(), false, 'không có ô mét');
      await page.waitForFunction(() => document.getElementById('xa-vai-uid-error').textContent.includes('Ngoài đợt xả · không lưu · đã báo vận hành kho'));
      assert.equal((await page.locator('#xa-vai-uid-error').innerText()).includes(uid(41)), false, 'câu báo trong pop-up không lặp UID');
      await shot(page, `out-block-${width}`);
      await page.waitForFunction(() => true);
      assert.equal(s.reports.length, 1); assert.equal(s.reports[0].p_group_uid, uid(41)); assert.ok(s.reports[0].p_access_token);
      assert.equal(calls(s, 'xa_vai_measure_save').length, saves, 'khác SKU: không lưu');
      const lookups = calls(s, 'xa_vai_measure_lookup').length;
      await page.keyboard.type(uid(2));
      await page.waitForFunction(() => /Mã hàng\s*CWSH02/.test(document.getElementById('xa-vai-uid').innerText));
      assert.equal(calls(s, 'xa_vai_measure_lookup').length, lookups + 1);
      assert.equal(calls(s, 'xa_vai_measure_lookup').pop().body.p_group_uid, uid(2), 'không mất ký tự đầu của lượt quét kế');
      await discardUid(page);

      // Máy chủ chặn OUTSIDE_BATCH lúc lưu (đợt vừa đổi): báo lỗi + báo vận hành kho.
      s.saveError = { code: 'OUTSIDE_BATCH', message: 'Group UID nằm ngoài đợt xả vải đang mở' };
      await page.locator('#xa-vai-code').click();
      await page.keyboard.type(uid(42));
      await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'visible' });
      await page.locator('#xa-vai-meters').fill('90');
      await page.locator('#xa-vai-save').click();
      await page.waitForFunction(() => /Ngoài đợt xả · không lưu · đã báo vận hành kho/.test(document.getElementById('xa-vai-message').textContent));
      assert.equal(s.reports.at(-1).p_group_uid, uid(42));
      assert.equal(await page.locator('#xa-vai-meter-form').isVisible(), false, 'máy chủ chặn → pop-up chuyển sang chặn, không còn ô mét');
      s.saveError = null;
      await page.keyboard.press('Escape');

      // Máy chủ ép gắn (web không kiểm được đợt lúc tra): NEED_BATCH → hiện ô chọn phiếu IT, chọn rồi Lưu → gắn đúng phiếu rồi lưu.
      s.saveError = { code: 'NEED_BATCH', message: 'Chọn phiếu IT cho Group UID này', batches: [{ itNumber: IT, itemCode: 'CWSH02' }, { itNumber: IT_NEW, itemCode: 'SWSH09' }] }; s.saveErrorOnce = true;
      await page.locator('#xa-vai-code').click();
      await page.keyboard.type(uid(43));
      await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'visible' });
      await page.locator('#xa-vai-meters').fill('90');
      await page.locator('#xa-vai-save').click();
      await page.waitForFunction(() => /Chọn phiếu IT rồi Lưu/.test(document.getElementById('xa-vai-message').textContent));
      assert.equal(await page.locator('#xa-vai-it-pickrow').isVisible(), true);
      await page.locator('#xa-vai-it-pick').selectOption(IT_NEW);
      await page.locator('#xa-vai-save').click();
      await page.waitForFunction(() => /Đã lưu .* ngoài phiếu SWSH09/.test(document.getElementById('xa-vai-message').textContent));
      assert.deepEqual(s.attached.at(-1).p_group_uid === uid(43) && s.attached.at(-1).p_it_number, IT_NEW);

      // Máy khác vừa gắn UID vào đợt khác (ALREADY_IN_BATCH): vẫn lưu, theo đợt đã có.
      s.attachError = { code: 'ALREADY_IN_BATCH', message: 'Group UID đã thuộc đợt xả khác', itNumber: IT, itemCode: 'CWSH02' };
      await page.locator('#xa-vai-code').click();
      await page.keyboard.type(uid(40));
      await page.locator('#xa-vai-uid-dialog').waitFor({ state: 'visible' });
      await page.locator('#xa-vai-meters').fill('90');
      await page.locator('#xa-vai-save').click();
      await page.waitForFunction(() => /Đã lưu .* ngoài phiếu CWSH02/.test(document.getElementById('xa-vai-message').textContent));

      // Tab Phiếu IT: trạng thái đợt, số ngoài phiếu, mục Ngoài phiếu; Admin đóng đợt (Admin chỉ xét máy tính).
      await page.locator('#xa-vai-tab-it').click();
      const card = page.locator(`.xv-it-card[data-it="${IT}"]`);
      await card.waitFor();
      assert.equal((await card.locator('.xv-it-st').innerText()).trim(), 'Đang xả');
      assert.equal((await card.locator('.xv-it-card__out').innerText()).trim(), 'Ngoài phiếu 1');
      assert.equal(await card.locator('[data-it-act="status"]').count(), 0, 'chưa Admin: không có nút Đóng đợt');
      assert.equal(await card.locator('[data-it-act="delete"]').count(), 0, 'chưa Admin: không có nút Xoá đợt');
      assert.equal(await page.locator('#xa-vai-it-out [data-out-del], #xa-vai-it-out [data-out-del-all]').count(), 0, 'chưa Admin: không có nút Xoá ở Ngoài đợt xả');
      const out = page.locator('#xa-vai-it-out');
      await out.waitFor({ state: 'visible' });
      assert.equal((await page.locator('#xa-vai-it-out-count').innerText()).trim(), '2');
      await out.locator('summary').click();
      assert.equal(await out.locator('tbody tr').count(), 2);
      assert.match(await out.innerText(), /Ngoài đợt xả · không lưu · 1/);
      assert.match(await out.innerText(), /Ngoài phiếu · gắn vào đợt · 1/);
      assert.equal((await out.locator('summary').innerText()).replace(/\s+/g, ' ').trim(), 'Bất thường 2');
      if (width >= 768) {
        await login(page);
        await card.locator('[data-it-act="status"]').click();
        await page.locator('dialog.whd .whd-ok').click();
        await page.waitForFunction(it => document.querySelector(`.xv-it-card[data-it="${it}"] .xv-it-st`)?.textContent.trim() === 'Xong', IT);
        const st = calls(s, 'xa_vai_it_set_status');
        assert.equal(st.length, 1); assert.equal(st[0].body.p_status, 'done'); assert.equal(st[0].auth, 'Bearer test-admin-token');
        assert.equal((await card.locator('[data-it-act="status"]').innerText()).trim(), 'Mở lại');
        await shot(page, `out-list-${width}`);
        // Xoá đợt (06/11/2026): hộp đỏ hỏi lại; Huỷ không gọi máy chủ; Xoá đợt → gọi bằng JWT Admin, thẻ biến mất, báo số UID.
        await card.locator('[data-it-act="delete"]').click();
        await page.locator('dialog.whd').waitFor({ state: 'visible' });
        assert.equal(await page.locator('dialog.whd').getAttribute('data-tone'), 'danger');
        assert.match(await page.locator('dialog.whd .whd-facts').innerText(), /CWSH02[\s\S]*IT 1007260000000001[\s\S]*2 UID[\s\S]*1 UID đã đo giữ mét/);
        await page.locator('dialog.whd .whd-cancel').click();
        assert.equal(calls(s, 'xa_vai_it_delete').length, 0, 'Huỷ: không xoá');
        await card.locator('[data-it-act="delete"]').click();
        await page.locator('dialog.whd .whd-ok').click();
        await card.waitFor({ state: 'detached' });
        const del = calls(s, 'xa_vai_it_delete');
        assert.equal(del.length, 1); assert.equal(del[0].body.p_it_number, IT); assert.equal(del[0].auth, 'Bearer test-admin-token');
        await page.waitForFunction(() => /Đã xoá đợt CWSH02 · IT 1007260000000001 · 2 UID/.test(document.getElementById('xa-vai-message').textContent));
        // Mục "Ngoài đợt xả" (06/11/2026): Admin xoá một dòng, rồi Xoá hết; Huỷ không gọi máy chủ.
        s.outside.outside.push({ groupUid: uid(44), sku: '900000009', lastAt: now(), scanCount: 1, device: 'may-test-01', openItems: 'CWSH02' }); s.outside.outsideTotal = 2;
        await page.locator('#xa-vai-tab-scan').click();
        await page.locator('#xa-vai-tab-it').click();
        await out.locator(`[data-out-del="${uid(44)}"]`).waitFor();
        await out.locator(`[data-out-del="${uid(41)}"]`).click();
        assert.equal(await page.locator('dialog.whd').getAttribute('data-tone'), 'danger');
        await page.locator('dialog.whd .whd-cancel').click();
        assert.equal(calls(s, 'xa_vai_it_report_delete').length, 0, 'Huỷ: không xoá');
        await out.locator(`[data-out-del="${uid(41)}"]`).click();
        await page.locator('dialog.whd .whd-ok').click();
        await out.locator(`[data-out-del="${uid(41)}"]`).waitFor({ state: 'detached' });
        let rd = calls(s, 'xa_vai_it_report_delete');
        assert.deepEqual(rd.at(-1).body.p_items.map(x => x.groupUid), [uid(41)]); assert.equal(rd.at(-1).auth, 'Bearer test-admin-token');
        assert.equal(typeof rd.at(-1).body.p_items[0].lastAt, 'string', 'gửi kèm giờ quét cuối đang thấy');
        await page.waitForFunction(() => /Đã xoá 1 dòng Ngoài đợt xả/.test(document.getElementById('xa-vai-message').textContent));
        // Máy xưởng quét lại uid(44) sau khi Admin tải danh sách: Xoá hết không xoá lượt mới, báo vàng, danh sách tải lại.
        s.outside.outside.find(x => x.groupUid === uid(44)).lastAt = new Date(Date.now() + 1000).toISOString();
        await out.locator('[data-out-del-all]').click();
        assert.match(await page.locator('dialog.whd .whd-list').innerText(), new RegExp(uid(44)));
        await page.locator('dialog.whd .whd-ok').click();
        await page.waitForFunction(() => /Đã xoá 0 dòng Ngoài đợt xả · 1 dòng có lượt quét mới/.test(document.getElementById('xa-vai-message').textContent));
        assert.equal(await page.locator('#xa-vai-message').getAttribute('data-tone'), 'warn');
        await out.locator(`[data-out-del="${uid(44)}"]`).waitFor();
        await out.locator('[data-out-del-all]').click();
        await page.locator('dialog.whd .whd-ok').click();
        await out.locator('[data-out-del-all]').waitFor({ state: 'detached' });
        rd = calls(s, 'xa_vai_it_report_delete');
        assert.equal(rd.length, 3); assert.deepEqual(rd.at(-1).body.p_items.map(x => x.groupUid), [uid(44)]);
        assert.doesNotMatch(await out.innerText(), /Ngoài đợt xả · không lưu/);
        assert.equal((await page.locator('#xa-vai-it-out-count').innerText()).trim(), '1', 'còn dòng Ngoài phiếu · gắn vào đợt');
      }
      if (width < 768) await noOverflow(page, '#xa-vai-screen [data-panel="it"]');
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('xa_vai_it_browser: đợt 2 (cùng SKU gắn đợt, khác SKU chặn + báo, OUTSIDE_BATCH, đóng đợt, xoá đợt, mục Ngoài phiếu) + xem đợt + tiến độ + UID, Admin đọc phiếu (mã hàng từ ghi chú, thiếu UID, Extension cũ, phiếu chưa xuất), Lưu đợt bằng JWT Admin, pop-up quét + In A4 điền mã của đợt — 1280 + 375 passed');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
