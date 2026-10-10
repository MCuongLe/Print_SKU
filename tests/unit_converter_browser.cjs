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
        if (url.includes('/SKU_Name?') && url.includes('sku=eq.900000301')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ sku: '900000301', product_name: 'Chỉ Test/F1/Tex 27/mm' }]) });
        if (url.includes('/SKU_Name?') && url.includes('sku=eq.900000302')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ sku: '900000302', product_name: 'Chỉ Test/F2/Tex 30/mm' }]) });
        if (url.endsWith('/rpc/sku_combo_by_normal')) {
          const { p_sku } = route.request().postDataJSON();
          const rows = p_sku === '900000301' ? [{ combo_sku: '900000311', product_name: '(Combo) Chỉ Test/F1/cuộn 5000m', quantity: 5000000, component_count: 1, available: true }]
            : p_sku === '900000302' ? [{ combo_sku: '900000321', product_name: '(Combo) Chỉ Test/F2/cuộn 5000m', quantity: 5000000, component_count: 1, available: true }, { combo_sku: '900000322', product_name: '(Combo) Chỉ Test/F2/cuộn 3000m', quantity: 3000000, component_count: 1, available: true }, { combo_sku: '900000323', product_name: '(Combo) Chỉ Test/F2/bộ 2 màu', quantity: 1000000, component_count: 2, available: true }] : [];
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(rows) });
        }
        if (url.includes('/SKU_Name?')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [] } }) });
      });

      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-unit-converter').click();
      await page.locator('#unit-converter-screen').waitFor({ state: 'visible' });

      // Điện thoại: "Thông số hàng" và "Cách tính" là popup (tờ trượt dưới); từ 801 px nằm sẵn trong trang như cũ.
      const modal = width < 800;
      const withParams = async (kind, fill) => {
        const opener = page.locator(`#uc-${kind}-open`), sheet = page.locator(`#uc-${kind}-params`);
        assert.equal(await opener.isVisible(), modal, `nút Thông số hàng chỉ hiện trên điện thoại (${width}px)`);
        if (modal) { await opener.click(); await sheet.waitFor({ state: 'visible' }); } else assert.equal(await sheet.isVisible(), true, 'từ 801 px thông số hàng nằm sẵn trong trang');
        await fill();
        if (modal) { await page.keyboard.press('Escape'); await sheet.waitFor({ state: 'hidden' }); }
      };

      // Chỉ: đúng ví dụ Audit Factory, dùng Tex khi không có khối lượng cuộn nguyên.
      assert.equal((await page.locator('#uc-thread-open span').innerText()).trim(), 'Thông số hàng', 'chưa nhập thì dòng tóm tắt chỉ ghi tên');
      await withParams('thread', async () => {
        await page.locator('#uc-thread-spec').fill('5000');
        await page.locator('#uc-thread-tex').fill('27');
        await page.locator('#uc-thread-core').fill('14');
      });
      await page.locator('#uc-total').fill('10000');
      await page.locator('#uc-weight-unit [data-unit="g"]').click();
      await page.locator('#uc-thread-cones').fill('10');
      await page.waitForFunction(() => document.querySelector('#uc-mm')?.textContent === '365.185.185');
      assert.equal(await page.locator('#uc-basis').innerText(), 'Tex 27');
      assert.equal((await page.locator('#uc-thread-open span').innerText()).trim(), '5.000 m · Tex 27 · lõi 14 g', 'dòng tóm tắt thông số hàng');
      assert.match(await page.locator('#uc-sub').innerText(), /^365\.185[,.]2 m · Tex 27$/, 'dòng phụ dưới kết quả: mét + thước đang dùng');
      assert.equal(await page.locator('.uc-steps-open').isVisible(), modal);
      if (modal) {
        await page.locator('.uc-steps-open').click(); await page.locator('#uc-steps-sheet').waitFor({ state: 'visible' });
        assert.ok(await page.locator('#uc-steps .fsk-step').count() >= 4, 'Cách tính liệt kê các bước');
        await page.keyboard.press('Escape'); await page.locator('#uc-steps-sheet').waitFor({ state: 'hidden' });
      } else assert.equal(await page.locator('#uc-steps-sheet').isVisible(), true, 'từ 801 px cách tính nằm sẵn trong trang');
      assert.equal(await page.locator('#uc-find-hint, .uc-result-main small:not(.uc-result-sub)').count(), 0);
      assert.equal(await page.locator('#uc-use').isVisible(), false, 'không SKU vẫn tính/copy được, chỉ không thể chuyển sang in');

      // Quy cách cuộn nguyên suy ra từ Combo (RPC sku_combo_by_normal): một Combo → tự điền + chip "theo Combo"; nhiều Combo khác quy cách → chip để chọn, không tự chọn hộ.
      await page.locator('#uc-clear').click();
      await page.locator('[data-uc-kind="thread"]').click();
      await page.locator('#uc-code').fill('900000301'); await page.locator('#uc-code-form').press('Enter');
      await page.waitForFunction(() => document.getElementById('uc-thread-spec').value === '5000');
      assert.equal(await page.locator('#uc-thread-tex').inputValue(), '27');
      assert.deepEqual(await page.locator('#uc-spec-choices button').allInnerTexts(), ['5.000 m']);
      assert.equal(await page.locator('#uc-spec-choices button').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('#uc-spec-choices button').getAttribute('title'), 'Theo Combo 900000311');
      assert.equal((await page.locator('#uc-thread-open span').innerText()).trim(), '5.000 m · Tex 27');
      await page.locator('#uc-clear').click();
      assert.equal(await page.locator('#uc-spec-choices').isVisible(), false, 'Nhập lại từ đầu thì bỏ chip quy cách');
      await page.locator('#uc-code').fill('900000302'); await page.locator('#uc-code-form').press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('#uc-spec-choices button').length === 2);
      assert.deepEqual(await page.locator('#uc-spec-choices button').allInnerTexts(), ['5.000 m', '3.000 m'], 'Combo nhiều thành phần không được tính là quy cách');
      assert.equal(await page.locator('#uc-thread-spec').inputValue(), '', 'nhiều quy cách khác nhau thì không tự chọn hộ');
      await page.locator('#uc-spec-choices button').nth(1).click();
      assert.equal(await page.locator('#uc-thread-spec').inputValue(), '3000');
      assert.deepEqual(await page.locator('#uc-spec-choices button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-pressed'))), ['false', 'true']);
      await page.locator('#uc-clear').click();

      // Vải nhập tay: GSM × khổ.
      await page.locator('[data-uc-kind="fabric"]').click();
      await page.locator('#uc-total').fill('10');
      await page.locator('#uc-weight-unit [data-unit="kg"]').click();
      await withParams('fabric', async () => {
        await page.locator('#uc-fabric-width').fill('150');
        await page.locator('#uc-fabric-gsm').fill('200');
      });
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
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      console.log(`PASS ${width}px: thread Tex, fabric manual, SKU/UID autofill, quy cách từ Combo, popup thông số/cách tính, return-to-print, no overflow/errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
