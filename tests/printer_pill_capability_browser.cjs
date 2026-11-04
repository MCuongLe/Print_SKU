// Thẻ máy in của các màn TEM chỉ đọc agent tem (sku:v1 / group_uid:v1 / location:v1), không đọc agent máy in A4 (xa_vai_sheet:v1).
// Trước đây web lấy agent có last_seen_at mới nhất bất kể khả năng: khi agent A4 chạy, agent tem chết vẫn hiện "Máy in rảnh".
// Ba nơi: thẻ #uid-printer-text (IN TEM GROUP UID), lệnh cũ pr_hangdoi (IN TEM SKU / MÃ VỊ TRÍ), thẻ máy in trong Lệnh in Admin (loadPrinter).
// Supabase giả lập, chỉ dùng mã tổng hợp. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const ago = seconds => new Date(Date.now() - seconds * 1000).toISOString();
const LABEL_CAPS = ['sku:v1', 'sku:v2', 'sku:v3', 'group_uid:v1', 'location:v1', 'location:name-optional'];
const agent = (id, capabilities, seconds, printer = { ok: true, blocked: false, message: '' }) => ({
  id, name: id, capabilities, lastSeenAt: ago(seconds), state: { version: '0.10.2', capabilities, printer }
});

const CASES = [
  { name: 'A. agent tem chết, agent A4 vừa liên lạc', agents: [agent('may-kho-01', LABEL_CAPS, 600), agent('may-a4-01', ['xa_vai_sheet:v1'], 3)], pill: 'Mất kết nối máy in', lost: true },
  { name: 'B. agent tem sống, agent A4 chết', agents: [agent('may-kho-01', LABEL_CAPS, 4), agent('may-a4-01', ['xa_vai_sheet:v1'], 900)], pill: 'Máy in rảnh', lost: false },
  { name: 'C. agent tem báo hết giấy, A4 sẵn sàng', agents: [agent('may-kho-01', LABEL_CAPS, 4, { ok: true, blocked: true, message: 'Hết giấy tem' }), agent('may-a4-01', ['xa_vai_sheet:v1'], 1)], pill: 'Hết giấy tem', lost: false },
  { name: 'D. chỉ có agent A4', agents: [agent('may-a4-01', ['xa_vai_sheet:v1'], 2)], pill: 'Mất kết nối máy in', lost: true },
  { name: 'E. hai agent tem, lấy agent liên lạc mới nhất', agents: [agent('may-kho-02', LABEL_CAPS, 700), agent('may-kho-01', LABEL_CAPS, 5)], pill: 'Máy in rảnh', lost: false }
];

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const scenario of CASES) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/rpc/print_queue_status')) {
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: scenario.agents } }) });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: {} }) });
      });
      await page.goto(BASE + '#group-uid');
      const text = page.locator('#uid-printer-text');
      await page.waitForFunction(() => !/^Đang kiểm tra/.test(document.getElementById('uid-printer-text')?.textContent || ''));
      assert.equal((await text.textContent()).trim(), scenario.pill, `${scenario.name}: thẻ máy in IN TEM GROUP UID`);

      const legacy = await page.evaluate(() => fetch('legacy://print-queue-shim', { method: 'POST', body: JSON.stringify({ action: 'pr_hangdoi' }) }).then(response => response.json()));
      assert.equal(legacy.status, 'success', `${scenario.name}: pr_hangdoi thành công`);
      const lostLegacy = !legacy.may || legacy.may.ro === true;
      assert.equal(lostLegacy, scenario.lost, `${scenario.name}: pr_hangdoi báo mất liên lạc = ${scenario.lost}`);
      if (!scenario.lost && scenario.pill !== 'Máy in rảnh') assert.equal(legacy.may.chu, scenario.pill, `${scenario.name}: pr_hangdoi lấy thông báo của agent tem`);
      await context.close();
      console.log(`PASS ${scenario.name}`);
    }
  } finally {
    await browser.close();
  }
  console.log('PASS printer_pill_capability_browser');
})().catch(error => { console.error(error); process.exit(1); });
