// Chuẩn chữ toàn app (10/10/2026, khối #type-standard): mọi chữ đang hiện trên các màn dùng một font hệ thống,
// cỡ thuộc thang 12·13·14·16·18·22·28, đậm 400·600·700, chữ hoa/giãn chữ chỉ ở chỗ cho phép.
// Điện thoại 390 px + máy tính 1280 px (Admin chỉ máy tính). Dữ liệu giả rỗng, không gọi Supabase thật.
// Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const USER = ['home', 'worker', 'group-uid', 'fabric-relaxation', 'location', 'cut-group-uid', 'find-sku', 'unit-converter', 'xa-vai', 'inspection', 'sample', 'storage-risk', 'group-uid-history'];
const ADMIN = ['admin/lenh-in', 'admin/sku-sync', 'admin/group-uid-sync', 'admin/kiem-ke', 'admin/cauhinh'];

// Chạy trong trang: liệt kê chữ lệch chuẩn trong màn đang hiện (phần tử gốc nằm ở giữa màn hình)
const audit = () => {
  const SIZES = [12, 13, 14, 16, 18, 22, 28], WEIGHTS = ['400', '600', '700'];
  const UPPER_OK = '.barcode-home__group-title, .ins-row--head, .loc-code';
  let root = document.elementFromPoint(innerWidth / 2, 200);
  while (root && root.parentElement && root.parentElement !== document.body) root = root.parentElement;
  const bad = [];
  for (const el of (root || document.body).querySelectorAll('*')) {
    if (el.closest('svg, code, kbd, pre, script, style, template')) continue;
    const box = el.getBoundingClientRect(), cs = getComputedStyle(el);
    if (!box.width || !box.height || cs.visibility === 'hidden') continue;
    const field = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && !/checkbox|radio|hidden|file|range|color/.test(el.type);
    const text = field ? (el.value || el.placeholder || '') : [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (!text) continue;
    const size = parseFloat(cs.fontSize), name = `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : ''} "${text.slice(0, 24)}"`;
    if (!/^system-ui/.test(cs.fontFamily)) bad.push(`font ${cs.fontFamily.split(',')[0]} · ${name}`);
    if (size && !SIZES.includes(size) && !(size >= 46 && el.closest('.sample-result__no, .sample-modal__no'))) bad.push(`cỡ ${size}px · ${name}`);
    if (!WEIGHTS.includes(cs.fontWeight)) bad.push(`đậm ${cs.fontWeight} · ${name}`);
    const upperOk = el.closest(UPPER_OK);
    if (cs.textTransform === 'uppercase' && !upperOk) bad.push(`chữ hoa · ${name}`);
    if (!/^(normal|0px)$/.test(cs.letterSpacing) && !upperOk) bad.push(`giãn chữ ${cs.letterSpacing} · ${name}`);
  }
  return { root: root && (root.id || root.className), bad };
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems = [];
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      await context.addInitScript(() => sessionStorage.setItem('print-sku-admin-session-v1', JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
        if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
        return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [] } });
      });
      for (const route of mobile ? USER : [...USER, ...ADMIN]) {
        await page.goto(BASE + '#' + route);
        await page.waitForTimeout(900);
        const { root, bad } = await page.evaluate(audit);
        assert.ok(root, `${route}: không thấy màn`);
        for (const item of bad) problems.push(`${width}px ${route}: ${item}`);
      }
      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) { console.error(problems.slice(0, 80).join('\n')); console.error(`… ${problems.length} chữ lệch chuẩn`); process.exitCode = 1; return; }
  console.log(`PASS chuẩn chữ: ${USER.length} màn × 2 khổ + ${ADMIN.length} màn Admin — một font hệ thống, cỡ 12·13·14·16·18·22·28, đậm 400·600·700`);
})().catch(error => { console.error(error); process.exitCode = 1; });
