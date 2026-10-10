// TÌM SKU luôn gợi ý SKU Normal (10/10/2026): dòng Combo trong kết quả được thay bằng SKU Normal theo quan hệ Combo → Normal
// (RPC sku_combo_lookup). Tên Combo khớp cao mà tên Normal khớp thấp thì thẻ đỏ. Dữ liệu giả, không gọi Supabase thật.
// Chạy với python -m http.server 8000.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const CATALOG = [
  { sku: '900000401', product_name: 'Chỉ Mẫu/F1698 Xám/Tex 27/mm', status: '1' },
  { sku: '900000411', product_name: '(Combo) Chỉ Mẫu/SBD17 Xám lông chuột/Tex 27/cuộn 5000m', status: '1' },
  { sku: '900000501', product_name: 'Chỉ Mẫu/K22 Đỏ/Tex 30/mm', status: '1' },
  { sku: '900000511', product_name: '(Combo) Chỉ Mẫu/K22 Đỏ/Tex 30/cuộn 3000m', status: '1' },
  { sku: '900000611', product_name: '(Combo) Chỉ Mẫu/Z99 Vàng/Tex 40/cuộn 5000m', status: '1' },
];
const LINKS = {
  '900000411': [{ normal_sku: '900000401', product_name: 'Chỉ Mẫu/F1698 Xám/Tex 27/mm', category_name: 'Phụ liệu', quantity: 5000000, available: true }],
  '900000511': [{ normal_sku: '900000501', product_name: 'Chỉ Mẫu/K22 Đỏ/Tex 30/mm', category_name: 'Phụ liệu', quantity: 3000000, available: true }],
  '900000611': [],
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 800, hasTouch: width < 800 });
      const page = await context.newPage();
      const errors = [], lookups = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/SKU_Name?')) return route.fulfill({ contentType: 'application/json', headers: { 'content-range': `0-${CATALOG.length - 1}/${CATALOG.length}` }, body: JSON.stringify(CATALOG) });
        if (url.endsWith('/rpc/sku_combo_lookup')) {
          const { p_sku } = route.request().postDataJSON(); lookups.push(p_sku);
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(LINKS[p_sku] || []) });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [], items: [] } }) });
      });
      const search = async code => {
        await page.locator('#fsk-tab-scan').click();
        await page.locator('#fsk-code').fill(code); await page.locator('#fsk-code-form').press('Enter');
        await page.locator('#fsk-results .fsk-card').first().waitFor();
        return page.locator('#fsk-results .fsk-card').evaluateAll(cards => cards.map(card => ({ sku: card.dataset.sku, alert: card.dataset.alert === 'true', combo: card.dataset.combo || '', tone: card.querySelector('.fsk-pct')?.dataset.tone, pct: card.querySelector('.fsk-pct')?.textContent.trim(), via: card.querySelector('.fsk-via')?.textContent.trim() || '' })));
      };
      await page.goto(BASE + '#find-sku');
      await page.locator('#find-sku-screen').waitFor({ state: 'visible' });

      // 1) Tem khớp tên Combo (SBD17) nhưng tên Normal không có mảnh đó → gợi ý Normal, thẻ đỏ, ghi Combo + % của Combo
      let cards = await search('SBD17');
      assert.equal(cards.some(card => card.sku === '900000411'), false, `không gợi ý SKU Combo: ${JSON.stringify(cards)}`);
      const red = cards.find(card => card.sku === '900000401');
      assert.ok(red, `phải gợi ý SKU Normal 900000401: ${JSON.stringify(cards)}`);
      assert.equal(red.alert, true, `tên Combo khớp cao mà tên Normal khớp thấp → thẻ đỏ: ${JSON.stringify(red)}`);
      assert.equal(red.tone, 'bad');
      assert.equal(red.combo, '900000411');
      assert.match(red.via, /^Combo 900000411 · \d+%$/);
      assert.ok(Number.parseInt(red.via.split('·')[1], 10) >= 70, 'Combo khớp cao');
      assert.ok(Number.parseInt(red.pct, 10) < 70 || red.pct.startsWith('—'), `Normal khớp thấp: ${red.pct}`);
      // Chọn thẻ đỏ → bước Số lượng nhận SKU Normal, ghi rõ đổi từ Combo nào (tỷ lệ 1 Combo = 5.000.000 mm)
      await page.locator('#fsk-results .fsk-card[data-sku="900000401"] .fsk-pick').click();
      await page.locator('#fsk-calc-body').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#fsk-sel-sku').innerText()).trim(), '900000401');
      assert.match(await page.locator('#fsk-sel-combo').innerText(), /Đổi từ SKU Combo 900000411 · 1 Combo = 5\.000\.000/);

      // 2) Mảnh có ở cả Normal lẫn Combo (K22) → chỉ còn thẻ Normal, không đỏ, không trùng
      cards = await search('K22');
      assert.deepEqual(cards.map(card => card.sku), ['900000501'], `chỉ một thẻ Normal, không lặp: ${JSON.stringify(cards)}`);
      assert.equal(cards[0].alert, false);

      // 3) Combo chưa có quan hệ Normal → giữ thẻ Combo như cũ (không mất gợi ý)
      cards = await search('Z99');
      assert.deepEqual(cards.map(card => card.sku), ['900000611']);
      assert.equal(cards[0].alert, false);
      assert.ok(lookups.includes('900000611'));

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: TÌM SKU luôn gợi ý SKU Normal, thẻ đỏ khi tên Combo khớp cao mà tên Normal thấp, không trùng, Combo chưa có quan hệ vẫn giữ`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
