// Run against the local static server. All external requests are intercepted;
// print jobs are captured in memory and never sent to a real queue/printer.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        if (url.endsWith('/rpc/group_uid_lookup')) {
          const { p_codes } = route.request().postDataJSON();
          await new Promise(resolve => setTimeout(resolve, 150));
          if (p_codes.includes('TEST-ERROR')) return route.fulfill({ status: 503, body: '{}' });
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(p_codes.filter(code => code !== 'TEST-UNKNOWN').map(code => ({
            group_uid_code: code, sku: code === 'TEST-NOSKU' ? '' : '000123456',
            product_name: code === 'TEST-EMPTY' ? '' : 'Vải thử nghiệm & kiểm tra', lot: 'LOT-01', roll: '007'
          }))) });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [] } }) });
      });
      await page.goto('http://127.0.0.1:8000/#group-uid');
      await page.evaluate(() => {
        window.testJobs = [];
        window.PrintSkuQueue.enqueue = async job => { window.testJobs.push(job); return { ok: true }; };
      });
      const add = async code => { await page.locator('#uid-code').fill(code); await page.locator('#uid-code').press('Enter'); };
      await add('TEST-FOUND');
      await add('TEST-FOUND'); // duplicate while request is still running
      await page.waitForFunction(() => document.querySelector('#uid-ready-count').textContent === '1');
      assert.match(await page.locator('#uid-ready').innerText(), /LOT-01.*007/);
      assert.match(await page.locator('#uid-ready').innerText(), /000123456/);
      await add('TEST-NOSKU');
      await page.waitForFunction(() => document.querySelector('#uid-ready-count').textContent === '2');
      await add('TEST-UNKNOWN');
      await add('TEST-EMPTY');
      await add('TEST-ERROR');
      await page.waitForFunction(() => document.querySelector('#uid-pending-count').textContent === '3');
      assert.equal(await page.locator('#uid-print-all').isEnabled(), true);
      await page.locator('#uid-print-all').click();
      const jobs = await page.evaluate(() => window.testJobs);
      assert.equal(jobs.length, 1);
      assert.deepEqual(jobs[0].payload.items[0], { groupUid: 'TEST-FOUND', sku: '000123456', productName: 'Vải thử nghiệm & kiểm tra', lot: 'LOT-01', roll: '007', copies: 1 });
      assert.equal(jobs[0].payload.items[1].sku, '');
      assert.equal(await page.locator('#uid-ready-count').textContent(), '0');
      assert.equal(await page.locator('#uid-pending-count').textContent(), '3');
      const empty = page.locator('#uid-pending .uid-row').filter({ hasText: 'TEST-EMPTY' });
      await empty.locator('input').check();
      await page.locator('#uid-bulk-product').fill('Tên bổ sung');
      await page.locator('#uid-apply-mapping').click();
      assert.match(await page.locator('#uid-ready').innerText(), /LOT-01.*007/);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: automatic mapping, blank SKU, duplicate, missing data, network error, manual fallback, print payload, no overflow/page errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
