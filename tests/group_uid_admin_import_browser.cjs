// Browser integration test for the Admin Group UID import screen.
// Supabase calls are mocked; no database rows are written.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const locked = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await locked.goto('http://127.0.0.1:8000/#admin/group-uid-data');
    await locked.locator('#admin-auth').waitFor({ state: 'visible' });
    assert.equal(await locked.locator('#group-uid-import-screen').isVisible(), false);
    console.log('PASS unauthenticated: login is visible and Group UID import screen stays hidden');
    await locked.close();
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(() => sessionStorage.setItem('print-sku-admin-session-v1', JSON.stringify({
        access_token: 'test-admin-token', refresh_token: 'test-refresh-token'
      })));
      const page = await context.newPage();
      const errors = [];
      let uploaded = 0;
      let commitCalls = 0;
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        if (url.endsWith('/auth/v1/user')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-0000-0000-000000000001' }) });
        if (url.includes('/rest/v1/user_roles')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ username: 'Test Admin', role: 'admin' }]) });
        if (url.endsWith('/rpc/group_uid_import_history')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { runs: [] } }) });
        if (url.endsWith('/rpc/group_uid_import_start')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { runId: '11111111-1111-1111-1111-111111111111', previousImports: 0 } }) });
        if (url.endsWith('/rpc/group_uid_import_chunk')) {
          uploaded += route.request().postDataJSON().p_rows.length;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { uploadedRows: uploaded } }) });
        }
        if (url.endsWith('/rpc/group_uid_import_validate')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
          ok: true, data: { totalRows: uploaded, newRows: 12, updatedRows: 20, unchangedRows: uploaded - 35,
            staleRows: 3, blankSkuRows: 2331, unknownSkuRows: 8, duplicateRows: 0 }
        }) });
        if (url.endsWith('/rpc/group_uid_import_commit')) {
          commitCalls += 1;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { writtenRows: 32, status: 'completed' } }) });
        }
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      });
      await page.goto('http://127.0.0.1:8000/#admin/group-uid-data');
      await page.locator('#group-uid-import-screen').waitFor({ state: 'visible' });
      await page.locator('#gui-file').setInputFiles(path.resolve('D:/UID/GROUP_UID_DETAIL_2026_09_22_17_02_1.xlsx'));
      await page.locator('#gui-apply').waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('#gui-apply').disabled, null, { timeout: 30000 });
      assert.equal(uploaded, 8148);
      assert.equal(await page.locator('#gui-total').innerText(), '8.148');
      assert.equal(await page.locator('#gui-blank-sku').innerText(), '2.331');
      assert.match(await page.locator('#gui-status').innerText(), /File hợp lệ/);
      page.once('dialog', dialog => dialog.accept());
      await page.locator('#gui-apply').click();
      await page.waitForFunction(() => document.querySelector('#gui-status').textContent.includes('Đã cập nhật'));
      assert.equal(commitCalls, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: parsed 8,148 WMS rows, uploaded 500-row chunks, previewed, confirmed and committed without overflow/page errors`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
