// Đợt 4 (11/10/2026): lớp quét dùng chung (PrintSkuScanUI) — không câu hướng dẫn khi quét, thẻ "mã không có trong danh mục" chỉ có
// tiêu đề + mã + 2 nút icon, thẻ lỗi theo nguyên nhân luôn có "Gõ tay" (bị chặn / camera bận còn có "Thử lại" mở lại camera ngay),
// màn ngang không đè nút lên khung ngắm; đóng / ẩn tab / nút Back đều tắt camera. Camera + bộ đọc mã giả lập; danh mục SKU giả rỗng.
// Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
// Camera giả: canvas.captureStream; window.__camError = tên lỗi để ev() ném lỗi; window.__code = mã bộ đọc trả về.
const fakeScanner = () => {
  const install = () => {
    const S = window.PrintSkuScanner; if (!S) return false;
    window.__tracks = [];
    window.PrintSkuScanner = { ...S, gl: () => true, k0: () => window.__secure !== false, Jp: async () => ({ doc: async () => (window.__code ? { ma: window.__code } : null) }),
      ev: async () => {
        if (window.__camError) throw Object.assign(new Error('giả lập'), { name: window.__camError });
        const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#456'; g.fillRect(0, 0, 640, 480); }, 100);
        const stream = c.captureStream(10); window.__tracks.push(...stream.getTracks()); return stream;
      } };
    return true;
  };
  const t = setInterval(() => { if (install()) clearInterval(t); }, 20);
};
const rect = el => { const b = el.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width }; };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height, tag] of [[390, 844, 'dọc'], [844, 390, 'ngang']]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true });
      await context.addInitScript(fakeScanner);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) });
      });
      await page.goto(BASE + '#worker');
      await page.locator('#root main input').first().waitFor({ state: 'visible' });
      await page.waitForFunction(() => window.PrintSkuScanner?.ev && window.__tracks);
      const open = (setup = {}) => page.evaluate(s => { Object.assign(window, { __code: '', __camError: '', __secure: true }, s); window.PrintSkuScanUI.open({ title: 'Quét mã SKU', typeLabel: 'Gõ tay mã SKU', typeFocus: '#f-sku' }); }, setup);
      const stateIs = name => page.waitForFunction(n => document.querySelector('.pss')?.dataset.state === n, name);
      const pss = page.locator('.pss');

      // 1. Đang quét: không có câu hướng dẫn, nút gõ tay ngắn có tên đầy đủ
      await open(); await stateIs('scan');
      const scan = await page.evaluate(() => { const r = document.querySelector('.pss'), st = r.querySelector('.pss-status'), type = r.querySelector('.pss-type'); return { status: st.offsetParent ? st.textContent : '', type: type.innerText.trim(), label: type.getAttribute('aria-label') }; });
      assert.deepEqual(scan, { status: '', type: 'Gõ tay', label: 'Gõ tay mã SKU' }, `${tag}: đang quét không có chữ hướng dẫn`);
      if (tag === 'ngang') {
        const boxes = await page.evaluate(() => ['.pss-guide', '.pss-zoom', '.pss-type'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return { s, l: b.left, t: b.top, r: b.right, b: b.bottom }; }));
        for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) { const a = boxes[i], b = boxes[j]; assert.ok(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t, `màn ngang: ${a.s} đè ${b.s}`); }
      }
      // Đóng: tắt camera
      await pss.locator('[data-act="close"]').click(); await pss.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.__tracks.every(t => t.readyState === 'ended')), true, `${tag}: đóng là tắt camera`);

      // 2. Mã không có trong danh mục: tiêu đề + mã + 2 nút icon, không đoạn giải thích
      await open({ __code: '893000111222' }); await stateIs('warn');
      const warn = await pss.locator('.pss-card').evaluate(c => ({ text: c.innerText.replace(/\s+/g, ' ').trim(), p: c.querySelectorAll('p').length, icons: [...c.querySelectorAll('button')].map(b => !!b.querySelector('svg')) }));
      assert.equal(warn.text, 'Mã này không có trong danh mục SKU 893000111222 Dùng mã này Quét tiếp');
      assert.equal(warn.p, 0, 'không có đoạn giải thích'); assert.deepEqual(warn.icons, [true, true], 'nút có icon');
      if (tag === 'ngang') { const [g, c] = await page.evaluate(() => ['.pss-guide', '.pss-card'].map(s => { const b = document.querySelector(s).getBoundingClientRect(); return { l: b.left, r: b.right }; })); assert.ok(c.l >= g.r, 'màn ngang: thẻ nằm bên phải khung ngắm'); }
      await pss.locator('[data-act="use"]').click(); await pss.waitFor({ state: 'detached' });

      // 3. Camera bị chặn: có "Thử lại" — cấp quyền xong bấm là quét được, không ngõ cụt
      await open({ __camError: 'NotAllowedError' }); await stateIs('error');
      assert.match(await pss.locator('.pss-card').innerText(), /Camera đang bị chặn/);
      assert.deepEqual(await pss.locator('.pss-card button').evaluateAll(bs => bs.map(b => b.dataset.act)), ['retry', 'type']);
      await page.evaluate(() => { window.__camError = ''; });
      await pss.locator('[data-act="retry"]').click(); await stateIs('scan');
      assert.equal(await pss.locator('.pss-card').isVisible(), false, 'Thử lại mở lại camera trong cùng lớp quét');
      // Ẩn tab (chuyển app): tắt camera
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      await pss.waitFor({ state: 'detached' });
      await page.evaluate(() => { delete document.hidden; });
      assert.equal(await page.evaluate(() => window.__tracks.every(t => t.readyState === 'ended')), true, `${tag}: ẩn tab là tắt camera`);

      // 4. Không có camera: chỉ "Gõ tay", bấm thì về ô nhập SKU
      await open({ __camError: 'NotFoundError' }); await stateIs('error');
      assert.equal((await pss.locator('.pss-card').innerText()).replace(/\s+/g, ' ').trim(), 'Không có camera Gõ tay');
      await pss.locator('.pss-card [data-act="type"]').click(); await pss.waitFor({ state: 'detached' });
      await page.waitForFunction(() => document.activeElement?.id === 'f-sku');

      // 5. Camera bận (app khác chiếm) có Thử lại; trang không HTTPS thì không
      await open({ __camError: 'NotReadableError' }); await stateIs('error');
      assert.match(await pss.locator('.pss-card').innerText(), /Camera đang bận/);
      assert.equal(await pss.locator('[data-act="retry"]').count(), 1);
      await page.goBack(); await pss.waitFor({ state: 'detached' });
      await open({ __secure: false }); await stateIs('error');
      assert.match(await pss.locator('.pss-card').innerText(), /Cần HTTPS để mở camera/);
      assert.equal(await pss.locator('[data-act="retry"]').count(), 0);
      await page.keyboard.press('Escape'); await pss.waitFor({ state: 'detached' });

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${tag} ${width}×${height}: quét không chữ hướng dẫn, thẻ mã lạ 2 nút icon, chặn/bận có Thử lại, không camera/không HTTPS chỉ Gõ tay, ngang không đè, đóng/ẩn tab/Back tắt camera`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
