// IN TEM GROUP UID theo mẫu (11/10/2026, khối #uid-mockup): dòng chờ gán có Lot/Roll + giờ thêm + chép + xoá, ô tìm, Chọn tất cả + Xóa đã chọn,
// điện thoại hiện 3 dòng + "Xem tất cả" mở tấm "Danh sách Group UID" (lọc Tất cả / Chưa gán SKU / Đã gán, tìm, chọn, Xác nhận);
// thẻ Gán SKU có nút ẩn/hiện bàn phím cho ô SKU; tay kéo ⋮⋮ đổi thứ tự UID chờ gán (12/10/2026). Supabase giả lập. Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const CODES = ['1028260925000001', '1028260925000002', '1028260925000003', '1028260925000004', '1028260925000009'];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith('/rpc/group_uid_lookup')) {
          const { p_codes } = route.request().postDataJSON();
          // Mã đuôi 9 có SKU + tên → sẵn sàng in; còn lại chỉ có Lot/Roll → chờ gán
          return json(p_codes.map(code => ({ group_uid_code: code, sku: code.endsWith('9') ? '000123456' : '', product_name: code.endsWith('9') ? 'Vải thử nghiệm' : '', lot: 'L' + code.slice(-1), roll: String(50 + Number(code.slice(-1))) })));
        }
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
        return json({ ok: true, data: { agents: [], jobs: [] } });
      });
      await page.goto(BASE + '#group-uid');
      await page.locator('#uid-code').waitFor();
      assert.equal((await page.locator('#uid-add').textContent()).trim(), 'Thêm vào danh sách');
      for (const code of CODES) { await page.locator('#uid-code').fill(code); await page.locator('#uid-code').press('Enter'); }
      await page.waitForFunction(() => document.querySelector('#uid-pending-count').textContent === '4' && document.querySelector('#uid-ready-count').textContent === '1');

      const rows = () => page.evaluate(() => [...document.querySelectorAll('#uid-pending .uid-row')].filter(r => r.getBoundingClientRect().height).map(r => r.querySelector('.uid-row__body').innerText.replace(/\s+/g, ' ').trim()));
      let visible = await rows();
      assert.equal(visible.length, mobile ? 3 : 4, mobile ? 'điện thoại: 3 dòng đầu' : 'máy tính: đủ dòng');
      assert.match(visible[0], /^1028260925000001 Lot: L1\s*\|\s*Roll: 51 Thêm: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/, 'dòng có Lot/Roll và giờ thêm');
      assert.equal(await page.locator('#uid-more').isVisible(), mobile, 'Xem tất cả chỉ trên điện thoại khi > 3 dòng');

      // Tìm theo Group UID / Lot / Roll
      await page.locator('#uid-search').fill('L3');
      assert.deepEqual((await rows()).map(t => t.split(' ')[0]), ['1028260925000003']);
      await page.locator('#uid-search').fill('');

      // Chép UID
      await page.locator('#uid-pending .uid-row').first().locator('[data-action="copy"]').click();
      // Chép qua clipboard là bất đồng bộ: chờ dòng trạng thái đổi (đọc ngay sau click có lúc còn dòng cũ khi máy chạy nặng)
      await page.waitForFunction(() => document.getElementById('uid-status').textContent.trim() === 'Đã chép 1028260925000001.', null, { timeout: 5000 });

      // Chọn 2 → Xóa đã chọn (hỏi lại)
      assert.equal(await page.locator('#uid-bulk-delete').isDisabled(), true);
      await page.locator('#uid-pending .uid-row').nth(0).locator('input').check();
      await page.locator('#uid-pending .uid-row').nth(1).locator('input').check();
      await page.locator('#uid-bulk-delete').click();
      await page.locator('dialog.whd').waitFor({ state: 'visible' });
      assert.equal((await page.locator('dialog.whd .whd-title').textContent()).trim(), 'Xóa 2 Group UID đã chọn');
      await page.locator('dialog.whd .whd-ok').click();
      await page.waitForFunction(() => document.querySelector('#uid-pending-count').textContent === '2');
      assert.deepEqual((await rows()).map(t => t.split(' ')[0]), ['1028260925000003', '1028260925000004']);

      // Kéo ⋮⋮ đổi thứ tự (Gán tự động lấy UID từ đầu khung chờ): kéo dòng 2 lên trên dòng 1, rồi phím mũi tên xuống trả lại
      const order = () => page.evaluate(() => [...document.querySelectorAll('#uid-pending .uid-row')].map(r => r.querySelector('.uid-row__code').textContent));
      const handle = page.locator('#uid-pending .uid-row').nth(1).locator('[data-drag]');
      const [hb, first] = [await handle.boundingBox(), await page.locator('#uid-pending .uid-row').first().boundingBox()];
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2, first.y + 6, { steps: 8 });
      await page.mouse.up();
      assert.deepEqual(await order(), ['1028260925000004', '1028260925000003'], 'kéo thả đổi thứ tự');
      assert.match(await page.locator('#uid-status').textContent(), /1028260925000004 tới vị trí 1/);
      await page.locator('#uid-pending .uid-row').first().locator('[data-drag]').focus();
      await page.keyboard.press('ArrowDown');
      assert.deepEqual(await order(), ['1028260925000003', '1028260925000004'], 'phím mũi tên đổi thứ tự');
      await page.locator('#uid-search').fill('L3');
      assert.equal(await page.locator('#uid-pending [data-drag]').count(), 0, 'đang tìm thì ẩn tay kéo');
      await page.locator('#uid-search').fill('');

      // Ô SKU khi gán: nút ẩn/hiện bàn phím
      await page.locator('#uid-sku-kb').click();
      assert.equal(await page.locator('#uid-sku-kb').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => document.getElementById('uid-bulk-sku').inputMode), 'none');

      if (mobile) {
        // Tấm "Danh sách Group UID": cả chờ gán và đã gán
        await page.locator('#uid-sheet-open').click();
        const sheet = page.locator('#uid-sheet');
        await sheet.waitFor({ state: 'visible' });
        assert.deepEqual(await sheet.locator('[data-sheet-filter]').allTextContents(), ['Tất cả (3)', 'Chưa gán SKU (2)', 'Đã gán (1)']);
        await sheet.locator('[data-sheet-filter="mapped"]').click();
        assert.deepEqual(await sheet.locator('.uid-row .uid-row__code').allTextContents(), ['1028260925000009']);
        assert.equal(await sheet.locator('.uid-row input[type=checkbox]').count(), 0, 'UID đã gán không có ô chọn');
        await sheet.locator('[data-sheet-filter="all"]').click();
        await sheet.locator('#uid-sheet-all').check();
        assert.equal((await sheet.locator('#uid-sheet-picked').textContent()).trim(), 'Đã chọn 2');
        assert.equal((await sheet.locator('#uid-sheet-total').textContent()).trim(), 'Tổng 3 Group UID');
        await sheet.locator('#uid-sheet-search').fill('000004');
        assert.deepEqual(await sheet.locator('.uid-row .uid-row__code').allTextContents(), ['1028260925000004']);
        await sheet.locator('.uid-sheet__ok').click();
        assert.equal(await sheet.isVisible(), false, 'Xác nhận đóng tấm');
        assert.equal(await page.locator('#uid-select-all').isChecked(), true, 'chọn trong tấm áp vào thẻ Chưa gán SKU');
      } else {
        assert.equal(await page.locator('#uid-sheet-open').isVisible(), false, 'máy tính: danh sách đã hiện đủ');
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: dòng chờ gán Lot/Roll + giờ thêm, tìm, chép, Xóa đã chọn, kéo thả + phím mũi tên đổi thứ tự, bàn phím ô SKU${mobile ? ', 3 dòng + Xem tất cả, tấm Danh sách Group UID (lọc, chọn, tìm, Xác nhận)' : ''}`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
