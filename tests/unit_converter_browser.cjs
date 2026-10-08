// Local UI checks only: all external traffic is mocked; no real printing or production writes.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 940 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        if (url.includes('/SKU_Name?') && url.includes('sku=eq.900000201')) {
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ sku: '900000201', product_name: 'Vải mẫu/Canvas/220gsm/58_60in/g' }]) });
        }
        if (url.endsWith('/rpc/group_uid_lookup')) {
          const { p_codes } = route.request().postDataJSON();
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(p_codes.map(code => ({ group_uid_code: code, sku: '900000202', product_name: 'Vải mẫu/Polyester/170GSM/W180cm/mm', lot: 'LOT-01', roll: '01' }))) });
        }
        if (url.includes('/SKU_Name?')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [] } }) });
      });

      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-unit-converter').click();
      await page.locator('#unit-converter-screen').waitFor({ state: 'visible' });

      // Chỉ: đúng ví dụ Audit Factory, dùng Tex khi không có khối lượng cuộn nguyên.
      await page.locator('#uc-thread-spec').fill('5000');
      await page.locator('#uc-thread-tex').fill('27');
      await page.locator('#uc-total').fill('10000');
      await page.locator('#uc-weight-unit [data-unit="g"]').click();
      await page.locator('#uc-thread-cones').fill('10');
      await page.locator('#uc-thread-core').fill('14');
      await page.waitForFunction(() => document.querySelector('#uc-mm')?.textContent === '365.185.185');
      assert.equal(await page.locator('#uc-basis').innerText(), 'Tex 27');
      assert.equal(await page.locator('#uc-use').isVisible(), false, 'không SKU vẫn tính/copy được, chỉ không thể chuyển sang in');

      // Vải nhập tay: GSM × khổ.
      await page.locator('[data-uc-kind="fabric"]').click();
      await page.locator('#uc-total').fill('10');
      await page.locator('#uc-weight-unit [data-unit="kg"]').click();
      await page.locator('#uc-fabric-width').fill('150');
      await page.locator('#uc-fabric-gsm').fill('200');
      await page.waitForFunction(() => document.querySelector('#uc-mm')?.textContent === '33.333');
      assert.match(await page.locator('#uc-warning').innerText(), /±5–8%/);

      // SKU tự đọc khổ inch dạng khoảng và GSM.
      await page.locator('#uc-code').fill('900000201');
      await page.locator('#uc-code-form').press('Enter');
      await page.waitForFunction(() => document.querySelector('#uc-picked-code')?.textContent.includes('900000201'));
      assert.equal(await page.locator('#uc-fabric-gsm').inputValue(), '220');
      assert.equal(Number(Number(await page.locator('#uc-fabric-width').inputValue()).toFixed(2)), 149.86);
      assert.equal(await page.locator('#uc-use').isVisible(), false, 'SKU đơn vị g không được gắn nhầm kết quả mm để in');
      assert.equal(await page.locator('#uc-lookup-details').evaluate(element => element.open), false, 'mục 1 tự thu gọn sau khi nhận diện');

      // Nhập lại từ đầu mở mục 1 và xóa cả SKU lẫn thông số.
      await page.locator('#uc-clear').click();
      assert.equal(await page.locator('#uc-lookup-details').evaluate(element => element.open), true);
      assert.equal(await page.locator('#uc-code').inputValue(), '');
      assert.equal(await page.locator('#uc-fabric-gsm').inputValue(), '');

      // Group UID tự tìm SKU/tên sản phẩm rồi đọc khổ và GSM.
      await page.locator('#uc-code').fill('1028260900000101');
      await page.locator('#uc-code-form').press('Enter');
      await page.waitForFunction(() => document.querySelector('#uc-picked-code')?.textContent.includes('1028260900000101'));
      assert.equal(await page.locator('#uc-fabric-width').inputValue(), '180');
      assert.equal(await page.locator('#uc-fabric-gsm').inputValue(), '170');
      await page.locator('#uc-total').fill('10');
      assert.equal(await page.locator('#uc-use').isVisible(), true);
      assert.equal(await page.locator('#uc-lookup-details').evaluate(element => element.open), false);

      // Lô tiếp theo chỉ xóa số cân, vẫn giữ SKU và thông số hàng.
      await page.locator('#uc-next').click();
      assert.equal(await page.locator('#uc-total').inputValue(), '');
      assert.equal(await page.locator('#uc-fabric-width').inputValue(), '180');
      assert.equal(await page.locator('#uc-fabric-gsm').inputValue(), '170');

      // Kết quả quay về TÌM SKU, tự điền mm nhưng vẫn để người dùng quyết định số tem/in.
      await page.locator('#uc-total').fill('10');
      await page.screenshot({ path: `workstation-agent/preview/unit-converter-ui-${width}.png`, fullPage: true });
      await page.locator('#uc-use').click();
      await page.locator('#find-sku-screen').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#fsk-qty').inputValue(), '32680');
      assert.equal(await page.locator('#fsk-copies').inputValue(), '1');
      assert.equal(await page.locator('#fsk-add').isEnabled(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `workstation-agent/preview/unit-converter-return-${width}.png`, fullPage: true });
      console.log(`PASS ${width}px: thread Tex, fabric manual, SKU/UID autofill, return-to-print, no overflow/errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
