// Đợt 2 Garment (26/10/2026): KIỂM TRA ĐẦU VÀO chọn nguồn PO MTG | GARMENT — kho theo nguồn, kiểm bản Extension ≥ 0.11.0 và po.site,
// Buyer của biên bản theo nguồn của PO đã nạp. Extension giả lập qua cầu nối của trang; dữ liệu giả (PO 999…, SKU 9000000xx); chặn mọi mạng ngoài.
// Mỗi kịch bản mở lại trang và ghi lỗi riêng (không dừng ở lỗi đầu) để liệt kê đủ nhóm hỏng. Cần máy chủ tĩnh ở APP_URL / BASE (mặc định http://localhost:8000/).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readXlsx } = require('./xlsx_read.cjs');
const APP_URL = process.env.APP_URL || process.env.BASE || 'http://localhost:8000/';

const NAME = 'Thun dệt mẫu/JV52575A1-35_Spica/61% Nylon, 31% Poly, 8% Spandex/none/Trắng/30mm/none/m';
const item = (sku, qty) => ({ sku, barcode: '', name: NAME, orderedQty: qty });
const GARMENT_WH = 'WH - MATERIAL - GARMENT - 130 Ấp Chánh - Tỉnh Long An';
const MTG_WH = 'WH - MATERIAL - MTG';
const po = (code, extra) => ({ poId: '1', poCode: code, vendor: 'CÔNG TY MẪU - Ms Test', warehouse: GARMENT_WH, deliveryDate: '2026-10-30', lastModified: '2026-10-26', status: 'receiving', items: [item('900000014', 300)], ...extra });
const POS = {
  '99900000000101': po('99900000000101', { site: 'garment', vendor: 'Hộ kinh doanh Mẫu' }), // Garment hợp lệ (Extension 0.11.0 đã bỏ "- " đầu NCC)
  '99900000000102': po('99900000000102', { site: 'garment', warehouse: MTG_WH }),               // kho MTG trên nguồn Garment
  '99900000000103': po('99900000000103', { site: 'garment', warehouse: 'SHOP - 130 AP CHANH - GARMENT' }),
  '99900000000104': po('99900000000104', { site: 'mastige', warehouse: MTG_WH }),               // PO Mastige hợp lệ
  '99900000000105': po('99900000000105', { warehouse: MTG_WH }),                                // Extension cũ: không có khoá site
  '99900000000106': po('99900000000106', { warehouse: GARMENT_WH }),                            // không có site + kho Garment
};
const TEXT = { garmentHelp: 'Buyer để trống', mtgHelp: 'Buyer mặc định MASTIGE' };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const failures = [];
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    // Extension giả: PING trả window.__ext.version; GET_PO trả POS[mã] bất kể site (để kiểm phía web), ghi lại mọi yêu cầu.
    await page.addInitScript(cfg => {
      window.__ext = { version: '0.12.1', delay: 0, requests: [], pos: cfg.pos };
      window.addEventListener('message', event => {
        const request = event.data;
        if (event.source !== window || !request || request.source !== 'PRINT_SKU_APP') return;
        window.__ext.requests.push({ type: request.type, payload: request.payload });
        const reply = (ok, data, error) => setTimeout(() => window.postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: request.requestId, ok, data, error }, location.origin), request.type === 'GET_PO' ? window.__ext.delay : 0);
        if (request.type === 'PING') window.__ext.pingError ? reply(false, undefined, window.__ext.pingError) : reply(true, { version: window.__ext.version });
        else if (request.type === 'GET_PO') window.__ext.pos[request.payload.poCode] ? reply(true, window.__ext.pos[request.payload.poCode]) : reply(false, undefined, { message: 'Không tìm thấy PO' });
      });
    }, { pos: POS });
    await page.route('**/*', route => route.request().url().startsWith(APP_URL) ? route.continue() : route.abort());
    await page.route(/\/rest\/v1\/rpc\/sku_combo_lookup$/, route => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '[]' });
    });

    const open = async () => {
      await page.goto(APP_URL + '#inspection');
      await page.evaluate(() => { try { localStorage.removeItem('ins-site-v1'); } catch { /* không có thì thôi */ } });
      await page.reload();
      await page.waitForSelector('#ins-file', { state: 'attached' });
      await page.waitForFunction(() => document.querySelector('#ins-connector')?.dataset.state === 'ready');
    };
    const pick = site => page.click(`#ins-site-${site}`);
    const pressed = () => page.$$eval('#ins-site .ins-sitebtn', buttons => Object.fromEntries(buttons.map(button => [button.dataset.site, button.getAttribute('aria-pressed')])));
    const setVersion = version => page.evaluate(v => { window.__ext.version = v; }, version);
    const requests = type => page.evaluate(t => window.__ext.requests.filter(r => r.type === t).map(r => r.payload), type);
    const status = () => page.$eval('#ins-status', node => node.innerText);
    const fetchPo = async code => {
      await page.fill('#ins-po-lookup', code);
      await page.click('#ins-fetch-po');
      await page.waitForFunction(() => !document.querySelector('#ins-fetch-po').disabled);
      await page.waitForTimeout(350); // chờ tra SKU Normal xong
    };
    const loaded = () => page.inputValue('#ins-po');
    const buyer = async () => {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#ins-export')]);
      const sheet = readXlsx(fs.readFileSync(await download.path())).sheet;
      const cell = sheet.match(/<c r="C5"[^>]*?(?:\/>|>([\s\S]*?)<\/c>)/);
      assert.ok(cell, 'biên bản phải có ô C5');
      return [...(cell[1] || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join('');
    };
  const buildPoXlsx = (page, items) => page.evaluate(async items => {
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
  }, items);
    const scenario = async (name, fn) => {
      try { await open(); await fn(); }
      catch (error) { failures.push(`${name}: ${String(error.message).split('\n')[0].slice(0, 220)}`); }
    };

    await scenario('1 công tắc nguồn: mặc định MTG, bấm GARMENT đổi, nhớ sau khi tải lại trang', async () => {
      assert.deepEqual(await pressed(), { mastige: 'true', garment: 'false' }, 'mặc định MTG');
      assert.equal((await page.$eval('#ins-site-mastige', n => n.innerText)).trim(), 'MTG');
      assert.equal((await page.$eval('#ins-site-garment', n => n.innerText)).trim(), 'GARMENT');
      await pick('garment');
      assert.deepEqual(await pressed(), { mastige: 'false', garment: 'true' });
      await page.reload();
      await page.waitForSelector('#ins-file', { state: 'attached' });
      assert.deepEqual(await pressed(), { mastige: 'false', garment: 'true' }, 'lựa chọn nhớ theo máy');
      const heights = await page.$$eval('#ins-site .ins-sitebtn', buttons => buttons.map(button => Math.round(button.getBoundingClientRect().height)));
      assert.ok(heights.every(height => height >= 44), `vùng bấm ≥ 44 px: ${heights}`);
    });

    await scenario('2 nguồn MTG gửi site=mastige, nạp PO Mastige, Buyer MASTIGE', async () => {
      await fetchPo('99900000000104');
      assert.deepEqual(await requests('GET_PO'), [{ poCode: '99900000000104', site: 'mastige' }]);
      assert.equal(await loaded(), '99900000000104');
      assert.match(await status(), /Đã lấy PO 99900000000104/);
      assert.equal(await buyer(), 'MASTIGE');
      assert.match(await page.$eval('#ins-buyer-help', n => n.innerText), new RegExp(TEXT.mtgHelp));
    });

    await scenario('3 nguồn GARMENT gửi site=garment, nạp PO Garment, Buyer để trống, NCC không còn "- " đầu', async () => {
      await pick('garment');
      await fetchPo('99900000000101');
      assert.deepEqual(await requests('GET_PO'), [{ poCode: '99900000000101', site: 'garment' }]);
      assert.equal(await loaded(), '99900000000101');
      assert.match(await status(), /Đã lấy PO 99900000000101.*\(Inside Garment\)/);
      assert.equal(await page.inputValue('#ins-date'), '26/10/2026');
      assert.deepEqual(await page.$$eval('.ins-row[data-index] input[data-field="supplier"]', inputs => inputs.map(input => input.value)), ['Hộ kinh doanh Mẫu']);
      assert.equal(await buyer(), '', 'Buyer của PO Garment để trống cho QC tự điền');
      assert.match(await page.$eval('#ins-buyer-help', n => n.innerText), new RegExp(TEXT.garmentHelp));
    });

    await scenario('4 Buyer theo nguồn của PO đã nạp, không theo công tắc bấm sau đó', async () => {
      await pick('garment');
      await fetchPo('99900000000101');
      await pick('mastige');
      assert.equal(await buyer(), '', 'đã nạp PO Garment rồi bấm MTG: biên bản vẫn là của Garment');
      await fetchPo('99900000000104');
      assert.equal(await buyer(), 'MASTIGE');
      await pick('garment');
      assert.equal(await buyer(), 'MASTIGE', 'bấm GARMENT sau khi nạp PO Mastige: Buyer giữ MASTIGE');
    });

    await scenario('5 nguồn GARMENT từ chối kho MTG và kho SHOP, giữ PO đã nạp', async () => {
      await pick('garment');
      await fetchPo('99900000000101');
      await fetchPo('99900000000102');
      assert.match(await status(), /PO thuộc kho WH - MATERIAL - MTG, không phải WH - MATERIAL - GARMENT/);
      assert.equal(await loaded(), '99900000000101', 'lỗi kho không đè PO đang có');
      await fetchPo('99900000000103');
      assert.match(await status(), /PO thuộc kho SHOP - 130 AP CHANH - GARMENT, không phải WH - MATERIAL - GARMENT/);
      assert.equal(await loaded(), '99900000000101');
    });

    await scenario('6 nguồn MTG từ chối kho Garment', async () => {
      await fetchPo('99900000000106');
      assert.match(await status(), /không phải WH - MATERIAL - MTG/);
      assert.equal(await loaded(), '');
    });

    await scenario('7 GARMENT với Extension < 0.11.0: chặn trước khi hỏi PO', async () => {
      await setVersion('0.10.10');
      await pick('garment');
      await fetchPo('99900000000101');
      assert.deepEqual(await requests('GET_PO'), [], 'không gửi GET_PO cho Extension cũ');
      assert.match(await status(), /Extension.*0\.11\.0.*Garment/);
      assert.equal(await loaded(), '');
      assert.equal((await page.$eval('#ins-connector', n => n.innerText)).trim(), 'Tải lại trang');
      await setVersion('0.11.0');
      await open();
      await pick('garment');
      await setVersion('abc');
      await fetchPo('99900000000101');
      assert.deepEqual(await requests('GET_PO'), [], 'bản không đọc được cũng bị chặn');
    });

    await scenario('8 po.site không khớp nguồn (hoặc thiếu ở GARMENT) bị từ chối', async () => {
      await pick('garment');
      await fetchPo('99900000000104');
      assert.match(await status(), /không thuộc Inside Garment/);
      assert.equal(await loaded(), '');
      await fetchPo('99900000000106');
      assert.match(await status(), /không thuộc Inside Garment/, 'PO không có site ở nguồn GARMENT');
      assert.equal(await loaded(), '');
    });

    await scenario('9 nguồn MTG: Extension cũ (không có site) vẫn đọc được; po.site=garment bị từ chối', async () => {
      await setVersion('0.10.10');
      await fetchPo('99900000000105');
      assert.equal(await loaded(), '99900000000105', 'tương thích ngược: Extension cũ + nguồn MTG');
      assert.equal(await buyer(), 'MASTIGE');
      await fetchPo('99900000000101');
      assert.match(await status(), /không thuộc Inside\b/);
      assert.equal(await loaded(), '99900000000105');
    });

    await scenario('10 trong lúc đọc PO các nút nguồn bị khoá; đổi nguồn giữa chừng không đổi nguồn của yêu cầu', async () => {
      await page.evaluate(() => { window.__ext.delay = 600; });
      await pick('garment');
      await page.fill('#ins-po-lookup', '99900000000101');
      await page.click('#ins-fetch-po');
      assert.deepEqual(await page.$$eval('#ins-site .ins-sitebtn', buttons => buttons.map(button => button.disabled)), [true, true], 'khoá nút nguồn khi đang đọc');
      await page.waitForFunction(() => !document.querySelector('#ins-fetch-po').disabled);
      assert.equal(await loaded(), '99900000000101');
      assert.deepEqual(await page.$$eval('#ins-site .ins-sitebtn', buttons => buttons.map(button => button.disabled)), [false, false]);
    });

    await scenario('11 nhập Excel: Buyer theo nút đang chọn, trạng thái ghi rõ "file · nguồn"', async () => {
      const bytes = await buildPoXlsx(page, [['900000014', NAME, 120]]);
      await pick('garment');
      await page.setInputFiles('#ins-file', { name: 'po.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      await page.waitForFunction(() => document.querySelector('#ins-status').innerText.includes('(file · GARMENT)'));
      assert.equal(await buyer(), '', 'Excel nhập khi chọn GARMENT');
      await pick('mastige');
      await page.evaluate(() => { document.querySelector('#ins-status').textContent = ''; });
      await page.setInputFiles('#ins-file', { name: 'po2.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      await page.waitForFunction(() => document.querySelector('#ins-status').innerText.includes('(file · MTG)'));
      assert.equal(await buyer(), 'MASTIGE', 'Excel nhập khi chọn MTG');
    });

    await scenario('12 điện thoại 390 px: công tắc nguồn vừa hàng, không tràn ngang', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await page.waitForSelector('#ins-site', { state: 'attached' });
      const box = await page.$eval('#ins-site', n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
      assert.ok(box.left >= 0 && box.right <= 390, `công tắc nằm trong màn: ${JSON.stringify(box)}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'không cuộn ngang');
      await page.setViewportSize({ width: 1280, height: 900 });
    });

    await scenario('13 nhập Excel: nút nguồn khoá trong lúc đọc file, Buyer theo nguồn lúc chọn file', async () => {
      const bytes = await buildPoXlsx(page, [['900000014', NAME, 120]]);
      await page.evaluate(() => { const original = File.prototype.arrayBuffer; File.prototype.arrayBuffer = function () { return new Promise(resolve => setTimeout(() => resolve(original.call(this)), 700)); }; });
      await pick('garment');
      await page.setInputFiles('#ins-file', { name: 'po.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      assert.deepEqual(await page.$$eval('#ins-site .ins-sitebtn', buttons => buttons.map(button => button.disabled)), [true, true], 'khoá nút nguồn khi đang đọc file');
      await page.waitForFunction(() => document.querySelector('#ins-status').innerText.includes('(file · GARMENT)'));
      assert.deepEqual(await page.$$eval('#ins-site .ins-sitebtn', buttons => buttons.map(button => button.disabled)), [false, false], 'mở khoá sau khi đọc xong');
      assert.equal(await buyer(), '');
    });

    await scenario('14 đọc Inside và nhập Excel chồng nhau: nút nguồn chỉ mở khi cả hai xong', async () => {
      const bytes = await buildPoXlsx(page, [['900000014', NAME, 120]]);
      await page.evaluate(() => { window.__ext.delay = 500; const original = File.prototype.arrayBuffer; File.prototype.arrayBuffer = function () { return new Promise(resolve => setTimeout(() => resolve(original.call(this)), 1600)); }; });
      await pick('garment');
      await page.fill('#ins-po-lookup', '99900000000101');
      await page.click('#ins-fetch-po');
      await page.setInputFiles('#ins-file', { name: 'po.xlsx', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      await page.waitForFunction(() => !document.querySelector('#ins-fetch-po').disabled);
      assert.deepEqual(await page.$$eval('#ins-site .ins-sitebtn', buttons => buttons.map(button => button.disabled)), [true, true], 'đọc Inside xong nhưng file còn đọc: nút nguồn vẫn khoá');
      await page.waitForFunction(() => !document.querySelector('#ins-site .ins-sitebtn').disabled);
    });

    await scenario('15 PING lỗi "tải lại trang" giữ nguyên câu gốc sau lần chặn trước', async () => {
      await setVersion('0.10.10');
      await pick('garment');
      await fetchPo('99900000000101'); // lần 1: chặn Extension cũ → huy hiệu "Tải lại trang", connectorReady = false
      await page.evaluate(() => { window.__ext.pingError = { message: 'Tiện ích vừa được cập nhật; hãy tải lại trang' }; });
      await fetchPo('99900000000101'); // lần 2: Extension vừa Reload, trang chưa F5 → cầu nối mồ côi
      assert.match(await status(), /tải lại trang/);
      assert.doesNotMatch(await status(), /Không tìm thấy tiện ích/);
      assert.equal((await page.$eval('#ins-connector', n => n.innerText)).trim(), 'Tải lại trang');
    });

    await scenario('16 phím Enter khi đang đọc PO không mở lượt đọc thứ hai', async () => {
      await page.evaluate(() => { window.__ext.delay = 600; });
      await pick('garment');
      await page.fill('#ins-po-lookup', '99900000000101');
      await page.click('#ins-fetch-po');
      await page.press('#ins-po-lookup', 'Enter');
      await page.waitForFunction(() => !document.querySelector('#ins-fetch-po').disabled);
      assert.equal((await requests('GET_PO')).length, 1, 'chỉ một GET_PO');
      assert.equal(await loaded(), '99900000000101');
    });

    if (errors.length) failures.push(`lỗi trang: ${errors.join(' | ').slice(0, 300)}`);
  } finally {
    await browser.close();
  }
  assert.deepEqual(failures, [], 'các kịch bản hỏng');
  console.log('inspection_garment: nguồn MTG | GARMENT, kho, bản Extension, po.site, Buyer biên bản đều đạt');
})().catch(error => { console.error(error); process.exit(1); });
