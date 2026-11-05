// THEO DÕI XẢ VẢI → tab "Đã in": Admin xoá dòng đã chọn (04/11/2026, Việc 6 của docs/plans/2026-11-04-xoa-lenh-da-in-khi-admin-dang-nhap.md).
// Icon khiên ở thanh tiêu đề đăng nhập Admin (hộp dùng chung, như CẮT GROUP UID); là Admin thì hiện nút Xoá; bấm → máy chủ đếm trước
// (xa_vai_printed_delete p_dry_run) → WhDialog nêu số dòng, số lệnh in A4 sẽ trống, số dòng giữ lại → xoá đúng danh sách máy chủ trả.
// Run against python -m http.server 8000 (đổi bằng BASE). Supabase giả lập, dữ liệu giả (SKU 9000000xx, UID 1028260000000xxx).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const TOKEN = 'pd_' + 'cd'.repeat(24);
const uid = n => `10282600000${String(n).padStart(5, '0')}`;
const ago = m => new Date(Date.now() - m * 60000).toISOString();
const JOB_A = '00000000-0000-4000-8000-00000000000a', JOB_B = '00000000-0000-4000-8000-00000000000b';

const seed = () => new Map([
  [uid(1), { sku: '900000001', itemCode: 'CWSH02', lot: '1', roll: '1', systemMm: 87780, actualMm: 87780, printedAt: ago(60), jobId: JOB_A }],
  [uid(2), { sku: '900000001', itemCode: 'CWSH02', lot: '1', roll: '2', systemMm: 88700, actualMm: 88700, printedAt: ago(60), jobId: JOB_A }],
  [uid(3), { sku: '900000001', itemCode: 'CWSH02', lot: '2', roll: '3', systemMm: 57610, actualMm: 57610, printedAt: ago(30), jobId: JOB_B }],
]);

function mock(page, s) {
  return page.route('**/*', async route => {
    const request = route.request(), url = request.url();
    if (url.startsWith(BASE)) return route.continue();
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/auth/v1/token')) return json({ access_token: 'test-admin-token', refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600 });
    if (url.includes('/auth/v1/user')) return json({ id: '00000000-0000-4000-8000-000000000001', email: 'admin@test.vn' });
    if (url.includes('/auth/v1/logout')) return json({});
    if (url.includes('/rest/v1/user_roles')) return json([{ username: 'admin', role: 'admin' }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (!rpc) return json([]);
    const body = request.postDataJSON?.() || {};
    s.calls.push({ rpc, body, auth: request.headers().authorization });
    const ok = data => json({ ok: true, data });
    if (rpc === 'xa_vai_measure_search' && s.searchDown) { s.searchDown = false; return route.abort('internetdisconnected'); }
    if (rpc === 'xa_vai_measure_search') return ok({ items: [...s.rows].map(([u, m]) => ({ groupUid: u, ...m, status: 'printed', measuredAt: m.printedAt, printJobId: m.jobId })), total: s.rows.size, truncated: false });
    if (rpc === 'xa_vai_measure_list') return ok({ items: [], total: 0 });
    if (rpc === 'print_queue_status') return ok({ queued: 0, queuedA4: 0, agents: [] });
    if (rpc === 'xa_vai_printed_delete') {
      if (request.headers().authorization !== 'Bearer test-admin-token') return json({ ok: false, error: { code: 'FORBIDDEN', message: 'Chỉ Admin được xoá dòng Xả vải đã in' } });
      if (s.fail && !body.p_dry_run) return json({ message: 'boom' }, 500);
      // Máy chủ đã xoá nhưng phản hồi bị cắt (HTTP 200, thân hỏng) và lần tải lại sau đó cũng lỗi mạng.
      if (s.cut && !body.p_dry_run) { s.cut = false; s.searchDown = true; body.p_group_uids.forEach(c => s.rows.delete(c)); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":tr' }); }
      // Phiên hết hạn đúng lúc xoá thật: PostgREST trả 401 một lần (web gia hạn rồi gửi lại đúng một lần).
      if (s.unauth && !body.p_dry_run) { s.unauth = false; return json({ code: 'PGRST301', message: 'JWT expired' }, 401); }
      const codes = [...new Set(body.p_group_uids)], okUids = [], skipped = [];
      for (const c of codes) {
        if (!s.rows.has(c)) skipped.push({ groupUid: c, reason: 'NOT_FOUND', status: null });
        else if (s.keep?.has(c)) skipped.push({ groupUid: c, reason: 'TOO_RECENT', status: 'printed' });
        else okUids.push(c);
      }
      const jobs = [...new Set(okUids.map(c => s.rows.get(c).jobId))].filter(j => [...s.rows].every(([c, m]) => m.jobId !== j || okUids.includes(c)));
      if (!body.p_dry_run) okUids.forEach(c => s.rows.delete(c));
      return ok({ dryRun: Boolean(body.p_dry_run), requested: codes.length, uids: okUids, rows: okUids.length, jobs: jobs.length, events: jobs.length * 7, skipped });
    }
    return ok({});
  });
}

const whd = page => page.locator('dialog.whd');
const answer = async (page, yes) => { await whd(page).waitFor({ state: 'visible' }); await whd(page).locator(yes ? '.whd-ok' : '.whd-cancel').click(); await whd(page).waitFor({ state: 'hidden' }); };
const dels = s => s.calls.filter(c => c.rpc === 'xa_vai_printed_delete');
const row = (page, n) => page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(n)}"] input[data-pick]`);
const msg = page => page.locator('#xa-vai-message').innerText();
// XV_DEL_SHOTS=<thư mục> thì chụp nút Xoá + hộp xác nhận ở từng khổ (không bắt buộc).
const shot = async (page, name) => { if (process.env.XV_DEL_SHOTS) await page.screenshot({ path: `${process.env.XV_DEL_SHOTS}/${name}.png` }); };

async function open(browser, width, s) {
  const mobile = width < 768;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 800 : 900 }, isMobile: mobile, hasTouch: mobile });
  await context.addInitScript(token => localStorage.setItem('tb-khoa', token), TOKEN);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => { errors.push(`hộp trình duyệt: ${d.message()}`); d.dismiss(); });
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await page.locator('#xa-vai-tab-printed').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length > 0);
  return { context, page, errors };
}
async function login(page) {
  await page.locator('#xa-vai-admin').click();
  await page.locator('#admin-auth').waitFor({ state: 'visible' });
  await page.locator('#admin-auth-email').fill('admin@test.vn');
  await page.locator('#admin-auth-password').fill('mat-khau-thu');
  await page.locator('#admin-auth-submit').click();
  await page.locator('#admin-auth').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#xa-vai-admin').getAttribute('aria-pressed') === 'true');
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      // ---------- 1. Chưa Admin: không có nút Xoá; đăng nhập → có nút; hỏi số đếm, Huỷ, xoá thật ----------
      {
        const s = { rows: seed(), calls: [] };
        const { context, page, errors } = await open(browser, width, s);
        const admin = page.locator('#xa-vai-admin'), del = page.locator('#xa-vai-delete');
        assert.equal(await admin.isVisible(), true, 'icon khiên ở thanh tiêu đề');
        assert.equal(await admin.getAttribute('aria-pressed'), 'false');
        assert.equal(await admin.getAttribute('aria-label'), 'Đăng nhập Admin');
        assert.equal(await del.isVisible(), false, 'chưa Admin: không có nút Xoá');
        await login(page);
        assert.equal(page.url().endsWith('#xa-vai'), true, 'đăng nhập xong ở lại màn Xả vải');
        assert.equal(await del.isVisible(), true, 'Admin: có nút Xoá');
        assert.equal(await del.isDisabled(), true, 'chưa chọn dòng: khoá nút');
        assert.equal((await del.innerText()).trim(), 'Xoá');

        await row(page, 1).check();
        await row(page, 2).check();
        assert.equal((await del.innerText()).trim(), 'Xoá · 2');
        assert.equal(await del.isEnabled(), true);
        await shot(page, `selected-${width}`);
        await del.click();
        await whd(page).waitFor({ state: 'visible' });
        assert.equal(dels(s).length, 1);
        assert.equal(dels(s)[0].body.p_dry_run, true, 'lần đầu chỉ đếm');
        assert.equal(dels(s)[0].auth, 'Bearer test-admin-token', 'gửi bằng phiên Admin, không phải khoá máy');
        assert.deepEqual([...dels(s)[0].body.p_group_uids].sort(), [uid(1), uid(2)]);
        assert.equal(await whd(page).getAttribute('data-tone'), 'danger');
        assert.equal((await whd(page).locator('.whd-title').textContent()).trim(), 'Xoá 2 dòng đã in');
        assert.deepEqual(await whd(page).locator('.whd-facts li').allTextContents(), ['2 dòng', '1 lệnh in A4', 'Không hoàn tác']);
        assert.deepEqual(await whd(page).locator('.whd-list li').allTextContents(), [uid(1), uid(2)]);
        assert.equal((await whd(page).locator('.whd-ok').textContent()).trim(), 'Xoá 2 dòng');
        await shot(page, `confirm-${width}`);
        await answer(page, false);
        assert.equal(dels(s).length, 1, 'Huỷ: không xoá');
        assert.equal(s.rows.size, 3);

        await del.click();
        await answer(page, true);
        await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length === 1);
        const real = dels(s).filter(c => c.body.p_dry_run === false);
        assert.equal(real.length, 1, 'xoá thật đúng một lần');
        assert.deepEqual([...real[0].body.p_group_uids].sort(), [uid(1), uid(2)]);
        await page.waitForFunction(() => /Đã xoá 2 dòng · 1 lệnh in A4/.test(document.getElementById('xa-vai-message').textContent));
        assert.equal((await del.innerText()).trim(), 'Xoá', 'xoá xong: bỏ chọn');
        assert.equal((await page.locator('#xa-vai-found').innerText()).trim(), '1');

        // Thoát Admin: ẩn nút Xoá, ở lại màn
        await admin.click();
        await answer(page, true);
        await page.waitForFunction(() => document.querySelector('#xa-vai-admin').getAttribute('aria-pressed') === 'false');
        assert.equal(await del.isVisible(), false);
        assert.equal(page.url().endsWith('#xa-vai'), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không cuộn ngang');
        assert.deepEqual(errors, []);
        await context.close();
      }
      // ---------- 2. Máy chủ giữ lại dòng (in < 5 phút) / không còn gì để xoá / lỗi máy chủ ----------
      {
        const s = { rows: seed(), calls: [], keep: new Set([uid(3)]) };
        const { context, page, errors } = await open(browser, width, s);
        await login(page);
        await row(page, 1).check();
        await row(page, 3).check();
        await page.locator('#xa-vai-delete').click();
        await whd(page).waitFor({ state: 'visible' });
        assert.deepEqual(await whd(page).locator('.whd-facts li').allTextContents(), ['1 dòng', '1 dòng giữ lại', 'Không hoàn tác'], 'lệnh còn dòng khác: không xoá lệnh');
        assert.deepEqual(await whd(page).locator('.whd-list li').allTextContents(), [uid(1)], 'danh sách chỉ dòng sẽ xoá');
        await answer(page, true);
        await page.waitForFunction(() => /Đã xoá 1 dòng/.test(document.getElementById('xa-vai-message').textContent));
        assert.deepEqual(dels(s).find(c => c.body.p_dry_run === false).body.p_group_uids, [uid(1)], 'xoá thật chỉ gửi dòng máy chủ cho xoá');
        // Chỉ còn dòng bị giữ: báo, không hỏi, không xoá thật
        await row(page, 3).check();
        await page.locator('#xa-vai-delete').click();
        await page.waitForFunction(() => /Không có dòng xoá được/.test(document.getElementById('xa-vai-message').textContent));
        assert.equal(await whd(page).isVisible(), false);
        assert.equal(dels(s).filter(c => c.body.p_dry_run === false).length, 1);
        // Bấm đôi: chỉ một lượt đếm, một hộp xác nhận
        s.keep = null;
        const dry0 = dels(s).filter(c => c.body.p_dry_run === true).length;
        await page.locator('#xa-vai-delete').dblclick();
        await answer(page, false);
        await page.waitForTimeout(300);
        assert.equal(dels(s).filter(c => c.body.p_dry_run === true).length, dry0 + 1, 'bấm đôi: một lượt đếm');
        assert.equal(await whd(page).isVisible(), false, 'không có hộp thứ hai');
        // Máy chủ lỗi 5xx / mất phản hồi khi xoá thật: không biết đã xoá chưa → báo "Chưa rõ", tải lại danh sách, không tự gửi lại
        s.fail = true;
        const search0 = s.calls.filter(c => c.rpc === 'xa_vai_measure_search').length;
        await page.locator('#xa-vai-delete').click();
        await answer(page, true);
        await page.waitForFunction(() => /Chưa rõ đã xoá hay chưa/.test(document.getElementById('xa-vai-message').textContent));
        assert.ok(s.calls.filter(c => c.rpc === 'xa_vai_measure_search').length > search0, 'chưa rõ: tải lại danh sách');
        assert.equal(dels(s).filter(c => c.body.p_dry_run === false).length, 2, 'không tự gửi lại lệnh xoá');
        assert.equal(await page.locator('#xa-vai-printed-rows tr[data-uid]').count(), 2);
        assert.equal((await page.locator('#xa-vai-delete').innerText()).trim(), 'Xoá · 1', 'giữ lựa chọn để thử lại');
        assert.equal(await page.locator('#xa-vai-delete').isEnabled(), true);
        // 401 ở lần xoá thật: gia hạn phiên, gửi lại đúng một lần, xoá xong
        s.fail = false; s.unauth = true;
        await page.locator('#xa-vai-delete').click();
        await answer(page, true);
        await page.waitForFunction(() => /Đã xoá 1 dòng/.test(document.getElementById('xa-vai-message').textContent));
        assert.equal(dels(s).filter(c => c.body.p_dry_run === false).length, 4, '401 → gửi lại đúng một lần');
        assert.equal(await page.locator('#xa-vai-printed-rows tr[data-uid]').count(), 1);
        // 200 thân hỏng sau khi máy chủ đã xoá + tải lại lỗi: báo chưa rõ, KHÔNG nói "đã tải lại"
        await row(page, 2).check();
        s.cut = true;
        await page.locator('#xa-vai-delete').click();
        await answer(page, true);
        await page.waitForFunction(() => /Chưa rõ đã xoá hay chưa/.test(document.getElementById('xa-vai-message').textContent));
        assert.match(await msg(page), /chưa tải lại được/);
        assert.doesNotMatch(await msg(page), /đã tải lại/);
        assert.deepEqual(errors, []);
        await context.close();
      }
      console.log(`PASS ${width}px: Xả vải Đã in — khiên đăng nhập Admin, nút Xoá chỉ Admin, đếm trước → WhDialog dòng/lệnh A4/giữ lại, Huỷ không xoá, xoá đúng danh sách máy chủ, thoát Admin ẩn nút, bấm đôi một lượt, lỗi 5xx báo chưa rõ + tải lại, 401 gửi lại một lần`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
