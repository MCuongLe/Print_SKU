// MÃ VỊ TRÍ (#location): kiểm tra giao diện local. Mọi kết nối ra ngoài bị giả lập — không
// ghi Supabase thật, không in thật. Chạy khi có server: python -m http.server 8000
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      const calls = [];
      const state = { capabilities: ['sku:v1', 'group_uid:v1'], enqueueFailOnce: true, jobs: [] };
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async route => {
        const request = route.request(), url = request.url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        const rpc = url.split('/rpc/')[1] || '';
        const body = request.postDataJSON?.() || {};
        calls.push(rpc);
        let result = { ok: true, data: {} };
        if (rpc === 'print_queue_status') {
          result = { ok: true, data: { agents: [{ id: 'test-agent', capabilities: state.capabilities, lastSeenAt: new Date().toISOString() }] } };
        } else if (rpc === 'print_enqueue') {
          state.jobs.push(body);
          if (state.enqueueFailOnce) { state.enqueueFailOnce = false; return route.abort('failed'); }
          result = { ok: true, data: { id: `job-${state.jobs.length}`, status: 'queued', duplicate: false } };
        } else if (rpc === 'print_job_status') {
          result = { ok: true, data: { id: body.p_job_id, status: 'completed' } };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      });

      const message = () => page.locator('#loc-message').textContent();
      const waitMessage = text => page.waitForFunction(t => document.querySelector('#loc-message').textContent.includes(t), text);
      const previewTexts = () => page.locator('#loc-preview text').allTextContents();

      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-location').click();
      assert.equal(page.url().endsWith('#location'), true);
      await page.locator('#location-screen').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#barcode-home').isVisible(), false);
      // Không còn danh mục: không danh sách, không dán Excel, không gọi hàm lưu/tìm vị trí nào.
      for (const id of ['#loc-rows', '#loc-bulk', '#loc-search', '#loc-save']) assert.equal(await page.locator(id).count(), 0, id);
      await page.waitForFunction(() => document.activeElement.id === 'loc-code');

      // Mã gõ chữ thường được chuẩn hoá chữ hoa; xem trước có QR thật và mã, font Arial.
      await page.locator('#loc-code').fill('z99-t01-001-01-01-01');
      assert.ok(await page.locator('#loc-preview rect').count() > 50, 'xem trước phải có QR');
      assert.equal((await previewTexts())[0], 'Z99-T01-001-01-01-01');
      assert.equal(await page.locator('#loc-preview text[font-family="Arial,Helvetica,sans-serif"]').count(), await page.locator('#loc-preview text').count());
      // QR xem trước: khung đúng như agent in cho mã này (version 1 = 21 module × 10 dot = 210 dot,
      // qrcode-generator chế độ chữ-số mức M) và vẽ đúng từng ô ma trận của bộ mã hoá. Không đối
      // chiếu bằng bộ ĐỌC ZXing 0.21.3: nó không đọc được một số QR hợp lệ (đúng chuỗi này ở mức M —
      // đã so khớp với thư viện segno, ma trận giống hệt), còn bộ MÃ HOÁ thì đúng.
      const mismatches = await page.evaluate(() => {
        const zx = window.PrintSkuScanner.zxing(), M = zx.QRCodeDecoderErrorCorrectionLevel.M;
        let matrix;
        try { matrix = zx.QRCodeEncoder.encode('Z99-T01-001-01-01-01', M, new Map([[zx.EncodeHintType.QR_VERSION, 1]])).getMatrix(); }
        catch (_) { matrix = zx.QRCodeEncoder.encode('Z99-T01-001-01-01-01', M).getMatrix(); }
        const n = matrix.getWidth(), rects = [...document.querySelectorAll('#loc-preview g rect')].map(r => ['x', 'y', 'width', 'height'].map(k => +r.getAttribute(k)));
        const x0 = Math.min(...rects.map(r => r[0])), y0 = Math.min(...rects.map(r => r[1]));
        const outer = Math.max(...rects.map(r => r[0] + r[2])) - x0, module = outer / n;
        const drawn = new Set();
        for (const [x, y, w] of rects) for (let k = 0; k < Math.round(w / module); k++) drawn.add(`${Math.round((x - x0) / module) + k},${Math.round((y - y0) / module)}`);
        let bad = Math.abs(outer - 210) < 0.5 && y0 === 40 ? 0 : 1000;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((matrix.get(x, y) === 1) !== drawn.has(`${x},${y}`)) bad++;
        return bad;
      });
      assert.equal(mismatches, 0);

      // Đo chữ: tên dài vẫn đủ ký tự; mã dài bị ép ngang thì báo ngắn.
      await page.locator('#loc-name').fill('W'.repeat(60));
      assert.equal((await previewTexts()).slice(1).join(''), 'W'.repeat(60));
      assert.equal(await page.locator('#loc-fit-hint').textContent(), '');
      await page.locator('#loc-code').fill('W'.repeat(40));
      assert.match(await page.locator('#loc-fit-hint').textContent(), /^Mã ép ngang \d+%$/);
      assert.equal((await previewTexts())[0], 'W'.repeat(40));

      // Mã có dấu / ký tự lạ: báo lỗi ngay, bấm In không gửi gì.
      await page.locator('#loc-code').fill('Ô01#');
      assert.match(await page.locator('#loc-code-hint').textContent(), /Mã chỉ gồm/);
      await page.locator('#loc-print').click();
      assert.match(await message(), /Mã chỉ gồm/);
      assert.equal(state.jobs.length, 0);

      // Enter ở ô mã (máy quét) chuyển sang ô tên, không in.
      await page.locator('#loc-code').fill('z99-t01-001-01-01-01');
      await page.locator('#loc-code').press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'loc-name');
      assert.equal(state.jobs.length, 0);

      // Số tem: nút ± và nhãn nút In.
      await page.locator('#loc-name').fill('  Khu vực   kiểm thử ');
      await page.locator('#loc-form [data-step="1"]').click();
      assert.equal(await page.locator('#loc-copies').inputValue(), '2');
      assert.equal(await page.locator('#loc-print').textContent(), 'In 2 tem');
      await page.locator('#loc-form [data-step="-1"]').click();
      await page.locator('#loc-form [data-step="-1"]').click();
      assert.equal(await page.locator('#loc-copies').inputValue(), '1');
      await page.locator('#loc-copies').fill('2');

      // Agent chưa có location:v1 → không gửi lệnh.
      await page.locator('#loc-print').click();
      await waitMessage('chưa hỗ trợ tem vị trí');
      assert.equal(state.jobs.length, 0);

      // Lỗi mạng lần đầu → bấm lại dùng cùng nonce; payload đúng loại tem location, tên đã chuẩn hoá.
      state.capabilities = ['sku:v1', 'location:v1'];
      await page.locator('#loc-print').click();
      await waitMessage('Chưa xác nhận được lệnh in');
      await page.locator('#loc-name').press('Enter');
      await waitMessage('Agent đã in xong');
      assert.equal(state.jobs.length, 2);
      assert.equal(state.jobs[0].p_nonce, state.jobs[1].p_nonce);
      const job = state.jobs[1];
      assert.equal(job.p_type, 'location');
      assert.equal(job.p_template_version, 1);
      assert.equal(job.p_copies, 2);
      assert.equal(job.p_requested_by, 'web-location');
      assert.deepEqual(job.p_payload, { items: [{ code: 'Z99-T01-001-01-01-01', name: 'Khu vực kiểm thử', copies: 2 }] });
      // Sau khi gửi: giữ nội dung, bôi đen mã để quét vị trí kế tiếp.
      assert.equal(await page.locator('#loc-code').inputValue(), 'z99-t01-001-01-01-01');
      assert.equal(await page.evaluate(() => document.activeElement.id === 'loc-code' && document.activeElement.selectionEnd - document.activeElement.selectionStart), 20);

      // In lại cùng nội dung sau khi đã gửi thành công = lệnh mới (nonce mới).
      await page.locator('#loc-print').click();
      await waitMessage('job-3');
      assert.notEqual(state.jobs[2].p_nonce, state.jobs[1].p_nonce);

      // Tem không tên: cần agent có location:name-optional.
      await page.locator('#loc-name').fill('');
      await page.locator('#loc-print').click();
      await waitMessage('Tem không tên cần agent 0.8.8');
      assert.equal(state.jobs.length, 3);
      state.capabilities.push('location:name-optional');
      await page.locator('#loc-print').click();
      await waitMessage('job-4');
      assert.deepEqual(state.jobs[3].p_payload.items[0], { code: 'Z99-T01-001-01-01-01', name: '', copies: 2 });
      assert.equal((await previewTexts()).length, 1, 'tem không tên chỉ có mã');

      // Chỉ gọi hàng đợi in, không gọi RPC nào khác.
      assert.deepEqual([...new Set(calls)].sort(), ['print_enqueue', 'print_job_status', 'print_queue_status']);

      // Không tràn ngang; quay về trang chủ.
      assert.equal(await page.evaluate(() => document.querySelector('#location-screen').scrollWidth <= innerWidth), true);
      await page.locator('#loc-back').click();
      await page.locator('#barcode-home').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#location-screen').isVisible(), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: một vị trí → xem trước → in, không danh mục, QR đúng ma trận, đo chữ Arial đủ ký tự, chặn agent cũ/tem không tên, nonce gửi lại`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
