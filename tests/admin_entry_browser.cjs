// Lối vào Admin nằm ở trang chủ (ô QUẢN TRỊ), không còn trong IN TEM SKU.
// Thanh admin nổi (tên + Dữ liệu UID/Đồng bộ SKU/Đăng xuất) đã bỏ; Đăng xuất nằm trong thanh bên Admin (desktop) và hàng tiêu đề (điện thoại).
// Run against python -m http.server 8000. Supabase/auth được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';

const mockRoutes = async page => page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith('/auth/v1/user')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-0000-0000-000000000001' }) });
  if (url.includes('/rest/v1/user_roles')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ username: 'Test Admin', role: 'admin' }]) });
  if (url.includes('/auth/v1/logout')) return route.fulfill({ status: 204, body: '' });
  if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
  return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [], items: [] } }) });
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      // ---- chưa đăng nhập ----
      {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await mockRoutes(page);
        await page.goto(BASE + '#home');
        const tile = page.locator('#barcode-admin');
        await tile.waitFor({ state: 'visible' });
        assert.equal((await tile.innerText()).trim(), 'QUẢN TRỊ');
        assert.equal(await page.locator('#barcode-home .barcode-home__group-title', { hasText: 'Quản trị' }).count(), 1);

        // IN TEM SKU không còn nút Quản trị (bánh răng) trong header
        await page.goto(BASE + '#worker');
        await page.locator('#print-sku-back').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#root header button[aria-label="Quản trị"]').count(), 0, 'IN TEM SKU không còn nút Quản trị');

        // Ô QUẢN TRỊ → hộp thoại đăng nhập; Hủy → về trang chủ
        await page.goto(BASE + '#home');
        await page.locator('#barcode-admin').click();
        await page.locator('#admin-auth').waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => location.hash), '#admin/lenh-in');
        assert.equal((await page.locator('.admin-auth__brand strong').innerText()).trim(), 'WH-MATERIAL');
        assert.equal((await page.locator('#admin-auth-cancel').innerText()).trim(), 'Về trang chủ');
        await page.locator('#admin-auth-cancel').click();
        await page.waitForFunction(() => location.hash === '#home');
        assert.equal(await page.locator('#admin-auth').isVisible(), false);
        await page.locator('#barcode-home').waitFor({ state: 'visible' });
        assert.deepEqual(errors, []);
        await page.close();
      }

      // ---- đã đăng nhập (phiên giả lập) ----
      {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await mockRoutes(page);
        // 08/10/2026: ô QUẢN TRỊ mở thẳng màn "Lệnh in" (gộp Tổng quan + Đợt đã gửi), không còn vào React Tổng quan.
        const openAdmin = async () => {
          await page.goto(BASE + '#home');
          await page.locator('#barcode-admin').click();
          await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
          assert.equal(await page.locator('#admin-auth').isVisible(), false);
          assert.equal(await page.evaluate(() => location.hash), '#admin/lenh-in');
          assert.equal((await page.locator('#print-jobs-heading').innerText()).trim(), 'Lệnh in');
          assert.equal(await page.locator('#root').isVisible(), false);
        };

        // Về trang chủ từ giao diện Admin (thanh bên ở desktop, mũi tên ở header điện thoại)
        await openAdmin();
        if (width >= 768) {
          assert.equal((await page.locator('#print-jobs-screen .ss-brand span').innerText()).trim(), 'WH-MATERIAL');
          await page.locator('#print-jobs-screen .ss-side-foot button', { hasText: 'Về trang chủ' }).click();
        } else {
          await page.locator('#print-jobs-screen header button[aria-label="Về trang chủ WH-MATERIAL"]').click();
        }
        await page.waitForFunction(() => location.hash === '#home');
        await page.locator('#barcode-home').waitFor({ state: 'visible' });

        // Không còn thanh admin nổi, nút Dữ liệu UID và màn nạp Excel; Đăng xuất có đúng một nút trong thanh điều hướng
        await openAdmin();
        for (const id of ['#admin-session', '#admin-uid-data', '#admin-sku-sync', '#group-uid-import-screen']) assert.equal(await page.locator(id).count(), 0, id + ' đã bị xóa');
        const logout = page.locator(width >= 768 ? '#print-jobs-screen .ss-side-foot button[data-admin-logout]' : '#print-jobs-screen header button[data-admin-logout]');
        await logout.waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-admin-logout]:visible').count(), 1);
        assert.equal(width >= 768 ? (await logout.innerText()).trim() : await logout.getAttribute('aria-label'), 'Đăng xuất');
        if (width >= 768) assert.equal(await page.locator('#print-jobs-screen .ss-nav button', { hasText: 'Đồng bộ SKU' }).count(), 1);
        // Hash Admin cũ/lạ (màn nạp Excel đã xoá) chuyển về Lệnh in
        await page.goto(BASE + '#admin/group-uid-data');
        await page.waitForFunction(() => location.hash === '#admin/lenh-in');
        await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#group-uid-import-screen').count(), 0);

        // Đăng xuất → trang chủ, phiên bị xóa
        await openAdmin();
        await logout.click();
        await page.waitForFunction(() => location.hash === '#home');
        assert.equal(await page.evaluate(key => sessionStorage.getItem(key), SESSION_KEY), null);
        await page.locator('#barcode-home').waitFor({ state: 'visible' });

        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.deepEqual(errors, []);
        await context.close();
      }
      console.log(`PASS ${width}px: ô QUẢN TRỊ ở trang chủ, IN TEM SKU không còn nút Quản trị, đăng nhập/Hủy/Về trang chủ/Đăng xuất đều về #home`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
