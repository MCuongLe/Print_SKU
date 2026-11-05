// THEO DÕI XẢ VẢI — báo "Máy in A4 chưa in" khi phiếu đã tới máy in mà không ra giấy (05/11/2026, phương án 1 sau vụ máy HP chưa bật:
// Windows vẫn báo máy in bình thường, agent gửi phiếu vào hàng đợi rồi chờ 10 phút, web chỉ thấy "Mất kết nối"). Luật: lệnh đang theo dõi
// (của máy này hoặc dòng printing của máy khác) ở claimed / rendering / sending / spooling quá 20 giây kể từ lúc TRANG NÀY thấy nó ở đó
// (đồng hồ đơn điệu, không so createdAt máy chủ) → thẻ máy in đỏ "Máy in A4 chưa in · kiểm tra đã bật máy", thắng mọi trạng thái poll khác;
// lệnh xong / lỗi / huỷ → thẻ về theo poll. Lệnh còn queued (agent chưa nhận) hay mới tới máy in chưa đủ 20 giây thì không báo.
// Thời gian dịch bằng page.clock (không chờ thật). Run against python -m http.server 8000 (đổi bằng BASE). Supabase giả lập, dữ liệu giả.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const TOKEN = 'pd_' + 'cd'.repeat(24);
const uid = n => `10282600000${String(n).padStart(5, '0')}`;
const WARN = 'Máy in A4 chưa in · kiểm tra đã bật máy';
const J_OTHER = '00000000-0000-4000-8000-00000000000a';

const makeServer = () => ({
  calls: [],
  // UID 1, 2 chờ in; UID 3 đang in bởi máy khác (lệnh J_OTHER đã spooling từ lâu)
  measures: new Map([
    [uid(1), { sku: '900000001', lot: 'L1', roll: 'R1', systemMm: 60000, actualMm: 60000, status: 'pending', jobId: null, itemCode: null }],
    [uid(2), { sku: '900000001', lot: 'L1', roll: 'R2', systemMm: 50000, actualMm: 50000, status: 'pending', jobId: null, itemCode: null }],
    [uid(3), { sku: '900000002', lot: 'L2', roll: 'R3', systemMm: 40000, actualMm: 40000, status: 'printing', jobId: J_OTHER, itemCode: 'CWSH02' }],
  ]),
  jobs: new Map([[J_OTHER, { status: 'spooling' }]]),
  seq: 0,
});

const mock = (page, s) => page.route('**/*', async route => {
  const url = route.request().url();
  if (url.startsWith(BASE)) return route.continue();
  const json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
  if (!rpc) return json([]);
  const body = route.request().postDataJSON?.() || {};
  s.calls.push({ rpc, body });
  const ok = data => json({ ok: true, data });
  const item = (u, m) => ({ groupUid: u, sku: m.sku, itemCode: m.itemCode, lot: m.lot, roll: m.roll, systemMm: m.systemMm, actualMm: m.actualMm, measuredAt: '2026-11-05T01:00:00.000Z', status: m.status, printedAt: null, printJobId: m.jobId });
  if (rpc === 'xa_vai_measure_list') { const items = [...s.measures].filter(([, m]) => m.status !== 'printed').map(([u, m]) => item(u, m)); return ok({ items, total: items.length }); }
  if (rpc === 'xa_vai_measure_search') return ok({ items: [], total: 0, truncated: false });
  if (rpc === 'xa_vai_print_enqueue') {
    const id = `00000000-0000-4000-8000-${String(++s.seq).padStart(12, '0')}`;
    s.jobs.set(id, { status: 'queued' });
    body.p_uids.forEach(u => { const m = s.measures.get(u); m.status = 'printing'; m.jobId = id; m.itemCode = String(body.p_item_code).toUpperCase(); });
    return ok({ id, status: 'queued', duplicate: false, count: body.p_uids.length });
  }
  // createdAt cố ý lệch 5 phút về tương lai (đồng hồ máy trạm chậm): web không được dựa vào nó.
  if (rpc === 'print_job_status') { const j = s.jobs.get(body.p_job_id); return j ? ok({ id: body.p_job_id, type: 'xa_vai_sheet', status: j.status, createdAt: new Date(Date.now() + 300000).toISOString(), errorCode: j.errorCode || null, errorMessage: j.errorMessage || null, result: j.result || null }) : json({ ok: false, error: { code: 'NOT_FOUND', message: 'Không có lệnh' } }); }
  if (rpc === 'print_queue_status') return ok({ queued: 0, queuedCopies: 0, queuedA4: 0, active: 0, agents: [{ id: 'may-a4-01', capabilities: ['xa_vai_sheet:v1'], lastSeenAt: new Date(Date.now() + 86400000).toISOString(), state: { printer: { blocked: false } } }] }); // lastSeenAt ở tương lai: đồng hồ trang bị dịch xa, agent vẫn phải "liên lạc tốt"
  return ok({});
});
const finish = (s, id) => { const j = s.jobs.get(id); j.status = 'completed'; j.result = { spoolConfirmed: true }; for (const [, m] of s.measures) if (m.jobId === id && m.status === 'printing') m.status = 'printed'; };
const fail = (s, id) => { const j = s.jobs.get(id); j.status = 'failed'; j.errorCode = 'PRINTER_STALLED'; j.errorMessage = 'Máy in đứng yên 10 phút ở trang 0'; for (const [, m] of s.measures) if (m.jobId === id && m.status === 'printing') { m.status = 'pending'; m.jobId = null; m.itemCode = null; } };

const pill = page => page.locator('#xa-vai-printer');
const pillText = page => page.evaluate(() => document.getElementById('xa-vai-printer').textContent.trim());
const msg = page => page.locator('#xa-vai-message').innerText();
const statusCalls = s => s.calls.filter(c => c.rpc === 'print_job_status').length;
// Dịch đồng hồ trang từng bước 500 ms (timer giả chạy đúng mốc hẹn, chuỗi hỏi 2,5 s vẫn nối nhau) và bảo đảm có ít nhất một lượt hỏi trạng thái
// lệnh trong / sau khi dịch; lượt cuối của quãng 25 s thấy lệnh đã ở máy in ≥ 22,5 s (ngưỡng 20 s). Lệnh xong giữa chừng thì chuỗi hỏi dừng — vẫn đạt.
const tick = async (page, s, ms = 3000, label = '') => { const n0 = statusCalls(s); for (let t = 0; t < ms; t += 500) { await page.clock.fastForward(500); await page.waitForTimeout(10); } for (let i = 0; i < 140 && statusCalls(s) === n0; i++) { await page.clock.fastForward(500); await page.waitForTimeout(25); } assert.ok(statusCalls(s) > n0, `${label}: có lượt hỏi trạng thái lệnh khi dịch đồng hồ (đã ${n0} lượt, thẻ: ${await pillText(page)}, báo: ${await msg(page)})`); await page.waitForTimeout(150); };
const chibiGone = page => page.waitForFunction(() => { const o = document.getElementById('print-chibi-overlay'); return !o || o.hidden; }, null, { timeout: 6000 });
// XA_VAI_WAIT_SHOTS=<thư mục> thì chụp thẻ đỏ ở từng khổ (gửi Codex review ảnh).
const shot = async (page, name) => { if (process.env.XA_VAI_WAIT_SHOTS) await page.screenshot({ path: `${process.env.XA_VAI_WAIT_SHOTS}/${name}.png` }); };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height: mobile ? 800 : 900 }, isMobile: mobile, hasTouch: mobile });
      await context.addInitScript(token => localStorage.setItem('tb-khoa', token), TOKEN);
      const page = await context.newPage(), errors = [], s = makeServer();
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      await mock(page, s);
      await page.clock.install();
      await page.goto(BASE + '#xa-vai');
      await page.locator('#xa-vai-screen').waitFor({ state: 'visible' });
      await page.locator('#xa-vai-tab-queue').click();
      await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 3);
      await page.waitForFunction(() => /Máy in A4 sẵn sàng/.test(document.getElementById('xa-vai-printer').textContent));

      // 1. Lệnh của máy khác (dòng printing, spooling): trang vừa thấy → chưa báo; sau 20 giây vẫn spooling → thẻ đỏ (dù agent vẫn liên lạc tốt)
      await tick(page, s, 2000, '1a');
      assert.doesNotMatch(await pillText(page), new RegExp(WARN), 'mới thấy lệnh ở máy in: chưa báo');
      await tick(page, s, 25000, '1b');
      assert.match(await pillText(page), new RegExp(WARN), 'bước 1: lệnh máy khác ở máy in quá 20 s');
      assert.equal(await pill(page).getAttribute('data-tone'), 'off');
      await shot(page, `${width}-chua-in`);
      if (mobile) {
        const box = await page.locator('#xa-vai-printer-text').boundingBox();
        assert.ok(box && box.width > 100, 'điện thoại: dòng chữ hiện dưới nút In (không chỉ icon)');
        assert.equal(await page.locator('#xa-vai-printer-text').evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1), true, 'điện thoại: chữ không bị cắt ngang lẫn dọc (xuống dòng, đủ câu)');
        const pb = await pill(page).boundingBox();
        assert.ok(pb.height <= 56, `điện thoại: thẻ tối đa hai dòng (${pb.height})`);
      }
      assert.match(await msg(page), new RegExp(WARN), 'không ở tab Quét: dòng báo cũng nói');
      // Poll máy in (15 giây) không ghi đè chữ "chưa in"
      const polls = s.calls.filter(c => c.rpc === 'print_queue_status').length;
      await tick(page, s, 16000, '1c poll');
      assert.ok(s.calls.filter(c => c.rpc === 'print_queue_status').length > polls, 'đã có lượt poll máy in');
      assert.match(await pillText(page), new RegExp(WARN), 'poll không ghi đè "chưa in"');
      // Máy khác in xong → thẻ về "sẵn sàng" theo poll
      finish(s, J_OTHER);
      await tick(page, s, 3000, '1d xong');
      await page.waitForFunction(() => /Máy in A4 sẵn sàng/.test(document.getElementById('xa-vai-printer').textContent));
      assert.equal(await pill(page).getAttribute('data-tone'), 'ok');
      await page.waitForFunction(() => document.querySelectorAll('#xa-vai-queue-rows tr[data-uid]').length === 2);

      // 2. Gửi in: lệnh queued lâu (agent chưa nhận) → KHÔNG báo "chưa in"
      await page.locator('#xa-vai-print').click();
      await page.locator('#xa-vai-mh-dialog').waitFor({ state: 'visible' });
      await page.locator('#xa-vai-mh-code').fill('CWSH02');
      await page.locator('#xa-vai-mh-ok').click();
      await page.waitForFunction(() => /Đã gửi in A4 2 UID/.test(document.getElementById('xa-vai-message').textContent));
      await page.clock.fastForward(3000);
      await chibiGone(page);
      const own = [...s.jobs.keys()].find(k => k !== J_OTHER);
      await tick(page, s, 30000, '2 queued');
      assert.doesNotMatch(await pillText(page), new RegExp(WARN), 'queued lâu: agent chưa nhận, không phải máy in chưa in');
      // 3. Agent đã gửi tới máy in (spooling): mới thấy → chưa báo; đủ 20 giây → báo + dòng báo + âm báo
      s.jobs.get(own).status = 'spooling';
      await tick(page, s, 2000, '3a');
      assert.doesNotMatch(await pillText(page), new RegExp(WARN), 'spooling mới thấy: chưa báo');
      await tick(page, s, 25000, '3b');
      assert.match(await pillText(page), new RegExp(WARN), 'bước 3: lệnh máy này ở máy in quá 20 s');
      assert.match(await msg(page), new RegExp(WARN), 'lệnh của máy này: dòng báo nói');
      // 4. Kết thúc: máy tính → in xong; điện thoại → agent báo lỗi (hết 10 phút) → chữ tự tắt, UID về Chờ in
      if (mobile) fail(s, own); else finish(s, own);
      await tick(page, s, 3000, '4 kết thúc');
      await page.waitForFunction(() => /Máy in A4 sẵn sàng/.test(document.getElementById('xa-vai-printer').textContent));
      assert.equal(await pill(page).getAttribute('data-tone'), 'ok');
      await page.waitForFunction(re => new RegExp(re).test(document.getElementById('xa-vai-message').textContent), mobile ? 'Lệnh in A4 lỗi' : 'Đã in xong phiếu A4');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không cuộn ngang');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: Xả vải — phiếu ở máy in quá 20 s (máy này / máy khác, đồng hồ trang) → thẻ đỏ "${WARN}", thắng poll; queued lâu / mới tới máy in không báo; xong / lỗi tự tắt`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
