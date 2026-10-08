// Màn #admin/sku-sync: icon Lucide thay ký tự, không có câu hướng dẫn dài, tiêu đề bảng đổi theo nhóm, ô cảnh báo, preview hết hạn.
// Run against python -m http.server 8000. Supabase, Edge Function và Extension được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const MIN = 60000;
const ago = minutes => new Date(Date.now() - minutes * MIN).toISOString();

const CHANGES = {
  skus: { added: [{ sku: '900000001', after: { product_name: 'SKU thử', category_name: 'Thời Trang (Phụ Liệu)' } }], updated: [] },
  combos: {
    added: [], updated: [],
    orphaned: [
      { comboSku: 'C0', normalSku: 'OLD', quantity: 2, comboName: 'Combo C0', reason: 'component_removed' },
      { comboSku: 'GONE', normalSku: 'N5', quantity: 1, comboName: '', reason: 'combo_missing' },
    ],
    excluded: [{ comboSku: 'C1', normalSku: 'N1', quantity: 1000, missing: 'combo' }, { comboSku: 'C2', normalSku: 'N2', quantity: 6, missing: 'normal' }],
  },
  sourceIssues: [
    { type: 'partial_combo_description', combo_sku: 'C3', combo_name: 'Combo ba', description: 'Combo C3=A1 + B 1', reason: 'Bỏ qua thành phần: B 1' },
    { type: 'unparsed_combo_description', combo_sku: 'C4', description: 'Ghi chú <b>tự do</b>', reason: 'Mô tả không đúng dạng Combo A=B+C' },
  ],
};
const SOURCE_COUNTS = { normalRows: 3, comboRows: 1000, selectedComboLinks: 10, excludedBreakdown: { bothMissing: 990, oneMissing: 2, outOfCategory: 0 }, sourceIssues: 2 };
const CHANGE_COUNTS = { skuAdded: 1, skuUpdated: 0, comboAdded: 0, comboUpdated: 0, comboOrphaned: 2 };
const RUNS = [
  { id: 'run-fresh', status: 'previewed', created_at: ago(5), change_counts: CHANGE_COUNTS },
  { id: 'run-old', status: 'previewed', created_at: ago(45), change_counts: CHANGE_COUNTS },
  { id: 'run-done', status: 'completed', created_at: ago(120), completed_at: ago(119), change_counts: {} },
];

const mockRoutes = async page => page.route('**/*', async route => {
  const url = route.request().url();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
  if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
  if (url.includes('/functions/v1/sku-sync')) {
    const { action, runId } = JSON.parse(route.request().postData() || '{}');
    const ok = data => json({ ok: true, data });
    if (action === 'history') return ok({ runs: RUNS, lastSuccessAt: ago(119), lastSnapshotAt: ago(120) });
    if (action === 'preview') return ok({ runId: 'run-fresh', status: 'previewed', sourceCounts: SOURCE_COUNTS, changeCounts: CHANGE_COUNTS, changes: CHANGES });
    if (action === 'detail') {
      const run = RUNS.find(item => item.id === runId);
      return ok({ ...run, cutoff: 'x', source_counts: SOURCE_COUNTS, change_counts: run.change_counts, changes: CHANGES, verification: {}, error_message: null });
    }
    return json({ ok: false, error: { message: 'chưa giả lập ' + action } }, 400);
  }
  if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
});

// Extension giả: trả lời PING và GET_SKU_SYNC_DATA qua postMessage như app-bridge.js.
const fakeExtension = () => addEventListener('message', event => {
  const request = event.data;
  if (!request || request.source !== 'PRINT_SKU_APP') return;
  const data = request.type === 'PING'
    ? { version: '0.3.3' }
    : { generatedAt: new Date().toISOString(), cutoff: 'x', categories: [], normalRows: [], comboRows: [], sourceCounts: {} };
  postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: request.requestId, ok: true, data }, location.origin);
});

const headers = page => page.locator('#ss-change-head th').allInnerTexts();
// Nhóm cảnh báo phải hiện đủ cả 4 cột kể cả ở điện thoại (quy tắc ẩn cột 3 chỉ dành cho bảng thay đổi thường)
const allVisible = async page => { for (const th of await page.locator('#ss-change-head th').all()) assert.equal(await th.isVisible(), true); };
const cells = async page => (await page.locator('#ss-change-body tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent.trim()))));

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await mockRoutes(page);
      await page.goto(BASE + '#admin/sku-sync');
      await page.locator('#sku-sync-screen').waitFor({ state: 'visible' });
      await page.locator('#ss-history tr[data-run]').first().waitFor();

      // Menu và nút Về trang chủ/Đăng xuất dùng icon SVG, không dùng ký tự
      const navButtons = page.locator('.ss-nav button');
      assert.equal(await navButtons.count(), 4);
      for (let index = 0; index < 4; index += 1) assert.equal(await navButtons.nth(index).locator('svg').count(), 1, `mục menu ${index + 1} có icon`);
      assert.equal(await page.locator('.ss-side-foot button svg').count(), 2);
      const chrome = await page.locator('.ss-side, .ss-top').allInnerTexts();
      for (const glyph of ['▦', '☷', '⚙', '⇄', '←']) assert.equal(chrome.join('').includes(glyph), false, `không còn ký tự ${glyph}`);

      // Không có câu hướng dẫn/giải thích dài
      const screenText = await page.locator('#sku-sync-screen').innerText();
      for (const phrase of ['Extension đọc phiên Inside', 'Edge Function đối chiếu', 'Không tự xóa SKU', 'Chọn một lượt để xem', 'Bấm “Kiểm tra']) assert.equal(screenText.includes(phrase), false, `đã bỏ câu "${phrase}"`);
      assert.equal(await page.locator('.ss-hero p, .ss-note').count(), 0);
      assert.equal((await page.locator('#ss-change-note').innerText()).trim(), '');

      // Lịch sử: preview quá 30 phút hiện "Hết hạn" và khóa nút Cập nhật
      const badges = await page.locator('#ss-history .ss-badge').allInnerTexts();
      assert.deepEqual(badges, ['Chờ cập nhật', 'Hết hạn', 'Hoàn tất']);
      await page.locator('#ss-history tr[data-run="run-old"]').click();
      await page.waitForFunction(() => document.getElementById('ss-change-title').textContent !== 'Chi tiết thay đổi');
      assert.equal(await page.locator('#ss-apply').isDisabled(), true);

      // Tạo preview: ô cảnh báo sáng lên, tiêu đề bảng đổi theo từng nhóm
      await page.locator('#sku-sync-preview').click();
      await page.waitForFunction(() => /cảnh báo/.test(document.getElementById('sku-sync-status').textContent));
      assert.equal(await page.locator('#ss-apply').isDisabled(), false);
      assert.equal((await page.locator('#sku-sync-status').innerText()).includes('Xem chi tiết'), false);
      for (const [id, count] of [['ss-combo-orphaned', '2'], ['ss-combo-excluded', '2'], ['ss-source-issues', '2']]) {
        assert.equal((await page.locator('#' + id).innerText()).trim(), count);
        assert.equal(await page.locator('#' + id).evaluate(node => node.closest('.ss-metric').dataset.alert), 'true');
      }

      assert.deepEqual(await headers(page), ['Mã', 'Loại thay đổi', 'Giá trị cũ', 'Giá trị mới']); // nhóm mặc định (SKU mới)

      await page.locator('[data-change-kind="combo-orphaned"]').click();
      assert.deepEqual(await headers(page), ['Combo → Normal', 'Lý do', 'Trong Supabase', 'Trên Inside']);
      await allVisible(page);
      assert.deepEqual(await cells(page), [
        ['C0 → OLD', 'Thành phần không còn', 'Số lượng: 2 · Combo C0', 'Không còn'],
        ['GONE → N5', 'Combo không còn', 'Số lượng: 1', 'Không còn'],
      ]);
      assert.equal((await page.locator('#ss-change-note').innerText()).trim(), '2 dòng');

      await page.locator('[data-change-kind="combo-excluded"]').click();
      assert.deepEqual(await headers(page), ['Combo → Normal', 'Loại', 'Số lượng', 'SKU chưa có trong database']);
      await allVisible(page);
      assert.deepEqual(await cells(page), [['C1 → N1', 'Thiếu SKU', '1000', 'Combo'], ['C2 → N2', 'Thiếu SKU', '6', 'Normal']]);

      await page.locator('[data-change-kind="source-issues"]').click();
      assert.deepEqual(await headers(page), ['Mã', 'Loại lỗi', 'Nội dung trên Inside', 'Lý do']);
      await allVisible(page);
      const issues = await cells(page);
      assert.deepEqual(issues[0], ['C3', 'Thiếu thành phần', 'Combo C3=A1 + B 1', 'Bỏ qua thành phần: B 1']);
      assert.equal(issues[1][2], 'Ghi chú <b>tự do</b>');
      assert.equal(await page.locator('#ss-change-body b').count(), 0, 'nội dung từ Inside không được chèn thành HTML');

      await page.locator('[data-change-kind="sku-added"]').click();
      assert.deepEqual(await headers(page), ['Mã', 'Loại thay đổi', 'Giá trị cũ', 'Giá trị mới']);

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: menu icon SVG, không câu hướng dẫn, tiêu đề bảng theo nhóm, ô cảnh báo, preview hết hạn, không tràn ngang/lỗi`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
