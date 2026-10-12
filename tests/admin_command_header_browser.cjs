// Header B · Điều hành: kiểm tra 5 module Admin ở desktop/mobile.
// 12/10/2026 (soát Admin): thanh trên gọn — ô KPI và mốc giờ ẩn vì trùng các thẻ ngay bên dưới (script vẫn tính, chỉ không hiện).
// Chạy với python -m http.server 8000. Supabase/auth được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const ROUTES = [
  ['#admin/lenh-in', '#print-jobs-screen'],
  ['#admin/sku-sync', '#sku-sync-screen'],
  ['#admin/group-uid-sync', '#group-uid-sync-screen']
];

const mockRoutes = page => page.route('**/*', route => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.endsWith('/auth/v1/user')) return json({ id: 'test-admin' });
  if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
  if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [], devices: [] } });
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 600, hasTouch: width < 600 });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await mockRoutes(page);

      for (const [route, screen] of ROUTES) {
        await page.goto(BASE + route);
        const header = page.locator(`${screen} .ss-top[data-command-header="b"]`);
        await header.waitFor({ state: 'visible' });
        await header.locator(':scope > .an-toggle').waitFor({ state: 'visible' });
        assert.equal(await header.locator('.ss-command-kpi').count(), 1, `${route}: KPI vẫn được tính`);
        assert.equal(await header.locator('.ss-command-kpi').isVisible(), false, `${route}: KPI ẩn (trùng thẻ bên dưới)`);
        assert.equal(await header.locator('.ss-command-meta').isVisible(), false, `${route}: mốc giờ ẩn (trùng thẻ bên dưới)`);
        assert.equal(await header.locator('.ss-connection').isVisible(), true, `${route}: trạng thái kết nối hiện`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${route}: không tràn ngang`);
        assert.equal(await header.locator('.ss-top-refresh').isVisible(), width >= 1024, `${route}: hành động chính chỉ hiện đủ nhãn trên desktop`);
      }

      await page.goto(BASE + '#admin/cauhinh');
      const configHeader = page.locator('#root header.ss-command-react');
      await configHeader.waitFor({ state: 'visible' });
      assert.equal(await configHeader.locator('.ss-command-react-kpis .ss-command-kpi').count(), 2, 'Cấu hình: chip máy và mẫu tem vẫn được tính');
      assert.equal(await configHeader.locator('.ss-command-react-kpis .ss-command-kpi').first().isVisible(), false, 'Cấu hình: chip máy / mẫu tem ẩn (trùng thẻ Tên máy, Mẫu tem)');
      assert.equal(await configHeader.locator('.ss-command-react-refresh').isVisible(), width >= 1024, 'Cấu hình: hành động Kiểm tra lại responsive');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'Cấu hình: không tràn ngang');

      if (process.env.SHOT_DIR) {
        await page.goto(BASE + '#admin/lenh-in');
        await page.locator('#print-jobs-screen .ss-top[data-command-header="b"]').waitFor({ state: 'visible' });
        await page.screenshot({ path: path.join(process.env.SHOT_DIR, `header-b-${width}.png`), fullPage: false });
      }
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: 5 header B gọn (trạng thái + làm mới, KPI/mốc giờ ẩn), responsive và không tràn ngang`);
    }
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
