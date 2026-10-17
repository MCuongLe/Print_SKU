// Khả năng tiếp cận (11/10/2026): quét axe-core (WCAG 2.0/2.1/2.2 A + AA và best-practice) từng màn — 11 màn trang chủ ở 390 + 1280 px,
// 5 màn Admin ở 1280 px — không được có lỗi nào (mọi mức). axe-core chỉ dùng khi test: cài một lần bằng `npm install` ở thư mục gốc
// repo (package.json), không nhúng vào app. Dữ liệu giả rỗng. Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');

let AXE;
try { AXE = require.resolve('axe-core/axe.min.js', { paths: [path.join(__dirname, '..')] }); } catch (_) {
  console.error('Chưa có axe-core: chạy `npm install` ở thư mục gốc repo rồi chạy lại test này.'); process.exit(1);
}
const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SCREENS = { home: '#barcode-home', worker: '#root', 'group-uid': '#uid-screen', location: '#location-screen', 'cut-group-uid': '#cut-group-uid-screen', 'find-sku': '#find-sku-screen', 'unit-converter': '#unit-converter-screen', 'xa-vai': '#xa-vai-screen', inspection: '#ins-screen', 'storage-risk': '#storage-risk-screen', 'group-uid-history': '#uidhist-screen', 'inventory-audit': '#inventory-audit-screen', 'site-control': '#site-control-screen', assistant: '#assistant-screen' };
const ADMIN = { 'admin/lenh-in': '#print-jobs-screen', 'admin/sku-sync': '#sku-sync-screen', 'admin/group-uid-sync': '#group-uid-sync-screen', 'admin/cauhinh': '#root' };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '00000000-0000-0000-0000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems = [];
  let scanned = 0;
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      await context.addInitScript(t => sessionStorage.setItem('print-sku-admin-session-v1', JSON.stringify({ access_token: t, refresh_token: 'r' })), JWT);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
        if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Admin', role: 'admin' }]);
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
        return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [], devices: [] } });
      });
      for (const [route, selector] of Object.entries(mobile ? SCREENS : { ...SCREENS, ...ADMIN })) {
        await page.goto(BASE + '#' + route);
        await page.locator(selector).first().waitFor({ state: 'visible' });
        await page.waitForTimeout(900);
        await page.addScriptTag({ path: AXE });
        const violations = await page.evaluate(async ({ selector, tags }) => (await axe.run({ include: [selector] }, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })).violations
          .map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(n => n.target.join(' ')) })), { selector, tags: TAGS });
        scanned++;
        for (const v of violations) problems.push(`${width}px ${route}: [${v.impact}] ${v.id} × ${v.nodes.length} — ${v.nodes.slice(0, 3).join(' | ')}`);
      }
      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) { console.error(problems.join('\n')); console.error(`… ${problems.length} lỗi axe`); process.exitCode = 1; return; }
  console.log(`PASS axe: ${scanned} lượt quét (11 màn × 2 khổ + 5 Admin) — 0 lỗi WCAG A/AA + best-practice`);
})().catch(error => { console.error(error); process.exitCode = 1; });
