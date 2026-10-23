// Lối vào Admin nằm ở trang chủ (ô QUẢN TRỊ), không còn trong IN TEM SKU.
// Thanh admin nổi (tên + Dữ liệu UID/Đồng bộ SKU/Đăng xuất) đã bỏ; Đăng xuất nằm ở chân thanh trái chung (máy tính ≥ 1024 px, 11/10/2026 thay thanh bên
// riêng của Admin) và hàng tiêu đề (điện thoại).
// Run against python -m http.server 8000 (đổi bằng BASE). Supabase/auth được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
// Trang chủ điện thoại (17/10/2026): nhóm Quản trị là danh sách thả, mặc định đóng; mở trước khi bấm ô (đã mở thì để nguyên)
const openAdminFold = async page => { const t = page.locator('#barcode-home [data-tone="admin"] .home-fold__toggle'); if (await t.isVisible() && await t.getAttribute('aria-expanded') !== 'true') await t.click(); };
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
        await openAdminFold(page);
        const tile = page.locator('#barcode-admin');
        await tile.waitFor({ state: 'visible' });
        assert.equal((await tile.innerText()).trim(), 'QUẢN TRỊ');
        assert.equal(await page.locator('#barcode-home .barcode-home__group-title', { hasText: 'Quản trị' }).count(), 1);

        // IN TEM SKU không còn nút Quản trị (bánh răng) trong header
        await page.goto(BASE + '#worker');
        // Máy tính: nút quay lại ẩn vì thanh trái có mục Trang chủ
        await page.locator(width >= 1024 ? '#app-nav .an-item[aria-current="page"][aria-label="In tem SKU"]' : '#print-sku-back').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#root header button[aria-label="Quản trị"]').count(), 0, 'IN TEM SKU không còn nút Quản trị');

        // Ô QUẢN TRỊ → hộp thoại đăng nhập; Hủy → về trang chủ
        await page.goto(BASE + '#home');
        await openAdminFold(page);
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
          await openAdminFold(page);
          await page.locator('#barcode-admin').click();
          await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
          assert.equal(await page.locator('#admin-auth').isVisible(), false);
          assert.equal(await page.evaluate(() => location.hash), '#admin/lenh-in');
          assert.equal((await page.locator('#print-jobs-heading').innerText()).trim(), 'Lệnh in');
          assert.equal(await page.locator('#root').isVisible(), false);
        };

        // Về trang chủ từ giao diện Admin (mục Trang chủ ở thanh trái chung trên máy tính, mũi tên ở header điện thoại)
        await openAdmin();
        if (width >= 1024) {
          assert.equal((await page.locator('#app-nav .an-head').first().innerText()).trim(), 'Quản trị', 'chế độ Quản trị: chỉ nhóm Quản trị');
          assert.equal(await page.locator('#print-jobs-screen .ss-side').isVisible(), false, 'thanh bên riêng của Admin ẩn');
          await page.locator('#app-nav .an-item[aria-label="Về trang chủ"]').click();
        } else {
          await page.locator('#print-jobs-screen header .an-toggle').click();
          await page.locator('#app-nav .an-item[aria-label="Về trang chủ"]').click();
        }
        await page.waitForFunction(() => location.hash === '#home');
        await page.locator('#barcode-home').waitFor({ state: 'visible' });

        // Không còn thanh admin nổi, nút Dữ liệu UID và màn nạp Excel; Đăng xuất có đúng một nút trong thanh điều hướng
        await openAdmin();
        for (const id of ['#admin-session', '#admin-uid-data', '#admin-sku-sync', '#group-uid-import-screen']) assert.equal(await page.locator(id).count(), 0, id + ' đã bị xóa');
        if (width < 1024) await page.locator('#print-jobs-screen header .an-toggle').click();
        const logout = page.locator('#app-nav .an-foot [data-admin-logout]');
        await logout.waitFor({ state: 'visible' });
        assert.equal(await page.locator('[data-admin-logout]:visible').count(), 1);
        assert.equal(width >= 1024 ? (await logout.innerText()).trim() : await logout.getAttribute('aria-label'), 'Đăng xuất');
        if (width >= 1024) assert.equal(await page.locator('#app-nav .an-item[aria-label="Đồng bộ SKU"]').count(), 1);
        // Hash Admin cũ/lạ (màn nạp Excel đã xoá) chuyển về Lệnh in
        await page.goto(BASE + '#admin/group-uid-data');
        await page.waitForFunction(() => location.hash === '#admin/lenh-in');
        await page.locator('#print-jobs-screen').waitFor({ state: 'visible' });
        assert.equal(await page.locator('#group-uid-import-screen').count(), 0);

        // Đăng xuất → trang chủ, phiên bị xóa
        await openAdmin();
        if (width < 1024) await page.locator('#print-jobs-screen header .an-toggle').click();
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
