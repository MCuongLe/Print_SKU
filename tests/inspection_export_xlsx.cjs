// Local check of the "KIỂM TRA ĐẦU VÀO" Excel export: Arial only, A4 landscape print setup, no clipped rows.
// Synthetic PO only; all external traffic is blocked. Needs the app served at APP_URL (default http://localhost:8000/).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const APP_URL = process.env.APP_URL || 'http://localhost:8000/';

const ITEMS = [
  ['422000001', 'Dây kéo mẫu A/ZIP-0001_NCC Alpha/100% Polyester/none/Đen-580-AA/M,L:41cm/none/pcs', 480],
  ['000123456', 'Chỉ may mẫu B/FX-0002_Công Ty TNHH Sản Xuất Thương Mại Dịch Vụ Alpha Beta Gamma/100% Polyester/none/Xám lông chuột ánh kim đậm HP SBD17 (2)/Tex 24-100D-2/none/cuộn 5000m', 1250],
  ['422000003', 'Nhãn care mẫu D/LAB004_ACME LABELS INDUSTRIAL VIỆT NAM/100% Polyester/none/White_TN035/none/25x78mm/pcs', 12003],
  ['422000004', 'Thun mẫu E/EL-0005_Spica/60% Nylon 40% Polyester/none/Xanh Navy-Navy 19-4031TCX/25mm/none/m', 79],
  ['422000005', 'Bo cổ mẫu F/BO-0006_NCC Gamma/98% Cotton 2% Spandex/none/Be ca cao-Etherea/Size 7x35cm/none/kg', 23],
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(APP_URL) ? route.continue() : route.abort());
    await page.goto(APP_URL + '#inspection');
    await page.waitForSelector('#ins-file', { state: 'attached' });

    // Dựng file PO (.xlsx) tổng hợp bằng bộ ghi zip của chính app.
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

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ins-export')]);
    const bytes = Array.from(require('node:fs').readFileSync(await download.path()));
    const parts = await page.evaluate(async raw => {
      const u8 = new Uint8Array(raw), dec = new TextDecoder(), out = {};
      const entries = window.PrintSkuZip.readZipEntries(u8);
      for (const [name, entry] of Object.entries(entries)) out[name] = /\.(xml|rels)$/.test(name) ? dec.decode(await window.PrintSkuZip.inflateZipEntry(u8, entry)) : '(binary)';
      return out;
    }, bytes);
    const sheet = parts['xl/worksheets/sheet1.xml'], styles = parts['xl/styles.xml'], book = parts['xl/workbook.xml'];

    // Font và viền
    assert.deepEqual([...new Set([...styles.matchAll(/<name val="([^"]+)"\/>/g)].map(m => m[1]))], ['Arial'], 'mọi font phải là Arial');
    assert.ok(!/<i\/>/.test(styles.match(/<fonts[\s\S]*?<\/fonts>/)[0].split('</font>')[7] || ''), 'font dữ liệu không in nghiêng');
    assert.equal((styles.match(/style="medium"/g) || []).length, 0, 'không còn viền dày');

    // Trang in A4 ngang, vừa khít chiều rộng, lặp dòng tiêu đề, không dính cài đặt máy in của template
    assert.match(sheet, /<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"\/>/);
    assert.match(sheet, /<pageSetUpPr fitToPage="1"\/>/);
    assert.ok(!/topLeftCell/.test(sheet), 'file phải mở ở A1');
    assert.match(book, /_xlnm\.Print_Titles[^>]*>[^<]*\$13:\$13</);
    assert.match(book, /_xlnm\.Print_Area[^>]*>[^<]*\$A\$1:\$O\$53</);
    assert.ok(!Object.keys(parts).some(name => /printerSettings/.test(name)), 'không còn printerSettings');
    assert.ok(!/r:id="rId1"/.test(sheet), 'không còn tham chiếu r:id mồ côi');

    // Dữ liệu: SKU là chữ (giữ số 0 đầu), hàng không dùng bị ẩn, chiều cao đủ cho số dòng chữ
    assert.match(sheet, /<c r="A15"[^>]*t="inlineStr"><is><t[^>]*>000123456<\/t>/);
    const heightOf = row => Number(sheet.match(new RegExp(`<row r="${row}"[^>]*\\sht="([\\d.]+)"`))[1]);
    for (let row = 14; row < 14 + ITEMS.length; row += 1) assert.ok(heightOf(row) >= 24, `hàng ${row} cao tối thiểu 24pt: ${sheet.match(new RegExp(`<row r="${row}"[^>]*>`))?.[0]}`);
    assert.ok(heightOf(15) >= 57, 'tên rất dài (5 dòng) phải đủ cao');
    assert.ok(heightOf(16) >= 57, 'từ dài không có dấu cách bị cắt theo ký tự: cần 4 dòng');
    const hidden = [...sheet.matchAll(/<row r="(\d+)"[^>]*hidden="1"/g)].map(m => Number(m[1]));
    assert.deepEqual(hidden, Array.from({ length: 49 - (13 + ITEMS.length) }, (_, i) => 14 + ITEMS.length + i), 'hàng 14+n..49 phải ẩn');
    assert.deepEqual(errors, [], 'không có lỗi trang');
    console.log('inspection_export_xlsx: Arial, A4 ngang, vùng in, chiều cao hàng, hàng ẩn đều đạt');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
