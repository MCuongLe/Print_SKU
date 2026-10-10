// Local check: Combo lines of a PO show their Normal SKU on screen and in the exported report.
// Synthetic PO; the sku_combo_lookup RPC is mocked and all other external traffic is blocked.
// Needs the app served at APP_URL (default http://localhost:8000/).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const APP_URL = process.env.APP_URL || 'http://localhost:8000/';

// sku, tên, số lượng
const ITEMS = [
  ['422100001', '(Combo) Chỉ mẫu A/FX-0001_NCC Alpha/100% Polyester/none/Xám/Tex 24/none/cuộn 5000m', 145],
  ['422100002', '(Combo) Bo cổ - tay mẫu/BO-0002_NCC Beta/98% Cotton 2% Spandex/none/Navy/Size 7x35cm/none/set', 60],
  ['422100003', '(Combo) Dây thun mẫu C/EL-0003_NCC Gamma/60% Nylon/none/Đen/25mm/none/m', 10],
  ['422100004', 'Nhãn care mẫu D/LAB004_ACME LABELS/100% Polyester/none/White/none/25x78mm/pcs', 12003],
  ['422100005', '(Combo) Chỉ mẫu E/FX-0005_NCC Alpha/100% Polyester/none/Đỏ/Tex 24/none/cuộn 5000m', 20],
  ['422100006', '(Combo) Chỉ mẫu F/FX-0006_NCC Alpha/100% Polyester/none/Xanh/Tex 24/none/cuộn 5000m', 30],
  ['422100007', 'Dây kéo mẫu G/ZIP-0007_NCC Alpha/100% Polyester/none/Đen/20cm/none/pcs', 15],
];
// Phản hồi giả lập của RPC; E và G luôn lỗi 500 (G là SKU thường), F lỗi 500 lần đầu rồi thành công (thử lại lúc xuất).
const NORMALS = {
  '422100001': [{ normal_sku: '422900001', product_name: 'Chỉ mẫu A', category_name: 'Phụ liệu', quantity: 5000000, available: true }],
  '422100002': [{ normal_sku: '422900002', product_name: 'Bo cổ mẫu', category_name: 'Phụ liệu', quantity: 1, available: true }, { normal_sku: '422900003', product_name: 'Bo tay mẫu', category_name: 'Phụ liệu', quantity: 2, available: false }],
  '422100006': [{ normal_sku: '422900006', product_name: 'Chỉ mẫu F', category_name: 'Phụ liệu', quantity: 5000000, available: true }],
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [], calls = {};
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(APP_URL) ? route.continue() : route.abort());
    await page.route(/\/rest\/v1\/rpc\/sku_combo_lookup$/, route => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const sku = route.request().postDataJSON().p_sku;
      calls[sku] = (calls[sku] || 0) + 1;
      if (sku === '422100005' || sku === '422100007' || (sku === '422100006' && calls[sku] === 1)) return route.fulfill({ status: 500, headers: cors, body: 'error' });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(NORMALS[sku] || []) });
    });
    await page.goto(APP_URL + '#inspection');
    await page.waitForSelector('#ins-file', { state: 'attached' });

    const input = await page.evaluate(async items => {
      const enc = new TextEncoder();
      const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const text = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      const num = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
      const rows = [
        `<row r="4">${text('G4', 'Mã số')}${text('H4', '99900000000001')}</row>`,
        `<row r="9">${text('E9', 'Ngày giao: 11:33 22/10/2026')}</row>`,
        `<row r="16">${['STT', 'SKU', 'Tên', 'Barcode', 'Mã NCC', 'Số lượng', 'Giá(+VAT)', 'Thành tiền'].map((h, i) => text('ABCDEFGH'[i] + 16, h)).join('')}</row>`,
        ...items.map(([sku, name, qty], i) => `<row r="${17 + i}">${num('A' + (17 + i), i + 1)}${text('B' + (17 + i), sku)}${text('C' + (17 + i), name)}${num('F' + (17 + i), qty)}</row>`),
      ].join('');
      const parts = {
        '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
        '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
      };
      return Array.from(window.PrintSkuZip.buildZip(Object.entries(parts).map(([name, xml]) => ({ name, data: enc.encode(xml) }))));
    }, ITEMS);
    await page.setInputFiles('#ins-file', { name: 'po.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(input) });
    await page.waitForFunction(count => document.querySelectorAll('.ins-row[data-index]').length === count, ITEMS.length);
    // Chờ tra xong: dòng F lỗi lần đầu nên hiện cảnh báo, các dòng còn lại đã có kết quả.
    await page.waitForFunction(() => document.querySelectorAll('.ins-sku--warn').length === 3 && document.querySelectorAll('.ins-sku').length === 2);

    // ---- Màn hình ----
    const cells = await page.$$eval('.ins-row[data-index]', rows => rows.map(row => {
      const cell = row.querySelector('[data-sku-cell]');
      return { normal: cell.classList.contains('ins-sku'), text: cell.value ?? cell.innerText, warn: cell.classList.contains('ins-sku--warn'), title: cell.title, qty: row.querySelector('[data-field="qty"]').value };
    }));
    assert.deepEqual(cells[0], { normal: true, text: '422900001', warn: false, title: 'Combo 422100001', qty: '145' });
    assert.equal(cells[1].normal, true);
    assert.equal(cells[1].text.replace(/\n+/g, ' ').trim(), '422900002 422900003', 'Combo 2 Normal hiện cả hai SKU');
    assert.match(cells[1].title, /ngừng hoạt động/, 'Normal không available phải được ghi trong tooltip');
    assert.deepEqual([cells[2].normal, cells[2].warn, cells[2].text], [false, true, '422100003'], 'Combo chưa có liên kết: giữ SKU Combo và cảnh báo');
    assert.deepEqual([cells[3].normal, cells[3].warn, cells[3].text], [false, false, '422100004'], 'SKU thường giữ nguyên');
    assert.deepEqual([cells[4].normal, cells[4].warn], [false, true], 'Tra lỗi: giữ SKU Combo và cảnh báo');
    assert.deepEqual([cells[6].normal, cells[6].warn, cells[6].text], [false, false, '422100007'], 'SKU thường lỗi mạng: giữ nguyên, không bị đánh dấu');
    assert.deepEqual(cells.map(cell => cell.qty), ['145', '60', '10', '12003', '20', '30', '15'], 'số lượng giữ nguyên theo PO');

    // ---- Biên bản ----
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ins-export')]);
    const bytes = Array.from(require('node:fs').readFileSync(await download.path()));
    const sheet = await page.evaluate(async raw => {
      const u8 = new Uint8Array(raw), entries = window.PrintSkuZip.readZipEntries(u8);
      return new TextDecoder().decode(await window.PrintSkuZip.inflateZipEntry(u8, entries['xl/worksheets/sheet1.xml']));
    }, bytes);
    const cellText = ref => { const match = sheet.match(new RegExp(`<c r="${ref}"[^>]*t="inlineStr"><is><t[^>]*>([^<]*)</t>`)); return match ? match[1] : null; };
    const heightOf = row => Number(sheet.match(new RegExp(`<row r="${row}"[^>]*\\sht="([\\d.]+)"`))[1]);
    assert.equal(cellText('A14'), '422900001');
    assert.equal(cellText('A15'), '422900002\n422900003', 'hai Normal: mỗi SKU một dòng trong cùng ô');
    assert.equal(cellText('A16'), '422100003');
    assert.equal(cellText('O16'), 'Combo chưa có SKU Normal');
    assert.equal(cellText('A17'), '422100004');
    assert.equal(cellText('O17'), null);
    assert.equal(cellText('A18'), '422100005');
    assert.equal(cellText('O18'), 'Chưa tra được SKU Normal');
    assert.equal(cellText('A19'), '422900006', 'dòng lỗi lần đầu được thử lại lúc xuất');
    assert.equal(cellText('O19'), null);
    assert.equal(cellText('A20'), '422100007');
    assert.equal(cellText('O20'), null, 'SKU thường lỗi mạng không bị ghi chú');
    assert.ok(heightOf(15) >= 32, 'ô SKU hai dòng phải đủ cao');
    assert.ok(heightOf(16) >= 32, 'ghi chú hai dòng phải đủ cao');
    assert.deepEqual(['E14', 'E15'].map(ref => sheet.match(new RegExp(`<c r="${ref}"[^>]*><v>([^<]*)</v>`))[1]), ['145', '60'], 'số lượng trong biên bản giữ nguyên theo PO');
    assert.match(await page.locator('#ins-status').innerText(), /Chưa tra được SKU Normal cho 3 dòng/);

    // Mỗi SKU chỉ tra một lần (có nhớ kết quả); chỉ F được thử lại sau lỗi.
    assert.deepEqual(calls, { '422100001': 1, '422100002': 1, '422100003': 1, '422100004': 1, '422100005': 2, '422100006': 2, '422100007': 2 });
    assert.deepEqual(errors, [], 'không có lỗi trang');
    console.log('inspection_normal_sku_browser: màn hình và biên bản hiển thị SKU Normal; Combo thiếu liên kết/lỗi giữ SKU Combo kèm ghi chú');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
