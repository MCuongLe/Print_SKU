// Giao diện điện thoại đợt 2 (11/10/2026, khối CSS #mobile-pro-home): trang chủ lưới 3 cột ô gọn, 14 ô vừa một màn 390 × 844
// (≤ 340 px về 2 cột); IN TEM SKU cùng kiểu các module đợt 1 (số thứ tự chấm tròn 22 px, tiêu đề khối 18 px, thẻ phẳng, nút 46 px).
// Máy tính giữ nguyên. Dữ liệu giả rỗng, không gọi Supabase thật. Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [320, 640], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [] } }) });
      });

      // --- Trang chủ ---
      await page.goto(BASE + '#home');
      await page.locator('#barcode-print-sku').waitFor({ state: 'visible' });
      const home = await page.evaluate(() => {
        const tiles = [...document.querySelectorAll('#barcode-home .barcode-choice')].filter(t => t.getBoundingClientRect().width > 0);
        const boxes = tiles.map(t => t.getBoundingClientRect());
        const lines = tiles.map(t => { const s = t.querySelector('strong'), cs = getComputedStyle(s); return Math.round(s.getBoundingClientRect().height / parseFloat(cs.lineHeight)); });
        return { count: tiles.length, cols: new Set(boxes.map(b => Math.round(b.left))).size, w: Math.round(boxes[0].width), h: Math.round(Math.min(...boxes.map(b => b.height))), bottom: Math.round(Math.max(...boxes.map(b => b.bottom))), maxLines: Math.max(...lines), overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(home.count >= 13, `trang chủ có đủ ô (${home.count})`);
      assert.equal(home.overflow, false, `${width}px: trang chủ tràn ngang`);
      if (width === 390) {
        assert.equal(home.cols, 3, 'điện thoại: lưới 3 cột');
        assert.ok(home.bottom <= height, `điện thoại 390 × 844: mọi ô vừa một màn (ô cuối ở ${home.bottom}px)`);
        assert.ok(home.maxLines <= 2, `tên ô tối đa 2 dòng (${home.maxLines})`);
        assert.ok(home.h >= 88, `ô đủ lớn để chạm (${home.h}px)`);
      } else if (width === 320) {
        assert.equal(home.cols, 2, 'màn rất hẹp: về 2 cột');
      } else {
        assert.deepEqual([home.w, home.h], [200, 152], 'máy tính giữ ô cũ 200 × 152');
      }

      // --- IN TEM SKU ---
      await page.goto(BASE + '#worker');
      await page.locator('#root > main > section').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(300);
      const sku = await page.evaluate(() => {
        const sec = document.querySelector('#root > main > section'), num = sec.querySelector('p.items-baseline > b'), title = sec.querySelector('p.items-baseline > span');
        const add = [...sec.querySelectorAll('button')].find(b => /Thêm vào danh sách/.test(b.textContent));
        const c = getComputedStyle(num), t = getComputedStyle(title), s = getComputedStyle(sec), a = getComputedStyle(add);
        return { num: [Math.round(num.getBoundingClientRect().width), Math.round(num.getBoundingClientRect().height), c.borderRadius, c.color, c.backgroundColor].join(' '), title: `${t.fontSize}/${t.fontWeight}`, radius: s.borderRadius, shadow: s.boxShadow, addH: Math.round(add.getBoundingClientRect().height), addR: a.borderRadius, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(sku.overflow, false, `${width}px: IN TEM SKU tràn ngang`);
      if (mobile) {
        assert.equal(sku.num, '22 22 50% rgb(255, 255, 255) rgb(0, 103, 71)', 'số thứ tự khối: chấm tròn 22 px, chữ trắng');
        assert.equal(sku.title, '18px/600', 'tiêu đề khối 18 px');
        assert.equal(sku.radius, '14px'); assert.equal(sku.shadow, 'none', 'thẻ phẳng');
        assert.ok(sku.addH >= 46, `nút Thêm vào danh sách ≥ 46 px (${sku.addH})`); assert.equal(sku.addR, '12px');
      } else {
        assert.notEqual(sku.num.split(' ')[4], 'rgb(0, 103, 71)', 'máy tính giữ số thứ tự cũ');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: trang chủ ${home.cols} cột (${home.count} ô, ô cuối ${home.bottom}px), IN TEM SKU ${mobile ? 'cùng kiểu đợt 1' : 'giữ nguyên'}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
