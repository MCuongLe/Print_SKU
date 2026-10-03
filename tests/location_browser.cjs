// MÃ VỊ TRÍ (#location): kiểm tra giao diện local. Mọi kết nối ra ngoài bị giả lập — không
// ghi Supabase thật, không in thật. File Excel tạo ngay trong test bằng dữ liệu giả.
// Chạy khi có server: python -m http.server 8000
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

// .xlsx tối thiểu (zip không nén). rows: mảng hàng, mỗi ô là chuỗi hoặc { formula, value } như cột Code của template WMS.
const xlsx = rows => {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const col = i => String.fromCharCode(65 + i);
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => {
    const ref = `${col(c)}${r + 1}`;
    if (cell && typeof cell === 'object') return `<c r="${ref}" t="str"><f>${esc(cell.formula)}</f><v>${esc(cell.value)}</v></c>`;
    return cell === '' ? '' : `<c r="${ref}" t="inlineStr"><is><t>${esc(cell)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml': '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Template import" sheetId="1" r:id="rId7"/><sheet name="Khác" sheetId="2" r:id="rId8"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId8" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/sheet2.xml"/></Relationships>',
    // sheet1.xml là sheet THỨ HAI trong workbook: đọc phải theo thứ tự workbook, không theo tên file.
    'xl/worksheets/sheet1.xml': '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Code</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>SAI-SHEET</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), nameBytes = Buffer.from(name, 'utf8'), crc = zlib.crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
};
const HEAD = ['Warehouse Code', 'Floor', 'Area', 'Aisle', 'Rack', 'Shelf', 'Bin', 'Code', 'Type', 'Purpose Type', 'Storage Type', 'Floor Description', 'Area Description', 'Aisle Description', 'Rack Description', 'Shelf Description', 'Bin Description', 'Bin Location Description'];
const wmsRow = (parts, name, cached = parts.join('-')) => ['9999', ...parts, { formula: 'B2&"-"&C2&"-"&D2&"-"&E2&"-"&F2&"-"&G2', value: cached }, '1', 'Lưu trữ (ST)', 'Hàng lẻ', '', '', '', '', '', '', name];
const WMS_FILE = xlsx([
  HEAD,
  wmsRow(['Z9', 'TEST', 'AA', '01', '01', '01'], 'Kệ thử 01'),
  wmsRow(['Z9', 'TEST', 'AA', '01', '01', '02'], 'Mô tả mã vị trí'),          // chữ mẫu của template → coi như không tên
  wmsRow(['Z9', 'TEST', 'AA', '01', '01', '01'], 'Trùng mã'),                 // trùng dòng 2
  wmsRow(['Z9', 'TÊST', 'AA', '01', '01', '03'], 'Mã có dấu'),               // sai mã → bỏ, báo số dòng
  wmsRow(['', '', '', '', '', ''], '', '-----'),                              // dòng công thức trống → bỏ qua im lặng
  wmsRow(['Z9', 'TEST', 'AA', '01', '01', '04'], 'Kệ thử 04', ''),           // Code chưa tính → ghép từ Floor…Bin
]);
const SIMPLE_FILE = xlsx([
  ['Lầu', 'Khu vực', 'Dãy', 'Kệ', 'Mâm', 'Ô', 'Location', 'Description'],
  ['Z8', 'B1', '401', '01', '01', '01', 'Z8-B1-401-01-01-01', 'Phòng thử - Dãy 401 - ô số 01'],
  ['Z8', 'B1', '401', '01', '01', '02', 'Z8-B1-401-01-01-02', 'Phòng thử - Dãy 401 - ô số 02'],
]);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      const state = { capabilities: ['sku:v1', 'group_uid:v1'], failOnce: true, jobs: [], status: 'queued' };
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', dialog => dialog.accept());
      await page.route('**/*', async route => {
        const request = route.request(), url = request.url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        const rpc = url.split('/rpc/')[1] || '';
        const body = request.postDataJSON?.() || {};
        let result = { ok: true, data: {} };
        if (rpc === 'print_queue_status') result = { ok: true, data: { agents: [{ id: 'test-agent', capabilities: state.capabilities, lastSeenAt: new Date().toISOString() }] } };
        else if (rpc === 'print_enqueue') {
          state.jobs.push(body);
          if (state.failOnce && state.jobs.length === 2) { state.failOnce = false; return route.abort('failed'); }
          result = { ok: true, data: { id: `job-${state.jobs.length}`, status: 'queued', duplicate: false } };
        } else if (rpc === 'print_job_status') {
          // job-1 in lỗi ở agent khi state.status = 'failed'; mọi lệnh khác theo state.status (failed → coi như xong).
          const status = state.status === 'failed' ? (body.p_job_id === 'job-1' ? 'failed' : 'completed') : state.status;
          result = { ok: true, data: { id: body.p_job_id, status, errorMessage: status === 'failed' ? 'Hết giấy' : null } };
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      });
      const waitMessage = text => page.waitForFunction(t => document.querySelector('#loc-message').textContent.includes(t), text);
      const rows = () => page.locator('#loc-list .loc-row');
      const codes = () => page.locator('#loc-list .loc-row strong').allTextContents();

      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-location').click();
      await page.locator('#location-screen').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.activeElement.id === 'loc-code');
      assert.equal(await page.locator('#loc-preview').count(), 0, 'không còn xem trước');
      assert.equal(await page.locator('#loc-empty').isVisible(), true);
      assert.equal(await page.locator('#loc-printbar').isVisible(), false);

      // Nhập tay: mã sai bị chặn; Enter ở ô mã (máy quét) chỉ chuyển sang ô tên.
      await page.locator('#loc-code').fill('ô01#');
      assert.match(await page.locator('#loc-code-hint').textContent(), /Mã chỉ gồm/);
      await page.locator('#loc-add').click();
      assert.equal(await rows().count(), 0);
      await page.locator('#loc-code').fill('z99-t01-001-01-01-01');
      await page.locator('#loc-code').press('Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'loc-name');
      assert.equal(await rows().count(), 0);
      // Mã chữ thường → chữ hoa, tên gộp khoảng trắng, Enter ở ô tên thêm vào hàng đợi.
      await page.locator('#loc-name').fill('  Khu vực   kiểm thử ');
      await page.locator('#loc-form [data-step="1"]').click();
      await page.locator('#loc-name').press('Enter');
      await waitMessage('Đã thêm Z99-T01-001-01-01-01 · 2 tem');
      assert.deepEqual(await codes(), ['Z99-T01-001-01-01-01']);
      assert.match(await rows().first().innerText(), /Khu vực kiểm thử/);
      assert.equal(await page.locator('#loc-code').inputValue(), '');
      // Thêm lại cùng mã → cập nhật, không thêm dòng trùng.
      await page.locator('#loc-code').fill('Z99-T01-001-01-01-01');
      await page.locator('#loc-name').fill('Tên mới');
      await page.locator('#loc-add').click();
      await waitMessage('Đã cập nhật Z99-T01-001-01-01-01');
      assert.equal(await rows().count(), 1);
      assert.match(await rows().first().innerText(), /Tên mới/);

      // Nhập Excel template WMS: sheet đầu theo workbook, cột Code (công thức), bỏ chữ mẫu, trùng, mã sai, dòng trống.
      await page.locator('#loc-copies').fill('1');
      await page.locator('#loc-file').setInputFiles({ name: 'template_thu.xlsx', mimeType: XLSX_TYPE, buffer: WMS_FILE });
      await waitMessage('template_thu.xlsx: thêm 3 vị trí · 1 tem/vị trí');
      assert.match(await page.locator('#loc-message').textContent(), /bỏ 1 mã trùng · bỏ 1 dòng sai \(dòng 5\)/);
      assert.deepEqual(await codes(), ['Z99-T01-001-01-01-01', 'Z9-TEST-AA-01-01-01', 'Z9-TEST-AA-01-01-02', 'Z9-TEST-AA-01-01-04']);
      assert.match(await rows().nth(2).innerText(), /—/, 'chữ mẫu "Mô tả mã vị trí" không in lên tem');
      // Dạng Location / Description; số tem lấy theo ô Số tem.
      await page.locator('#loc-copies').fill('300');
      await page.locator('#loc-file').setInputFiles({ name: 'phong_thu.xlsx', mimeType: XLSX_TYPE, buffer: SIMPLE_FILE });
      await waitMessage('phong_thu.xlsx: thêm 2 vị trí · 300 tem/vị trí');
      assert.equal(await rows().count(), 6);
      await page.locator('#loc-file').setInputFiles({ name: 'sai.xlsx', mimeType: 'text/plain', buffer: Buffer.from('không phải excel') });
      await waitMessage('Không đọc được sai.xlsx: chỉ đọc được file .xlsx');

      // Sửa số tem, bỏ chọn, xoá dòng.
      await rows().nth(1).locator('[data-act="copies"]').fill('3');
      await rows().nth(1).locator('[data-act="copies"]').dispatchEvent('change');
      await rows().nth(3).locator('[data-act="pick"]').uncheck();
      assert.equal(await page.locator('#loc-sum').textContent(), '5 vị trí · 606 tem');
      await rows().nth(3).locator('[data-act="remove"]').click();
      assert.equal(await rows().count(), 5);
      assert.equal(await page.locator('#loc-sum').textContent(), '5 vị trí · 606 tem');

      // Hàng đợi lưu trên máy: còn sau khi tải lại trang.
      await page.reload();
      await page.locator('#location-screen').waitFor({ state: 'visible' });
      assert.equal(await rows().count(), 5);

      // Agent cũ / thiếu name-optional → không gửi lệnh nào.
      await page.locator('#loc-print').click();
      await waitMessage('chưa hỗ trợ tem vị trí');
      assert.equal(state.jobs.length, 0);
      state.capabilities = ['sku:v1', 'location:v1'];
      await page.locator('#loc-print').click();
      await waitMessage('Tem không tên cần agent 0.8.8');
      assert.equal(state.jobs.length, 0);
      state.capabilities.push('location:name-optional');

      // 2 + 3 + 1 + 300 + 300 = 606 tem > 500/lệnh nên tự chia 2 lệnh (306 + 300).
      // Lệnh thứ 2 lỗi mạng lần đầu: bấm lại chỉ gửi phần còn lại, dùng đúng nonce cũ.
      await page.locator('#loc-print').click();
      await waitMessage('Đã gửi 306 tem; chưa gửi được phần còn lại');
      await page.locator('#loc-print').click();
      await waitMessage('Đã gửi 300 tem · 1 vị trí');
      assert.equal(state.jobs.length, 3);
      assert.ok(state.jobs.every(job => job.p_type === 'location' && job.p_template_version === 1 && job.p_copies <= 500 && job.p_requested_by === 'web-location'));
      assert.equal(state.jobs[1].p_nonce, state.jobs[2].p_nonce, 'gửi lại dùng cùng nonce');
      assert.notEqual(state.jobs[0].p_nonce, state.jobs[1].p_nonce);
      assert.deepEqual(state.jobs[0].p_payload.items.map(item => [item.code, item.copies]), [['Z99-T01-001-01-01-01', 2], ['Z9-TEST-AA-01-01-01', 3], ['Z9-TEST-AA-01-01-02', 1], ['Z8-B1-401-01-01-01', 300]]);
      assert.deepEqual(state.jobs[0].p_payload.items[0], { code: 'Z99-T01-001-01-01-01', name: 'Tên mới', copies: 2 });
      assert.deepEqual(state.jobs[2].p_payload.items, [{ code: 'Z8-B1-401-01-01-02', name: 'Phòng thử - Dãy 401 - ô số 02', copies: 300 }]);
      assert.equal(await page.locator('#loc-list .loc-row[data-status="queued"]').count(), 5);
      assert.equal(await page.locator('#loc-list .loc-row[data-status="queued"] [data-act="remove"]:disabled').count(), 5);

      // job-1 lỗi ở agent → 4 dòng của nó thành "In lỗi", chọn lại được; lệnh còn lại xong → rời hàng đợi.
      state.status = 'failed';
      await page.waitForFunction(() => document.querySelectorAll('#loc-list .loc-row[data-status="failed"]').length === 4 && !document.querySelector('#loc-list .loc-row[data-status="queued"]'));
      assert.equal(await rows().count(), 4);
      assert.equal(await page.locator('#loc-list .loc-row[data-status="failed"] [data-act="pick"]:not(:disabled)').count(), 4);
      assert.match(await rows().first().innerText(), /In lỗi: Hết giấy/);

      assert.equal(await page.evaluate(() => document.querySelector('#location-screen').scrollWidth <= innerWidth), true);
      await page.locator('#loc-back').click();
      await page.locator('#barcode-home').waitFor({ state: 'visible' });
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: nhập tay + Excel (template WMS, Location/Description), hàng đợi lưu trên máy, chia lệnh ≤500 tem, nonce gửi lại, chặn agent cũ, lỗi/xong theo lệnh`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
