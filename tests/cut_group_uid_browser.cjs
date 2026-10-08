// Run against python -m http.server 8000. External requests are intercepted.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true });
      const errors = [];
      const records = [];
      const comboLookups = [];
      const adminDeletes = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request(), url = request.url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        const rpc = url.split('/rpc/')[1] || '';
        const body = request.postDataJSON?.() || {};
        let result = { ok: true, data: {} };
        if (rpc === 'cut_group_uid_scan') {
          if (body.p_group_uid === 'MISSING') result = { ok: false, error: { code: 'GROUP_UID_NOT_READY', message: 'Group UID chưa có đủ dữ liệu.' } };
          else if (records.some(x => x.groupUid === body.p_group_uid)) result = { ok: false, error: { code: 'ALREADY_CUT', message: 'Group UID này đã được cắt trước đó' } };
          else {
            const row = { groupUid: body.p_group_uid, sku: 'SKU-001', productName: 'Vải thử nghiệm', lot: 'LOT-7', roll: 'ROLL-2', printStatus: 'pending', cutAt: new Date().toISOString() };
            records.push(row); result = { ok: true, data: row };
          }
        } else if (rpc === 'cut_group_uid_list') result = { ok: true, data: { items: records.filter(x => ['pending', 'queued', 'failed'].includes(x.printStatus)) } };
        else if (rpc === 'cut_group_uid_search') result = { ok: true, data: { items: records.filter(x => !body.p_sku || x.sku.includes(body.p_sku)) } };
        else if (rpc === 'cut_group_uid_mark_queued') { records.filter(x => body.p_codes.includes(x.groupUid)).forEach(x => { x.printStatus = 'queued'; x.printJobId = body.p_job_id; }); result = { ok: true, data: { count: body.p_codes.length } }; }
        else if (rpc === 'cut_group_uid_mark_result') { records.filter(x => x.printJobId === body.p_job_id).forEach(x => x.printStatus = body.p_status); result = { ok: true, data: { count: 1 } }; }
        else if (rpc === 'cut_group_uid_remove') { const i = records.findIndex(x => x.groupUid === body.p_group_uid); if (i >= 0) records.splice(i, 1); result = { ok: true, data: {} }; }
        else if (rpc === 'print_queue_status') result = { ok: true, data: { agents: [] } };
        // RPC trả mảng như PostgREST; mảng rỗng = không phải SKU Combo. COMBO-001 là mã Combo giả của SKU-001.
        else if (rpc === 'sku_combo_lookup') {
          comboLookups.push(body.p_sku);
          result = body.p_sku === 'COMBO-001' ? [{ normal_sku: 'SKU-001', product_name: 'Vải thử nghiệm', category_name: 'Thời Trang (NVL)', quantity: 1000, available: true }] : [];
        }
        // Đăng nhập Admin (Supabase Auth giả lập) + RPC xóa chỉ nhận đúng token Admin.
        else if (url.includes('/auth/v1/token')) result = { access_token: 'test-admin-token', refresh_token: 'test-refresh', token_type: 'bearer' };
        else if (url.includes('/auth/v1/user')) result = { id: '00000000-0000-4000-8000-000000000001', email: 'admin@test.vn' };
        else if (url.includes('/rest/v1/user_roles')) result = [{ username: 'admin', role: 'admin' }];
        else if (url.includes('/auth/v1/logout')) result = {};
        else if (rpc === 'cut_group_uid_admin_delete') {
          adminDeletes.push({ auth: request.headers().authorization, codes: body.p_codes });
          if (request.headers().authorization !== 'Bearer test-admin-token') result = { ok: false, error: { code: 'FORBIDDEN', message: 'Chỉ Admin được xóa Group UID đã cắt' } };
          else { const gone = records.filter(x => body.p_codes.includes(x.groupUid)).map(x => x.groupUid); gone.forEach(code => records.splice(records.findIndex(x => x.groupUid === code), 1)); result = { ok: true, data: { count: gone.length, codes: gone, missing: body.p_codes.length - gone.length } }; }
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      });
      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-cut-uid').click();
      assert.equal(page.url().endsWith('#cut-group-uid'), true);
      await page.locator('#cut-group-uid-screen').waitFor({ state: 'visible' });
      assert.deepEqual(await page.locator('#cut-group-uid-screen').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { position: getComputedStyle(element).position, top: rect.top, left: rect.left, width: rect.width, viewport: innerWidth };
      }), { position: 'fixed', top: 0, left: 0, width, viewport: width });
      await page.evaluate(() => {
        window.testJobs = [];
        window.PrintSkuQueue.enqueue = async job => { window.testJobs.push(job); return { ok: true, data: { id: '11111111-1111-4111-8111-111111111111' } }; };
        window.PrintSkuQueue.jobStatus = async () => ({ ok: true, data: { status: 'completed' } });
      });
      const scan = async uid => { await page.locator('#cut-code').fill(uid); await page.locator('#cut-code').press('Enter'); };
      await scan('MISSING');
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('cập nhật'));
      await scan('UID-0001');
      // Quét chỉ lưu tem; thông báo "Đã lưu tem" bị ghi đè ngay khi tra cứu tự chạy nên chờ thẻ UID vừa quét.
      await page.waitForFunction(() => {
        const last = document.querySelector('#cut-last');
        return !last.hidden && last.textContent.includes('UID-0001') && !document.querySelector('#cut-add').disabled;
      });
      assert.equal(await page.locator('#cut-count').textContent(), '0');
      await scan('UID-0001');
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('đã được cắt'));
      // Tem chỉ vào hàng chờ in sau khi chọn ở Tra cứu và đưa vào hàng chờ.
      await page.locator('#cut-tab-data').click();
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => document.querySelector('#cut-found').textContent === '1');
      await page.locator('#cut-search-all').check();
      await page.locator('#cut-push').click();
      await page.waitForFunction(() => document.querySelector('#cut-count').textContent === '1');
      assert.match(await page.locator('#cut-list').innerText(), /SKU-001.*Vải thử nghiệm/s);
      await page.locator('#cut-print').click();
      await page.waitForFunction(() => document.querySelector('#cut-count').textContent === '0');
      // Nút In tem chỉ dừng animation khi lệnh in xong (jobStatus = completed).
      await page.waitForFunction(() => ['idle', 'disabled'].includes(document.querySelector('#cut-print').dataset.printState));
      const jobs = await page.evaluate(() => window.testJobs);
      assert.equal(jobs.length, 1);
      assert.deepEqual(jobs[0].payload.items[0], { groupUid: 'UID-0001', sku: 'SKU-001', productName: 'Vải thử nghiệm', lot: 'LOT-7', roll: 'ROLL-2', copies: 1 });
      for (let number = 2; number <= 80; number++) records.push({
        groupUid: `UID-${String(number).padStart(4, '0')}`, sku: 'SKU-001',
        productName: 'Vải thử nghiệm có tên dài để kiểm tra tự xuống dòng trong packing list',
        lot: 'LOT-7', roll: String(number), printStatus: 'printed', cutAt: new Date().toISOString()
      });
      await page.locator('#cut-tab-data').click();
      await page.locator('#cut-sku').fill('SKU-001');
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => document.querySelector('#cut-found').textContent === '80');
      assert.match(await page.locator('#cut-results').innerText(), /SKU-001.*UID-0001.*LOT-7.*ROLL-2.*Vải thử nghiệm/s);
      // Gõ mã SKU Combo: hỏi SKU Normal bằng hộp chọn dùng chung, chọn xong ô lọc đổi sang mã Normal rồi mới tìm.
      await page.locator('#cut-sku').fill('COMBO-001');
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      const comboDialog = page.locator('dialog.sku-combo-dialog');
      await comboDialog.waitFor({ state: 'visible' });
      assert.equal(await comboDialog.locator('h2').textContent(), 'Chọn SKU Normal để tra cứu');
      await comboDialog.locator('.sku-combo-option').click();
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('SKU Combo COMBO-001 → SKU Normal SKU-001'));
      assert.equal(await page.locator('#cut-sku').inputValue(), 'SKU-001');
      assert.equal(await page.locator('#cut-found').textContent(), '80');
      // Chỉ tra Combo khi người dùng bấm tìm (không ở các lượt tải lại tự động); mã Normal vừa chọn không tra lại.
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => /^Tìm thấy 80 UID/.test(document.querySelector('#cut-message').textContent));
      assert.deepEqual(comboLookups, ['SKU-001', 'COMBO-001']);
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#cut-export').click();
      const download = await downloadPromise, path = await download.path();
      if (process.env.CUT_XLSX_OUTPUT && width === 1280) await download.saveAs(process.env.CUT_XLSX_OUTPUT);
      assert.match(download.suggestedFilename(), /^Group_UID_da_cat_\d{8}\.xlsx$/);
      assert.ok(fs.statSync(path).size > 1500);
      const xlsx = fs.readFileSync(path);
      assert.equal(xlsx.includes(Buffer.from('orientation="landscape"')), true);
      assert.equal(xlsx.includes(Buffer.from('fitToWidth="1" fitToHeight="0" pageOrder="downThenOver"')), true);
      assert.equal(xlsx.includes(Buffer.from('_xlnm.Print_Titles')), true);
      assert.equal(xlsx.includes(Buffer.from('<sz val="12"/>')), true);
      assert.equal(xlsx.includes(Buffer.from('rgb="FF1F4E78"')), true);
      assert.equal(xlsx.includes(Buffer.from('<left style="thin">')), true);
      assert.equal(xlsx.includes(Buffer.from('<c r="A2" s="2"')), true);
      assert.equal(xlsx.includes(Buffer.from('ref="A1:E81"')), true);
      for (const header of ['SKU', 'UID', 'Lot', 'Roll', 'Tên SP']) assert.equal(xlsx.includes(Buffer.from(header)), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // Quét UID bằng camera điện thoại: giả lập camera + bộ đọc mã. Mã 9 số (SKU trên cùng tem) bị hỏi lại, mã 16 số được lưu.
      await page.locator('#cut-tab-scan').click();
      assert.equal(await page.locator('#cut-camera').isVisible(), true);
      await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 240;
        const ctx = canvas.getContext('2d'); setInterval(() => { ctx.fillStyle = '#345'; ctx.fillRect(0, 0, 320, 240); }, 100);
        window.testNextCode = '422467418';
        window.PrintSkuScanner = { ...window.PrintSkuScanner, gl: () => true, k0: () => true, Jp: async () => ({ doc: async () => ({ ma: window.testNextCode }) }), ev: async () => canvas.captureStream(10) };
      });
      await page.locator('#cut-camera').click();
      const scanner = page.locator('.pss');
      await page.waitForFunction(() => document.querySelector('.pss')?.dataset.state === 'warn');
      assert.match(await scanner.locator('.pss-card').innerText(), /Mã này không phải Group UID.*422467418/s);
      assert.equal(await scanner.locator('.pss-type span').textContent(), 'Gõ tay mã UID');
      await page.evaluate(() => { window.testNextCode = '1028269999000001'; });
      await scanner.locator('[data-act="again"]').click();
      await scanner.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.querySelector('#cut-last').textContent.includes('1028269999000001'));
      assert.equal(records.some(x => x.groupUid === '1028269999000001'), true);
      assert.equal(records.some(x => x.groupUid === '422467418'), false);
      // Admin: icon khiên mở hộp đăng nhập dùng chung; đăng nhập xong ở lại CẮT UID, hiện nút Xóa; ô quét không giành focus của ô email.
      assert.equal(await page.locator('#cut-admin').getAttribute('aria-pressed'), 'false');
      assert.equal(await page.locator('#cut-delete').isVisible(), false);
      await page.locator('#cut-admin').click();
      await page.locator('#admin-auth').waitFor({ state: 'visible' });
      await page.locator('#admin-auth-email').click();
      await page.keyboard.type('admin@test.vn');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'admin-auth-email');
      await page.locator('#admin-auth-password').fill('mat-khau-thu');
      await page.locator('#admin-auth-submit').click();
      await page.locator('#admin-auth').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => document.querySelector('#cut-admin').getAttribute('aria-pressed') === 'true');
      assert.equal(page.url().endsWith('#cut-group-uid'), true);
      await page.locator('#cut-tab-data').click();
      assert.equal(await page.locator('#cut-delete').isVisible(), true);
      await page.locator('#cut-sku').fill('');
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      const before = Number(await page.waitForFunction(() => document.querySelector('#cut-message').textContent.startsWith('Tìm thấy') && document.querySelector('#cut-found').textContent).then(h => h.jsonValue()));
      await page.locator('#cut-results tr[data-code="UID-0002"] input[type=checkbox]').check();
      assert.equal(await page.locator('#cut-delete').textContent(), 'Xóa 1 UID');
      await page.locator('#cut-delete').click();
      await page.locator('dialog .whd-ok').click();
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.startsWith('Đã xóa 1 UID'));
      assert.deepEqual(adminDeletes, [{ auth: 'Bearer test-admin-token', codes: ['UID-0002'] }]);
      assert.equal(records.some(x => x.groupUid === 'UID-0002'), false);
      assert.equal(await page.locator('#cut-found').textContent(), String(before - 1));
      // Thoát Admin: ở lại màn, ẩn nút Xóa.
      await page.locator('#cut-admin').click();
      await page.locator('dialog .whd-ok').click();
      await page.waitForFunction(() => document.querySelector('#cut-admin').getAttribute('aria-pressed') === 'false');
      assert.equal(await page.locator('#cut-delete').isVisible(), false);
      assert.equal(page.url().endsWith('#cut-group-uid'), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: route, missing/duplicate UID, persistence, current label payload, status polling, SKU filter, combo→normal SKU filter, A4 landscape XLSX, camera UID scan, admin login/delete/logout, no overflow/errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
