// Giao diện điện thoại đợt 2 (11/10/2026, khối CSS #mobile-pro-home) + thẻ nhóm theo mẫu (#home-cards): trang chủ lưới 3 cột ô gọn, mỗi nhóm một thẻ có thanh tiêu đề
// (≤ 340 px về 2 cột); IN TEM SKU cùng kiểu các module đợt 1 (số thứ tự chấm tròn 22 px, tiêu đề khối 18 px, thẻ phẳng, nút 46 px).
// Máy tính giữ nguyên. Dữ liệu giả rỗng, không gọi Supabase thật. Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [320, 640], [1280, 800], [1920, 1080]]) {
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
        const groups = [...document.querySelectorAll('#barcode-home .barcode-home__group')];
        const firstRow = boxes.filter(b => Math.abs(b.top - boxes[0].top) < 2);
        return { count: tiles.length, cols: firstRow.length, w: Math.round(boxes[0].width), h: Math.round(Math.min(...boxes.map(b => b.height))), bottom: Math.round(Math.max(...boxes.map(b => b.bottom))), maxLines: Math.max(...lines), overflow: document.documentElement.scrollWidth > innerWidth,
          groupCols: new Set(groups.map(g => Math.round(g.getBoundingClientRect().left))).size,
          heads: groups.map(g => { const icon = g.querySelector('.barcode-home__group-icon'), r = icon.getBoundingClientRect(); return `${g.querySelector('h2').textContent.trim()}|${g.querySelector('[data-home-count]').textContent}|${Math.round(r.width)}|${getComputedStyle(icon).borderRadius}`; }),
          counts: groups.map(g => [...g.querySelectorAll('.barcode-choice')].filter(t => !t.hidden && t.getBoundingClientRect().width > 0).length) };
      });
      assert.ok(home.count >= 10, `trang chủ có đủ ô (${home.count})`);
      // Thẻ nhóm theo mẫu 11/10/2026: thanh tiêu đề có icon tròn, tên nhóm, số chức năng đúng số ô đang hiện
      home.heads.forEach((head, i) => { const [name, count, w, r] = head.split('|'); assert.equal(count, `${String(home.counts[i]).padStart(2, '0')} chức năng`, `${name}: số chức năng`); assert.equal(r, '50%', `${name}: icon nhóm tròn`); assert.ok(Number(w) >= 40, `${name}: icon nhóm ≥ 40 px`); });
      assert.deepEqual(home.heads.map(h => h.split('|')[0]), ['In tem', 'Vận hành kho', 'Kiểm tra', 'Quản trị']);
      assert.equal(home.overflow, false, `${width}px: trang chủ tràn ngang`);
      // Ảnh nền đầu trang (kệ kho, webp nhúng sẵn — không tải ngoài) thay hoạ tiết kệ SVG ::after; màn ≥ 1200 px ảnh giữ rộng 960 px, icon kho thẳng mép thẻ nhóm
      const head = await page.evaluate(() => {
        const hd = document.querySelector('#barcode-home .barcode-home__header'), cs = getComputedStyle(hd);
        return { img: /url\("data:image\/webp;base64,/.test(cs.backgroundImage), size: cs.backgroundSize.split(', ').pop(), after: getComputedStyle(hd, '::after').content, h: Math.round(hd.getBoundingClientRect().height), color: getComputedStyle(hd.querySelector('h1')).color,
          toggleX: (t => t && t.getBoundingClientRect().width ? Math.round(t.getBoundingClientRect().left) : null)(hd.querySelector('.an-toggle')),
          markX: Math.round(hd.querySelector('.barcode-home__mark').getBoundingClientRect().left), groupX: Math.round(document.querySelector('#barcode-home .barcode-home__group').getBoundingClientRect().left) };
      });
      assert.equal(head.img, true, 'đầu trang có ảnh nền webp nhúng');
      assert.equal(head.after, 'none', 'bỏ hoạ tiết kệ SVG cũ');
      assert.equal(head.size, width >= 1200 ? '960px auto' : 'cover', 'màn ≥ 1200 px: ảnh giữ rộng 960 px, không phóng theo bề rộng màn');
      assert.equal(head.color, 'rgb(255, 255, 255)');
      assert.equal(head.h, mobile ? 112 : 148, `đầu trang cao ${head.h}px`);
      // Máy tính ≥ 1024 px: đầu trang bắt đầu bằng nút thu gọn thanh trái, thẳng mép thẻ nhóm
      if (mobile) { assert.equal(head.markX, 16); assert.equal(head.toggleX, null); } else assert.equal(head.toggleX, head.groupX, 'máy tính: nút thu gọn thẳng mép thẻ nhóm');
      if (width === 390) {
        assert.equal(home.cols, 3, 'điện thoại: lưới 3 cột');
        assert.ok(home.bottom <= height * 1.25, `điện thoại 390 × 844: trang chủ cuộn tối đa ~1,25 màn (ô cuối ở ${home.bottom}px)`);
        assert.ok(home.maxLines <= 2, `tên ô tối đa 2 dòng (${home.maxLines})`);
        assert.ok(home.h >= 88, `ô đủ lớn để chạm (${home.h}px)`);
      } else if (width === 320) {
        assert.equal(home.cols, 2, 'màn rất hẹp: về 2 cột');
      } else {
        assert.equal(home.groupCols, 2, 'máy tính: thẻ nhóm xếp 2 cột');
        // Ô cao 152; thanh trái chung (264 px) làm vùng nội dung hẹp hơn nên tên 2 dòng đẩy ô lên 160
        assert.ok(home.h >= 152 && home.h <= 160, `máy tính: ô cao 152–160 (${home.h})`);
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
        assert.equal(sku.num, '22 22 50% rgb(255, 255, 255) rgb(0, 95, 65)', 'số thứ tự khối: chấm tròn 22 px, chữ trắng, xanh thương hiệu --wms-brand (chuẩn chung)');
        assert.equal(sku.title, '18px/600', 'tiêu đề khối 18 px');
        assert.equal(sku.radius, '14px'); assert.equal(sku.shadow, 'none', 'thẻ phẳng');
        assert.ok(sku.addH >= 46, `nút Thêm vào danh sách ≥ 46 px (${sku.addH})`); assert.equal(sku.addR, '12px');
      } else {
        assert.match(sku.num, /^30 30 50% /, 'máy tính: chấm tròn 30 px theo chuẩn chung');
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: trang chủ ${home.cols} cột (${home.count} ô, ô cuối ${home.bottom}px), IN TEM SKU ${mobile ? 'cùng kiểu đợt 1' : 'chấm tròn 30 px'}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
