// Màn #admin/lenh-in (08/10/2026): gộp "Tổng quan" + "Đợt đã gửi" thành danh sách lệnh in theo ngày của cả kho,
// lọc SKU/UID, tìm kiếm, popup chi tiết; in lại SKU = nguyên lệnh, UID = toàn bộ hoặc một phần dòng.
// Run against python -m http.server 8000. Supabase được giả lập (dữ liệu tổng hợp); không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const at = (hh, mm) => new Date(`${TODAY}T${hh}:${mm}:00+07:00`).toISOString();

const JOBS = [
  { id: 'aaaa1111-0000-4000-8000-000000000001', type: 'sku', status: 'completed', copies: 6, source: 'Máy kho', createdAt: at('10', '31'), completedAt: at('10', '31'),
    items: [{ sku: '900000101', productName: 'Vải mẫu A cotton xanh navy', quantity: '', printedDate: '08/10/26', copies: 2 },
            { sku: '900000102', productName: 'Vải mẫu A cotton đỏ đô', quantity: '', printedDate: '08/10/26', copies: 2 },
            { sku: '900000103', productName: 'Chỉ mẫu B polyester trắng', quantity: '', printedDate: '08/10/26', copies: 2 }] },
  { id: 'bbbb2222-0000-4000-8000-000000000002', type: 'group_uid', status: 'completed', copies: 3, source: 'web-group-uid', createdAt: at('09', '58'), completedAt: at('09', '58'),
    items: [{ groupUid: '1028260900000101', sku: '900000201', productName: 'Vải mẫu C canvas đen', lot: '11', roll: '16', copies: 1 },
            { groupUid: '1028260900000102', sku: '900000201', productName: 'Vải mẫu C canvas đen', lot: '11', roll: '20', copies: 1 },
            { groupUid: '1028260900000103', sku: '900000201', productName: 'Vải mẫu C canvas đen', lot: '5', roll: '2', copies: 1 }] },
  { id: 'cccc3333-0000-4000-8000-000000000003', type: 'sku', status: 'failed', copies: 10, source: 'web-find-sku', createdAt: at('09', '52'), completedAt: null,
    errorCode: 'PRINTER_STALLED', errorMessage: 'Máy in đứng quá 600 giây',
    items: [{ sku: '900000301', productName: 'Dây kéo mẫu D size 7 50cm', quantity: '', printedDate: '08/10/26', copies: 10 }] },
  { id: 'dddd4444-0000-4000-8000-000000000004', type: 'sku', status: 'queued', copies: 2, source: 'Máy kho · in lại aaaa1111', reprintOf: 'aaaa1111-0000-4000-8000-000000000001', createdAt: at('10', '40'), completedAt: null,
    items: [{ sku: '900000401', productName: 'Nút mẫu E 4 lỗ nâu', quantity: '', printedDate: '08/10/26', copies: 2 }] },
  { id: 'eeee5555-0000-4000-8000-000000000005', type: 'location', status: 'completed', copies: 1, source: 'web-location', createdAt: at('08', '15'), completedAt: at('08', '15'),
    items: [{ code: 'Z99-T01-001-01-01-01', name: 'Kệ thử', copies: 1 }] },
];
const kind = job => (job.type === 'sku' || job.type === 'group_uid' ? job.type : 'other');
const text = job => [job.id, job.source, ...job.items.flatMap(it => [it.sku, it.groupUid, it.productName, it.code, it.name])].join(' ').toLowerCase();

function mock(page, calls) {
  return page.route('**/*', async route => {
    const url = route.request().url();
    const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
    if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    const args = JSON.parse(route.request().postData() || '{}');
    if (rpc) calls.push({ rpc, args });
    if (rpc === 'print_queue_status') return json({ ok: true, data: { queued: 1, queuedCopies: 2, active: 0, agents: [{ id: 'may-kho-01', state: { version: '0.8.9', printer: { ok: true, blocked: false, message: 'sẵn sàng' } }, lastSeenAt: new Date().toISOString() }] } });
    if (rpc === 'print_admin_jobs') {
      const day = args.p_day || TODAY, q = String(args.p_query || '').toLowerCase();
      const dayJobs = day === TODAY ? JOBS : [];
      const matched = dayJobs.filter(job => !q || text(job).includes(q));
      const shown = matched.filter(job => args.p_type === 'all' || kind(job) === args.p_type);
      return json({ ok: true, data: {
        day, today: TODAY, oldestDay: '2026-10-05',
        summary: { jobs: dayJobs.length, copies: dayJobs.reduce((n, j) => n + j.copies, 0), failed: dayJobs.filter(j => j.status === 'failed').length, active: 1 },
        counts: { all: matched.length, sku: matched.filter(j => kind(j) === 'sku').length, group_uid: matched.filter(j => kind(j) === 'group_uid').length, other: matched.filter(j => kind(j) === 'other').length },
        jobs: shown.map(job => ({ id: job.id, type: job.type, kind: kind(job), status: job.status, copies: job.copies, itemCount: job.items.length, first: job.items[0], source: job.source,
          createdAt: job.createdAt, completedAt: job.completedAt, errorCode: job.errorCode || null, errorMessage: job.errorMessage || null, reprintOf: job.reprintOf || null, reprintCount: 0 })),
      } });
    }
    if (rpc === 'print_admin_job') {
      const job = JOBS.find(j => j.id === args.p_job_id) || { id: args.p_job_id, type: 'sku', status: 'queued', copies: 2, source: 'x', items: [], createdAt: new Date().toISOString() };
      const final = ['completed', 'failed', 'cancelled'].includes(job.status);
      return json({ ok: true, data: { ...job, items: job.items.map((it, index) => ({ ...it, index })), reprints: job.id === JOBS[0].id ? [{ id: JOBS[3].id, status: 'queued', copies: 2, createdAt: JOBS[3].createdAt }] : [],
        reprint: { allowed: ['sku', 'group_uid'].includes(job.type) && final && job.items.length > 0, partial: job.type === 'group_uid', reason: !['sku', 'group_uid'].includes(job.type) ? 'NOT_SUPPORTED' : final ? null : 'JOB_ACTIVE' } } });
    }
    if (rpc === 'print_admin_reprint') {
      const job = JOBS.find(j => j.id === args.p_job_id);
      const items = args.p_items ? args.p_items.map(i => job.items[i]) : job.items;
      return json({ ok: true, data: { id: 'ffff6666-0000-4000-8000-000000000006', status: 'queued', duplicate: false, copies: items.reduce((n, it) => n + it.copies, 0), itemCount: items.length, reprintOf: job.id } });
    }
    if (url.includes('/rest/v1/') && !rpc) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
}

const rows = page => page.locator('#pj-list .pj-row:not(.pj-head)');
// PJ_SHOTS=<thư mục> thì chụp màn hình ở vài bước để xem bằng mắt (không bắt buộc).
const shot = async (page, name, fullPage = false) => { if (process.env.PJ_SHOTS) await page.screenshot({ path: `${process.env.PJ_SHOTS}/${name}.png`, fullPage }); };
const lastCall = (calls, name) => [...calls].reverse().find(call => call.rpc === name);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      const page = await context.newPage();
      const errors = [], calls = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await mock(page, calls);

      // Hash cũ Tổng quan / Đợt đã gửi chuyển về Lệnh in; React ẩn
      for (const old of ['#admin/tongquan', '#admin/hangdoi']) {
        await page.goto(BASE + old);
        await page.waitForFunction(() => location.hash === '#admin/lenh-in');
        await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#root').isVisible(), false, old);
      }
      await rows(page).first().waitFor();

      // Menu riêng: Lệnh in đứng đầu, đủ icon; không còn Tổng quan / Đợt đã gửi
      const nav = await page.locator('#print-jobs-screen .ss-nav button').allInnerTexts();
      assert.deepEqual(nav.map(t => t.trim()), ['Lệnh in', 'Đồng bộ SKU', 'Đồng bộ Group UID', 'Cấu hình']);
      assert.equal(await page.locator('#print-jobs-screen .ss-nav button svg').count(), 4);
      for (const id of ['sku-sync-screen', 'group-uid-sync-screen']) {
        const other = (await page.locator(`#${id} .ss-nav`).innerText());
        assert.equal(/Tổng quan|Đợt đã gửi/.test(other), false, `${id} không còn mục cũ`);
        assert.equal(other.includes('Lệnh in'), true, `${id} có Lệnh in`);
      }

      // Dải trạng thái cả kho + số theo ngày
      assert.equal((await page.locator('#pj-stat-printer strong').innerText()).trim(), 'Sẵn sàng');
      assert.match(await page.locator('#pj-stat-printer small').innerText(), /v0\.8\.9/);
      assert.equal((await page.locator('#pj-stat-queue strong').innerText()).trim(), '1');
      assert.equal((await page.locator('#pj-stat-day strong').innerText()).trim(), '5 lệnh');
      assert.equal((await page.locator('#pj-stat-failed strong').innerText()).trim(), '1');
      assert.equal(await page.locator('#pj-stat-failed').getAttribute('data-tone'), 'bad');

      await shot(page, `list-${width}`, true);
      // Danh sách: đủ lệnh, nhãn In lại, nguồn đổi sang tên màn
      assert.equal(await rows(page).count(), 5);
      assert.deepEqual([await page.locator('#pj-count-all').innerText(), await page.locator('#pj-count-sku').innerText(), await page.locator('#pj-count-uid').innerText()], ['5', '3', '1']);
      const reRow = rows(page).filter({ hasText: 'Nút mẫu E' });
      assert.equal(await reRow.locator('.pj-re').count(), 1);
      assert.equal(await reRow.locator('.pj-end .pj-badge').count(), 1, 'cột trạng thái chỉ một nhãn');
      if (width >= 768) assert.equal((await rows(page).filter({ hasText: 'Dây kéo mẫu D' }).locator('.pj-src').innerText()).trim(), 'TÌM SKU');
      assert.equal(await page.locator('#pj-today').isHidden(), true);
      assert.equal(await page.locator('#pj-next').isDisabled(), true, 'không đi tới ngày mai');

      // Lọc UID → chỉ lệnh UID; Tất cả → đủ lại
      await page.locator('[data-pj-type="group_uid"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#pj-list .pj-row:not(.pj-head)').length === 1);
      assert.equal(lastCall(calls, 'print_admin_jobs').args.p_type, 'group_uid');
      assert.equal(await page.locator('[data-pj-type="group_uid"]').getAttribute('aria-pressed'), 'true');
      await page.locator('[data-pj-type="all"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#pj-list .pj-row:not(.pj-head)').length === 5);

      // Tìm theo SKU (gửi lên máy chủ)
      await page.locator('#pj-query').fill('900000301');
      await page.waitForFunction(() => document.querySelectorAll('#pj-list .pj-row:not(.pj-head)').length === 1);
      assert.equal(lastCall(calls, 'print_admin_jobs').args.p_query, '900000301');
      await page.locator('#pj-query').fill('khongcolenhnao');
      await page.waitForFunction(() => /Không có lệnh khớp/.test(document.getElementById('pj-list').textContent));
      await page.locator('#pj-query').fill('');
      await page.waitForFunction(() => document.querySelectorAll('#pj-list .pj-row:not(.pj-head)').length === 5);

      // Ngày trước: rỗng, hiện nút Hôm nay; quay lại Hôm nay
      await page.locator('#pj-prev').click();
      await page.waitForFunction(() => /Chưa có lệnh in/.test(document.getElementById('pj-list').textContent));
      assert.notEqual(lastCall(calls, 'print_admin_jobs').args.p_day, TODAY);
      assert.equal(await page.locator('#pj-today').isVisible(), true);
      assert.match(await page.locator('#pj-day-label').textContent(), /^Ngày \d\d\/\d\d$/);
      await page.locator('#pj-today').click();
      await page.waitForFunction(() => document.querySelectorAll('#pj-list .pj-row:not(.pj-head)').length === 5);

      // Popup SKU: không có ô tick, in lại nguyên lệnh (không gửi p_items)
      await rows(page).filter({ hasText: 'Vải mẫu A cotton xanh navy' }).click();
      const dlg = page.locator('#pj-dialog');
      await dlg.waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelectorAll('#pj-d-tbody tr[data-index]').length === 3);
      assert.equal(await dlg.locator('input[type=checkbox]:visible').count(), 0, 'SKU không cho chọn từng dòng');
      assert.match(await page.locator('#pj-d-title').innerText(), /^SKU · aaaa1111$/);
      assert.match(await page.locator('#pj-d-meta').innerText(), /Ngày in 08\/10\/26/);
      assert.match(await page.locator('#pj-d-meta').innerText(), /Đã in lại/);
      assert.equal((await page.locator('#pj-d-reprint-text').innerText()).trim(), 'In lại 6 tem');
      await shot(page, `sku-popup-${width}`);
      await page.locator('#pj-d-reprint').click();
      await page.waitForFunction(() => /ffff6666/.test(document.getElementById('pj-d-note').textContent));
      const skuCall = lastCall(calls, 'print_admin_reprint');
      assert.equal(skuCall.args.p_job_id, JOBS[0].id);
      assert.equal(skuCall.args.p_items, null);
      assert.match(skuCall.args.p_nonce, /^rp-[a-z0-9]+-[a-z0-9]+$/);
      assert.equal(await page.locator('#pj-d-reprint').isDisabled(), true, 'đã gửi thì khoá nút');
      assert.equal((await page.locator('#pj-d-reprint-text').innerText()).trim(), 'Đã gửi');
      await page.locator('#pj-d-close').click();
      await dlg.waitFor({ state: 'hidden' });

      // Popup UID: tick sẵn tất cả; bỏ 1 dòng → in lại một phần, gửi đúng số thứ tự dòng
      await rows(page).filter({ hasText: '1028260900000101' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#pj-d-tbody input[data-pick]').length === 3);
      assert.equal(await page.locator('#pj-d-tbody input[data-pick]:checked').count(), 3);
      assert.equal(await page.locator('#pj-d-all').isChecked(), true);
      await page.locator('#pj-d-tbody input[data-pick="1"]').uncheck();
      assert.equal((await page.locator('#pj-d-sum').innerText()).trim(), '2/3 dòng · 2 tem');
      assert.equal(await page.locator('#pj-d-all').evaluate(box => box.indeterminate), true);
      assert.equal((await page.locator('#pj-d-reprint-text').innerText()).trim(), 'In lại 2 tem');
      await page.locator('#pj-d-all').check();   // đang lửng → bấm là chọn hết
      assert.equal((await page.locator('#pj-d-sum').innerText()).trim(), '3/3 dòng · 3 tem');
      await page.locator('#pj-d-all').uncheck();
      assert.equal(await page.locator('#pj-d-reprint').isDisabled(), true, 'không chọn dòng nào thì không in');
      assert.equal((await page.locator('#pj-d-reprint-text').innerText()).trim(), 'Chọn dòng');
      await page.locator('#pj-d-all').check();
      assert.equal((await page.locator('#pj-d-sum').innerText()).trim(), '3/3 dòng · 3 tem');
      await page.locator('#pj-d-tbody input[data-pick="1"]').uncheck();
      await page.locator('#pj-d-reprint').click();
      await page.waitForFunction(() => /ffff6666/.test(document.getElementById('pj-d-note').textContent));
      assert.deepEqual(lastCall(calls, 'print_admin_reprint').args.p_items, [0, 2]);
      await shot(page, `uid-popup-${width}`);
      if (width < 768) {
        const box = await dlg.boundingBox();
        assert.ok(box.width <= width + 1, 'popup vừa khổ điện thoại');
        assert.equal(await page.locator('#pj-d-tbody .meta').first().isVisible(), true, 'điện thoại hiện SKU · Lot · Roll gộp một dòng');
      }
      await page.keyboard.press('Escape');
      await dlg.waitFor({ state: 'hidden' });

      // UID: chọn đủ dòng → p_items null (nguyên lệnh)
      await rows(page).filter({ hasText: '1028260900000101' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#pj-d-tbody input[data-pick]').length === 3);
      await page.locator('#pj-d-reprint').click();
      await page.waitForFunction(() => /ffff6666/.test(document.getElementById('pj-d-note').textContent));
      assert.equal(lastCall(calls, 'print_admin_reprint').args.p_items, null);
      await page.locator('#pj-d-close').click();

      // Lệnh đang chờ: không có nút in lại; lệnh lỗi: hiện lý do; lệnh vị trí: chỉ xem
      await rows(page).filter({ hasText: 'Nút mẫu E' }).click();
      await page.waitForFunction(() => /đang chờ hoặc đang in/.test(document.getElementById('pj-d-note').textContent));
      assert.equal(await page.locator('#pj-d-reprint').isVisible(), false);
      await page.locator('#pj-d-meta button[data-open-job]').click();   // "In lại từ aaaa1111"
      await page.waitForFunction(() => /aaaa1111/.test(document.getElementById('pj-d-title').textContent));
      await page.locator('#pj-d-close').click();
      await rows(page).filter({ hasText: 'Dây kéo mẫu D' }).click();
      await page.locator('#pj-d-alert').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#pj-d-alert').innerText()).trim(), 'Máy in đứng quá 600 giây');
      assert.equal((await page.locator('#pj-d-reprint-text').innerText()).trim(), 'In lại 10 tem');
      await page.locator('#pj-d-close').click();
      await rows(page).filter({ hasText: 'Z99-T01' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#pj-d-tbody tr[data-index]').length === 1);
      assert.equal(await page.locator('#pj-d-reprint').isVisible(), false);
      await page.locator('#pj-d-close').click();

      // Menu React (màn Cấu hình): Tổng quan / Đợt đã gửi ẩn, Lệnh in đứng đầu và đưa về màn mới
      await page.goto(BASE + '#admin/cauhinh');
      await page.locator('#root').waitFor({ state: 'visible' });
      const reactNav = page.locator(width >= 768 ? '#root aside nav' : '#root header nav');
      await reactNav.locator('[data-print-jobs-nav]').waitFor({ state: 'visible' });
      for (const label of ['Tổng quan', 'Đợt đã gửi']) assert.equal(await reactNav.locator('button', { hasText: label }).isVisible(), false, `${label} ẩn`);
      assert.equal((await reactNav.locator('button:visible').first().innerText()).trim(), 'Lệnh in');
      await reactNav.locator('[data-print-jobs-nav]').click();
      await page.waitForFunction(() => location.hash === '#admin/lenh-in');
      await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });

      // Không chữ hướng dẫn dài; không cuộn ngang; không lỗi JS
      const screenText = await page.locator('#print-jobs-screen').innerText();
      for (const phrase of ['Chỉ ghi trong phiên', 'Đóng tab là mất', 'Apps Script']) assert.equal(screenText.includes(phrase), false, phrase);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không cuộn ngang');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: Lệnh in — hash cũ chuyển về, lọc SKU/UID, tìm, đổi ngày, popup, in lại SKU nguyên lệnh, UID một phần/toàn bộ, chặn lệnh đang chờ`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
