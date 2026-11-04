// THEO DÕI XẢ VẢI bản phiếu A4 (04/11/2026, docs/plans/2026-11-04-xa-vai-met-thuc-te-a4.md): quét Group UID của BẤT KỲ SKU nào → nhập mét thực tế
// → hàng "Chờ in" (mọi SKU) → In A4: khung nhập Mã hàng (mã kiểu hàng như CWSH02, nhớ theo máy) → RPC xa_vai_print_enqueue(p_item_code) qua
// PrintSkuQueue.enqueueRpc (khoá máy, nonce, lớp phủ chibi) → "Đã in" lọc theo Mã hàng + ngày, in lại (một mã hàng mỗi phiếu), Excel.
// Máy chủ giả lập theo hợp đồng RPC (CONTRACT V2 mục 1, 5: đơn vị mm; CONTRACT V3 mục 1, 3: item_code, bỏ p_sku ở save / list; chưa có mẫu phản hồi
// thật vì RPC mới). Dữ liệu giả: SKU 9000000xx, UID 1028260000000xxx, mã hàng CWSH02 / TEST01.
// Chạy với python -m http.server 8000 (đổi bằng BASE). XA_VAI_SHOTS=<thư mục> thì chụp ảnh 1280 + 375 px ba tab + khung nhập Mã hàng.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const { readXlsx } = require('./xlsx_read.cjs');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SHOTS = process.env.XA_VAI_SHOTS || '';
const TOKEN = 'pd_' + 'cd'.repeat(24);
const SKU = '900000001', SKU2 = '900000002', SKU_BIG = '900000003';
const NAME = 'Vải Test Jersey/Cotton/155gsm, 178cm/Đen/g';
const CODE_RE = /^[0-9A-Z._-]{1,40}$/;
const uid = n => `10282600000${String(n).padStart(5, '0')}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ago = m => new Date(Date.now() - m * 60000).toISOString();

// Máy chủ giả: chi tiết UID (group_uid_details) + bảng xa_vai_measures (có item_code) + lệnh in. Đơn vị lưu và so sánh = mm nguyên.
const makeServer = () => {
  const s = { calls: [], details: new Map(), measures: new Map(), jobs: new Map(), nonces: new Map(), mode: 'ok', abortOnce: new Set(), abortAfter: new Set(), seq: 0, listTotal: null };
  const add = (n, sku, systemMm, lot = 'L1', roll = `R${n}`) => s.details.set(uid(n), { sku, lot, roll, systemMm, productName: sku === SKU ? NAME : `Vải thử ${sku}` });
  add(1, SKU, 60758); add(2, SKU, 50000); add(3, SKU, 40000); add(4, SKU, 30000); add(5, SKU, null); add(6, SKU, 60000); add(9, SKU2, 20000);
  for (let i = 0; i < 150; i++) add(500 + i, SKU_BIG, 10000, 'LB', `B${i}`);
  s.item = (u, m) => ({ groupUid: u, sku: m.sku, itemCode: m.itemCode || null, lot: m.lot, roll: m.roll, systemMm: m.systemMm, actualMm: m.actualMm, measuredAt: m.measuredAt, status: m.status, printedAt: m.printedAt || null, printJobId: m.jobId || null });
  s.measure = (u, actualMm, status = 'pending', extra = {}) => { const d = s.details.get(u); s.measures.set(u, { sku: d.sku, lot: d.lot, roll: d.roll, systemMm: d.systemMm, actualMm, measuredAt: new Date(Date.now() + (s.seq++)).toISOString(), status, printedAt: null, jobId: null, itemCode: null, ...extra }); };
  // Lệnh do máy khác gửi (hoặc trước khi tải lại trang): UID đang "printing" gắn printJobId + mã hàng.
  s.foreignJob = (id, uids, itemCode = 'CWSH02') => { s.jobs.set(id, { status: 'queued', uids, reprint: false }); uids.forEach(u => { const m = s.measures.get(u); m.status = 'printing'; m.jobId = id; m.itemCode = itemCode; }); };
  return s;
};

const mock = async (page, s) => page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (!rpc) return json([]);
  const body = route.request().postDataJSON?.() || {};
  s.calls.push({ rpc, body });
  if (s.delayMs?.[rpc]) await sleep(s.delayMs[rpc]);
  if (s.abortOnce.has(rpc)) { s.abortOnce.delete(rpc); return route.abort('internetdisconnected'); }
  // PostgREST: tham số lạ (chữ ký cũ có p_sku) → HTTP 404 PGRST202, như khi web cũ gọi hàm đã đổi chữ ký.
  const noFn = () => json({ code: 'PGRST202', message: `Could not find the function public.${rpc}`, details: null, hint: null }, 404);
  // abortAfter: máy chủ đã ghi xong rồi mới mất phản hồi (hết giờ) — web không biết lệnh đã vào hay chưa.
  const after = s.abortAfter.has(rpc);
  if (after) s.abortAfter.delete(rpc);
  const ok = after ? () => route.abort('timedout') : data => json({ ok: true, data });
  const fail = (code, message, extra = {}) => json({ ok: false, error: { code, message, ...extra } });
  const denied = () => fail('ACCESS_DENIED', 'Máy chưa kích hoạt; vào ô KÍCH HOẠT MÁY.');
  if (rpc === 'xa_vai_measure_lookup') {
    const u = String(body.p_group_uid || '').trim(), d = s.details.get(u), m = s.measures.get(u);
    if (!d) return fail('GROUP_UID_NOT_READY', 'Group UID chưa có trong dữ liệu');
    return ok({ groupUid: u, sku: d.sku, productName: d.productName, itemCode: m ? m.itemCode || null : null, lot: d.lot, roll: d.roll, uidStatus: 'Available', systemQty: 1000, systemMm: d.systemMm, state: m ? m.status : 'new', actualMm: m ? m.actualMm : null, measuredAt: m ? m.measuredAt : null, printedAt: m ? m.printedAt : null, printJobId: m ? m.jobId || null : null });
  }
  // list / search: p_item_code khác rỗng mà sai mẫu (sau upper + trim) → INVALID_ITEM_CODE (SQL V3).
  const badCode = () => body.p_item_code != null && String(body.p_item_code).trim() !== '' && !CODE_RE.test(String(body.p_item_code).trim().toUpperCase());
  if ((rpc === 'xa_vai_measure_list' || rpc === 'xa_vai_measure_search') && badCode()) return fail('INVALID_ITEM_CODE', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)');
  if (rpc === 'xa_vai_measure_list') {
    if ('p_sku' in body) return noFn();
    // queue = pending + printing của MỌI SKU, bỏ qua p_item_code (CONTRACT V3 mục 1).
    const items = [...s.measures.entries()].filter(([, m]) => m.status === 'pending' || m.status === 'printing').sort((a, b) => a[1].measuredAt.localeCompare(b[1].measuredAt)).map(([u, m]) => s.item(u, m));
    return ok({ items, total: s.listTotal ?? items.length });
  }
  if (rpc === 'xa_vai_measure_search') {
    const items = [...s.measures.entries()].filter(([, m]) => m.status === 'printed' && (!body.p_item_code || m.itemCode === body.p_item_code) && (!body.p_sku || m.sku === body.p_sku)).map(([u, m]) => s.item(u, m));
    return ok({ items, total: items.length, truncated: false });
  }
  if (rpc === 'xa_vai_measure_save') {
    if ('p_sku' in body) return noFn();
    if (s.mode === 'deny') return denied();
    const u = body.p_group_uid, d = s.details.get(u), m = s.measures.get(u);
    if (!d) return fail('GROUP_UID_NOT_READY', 'Group UID chưa có trong dữ liệu');
    if (!(Number.isInteger(body.p_actual_mm) && body.p_actual_mm > 0 && body.p_actual_mm <= 100000000)) return fail('INVALID_QTY', 'Mét thực tế phải lớn hơn 0 và không quá 100.000 m');
    if (m && m.status !== 'pending') return fail('NOT_PENDING', 'UID đã gửi in');
    if (m && !body.p_replace) return fail('ALREADY_MEASURED', 'UID đã có mét', { item: s.item(u, m) });
    if (m) { m.actualMm = body.p_actual_mm; m.measuredAt = new Date().toISOString(); return ok({ item: s.item(u, m), replaced: true }); }
    s.measure(u, body.p_actual_mm);
    return ok({ item: s.item(u, s.measures.get(u)), replaced: false });
  }
  if (rpc === 'xa_vai_measure_delete') {
    if (s.mode === 'deny') return denied();
    const m = s.measures.get(body.p_group_uid);
    if (!m) return fail('NOT_FOUND', 'Không có'); if (m.status !== 'pending') return fail('NOT_PENDING', 'Đã gửi in');
    s.measures.delete(body.p_group_uid); return ok({ groupUid: body.p_group_uid });
  }
  if (rpc === 'xa_vai_print_enqueue') {
    if (s.mode === 'deny') return denied();
    // Máy chủ từ chối ở tầng HTTP (4xx, vd hàm chưa có / tham số sai): web phải báo "Chưa gửi được", không "Chưa rõ".
    if (s.mode === 'http404') return noFn();
    if (s.nonces.has(body.p_nonce)) return ok({ ...s.nonces.get(body.p_nonce), duplicate: true });
    const rows = body.p_uids.map(u => [u, s.measures.get(u)]);
    if (rows.some(([, m]) => !m)) return fail('NOT_FOUND', 'Không có');
    if (rows.some(([, m]) => m.status !== (body.p_reprint ? 'printed' : 'pending'))) return fail('NOT_PENDING', 'Sai trạng thái');
    const code = String(body.p_item_code ?? '').trim().toUpperCase();
    if (!body.p_reprint && !CODE_RE.test(code)) return fail('INVALID_ITEM_CODE', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)');
    if (s.mode === 'badcode' && !body.p_reprint) return fail('INVALID_ITEM_CODE', 'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)');
    if (body.p_reprint) { const codes = new Set(rows.map(([, m]) => m.itemCode || '')); if (codes.size !== 1 || codes.has('')) return fail('MIXED_ITEM_CODE', 'Mỗi phiếu một mã hàng', { itemCodes: [...codes].filter(Boolean) }); }
    const id = `00000000-0000-4000-8000-${String(s.jobs.size + 1).padStart(12, '0')}`;
    s.jobs.set(id, { status: 'queued', uids: body.p_uids, reprint: body.p_reprint });
    if (!body.p_reprint) rows.forEach(([, m]) => { m.status = 'printing'; m.jobId = id; m.itemCode = code; });
    const data = { id, status: 'queued', duplicate: false, count: rows.length };
    s.nonces.set(body.p_nonce, data);
    return ok(data);
  }
  if (rpc === 'print_job_status') { const j = s.jobs.get(body.p_job_id); return j ? ok({ id: body.p_job_id, status: j.status, errorCode: j.errorCode || null, errorMessage: j.errorMessage || null, result: j.result || null }) : fail('NOT_FOUND', 'Không có lệnh'); }
  if (rpc === 'print_queue_status') return ok({ queued: 0, queuedCopies: 0, queuedA4: 0, active: 0, agents: [
    { id: 'may-kho-01', capabilities: ['sku:v1', 'group_uid:v1'], lastSeenAt: ago(0.1), state: { printer: { blocked: false } } },
    { id: 'may-a4-01', capabilities: ['xa_vai_sheet:v1'], lastSeenAt: s.a4Seen || ago(0.1), state: { printer: { blocked: false } } }] });
  return json({ ok: true, data: {} });
});
// Agent giả in xong: lệnh queued → completed, UID printing → printed (trigger máy chủ, giữ item_code).
const finishJobs = (s, result = { spoolConfirmed: true }) => { for (const [id, j] of s.jobs) if (j.status === 'queued') { j.status = 'completed'; j.result = result; for (const [, m] of s.measures) if (m.jobId === id && m.status === 'printing') { m.status = 'printed'; m.printedAt = new Date().toISOString(); } } };
// Agent giả báo lỗi: lệnh failed, trigger trả UID về "Chờ in" và xoá item_code (lệnh in lại không đổi dòng nào).
const failJob = (s, id, errorCode, errorMessage) => { const j = s.jobs.get(id); j.status = 'failed'; j.errorCode = errorCode; j.errorMessage = errorMessage; for (const [, m] of s.measures) if (m.jobId === id && m.status === 'printing') { m.status = 'pending'; m.jobId = null; m.itemCode = null; } };

const calls = (s, rpc) => s.calls.filter(c => c.rpc === rpc);
const waitFor = async (fn, what, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(50); } assert.fail(`hết giờ chờ: ${what}`); };
const msg = page => page.locator('#xa-vai-message').innerText();
const waitMsg = (page, re, ms = 6000) => page.waitForFunction(r => new RegExp(r).test(document.getElementById('xa-vai-message').textContent), re.source, { timeout: ms }).catch(async e => { throw new Error(`chờ /${re.source}/, đang là "${await msg(page)}" (${e.message.split(/\r?\n/)[0]})`); });
const focused = page => page.evaluate(() => document.activeElement?.id || '');
const shot = async (page, name) => { if (SHOTS) { await sleep(250); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); } };
const mh = page => page.locator('#xa-vai-mh-dialog');
// Bấm In (hoặc In lại) → khung nhập Mã hàng → (gõ mã) → In.
const openCode = async (page, btn = '#xa-vai-print') => { await page.locator(btn).click(); await mh(page).waitFor({ state: 'visible' }); };
const submitCode = async (page, code) => { if (code !== undefined) await page.locator('#xa-vai-mh-code').fill(code); await page.locator('#xa-vai-mh-ok').click(); };
const printCode = async (page, code) => { await openCode(page); await submitCode(page, code); await mh(page).waitFor({ state: 'hidden' }); };
const chibiGone = page => page.waitForFunction(() => { const o = document.getElementById('print-chibi-overlay'); return !o || o.hidden; }, null, { timeout: 6000 });
const statusCalls = (s, id) => calls(s, 'print_job_status').filter(c => !id || c.body.p_job_id === id).length;
// Âm báo: đếm lệnh PrintSkuScanCue.play (không phát tiếng thật).
const spyCue = page => page.evaluate(() => { window.__cues = []; window.PrintSkuScanCue.play = tone => { window.__cues.push(tone); }; });
const cues = page => page.evaluate(() => window.__cues);
const setHidden = (page, hidden) => page.evaluate(h => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);

async function newPage(browser, width) {
  const mobile = width < 800;
  const context = await browser.newContext({ viewport: { width, height: mobile ? 800 : 900 }, isMobile: mobile, hasTouch: mobile, acceptDownloads: true });
  await context.addInitScript(token => { if (!sessionStorage.getItem('xv-init')) { sessionStorage.setItem('xv-init', '1'); localStorage.setItem('tb-khoa', token); } }, TOKEN);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
  return { context, page, errors };
}
const scan = async (page, value) => { await chibiGone(page); await page.locator('#xa-vai-code').fill(value); await page.locator('#xa-vai-code').press('Enter'); };
const typeMeters = async (page, value) => { await chibiGone(page); await page.locator('#xa-vai-meters').fill(value); await page.locator('#xa-vai-meters').press('Enter'); };

async function desktop(browser) {
  const { context, page, errors } = await newPage(browser, 1280);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  // Ba tab, không còn tab cũ; tab Quét không còn phần Mã hàng-là-SKU, Chờ in không còn công tắc "Tất cả SKU"
  assert.deepEqual(await page.locator('#xa-vai-screen .cut-tab').evaluateAll(n => n.map(b => b.id)), ['xa-vai-tab-scan', 'xa-vai-tab-queue', 'xa-vai-tab-printed']);
  assert.equal(await page.locator('#xa-vai-tab-open, #xa-vai-tab-done').count(), 0, 'gỡ tab Đang xả / Đã xả xong');
  assert.equal(await page.locator('#xa-vai-sku-code, #xa-vai-sku-card, #xa-vai-sku-change, #xa-vai-all').count(), 0, 'bỏ ô SKU / Đổi mã / công tắc Tất cả SKU');
  await waitFor(() => calls(s, 'xa_vai_measure_search').length && calls(s, 'xa_vai_measure_list').length, 'tải Chờ in + Đã in khi vào màn');
  const list0 = calls(s, 'xa_vai_measure_list')[0].body;
  assert.equal(list0.p_status, 'queue'); assert.equal('p_sku' in list0, false, 'list không gửi p_sku'); assert.equal(list0.p_item_code ?? null, null, 'Chờ in không lọc mã hàng');
  const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  const search0 = calls(s, 'xa_vai_measure_search')[0].body;
  assert.equal(search0.p_date_from, today, 'Đã in mặc định từ hôm nay'); assert.equal(search0.p_date_to, today);
  for (const name of ['xa_vai_measure_list', 'xa_vai_measure_search']) assert.ok(calls(s, name).every(c => !('p_access_token' in c.body)), `${name} (đọc) không gửi khoá máy`);
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'vào màn con trỏ ở ô Group UID');
  await shot(page, '1280-quet-trong');
  // Quét UID → thẻ UID + con trỏ sang ô mét
  await scan(page, uid(1));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  const card = (await page.locator('#xa-vai-uid').innerText()).replace(/\s+/g, ' ');
  assert.match(card, new RegExp(uid(1))); assert.match(card, new RegExp(SKU)); assert.match(card, /L1/); assert.match(card, /R1/); assert.match(card, /60,76/);
  await waitFor(async () => await focused(page) === 'xa-vai-meters', 'con trỏ sang ô mét');
  await shot(page, '1280-quet-uid');
  await typeMeters(page, '60,5');
  await waitMsg(page, /Đã lưu 1028260000000001/);
  const save1 = calls(s, 'xa_vai_measure_save')[0].body;
  assert.deepEqual({ ...save1 }, { p_access_token: TOKEN, p_group_uid: uid(1), p_actual_mm: 60500, p_replace: false }, 'lưu mét: khoá máy + mm nguyên, không p_sku');
  assert.equal(await page.locator('#xa-vai-saved').textContent(), '1', 'đếm UID đã lưu của phiên');
  assert.equal(await page.locator('#xa-vai-meter-form').isHidden(), true, 'lưu xong thì ẩn ô mét');
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'lưu xong con trỏ về ô quét');
  // Lệch > 20%: hỏi xác nhận (Nhập lại → không ghi; Lưu → ghi)
  await scan(page, uid(2));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  await typeMeters(page, '30');
  const whd = page.locator('dialog.whd');
  await whd.waitFor({ state: 'visible' });
  assert.match(await whd.locator('.whd-title').textContent(), /lệch hơn 20%/);
  assert.match(await whd.locator('.whd-facts').innerText(), /50,00/);
  await whd.locator('.whd-cancel').click();
  await sleep(200);
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1, 'Nhập lại thì chưa ghi');
  await page.locator('#xa-vai-meters').press('Enter');
  await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
  await waitMsg(page, /Đã lưu 1028260000000002/);
  assert.equal(calls(s, 'xa_vai_measure_save').pop().body.p_actual_mm, 30000);
  // Lệch theo mm: hệ thống 60.000 mm; 49,5 m gửi đúng 49.500 mm; dòng chênh lệch khi gõ theo mm
  await scan(page, uid(6));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  await page.locator('#xa-vai-meters').fill('49,5');
  assert.equal(await page.locator('#xa-vai-diff').innerText(), 'Chênh lệch −10,50 m', 'chênh lệch khi gõ tính theo mm, không còn độ co %');
  assert.equal(await page.locator('#xa-vai-diff').getAttribute('data-tone'), null, 'lệch ≤ 20% không tô cảnh báo');
  await page.locator('#xa-vai-meters').press('Enter');
  await waitMsg(page, /Đã lưu 1028260000000006 · 49,50 m/);
  assert.equal(calls(s, 'xa_vai_measure_save').pop().body.p_actual_mm, 49500, '49,5 m → 49500 mm');
  await page.locator(`#xa-vai-tab-queue`).click();
  await page.waitForFunction(u => document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"]`), uid(6));
  await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(6)}"] [data-act="delete"]`).click();
  await page.locator('dialog.whd .whd-ok').click();
  await page.waitForFunction(u => !document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"]`), uid(6));
  await page.locator('#xa-vai-tab-scan').click();
  // UID của SKU khác (V3): quét và lưu bình thường, không còn chặn "Khác mã hàng"
  await scan(page, uid(9));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  assert.match(await page.locator('#xa-vai-uid').innerText(), new RegExp(SKU2));
  assert.notEqual(await page.locator('#xa-vai-uid').getAttribute('data-tone'), 'bad', 'UID SKU khác không bị tô đỏ');
  await typeMeters(page, '19,5');
  await waitMsg(page, /Đã lưu 1028260000000009/);
  // ALREADY_MEASURED (máy khác vừa lưu sau lúc tra) → hỏi thay số → lưu lại với p_replace
  await scan(page, uid(3));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  s.measure(uid(3), 39000);
  await typeMeters(page, '38,4');
  await whd.waitFor({ state: 'visible' });
  assert.match(await whd.locator('.whd-title').textContent(), /đã có mét/);
  assert.match(await whd.locator('.whd-facts').innerText(), /39,00/);
  await whd.locator('.whd-ok').click();
  await waitMsg(page, /Đã sửa 1028260000000003/);
  const saves3 = calls(s, 'xa_vai_measure_save').filter(c => c.body.p_group_uid === uid(3)).map(c => c.body.p_replace);
  assert.deepEqual(saves3, [false, true], 'ALREADY_MEASURED → lưu lại với p_replace=true');
  // UID đã có mét (Chờ in): hiện số cũ, sửa = p_replace
  await scan(page, uid(1));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#xa-vai-meters').inputValue(), '60,50', 'UID đã có mét thì hiện số cũ');
  await typeMeters(page, '61');
  await waitMsg(page, /Đã sửa 1028260000000001/);
  assert.equal(calls(s, 'xa_vai_measure_save').pop().body.p_replace, true);
  // Mất mạng khi GHI: "chưa rõ đã ghi hay chưa" rồi tra lại UID
  await scan(page, uid(4));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  const lookups = calls(s, 'xa_vai_measure_lookup').length;
  s.abortOnce.add('xa_vai_measure_save');
  await typeMeters(page, '29,9');
  await waitMsg(page, /Chưa rõ đã ghi hay chưa/);
  await waitFor(() => calls(s, 'xa_vai_measure_lookup').length > lookups, 'tra lại UID sau lỗi mạng');
  assert.equal(calls(s, 'xa_vai_measure_lookup').pop().body.p_group_uid, uid(4));
  assert.equal(await page.locator('#xa-vai-meters').inputValue(), '29,9', 'giữ số đang nhập để bấm lại');
  // Máy chưa kích hoạt: hộp kích hoạt mở, báo trong dòng, giữ số mét
  s.mode = 'deny';
  await page.locator('#xa-vai-meters').press('Enter');
  await page.locator('#pdv-dialog').waitFor({ state: 'visible' });
  await waitMsg(page, /Máy chưa kích hoạt/);
  assert.equal(await page.locator('#xa-vai-message .xv-activate').count(), 1, 'có nút mở lại ô Kích hoạt máy');
  assert.equal(await page.locator('#xa-vai-meters').inputValue(), '29,9');
  await page.locator('#pdv-cancel').click();
  s.mode = 'ok';
  await page.locator('#xa-vai-meters').press('Enter');
  await waitMsg(page, /Đã lưu 1028260000000004/);
  assert.equal(await page.locator('#xa-vai-saved').textContent(), '7');
  assert.ok(calls(s, 'xa_vai_measure_save').every(c => !('p_sku' in c.body)), 'save không gửi p_sku');

  // ---- Chờ in: mọi SKU, cột SKU luôn hiện ----
  await page.locator('#xa-vai-tab-queue').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 5);
  assert.equal(await page.locator('#xa-vai-queue-count').textContent(), '5');
  assert.equal(await page.locator('#xa-vai-queue-rows input[data-pick]:checked').count(), 5, 'mặc định chọn hết UID chờ in');
  assert.match((await page.locator('#xa-vai-queue-total').innerText()).replace(/\s+/g, ' '), /5 UID.*178,80 m/, 'tổng UID + mét thực tế');
  const skuHead = await page.locator('#xa-vai-queue-rows').evaluate(tb => [...tb.closest('table').querySelectorAll('thead th')].map(th => ({ t: th.textContent.trim(), v: getComputedStyle(th).display !== 'none' })));
  assert.ok(skuHead.some(h => h.t === 'SKU' && h.v), 'cột SKU luôn hiện ở Chờ in');
  assert.match(await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(9)}"]`).innerText(), new RegExp(SKU2));
  await page.waitForFunction(() => /Máy in A4 sẵn sàng/.test(document.getElementById('xa-vai-printer').textContent));
  assert.equal(await page.locator('#xa-vai-printer').getAttribute('data-tone'), 'ok');
  await shot(page, '1280-cho-in');
  // Sửa: về tab Quét với UID đó
  await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(2)}"] [data-act="edit"]`).click();
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#xa-vai-tab-scan').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#xa-vai-meters').inputValue(), '30,00');
  assert.equal(await page.locator('#xa-vai-uid-dialog').evaluate(d => d.open), true, 'Sửa từ Chờ in mở pop-up nhập mét');
  await page.locator('#xa-vai-uid-close').click(); // pop-up modal chặn bấm tab: đóng trước
  await page.locator('#xa-vai-tab-queue').click();
  // Xoá: hỏi xác nhận rồi gọi xa_vai_measure_delete có khoá máy
  await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(2)}"] [data-act="delete"]`).click();
  await whd.waitFor({ state: 'visible' }); await whd.locator('.whd-ok').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 4);
  assert.equal(calls(s, 'xa_vai_measure_delete')[0].body.p_access_token, TOKEN);
  const order = await page.locator('#xa-vai-queue-rows tr[data-uid]').evaluateAll(trs => trs.map(tr => tr.dataset.uid));
  assert.deepEqual(order.slice().sort(), [uid(1), uid(3), uid(4), uid(9)]);
  await page.locator('#xa-vai-copies').selectOption('2');
  assert.match((await page.locator(`#xa-vai-queue-rows tr[data-uid="${uid(1)}"]`).innerText()).replace(/\s+/g, ' '), /60,76 61,00/, 'Chờ in: mét = mm ÷ 1000');
  // In A4 → khung nhập Mã hàng: Huỷ thì không gửi
  await openCode(page);
  assert.match((await mh(page).innerText()).replace(/\s+/g, ' '), /4 UID.*2 bản/, 'khung Mã hàng hiện số UID và số bản');
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), '', 'máy chưa có mã lần trước thì ô trống');
  await waitFor(async () => await focused(page) === 'xa-vai-mh-code', 'con trỏ vào ô Mã hàng');
  await shot(page, '1280-ma-hang');
  await page.locator('#xa-vai-mh-cancel').click();
  await mh(page).waitFor({ state: 'hidden' });
  assert.equal(calls(s, 'xa_vai_print_enqueue').length, 0, 'Huỷ thì không gửi');
  // Sai mẫu (khoảng trắng, chữ có dấu) → báo trong khung, không gửi
  await openCode(page);
  await submitCode(page, 'CW SH02');
  await page.waitForFunction(() => /Mã hàng chỉ gồm chữ, số/.test(document.getElementById('xa-vai-mh-error').textContent));
  assert.equal(await mh(page).isVisible(), true, 'sai mẫu thì khung vẫn mở');
  await submitCode(page, 'ÁO01');
  await page.waitForFunction(() => /Mã hàng chỉ gồm chữ, số/.test(document.getElementById('xa-vai-mh-error').textContent));
  await shot(page, '1280-ma-hang-sai');
  assert.equal(calls(s, 'xa_vai_print_enqueue').length, 0, 'sai mẫu thì không gửi');
  // Gõ chữ thường → tự viết hoa; lỗi mạng lần đầu → "Chưa rõ" + tải lại thật → Thử lại dùng lại nonce và mã hàng
  await page.locator('#xa-vai-mh-code').fill('cwsh02');
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'CWSH02', 'mã hàng tự viết hoa');
  s.abortOnce.add('xa_vai_print_enqueue');
  const lists0 = calls(s, 'xa_vai_measure_list').length;
  await page.locator('#xa-vai-mh-ok').click();
  await mh(page).waitFor({ state: 'hidden' });
  await waitMsg(page, /^Chưa rõ lệnh in đã gửi hay chưa — đã tải lại danh sách$/);
  assert.doesNotMatch(await msg(page), /chưa gửi được|fetch|failed|error|network|HTTP/i, 'lỗi mạng khi In: không chữ Anh, không "chưa gửi được"');
  assert.ok(calls(s, 'xa_vai_measure_list').length > lists0, 'lỗi mạng khi In thì tải lại hàng chờ');
  await page.waitForFunction(() => document.getElementById('xa-vai-print').textContent.trim() === 'Thử lại');
  const sawChibi = page.waitForFunction(() => { const o = document.getElementById('print-chibi-overlay'); return o && !o.hidden; }, null, { timeout: 6000 }).then(() => true, () => false);
  await openCode(page);
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'CWSH02', 'Thử lại: điền sẵn mã hàng của lần gửi dở');
  await submitCode(page);
  assert.equal(await sawChibi, true, 'lệnh in A4 hiện lớp phủ chibi chung');
  await waitMsg(page, /Đã gửi in A4 4 UID/);
  const [e1, e2] = calls(s, 'xa_vai_print_enqueue').map(c => c.body);
  assert.deepEqual(e2.p_uids, order, 'gửi đúng UID theo thứ tự hàng chờ — hai SKU chung một phiếu');
  assert.equal(new Set(e2.p_uids.map(u => s.measures.get(u).sku)).size, 2, 'UID hai SKU in chung một lệnh');
  assert.equal(e2.p_item_code, 'CWSH02', 'gửi p_item_code viết hoa');
  assert.equal(e2.p_copies, 2); assert.equal(e2.p_reprint, false); assert.equal(e2.p_access_token, TOKEN);
  assert.ok(e2.p_nonce && e2.p_nonce === e1.p_nonce, 'Thử lại sau lỗi mạng dùng lại nonce');
  assert.equal(await page.evaluate(() => localStorage.getItem('xa-vai-mahang-v1')), 'CWSH02', 'gửi được thì nhớ mã hàng theo máy');
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows input[data-pick]:disabled').length === 4);
  assert.match(await page.locator('#xa-vai-queue-rows').innerText(), /Đang in/, 'UID đã gửi hiện "Đang in", không chọn được');
  // Agent in xong → UID sang Đã in
  finishJobs(s);
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 0, null, { timeout: 9000 });
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length === 4, null, { timeout: 9000 });
  assert.equal(await page.locator('#xa-vai-found').textContent(), '4');
  // Lần In sau: khung điền sẵn mã lần trước; đổi mã → nonce mới, p_item_code mới
  await page.locator('#xa-vai-tab-scan').click();
  await scan(page, uid(5));
  await page.waitForFunction(u => document.getElementById('xa-vai-uid').textContent.includes(u) && !document.getElementById('xa-vai-meter-form').hidden, uid(5)); // thẻ UID của lần Sửa trước còn trên tab Quét: chờ đúng UID mới
  assert.match(await page.locator('#xa-vai-uid').innerText(), /—/, 'mét hệ thống không quy đổi được thì hiện —');
  await typeMeters(page, '12');
  await waitMsg(page, /Đã lưu 1028260000000005/);
  await page.locator('#xa-vai-tab-queue').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows input[data-pick]:checked').length === 1);
  await openCode(page);
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'CWSH02', 'nhớ mã hàng lần trước');
  await submitCode(page, 'test01');
  await waitMsg(page, /Đã gửi in A4 1 UID/);
  const e3 = calls(s, 'xa_vai_print_enqueue').pop().body;
  assert.notEqual(e3.p_nonce, e2.p_nonce, 'lần bấm mới có nonce mới'); assert.equal(e3.p_item_code, 'TEST01');
  assert.equal(await page.evaluate(() => localStorage.getItem('xa-vai-mahang-v1')), 'TEST01');
  finishJobs(s);
  // Máy in A4 mất kết nối (> 45 giây)
  s.a4Seen = ago(2);
  await page.locator('#xa-vai-reload').click();
  await page.waitForFunction(() => /Mất kết nối máy in A4/.test(document.getElementById('xa-vai-printer').textContent));

  // ---- Đã in: lọc Mã hàng, in lại (một mã hàng mỗi phiếu), Excel ----
  await page.locator('#xa-vai-tab-printed').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length === 5, null, { timeout: 9000 });
  const heads = await page.locator('#xa-vai-printed-rows').evaluate(tb => [...tb.closest('table').querySelectorAll('thead th')].map(th => th.textContent.trim()));
  assert.deepEqual(heads, ['Chọn', 'Mã hàng', 'Group UID', 'SKU', 'Lot', 'Roll', 'Mét HT', 'Mét TT', 'Giờ in']);
  const row1 = (await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(1)}"]`).innerText()).replace(/\s+/g, ' ');
  assert.match(row1, /CWSH02/); assert.match(row1, new RegExp(SKU)); assert.match(row1, /60,76 61,00/, 'Đã in: mét = mm ÷ 1000');
  await shot(page, '1280-da-in');
  // Ô lọc Mã hàng: chỉ viết hoa, KHÔNG xoá ký tự sai (dán CW/SH02 không được âm thầm thành CWSH02); sai mẫu → báo, không gọi RPC
  await page.locator('#xa-vai-item').fill(' cw/sh02 ');
  assert.equal(await page.locator('#xa-vai-item').inputValue(), ' CW/SH02 ', 'ô lọc Mã hàng tự viết hoa, giữ nguyên ký tự sai');
  const searchesBad = calls(s, 'xa_vai_measure_search').length;
  await page.locator('#xa-vai-item').press('Enter');
  await waitMsg(page, /Mã hàng chỉ gồm chữ, số, \. _ - \(tối đa 40 ký tự\)/);
  assert.equal(await page.locator('#xa-vai-message').getAttribute('data-tone'), 'error');
  assert.equal(await page.locator('#xa-vai-item').getAttribute('aria-invalid'), 'true', 'ô lọc đánh dấu sai');
  await sleep(300);
  assert.equal(calls(s, 'xa_vai_measure_search').length, searchesBad, 'mã sai mẫu thì không gọi xa_vai_measure_search');
  await page.locator('#xa-vai-item').fill(' cwsh02 ');
  assert.equal(await page.locator('#xa-vai-item').inputValue(), ' CWSH02 ', 'ô lọc Mã hàng tự viết hoa');
  const searches = calls(s, 'xa_vai_measure_search').length;
  await page.locator('#xa-vai-item').press('Enter');
  await waitFor(() => calls(s, 'xa_vai_measure_search').length > searches, 'tìm theo Mã hàng');
  const sq = calls(s, 'xa_vai_measure_search').pop().body;
  assert.equal(sq.p_item_code, 'CWSH02'); assert.equal(sq.p_sku ?? null, null); assert.equal(sq.p_date_from, today);
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length === 4);
  // Bấm một mã hàng trong bảng → chọn mọi dòng cùng mã
  await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(3)}"] [data-code]`).click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows input[data-pick]:checked').length === 4);
  // In lại: máy chủ ĐÃ ghi lệnh rồi mới mất phản hồi (hết giờ) → "Chưa rõ" → Thử lại gửi đúng nonce cũ → máy chủ trả lệnh cũ, không in trùng
  const jobs0 = s.jobs.size;
  s.abortAfter.add('xa_vai_print_enqueue');
  await page.locator('#xa-vai-reprint').click();
  await waitMsg(page, /^Chưa rõ lệnh in đã gửi hay chưa — đã tải lại danh sách$/);
  assert.equal(s.jobs.size, jobs0 + 1, 'máy chủ đã ghi lệnh in lại');
  await page.waitForFunction(() => document.getElementById('xa-vai-reprint').textContent.trim() === 'Thử lại');
  await page.locator('#xa-vai-reprint').click();
  await waitMsg(page, /Đã gửi in lại 4 UID/);
  await chibiGone(page); // lớp phủ chibi giữ con trỏ ~0,7 s: gõ vào ô lọc khi nó còn mở thì phím không tới ô
  const [r1, re] = calls(s, 'xa_vai_print_enqueue').slice(-2).map(c => c.body);
  assert.ok(re.p_nonce && re.p_nonce === r1.p_nonce, 'Thử lại sau "chưa rõ" gửi đúng nonce cũ');
  assert.equal(s.jobs.size, jobs0 + 1, 'Thử lại cùng nonce không tạo lệnh in thứ hai');
  assert.deepEqual(re.p_uids.slice().sort(), [uid(1), uid(3), uid(4), uid(9)]); assert.equal(re.p_reprint, true); assert.equal(re.p_copies, 1);
  finishJobs(s);
  // Chọn lẫn hai mã hàng → báo "Mỗi phiếu một mã hàng", không gửi
  await page.locator('#xa-vai-item').fill('');
  await page.locator('#xa-vai-item').press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length === 5);
  assert.equal(calls(s, 'xa_vai_measure_search').pop().body.p_item_code, null, 'ô lọc rỗng gửi p_item_code null');
  await page.locator('#xa-vai-printed-all').check(); await page.locator('#xa-vai-printed-all').uncheck(); // đang chọn 4/5 (lưng chừng): chọn hết rồi bỏ hết
  await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(1)}"] input[data-pick]`).check();
  await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(5)}"] input[data-pick]`).check();
  const before = calls(s, 'xa_vai_print_enqueue').length;
  await page.locator('#xa-vai-reprint').click();
  await waitMsg(page, /Mỗi phiếu một mã hàng/);
  assert.equal(await page.locator('#xa-vai-message').getAttribute('data-tone'), 'error');
  assert.equal(calls(s, 'xa_vai_print_enqueue').length, before, 'chọn lẫn mã hàng thì không gửi');
  // Máy chủ báo MIXED_ITEM_CODE (dữ liệu trên màn đã cũ) → cùng câu báo
  await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(5)}"] input[data-pick]`).uncheck();
  await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(3)}"] input[data-pick]`).check();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows input[data-pick]:checked').length === 2);
  await page.evaluate(() => { document.getElementById('xa-vai-message').textContent = ''; });
  s.measures.get(uid(3)).itemCode = 'TEST01';
  await page.locator('#xa-vai-reprint').click();
  await waitMsg(page, /Chưa gửi được lệnh in: Mỗi phiếu một mã hàng/);
  assert.equal(calls(s, 'xa_vai_print_enqueue').length, before + 1, 'máy chủ từ chối MIXED_ITEM_CODE');
  s.measures.get(uid(3)).itemCode = 'CWSH02';
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#xa-vai-export').click()]);
  assert.match(download.suggestedFilename(), /\.xlsx$/);
  const book = readXlsx(require('node:fs').readFileSync(await download.path()));
  assert.deepEqual(book.table[0], ['STT', 'Mã hàng', 'SKU', 'Group UID', 'Lot', 'Roll', 'Hệ thống (mm)', 'Thực tế (mm)', 'Chênh lệch (mm)', 'Giờ nhập', 'Giờ in'], 'Excel: cột mm, không cột co');
  assert.equal(book.table.length, 6, 'tiêu đề + 5 dòng');
  const x1 = book.table.find(r => r[3] === uid(1));
  assert.ok(x1, 'Group UID là chữ đủ 16 số'); assert.equal(x1[1], 'CWSH02'); assert.equal(x1[2], SKU); assert.equal(x1[6], 60758); assert.equal(x1[7], 61000); assert.equal(x1[8], 242, 'mm nguyên: thực tế − hệ thống');
  const x4 = book.table.find(r => r[3] === uid(4));
  assert.equal(x4[6], 30000); assert.equal(x4[7], 29900); assert.equal(x4[8], -100, 'chênh lệch âm');
  const x5 = book.table.find(r => r[3] === uid(5));
  assert.equal(x5[6], ''); assert.equal(x5[7], 12000); assert.equal(x5[8], '', 'không có hệ thống thì ô chênh lệch trống');
  assert.ok(book.table.every(r => r.every(v => !/(^|\s)co(\s|$)|%/i.test(String(v)))), 'Excel không có độ co %');
  assert.equal(x5[1], 'TEST01');
  assert.ok(calls(s, 'xa_vai_measure_list').length && calls(s, 'xa_vai_measure_list').every(c => !('p_access_token' in c.body)), 'xa_vai_measure_list (đọc) không gửi khoá máy');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '1280 px không tràn ngang');
  assert.deepEqual(errors, [], 'không lỗi console');
  await context.close();
  console.log('PASS 1280px: quét mọi SKU → mét → lưu (khoá máy, không p_sku), lệch > 20% hỏi, ALREADY_MEASURED → thay, sửa UID Chờ in, mất mạng "chưa rõ" + tra lại, ACCESS_DENIED, Chờ in (mọi SKU, cột SKU, chọn/sửa/xoá/tổng/máy in A4), khung Mã hàng (Huỷ, sai mẫu, viết hoa, nhớ mã), In A4 hai SKU một phiếu (nonce, Thử lại cùng nonce + mã, chibi) → Đã in lọc Mã hàng, chọn theo mã, In lại, một mã hàng mỗi phiếu (máy + máy chủ), Excel Mã hàng + SKU');
}

async function bigQueue(browser) {
  const { context, page, errors } = await newPage(browser, 1280);
  const s = makeServer();
  for (let i = 0; i < 150; i++) s.measure(uid(500 + i), 9500);
  await mock(page, s);
  await page.addInitScript(() => localStorage.setItem('xa-vai-mahang-v1', 'TEST01'));
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await page.locator('#xa-vai-tab-queue').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows input[data-pick]:checked').length === 150);
  await openCode(page);
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'TEST01', 'điền sẵn mã hàng lưu trên máy');
  await page.locator('#xa-vai-mh-code').press('Enter');
  await waitMsg(page, /Đã gửi in A4 150 UID · TEST01 · 2 lệnh/);
  const sent = calls(s, 'xa_vai_print_enqueue').map(c => c.body);
  assert.deepEqual(sent.map(b => b.p_uids.length), [100, 50], '> 100 UID chia lệnh ≤ 100');
  assert.deepEqual(sent.map(b => b.p_item_code), ['TEST01', 'TEST01'], 'các lệnh chia nhỏ dùng cùng mã hàng');
  const base = sent[0].p_nonce.replace(/-1$/, '');
  assert.deepEqual(sent.map(b => b.p_nonce), [`${base}-1`, `${base}-2`], 'nonce = nonce gốc + -1, -2');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS > 100 UID: tự chia 100 + 50, nonce gốc -1/-2, cùng mã hàng (điền sẵn từ máy)');
}

// Theo dõi lệnh in (review vòng 2): lệnh máy khác ở tab Quét không đè dòng báo / không phát âm; ở tab khác báo không âm; tab ẩn thôi hỏi
// print_job_status, hiện lại hỏi tiếp; hết dòng printing thì thôi hỏi; "Hiện n / tổng"; lỗi 4xx ("Chưa gửi được", bỏ nonce) khác lỗi mạng
// ("Chưa rõ", giữ nonce, chỉ nói "đã tải lại" khi tải lại thật xong); lệnh in lại lỗi không nói "UID về Chờ in".
async function tracking(browser) {
  const { context, page, errors } = await newPage(browser, 1280);
  const s = makeServer();
  const job = n => `00000000-0000-4000-8000-0000000000a${n}`;
  s.measure(uid(1), 60500); s.measure(uid(2), 49800); s.measure(uid(3), 40100); s.measure(uid(9), 19000);
  s.foreignJob(job(1), [uid(1)]); s.foreignJob(job(2), [uid(2)]);
  s.listTotal = 250;
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await waitFor(() => calls(s, 'xa_vai_measure_list').length, 'tải Chờ in khi vào màn (không cần chọn mã)');
  await waitFor(() => statusCalls(s, job(2)), 'theo dõi lệnh máy khác ngay ở tab Quét');
  // Đang làm ở tab Quét: lệnh máy khác xong / lỗi chỉ tải lại danh sách — không đè dòng báo, không phát âm
  await spyCue(page);
  await scan(page, uid(4));
  await waitMsg(page, /^Đã tra 1028260000000004$/);
  await page.evaluate(() => { window.__cues = []; });
  const lists1 = calls(s, 'xa_vai_measure_list').length;
  failJob(s, job(2), 'SENT_UNCONFIRMED', 'Lệnh đã được gửi xuống máy in nhưng agent mất kết nối trước khi xác nhận.');
  finishJobs(s, { spoolConfirmed: false });
  await waitFor(() => calls(s, 'xa_vai_measure_list').length > lists1, 'lệnh máy khác xong thì tải lại Chờ in', 9000);
  await sleep(400);
  assert.equal(await msg(page), 'Đã tra 1028260000000004', 'lệnh máy khác không đè dòng báo của tab Quét');
  assert.deepEqual(await cues(page), [], 'lệnh máy khác không phát âm');
  // Chờ in: total > số dòng → "Hiện n / tổng" (pop-up nhập mét của UID vừa quét chặn bấm tab: đóng trước)
  await page.locator('#xa-vai-uid-close').click();
  await page.locator('#xa-vai-tab-queue').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 3);
  assert.match((await page.locator('#xa-vai-queue-total').innerText()).replace(/\s+/g, ' '), /Hiện 3 \/ 250/, 'total > số dòng → "Hiện n / tổng"');
  await shot(page, '1280-cho-in-hien-n-tong');
  s.listTotal = null;
  // Lệnh máy khác ở tab Chờ in: dòng sang Đã in không cần Tải lại, có báo nhưng không phát âm
  s.foreignJob(job(3), [uid(9)]);
  await page.locator('#xa-vai-reload').click();
  await page.waitForFunction(u => document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"] input[data-pick]`)?.disabled, uid(9));
  assert.equal(/Hiện/.test(await page.locator('#xa-vai-queue-total').innerText()), false, 'đủ dòng thì không báo "Hiện n / tổng"');
  await waitFor(() => statusCalls(s, job(3)), 'hỏi trạng thái lệnh của máy khác');
  await page.evaluate(() => { window.__xvReload = 0; window.__cues = []; document.getElementById('xa-vai-reload').addEventListener('click', () => { window.__xvReload += 1; }); });
  finishJobs(s, { spoolConfirmed: false });
  await page.waitForFunction(u => !document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"]`), uid(9), { timeout: 9000 });
  await page.waitForFunction(u => document.querySelector(`#xa-vai-printed-rows tr[data-uid="${u}"]`), uid(9), { timeout: 9000 });
  await waitMsg(page, /Đã gửi tới máy in A4 \(chưa xác nhận ra giấy\)/);
  assert.equal(await page.evaluate(() => window.__xvReload), 0, 'dòng sang Đã in không cần bấm Tải lại');
  s.foreignJob(job(4), [uid(3)]);
  await page.locator('#xa-vai-reload').click();
  await page.waitForFunction(u => document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"] input[data-pick]`)?.disabled, uid(3));
  await waitFor(() => statusCalls(s, job(4)), 'hỏi trạng thái lệnh thứ hai của máy khác');
  failJob(s, job(4), 'SENT_UNCONFIRMED', 'Agent mất kết nối.');
  await waitMsg(page, /Phiếu có thể đã in — kiểm tra máy in A4 trước khi in lại/, 9000);
  assert.equal(await page.locator('#xa-vai-message').getAttribute('data-tone'), 'warn');
  assert.deepEqual(await cues(page), [], 'lệnh máy khác ở tab khác: có báo, không phát âm');
  await page.waitForFunction(u => document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"] input[data-pick]`)?.disabled === false, uid(3), { timeout: 9000 });
  // Tab ẩn: thôi hỏi print_job_status; hiện lại: hỏi tiếp
  s.foreignJob(job(5), [uid(2)]);
  await page.locator('#xa-vai-reload').click();
  await waitFor(() => statusCalls(s, job(5)), 'theo dõi lệnh thứ ba');
  await setHidden(page, true);
  await sleep(800);
  const hiddenN = statusCalls(s);
  await sleep(4500);
  assert.equal(statusCalls(s), hiddenN, 'tab ẩn thì thôi hỏi trạng thái lệnh');
  await setHidden(page, false);
  await waitFor(() => statusCalls(s) > hiddenN, 'hiện tab lại thì hỏi tiếp', 4000);
  finishJobs(s);
  await page.waitForFunction(u => !document.querySelector(`#xa-vai-queue-rows tr[data-uid="${u}"]`), uid(2), { timeout: 9000 });
  // Không còn dòng printing: thôi hỏi trạng thái lệnh
  await sleep(1500);
  const polls = statusCalls(s);
  await sleep(3500);
  assert.equal(statusCalls(s), polls, 'hết dòng printing thì không hỏi print_job_status nữa');
  // Lỗi HTTP 4xx khi In: "Chưa gửi được lệnh in: …", bỏ nonce (lần sau nonce mới), nút không kẹt "Thử lại"
  s.measure(uid(4), 29000); s.measure(uid(6), 58000);
  await page.locator('#xa-vai-reload').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 3);
  await page.locator('#xa-vai-queue-all').check();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows input[data-pick]:checked').length === 3);
  // Máy chủ trả INVALID_ITEM_CODE: khung Mã hàng hiện lại với câu lỗi, giữ mã đã gõ; sửa xong In lại được
  s.mode = 'badcode';
  const enq0 = calls(s, 'xa_vai_print_enqueue').length;
  await openCode(page); await submitCode(page, 'TEST01');
  await page.waitForFunction(() => { const d = document.getElementById('xa-vai-mh-dialog'); return d.open && /Mã hàng chỉ gồm chữ, số/.test(document.getElementById('xa-vai-mh-error').textContent); });
  assert.equal(calls(s, 'xa_vai_print_enqueue').length, enq0 + 1, 'đã hỏi máy chủ một lần');
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'TEST01', 'giữ mã đã gõ');
  await page.locator('#xa-vai-mh-cancel').click();
  await mh(page).waitFor({ state: 'hidden' });
  s.mode = 'http404';
  await printCode(page, 'TEST01');
  await waitMsg(page, /^Chưa gửi được lệnh in: /);
  assert.doesNotMatch(await msg(page), /Chưa rõ/, '4xx không phải "chưa rõ"');
  assert.equal(await page.locator('#xa-vai-message').getAttribute('data-tone'), 'error');
  await page.waitForFunction(() => document.getElementById('xa-vai-print').textContent.trim() !== 'Thử lại');
  const nonceA = calls(s, 'xa_vai_print_enqueue').pop().body.p_nonce;
  assert.equal(await page.evaluate(() => localStorage.getItem('xa-vai-mahang-v1')), null, 'chưa gửi được thì chưa nhớ mã');
  // Lỗi mạng khi In + tải lại cũng lỗi: "Chưa rõ" + "Chưa tải lại được danh sách" (không nói "đã tải lại"), nút Thử lại (PrintSkuNotice) tải lại hàng chờ
  s.mode = 'ok';
  s.abortOnce.add('xa_vai_print_enqueue'); s.abortOnce.add('xa_vai_measure_list');
  await printCode(page, 'TEST01');
  await waitMsg(page, /^Chưa rõ lệnh in đã gửi hay chưa\. Chưa tải lại được danh sách$/);
  assert.doesNotMatch(await msg(page), /bấm Tải lại/, 'không câu hướng dẫn "bấm Tải lại"');
  const listsRetry = calls(s, 'xa_vai_measure_list').length;
  await page.locator('#xa-vai-message .ps-retry').click();
  await waitFor(() => calls(s, 'xa_vai_measure_list').length > listsRetry, 'nút Thử lại tải lại hàng chờ');
  const nonceB = calls(s, 'xa_vai_print_enqueue').pop().body.p_nonce;
  assert.notEqual(nonceB, nonceA, 'sau lỗi 4xx thì lần gửi sau có nonce mới');
  await page.waitForFunction(() => document.getElementById('xa-vai-print').textContent.trim() === 'Thử lại');
  await printCode(page);
  await waitMsg(page, /Đã gửi in A4 3 UID/);
  assert.equal(calls(s, 'xa_vai_print_enqueue').pop().body.p_nonce, nonceB, 'Thử lại sau lỗi mạng dùng lại nonce');
  finishJobs(s);
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 0, null, { timeout: 9000 });
  // In A4: máy chủ đã ghi rồi mới hết giờ → "Chưa rõ", tải lại thấy "Đang in" (printJobId) → theo dõi tới khi in xong
  s.measure(uid(5), 12000);
  await page.locator('#xa-vai-reload').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows input[data-pick]:checked').length === 1);
  s.abortAfter.add('xa_vai_print_enqueue');
  await printCode(page, 'TEST01');
  await waitMsg(page, /^Chưa rõ lệnh in đã gửi hay chưa — đã tải lại danh sách$/);
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows input[data-pick]:disabled').length === 1);
  finishJobs(s);
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 0, null, { timeout: 9000 });
  // Lệnh IN LẠI lỗi: "Lệnh in lại lỗi: …", không nói "UID về Chờ in"
  await page.locator('#xa-vai-tab-printed').click();
  await page.waitForFunction(u => document.querySelector(`#xa-vai-printed-rows tr[data-uid="${u}"]`), uid(5), { timeout: 9000 });
  await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(5)}"] input[data-pick]`).check();
  await page.locator('#xa-vai-reprint').click();
  await waitMsg(page, /Đã gửi in lại 1 UID/);
  const reId = [...s.jobs.keys()].pop();
  assert.equal(s.jobs.get(reId).reprint, true);
  failJob(s, reId, 'PRINT_ERROR', 'Kẹt giấy');
  await waitMsg(page, /^Lệnh in lại lỗi: Kẹt giấy$/, 9000);
  assert.doesNotMatch(await msg(page), /Chờ in/, 'lệnh in lại lỗi không nói "UID về Chờ in"');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS theo dõi: lệnh máy khác ở tab Quét không đè dòng báo / không âm, ở Chờ in báo không âm, dòng sang Đã in không cần Tải lại, spoolConfirmed=false, SENT_UNCONFIRMED, tab ẩn thôi hỏi / hiện hỏi lại, thôi hỏi khi hết printing, "Hiện n / tổng", 4xx "Chưa gửi được" (nonce mới) vs lỗi mạng "Chưa rõ" (tải lại lỗi → nút Thử lại), In "chưa rõ" (máy chủ đã ghi) → theo dõi, lệnh in lại lỗi');
}

// Giới hạn theo dõi (review vòng 3): agent A4 tắt, lệnh "queued" mãi → sau ~10 phút thôi hỏi print_job_status; Lưu mét (loadQueue → track) KHÔNG
// mở lại chuỗi hỏi; chỉ bấm Tải lại mới theo dõi lại. Tua thời gian: nhịp theo dõi tính bằng tổng các khoảng chờ đã hẹn (không đọc đồng hồ), nên
// trang này thu nhỏ mọi setTimeout ≥ 2,5 s 500 lần (2,5 s → 5 ms, 60 s → 120 ms). page.clock (Playwright 1.63) chạy mọi bộ hẹn giờ của cả trang
// theo thời gian giả: 10 phút giả mất > 4 phút thật rồi sập trình duyệt, nên không dùng.
async function watchLimit(browser) {
  const { context, page, errors } = await newPage(browser, 1280);
  const s = makeServer();
  const job = '00000000-0000-4000-8000-0000000000b1';
  s.measure(uid(1), 60500); s.foreignJob(job, [uid(1)]);
  await mock(page, s);
  await page.addInitScript(() => { const orig = window.setTimeout; window.setTimeout = (fn, ms, ...a) => orig(fn, Number(ms) >= 2500 ? Number(ms) / 500 : ms, ...a); });
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await waitFor(() => statusCalls(s, job) > 3, 'đang theo dõi lệnh kẹt');
  // Chờ tới khi thôi hỏi: số lần gọi đứng yên 1,5 s (khoảng hỏi lớn nhất sau thu nhỏ = 120 ms)
  let stopped = -1;
  await waitFor(async () => { const n = statusCalls(s, job); await sleep(2000); if (statusCalls(s, job) === n) { stopped = n; return true; } return false; }, 'thôi hỏi sau ~10 phút', 20000);
  assert.ok(stopped >= 30 && stopped <= 50, `hỏi khoảng 39 lần trong ~10 phút rồi dừng (đã hỏi ${stopped})`);
  // Lưu mét một UID khác → loadQueue → track(): không mở lại chuỗi hỏi
  const lists = calls(s, 'xa_vai_measure_list').length;
  await scan(page, uid(2));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  await typeMeters(page, '50');
  await waitMsg(page, /Đã lưu 1028260000000002/);
  await waitFor(() => calls(s, 'xa_vai_measure_list').length > lists, 'lưu xong tải lại Chờ in');
  await sleep(3500); // nhịp đầu sau khi thêm lệnh là 1,5 s (không bị thu nhỏ)
  assert.equal(statusCalls(s, job), stopped, 'Lưu mét không làm hỏi lại lệnh đã thôi theo dõi');
  // Bấm Tải lại → theo dõi lại
  await page.locator('#xa-vai-tab-queue').click();
  await page.locator('#xa-vai-reload').click();
  await waitFor(() => statusCalls(s, job) > stopped, 'bấm Tải lại thì theo dõi lại', 4000);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS giới hạn theo dõi: ~10 phút thôi hỏi, Lưu mét không hỏi lại, Tải lại theo dõi lại');
}
// QUÉT → TỰ TRA → POP-UP NHẬP MÉT (04/11/2026, yêu cầu trên điện thoại Honeywell): đủ 16 chữ số thì tự tra (không cần Enter hay "Tra UID"; mọi
// Group UID trong WMS đều 16 chữ số), UID có trong hệ thống thì mở pop-up nhập mét ngay — con trỏ ở ô mét (bàn phím số), Enter / Lưu → đóng, con
// trỏ về ô quét. Chỉ việc ĐỌC tự chạy; GHI vẫn cần Enter / Lưu (quyết định "không tự submit" của ô quét giữ cho ghi). Pop-up neo ở ĐẦU màn trên
// điện thoại để bàn phím số không che ô mét và nút Lưu.
async function popupScan(browser) {
  const { context, page, errors } = await newPage(browser, 375);
  const s = makeServer();
  s.measure(uid(1), 60500); // pending → pop-up "Sửa"
  s.measure(uid(3), 40100, 'printed', { printedAt: new Date().toISOString(), itemCode: 'CWSH02' }); // đã in → pop-up chỉ xem
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  const dlg = page.locator('#xa-vai-uid-dialog');
  const code = page.locator('#xa-vai-code');
  const meters = page.locator('#xa-vai-meters');
  const lookups = () => calls(s, 'xa_vai_measure_lookup').length;
  const isOpen = () => dlg.evaluate(d => d.open);
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'vào màn con trỏ ở ô quét');
  // 15 chữ số chưa phải một Group UID: không tự tra
  await code.fill(uid(2).slice(0, 15));
  await sleep(400);
  assert.equal(lookups(), 0, 'chưa đủ 16 chữ số thì không tự tra');
  assert.equal(await isOpen(), false);
  // Đủ 16 chữ số: tự tra, KHÔNG Enter, KHÔNG bấm Tra UID → pop-up modal
  await code.fill(uid(2));
  await dlg.waitFor({ state: 'visible' });
  assert.equal(lookups(), 1, 'tự tra đúng một lần');
  assert.equal(await dlg.evaluate(d => d.matches(':modal')), true, 'pop-up là hộp thoại modal');
  assert.equal(await dlg.locator('#xa-vai-uid').count(), 1, 'thẻ UID nằm trong pop-up');
  assert.equal(await dlg.locator('#xa-vai-meter-form').count(), 1, 'ô mét + Lưu nằm trong pop-up');
  await waitFor(async () => await focused(page) === 'xa-vai-meters', 'con trỏ ở ô mét trong pop-up');
  assert.equal(await meters.getAttribute('inputmode'), 'decimal', 'bàn phím số');
  const card = (await page.locator('#xa-vai-uid').innerText()).replace(/\s+/g, ' ');
  assert.match(card, new RegExp(uid(2))); assert.match(card, new RegExp(SKU)); assert.match(card, /L1/); assert.match(card, /50,00/);
  // Hình học trên 375 × 800: nằm trong màn, neo ở đầu (bàn phím ~45% màn không che), ô chữ ≥ 16 px, nút ≥ 44 px
  const box = await dlg.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375, 'pop-up không tràn ngang');
  assert.ok(box.y >= 0 && box.y < 120, `pop-up neo ở đầu màn (y=${box.y})`);
  // Honeywell 360 × ~670 px: thanh Chrome ~68 + bàn phím số ~270 → còn ~290 px phía trên bàn phím; pop-up phải gọn trong đó.
  assert.ok(box.y + box.height <= 300, `pop-up nằm gọn trên vùng bàn phím (đáy ${box.y + box.height})`);
  assert.ok(parseFloat(await meters.evaluate(el => getComputedStyle(el).fontSize)) >= 16, 'ô mét chữ ≥ 16 px');
  for (const id of ['#xa-vai-save', '#xa-vai-uid-close']) assert.ok((await page.locator(id).boundingBox()).height >= 44, `${id} ≥ 44 px`);
  await shot(page, '375-popup-nhap-met');
  // Vùng thấy được khi bàn phím số bật (Honeywell 360 px, ~290 px phía trên bàn phím): thẻ, ô mét và nút Lưu đều nằm trọn trong đó
  await page.setViewportSize({ width: 360, height: 290 });
  const tight = await dlg.boundingBox(), tightSave = await page.locator('#xa-vai-save').boundingBox(), tightIn = await meters.boundingBox();
  assert.ok(tight.y >= 0 && tight.y + tight.height <= 290 && tight.x >= 0 && tight.x + tight.width <= 360, `pop-up nằm trọn trong 360 × 290 (${JSON.stringify(tight)})`);
  assert.ok(tightSave.y + tightSave.height <= 290 && tightIn.y + tightIn.height <= 290, `ô mét và nút Lưu nằm trong 290 px phía trên bàn phím (dialog ${JSON.stringify(tight)}, Lưu ${JSON.stringify(tightSave)}, ô ${JSON.stringify(tightIn)})`);
  await page.setViewportSize({ width: 375, height: 800 });
  // Enter ở ô mét (phím → của bàn phím số) = Lưu → đóng pop-up, con trỏ về ô quét, đếm phiên
  await meters.fill('50,5');
  await meters.press('Enter');
  await waitMsg(page, /Đã lưu 1028260000000002 · 50,50 m/);
  await dlg.waitFor({ state: 'hidden' });
  assert.equal(await isOpen(), false);
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'lưu xong con trỏ về ô quét');
  assert.equal(await page.locator('#xa-vai-saved').textContent(), '1');
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1);
  // Máy quét gửi Enter ngay sau mã: tự tra + Enter vẫn chỉ tra MỘT lần
  await code.fill(uid(4));
  await code.press('Enter');
  await dlg.waitFor({ state: 'visible' });
  await sleep(300);
  assert.equal(lookups(), 2, 'tự tra + Enter chỉ tra một lần');
  // Esc / đóng: không ghi, con trỏ về ô quét, ô mét sạch
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1, 'đóng pop-up không ghi');
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'đóng pop-up con trỏ về ô quét');
  assert.equal(await meters.inputValue(), '', 'đóng pop-up xoá số đang gõ');
  // Số không hợp lệ: báo ngay TRONG pop-up (dòng báo của màn nằm sau lớp phủ)
  await code.fill(uid(6));
  await dlg.waitFor({ state: 'visible' });
  await meters.fill('abc');
  await meters.press('Enter');
  const err = page.locator('#xa-vai-uid-error');
  await waitFor(async () => /Mét thực tế không hợp lệ/.test(await err.innerText()), 'báo lỗi trong pop-up');
  assert.equal(await err.isVisible(), true);
  assert.equal(await dlg.evaluate(d => d.open), true, 'lỗi thì pop-up giữ nguyên để sửa');
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1, 'số sai không gửi lên máy chủ');
  // Máy quét bắn tiếp UID khác vào ô mét (chưa lưu): chuyển sang UID mới, lỗi cũ xoá, UID đã có mét hiện số cũ + nút Sửa
  await spyCue(page);
  await meters.fill(uid(1));
  await meters.press('Enter'); // máy quét có Enter cuối mã: không được lưu / báo lỗi giả
  await waitFor(async () => (await page.locator('#xa-vai-uid').innerText()).includes(uid(1)), 'chuyển sang UID quét tiếp trong ô mét');
  await sleep(500);
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1, 'Enter đến sau mã quét không lưu UID mới');
  assert.ok(!(await cues(page)).includes('error'), 'Enter đến sau mã quét không phát tiếng lỗi');
  assert.equal(await meters.inputValue(), '60,50', 'UID đã có mét hiện số cũ');
  assert.match((await page.locator('#xa-vai-save').textContent()).trim(), /Sửa/);
  // Enter đến muộn (máy quét hậu tố chậm, gõ tay) khi ô mét chưa đổi gì: KHÔNG lưu, dù đã quá 0,3 s; nút Sửa vẫn lưu được
  await sleep(700);
  await meters.press('Enter');
  await sleep(300);
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1, 'Enter khi chưa đổi số không lưu lại UID đã có mét');
  assert.equal(await dlg.evaluate(d => d.open), true);
  await page.locator('#xa-vai-meter-form').evaluate(f => f.requestSubmit()); // phím Xong của IME Android có thể submit thẳng, không qua keydown Enter
  await sleep(300);
  assert.equal(calls(s, 'xa_vai_measure_save').length, 1, 'submit trực tiếp khi chưa đổi số không lưu lại UID đã có mét');
  const boxPending = await dlg.boundingBox();
  assert.ok(boxPending.y + boxPending.height <= 290, `pop-up UID đã có mét (thêm Mét TT) vẫn gọn trên bàn phím (đáy ${boxPending.y + boxPending.height})`);
  assert.equal(await page.locator('#xa-vai-meter-form > label').isVisible(), true, 'nhãn "Mét thực tế" luôn thấy (phân biệt với Mét HT / Mét TT)');
  await shot(page, '375-popup-sua');
  assert.equal(await err.innerText(), '', 'sang UID mới thì xoá lỗi cũ');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });
  // UID đã in phiếu: KHÔNG pop-up (không có gì để nhập) — thẻ báo ngay dưới ô quét, con trỏ giữ ở ô quét để quét tiếp liền
  await code.fill(uid(3));
  await waitMsg(page, /đã in phiếu CWSH02/);
  assert.equal(await isOpen(), false, 'UID đã in không mở pop-up');
  assert.match((await page.locator('#xa-vai-note').innerText()).replace(/\s+/g, ' '), /Đã in/);
  assert.equal(await page.locator('#xa-vai-meter-form').isHidden(), true, 'UID đã in: không có ô mét');
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'UID đã in: con trỏ vẫn ở ô quét');
  // Quét tiếp UID chưa nhập: thẻ báo cũ biến mất, pop-up mở
  await code.fill(uid(5));
  await dlg.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#xa-vai-note').isHidden(), true, 'quét UID mới thì xoá thẻ báo cũ');
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });
  // UID không có trong hệ thống: KHÔNG mở pop-up, báo lỗi, giữ mã trong ô quét
  const before = lookups();
  await code.fill(uid(99));
  await waitMsg(page, /chưa có trong dữ liệu/);
  assert.equal(lookups(), before + 1);
  assert.equal(await isOpen(), false, 'UID lạ không mở pop-up');
  assert.equal(await code.inputValue(), uid(99), 'giữ mã để xem lại');
  // Rời màn khi pop-up đang mở: pop-up đóng, trang không bị khoá (không còn hộp thoại modal)
  await code.fill(uid(1));
  await dlg.waitFor({ state: 'visible' });
  await page.evaluate(() => { location.hash = '#home'; });
  await waitFor(async () => !(await isOpen()), 'rời màn thì pop-up đóng');
  assert.equal(await page.evaluate(() => document.querySelectorAll('dialog:modal').length), 0, 'không còn hộp thoại modal khoá trang');
  await page.evaluate(() => { location.hash = '#xa-vai'; });
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'vào lại màn con trỏ ở ô quét');
  // Nút Lưu bấm tay lưu được (không phụ thuộc Enter / submit)
  await code.fill(uid(6));
  await dlg.waitFor({ state: 'visible' });
  await meters.fill('59,5');
  await page.locator('#xa-vai-save').click();
  await waitMsg(page, /Đã lưu 1028260000000006 · 59,50 m/);
  await dlg.waitFor({ state: 'hidden' });
  // Tra UID quét tiếp (trong ô mét) bị lỗi mạng: KHÔNG giữ thẻ UID cũ (nhập mét rồi lưu nhầm cây vải cũ) — đóng pop-up, mã vừa quét về ô quét
  await code.fill(uid(2));
  await dlg.waitFor({ state: 'visible' });
  s.abortOnce.add('xa_vai_measure_lookup');
  const savesBefore = calls(s, 'xa_vai_measure_save').length;
  await meters.fill(uid(4));
  await waitMsg(page, /Không tra được Group UID/);
  await dlg.waitFor({ state: 'hidden' });
  assert.equal(await code.inputValue(), uid(4), 'lỗi mạng khi tra: mã vừa quét về ô Group UID để thử lại');
  assert.equal(await page.locator('#xa-vai-meter-form').isHidden(), true, 'lỗi mạng khi tra: không còn form mét của UID cũ');
  assert.equal(calls(s, 'xa_vai_measure_save').length, savesBefore);
  // Rời màn đúng lúc đang lưu mà lưu hỏng: quay lại không còn UID cũ / form mét treo mà pop-up đã đóng
  await code.fill(uid(2));
  await dlg.waitFor({ state: 'visible' });
  s.delayMs = { xa_vai_measure_save: 700 };
  s.abortOnce.add('xa_vai_measure_save');
  await meters.fill('44');
  await meters.press('Enter');
  await waitFor(() => calls(s, 'xa_vai_measure_save').length === savesBefore + 1, 'lệnh lưu đã gửi');
  await page.evaluate(() => { location.hash = '#home'; });
  await sleep(1100);
  s.delayMs = null;
  await page.evaluate(() => { location.hash = '#xa-vai'; });
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#xa-vai-meter-form').isHidden(), true, 'quay lại không còn form mét của UID cũ');
  assert.equal(await isOpen(), false);
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'quay lại con trỏ ở ô quét');
  // Cùng cuộc đua nhưng quay lại NGAY: lưu hỏng sau 0,5 s rồi tra nền trả sau 0,8 s — kết quả muộn không được dựng lại UID cũ / mở lại pop-up
  await code.fill(uid(2));
  await dlg.waitFor({ state: 'visible' });
  s.delayMs = { xa_vai_measure_save: 500, xa_vai_measure_lookup: 800 };
  s.abortOnce.add('xa_vai_measure_save');
  const savesRace = calls(s, 'xa_vai_measure_save').length;
  await meters.fill('45');
  await meters.press('Enter');
  await waitFor(() => calls(s, 'xa_vai_measure_save').length === savesRace + 1, 'lệnh lưu đã gửi');
  await page.evaluate(() => { location.hash = '#home'; });
  await page.evaluate(() => { location.hash = '#xa-vai'; });
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await sleep(2000);
  s.delayMs = null;
  assert.equal(await isOpen(), false, 'tra nền trả muộn không mở lại pop-up');
  assert.equal(await page.locator('#xa-vai-meter-form').isHidden(), true, 'tra nền trả muộn không dựng lại form mét');
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'con trỏ ở ô quét sau cuộc đua');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS pop-up quét: đủ 16 chữ số tự tra, tự tra + Enter một lần, pop-up neo đầu màn, Enter lưu → về ô quét, Esc không ghi, lỗi báo trong pop-up, UID mới thay trong ô mét, UID đã in chỉ hiện thẻ báo không pop-up, UID lạ không pop-up, rời màn đóng pop-up');
}
// Máy quét thật CHỈ gõ vào ô đang nhận phím (không tự focus như locator.fill). Chạm nút Lưu / Đóng rồi quét tiếp: pop-up phải hiện lại.
// Lỗi gốc (người dùng báo 04/11, đo bằng gõ phím thật): đóng pop-up khi nút đang giữ focus → document.activeElement = ô quét nhưng phím KHÔNG
// vào ô ("focus ma"), máy quét gõ mất mã, UID kế không hiện pop-up. Enter ở ô mét thì không bị (focus đang ở ô nhập).
async function typedScan(browser) {
  const { context, page, errors } = await newPage(browser, 375);
  const s = makeServer();
  await mock(page, s);
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  await waitFor(async () => await focused(page) === 'xa-vai-code', 'vào màn con trỏ ở ô quét');
  const dlg = page.locator('#xa-vai-uid-dialog');
  const typeScan = async (n, enter = false) => {
    await page.keyboard.type(uid(n), { delay: 5 });
    if (enter) await page.keyboard.press('Enter');
    await dlg.waitFor({ state: 'visible', timeout: 4000 }).catch(async () => assert.fail(`quét ${uid(n)} bằng gõ phím: pop-up không hiện (ô quét="${await page.locator('#xa-vai-code').inputValue()}", focus=${await focused(page)})`));
  };
  // Chạm Lưu rồi quét tiếp, ba lượt liên tiếp
  for (const [n, m] of [[2, '50,5'], [4, '30,5'], [6, '60,5']]) {
    await typeScan(n);
    await page.keyboard.type(m);
    await page.locator('#xa-vai-save').tap();
    await waitMsg(page, new RegExp(`Đã lưu ${uid(n)}`));
    await dlg.waitFor({ state: 'hidden' });
  }
  // Chạm Đóng rồi quét tiếp
  await typeScan(1);
  await page.locator('#xa-vai-uid-close').tap();
  await dlg.waitFor({ state: 'hidden' });
  // Esc rồi quét tiếp (máy quét có Enter cuối mã)
  await typeScan(3, true);
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });
  // Enter ở ô mét rồi quét tiếp
  await typeScan(9);
  await page.keyboard.type('20,5');
  await page.keyboard.press('Enter');
  await waitMsg(page, new RegExp(`Đã lưu ${uid(9)}`));
  await dlg.waitFor({ state: 'hidden' });
  await typeScan(5);
  await page.keyboard.press('Escape');
  await dlg.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS quét bằng gõ phím thật: chạm Lưu / chạm Đóng / Esc / Enter rồi quét UID kế vẫn hiện pop-up (không focus ma)');
}
async function mobile(browser) {
  const { context, page, errors } = await newPage(browser, 375);
  const s = makeServer();
  s.measure(uid(1), 60500); s.measure(uid(9), 19800);
  s.measure(uid(3), 40100, 'printed', { printedAt: new Date().toISOString(), itemCode: 'CWSH02' }); s.measure(uid(4), 29700, 'printed', { printedAt: new Date().toISOString(), itemCode: 'CWSH02' });
  await mock(page, s);
  await page.addInitScript(() => localStorage.setItem('xa-vai-mahang-v1', 'CWSH02'));
  await page.goto(BASE + '#xa-vai');
  await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
  const over = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  await scan(page, uid(5));
  await page.locator('#xa-vai-meter-form').waitFor({ state: 'visible' });
  await page.locator('#xa-vai-meters').fill('11,5');
  assert.equal(await over(), false, '375 px tab Quét không tràn ngang');
  await shot(page, '375-quet');
  await page.locator('#xa-vai-uid-close').click(); // pop-up nhập mét chặn bấm tab: đóng trước
  await page.locator('#xa-vai-tab-queue').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 2);
  await page.waitForFunction(() => /Máy in A4/.test(document.getElementById('xa-vai-printer').textContent));
  assert.equal(await over(), false, '375 px tab Chờ in không tràn ngang');
  const cardRow = await page.locator('#xa-vai-queue-rows tr[data-uid]').first().evaluate(tr => getComputedStyle(tr).display);
  assert.equal(cardRow, 'grid', 'bảng Chờ in thành hàng gọn một dòng (lưới) trên điện thoại, không còn thẻ nhiều dòng (04/11, queuePhone kiểm chi tiết)');
  const btn = await page.locator('#xa-vai-print').boundingBox();
  assert.ok(btn.height >= 44 && btn.x >= 0 && btn.x + btn.width <= 375, 'nút In A4 đủ lớn, nằm trong màn');
  await shot(page, '375-cho-in');
  // Khung nhập Mã hàng trên điện thoại: nằm trong màn, ô chữ ≥ 16 px, nút ≥ 44 px
  await openCode(page);
  assert.equal(await page.locator('#xa-vai-mh-code').inputValue(), 'CWSH02');
  const box = await mh(page).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375 && box.y >= 0 && box.y + box.height <= 800, 'khung Mã hàng nằm trong màn 375 px');
  assert.ok(parseFloat(await page.locator('#xa-vai-mh-code').evaluate(el => getComputedStyle(el).fontSize)) >= 16, 'ô Mã hàng chữ ≥ 16 px');
  for (const id of ['#xa-vai-mh-ok', '#xa-vai-mh-cancel']) assert.ok((await page.locator(id).boundingBox()).height >= 44, `${id} ≥ 44 px`);
  await shot(page, '375-ma-hang');
  await page.locator('#xa-vai-mh-cancel').click();
  await mh(page).waitFor({ state: 'hidden' });
  assert.equal(calls(s, 'xa_vai_print_enqueue').length, 0);
  await page.locator('#xa-vai-screen').evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(page, '375-cho-in-cuoi');
  await page.locator('#xa-vai-tab-printed').click();
  await page.waitForFunction(() => document.querySelectorAll('#xa-vai-printed-rows tr[data-uid]').length === 2);
  assert.equal(await over(), false, '375 px tab Đã in không tràn ngang');
  const codeBtn = await page.locator(`#xa-vai-printed-rows tr[data-uid="${uid(3)}"] [data-code]`).boundingBox();
  assert.ok(codeBtn.height >= 44, 'nút Mã hàng trong thẻ ≥ 44 px');
  await shot(page, '375-da-in');
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS 375px: ba tab + khung Mã hàng không tràn ngang, bảng thành thẻ, nút In A4 / Mã hàng ≥ 44 px');
}

// Mỗi tab chỉ hiện đúng một thẻ: bắt lỗi CSS đè quy tắc ẩn của tab không được chọn (04/11/2026: thẻ Chờ in `display: grid` vô điều kiện làm tab Quét
// hiện luôn danh sách Chờ in bên dưới, người dùng báo "giao diện quét và chờ in rất lộn xộn" trên điện thoại).
const onlyPanel = async (page, name, where) => {
  const shown = await page.locator('#xa-vai-screen .cut-card[data-panel]').evaluateAll(cards => cards.filter(card => { const r = card.getBoundingClientRect(); return getComputedStyle(card).display !== 'none' && r.width > 0 && r.height > 0; }).map(card => card.dataset.panel));
  assert.deepEqual(shown, [name], `${where}: chỉ thẻ "${name}" hiện (đang hiện: ${shown.join(', ') || 'không thẻ nào'})`);
};

// TAB QUÉT: MỖI TÊN MỘT LẦN (04/11/2026, người dùng: "mục 1 quét bị lặp quét group UID, Group UID, Tra UID, UID"): tab đã gọi tên "Quét" nên tiêu đề
// thẻ chỉ còn cho trình đọc màn hình; ô quét giữ MỘT tên (placeholder "Group UID"); nút "Tra cứu" không lặp danh từ; bộ đếm "Đã lưu 0" không lặp đơn vị;
// không còn khung rỗng "Chưa quét Group UID" (trước đây chiếm nửa thẻ trên máy tính, ô quét bị bóp còn ~170 px, placeholder cắt thành "G…").
async function scanTabNames(browser) {
  for (const width of [1280, 375]) {
    const { context, page, errors } = await newPage(browser, width);
    await mock(page, makeServer());
    await page.goto(BASE + '#xa-vai');
    await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
    const tab = (await page.locator('#xa-vai-tab-scan').innerText()).replace(/\s+/g, ' ').replace(/\d+/g, '').trim();
    assert.equal(tab, 'Quét', `${width}: tab 1 chỉ ghi "Quét"`);
    await onlyPanel(page, 'scan', `${width}: tab Quét`);
    // Chữ nhìn thấy trong thẻ Quét (bỏ phần tử ẩn, phần tử cắt 1 px kiểu sr-only và con của chúng)
    const seen = await page.locator('#xa-vai-screen [data-panel="scan"]').evaluate(root => {
      const out = [], walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const text = n.textContent.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        let hidden = false;
        for (let el = n.parentElement; el && !hidden; el = el === root ? null : el.parentElement) {
          const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
          hidden = cs.visibility === 'hidden' || cs.display === 'none' || r.width < 2 || r.height < 2;
        }
        if (!hidden) out.push(text);
      }
      return out;
    });
    assert.equal(seen.join(' '), 'Tra cứu Đã lưu 0', `${width}: thẻ Quét chỉ còn nút "Tra cứu" và bộ đếm, không lặp tên / đơn vị (thấy: ${JSON.stringify(seen)})`);
    const code = page.locator('#xa-vai-code');
    assert.equal(await code.getAttribute('placeholder'), 'Group UID', 'ô quét giữ một tên');
    assert.equal(await code.getAttribute('aria-label'), 'Group UID', 'ô quét có tên cho trình đọc màn hình');
    assert.equal(await page.locator('#xa-vai-code-label, #xa-vai-uid-empty').count(), 0, 'không còn nhãn rời và khung rỗng');
    const heading = page.locator('#xa-vai-screen [data-panel="scan"] > h2');
    assert.match(await heading.textContent(), /Quét/, 'tiêu đề thẻ còn trong cây trợ năng');
    assert.ok((await heading.boundingBox()).width <= 2, 'tiêu đề thẻ không hiện (tab đã gọi tên)');
    // Bố cục: ô quét chiếm hết bề ngang thẻ
    const field = await page.locator('#xa-vai-form .scan-field').boundingBox(), btn = await page.locator('#xa-vai-lookup').boundingBox();
    const card = await page.locator('#xa-vai-screen [data-panel="scan"]').boundingBox();
    assert.ok(field.x + field.width <= card.x + card.width + 1 && btn.x + btn.width <= card.x + card.width + 1, `${width}: không tràn thẻ`);
    if (width >= 800) {
      assert.ok(field.width >= 480, `${width}: ô quét rộng (${field.width})`);
      assert.ok(Math.abs(btn.y + btn.height / 2 - (field.y + field.height / 2)) <= 12, 'nút Tra cứu cùng hàng với ô quét');
    } else {
      assert.ok(field.width >= 300, `${width}: ô quét rộng (${field.width})`);
      assert.ok(btn.y >= field.y + field.height - 1, 'điện thoại: nút Tra cứu nằm dưới ô quét');
      assert.ok(btn.width >= 300, 'nút Tra cứu rộng hết thẻ');
    }
    assert.ok(btn.height >= 44, 'nút Tra cứu ≥ 44 px');
    await shot(page, `${width}-tab-quet-ten-mot-lan`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS tab Quét: mỗi tên một lần (tab "Quét", ô quét "Group UID", nút "Tra cứu", "Đã lưu 0"), ô quét chiếm hết thẻ ở 1280 và 375 px');
}

// CHỜ IN TRÊN ĐIỆN THOẠI (04/11/2026, người dùng: "mục chờ in tối ưu cho điện thoại, ưu tiên nút in lên trên, thông báo máy in gọn bằng icon, group uid hiển thị
// đơn giản 1 hàng"): nút In A4 (kèm Số bản) nằm TRÊN danh sách; máy in sẵn sàng chỉ là icon (chữ vẫn có cho trình đọc màn hình), máy in có vấn đề mới hiện
// chữ, một dòng ngay dưới nút In; mỗi UID một hàng: ô chọn · Group UID · mét thực tế · sửa · xoá (SKU / Lot / Roll / mét hệ thống xem trong pop-up Sửa).
async function queuePhone(browser) {
  for (const width of [375, 360]) {
    const { context, page, errors } = await newPage(browser, width);
    const s = makeServer();
    s.measure(uid(1), 60500); s.measure(uid(9), 19800); s.measure(uid(2), 50000);
    await mock(page, s);
    await page.goto(BASE + '#xa-vai');
    await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
    await onlyPanel(page, 'scan', `${width}: tab Quét không hiện danh sách Chờ in`);
    await page.locator('#xa-vai-tab-queue').click();
    await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 3);
    await onlyPanel(page, 'queue', `${width}: tab Chờ in`);
    await page.waitForFunction(() => document.getElementById('xa-vai-printer').dataset.tone === 'ok');
    const box = sel => page.locator(sel).first().boundingBox();
    const over = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    // 1) nút In ở trên danh sách, thấy ngay không phải cuộn
    const print = await box('#xa-vai-print'), first = await box('#xa-vai-queue-rows tr[data-uid]');
    assert.ok(print.y + print.height <= first.y, `${width}: nút In nằm trên danh sách (In y=${print.y}+${print.height}, dòng đầu y=${first.y})`);
    assert.ok(print.y < 260 && print.height >= 44, `${width}: nút In thấy ngay, cao ≥ 44 (y=${print.y}, cao ${print.height})`);
    const copies = await box('#xa-vai-copies');
    assert.ok(copies.y + copies.height <= first.y && copies.height >= 44, `${width}: Số bản cùng khối nút In, ở trên danh sách`);
    // 2) máy in sẵn sàng = chỉ icon
    const chip = await box('#xa-vai-printer'), txt = await box('#xa-vai-printer-text');
    assert.ok(txt.width <= 2, `${width}: máy in sẵn sàng không hiện chữ`);
    assert.match(await page.locator('#xa-vai-printer').textContent(), /sẵn sàng/, 'chữ vẫn có cho trình đọc màn hình');
    assert.ok(chip.width <= 100 && chip.height >= 44, `${width}: thẻ máy in gọn (${chip.width} × ${chip.height})`);
    assert.equal(await page.locator('#xa-vai-printer .xv-ps--ok').isVisible(), true, 'icon trạng thái sẵn sàng');
    const all = await box('#xa-vai-queue-all'), reload = await box('#xa-vai-reload');
    assert.ok(Math.abs(chip.y + chip.height / 2 - (reload.y + reload.height / 2)) <= 14 && Math.abs(all.y + all.height / 2 - (reload.y + reload.height / 2)) <= 14, `${width}: Chọn tất cả · máy in · Tải lại cùng một hàng`);
    assert.ok((await box('#xa-vai-queue-selected')).width <= 2, `${width}: "Đã chọn n" ẩn (nút In đã ghi số UID)`);
    // 3) mỗi UID một hàng
    await shot(page, `${width}-cho-in-gon`);
    const rows = page.locator('#xa-vai-queue-rows tr[data-uid]');
    for (let i = 0; i < 3; i++) {
      const row = rows.nth(i), rb = await row.boundingBox();
      assert.ok(rb.height <= 64, `${width}: dòng ${i + 1} một hàng (cao ${rb.height})`);
      assert.equal(await row.evaluate(r => r.scrollWidth <= r.clientWidth), true, `${width}: dòng ${i + 1} không tràn ngang`);
      for (const label of ['SKU', 'Lot', 'Roll', 'Mét HT']) assert.equal(await row.locator(`td[data-label="${label}"]`).isHidden(), true, `${width}: cột ${label} ẩn trong hàng`);
      const parts = [row.locator('input[data-pick]'), row.locator('td[data-label="Group UID"]'), row.locator('td[data-label="Mét TT"]'), row.locator('.xv-uidbtn'), row.locator('[data-act="delete"]')];
      const cy = rb.y + rb.height / 2;
      for (const part of parts) { const b = await part.boundingBox(); assert.ok(b && Math.abs(b.y + b.height / 2 - cy) <= 12 && b.x >= rb.x && b.x + b.width <= rb.x + rb.width + 1, `${width}: dòng ${i + 1} đủ ô chọn, UID, mét, sửa, xoá trên một hàng`); }
      const del = await row.locator('[data-act="delete"]').boundingBox(), link = await row.locator('.xv-uidbtn').boundingBox();
      assert.ok(del.width >= 44 && del.height >= 44 && link.height >= 44, `${width}: nút xoá / UID ≥ 44 px`);
      assert.equal(await row.locator('[data-act="edit"]').isHidden(), true, `${width}: nút bút chì ẩn (bấm UID để sửa)`);
      assert.match((await row.locator('td[data-label="Group UID"]').innerText()).trim(), /^\d{16}$/, 'ô UID chỉ có mã');
    }
    assert.equal(await over(), false, `${width}: tab Chờ in không tràn ngang`);
    // 4) máy in có vấn đề: chữ hiện, một dòng, ngay dưới nút In
    s.a4Seen = ago(10);
    await page.locator('#xa-vai-tab-scan').click();
    await page.locator('#xa-vai-tab-queue').click();
    await page.waitForFunction(() => document.getElementById('xa-vai-printer').dataset.tone === 'off', null, { timeout: 20000 });
    const bad = await box('#xa-vai-printer'), badText = await box('#xa-vai-printer-text'), print2 = await box('#xa-vai-print');
    assert.ok(badText.width > 40, `${width}: máy in lỗi hiện chữ`);
    assert.ok(bad.height <= 56 && bad.width >= width - 80, `${width}: một dòng, rộng hết thẻ (${bad.width} × ${bad.height})`);
    assert.ok(bad.y >= print2.y + print2.height - 1 && bad.y < (await box('#xa-vai-queue-rows tr[data-uid]')).y, `${width}: thẻ máy in lỗi nằm giữa nút In và danh sách`);
    assert.equal(await page.locator('#xa-vai-printer .xv-ps--off').isVisible(), true, 'icon trạng thái mất kết nối');
    await shot(page, `${width}-cho-in-may-in-loi`);
    assert.equal(await over(), false);
    await page.locator('#xa-vai-tab-printed').click();
    await onlyPanel(page, 'printed', `${width}: tab Đã in`);
    await page.locator('#xa-vai-tab-scan').click();
    await onlyPanel(page, 'scan', `${width}: quay lại tab Quét`);
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS Chờ in điện thoại (375 + 360 px): nút In + Số bản trên danh sách, máy in sẵn sàng chỉ icon / lỗi một dòng dưới nút In, mỗi UID một hàng (chọn · UID · mét · sửa · xoá)');
}

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // XA_VAI_ONLY=watchLimit (tên phần, cách nhau dấu phẩy) để chạy riêng khi dò lỗi; mặc định chạy hết.
    const only = (process.env.XA_VAI_ONLY || '').split(',').filter(Boolean);
    for (const part of [desktop, bigQueue, tracking, watchLimit, popupScan, typedScan, mobile, scanTabNames, queuePhone]) if (!only.length || only.includes(part.name)) await part(browser);
    console.log('PASS xa_vai_a4_browser');
  } finally { await browser.close(); }
})().catch(error => { console.error('FAIL', error); process.exit(1); });
