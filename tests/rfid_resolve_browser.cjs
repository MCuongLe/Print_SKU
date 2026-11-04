// QUÉT RFID A5000 → GROUP UID ở các ô quét Group UID (04/11/2026, docs/plans/2026-11-04-quet-rfid-a5000-link-group-uid.md):
// khối dùng chung window.PrintSkuRfid (đổi mã RFID 1 chữ + 11 số ra Group UID qua RPC group_uid_by_rfid, ≤ 2 giây, chỉ nhận đúng 1 UID,
// ưu tiên UID không Canceled) và sáu ô quét: IN TEM GROUP UID #uid-code, CẮT GROUP UID #cut-code, CẤP VẢI #cap-vai-code, TRẢ NCC #vr-code,
// CHUYỂN ĐỔI ĐƠN VỊ #uc-code, XẢ VẢI #xa-vai-code. Supabase giả lập, UID giả 1028260000000xxx, RFID giả A500000000xx.
//   node tests/rfid_resolve_browser.cjs   (máy chủ tĩnh cổng 8000, đổi bằng BASE; RFID_PART=<tên,tên> để chạy riêng từng phần)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const UID1 = '1028260000000001', UID2 = '1028260000000002';
const RF3 = 'A50000000010', UID3 = '1028260000000003';
const RF1 = 'A50000000005', RF2 = 'A50000000006', RF_MANY = 'A50000000007', RF_NONE = 'A50000000008', RF_CANCEL = 'A50000000009';
const TOKEN = 'pd_' + 'ab'.repeat(24);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const row = (rfid, groupUid, status = 'Available') => ({ rfid, groupUid, status });

const makeServer = () => ({
  calls: [], mode: 'ok', delay: 0,
  rfid: {
    [RF1]: [row(RF1, UID1)],
    [RF2]: [row(RF2, UID2)],
    [RF3]: [row(RF3, UID3)],
    [RF_MANY]: [row(RF_MANY, UID1), row(RF_MANY, UID2)],
    [RF_CANCEL]: [row(RF_CANCEL, UID2, 'Canceled'), row(RF_CANCEL, UID1, 'Available')],
  },
});
const calls = (s, rpc) => s.calls.filter(c => c.rpc === rpc);

const LINE = { id: 'l1', no: 1, sku: '900000001', lot: 'L1', roll: '1', groupUid: UID1, qtyM: 100, state: 'matched', scannedAt: null, location: 'A-01' };
const PLAN = { id: 'p1', name: 'Đợt thử', status: 'open', scanned: 0, total: 1, matched: 1, qtyTotal: 100, poNo: '10012600000001', createdAt: new Date().toISOString() };
const LIST = { id: '33333333-3333-4333-8333-333333333333', fileName: 'tra-ncc-gia.xlsx', createdAt: '2026-10-24T01:00:00Z', itemCount: 1 };
const VR_ITEM = { groupUid: UID1, color: 'navy', sku: '900000496', productName: 'Vải giả', lot: 'L1', roll: '1', location: 'F0-KHO-000-00-00-01', currentLocation: 'F0-KHO-000-00-00-01', warehouse: 'F0' };

const mock = async (page, s) => page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
  const body = route.request().postDataJSON?.() || {};
  if (rpc) s.calls.push({ rpc, body });
  if (rpc === 'group_uid_by_rfid') {
    if (s.delay) await sleep(s.delay);
    if (s.mode === 'http500') return json({ message: 'lỗi giả' }, 500);
    if (s.mode === 'abort') return route.abort('failed');
    const rows = (body.p_codes || []).flatMap(c => s.rfid[c] || []);
    return json({ ok: true, data: { rows }, meta: {} });
  }
  if (rpc === 'group_uid_lookup') {
    return json((body.p_codes || []).map(code => ({ group_uid_code: code, sku: '900000202', product_name: 'Vải thử/Polyester/170GSM/W180cm/mm', lot: 'LOT-01', roll: '01' })));
  }
  if (rpc === 'cut_group_uid_scan') return json({ ok: true, data: { groupUid: body.p_group_uid, sku: '900000001', productName: 'Vải thử', lot: 'L1', roll: 'R1', printStatus: 'pending', cutAt: new Date().toISOString() } });
  if (rpc === 'cut_group_uid_list' || rpc === 'cut_group_uid_search') return json({ ok: true, data: { items: [] } });
  if (rpc === 'fabric_issue_list') return json({ ok: true, data: { plans: [PLAN] } });
  if (rpc === 'fabric_issue_get') return json({ ok: true, data: { plan: PLAN, lines: [LINE], products: {} } });
  if (rpc === 'fabric_issue_scan') return json({ ok: true, data: { result: 'issued', line: { ...LINE, scannedAt: new Date().toISOString(), scannedBy: 'Máy thử' }, plan: { ...PLAN, scanned: 1 } } });
  if (rpc === 'vendor_return_snapshot') return json({ ok: true, data: { list: LIST, items: [VR_ITEM] } });
  if (rpc === 'vendor_return_scan') return json({ ok: true, data: { result: 'new', color: 'navy', scannedAt: new Date().toISOString(), device: 'Máy giả' } });
  if (rpc === 'xa_vai_measure_lookup') {
    return json({ ok: true, data: { groupUid: body.p_group_uid, sku: '900000001', productName: 'Vải thử', itemCode: null, lot: 'L1', roll: '1', uidStatus: 'Available', systemQty: 1000, systemMm: 60000, state: 'new', actualMm: null, measuredAt: null, printedAt: null, printJobId: null } });
  }
  if (rpc === 'xa_vai_measure_list') return json({ ok: true, data: { items: [], total: 0 } });
  if (rpc === 'xa_vai_measure_search') return json({ ok: true, data: { items: [], total: 0, truncated: false } });
  if (url.includes('/SKU_Name?')) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [] } });
});

async function newPage(browser, width = 1280) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(token => { localStorage.setItem('tb-khoa', token); localStorage.setItem('nds-ten-may', 'Máy thử'); }, TOKEN);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { context, page, errors };
}
const bodyText = page => page.evaluate(() => document.body.innerText);
const waitText = (page, re, ms = 6000) => page.waitForFunction(r => new RegExp(r).test(document.body.innerText), re.source, { timeout: ms });

// ---- 1. Khối dùng chung ----
async function shared(browser) {
  const { context, page, errors } = await newPage(browser);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#home');
  const uid = raw => page.evaluate(r => window.PrintSkuRfid.uid(r), raw);
  assert.equal(await page.evaluate(() => typeof window.PrintSkuRfid?.uid), 'function', 'có window.PrintSkuRfid.uid');
  assert.equal(await page.evaluate(() => window.PrintSkuRfid.rfidOf('\u0002a50000000005\r\n')), RF1, 'rfidOf: viết hoa, bỏ ký tự điều khiển của máy quét');
  assert.equal(await page.evaluate(() => window.PrintSkuRfid.rfidOf('1028260000000001')), '', 'Group UID 16 số không phải RFID');
  assert.equal(await page.evaluate(() => window.PrintSkuRfid.rfidOf('900000001')), '', 'SKU không phải RFID');
  assert.equal(await page.evaluate(() => window.PrintSkuRfid.rfidOf('F0-VR-00-00-00-00')), '', 'mã vị trí không phải RFID');
  assert.equal(await page.evaluate(() => window.PrintSkuRfid.rfidOf('A5000000000')), '', '11 ký tự không phải RFID');
  assert.equal(await page.evaluate(() => window.PrintSkuRfid.rfidOf('A500000000055')), '', '13 ký tự không phải RFID');
  // Không phải RFID: trả nguyên mã (đã cắt khoảng trắng), KHÔNG gọi máy chủ
  assert.deepEqual(await uid(` ${UID1}\r`), { uid: UID1, via: '' });
  assert.deepEqual(await uid('UID-W1'), { uid: 'UID-W1', via: '' });
  assert.deepEqual(await uid(`${RF1} ${UID1}`), { uid: `${RF1} ${UID1}`, via: '' }, 'có cả Group UID 16 số: giữ nguyên chuỗi, mỗi màn tự xét (TRẢ NCC từ chối tiền tố)');
  assert.equal(calls(s, 'group_uid_by_rfid').length, 0, 'mã thường không gọi group_uid_by_rfid');
  // RFID → Group UID
  assert.deepEqual(await uid(RF1), { uid: UID1, via: RF1 });
  assert.deepEqual(calls(s, 'group_uid_by_rfid')[0].body, { p_codes: [RF1] }, 'hỏi đúng một mã RFID');
  assert.deepEqual(await uid('a50000000005'), { uid: UID1, via: RF1 }, 'chữ thường → viết hoa');
  assert.deepEqual(await uid('\u0002A50000000005\r\n'), { uid: UID1, via: RF1 }, 'tiền tố / Enter của máy quét');
  assert.deepEqual(await uid(RF_CANCEL), { uid: UID1, via: RF_CANCEL }, 'ưu tiên UID không Canceled');
  // Lỗi nghiệp vụ
  const many = await uid(RF_MANY);
  assert.equal(many.fail, 'many'); assert.equal(many.via, RF_MANY); assert.match(many.text, /RFID trùng nhiều UID/); assert.equal(many.uid, undefined);
  const none = await uid(RF_NONE);
  assert.equal(none.fail, 'none'); assert.match(none.text, /RFID chưa liên kết/); assert.match(none.text, new RegExp(RF_NONE));
  s.rfid[RF_NONE] = [{ rfid: RF_NONE, groupUid: 'khong-phai-16-so', status: 'Available' }, { rfid: 'A59999999999', groupUid: UID2, status: 'Available' }];
  assert.equal((await uid(RF_NONE)).fail, 'none', 'dòng sai dạng / khác RFID bị bỏ');
  // Lỗi hạ tầng
  s.mode = 'http500';
  const e500 = await uid(RF1);
  assert.equal(e500.fail, 'error'); assert.match(e500.text, /RFID chưa kiểm được/);
  s.mode = 'abort';
  assert.equal((await uid(RF1)).fail, 'error', 'mất mạng');
  s.mode = 'ok'; s.delay = 2800;
  const t0 = Date.now();
  assert.equal((await uid(RF1)).fail, 'error', 'quá 2 giây coi như chưa kiểm được');
  assert.ok(Date.now() - t0 < 2700, `hết giờ sau ~2 giây (đã chờ ${Date.now() - t0} ms)`);
  s.delay = 0;
  assert.deepEqual(await uid(RF1), { uid: UID1, via: RF1 }, 'sau lỗi hạ tầng quét lại vẫn chạy (không nhớ lỗi)');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS khối dùng chung: rfidOf đúng mẫu, mã thường không gọi máy chủ, RFID → UID (hoa / tiền tố / Canceled), trùng, chưa liên kết, 500, mất mạng, hết 2 giây');
}

// ---- 2. CHUYỂN ĐỔI ĐƠN VỊ #uc-code ----
async function converter(browser) {
  const { context, page, errors } = await newPage(browser);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#home');
  await page.locator('#barcode-unit-converter').click();
  await page.locator('#unit-converter-screen').waitFor({ state: 'visible' });
  await page.locator('#uc-code').fill(RF1);
  await page.locator('#uc-code').press('Enter');
  await page.waitForFunction(u => document.getElementById('uc-picked-code').textContent.includes(u), UID1);
  assert.match(await page.locator('#uc-picked-code').textContent(), new RegExp(`${UID1} · SKU 900000202`));
  assert.deepEqual(calls(s, 'group_uid_lookup').pop().body, { p_codes: [UID1] }, 'tra bằng Group UID đã giải mã, không phải mã RFID');
  const before = calls(s, 'group_uid_lookup').length;
  await page.locator('#uc-lookup-details').evaluate(el => { el.open = true; }); // mục 1 tự thu gọn sau khi nhận diện
  await page.locator('#uc-code').fill(RF_NONE);
  await page.locator('#uc-code').press('Enter');
  await waitText(page, /RFID chưa liên kết/);
  assert.equal(calls(s, 'group_uid_lookup').length, before, 'RFID chưa liên kết không tra tiếp');
  // RFID tra chậm rồi nhập Group UID khác (tra nhanh): kết quả RFID cũ về sau KHÔNG ghi đè sản phẩm của lượt mới
  await page.locator('#uc-lookup-details').evaluate(el => { el.open = true; });
  s.delay = 900;
  await page.locator('#uc-code').fill(RF2);
  await page.locator('#uc-code').press('Enter');
  s.delay = 0;
  await page.locator('#uc-code').fill('1028260000000077');
  await page.locator('#uc-code').press('Enter');
  await page.waitForFunction(() => document.getElementById('uc-picked-code').textContent.includes('1028260000000077'));
  await sleep(1500);
  assert.match(await page.locator('#uc-picked-code').textContent(), /1028260000000077/, 'lượt mới thắng');
  assert.doesNotMatch(await page.locator('#uc-picked-code').textContent(), new RegExp(UID2), 'RFID cũ về sau không ghi đè');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS CHUYỂN ĐỔI ĐƠN VỊ: RFID → Group UID → tra SKU, RFID chưa liên kết báo ngắn');
}

// ---- 3. CẮT GROUP UID #cut-code ----
async function cut(browser) {
  const { context, page, errors } = await newPage(browser);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#home');
  await page.locator('#barcode-cut-uid').click();
  await page.locator('#cut-group-uid-screen').waitFor({ state: 'visible' });
  await page.locator('#cut-code').fill(RF1);
  await page.locator('#cut-code').press('Enter');
  await page.waitForFunction(() => /Đã lưu tem/.test(document.body.innerText));
  assert.equal(calls(s, 'cut_group_uid_scan').pop().body.p_group_uid, UID1, 'cắt ghi theo Group UID, không ghi mã RFID');
  assert.match(await bodyText(page), new RegExp(`RFID ${RF1}`), 'thẻ kết quả ghi RFID đã quét');
  const before = calls(s, 'cut_group_uid_scan').length;
  await page.locator('#cut-code').fill(RF_NONE);
  await page.locator('#cut-code').press('Enter');
  await waitText(page, /RFID chưa liên kết/);
  assert.equal(calls(s, 'cut_group_uid_scan').length, before, 'RFID chưa liên kết không ghi gì');
  assert.equal(await page.locator('#cut-code').inputValue(), RF_NONE, 'giữ mã trong ô quét');
  await page.locator('#cut-code').fill(RF_MANY);
  await page.locator('#cut-code').press('Enter');
  await waitText(page, /RFID trùng nhiều UID/);
  assert.equal(calls(s, 'cut_group_uid_scan').length, before);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS CẮT GROUP UID: RFID → ghi theo Group UID + dòng RFID, chưa liên kết / trùng không ghi');
}

// ---- 4. IN TEM GROUP UID #uid-code ----
async function printLabel(browser) {
  const { context, page, errors } = await newPage(browser);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#group-uid');
  await page.evaluate(() => { window.testJobs = []; window.PrintSkuQueue.enqueue = async job => { window.testJobs.push(job); return { ok: true }; }; });
  await page.locator('#uid-code').fill(RF1);
  await page.locator('#uid-code').press('Enter');
  await page.waitForFunction(() => document.querySelector('#uid-ready-count').textContent === '1');
  assert.deepEqual(calls(s, 'group_uid_lookup').pop().body, { p_codes: [UID1] }, 'danh sách tem ghi Group UID, không phải mã RFID');
  assert.match(await page.locator('#uid-ready').innerText(), new RegExp(UID1));
  // Quét lại đúng RFID đó: đã có trong danh sách (so theo Group UID đã giải mã)
  await page.locator('#uid-code').fill(RF1);
  await page.locator('#uid-code').press('Enter');
  await waitText(page, /đã có trong danh sách/);
  assert.equal(await page.locator('#uid-ready-count').textContent(), '1', 'RFID trùng không thêm dòng thứ hai');
  await page.locator('#uid-code').fill(RF_NONE);
  await page.locator('#uid-code').press('Enter');
  await waitText(page, /RFID chưa liên kết/);
  assert.equal(await page.locator('#uid-ready-count').textContent(), '1');
  // Hai RFID quét liên tiếp khi lượt đầu còn đang giải mã: ô được xoá ngay, mã thứ hai không bị nối vào mã thứ nhất
  s.delay = 700;
  await page.locator('#uid-code').fill(RF2);
  await page.locator('#uid-code').press('Enter');
  assert.equal(await page.locator('#uid-code').inputValue(), '', 'ô quét xoá ngay khi nhận mã');
  await page.locator('#uid-code').fill(RF3);
  await page.locator('#uid-code').press('Enter');
  s.delay = 0;
  await page.waitForFunction(() => document.querySelector('#uid-ready-count').textContent === '3');
  assert.deepEqual(calls(s, 'group_uid_by_rfid').slice(-2).map(c => c.body.p_codes[0]).sort(), [RF2, RF3].sort(), 'mỗi mã RFID tra riêng, không có chuỗi ghép');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS IN TEM GROUP UID: RFID → Group UID vào danh sách, RFID trùng không thêm, chưa liên kết báo ngắn');
}

// ---- 5. CẤP VẢI #cap-vai-code ----
async function issue(browser) {
  const { context, page, errors } = await newPage(browser);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#cap-vai');
  await page.locator('#cap-vai-screen').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#cap-vai-plan option')?.value === 'p1');
  await page.waitForFunction(() => document.getElementById('cap-vai-total').textContent === '1');
  await page.locator('#cap-vai-code').fill(RF1);
  await page.locator('#cap-vai-code').press('Enter');
  await page.locator('#cap-vai-pop-title').waitFor();
  assert.match(await page.locator('#cap-vai-pop-title').textContent(), /CẤP GROUP UID NÀY/);
  assert.equal(calls(s, 'fabric_issue_scan').pop().body.p_group_uid, UID1, 'cấp vải ghi theo Group UID');
  assert.match(await page.locator('#cap-vai-pop-card').textContent(), new RegExp(`RFID ${RF1}`), 'thẻ kết quả ghi RFID đã quét');
  const before = calls(s, 'fabric_issue_scan').length;
  await page.locator('#cap-vai-popup [data-pop-close]').click().catch(() => {});
  await page.locator('#cap-vai-code').fill(RF_NONE);
  await page.locator('#cap-vai-code').press('Enter');
  await waitText(page, /RFID chưa liên kết/);
  assert.equal(calls(s, 'fabric_issue_scan').length, before, 'RFID chưa liên kết không ghi gì');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS CẤP VẢI: RFID → ghi theo Group UID + dòng RFID, chưa liên kết không ghi');
}

// ---- 6. TRẢ NCC #vr-code ----
async function vendorReturn(browser) {
  const { context, page, errors } = await newPage(browser);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#tra-ncc');
  await page.locator('#vendor-return-screen').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('vr-total').textContent.trim() !== '—');
  await page.locator('#vr-code').fill(RF1);
  await page.locator('#vr-code').press('Enter');
  await waitText(page, /Đã quét|ĐÃ QUÉT|Navy/i);
  await page.waitForFunction(() => document.getElementById('vr-result').dataset.tone && document.getElementById('vr-result').dataset.tone !== 'bad');
  assert.equal(calls(s, 'vendor_return_scan').pop().body.p_group_uid, UID1, 'trả NCC ghi theo Group UID');
  assert.match(await page.locator('#vr-result').innerText(), new RegExp(`RFID ${RF1}`), 'thẻ kết quả ghi RFID đã quét');
  const before = calls(s, 'vendor_return_scan').length;
  await page.locator('#vr-code').fill(RF_NONE);
  await page.locator('#vr-code').press('Enter');
  await page.waitForFunction(() => /RFID chưa liên kết/.test(document.getElementById('vr-result').innerText));
  assert.equal(await page.locator('#vr-result').getAttribute('data-tone'), 'bad');
  assert.equal(calls(s, 'vendor_return_scan').length, before, 'RFID chưa liên kết không ghi gì');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS TRẢ NCC: RFID → ghi theo Group UID + dòng RFID, chưa liên kết báo đỏ không ghi');
}

// ---- 7. XẢ VẢI #xa-vai-code ----
async function relax(browser) {
  const { context, page, errors } = await newPage(browser, 375);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  s.delay = 600;
  await page.locator('#xa-vai-code').fill(RF1);
  assert.equal(await page.locator('#xa-vai-code').inputValue(), '', 'ô quét trống ngay khi tự tra bắt đầu (quét tiếp không bị nối vào mã đang tra)');
  await page.locator('#xa-vai-code').press('Enter');
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  s.delay = 0;
  assert.equal(calls(s, 'xa_vai_measure_lookup').length, 1, 'tự tra + Enter chỉ tra một lần');
  assert.equal(calls(s, 'xa_vai_measure_lookup').pop().body.p_group_uid, UID1, 'xả vải tra theo Group UID đã giải mã');
  assert.match((await page.locator('#xa-vai-uid').innerText()).replace(/\s+/g, ' '), new RegExp(UID1));
  assert.match(await page.locator('#xa-vai-uid').innerText(), new RegExp(`RFID ${RF1}`), 'thẻ UID ghi RFID đã quét');
  await page.keyboard.press('Escape');
  const before = calls(s, 'xa_vai_measure_lookup').length;
  await page.locator('#xa-vai-code').fill(RF_NONE);
  await page.locator('#xa-vai-code').press('Enter');
  await waitText(page, /RFID chưa liên kết/);
  assert.equal(calls(s, 'xa_vai_measure_lookup').length, before, 'RFID chưa liên kết không tra tiếp');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS XẢ VẢI: RFID → Group UID → nhập mét, chưa liên kết báo ngắn');
}

// ---- 8. Camera dùng chung PrintSkuScanUI.openGroupUid nhận mã RFID ----
// Camera giả như tests/scan_field_standard_browser.cjs: window.__code = mã bộ đọc trả về.
const fakeScanner = () => {
  const install = () => {
    const S = window.PrintSkuScanner; if (!S) return false;
    window.PrintSkuScanner = { ...S, gl: () => true, k0: () => true, Jp: async () => ({ doc: async () => (window.__code ? { ma: window.__code } : null) }),
      ev: async () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#456'; g.fillRect(0, 0, 640, 480); }, 100);
        return c.captureStream(10);
      } };
    return true;
  };
  const t = setInterval(() => { if (install()) clearInterval(t); }, 20);
};
async function camera(browser) {
  const { context, page, errors } = await newPage(browser);
  await context.addInitScript(fakeScanner);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#home');
  await page.locator('#barcode-cut-uid').click();
  await page.locator('#cut-group-uid-screen').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('cut-camera').hidden);
  // Mã sai (không phải Group UID 16 số, không phải RFID): lớp camera không nhận, màn không ghi gì
  await page.evaluate(() => { window.__code = 'ABC123'; });
  await page.locator('#cut-camera').click();
  await waitText(page, /không phải Group UID/);
  assert.equal(calls(s, 'cut_group_uid_scan').length, 0, 'mã sai không ghi');
  await page.keyboard.press('Escape');
  // Mã RFID: lớp camera nhận mã thô, màn tự giải mã rồi ghi theo Group UID
  await page.evaluate(code => { window.__code = code; }, RF1);
  await page.locator('#cut-camera').click();
  await page.waitForFunction(() => /Đã lưu tem/.test(document.body.innerText));
  assert.equal(calls(s, 'cut_group_uid_scan').pop().body.p_group_uid, UID1, 'camera quét RFID → ghi theo Group UID');
  assert.deepEqual(calls(s, 'group_uid_by_rfid').pop().body, { p_codes: [RF1] });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS camera dùng chung: mã sai không nhận, mã RFID được nhận và màn giải ra Group UID');
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const only = (process.env.RFID_PART || '').split(',').filter(Boolean);
    for (const part of [shared, converter, cut, printLabel, issue, vendorReturn, relax, camera]) if (!only.length || only.includes(part.name)) await part(browser);
    console.log('PASS rfid_resolve_browser');
  } finally { await browser.close(); }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
