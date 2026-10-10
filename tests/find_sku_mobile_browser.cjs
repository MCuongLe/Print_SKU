// TÌM SKU trên điện thoại (10/10/2026; cao 520 px để nội dung dài hơn màn hình và thanh phải dính đáy): thanh "Thêm vào chờ in" dính đáy và nằm trong màn hình, camera + chọn ảnh một hàng,
// số tem một hàng, bớt câu hướng dẫn, hàng chờ in gọn, mỗi tab chỉ hiện đúng một khung.
// Chạy với python -m http.server 8000. Supabase và Edge Function được giả lập; không in thật, không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SKU = '422412924';
const NAME = 'Chỉ Irisa/FS9286_Phong Việt/100% Polyester/none/Black Marle-Melange/none/Tex 60- 20-2/mm';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 520], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: mobile, isMobile: mobile }); // ngữ cảnh mới mỗi lượt: hàng chờ lưu trong localStorage
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/SKU_Name?')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ sku: SKU, product_name: NAME }]) });
        if (url.includes('/rpc/') || url.includes('/functions/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [], items: [] } }) });
        return route.fulfill({ contentType: 'application/json', body: '[]' });
      });
      const visible = selector => page.locator(selector).first().isVisible();
      const rect = selector => page.locator(selector).first().evaluate(node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; });

      await page.goto(BASE + '#find-sku');
      await page.locator('#find-sku-screen').waitFor({ state: 'visible' });

      // Tab 1: camera + chọn ảnh cùng một hàng (điện thoại), "Chọn ảnh" chỉ còn icon nhưng vẫn có tên cho trình đọc màn hình
      const cam = await rect('#fsk-cam'), file = await rect('.fsk-file');
      if (mobile) {
        assert.ok(Math.abs(cam.top - file.top) <= 4, `camera và chọn ảnh phải cùng hàng (${cam.top} vs ${file.top})`);
        assert.ok(file.right - file.left <= 56, 'chọn ảnh chỉ là icon');
      }
      assert.equal(await page.locator('.fsk-file').getAttribute('aria-label'), 'Chọn ảnh');

      assert.equal((await page.locator('#fsk-results').innerText()).trim(), '', 'chưa tìm thì không có dòng "Chưa có kết quả"');
      assert.equal(await visible('#fsk-token-count'), false, 'chưa có từ khoá thì không hiện số trên nút Chi tiết xử lý');
      // Chọn SKU chỉ (đơn vị mm) → tab 2
      await page.locator('#fsk-code').fill(SKU); await page.locator('#fsk-code-form').press('Enter');
      await page.locator('#fsk-results button').first().waitFor();
      // Thẻ gợi ý: % nổi bật (chữ lớn), không còn "Vì sao gợi ý" / "Khớp mã"/"Cần kiểm tra" dạng chữ
      const pct = page.locator('#fsk-results .fsk-pct').first();
      assert.match((await pct.innerText()).replace(/\s+/g, ''), /^\d{1,3}%$/);
      assert.ok(Number.parseFloat(await pct.evaluate(node => getComputedStyle(node).fontSize)) >= 22, '% phải nổi bật (>= 22 px)');
      assert.match(await pct.getAttribute('aria-label'), /\d+%$/);
      assert.equal(await page.locator('#fsk-results .fsk-why, #fsk-results .fsk-conf, #fsk-results details').count(), 0, 'thẻ gợi ý không còn mục "Vì sao gợi ý"');
      assert.equal((await page.locator('#fsk-results .fsk-pick').first().innerText()).trim(), 'Chọn');
      if (mobile) {
        // Giao diện điện thoại: font hệ thống, gợi ý dạng danh sách (% bên trái, nút chọn tròn 40 px), đơn vị nằm trong khung ô nhập
        const look = await page.evaluate(() => { const screen = document.getElementById('find-sku-screen'), card = document.querySelector('#fsk-results .fsk-card'), pick = card.querySelector('.fsk-pick').getBoundingClientRect(), pct = card.querySelector('.fsk-pct').getBoundingClientRect(), tabs = getComputedStyle(document.querySelector('#find-sku-screen .cut-tab[aria-selected="true"]')); return { font: getComputedStyle(screen).fontFamily, grid: getComputedStyle(card).display, pick: Math.round(pick.width), pctLeft: pct.right <= card.querySelector('.fsk-card__id').getBoundingClientRect().left, tabBorder: tabs.borderTopWidth }; });
        assert.match(look.font, /system-ui/, 'điện thoại dùng font hệ thống');
        assert.equal(look.grid, 'grid'); assert.equal(look.pick, 40, 'nút chọn tròn 40 px'); assert.equal(look.pctLeft, true, '% nằm bên trái SKU');
        assert.equal(look.tabBorder, '0px', 'tab bước là nút chọn liền khối, không viền riêng');
      }
      // Chi tiết xử lý là popup mở bằng nút icon (có số từ khoá), Esc đóng
      assert.equal(await page.locator('#fsk-more').evaluate(node => node.tagName), 'DIALOG');
      assert.equal(await visible('#fsk-more'), false);
      assert.equal((await page.locator('#fsk-token-count').innerText()).trim(), '1');
      await page.locator('#fsk-more-open').click();
      await page.locator('#fsk-more').waitFor({ state: 'visible' });
      for (const id of ['#fsk-tags', '#fsk-raw', '#fsk-match', '#fsk-reload']) assert.equal(await visible(id), true, `${id} nằm trong popup`);
      await page.keyboard.press('Escape'); await page.locator('#fsk-more').waitFor({ state: 'hidden' });
      await page.locator('#fsk-results button').first().click();
      await page.locator('#fsk-calc-body').waitFor({ state: 'visible' });
      assert.equal(await visible('#find-sku-screen [data-panel="scan"]'), false, 'tab 2 không được hiện chồng khung quét');
      assert.equal((await page.locator('#fsk-message').innerText()).trim(), '', 'chọn SKU xong không còn dòng "nhập số lượng và số tem"');
      assert.equal((await page.locator('#fsk-sel-unit').innerText()).trim(), '', 'đã có chip đơn vị thì bỏ câu "Đơn vị của SKU…"');
      assert.equal((await page.locator('#fsk-qty-hint').innerText()).trim(), '');
      const calcText = await page.locator('#find-sku-screen [data-panel="calc"]').innerText();
      for (const gone of ['tính từ cân bên dưới', 'gõ thẳng', 'Bạn cũng có thể', 'số lượng in lên tem tính bằng mm', 'Vì sao gợi ý']) assert.equal(calcText.includes(gone), false, `còn câu hướng dẫn: ${gone}`);
      assert.equal((await page.locator('#fsk-open-converter').innerText()).trim(), 'Tính mm từ cân');
      assert.equal(await page.locator('#fsk-convert small').count(), 0);

      await page.locator('#fsk-qty').fill('29750000'); await page.locator('#fsk-copies').fill('2');
      await page.evaluate(() => document.activeElement.blur()); await page.waitForFunction(() => !document.getElementById('find-sku-screen').classList.contains('fsk-typing'));
      assert.match(await page.locator('#fsk-qty-doc').innerText(), /^Tem in: 29\.750\.000 mm = 29\.750 m$/);

      // Số tem một hàng với nhãn; nút Thêm vào chờ in nằm trọn trong màn hình mà không cần cuộn
      const label = await rect('label[for="fsk-copies"]'), copies = await rect('#fsk-copies');
      assert.ok(Math.abs((label.top + label.bottom) / 2 - (copies.top + copies.bottom) / 2) <= 8, 'nhãn Số tem cùng hàng với ô nhập');
      const add = await rect('#fsk-add');
      assert.ok(add.top >= 0 && add.bottom <= height, `nút Thêm vào chờ in phải nằm trong màn hình (${add.top}–${add.bottom} / ${height})`);
      if (mobile) {
        await page.evaluate(() => { document.getElementById('find-sku-screen').scrollTop = 0; });
        const bar = await rect('#fsk-add-bar');
        assert.ok(Math.abs(bar.bottom - height) <= 2, `thanh Thêm vào chờ in phải dính sát đáy khi cuộn lên đầu (${bar.bottom} / ${height})`);
        assert.equal(await visible('#fsk-add-sum'), false, 'điện thoại không lặp lại tóm tắt trên thanh');
        // Gốc lỗi trên Chrome Android: khung toàn màn hình không được cao hơn vùng nhìn thấy (min-height: 100vh tính cả thanh địa chỉ)
        const minHeight = await page.locator('#find-sku-screen').evaluate(node => getComputedStyle(node).minHeight);
        assert.ok(minHeight === '0px' || minHeight === 'auto', `khung full màn hình không được có min-height 100vh (thấy ${minHeight})`);
      }

      // Thêm vào chờ in → tab 3: dòng gọn, không câu "Lưu trên máy này…"
      await page.locator('#fsk-add').click();
      await page.locator('#fsk-list .cut-row').first().waitFor();
      assert.equal(await visible('#find-sku-screen [data-panel="calc"]'), false);
      assert.equal(await visible('#find-sku-screen [data-panel="scan"]'), false);
      const rowText = (await page.locator('#fsk-list .cut-row small').first().innerText()).trim();
      assert.equal(rowText, '29.750.000 mm · 2 tem', 'dòng chờ in gọn, không lặp "Số lượng"/"chờ in"');
      const listText = await page.locator('#find-sku-screen [data-panel="print"]').innerText();
      assert.equal(listText.includes('Lưu trên máy này'), false);
      assert.equal(await visible('#fsk-list-note .cut-secondary'), true, 'nút Quét thêm tem còn đó');

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: TÌM SKU — camera/ảnh một hàng, bớt câu hướng dẫn, số tem một hàng, thanh Thêm vào chờ in dính đáy, hàng chờ gọn, mỗi tab một khung`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
