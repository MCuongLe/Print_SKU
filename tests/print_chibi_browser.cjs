// Animation chibi dùng chung cho mọi lệnh PrintSkuQueue (SKU, Group UID, vị trí):
// hiện trong lúc máy chủ nhận lệnh, bật tick khi vào hàng đợi, lỗi thì đóng ngay.
// Supabase giả lập, chỉ dùng mã tổng hợp. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const context = await browser.newContext({ viewport: { width, height } });
      const page = await context.newPage();
      let reply = { ok: true, data: { id: '11111111-1111-4111-8111-111111111111', status: 'queued' } };
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/rpc/print_enqueue')) {
          const body = JSON.parse(route.request().postData() || '{}'), by = body.p_requested_by;
          await new Promise(resolve => setTimeout(resolve, by === 'slow-ok' ? 900 : by === 'fail-fast' ? 100 : 300));
          const result = by === 'fail-fast' ? { ok: false, error: { code: 'ACCESS_DENIED', message: 'Máy chưa kích hoạt' } } : reply;
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [] } }) });
      });
      await page.goto(BASE + '#home');
      const overlay = page.locator('#print-chibi-overlay');
      const live = page.locator('#print-chibi-status');
      await live.waitFor({ state: 'attached' });
      assert.equal(await live.evaluate(node => Boolean(node.closest('#print-chibi-overlay'))), false, 'live-region phải tồn tại ngoài phần hình bị đóng/ẩn');
      assert.equal(await overlay.isHidden(), true, `${width}px: ban đầu phải ẩn`);

      for (const type of ['sku', 'group_uid', 'location']) {
        await page.evaluate(type => {
          const item = type === 'sku' ? { sku: '900000091', productName: 'SKU giả', copies: 1 }
            : type === 'group_uid' ? { groupUid: '1028260000000091', sku: '900000091', copies: 1 }
              : { code: 'Z99-T01-001-01-01-01', name: 'Vị trí giả', copies: 1 };
          window.__printPromise = window.PrintSkuQueue.enqueue({ type, payload: { items: [item] }, copies: 1, requestedBy: 'test-animation' });
        }, type);
        await overlay.waitFor({ state: 'visible' });
        const visual = await overlay.evaluate(node => {
          const box = node.getBoundingClientRect(), style = getComputedStyle(node), image = node.querySelector('.print-chibi-character');
          return { state: node.dataset.state, position: style.position, backdrop: style.backdropFilter, box: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)], image: image?.getAttribute('src'), visibleCopy: node.querySelectorAll('.print-chibi-copy').length };
        });
        assert.equal(visual.state, 'sending', `${type}: trạng thái gửi lệnh`);
        assert.equal(visual.position, 'fixed');
        assert.ok(!visual.backdrop || visual.backdrop === 'none', 'không dùng backdrop-filter nặng');
        assert.deepEqual(visual.box, [0, 0, width, height], `${type}: phủ đúng viewport`);
        assert.equal(visual.image, 'assets/ai-thinking-chibi-simple.png');
        assert.equal(visual.visibleCopy, 0, 'animation không thêm dòng trạng thái nhìn thấy');
        const result = await page.evaluate(() => window.__printPromise);
        assert.equal(result.ok, true);
        assert.equal(await overlay.getAttribute('data-state'), 'done', `${type}: nhận lệnh xong phải bật tick`);
        await overlay.waitFor({ state: 'hidden' });
      }

      reply = { ok: false, error: { code: 'ACCESS_DENIED', message: 'Máy chưa kích hoạt' } };
      await page.evaluate(() => { window.__printPromise = window.PrintSkuQueue.enqueue({ type: 'location', payload: { items: [{ code: 'Z99-T01-001-01-01-02', copies: 1 }] }, copies: 1 }); });
      await overlay.waitFor({ state: 'visible' });
      const failed = await page.evaluate(() => window.__printPromise);
      assert.equal(failed.ok, false);
      await overlay.waitFor({ state: 'hidden' });
      assert.equal(await overlay.getAttribute('data-state'), 'sending', 'lỗi phải reset trạng thái để lần sau dùng lại');

      reply = { ok: true, data: { id: '22222222-2222-4222-8222-222222222222', status: 'queued' } };
      await page.evaluate(() => {
        const send = requestedBy => window.PrintSkuQueue.enqueue({ type: 'location', payload: { items: [{ code: 'Z99-T01-001-01-01-03', copies: 1 }] }, copies: 1, requestedBy });
        window.__slowPrint = send('slow-ok'); window.__fastPrint = send('fail-fast');
      });
      await overlay.waitFor({ state: 'visible' });
      const fast = await page.evaluate(() => window.__fastPrint);
      assert.equal(fast.ok, false);
      await overlay.waitFor({ state: 'hidden', timeout: 500 });
      assert.equal((await page.evaluate(() => window.__slowPrint)).ok, true);
      assert.equal(await overlay.isHidden(), true, 'lệnh đồng thời còn lại không được bật tick sau khi một lệnh đã lỗi');
      await context.close();
    }
    console.log('print_chibi_browser: SKU + Group UID + vị trí dùng chung chibi gửi lệnh; success bật tick, lỗi đóng ngay — passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
