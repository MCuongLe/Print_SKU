// MÃ VỊ TRÍ (#location): kiểm tra giao diện local. Mọi kết nối ra ngoài bị giả lập — không
// ghi Supabase thật, không in thật. Chạy khi có server: python -m http.server 8000
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

// Bỏ dấu giống public.warehouse_location_fold để giả lập tìm kiếm phía server.
const fold = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      const store = new Map();
      const calls = [];
      const state = { capable: false, enqueueFailOnce: true, jobs: [] };
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.route('**/*', async route => {
        const request = route.request(), url = request.url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        const rpc = url.split('/rpc/')[1] || '';
        const body = request.postDataJSON?.() || {};
        calls.push(rpc);
        let result = { ok: true, data: {} };
        if (rpc === 'warehouse_location_search') {
          const query = fold(body.p_query).trim();
          const exact = String(body.p_query || '').trim().toUpperCase();
          const all = [...store.values()].filter(x => !x.archived);
          const matched = all.filter(x => !query || fold(x.code).includes(query) || fold(x.name).includes(query))
            .sort((a, b) => (b.code === exact) - (a.code === exact) || a.code.localeCompare(b.code));
          result = { ok: true, data: { items: matched.slice(0, body.p_limit).map(({ archived, ...x }) => x), matched: matched.length, total: all.length } };
        } else if (rpc === 'warehouse_location_upsert') {
          let created = 0, updated = 0;
          for (const { code, name } of body.p_items) {
            const old = store.get(code);
            if (!old) created++; else if (old.name !== name || old.archived) updated++;
            store.set(code, { code, name, printCount: old?.printCount || 0, lastPrintedAt: old?.lastPrintedAt || null });
          }
          result = { ok: true, data: { created, updated, unchanged: body.p_items.length - created - updated, codes: body.p_items.map(x => x.code) } };
        } else if (rpc === 'warehouse_location_archive') {
          store.get(body.p_code).archived = true;
          result = { ok: true, data: { code: body.p_code } };
        } else if (rpc === 'print_queue_status') {
          result = { ok: true, data: { agents: [{ id: 'test-agent', capabilities: state.capable ? ['sku:v1', 'location:v1'] : ['sku:v1', 'group_uid:v1'], lastSeenAt: new Date().toISOString() }] } };
        } else if (rpc === 'print_enqueue') {
          state.jobs.push(body);
          if (state.enqueueFailOnce) { state.enqueueFailOnce = false; return route.abort('failed'); }
          result = { ok: true, data: { id: '11111111-1111-4111-8111-111111111111', status: 'queued', duplicate: false } };
        } else if (rpc === 'print_job_status') {
          for (const item of state.jobs.at(-1).p_payload.items) Object.assign(store.get(item.code), { printCount: (store.get(item.code).printCount || 0) + item.copies, lastPrintedAt: new Date().toISOString() });
          result = { ok: true, data: { id: body.p_job_id, status: 'completed' } };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      });

      const message = () => page.locator('#loc-message').textContent();
      const waitMessage = text => page.waitForFunction(t => document.querySelector('#loc-message').textContent.includes(t), text);

      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-location').click();
      assert.equal(page.url().endsWith('#location'), true);
      await page.locator('#location-screen').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#barcode-home').isVisible(), false);
      await page.waitForFunction(() => document.querySelector('#loc-rows').textContent.includes('Chưa có vị trí nào'));

      // Mã gõ chữ thường được chuẩn hoá chữ hoa; xem trước có QR thật (ZXing) và mã.
      await page.locator('#loc-code').fill('z99-t01-001-01-01-01');
      await page.waitForFunction(() => document.querySelector('#loc-code-hint').textContent.includes('Mã mới'));
      assert.ok(await page.locator('#loc-preview rect').count() > 50, 'xem trước phải có QR');
      assert.match(await page.locator('#loc-preview').textContent(), /Z99-T01-001-01-01-01/);
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

      // Đo chữ trên tem: báo vừa tem/đủ ký tự; tên quá dài thì cảnh báo chữ nhỏ nhưng vẫn đủ ký tự.
      await page.locator('#loc-name').fill('Khu vực kiểm thử');
      assert.match(await page.locator('#loc-fit-hint').textContent(), /Vừa tem, đủ ký tự/);
      await page.locator('#loc-name').fill('W'.repeat(60));
      assert.match(await page.locator('#loc-fit-hint').textContent(), /Vừa tem, đủ ký tự: mã cỡ 44, tên 5 dòng cỡ 20/);
      assert.equal((await page.locator('#loc-preview text').allTextContents()).slice(1).join(''), 'W'.repeat(60));
      await page.locator('#loc-code').fill('W'.repeat(40));
      assert.match(await page.locator('#loc-fit-hint').textContent(), /Mã dài: chữ mã bị ép còn \d+% bề ngang\. Tem vẫn in đủ ký tự/);
      assert.equal(await page.locator('#loc-preview text').first().textContent(), 'W'.repeat(40));
      await page.locator('#loc-code').fill('z99-t01-001-01-01-01');
      assert.equal(await page.locator('#loc-preview text[font-family="Arial,Helvetica,sans-serif"]').count(), await page.locator('#loc-preview text').count());
      await page.locator('#loc-name').fill('');

      // Chặn mã có dấu / ký tự lạ, không gọi Supabase.
      const upsertsBefore = calls.filter(x => x === 'warehouse_location_upsert').length;
      await page.locator('#loc-code').fill('Ô01#');
      await page.locator('#loc-name').fill('Kệ lỗi');
      await page.locator('#loc-save').click();
      assert.match(await message(), /Mã chỉ gồm/);
      assert.equal(calls.filter(x => x === 'warehouse_location_upsert').length, upsertsBefore);

      // Lưu mới → vào danh sách và tự chọn để in.
      await page.locator('#loc-code').fill('z99-t01-001-01-01-01');
      await page.locator('#loc-code').press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'loc-name');
      await page.locator('#loc-name').fill('  Khu vực   kiểm thử ');
      await page.locator('#loc-name').press('Enter');
      await waitMessage('Đã lưu vị trí mới Z99-T01-001-01-01-01');
      assert.deepEqual(store.get('Z99-T01-001-01-01-01').name, 'Khu vực kiểm thử');
      await page.waitForFunction(() => document.querySelector('#loc-total').textContent === '1');
      assert.equal(await page.locator('#loc-selected').textContent(), 'Đã chọn 1');
      assert.equal(await page.locator('#loc-code').inputValue(), '');

      // Gõ lại mã đã có → báo trước, tự điền tên cũ, nút đổi thành Cập nhật tên.
      await page.locator('#loc-code').fill('Z99-T01-001-01-01-01');
      await page.waitForFunction(() => document.querySelector('#loc-code-hint').textContent.includes('Mã đã có'));
      assert.equal(await page.locator('#loc-name').inputValue(), 'Khu vực kiểm thử');
      assert.equal(await page.locator('#loc-save').textContent(), 'Cập nhật tên');
      await page.locator('#loc-code').fill('');

      // Dán từ Excel: bỏ dòng tiêu đề, báo trùng mã, rồi lưu cả lô.
      await page.locator('#loc-bulk-box summary').click();
      await page.locator('#loc-bulk').fill('Mã vị trí\tTên vị trí\nZ99-T02-001\tKệ thử 1\nz99-t02-002\tKệ thử 2\nZ99-T02-001\tTrùng');
      assert.match(await page.locator('#loc-bulk-hint').textContent(), /trùng dòng 2/);
      assert.equal(await page.locator('#loc-bulk-save').isDisabled(), true);
      await page.locator('#loc-bulk').fill('Mã vị trí\tTên vị trí\nZ99-T02-001\tKệ thử 1\t\nz99-t02-002 Kệ thử 2\nZ99-T01-001-01-01-01\tKhu vực kiểm thử');
      assert.match(await page.locator('#loc-bulk-hint').textContent(), /3 vị trí hợp lệ/);
      await page.locator('#loc-bulk-save').click();
      await waitMessage('Đã lưu 3 vị trí: 2 mới, 0 cập nhật tên, 1 không đổi');
      await page.waitForFunction(() => document.querySelector('#loc-total').textContent === '3');
      assert.equal(store.get('Z99-T02-002').name, 'Kệ thử 2');
      assert.equal(await page.locator('#loc-selected').textContent(), 'Đã chọn 3');

      // Tìm không dấu.
      await page.locator('#loc-search').fill('ke thu 2');
      await page.waitForFunction(() => document.querySelectorAll('#loc-rows tr[data-code]').length === 1);
      assert.equal(await page.locator('#loc-rows tr[data-code]').getAttribute('data-code'), 'Z99-T02-002');
      await page.locator('#loc-search').fill('');
      await page.waitForFunction(() => document.querySelectorAll('#loc-rows tr[data-code]').length === 3);

      // Agent chưa có location:v1 → không gửi lệnh.
      await page.locator('#loc-copies').fill('2');
      assert.equal(await page.locator('#loc-print').textContent(), 'In 6 tem');
      await page.locator('#loc-print').click();
      await waitMessage('chưa hỗ trợ tem vị trí');
      assert.equal(state.jobs.length, 0);

      // Lỗi mạng lần đầu → bấm lại dùng cùng nonce; payload đúng loại tem location.
      state.capable = true;
      await page.locator('#loc-print').click();
      await waitMessage('Chưa xác nhận được lệnh in');
      await page.locator('#loc-print').click();
      await waitMessage('Agent đã in xong');
      assert.equal(state.jobs.length, 2);
      assert.equal(state.jobs[0].p_nonce, state.jobs[1].p_nonce);
      const job = state.jobs[1];
      assert.equal(job.p_type, 'location');
      assert.equal(job.p_template_version, 1);
      assert.equal(job.p_copies, 6);
      assert.equal(job.p_requested_by, 'web-location');
      assert.deepEqual(job.p_payload.items.map(x => [x.code, x.copies]), [['Z99-T01-001-01-01-01', 2], ['Z99-T02-001', 2], ['Z99-T02-002', 2]]);
      assert.equal(await page.locator('#loc-selected').textContent(), 'Đã chọn 0');
      await page.waitForFunction(() => document.querySelector('#loc-rows').textContent.includes('2 tem'));

      // Sửa: nạp vào form; Xoá: ẩn khỏi danh sách.
      await page.locator('#loc-rows tr[data-code="Z99-T02-001"] [data-act="edit"]').click();
      assert.equal(await page.locator('#loc-code').inputValue(), 'Z99-T02-001');
      assert.equal(await page.locator('#loc-save').textContent(), 'Cập nhật tên');
      await page.locator('#loc-rows tr[data-code="Z99-T02-002"] [data-act="archive"]').click();
      await waitMessage('Đã xoá Z99-T02-002');
      await page.waitForFunction(() => document.querySelector('#loc-total').textContent === '2');

      // Không tràn ngang; quay về trang chủ.
      assert.equal(await page.evaluate(() => document.querySelector('#location-screen').scrollWidth <= innerWidth), true);
      await page.locator('#loc-back').click();
      await page.locator('#barcode-home').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#location-screen').isVisible(), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: lưu/cập nhật/xoá vị trí, dán Excel, tìm không dấu, QR xem trước đúng ma trận, đo chữ Arial đủ ký tự, chặn agent cũ, nonce gửi lại, payload location`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
