// Hộp xác nhận dùng chung WhDialog (08/10/2026) thay mọi confirm() của trình duyệt.
// Kiểm: nội dung (tiêu đề, nhãn số, danh sách tối đa 5 + "+n"), con trỏ ban đầu theo kiểu hộp, Enter/Esc/bấm ra
// ngoài, xếp hàng khi gọi liên tiếp, trả con trỏ, giữa màn (máy tính) / sát đáy (điện thoại); cảnh báo Lot/Roll dùng
// chung PRINT UID + Cắt UID; luồng thật IN TEM SKU (bundle React): cảnh báo SKU Combo rồi xác nhận lệnh > 30 tem.
// Run against python -m http.server 8000. Supabase giả lập, dữ liệu tổng hợp; không ghi dữ liệu thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';

const mock = (page, enqueued) => page.route('**/*', async route => {
  const url = route.request().url();
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (rpc === 'print_enqueue') {
    enqueued.push(JSON.parse(route.request().postData() || '{}'));
    return json({ ok: true, data: { id: '99999999-0000-4000-8000-000000000009', status: 'queued', duplicate: false } });
  }
  if (rpc === 'print_job_status') return json({ ok: true, data: { id: '99999999-0000-4000-8000-000000000009', status: 'completed', copies: 31 } });
  if (rpc === 'print_queue_status') return json({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: [] } });
  // Bộ chọn SKU Combo dùng chung: mảng rỗng = không có SKU Normal liên kết, thêm thẳng vào danh sách.
  if (rpc === 'sku_combo_lookup') return json([]);
  if (url.includes('/rest/v1/') && !rpc) return json([]);
  return json({ ok: true, data: {} });
});

const box = page => page.locator('dialog.whd');
// Gọi WhDialog.confirm và giữ lời đáp ở window để đọc sau khi thao tác.
const ask = (page, options) => page.evaluate(opts => { window.__answer = 'chưa'; window.WhDialog.confirm(opts).then(value => { window.__answer = value; }); }, options);
const answer = page => page.waitForFunction(() => window.__answer !== 'chưa').then(() => page.evaluate(() => window.__answer));
const focused = (page, cls) => box(page).locator(cls).evaluate(button => button === document.activeElement);

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      const errors = [], native = [], enqueued = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => { native.push(dialog.message()); dialog.dismiss(); });
      await mock(page, enqueued);
      await page.goto(BASE + '#home');
      await page.locator('#barcode-admin').waitFor({ state: 'visible' });

      // Hộp thường: nội dung, danh sách 5 + "+2", con trỏ ở nút đồng ý, Enter = đồng ý
      await page.locator('#barcode-admin').focus();
      await ask(page, { title: 'In lại lệnh SKU', facts: ['3 SKU', '', '6 tem'], list: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'], confirmText: 'In lại 6 tem' });
      await box(page).waitFor({ state: 'visible' });
      assert.equal(await box(page).getAttribute('role'), 'alertdialog');
      assert.equal(await box(page).getAttribute('data-tone'), 'default');
      assert.equal((await box(page).locator('.whd-title').textContent()).trim(), 'In lại lệnh SKU');
      assert.deepEqual(await box(page).locator('.whd-facts li').allTextContents(), ['3 SKU', '6 tem'], 'bỏ nhãn rỗng');
      assert.deepEqual(await box(page).locator('.whd-list li').allTextContents(), ['A1', 'A2', 'A3', 'A4', 'A5', '+2']);
      assert.deepEqual([await box(page).locator('.whd-ok').textContent(), await box(page).locator('.whd-cancel').textContent()], ['In lại 6 tem', 'Huỷ']);
      assert.equal(await focused(page, '.whd-ok'), true);
      const rect = await box(page).boundingBox(), view = page.viewportSize();
      if (width >= 768) {
        assert.ok(Math.abs(rect.x + rect.width / 2 - view.width / 2) <= 2 && Math.abs(rect.y + rect.height / 2 - view.height / 2) <= 2, 'máy tính: hộp ở giữa màn');
        assert.ok(rect.width <= 400, 'máy tính: hộp gọn');
      } else {
        assert.ok(Math.abs(rect.y + rect.height - view.height) <= 1 && rect.width === view.width, 'điện thoại: bảng trượt sát đáy, rộng hết màn');
        const [ok, cancel] = [await box(page).locator('.whd-ok').boundingBox(), await box(page).locator('.whd-cancel').boundingBox()];
        assert.ok(ok.y < cancel.y && ok.height >= 48, 'điện thoại: nút đồng ý ở trên, cao 48px');
      }
      await page.keyboard.press('Enter');
      assert.equal(await answer(page), true);
      await box(page).waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'barcode-admin', 'trả con trỏ về chỗ cũ');

      // Cảnh báo: con trỏ ở Huỷ nên Enter = Huỷ; không có danh sách thì ẩn khung danh sách
      await ask(page, { tone: 'warning', title: '2 SKU Combo trong lệnh', confirmText: 'Vẫn in' });
      await box(page).waitFor({ state: 'visible' });
      assert.equal(await box(page).getAttribute('data-tone'), 'warning');
      assert.equal(await focused(page, '.whd-cancel'), true);
      assert.equal(await box(page).locator('.whd-list').isVisible(), false);
      assert.equal(await box(page).locator('.whd-facts').isVisible(), false);
      await page.keyboard.press('Enter');
      assert.equal(await answer(page), false);

      // Xoá: nút đồng ý màu đỏ, con trỏ ở Huỷ; bấm nút đồng ý = true
      await ask(page, { tone: 'danger', title: 'Xoá 3 vị trí khỏi hàng đợi', list: ['Z1', 'Z2', 'Z3'], confirmText: 'Xoá 3 vị trí' });
      await box(page).waitFor({ state: 'visible' });
      assert.equal(await focused(page, '.whd-cancel'), true);
      assert.equal(await box(page).locator('.whd-ok').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(163, 45, 45)');
      await box(page).locator('.whd-ok').click();
      assert.equal(await answer(page), true);

      // Esc và bấm ra ngoài hộp = Huỷ
      await ask(page, { title: 'Esc' });
      await box(page).waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      assert.equal(await answer(page), false);
      await ask(page, { title: 'Bấm ra ngoài' });
      await box(page).waitFor({ state: 'visible' });
      await page.mouse.click(5, 5);
      assert.equal(await answer(page), false);

      // Gọi liên tiếp: hộp thứ hai đợi hộp đầu trả lời, không chồng lên nhau
      await page.evaluate(() => { window.__both = []; for (const title of ['Hộp 1', 'Hộp 2']) window.WhDialog.confirm({ title }).then(value => window.__both.push([title, value])); });
      await box(page).waitFor({ state: 'visible' });
      assert.equal((await box(page).locator('.whd-title').textContent()).trim(), 'Hộp 1');
      await box(page).locator('.whd-ok').click();
      await page.waitForFunction(() => document.querySelector('dialog.whd .whd-title').textContent === 'Hộp 2' && document.querySelector('dialog.whd').open);
      await box(page).locator('.whd-cancel').click();
      await page.waitForFunction(() => window.__both.length === 2);
      assert.deepEqual(await page.evaluate(() => window.__both), [['Hộp 1', true], ['Hộp 2', false]]);

      // Cảnh báo Lot/Roll dùng chung (PRINT UID, Cắt UID): không đè → true không hỏi; đè → hộp cảnh báo
      assert.equal(await page.evaluate(() => window.PrintSkuQueue.confirmLotRoll([{ groupUid: 'U1', lot: '5', roll: '2' }])), true);
      await page.evaluate(() => { window.__answer = 'chưa'; window.PrintSkuQueue.confirmLotRoll([{ groupUid: '1028260900000999', lot: 'LOT-MAU-RAT-DAI-01', roll: 'ROLL-MAU-RAT-DAI-02' }]).then(value => { window.__answer = value; }); });
      await box(page).waitFor({ state: 'visible' });
      assert.equal(await box(page).getAttribute('data-tone'), 'warning');
      assert.equal((await box(page).locator('.whd-title').textContent()).trim(), 'Lot và Roll có thể đè nhau trên tem');
      assert.match(await box(page).locator('.whd-list li').first().textContent(), /^1028260900000999 · LOT LOT-MAU-RAT-DAI-01 · ROLL ROLL-MAU-RAT-DAI-02$/);
      assert.equal((await box(page).locator('.whd-cancel').textContent()).trim(), 'Dừng kiểm tra');
      assert.equal(await focused(page, '.whd-cancel'), true);
      await box(page).locator('.whd-cancel').click();
      assert.equal(await answer(page), false);

      // IN TEM SKU (bundle React): SKU Combo 31 tem → cảnh báo Combo, Huỷ thì không gửi; đồng ý → hỏi tiếp "In 31 tem"
      await page.goto(BASE + '#worker');
      await page.locator('#f-sku').fill('900000901');
      // Màn tra danh mục sau khi gõ SKU và xoá ô tên nếu không thấy mã — đợi tra xong rồi mới điền tên.
      await page.waitForFunction(() => /Chưa có trong danh mục/.test(document.getElementById('root').innerText));
      await page.locator('#f-pn').fill('(Combo) Bộ mẫu thử');
      await page.locator('#f-ban').fill('31');
      await page.getByRole('button', { name: 'Thêm vào danh sách' }).click();
      const printButton = page.locator('#root button.act-icon--print');   // nhãn nút đổi theo số tem nên chọn theo class
      await page.waitForFunction(() => /31/.test(document.body.innerText));
      await printButton.click();
      await box(page).waitFor({ state: 'visible' });
      assert.equal((await box(page).locator('.whd-title').textContent()).trim(), '1 SKU Combo trong lệnh');
      assert.deepEqual(await box(page).locator('.whd-facts li').allTextContents(), ['1 SKU', '31 tem']);
      assert.deepEqual(await box(page).locator('.whd-list li').allTextContents(), ['900000901 · Bộ mẫu thử']);
      assert.equal((await box(page).locator('.whd-ok').textContent()).trim(), 'Vẫn in 31 tem');
      assert.equal(await focused(page, '.whd-cancel'), true);
      await box(page).locator('.whd-cancel').click();
      await box(page).waitFor({ state: 'hidden' });
      await page.waitForTimeout(300);
      assert.equal(enqueued.length, 0, 'Huỷ cảnh báo Combo thì không gửi lệnh');
      await printButton.click();
      await box(page).waitFor({ state: 'visible' });
      await box(page).locator('.whd-ok').click();
      await page.waitForFunction(() => document.querySelector('dialog.whd').open && document.querySelector('dialog.whd .whd-title').textContent === 'In 31 tem');
      assert.deepEqual(await box(page).locator('.whd-facts li').allTextContents(), ['1 SKU']);
      assert.equal(await focused(page, '.whd-ok'), true);
      await box(page).locator('.whd-ok').click();
      for (const until = Date.now() + 10000; !enqueued.length && Date.now() < until;) await page.waitForTimeout(50);
      await page.waitForTimeout(200);
      assert.equal(enqueued.length, 1);
      assert.equal(enqueued[0].p_copies, 31);
      assert.equal(enqueued[0].p_type, 'sku');

      assert.deepEqual(native, [], 'không còn hộp confirm() của trình duyệt');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: WhDialog — nội dung, con trỏ theo kiểu, Enter/Esc/bấm ngoài, xếp hàng, vị trí; Lot/Roll; IN TEM SKU Combo + > 30 tem`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
