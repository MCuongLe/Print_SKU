// IN TEM SKU theo mẫu (11/10/2026, khối #sku-queue-ui): danh sách chờ in mới (ô chọn, sửa, xoá) đọc từ danh sách của bundle React (ẩn),
// thanh đáy Chọn tất cả + xoá tem đã chọn + "N tem / Tổng M bản in", điện thoại có tấm kéo lên (tìm, lọc Tất cả / Đã chọn / Chưa chọn).
// Mọi thao tác bấm nút của React nên In tem vẫn gửi lệnh như cũ. Supabase giả lập. Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const ITEMS = [['SKU-00128', 'Vải thun cotton 4 chiều / Navy', '1200', '2'], ['SKU-00245', 'Vải polyester / Black / 180gsm', '500', '1'], ['SKU-00367', 'Vải kate / White / 160gsm', '800', '1']];

const add = async (page, [sku, name, qty, copies]) => {
  await page.locator('#f-sku').fill(sku);
  await page.waitForFunction(() => /Chưa có trong danh mục/.test(document.getElementById('root').innerText)).catch(() => {});
  await page.locator('#f-pn').fill(name); await page.locator('#f-sl').fill(qty); await page.locator('#f-ban').fill(copies);
  await page.locator('#sku-add-to-list').click();
  await page.waitForFunction(s => [...document.querySelectorAll('#root .skq-list .skq-main b')].some(b => b.textContent === s), sku);
};
const state = page => page.evaluate(() => {
  const all = document.querySelector('#root .skq-tools .skq-all input');
  return {
    rows: [...document.querySelectorAll('#root main .skq-list > .skq-item')].map(li => `${li.querySelector('b').textContent}|${li.querySelector('.skq-meta').innerText.replace(/\s+/g, ' ')}|${li.querySelector('input').checked}`),
    react: document.querySelector('#root main ul.divide-y')?.children.length || 0,
    reactVisible: Boolean(document.querySelector('#root main ul.divide-y')?.getBoundingClientRect().height),
    count: document.querySelector('#root .skq-count')?.hidden ? '' : document.querySelector('#root .skq-count')?.textContent,
    sum: document.querySelector('#root .skq-sum')?.innerText.replace(/\s+/g, ' ').trim(),
    all: all ? `${all.checked}/${all.indeterminate}` : '',
    tools: !document.querySelector('#root .skq-tools')?.hidden
  };
});

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [], enqueued = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
        if (rpc === 'sku_combo_lookup') return json([]);
        if (rpc === 'print_enqueue') { enqueued.push(JSON.parse(route.request().postData() || '{}')); return json({ ok: true, data: { id: '99999999-0000-4000-8000-000000000001', status: 'queued', duplicate: false } }); }
        if (rpc === 'print_job_status') return json({ ok: true, data: { id: '99999999-0000-4000-8000-000000000001', status: 'completed', copies: 4 } });
        if (rpc === 'print_queue_status') return json({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: [] } });
        if (url.includes('/rest/v1/') && !rpc) return json([]);
        return json({ ok: true, data: {} });
      });
      await page.goto(BASE + '#worker');
      await page.locator('#f-sku').waitFor();
      await page.waitForFunction(() => document.querySelector('#root .skq-sum'));
      assert.equal(await page.locator('#f-sku').getAttribute('placeholder'), 'SKU', 'ô SKU giữ gợi ý ngắn (chuẩn không câu hướng dẫn)');
      assert.equal((await page.locator('#root main > section p.items-baseline > span').first().textContent()).trim(), 'Nhập thông tin tem');
      let s = await state(page);
      assert.equal(s.tools, false, 'chưa có tem: ẩn Chọn tất cả / xoá'); assert.equal(s.sum, '0 tem');

      for (const item of ITEMS) await add(page, item);
      s = await state(page);
      assert.deepEqual(s.rows, ['SKU-00128|1200 2 bản|true', 'SKU-00245|500 1 bản|true', 'SKU-00367|800 1 bản|true'], 'danh sách mới: tem mới mặc định đã chọn');
      assert.equal(s.react, 3); assert.equal(s.reactVisible, false, 'danh sách React ẩn');
      assert.equal(s.count, '3 tem'); assert.equal(s.sum, '3 tem Tổng 4 bản in'); assert.equal(s.all, 'true/false');

      // Bỏ chọn 1 tem → Chọn tất cả ở trạng thái lưng chừng; xoá tem đã chọn (hỏi lại) → còn tem chưa chọn
      await page.locator('#root main .skq-list input[aria-label="Chọn SKU-00245"]').uncheck();
      assert.equal((await state(page)).all, 'false/true');
      await page.locator('#root .skq-tools .skq-bulk').click();
      await page.locator('dialog.whd').waitFor({ state: 'visible' });
      assert.equal((await page.locator('dialog.whd .whd-title').textContent()).trim(), 'Xoá 2 tem đã chọn');
      assert.deepEqual(await page.locator('dialog.whd .whd-facts li').allTextContents(), ['2 tem', '3 bản in']);
      await page.locator('dialog.whd .whd-ok').click();
      await page.waitForFunction(() => document.querySelectorAll('#root main .skq-list > .skq-item').length === 1);
      s = await state(page);
      assert.deepEqual(s.rows, ['SKU-00245|500 1 bản|false'], 'chỉ còn tem chưa chọn'); assert.equal(s.sum, '1 tem Tổng 1 bản in');

      // Sửa: tem về ô nhập (SKU, tên, số lượng, số bản), bỏ khỏi danh sách
      await page.locator('#root main .skq-list [aria-label="Sửa SKU-00245"]').click();
      await page.waitForFunction(() => !document.getElementById('root').dataset.skqEditing, null, { timeout: 8000 }); // đợi điền lại xong (React tra danh mục có thể xoá tên)
      assert.deepEqual(await page.evaluate(() => ['f-sku', 'f-pn', 'f-sl', 'f-ban'].map(id => document.getElementById(id).value)), ['SKU-00245', 'Vải polyester / Black / 180gsm', '500', '1']);
      s = await state(page);
      assert.deepEqual(s.rows, []); assert.equal(s.count, ''); assert.equal(s.tools, false);
      await page.locator('#sku-add-to-list').click();
      await page.waitForFunction(() => document.querySelectorAll('#root main .skq-list > .skq-item').length === 1);
      assert.deepEqual((await state(page)).rows, ['SKU-00245|500 1 bản|true'], 'thêm lại sau khi sửa');

      // Xoá một tem bằng nút trên dòng
      await page.locator('#root main .skq-list [aria-label="Xoá SKU-00245"]').click();
      await page.waitForFunction(() => !document.querySelector('#root main ul.divide-y > li') && document.querySelector('#root .skq-sum b')?.textContent === '0 tem');

      for (const item of ITEMS) await add(page, item);
      if (mobile) {
        // Tấm kéo lên: tiêu đề, lọc, tìm, In tem đóng tấm rồi in cả danh sách
        await page.locator('#root .skq-open').click();
        const sheet = page.locator('dialog.skq-sheet');
        await sheet.waitFor({ state: 'visible' });
        assert.equal((await sheet.locator('h2').textContent()).trim(), 'Danh sách chờ in (3 tem)');
        assert.deepEqual(await sheet.locator('.skq-chip').allTextContents(), ['Tất cả (3)', 'Đã chọn (3)', 'Chưa chọn (0)']);
        await sheet.locator('input[aria-label="Chọn SKU-00128"]').uncheck();
        assert.deepEqual(await sheet.locator('.skq-chip').allTextContents(), ['Tất cả (3)', 'Đã chọn (2)', 'Chưa chọn (1)']);
        await sheet.locator('.skq-chip[data-filter="off"]').click();
        assert.deepEqual(await sheet.locator('.skq-item b').allTextContents(), ['SKU-00128']);
        await sheet.locator('.skq-chip[data-filter="all"]').click();
        await sheet.locator('.skq-search input').fill('kate');
        assert.deepEqual(await sheet.locator('.skq-item b').allTextContents(), ['SKU-00367'], 'tìm theo tên không dấu/có dấu');
        assert.deepEqual(await sheet.locator('.skq-pill').allTextContents(), ['800', '1 bản']);
        assert.equal((await sheet.locator('.skq-sum').innerText()).replace(/\s+/g, ' ').trim(), '3 tem Tổng 4 bản in');
        await sheet.locator('.skq-print').click();
        assert.equal(await sheet.isVisible(), false, 'In tem: đóng tấm kéo lên');
      } else {
        assert.equal(await page.locator('#root .skq-open').isVisible(), false, 'máy tính: danh sách đã hiện đủ, không cần tấm kéo lên');
        await page.locator('#root button.act-icon--print').click();
      }
      await page.waitForFunction(() => document.querySelector('dialog.whd[open]') || true);
      if (await page.locator('dialog.whd[open] .whd-ok').count()) await page.locator('dialog.whd[open] .whd-ok').click();
      await page.waitForFunction(n => n > 0, 0).catch(() => {});
      for (let i = 0; i < 30 && !enqueued.length; i++) await page.waitForTimeout(100);
      assert.ok(enqueued.length >= 1, 'In tem vẫn gửi lệnh in (print_enqueue)');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: danh sách chờ in mới (chọn, xoá đã chọn, sửa, xoá dòng), thanh đáy tổng tem/bản in${mobile ? ', tấm kéo lên (lọc, tìm, In tem)' : ''}, In tem vẫn gửi lệnh`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
