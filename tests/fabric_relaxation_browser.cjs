// Local UI checks only: all external traffic is mocked; no real printing.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel:'chrome', headless:true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport:{ width, height:900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.request().url().startsWith('http://localhost:8000/') ? route.continue() : route.fulfill({ contentType:'application/json', body:'{"ok":true,"data":{"agents":[],"jobs":[]}}' }));
      await page.goto('http://localhost:8000/#home');
      await page.locator('#barcode-fabric').click();
      await page.locator('#fabric-screen').waitFor({ state:'visible' });
      await page.reload();
      assert.equal(await page.locator('#fabric-screen').isVisible(), true);
      await page.evaluate(() => {
        window.jobs = []; window.failOnce = true;
        window.PrintSkuQueue.enqueue = async job => { window.jobs.push(job); if (window.failOnce) { window.failOnce=false; throw new Error('Test timeout'); } return { ok:true, data:{ id:'test-job' } }; };
        window.PrintSkuQueue.jobStatus = async () => ({ ok:true, data:{ status:'completed' } });
      });
      await page.locator('#fabric-print').click();
      assert.equal(await page.evaluate(() => window.jobs.length), 0);
      await page.locator('#fabric-code').fill('000TEST-FABRIC-01');
      for (const value of ['0', '1.5', '501']) {
        await page.locator('#fabric-copies').fill(value);
        await page.locator('#fabric-print').click();
        assert.equal(await page.evaluate(() => window.jobs.length), 0);
      }
      await page.locator('#fabric-copies').fill('3');
      await page.locator('#fabric-print').click();
      await page.waitForFunction(() => document.querySelector('#fabric-status').textContent.includes('Test timeout'));
      await page.locator('#fabric-print').click();
      await page.waitForFunction(() => document.querySelector('#fabric-status').textContent.includes('hoàn tất'));
      const jobs = await page.evaluate(() => window.jobs);
      assert.equal(jobs.length,2); assert.equal(jobs[0].requestNonce,jobs[1].requestNonce);
      assert.deepEqual(jobs[1].payload,{ itemCode:'000TEST-FABRIC-01' });
      assert.equal(jobs[1].copies,3); assert.equal(jobs[1].type,'fabric_relaxation');
      await page.locator('#fabric-code').fill('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
      assert.equal(await page.locator('#fabric-preview-code').textContent(),'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234');
      assert.equal(await page.evaluate(() => document.querySelector('#fabric-screen').scrollWidth <= innerWidth),true);
      await page.screenshot({ path:`workstation-agent/preview/fabric-ui-${width}.png`,fullPage:true });
      await page.locator('#fabric-back').click();
      await page.locator('#barcode-home').waitFor({ state:'visible' });
      await page.locator('#barcode-print-uid').click();
      await page.locator('#uid-screen').waitFor({ state:'visible' });
      assert.equal(await page.locator('#fabric-screen').isVisible(),false);
      assert.deepEqual(errors,[]);
      console.log(`PASS ${width}px: route, validation, retry nonce, queue payload, completion, long code, overflow, UID navigation`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
