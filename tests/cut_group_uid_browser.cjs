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
      await page.waitForFunction(() => document.querySelector('#cut-count').textContent === '1');
      assert.match(await page.locator('#cut-list').innerText(), /SKU-001.*Vải thử nghiệm/s);
      await scan('UID-0001');
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('đã được cắt'));
      await page.locator('#cut-print').click();
      await page.waitForFunction(() => document.querySelector('#cut-count').textContent === '0');
      const jobs = await page.evaluate(() => window.testJobs);
      assert.equal(jobs.length, 1);
      assert.deepEqual(jobs[0].payload.items[0], { groupUid: 'UID-0001', sku: 'SKU-001', productName: 'Vải thử nghiệm', lot: 'LOT-7', roll: 'ROLL-2', copies: 1 });
      await page.locator('#cut-sku').fill('SKU-001');
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => document.querySelector('#cut-found').textContent === '1');
      assert.match(await page.locator('#cut-results').innerText(), /SKU-001.*UID-0001.*LOT-7.*ROLL-2.*Vải thử nghiệm/s);
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#cut-export').click();
      const download = await downloadPromise, path = await download.path();
      assert.match(download.suggestedFilename(), /^Group_UID_da_cat_\d{8}\.xlsx$/);
      assert.ok(fs.statSync(path).size > 1500);
      const xlsx = fs.readFileSync(path);
      assert.equal(xlsx.includes(Buffer.from('orientation="landscape"')), true);
      for (const header of ['SKU', 'UID', 'Lot', 'Roll', 'Tên SP']) assert.equal(xlsx.includes(Buffer.from(header)), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: route, missing/duplicate UID, persistence, current label payload, status polling, SKU filter, A4 landscape XLSX, no overflow/errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
