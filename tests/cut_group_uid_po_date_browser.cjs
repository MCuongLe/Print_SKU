// CẮT GROUP UID → tab "Tem chờ in": hai ô tùy chọn Số PO + Ngày nhận như IN TEM GROUP UID (21/10/2026, agent 0.10.0). Áp cho mọi tem của lệnh,
// ngày gửi dạng dd/mm/yyyy, PO sai mẫu / năm 0026 bị chặn không gửi, hai ô khóa trong lúc gửi và xóa khi gửi xong, sửa PO rồi gửi lại là nonce mới.
// Chạy với python -m http.server 8000; Supabase giả lập, lệnh in chỉ bắt trong bộ nhớ.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      const records = ['CUT-0001', 'CUT-0002', 'CUT-0003'].map((groupUid, i) => ({ groupUid, sku: '900000001', productName: 'Vải thử nghiệm', lot: 'LOT-7', roll: String(i + 1), printStatus: 'pending', cutAt: new Date().toISOString() }));
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/*', route => {
        const request = route.request(), url = request.url();
        if (url.startsWith(BASE)) return route.continue();
        const rpc = url.split('/rpc/')[1] || '';
        const body = request.postDataJSON?.() || {};
        let result = { ok: true, data: {} };
        if (rpc === 'cut_group_uid_search') result = { ok: true, data: { items: records.filter(x => !body.p_sku || x.sku.includes(body.p_sku)) } };
        else if (rpc === 'cut_group_uid_list') result = { ok: true, data: { items: records.filter(x => ['pending', 'failed'].includes(x.printStatus)) } };
        else if (rpc === 'cut_group_uid_mark_queued') { records.filter(x => body.p_codes.includes(x.groupUid)).forEach(x => { x.printStatus = 'queued'; }); result = { ok: true, data: { count: body.p_codes.length } }; }
        else if (rpc === 'print_queue_status') result = { ok: true, data: { agents: [] } };
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      });
      await page.goto(BASE + '#cut-group-uid');
      await page.locator('#cut-group-uid-screen').waitFor({ state: 'visible' });
      await page.evaluate(() => {
        window.testJobs = []; window.testNonces = []; window.failNext = 0; window.delayMs = 0;
        window.PrintSkuQueue.enqueue = async job => {
          window.testNonces.push(job.requestNonce);
          if (window.delayMs) await new Promise(resolve => setTimeout(resolve, window.delayMs));
          if (window.failNext > 0) { window.failNext -= 1; return { ok: false, error: { message: 'lỗi giả lập' } }; }
          window.testJobs.push(job); return { ok: true, data: { id: '11111111-1111-4111-8111-111111111111' } };
        };
        window.PrintSkuQueue.jobStatus = async () => ({ ok: true, data: { status: 'completed' } });
      });
      // Tem vào hàng chờ in sau khi chọn ở Tra cứu rồi bấm đưa vào hàng chờ (như cut_group_uid_browser)
      const stage = async () => {
        records.forEach(x => { x.printStatus = 'pending'; });
        await page.locator('#cut-tab-data').click();
        await page.locator('#cut-search').evaluate(form => form.requestSubmit());
        await page.waitForFunction(() => document.querySelector('#cut-found').textContent === '3');
        await page.locator('#cut-search-all').check();
        await page.locator('#cut-push').click();
        await page.waitForFunction(() => document.querySelector('#cut-count').textContent === '3');
        await page.locator('#cut-tab-print').click();
      };
      const reset = stage;
      const jobs = () => page.evaluate(() => window.testJobs);
      const printAll = async () => { await page.locator('#cut-all').check(); await page.locator('#cut-print').click(); };
      await stage();

      // Hai ô cạnh nhau trong tab Tem chờ in, trống ban đầu
      const poBox = await page.locator('#cut-print-po').boundingBox(), dateBox = await page.locator('#cut-print-date').boundingBox();
      assert.ok(poBox && dateBox, 'ô PO và ngày nhận phải hiện');
      assert.ok(Math.abs(poBox.y - dateBox.y) < 2 && dateBox.x > poBox.x + poBox.width - 2, `hai ô cùng hàng (${width}px)`);
      assert.equal(await page.locator('#cut-print-po').inputValue(), '');

      // 1) Không nhập: tem như cũ, po / receivedDate rỗng
      await printAll();
      await page.waitForFunction(() => window.testJobs.length === 1);
      let items = (await jobs())[0].payload.items;
      assert.equal(items.length, 3);
      for (const item of items) assert.deepEqual([item.po, item.receivedDate], ['', '']);
      await reset();

      // 2) Nhập PO + ngày: áp cho cả 3 tem, ngày dd/mm/yyyy, dòng nhắc, xóa ô sau khi gửi
      await page.locator('#cut-print-po').fill(' 10000000000001 ');
      await page.locator('#cut-print-date').fill('2026-06-15');
      assert.equal(await page.locator('#cut-print-date-echo').innerText(), '· 15/06/2026');
      await printAll();
      await page.waitForFunction(() => window.testJobs.length === 2);
      items = (await jobs())[1].payload.items;
      for (const item of items) assert.deepEqual([item.po, item.receivedDate], ['10000000000001', '15/06/2026']);
      assert.equal(await page.locator('#cut-print-po').inputValue(), '', 'gửi xong xóa ô PO');
      assert.equal(await page.locator('#cut-print-date').inputValue(), '', 'gửi xong xóa ô ngày');
      assert.equal(await page.locator('#cut-print-date-echo').innerText(), '');
      await reset();

      // 3) PO sai mẫu / quá 20 ký tự, năm 0026: dừng và báo, không gửi, giữ ô, đưa con trỏ về ô lỗi
      const jobsBefore = (await jobs()).length;
      for (const bad of ['9'.repeat(21), 'PO@123']) {
        await page.locator('#cut-print-po').fill(bad);
        await printAll();
        await page.waitForFunction(() => /Số PO chỉ gồm/.test(document.querySelector('#cut-message').textContent));
        assert.equal((await jobs()).length, jobsBefore, `PO "${bad}" không được gửi`);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'cut-print-po');
        assert.equal(await page.locator('#cut-print-po').inputValue(), bad);
      }
      await page.locator('#cut-print-po').fill('');
      await page.locator('#cut-print-date').evaluate(el => { el.value = '0026-06-15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await printAll();
      await page.waitForFunction(() => /Ngày nhận chưa hợp lệ/.test(document.querySelector('#cut-message').textContent));
      assert.equal((await jobs()).length, jobsBefore, 'năm 0026 không được gửi');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'cut-print-date');
      await page.locator('#cut-print-date').evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });

      // 4) Hai ô khóa trong lúc gửi, mở lại và xóa khi xong
      await page.locator('#cut-print-po').fill('PO-LOCK');
      await page.evaluate(() => { window.delayMs = 600; });
      await printAll();
      await page.waitForFunction(() => document.getElementById('cut-print-po').disabled);
      assert.equal(await page.locator('#cut-print-date').isDisabled(), true);
      await page.waitForFunction(count => window.testJobs.length === count + 1, jobsBefore);
      await page.waitForFunction(() => !document.getElementById('cut-print-po').disabled);
      assert.equal(await page.locator('#cut-print-po').inputValue(), '');
      await page.evaluate(() => { window.delayMs = 0; });
      await reset();

      // 5) Gửi lỗi rồi thử lại: cùng nội dung dùng lại nonce; sửa PO thì nonce mới
      await page.locator('#cut-print-po').fill('PO-A');
      await page.evaluate(() => { window.failNext = 2; window.testNonces = []; });
      await printAll();
      await page.waitForFunction(() => window.testNonces.length === 1);
      await page.waitForFunction(() => !document.getElementById('cut-print-po').disabled && /Chưa xác nhận/.test(document.querySelector('#cut-message').textContent));
      assert.equal(await page.locator('#cut-print-po').inputValue(), 'PO-A', 'lỗi gửi thì giữ ô để thử lại');
      await page.locator('#cut-print').click();
      await page.waitForFunction(() => window.testNonces.length === 2);
      await page.waitForFunction(() => !document.getElementById('cut-print-po').disabled);
      await page.locator('#cut-print-po').fill('PO-B');
      await page.locator('#cut-print').click();
      await page.waitForFunction(() => window.testNonces.length === 3);
      const nonces = await page.evaluate(() => window.testNonces);
      assert.equal(nonces[0], nonces[1], 'cùng nội dung → cùng nonce');
      assert.notEqual(nonces[1], nonces[2], 'đổi PO → nonce mới');

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      if (process.env.SHOT) { await page.locator('#cut-print-po').fill('10000000000001'); await page.locator('#cut-print-date').fill('2026-06-15'); await page.screenshot({ path: `${process.env.SHOT}-cut-${width}.png` }); }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: CẮT GROUP UID có ô Số PO + Ngày nhận (áp cho cả lệnh, chặn PO/ngày sai, khóa khi gửi, nonce theo nội dung, không tràn ngang)`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
