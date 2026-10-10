// Local check: Trim Supplier = vendor (legal company name) of the PO, with the supplier written in the SKU name as fallback.
// The Inside extension is simulated through the page bridge; synthetic data only; all external traffic is blocked.
// Needs the app served at APP_URL (default http://localhost:8000/).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const APP_URL = process.env.APP_URL || 'http://localhost:8000/';

const NAME_SPICA = 'Thun dệt mẫu/JV52575A1-35_Spica/61% Nylon, 31% Poly, 8% Spandex/none/Trắng/30mm/none/m';
const NAME_SONG = 'Vải mẫu/Double face 5MT_Song Thủy/100% Cotton/none/Trắng/166cm/none/m';
const item = (sku, name, orderedQty) => ({ sku, barcode: '', name, orderedQty });
const POS = {
  // Danh sách PO của Inside trả "<tên công ty> - <người liên hệ>".
  '99900000000011': { poId: '1', poCode: '99900000000011', vendor: 'CÔNG TY TNHH SPICA ELASTIC VIỆT NAM - Ms Hà', warehouse: 'WH - MATERIAL - MTG', deliveryDate: '2026-10-20', status: 'approved',
    items: [item('422000001', NAME_SPICA, 30000), item('422100001', '(Combo) ' + NAME_SPICA, 500)] },
  // Tên pháp nhân chứa " - " thật: chỉ cắt hậu tố người liên hệ cuối cùng.
  '99900000000012': { poId: '2', poCode: '99900000000012', vendor: 'CÔNG TY TNHH SẢN XUẤT - THƯƠNG MẠI - XUẤT NHẬP KHẨU SONG THỦY H.K - Ms Lan', warehouse: 'WH - MATERIAL - MTG', deliveryDate: '2026-10-20', status: 'approved', items: [item('422000002', NAME_SONG, 100)] },
  // "Nhà cung cấp nhỏ lẻ" đại diện nhiều nhà thật: dùng NCC trong tên SKU.
  '99900000000013': { poId: '3', poCode: '99900000000013', vendor: 'Nhà cung cấp nhỏ lẻ - Nhà cung cấp nhỏ lẻ', warehouse: 'WH - MATERIAL - MTG', deliveryDate: '2026-10-20', status: 'approved', items: [item('422000003', NAME_SONG, 100)] },
  // Không có nhà cung cấp: dùng NCC trong tên SKU.
  '99900000000014': { poId: '4', poCode: '99900000000014', vendor: '', warehouse: 'WH - MATERIAL - MTG', deliveryDate: '2026-10-20', status: 'approved', items: [item('422000004', NAME_SONG, 100)] },
};
const NORMAL_NAME = 'Thun dệt mẫu/JV9999_NCC Normal Khác/61% Nylon/none/Đen/30mm/none/mm';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Giả lập extension qua cầu nối của trang: trả lời PING và GET_PO.
    await page.addInitScript(pos => {
      window.addEventListener('message', event => {
        const request = event.data;
        if (event.source !== window || !request || request.source !== 'PRINT_SKU_APP') return;
        const reply = (ok, data, error) => window.postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: request.requestId, ok, data, error }, location.origin);
        if (request.type === 'PING') reply(true, { version: 'test' });
        else if (request.type === 'GET_PO') pos[request.payload.poCode] ? reply(true, pos[request.payload.poCode]) : reply(false, undefined, { message: 'Không tìm thấy PO' });
      });
    }, POS);
    await page.route('**/*', route => route.request().url().startsWith(APP_URL) ? route.continue() : route.abort());
    await page.route(/\/rest\/v1\/rpc\/sku_combo_lookup$/, route => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const rows = route.request().postDataJSON().p_sku === '422100001' ? [{ normal_sku: '422900001', product_name: NORMAL_NAME, category_name: 'Phụ liệu', quantity: 1000, available: true }] : [];
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(rows) });
    });
    await page.goto(APP_URL + '#inspection');
    await page.waitForSelector('#ins-file', { state: 'attached' });

    const suppliers = () => page.$$eval('.ins-row[data-index] input[data-field="supplier"]', inputs => inputs.map(input => input.value));
    const fetchPo = async code => {
      await page.fill('#ins-po-lookup', code);
      await page.click('#ins-fetch-po');
      await page.waitForFunction(expected => document.querySelector('#ins-status').innerText.includes('Đã lấy PO ' + expected), code);
      await page.waitForFunction(() => !document.querySelector('#ins-fetch-po').disabled);
      await page.waitForTimeout(400); // chờ tra SKU Normal xong
    };

    // 1) Extension: tên công ty, cắt hậu tố người liên hệ; Combo vẫn dùng nhà cung cấp PO dù tên Normal ghi NCC khác.
    await fetchPo('99900000000011');
    assert.deepEqual(await suppliers(), ['CÔNG TY TNHH SPICA ELASTIC VIỆT NAM', 'CÔNG TY TNHH SPICA ELASTIC VIỆT NAM'], 'Trim Supplier là tên công ty, không phải "Spica"');
    const comboName = await page.$eval('.ins-row[data-index="1"] input[data-field="name"]', input => input.value);
    assert.equal(comboName, NORMAL_NAME, 'tên Combo vẫn theo SKU Normal');
    // 2) Tên pháp nhân có " - ": chỉ bỏ phần người liên hệ cuối.
    await fetchPo('99900000000012');
    assert.deepEqual(await suppliers(), ['CÔNG TY TNHH SẢN XUẤT - THƯƠNG MẠI - XUẤT NHẬP KHẨU SONG THỦY H.K']);
    // 3) "nhỏ lẻ" và không có nhà cung cấp: dùng NCC trong tên SKU.
    await fetchPo('99900000000013');
    assert.deepEqual(await suppliers(), ['Song Thủy']);
    await fetchPo('99900000000014');
    assert.deepEqual(await suppliers(), ['Song Thủy']);

    // 4) Nhập Excel "Phiếu mua": tên công ty ở dòng ngay dưới nhãn "Nhà cung cấp" (không cắt " - "); xuất biên bản ghi đúng tên đó.
    const VENDOR_XLS = 'CÔNG TY TNHH SẢN XUẤT - THƯƠNG MẠI - XUẤT NHẬP KHẨU SONG THỦY H.K';
    const buildXlsx = vendor => page.evaluate(async ({ vendor, name }) => {
      const enc = new TextEncoder();
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const text = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      const num = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
      const rows = [
        `<row r="4">${text('G4', 'Mã số')}${text('H4', '99900000000021')}</row>`,
        `<row r="7">${text('A7', 'Nhà cung cấp')}</row>`,
        `<row r="8">${text('A8', vendor)}</row>`,
        `<row r="9">${text('E9', 'Ngày giao: 11:33 22/10/2026')}</row>`,
        `<row r="16">${['STT', 'SKU', 'Tên', 'Barcode', 'Mã NCC', 'Số lượng', 'Giá(+VAT)', 'Thành tiền'].map((h, i) => text('ABCDEFGH'[i] + 16, h)).join('')}</row>`,
        `<row r="17">${num('A17', 1)}${text('B17', '422000005')}${text('C17', name)}${num('F17', 100)}</row>`,
      ].join('');
      const parts = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
      };
      return Array.from(window.PrintSkuZip.buildZip(Object.entries(parts).map(([file, xml]) => ({ name: file, data: enc.encode(xml) }))));
    }, { vendor, name: NAME_SONG });
    await page.setInputFiles('#ins-file', { name: 'po.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(await buildXlsx(VENDOR_XLS)) });
    await page.waitForFunction(() => document.querySelectorAll('.ins-row[data-index]').length === 1 && document.querySelector('#ins-status').innerText.includes('99900000000021'));
    assert.deepEqual(await suppliers(), [VENDOR_XLS], 'Excel: tên công ty giữ nguyên, kể cả dấu " - " của tên pháp nhân');
    assert.equal(await page.$eval('.ins-row[data-index="0"] input[data-field="supplier"]', input => input.title), VENDOR_XLS, 'tooltip hiện tên đầy đủ');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ins-export')]);
    const bytes = Array.from(require('node:fs').readFileSync(await download.path()));
    const sheet = await page.evaluate(async raw => {
      const u8 = new Uint8Array(raw), entries = window.PrintSkuZip.readZipEntries(u8);
      return new TextDecoder().decode(await window.PrintSkuZip.inflateZipEntry(u8, entries['xl/worksheets/sheet1.xml']));
    }, bytes);
    assert.match(sheet, new RegExp(`<c r="C14"[^>]*t="inlineStr"><is><t[^>]*>${VENDOR_XLS}</t>`), 'biên bản: Trim Supplier là tên công ty');
    const heightOf = row => Number(sheet.match(new RegExp(`<row r="${row}"[^>]*\\sht="([\\d.]+)"`))[1]);
    assert.ok(heightOf(14) >= 45, 'tên công ty dài phải đủ cao để không bị cắt');

    // 5) Excel của nhà cung cấp "nhỏ lẻ": dùng NCC trong tên SKU.
    await page.setInputFiles('#ins-file', { name: 'po2.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(await buildXlsx('Nhà cung cấp nhỏ lẻ')) });
    await page.waitForFunction(() => document.querySelector('.ins-row[data-index="0"] input[data-field="supplier"]')?.value === 'Song Thủy');

    assert.deepEqual(errors, [], 'không có lỗi trang');
    console.log('inspection_vendor_browser: Trim Supplier theo nhà cung cấp PO; dự phòng theo tên SKU khi "nhỏ lẻ" hoặc thiếu; Excel và Inside đều đạt');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
