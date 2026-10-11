// Thanh điều hướng trái chung (11/10/2026, khối #app-nav-theme + script app-nav-script): máy tính ≥ 1024 px có thanh trái 264 px dựng từ các ô trang chủ
// (WH-MATERIAL › Trang chủ + 4 nhóm theo màu, mục đang mở đánh dấu aria-current); nút thu gọn ở đầu thanh trên từng màn, thu gọn = ẩn hẳn thanh
// và nhớ trên máy; nhóm Quản trị đổi sang các mục Admin
// sau khi đăng nhập và thay thanh bên riêng của Admin; nút quay lại trang chủ ẩn. Điện thoại/máy tính bảng giữ như cũ. Dữ liệu giả, không gọi Supabase thật.
// Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = `${b64({ alg: 'HS256' })}.${b64({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
const ROUTES = { worker: 'In tem SKU', 'group-uid': 'In tem Group UID', location: 'Mã vị trí', 'cut-group-uid': 'Cắt Group UID', 'group-uid-history': 'Lịch sử Group UID', 'find-sku': 'Tìm SKU', 'unit-converter': 'Chuyển đổi đơn vị', 'xa-vai': 'Theo dõi xả vải', inspection: 'Kiểm tra đầu vào', 'storage-risk': 'Rủi ro lưu trữ' };

const open = async (browser, width, height, { admin = false } = {}) => {
  const mobile = width < 800;
  const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  if (admin) await context.addInitScript(token => sessionStorage.setItem('print-sku-admin-session-v1', JSON.stringify({ access_token: token, refresh_token: 'r' })), JWT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith('/auth/v1/user')) return json({ id: '1' });
    if (url.includes('/rest/v1/user_roles')) return json([{ username: 'A', role: 'admin' }]);
    if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [], devices: [] } });
  });
  return { context, page, errors };
};
const navState = page => page.evaluate(() => {
  const nav = document.getElementById('app-nav'), box = nav.getBoundingClientRect(), vis = e => e.getBoundingClientRect().width > 0;
  return {
    display: getComputedStyle(nav).display, visibility: getComputedStyle(nav).visibility, w: Math.round(box.width),
    toggles: [...document.querySelectorAll('.an-toggle')].filter(b => vis(b) && !b.closest('[inert], [hidden]')).map(b => b.getAttribute('aria-expanded')), // #root (React) nằm dưới, inert khi màn khác mở
    heads: [...nav.querySelectorAll('.an-head')].map(h => h.textContent.trim()),
    items: [...nav.querySelectorAll('.an-item')].filter(vis).map(b => b.getAttribute('aria-label')),
    current: [...nav.querySelectorAll('[aria-current="page"]')].map(b => b.getAttribute('aria-label')),
    backs: [...document.querySelectorAll('button[aria-label="Quay lại trang chủ WH-MATERIAL"]')].filter(vis).length,
    overflow: document.documentElement.scrollWidth > innerWidth
  };
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // --- Máy tính: thanh trái, mục đang mở, nội dung lùi sang phải ---
    {
      const { context, page, errors } = await open(browser, 1440, 900);
      await page.goto(BASE + '#home');
      await page.locator('#app-nav .an-item[aria-label="Kích hoạt máy"]').waitFor();
      let s = await navState(page);
      assert.equal(s.display, 'flex'); assert.equal(s.w, 264, 'thanh trái rộng 264 px');
      assert.deepEqual(s.heads, ['WH-MATERIAL', 'In tem', 'Vận hành kho', 'Kiểm tra', 'Quản trị']);
      assert.deepEqual(s.toggles, ['true'], 'trang chủ: một nút thu gọn ở đầu thanh trên');
      const tiles = await page.evaluate(() => [...document.querySelectorAll('#barcode-home .barcode-choice')].filter(t => !t.hidden).length);
      assert.equal(s.items.length, tiles + 1, 'mỗi ô đang hiện ở trang chủ có một mục (+ Trang chủ)');
      assert.deepEqual(s.current, ['Trang chủ']);
      assert.equal(Math.round(await page.evaluate(() => document.getElementById('barcode-home').getBoundingClientRect().left)), 264, 'trang chủ lùi sang phải 264 px');
      const style = await page.evaluate(() => { const b = document.querySelector('#app-nav .an-list .an-item:not([aria-current])'), h = document.querySelector('#app-nav .an-head'); return `${getComputedStyle(b).fontSize}/${getComputedStyle(b).fontWeight} ${getComputedStyle(h).fontSize}/${getComputedStyle(h).fontWeight} ${getComputedStyle(h, '::before').backgroundColor}`; });
      assert.equal(style, '16px/400 14px/700 rgb(0, 95, 65)', 'mục 16/400, tên nhóm 14/700 có ô vuông màu nhóm');

      for (const [route, label] of Object.entries(ROUTES)) {
        await page.goto(BASE + '#' + route); await page.waitForTimeout(400);
        s = await navState(page);
        assert.deepEqual(s.current, [label], `#${route}: mục đang mở`);
        assert.equal(s.backs, 0, `#${route}: nút quay lại trang chủ ẩn (đã có mục Trang chủ)`);
        assert.equal(s.overflow, false, `#${route}: không tràn ngang`);
        assert.deepEqual(s.toggles, ['true'], `#${route}: một nút thu gọn ở đầu thanh trên`);
      }
      // Tên nhóm dưới tiêu đề module, màu theo nhóm
      const eyebrow = await page.evaluate(() => { const h = document.getElementById('storage-risk-title'), a = getComputedStyle(h, '::after'); return `${a.content}|${a.fontSize}|${a.textTransform}|${a.color}`; });
      assert.equal(eyebrow, '"Kiểm tra"|12px|uppercase|rgb(138, 91, 0)');

      // Bấm mục = bấm ô trang chủ
      await page.locator('#app-nav .an-item[aria-label="Tìm SKU"]').click();
      await page.locator('#find-sku-screen').waitFor({ state: 'visible' });
      assert.equal(new URL(page.url()).hash, '#find-sku');
      assert.equal(Math.round(await page.evaluate(() => document.getElementById('find-sku-screen').getBoundingClientRect().left)), 264);
      await page.locator('#app-nav .an-item[aria-label="Trang chủ"]').click();
      await page.locator('#barcode-home').waitFor({ state: 'visible' });

      // IN TEM SKU (React): thanh đáy lùi theo thanh trái
      await page.locator('#app-nav .an-item[aria-label="In tem SKU"]').click();
      await page.waitForTimeout(400);
      assert.equal(Math.round(await page.evaluate(() => document.querySelector('#root .fixed.inset-x-0.bottom-0').getBoundingClientRect().left)), 264, 'thanh đáy IN TEM SKU bắt đầu sau thanh trái');

      // Thu gọn: ẩn hẳn thanh trái, nội dung tràn hết bề rộng, nút ở đầu thanh trên đổi thành Mở thanh bên; nhớ sau khi tải lại
      await page.locator('#root header .an-toggle').click();
      await page.waitForTimeout(300);
      s = await navState(page);
      assert.equal(s.visibility, 'hidden', 'thu gọn: thanh trái ẩn hẳn');
      assert.deepEqual(s.toggles, ['false']);
      assert.equal(await page.locator('#root header .an-toggle').getAttribute('aria-label'), 'Mở thanh bên');
      assert.equal(Math.round(await page.evaluate(() => document.querySelector('#root .fixed.inset-x-0.bottom-0').getBoundingClientRect().left)), 0, 'thu gọn: nội dung tràn hết bề rộng');
      await page.reload(); await page.locator('#root header .an-toggle').waitFor();
      assert.equal((await navState(page)).visibility, 'hidden', 'nhớ trạng thái thu gọn');
      await page.locator('#root header .an-toggle').click();
      await page.waitForTimeout(300);
      s = await navState(page);
      assert.equal(s.visibility, 'visible'); assert.deepEqual(s.toggles, ['true']);

      // In: thanh trái không ra giấy
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('app-nav')).display), 'none');
      await page.emulateMedia({ media: 'screen' });
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS 1440px: thanh trái 264 px, WH-MATERIAL › Trang chủ + 4 nhóm, mục đang mở đúng 10 module, nút thu gọn ở thanh trên, bấm mục mở module, thu gọn ẩn hẳn + nhớ trên máy, không ra giấy in');
    }

    // --- Admin: nhóm Quản trị mở các mục Admin, thay thanh bên riêng; Đăng xuất ở chân thanh ---
    {
      const { context, page, errors } = await open(browser, 1280, 800, { admin: true });
      await page.goto(BASE + '#admin/sku-sync');
      await page.locator('#app-nav .an-item[aria-label="Lệnh in"]').waitFor();
      let s = await navState(page);
      assert.deepEqual(s.current, ['Đồng bộ SKU']);
      for (const label of ['Lệnh in', 'Đồng bộ SKU', 'Đồng bộ Group UID', 'Kiểm kê SKU', 'Cấu hình', 'Đăng xuất']) assert.ok(s.items.includes(label), `có mục ${label}`);
      assert.equal(s.items.includes('Quản trị'), false, 'đã đăng nhập: mục Quản trị thay bằng các mục Admin');
      assert.equal(await page.locator('#sku-sync-screen .ss-side').isVisible(), false, 'thanh bên riêng của Admin ẩn');
      assert.equal(Math.round(await page.evaluate(() => document.querySelector('#sku-sync-screen .ss-top').getBoundingClientRect().left)), 264);
      await page.locator('#app-nav .an-item[aria-label="Cấu hình"]').click();
      await page.waitForTimeout(500);
      assert.equal(new URL(page.url()).hash, '#admin/cauhinh');
      assert.equal(await page.locator('#root aside').isVisible(), false, 'Cấu hình: thanh bên React ẩn');
      assert.deepEqual((await navState(page)).current, ['Cấu hình']);
      await page.locator('#app-nav .an-foot [data-admin-logout]').click();
      await page.locator('#barcode-home').waitFor({ state: 'visible' });
      s = await navState(page);
      assert.ok(s.items.includes('Quản trị') && !s.items.includes('Lệnh in') && !s.items.includes('Đăng xuất'), 'đăng xuất: nhóm Quản trị về như cũ');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS 1280px Admin: mục Admin trong nhóm Quản trị, thanh bên riêng ẩn, chuyển Cấu hình, Đăng xuất ở chân thanh');
    }

    // --- Dưới 1024 px: không có thanh trái, nút quay lại vẫn hiện ---
    for (const [width, height] of [[1023, 800], [390, 844]]) {
      const { context, page, errors } = await open(browser, width, height);
      await page.goto(BASE + '#find-sku');
      await page.locator('#find-sku-screen').waitFor({ state: 'visible' });
      const s = await navState(page);
      assert.equal(s.display, 'none', `${width}px: không có thanh trái`);
      assert.equal(await page.locator('#fsk-back').isVisible(), true, `${width}px: nút quay lại vẫn hiện`);
      assert.equal(Math.round(await page.evaluate(() => document.getElementById('find-sku-screen').getBoundingClientRect().left)), 0);
      assert.deepEqual(s.toggles, [], `${width}px: không có nút thu gọn`);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: giữ như cũ (không thanh trái, có nút quay lại)`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
