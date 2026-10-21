// IN TEM GROUP UID: ô Số PO + Ngày nhận ở khung "Sẵn sàng in" (21/10/2026). Hai ô tùy chọn: nhập tay áp cho UID chưa có PO,
// UID gán từ Packing List WMS (tab Gán WMS) mang đúng số PO đã đọc và không bị ô nhập tay ghi đè; ngày nhận chung cả lệnh, dạng dd/mm/yyyy;
// gửi xong thì xóa cả hai ô. Chạy với python -m http.server 8000; Extension và Supabase giả lập, lệnh in chỉ bắt trong bộ nhớ.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

const PO_A = '10000000000001', PO_B = '10000000000002';
const pl = (po, sku, i) => ({ purchase_order: po, shipment: '1000000000000001', sku, product_name: `Vải ${sku}`, quantity: 18, code: String(i + 1), batch_code: 'L1', status: 'Approved', delivery: 'Normal' });
const packing = {
  [PO_A]: [...Array.from({ length: 3 }, (_, i) => pl(PO_A, '900000001', i)), ...Array.from({ length: 2 }, (_, i) => pl(PO_A, '900000002', i))],
  [PO_B]: Array.from({ length: 2 }, (_, i) => pl(PO_B, '900000002', i))
};
const fakeExtension = data => {
  window.__packing = data;
  addEventListener('message', event => {
    const request = event.data;
    if (!request || request.source !== 'PRINT_SKU_APP') return;
    const reply = (ok, body, error) => postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: request.requestId, ok, data: body, error }, location.origin);
    if (request.type === 'PING' || request.type === 'PING_WMS') return reply(true, { version: '0.10.4' });
    if (request.type === 'GET_PACKING_LIST_PAGE') {
      const { purchaseOrders, page, size } = request.payload;
      const rows = purchaseOrders.flatMap(po => window.__packing[po] || []);
      return reply(true, { page, size, total: rows.length, totalPages: 1, rows, sourceRows: rows.length, purchaseOrders });
    }
    reply(false, null, { message: 'Loại yêu cầu chưa giả lập' });
  });
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.route('**/*', route => {
        const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith('/rpc/group_uid_lookup')) {
          const { p_codes } = route.request().postDataJSON();
          // TEST-READY đã có tên sản phẩm (sang thẳng Sẵn sàng in); các mã khác chưa có (chờ gán)
          return json(p_codes.filter(code => code === 'TEST-READY').map(code => ({ group_uid_code: code, sku: '000123456', product_name: 'Vải thử', lot: 'L9', roll: '5' })));
        }
        if (url.endsWith('/rpc/sku_combo_lookup')) return json([]);
        if (url.includes('/rest/v1/SKU_Name')) return json([{ product_name: 'Tên SKU từ Supabase' }]);
        return json({ ok: true, data: { agents: [], jobs: [] } });
      });
      await page.addInitScript(fakeExtension, packing);
      await page.goto(BASE + '#group-uid');
      await page.evaluate(() => {
        window.testJobs = []; window.testNonces = []; window.failNext = 0; window.delayMs = 0;
        window.PrintSkuQueue.enqueue = async job => {
          window.testNonces.push(job.requestNonce);
          if (window.delayMs) await new Promise(resolve => setTimeout(resolve, window.delayMs));
          if (window.failNext > 0) { window.failNext -= 1; return { ok: false, error: { message: 'lỗi giả lập' } }; }
          window.testJobs.push(job); return { ok: true, data: { id: 'job-' + window.testJobs.length } };
        };
        window.PrintSkuAdminAuth = { accessToken: async () => 'test-admin-token' };
        window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => 't', getToken: async () => 't' };
      });
      const add = async code => { await page.locator('#uid-code').fill(code); await page.locator('#uid-code').press('Enter'); };
      const ready = n => page.waitForFunction(count => document.querySelector('#uid-ready-count').textContent === String(count), n);
      const pending = n => page.waitForFunction(count => document.querySelector('#uid-pending-count').textContent === String(count), n);

      // Hai ô nằm trong khung Sẵn sàng in, cạnh nhau ở cả hai bề rộng, trống ban đầu
      const poBox = await page.locator('#uid-print-po').boundingBox(), dateBox = await page.locator('#uid-print-date').boundingBox();
      assert.ok(poBox && dateBox, 'ô PO và ngày nhận phải hiện');
      assert.ok(Math.abs(poBox.y - dateBox.y) < 2 && dateBox.x > poBox.x + poBox.width - 2, `hai ô cùng hàng (${width}px)`);
      assert.equal(await page.locator('#uid-print-po').inputValue(), '');
      assert.equal(await page.locator('#uid-print-date').getAttribute('type'), 'date');

      // 1) Không nhập gì: tem như cũ, po / receivedDate rỗng (agent bỏ ô PO)
      await add('TEST-READY'); await ready(1);
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => window.testJobs.length === 1);
      let items = await page.evaluate(() => window.testJobs[0].payload.items);
      assert.deepEqual([items[0].po, items[0].receivedDate], ['', '']);
      await ready(0);

      // 2) Nhập tay PO + ngày: áp cho mọi UID, ngày đổi sang dd/mm/yyyy, ô được xóa sau khi gửi xong
      await add('TEST-READY'); await ready(1);
      await add('TEST-MANUAL-2'); await pending(1);
      await page.locator('#uid-print-po').fill('  PO-MANUAL-01 ');
      await page.locator('#uid-print-date').fill('2026-06-15');
      assert.equal(await page.locator('#uid-print-date-echo').innerText(), '· 15/06/2026', 'dòng nhắc đúng chuỗi sẽ in lên tem');
      await page.locator('#uid-bulk-product').fill('Vải gán tay');
      await page.locator('#uid-pending .uid-row').first().locator('input').check();
      await page.locator('#uid-apply-mapping').click();
      await ready(2);
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => window.testJobs.length === 2);
      items = await page.evaluate(() => window.testJobs[1].payload.items);
      assert.equal(items.length, 2);
      for (const item of items) assert.deepEqual([item.po, item.receivedDate], ['PO-MANUAL-01', '15/06/2026']);
      assert.equal(await page.locator('#uid-print-po').inputValue(), '', 'gửi xong xóa ô PO');
      assert.equal(await page.locator('#uid-print-date').inputValue(), '', 'gửi xong xóa ô ngày nhận');
      assert.equal(await page.locator('#uid-print-date-echo').innerText(), '', 'gửi xong xóa dòng nhắc ngày');

      // Điện thoại (≤ 800px) không có Extension nên ẩn tab Gán WMS: chỉ máy tính chạy bước 3 và 4
      if (width > 800) {
        // 3) Gán WMS một PO: UID mang PO đó, không bị ô nhập tay ghi đè; UID đã có tên sẵn dùng ô nhập tay
        for (const code of ['W1', 'W2', 'W3']) await add(code);
        await pending(3);
        await page.locator('#uid-tab-po').click();
        await page.locator('#uid-po-input').fill(PO_A);
        await page.locator('#uid-po-go').click();
        await page.waitForFunction(() => document.querySelectorAll('#uid-po-rows .uid-auto__row').length === 2);
        assert.match(await page.locator('#uid-po-rows').innerText(), new RegExp(`PO ${PO_A}`), 'mỗi dòng Gán WMS hiện PO sẽ in');
        await page.locator('#uid-po-rows .uid-auto__row').nth(1).locator('input[type=checkbox]').uncheck(); // chỉ gán SKU 900000001 (3 UID)
        await page.locator('#uid-po-apply').click();
        await ready(3);
        assert.match(await page.locator('#uid-ready').innerText(), new RegExp(`PO ${PO_A}`), 'dòng Sẵn sàng in hiện PO của UID gán WMS');
        await add('TEST-READY'); await ready(4);
        await page.locator('#uid-print-po').fill('PO-MANUAL-02');
        await page.locator('#uid-print-date').fill('2026-07-05');
        await page.locator('#uid-print-all').click();
        await page.waitForFunction(() => window.testJobs.length === 3);
        items = await page.evaluate(() => window.testJobs[2].payload.items);
        const byUid = Object.fromEntries(items.map(item => [item.groupUid, item]));
        for (const code of ['W1', 'W2', 'W3']) assert.deepEqual([byUid[code].po, byUid[code].receivedDate, byUid[code].sku], [PO_A, '05/07/2026', '900000001'], code);
        assert.deepEqual([byUid['TEST-READY'].po, byUid['TEST-READY'].receivedDate], ['PO-MANUAL-02', '05/07/2026']);

        // 4) Đọc hai PO cùng lúc: SKU nằm ở cả hai PO thì PO để trống (không đoán), SKU chỉ ở một PO mang PO đó
        for (const code of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']) await add(code);
        await pending(7);
        await page.locator('#uid-tab-po').click();
        await page.locator('#uid-po-input').fill(`${PO_A} ${PO_B}`);
        await page.locator('#uid-po-go').click();
        await page.waitForFunction(() => document.querySelectorAll('#uid-po-rows .uid-auto__row').length === 2);
        await page.locator('#uid-po-apply').click();
        await ready(7);
        await page.locator('#uid-print-all').click();
        await page.waitForFunction(() => window.testJobs.length === 4);
        items = await page.evaluate(() => window.testJobs[3].payload.items);
        const skuPo = new Map(items.map(item => [item.sku, new Set()]));
        items.forEach(item => skuPo.get(item.sku).add(item.po));
        assert.deepEqual([...skuPo.get('900000001')], [PO_A], 'SKU chỉ ở PO A mang PO A');
        assert.deepEqual([...skuPo.get('900000002')], [''], 'SKU nằm ở hai PO thì PO để trống');
        assert.ok(items.every(item => item.receivedDate === ''));
      }

      // 5) PO sai mẫu hoặc quá 20 ký tự: dừng và báo, không cắt, không gửi, giữ nguyên ô; đúng 20 ký tự thì in được
      await add('TEST-READY'); await ready(1);
      const jobsBefore = await page.evaluate(() => window.testJobs.length);
      for (const bad of ['9'.repeat(21), 'PO@123', 'Đơn 1']) {
        await page.locator('#uid-print-po').fill(bad);
        await page.locator('#uid-print-all').click();
        await page.waitForFunction(() => /Số PO chỉ gồm/.test(document.querySelector('#uid-status').textContent));
        assert.equal(await page.locator('#uid-print-po').inputValue(), bad, 'không cắt, không xóa ô');
        assert.equal(await page.evaluate(() => window.testJobs.length), jobsBefore, `PO "${bad}" không được gửi`);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'uid-print-po', 'đưa con trỏ về ô PO');
        await page.evaluate(() => { document.querySelector('#uid-status').textContent = ''; });
      }
      await page.locator('#uid-print-po').fill(' ' + '9'.repeat(20) + ' ');
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(count => window.testJobs.length === count + 1, jobsBefore);
      assert.equal(await page.evaluate(() => window.testJobs.at(-1).payload.items[0].po), '9'.repeat(20), 'cắt hai đầu rồi in đủ 20 ký tự');
      await ready(0);

      // 5b) Ngày nhận gõ năm hai chữ số (năm 0026) hoặc ngoài khoảng cho phép: dừng và báo, không gửi
      await add('TEST-READY'); await ready(1);
      const jobsBeforeDate = await page.evaluate(() => window.testJobs.length);
      await page.locator('#uid-print-po').fill('');
      await page.locator('#uid-print-date').evaluate(el => { el.value = '0026-06-15'; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => /Ngày nhận chưa hợp lệ/.test(document.querySelector('#uid-status').textContent));
      assert.equal(await page.evaluate(() => window.testJobs.length), jobsBeforeDate, 'năm 0026 không được gửi');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'uid-print-date');
      await page.locator('#uid-print-date').evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(count => window.testJobs.length === count + 1, jobsBeforeDate);
      await ready(0);

      // 6) Trong lúc gửi hai ô bị khóa (không đổi nội dung giữa chừng), gửi xong mở lại và xóa
      await add('TEST-READY'); await ready(1);
      await page.locator('#uid-print-po').fill('PO-LOCK');
      await page.evaluate(() => { window.delayMs = 600; });
      const countBeforeLock = await page.evaluate(() => window.testJobs.length);
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => document.getElementById('uid-print-po').disabled);
      assert.equal(await page.locator('#uid-print-date').isDisabled(), true);
      await page.waitForFunction(count => window.testJobs.length === count + 1, countBeforeLock);
      await page.waitForFunction(() => !document.getElementById('uid-print-po').disabled);
      assert.equal(await page.locator('#uid-print-po').inputValue(), '');
      await page.evaluate(() => { window.delayMs = 0; });

      // 7) Gửi lỗi rồi thử lại: cùng nội dung dùng lại nonce (máy chủ không in trùng); sửa PO thì nonce mới (không nhận lại lệnh cũ có PO cũ)
      await add('TEST-READY'); await ready(1);
      await page.locator('#uid-print-po').fill('PO-A');
      await page.evaluate(() => { window.failNext = 2; window.testNonces = []; });
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => window.testNonces.length === 1);
      await page.waitForFunction(() => !document.getElementById('uid-print-po').disabled);
      assert.equal(await page.locator('#uid-print-po').inputValue(), 'PO-A', 'lỗi gửi thì giữ nguyên ô để thử lại');
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => window.testNonces.length === 2);
      await page.waitForFunction(() => !document.getElementById('uid-print-po').disabled);
      await page.locator('#uid-print-po').fill('PO-B');
      await page.locator('#uid-print-all').click();
      await page.waitForFunction(() => window.testNonces.length === 3);
      const nonces = await page.evaluate(() => window.testNonces);
      assert.equal(nonces[0], nonces[1], 'cùng nội dung → cùng nonce');
      assert.notEqual(nonces[1], nonces[2], 'đổi PO → nonce mới');
      await ready(0);

      await page.locator('#uid-print-po').fill('10000000000001');
      await page.locator('#uid-print-date').fill('2026-06-15');
      await add('TEST-READY'); await ready(1);
      await page.locator('#uid-print-all').scrollIntoViewIfNeeded();
      if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}-${width}.png` });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: ô PO + ngày nhận (nhập tay, ${width > 800 ? 'PO từ Gán WMS, nhiều PO, ' : ''}xóa sau khi gửi, giới hạn 20 ký tự, không tràn ngang)`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
