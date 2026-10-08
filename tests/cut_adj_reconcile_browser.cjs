// Doi chieu ADJ (tab 4 cua #cut-group-uid). Run against python -m http.server 8000 --bind 127.0.0.1.
// External requests are intercepted; file zip/xlsx "Group UID History" duoc dung gia lap trong test (du lieu tong hop).
//   PLAYWRIGHT_MODULE=<duong dan playwright> node tests/cut_adj_reconcile_browser.cjs
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const zlib = require('node:zlib');

// ---- Dung file zip/xlsx gia lap (khong phu thuoc thu vien) ----
const crcTable = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
const crc32 = buffer => { let c = 0xFFFFFFFF; for (const byte of buffer) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const buildZip = files => {
  const chunks = [], central = []; let offset = 0;
  for (const { name, data, deflate } of files) {
    const nameBytes = Buffer.from(name), raw = Buffer.from(data), body = deflate ? zlib.deflateRawSync(raw) : raw, method = deflate ? 8 : 0, crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x0800, 8); head.writeUInt16LE(method, 10);
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(raw.length, 24); head.writeUInt16LE(nameBytes.length, 28); head.writeUInt32LE(offset, 42);
    chunks.push(local, nameBytes, body); central.push(head, nameBytes); offset += 30 + nameBytes.length + body.length;
  }
  const centralBuffer = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuffer, end]);
};
const xmlEscape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Giong file WMS that: chuoi nam trong sharedStrings, o trong bi bo han (khong co the <c>), zip ngoai boc xlsx.
const buildHistoryZip = rows => {
  const shared = [], index = new Map();
  const stringId = text => { if (!index.has(text)) { index.set(text, shared.length); shared.push(text); } return index.get(text); };
  const sheetRows = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => value === '' ? '' : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="s"><v>${stringId(value)}</v></c>`).join('')}</row>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`;
  const strings = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map(text => `<si><t>${xmlEscape(text)}</t></si>`).join('')}</sst>`;
  const xlsx = buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', data: '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheet, deflate: true },
    { name: 'xl/sharedStrings.xml', data: strings, deflate: true }
  ]);
  return buildZip([{ name: 'GROUP_UID_HISTORY_TEST.xlsx', data: xlsx }]);
};

// ---- Du lieu tong hop ----
const HEADER = ['No.', 'Group UID Code', 'Warehouse', 'Action', 'Old Location', 'New Location', 'SKU', 'Product Name', 'Quantity', 'Barcode', 'Note', 'Updated By', 'Updated Date'];
let rowNo = 0;
const historyRow = (action, uid, sku, qty, note, at) => [String(++rowNo), uid, 'WH - TEST', action, '', '', sku, '', String(qty), '', note, 'user@example.test', at];
const cutRow = (uid, sku, qty, remaining, at) => historyRow('Cut', uid, sku, qty, `Cut ${qty} out of group ${uid} (remaining ${remaining})`, at);
const HISTORY = [
  HEADER,
  cutRow('UID-A', 'SKU-G', 306, 4694, '2026-10-03 09:00:00'),
  cutRow('UID-B', 'SKU-G', 306, 4388, '2026-10-03 09:01:00'),
  cutRow('UID-C', 'SKU-G', 100, 4900, '2026-10-03 09:02:00'),
  cutRow('UID-D', 'SKU-M', 1000, 9000, '2026-10-03 09:03:00'),
  cutRow('UID-E', 'SKU-G', 306, 4694, '2026-10-03 09:04:00'),
  cutRow('UID-E', 'SKU-G', 306, 4388, '2026-10-04 08:00:00'),
  cutRow('UID-I', 'SKU-G', 100, 4900, '2026-09-30 08:00:00'), // truoc lan quet cat tren app -> la lan cat khac
  cutRow('UID-J', 'SKU-N', 77, 923, '2026-10-03 09:05:00'),
  cutRow('UID-K', 'SKU-G', 307, 4693, '2026-10-03 09:06:00'),
  cutRow('UID-X', 'SKU-G', 50, 100, '2026-10-03 09:07:00'), // UID khong quet cat tren app
  historyRow('Create', 'UID-H', 'SKU-G', 5000, '', '2026-08-01 07:58:09'),
  historyRow('Transfer location', 'UID-A', 'SKU-G', 0, '', '2026-10-05 14:03:46')
];
const CUT_ROWS = 10;
const G = 'Vải thử nghiệm/AB_Test/60% Cotton/180cm-170gsm/Đỏ/g'; // chuan 1 m = 180cm x 170gsm = 306 g
const M = 'Vải thử nghiệm/Beige/mm'; // chuan 1000 mm
const N = 'Phụ liệu thử nghiệm/Size M'; // khong tinh duoc chuan
const APP_CUT_AT = '2026-10-01T03:00:00.000Z';
const appItem = (groupUid, sku, productName, adjExportedAt = null) => ({ groupUid, sku, productName, lot: 'LOT-1', roll: '1', printStatus: 'printed', cutAt: APP_CUT_AT, adjExportedAt });
const syntheticItems = () => [
  appItem('UID-A', 'SKU-G', G, '2026-10-03T02:00:30.000Z'), // khop
  appItem('UID-B', 'SKU-G', G), // quen tick
  appItem('UID-C', 'SKU-G', G, '2026-10-03T02:02:00.000Z'), // sai so luong (100 thay vi 306)
  appItem('UID-D', 'SKU-M', M, '2026-10-03T02:03:00.000Z'), // khop (mm)
  appItem('UID-E', 'SKU-G', G, '2026-10-03T02:04:00.000Z'), // Cut nhieu lan
  appItem('UID-F', 'SKU-G', G, '2026-10-02T03:00:00.000Z'), // tick, WMS khong co
  appItem('UID-G', 'SKU-G', G, '2026-10-06T03:00:00.000Z'), // tick sau moc du lieu WMS
  appItem('UID-H', 'SKU-G', G), // chua ADJ
  appItem('UID-I', 'SKU-G', G), // Cut cu truoc lan quet bi bo qua -> chua ADJ
  appItem('UID-J', 'SKU-N', N, '2026-10-03T02:05:00.000Z'), // khong co chuan -> khop
  appItem('UID-K', 'SKU-G', G, '2026-10-03T02:06:00.000Z') // lech 1 trong dung sai -> khop
];
const EXPECTED_STATES = { 'UID-A': 'ok', 'UID-B': 'forgot', 'UID-C': 'wrong', 'UID-D': 'ok', 'UID-E': 'multi', 'UID-F': 'missing', 'UID-G': 'wait', 'UID-H': 'pending', 'UID-I': 'pending', 'UID-J': 'ok', 'UID-K': 'ok' };
const STATE_ORDER = ['wrong', 'missing', 'multi', 'forgot', 'pending', 'wait', 'ok'];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true });
      const errors = [], items = syntheticItems();
      const store = { rows: [], imports: [], importCalls: [], tickCalls: [], reconcileBodies: [] };
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
      // 08/10/2026: xac nhan dung hop WhDialog trong trang; hop confirm() cua trinh duyet khong duoc hien nua.
      page.on('dialog', dialog => { errors.push(`hop trinh duyet: ${dialog.message()}`); dialog.dismiss(); });
      // Mo phong server theo dung quy tac SQL: chi tinh Cut co gio >= gio quet cat tren app.
      await page.route('**/*', async route => {
        const request = route.request(), url = request.url();
        if (url.startsWith('http://127.0.0.1:8000/')) return route.continue();
        const rpc = url.split('/rpc/')[1] || '';
        const body = request.postDataJSON?.() || {};
        let result = { ok: true, data: {} };
        if (rpc === 'cut_group_uid_reconcile') {
          store.reconcileBodies.push(body);
          const wmsCutsOf = item => store.rows.filter(r => r.group_uid_code === item.groupUid && Date.parse(r.cut_at) >= Date.parse(item.cutAt))
            .sort((a, b) => Date.parse(a.cut_at) - Date.parse(b.cut_at)).map(r => ({ cutAt: r.cut_at, qty: Number(r.qty), remaining: Number(r.remaining_qty), by: r.cut_by }));
          const imports = store.imports;
          result = { ok: true, data: {
            items: items.map(item => ({ ...item, wmsCuts: wmsCutsOf(item) })),
            coverage: imports.length ? { from: imports.map(i => i.from).sort()[0], until: imports.map(i => i.until).sort().pop(), files: imports.length, importedAt: new Date().toISOString() } : null,
            lastImport: null } };
        } else if (rpc === 'wms_group_uid_cut_import') {
          store.importCalls.push({ authorization: request.headers().authorization, body });
          const rowKey = r => `${r.group_uid_code}|${new Date(r.cut_at).toISOString()}`;
          const have = new Set(store.rows.map(rowKey));
          let added = 0;
          for (const row of body.p_rows) if (!have.has(rowKey(row))) { store.rows.push(row); have.add(rowKey(row)); added += 1; }
          store.imports.push({ from: body.p_data_from, until: body.p_data_until });
          result = { ok: true, data: { importId: 'x', cutRows: body.p_rows.length, newRows: added, changedRows: 0, unchangedRows: body.p_rows.length - added, previousImports: 0 } };
        } else if (rpc === 'cut_group_uid_adj_from_wms') {
          store.tickCalls.push(body.p_codes);
          let updated = 0;
          for (const code of body.p_codes) {
            const item = items.find(x => x.groupUid === code), cuts = store.rows.filter(r => r.group_uid_code === code && Date.parse(r.cut_at) >= Date.parse(item.cutAt));
            if (item && !item.adjExportedAt && cuts.length === 1) { item.adjExportedAt = cuts[0].cut_at; updated += 1; }
          }
          result = { ok: true, data: { updated, skipped: body.p_codes.length - updated } };
        } else if (rpc === 'cut_group_uid_list' || rpc === 'cut_group_uid_search') result = { ok: true, data: { items: [] } };
        else if (rpc === 'print_queue_status') result = { ok: true, data: { agents: [] } };
        // Ô lọc SKU tra SKU Combo trước khi tìm (từ 3e233cb); mảng rỗng = không phải Combo, tìm luôn.
        else if (rpc === 'sku_combo_lookup') result = [];
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      });
      const message = () => page.locator('#cut-message').textContent();
      const counts = () => page.$$eval('.cut-adj-kpi', buttons => Object.fromEntries(buttons.map(b => [b.dataset.st || 'all', Number(b.querySelector('b').textContent)])));
      const states = () => page.$$eval('#cut-adj-rows tr[data-code]', rows => rows.map(tr => [tr.dataset.code, tr.querySelector('.cut-adj-st').dataset.st]));

      await page.goto('http://127.0.0.1:8000/#home');
      await page.locator('#barcode-cut-uid').click();
      await page.locator('#cut-group-uid-screen').waitFor({ state: 'visible' });
      await page.locator('#cut-tab-adj').click();
      await page.waitForFunction(() => document.querySelector('#cut-adj-cov').textContent.includes('Chưa nạp'));
      assert.equal(await page.locator('#cut-adj-issues').textContent(), '0');
      assert.match(await page.locator('#cut-adj-rows').innerText(), /Chưa nạp dữ liệu WMS/);

      // File sai: khong phai zip, thieu cot, dong Cut loi -> bao loi, khong goi RPC nap.
      const upload = (name, buffer) => page.locator('#cut-adj-file').setInputFiles({ name, mimeType: 'application/zip', buffer });
      await upload('rac.zip', Buffer.from('khong phai zip'));
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('Không đọc được file'));
      await upload('thieu-cot.zip', buildHistoryZip([['A', 'B'], ['1', '2']]));
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('Thiếu hoặc trùng cột'));
      await upload('dong-loi.zip', buildHistoryZip([HEADER, cutRow('UID-A', 'SKU-G', 'abc', 1, '2026-10-03 09:00:00')]));
      await page.waitForFunction(() => /dòng Cut lỗi/.test(document.querySelector('#cut-message').textContent));
      assert.equal(store.importCalls.length, 0);

      // Chua dang nhap Admin: hien lop dang nhap, chua nap; dang nhap xong thi nap tiep file dang cho.
      await upload('GROUP_UID_HISTORY_TEST.zip', buildHistoryZip(HISTORY));
      await page.locator('#admin-auth').waitFor({ state: 'visible' });
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('Đăng nhập Admin'));
      assert.equal(store.importCalls.length, 0);
      await page.evaluate(() => {
        document.getElementById('admin-auth').hidden = true;
        document.getElementById('root').inert = false;
        document.documentElement.classList.remove('admin-auth-lock');
        window.PrintSkuAdminAuth.accessToken = async () => 'test-admin-token';
        window.dispatchEvent(new CustomEvent('print-sku-admin-ready'));
      });
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.startsWith('Đã nạp'));
      assert.match(await message(), new RegExp(`Đã nạp ${CUT_ROWS} dòng Cut: ${CUT_ROWS} mới, 0 đổi, 0 giữ nguyên`));
      assert.equal(store.importCalls.length, 1);
      const call = store.importCalls[0];
      assert.equal(call.authorization, 'Bearer test-admin-token');
      assert.match(call.body.p_file_sha256, /^[0-9a-f]{64}$/);
      assert.equal(call.body.p_file_name, 'GROUP_UID_HISTORY_TEST.zip');
      assert.equal(call.body.p_total_rows, HISTORY.length - 1);
      assert.equal(call.body.p_data_from, '2026-08-01T07:58:09+07:00');
      assert.equal(call.body.p_data_until, '2026-10-05T14:03:46+07:00');
      assert.equal(call.body.p_rows.length, CUT_ROWS);
      assert.deepEqual(call.body.p_rows[0], { group_uid_code: 'UID-A', cut_at: '2026-10-03T09:00:00+07:00', qty: '306', remaining_qty: '4694', sku: 'SKU-G', cut_by: 'user@example.test', warehouse: 'WH - TEST' });

      // Extension 0.5.0 doc truc tiep lich su WMS cua warehouse_id 1177; nap chong khong nhan doi.
      const apiRows = HISTORY.slice(1).map(row => ({
        group_uid_code: row[1], warehouse_name: row[2], action_name: row[3], sku: row[6],
        quantity: Number(row[8]), note: row[10], updated_by_name: row[11], updated_at_tz: `${row[12].replace(' ', 'T')}+07:00`
      }));
      await page.evaluate(source => {
        window.addEventListener('message', event => {
          const req = event.data;
          if (event.source !== window || req?.source !== 'PRINT_SKU_APP') return;
          if (req.type === 'PING_WMS') window.postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: req.requestId, ok: true, data: { version: '0.5.0' } }, location.origin);
          if (req.type === 'GET_GROUP_UID_HISTORY_PAGE') {
            const cuts = source.filter(row => /^Cut\s/i.test(row.note || '')).map(row => {
              const match = /^Cut\s+([\d.,]+)\s+out of group\s+(\S+)\s+\(remaining\s+([\d.,]+)\)$/i.exec(row.note);
              return { group_uid_code: row.group_uid_code, cut_at: new Date(row.updated_at_tz).toISOString(), qty: Number(match[1]), remaining_qty: Number(match[3]), sku: row.sku, cut_by: row.updated_by_name, warehouse: row.warehouse_name };
            });
            window.postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: req.requestId, ok: true, data: {
              page: 1, size: 500, total: source.length, totalPages: 1, rows: cuts, sourceRows: source.length,
              rangeFrom: new Date(source.map(row => row.updated_at_tz).sort()[0]).toISOString(),
              rangeTo: new Date(source.map(row => row.updated_at_tz).sort().at(-1)).toISOString(), warehouseId: '1177'
            } }, location.origin);
          }
        });
      }, apiRows);
      await page.locator('#cut-adj-wms').click();
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.startsWith('Đã đọc'));
      assert.match(await message(), new RegExp(`Đã đọc ${HISTORY.length - 1} dòng lịch sử kho WH - MATERIAL - MTG; nạp ${CUT_ROWS} dòng Cut: 0 mới, 0 đổi, ${CUT_ROWS} giữ nguyên`));
      assert.equal(store.importCalls.length, 2);
      assert.match(store.importCalls[1].body.p_file_name, /^WMS_API_WH_MATERIAL_/);
      assert.equal(store.importCalls[1].body.p_total_rows, HISTORY.length - 1);
      assert.equal(store.importCalls[1].body.p_rows.length, CUT_ROWS);

      // Phan loai trang thai.
      assert.deepEqual(await counts(), { all: 11, wrong: 1, missing: 1, multi: 1, forgot: 1, pending: 2, wait: 1, ok: 4 });
      assert.equal(await page.locator('#cut-adj-issues').textContent(), '4');
      const rows = await states();
      assert.deepEqual(Object.fromEntries(rows), EXPECTED_STATES);
      const order = rows.map(([, state]) => STATE_ORDER.indexOf(state));
      assert.deepEqual(order, [...order].sort((a, b) => a - b), 'dong lech nang phai nam tren cung');
      assert.match(await page.locator('#cut-adj-cov').innerText(), /WMS .*14:03/);
      const wrongRow = await page.locator('#cut-adj-rows tr[data-code="UID-C"]').innerText();
      assert.match(wrongRow, /306 g/);
      assert.match(wrongRow, /100 g/);
      assert.match(await page.locator('#cut-adj-rows tr[data-code="UID-D"]').innerText(), /1\.000 mm/);

      // Chi dong "Quen tick" co o chon; Tick giup ghi gio Cut cua WMS.
      assert.equal(await page.locator('#cut-adj-rows input[type=checkbox]').count(), 1);
      await page.locator('.cut-adj-kpi[data-st="forgot"]').click();
      assert.deepEqual((await states()).map(([code]) => code), ['UID-B']);
      assert.equal(await page.locator('.cut-adj-kpi[data-st="forgot"]').getAttribute('aria-pressed'), 'true');
      await page.locator('#cut-adj-all').check();
      assert.equal((await page.locator('#cut-adj-tick').textContent()).trim(), 'Tick giúp 1');
      await page.locator('#cut-adj-tick').click();
      await page.locator('dialog.whd').waitFor({ state: 'visible' });
      assert.equal((await page.locator('dialog.whd .whd-title').textContent()).trim(), 'Đánh dấu 1 UID đã xuất ADJ');
      assert.deepEqual(await page.locator('dialog.whd .whd-list li').allTextContents(), ['UID-B']);
      await page.locator('dialog.whd .whd-ok').click();
      await page.waitForFunction(() => document.querySelector('#cut-message').textContent.includes('Đã tick 1 UID'));
      assert.deepEqual(store.tickCalls, [['UID-B']]);
      assert.equal(items.find(x => x.groupUid === 'UID-B').adjExportedAt, '2026-10-03T09:01:00+07:00');
      await page.waitForFunction(() => document.querySelector('.cut-adj-kpi[data-st="ok"] b').textContent === '5');
      assert.deepEqual(await counts(), { all: 11, wrong: 1, missing: 1, multi: 1, forgot: 0, pending: 2, wait: 1, ok: 5 });
      assert.equal(await page.locator('#cut-adj-issues').textContent(), '3');

      // Loc theo the + loc SKU/ngay gui dung tham so + nap lai cung file khong nhan doi.
      await page.locator('.cut-adj-kpi[data-st="pending"]').click();
      assert.deepEqual((await states()).map(([code]) => code).sort(), ['UID-H', 'UID-I']);
      await page.locator('.cut-adj-kpi[data-st=""]').click();
      assert.equal((await states()).length, 11);
      await page.locator('#cut-adj-sku').fill('SKU-G');
      await page.locator('#cut-adj-date-from').fill('2026-10-01');
      await page.locator('#cut-adj-form').evaluate(form => form.requestSubmit());
      await page.waitForTimeout(300);
      const lastBody = store.reconcileBodies.at(-1);
      assert.equal(lastBody.p_sku, 'SKU-G');
      assert.equal(lastBody.p_date_from, '2026-10-01');
      assert.equal('p_date_to' in lastBody, false);
      await upload('GROUP_UID_HISTORY_TEST.zip', buildHistoryZip(HISTORY));
      await page.waitForFunction(() => /0 mới/.test(document.querySelector('#cut-message').textContent));
      assert.match(await message(), new RegExp(`${CUT_ROWS} giữ nguyên`));

      // Xuat Excel: dung dong dang loc, du 9 cot, A4 ngang.
      await page.locator('.cut-adj-kpi[data-st="wrong"]').click();
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#cut-adj-export').click();
      const download = await downloadPromise, path = await download.path();
      assert.match(download.suggestedFilename(), /^Doi_chieu_ADJ_\d{8}\.xlsx$/);
      const xlsx = fs.readFileSync(path);
      for (const text of ['Trạng thái', 'UID', 'SKU', 'Lot', 'Cắt lúc', 'SL chuẩn', 'SL WMS', 'Giờ Cut WMS', 'Tick ADJ', 'Sai số lượng', 'UID-C', '306 g', '100']) assert.equal(xlsx.includes(Buffer.from(text)), true, text);
      assert.equal(xlsx.includes(Buffer.from('UID-A')), false, 'chi xuat dong dang loc');
      assert.equal(xlsx.includes(Buffer.from('ref="A1:I2"')), true);
      assert.equal(xlsx.includes(Buffer.from('orientation="landscape"')), true);
      assert.equal(xlsx.includes(Buffer.from('<col min="9" max="9" width="18" customWidth="1"/>')), true);

      // Bo cuc: khong tran ngang, du 4 tab trong khung.
      const layout = await page.evaluate(() => {
        const screen = document.getElementById('cut-group-uid-screen');
        return { docOk: document.documentElement.scrollWidth <= innerWidth, screenOk: screen.scrollWidth <= screen.clientWidth, tabs: [...screen.querySelectorAll('.cut-tab')].map(t => Math.round(t.getBoundingClientRect().right)), innerWidth };
      });
      assert.equal(layout.docOk && layout.screenOk, true);
      assert.equal(layout.tabs.length, 4);
      assert.equal(layout.tabs.every(right => right <= layout.innerWidth), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: file zip/xlsx, loi file, Admin truoc khi nap, 7 trang thai, Cut cu truoc lan quet, tick giup, loc, nap lai, XLSX, no overflow/errors`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
