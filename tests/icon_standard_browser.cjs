// Đợt 3 (11/10/2026, khối CSS #icon-standard): icon Lucide nét 2, chỉ 4 cỡ 16 · 20 · 24 · 32; không còn ký tự làm icon (→ ← ×);
// chỗ icon nói được thì không có chữ hướng dẫn (phụ đề thanh trên, placeholder "Quét hoặc nhập…", "bỏ trống nếu không có"…);
// nút chỉ có icon luôn có tên (aria-label/title). Điện thoại 390 px + máy tính 1280 px (Admin chỉ máy tính). Dữ liệu giả rỗng.
// Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const USER = ['home', 'worker', 'group-uid', 'location', 'cut-group-uid', 'find-sku', 'unit-converter', 'xa-vai', 'inspection', 'storage-risk', 'group-uid-history'];
const ADMIN = ['admin/lenh-in', 'admin/sku-sync', 'admin/group-uid-sync', 'admin/kiem-ke', 'admin/cauhinh'];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '00000000-0000-0000-0000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
const GUIDE = ['Quét hoặc nhập', 'Quét mã hoặc gõ tay', 'Nhập hoặc quét', 'để tra tên', 'bỏ trống nếu không có', 'danh sách đang trống', 'Hoặc dùng file', 'Import từ file', 'Chọn file PO', 'Nhập file Excel', 'Xem trong Tra cứu', 'Mở dashboard', 'không SKU thì chọn'];

const audit = guide => {
  let root = document.elementFromPoint(innerWidth / 2, 200);
  while (root && root.parentElement && root.parentElement !== document.body) root = root.parentElement;
  const vis = e => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden'; };
  const bad = [];
  for (const svg of root.querySelectorAll('svg[viewBox="0 0 24 24"]')) {
    if (!vis(svg) || svg.parentElement.closest('svg')) continue;
    const b = svg.getBoundingClientRect(), shape = svg.querySelector('path,circle,rect,line,polyline,polygon,ellipse'), cs = getComputedStyle(shape || svg);
    const host = svg.parentElement, label = (host.getAttribute('aria-label') || host.textContent || host.className || '').toString().trim().slice(0, 20);
    if (![16, 20, 24, 32].includes(Math.round(b.width)) || Math.round(b.width) !== Math.round(b.height)) bad.push(`icon ${Math.round(b.width)}×${Math.round(b.height)} · ${label}`);
    if (cs.stroke !== 'none' && cs.strokeWidth !== '2px') bad.push(`nét ${cs.strokeWidth} · ${label}`);
  }
  for (const el of root.querySelectorAll('*')) {
    if (!vis(el) || el.closest('svg')) continue;
    const cs = getComputedStyle(el), own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
    if (own && parseFloat(cs.fontSize) > 0 && /^[→←×✕]$|\s[→←]$/.test(own)) bad.push(`ký tự làm icon "${own.slice(-24)}"`);
    const text = /^(INPUT|TEXTAREA)$/.test(el.tagName) ? el.placeholder || '' : own;
    for (const g of guide) if (text.includes(g)) bad.push(`chữ hướng dẫn "${text.slice(0, 40)}"`);
    if (el.tagName === 'BUTTON' && !el.textContent.trim() && !el.getAttribute('aria-label') && !el.getAttribute('title') && !el.getAttribute('aria-labelledby')) bad.push(`nút chỉ có icon nhưng không có tên · ${el.id || el.className}`);
  }
  for (const sub of root.querySelectorAll('.uid-topbar__name > span')) if (vis(sub)) bad.push(`phụ đề thanh trên "${sub.textContent.trim()}"`);
  return { root: root && (root.id || root.className), bad };
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems = [];
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
        return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [] } });
      });
      for (const route of mobile ? USER : [...USER, ...ADMIN]) {
        await page.goto(BASE + '#' + route);
        await page.waitForTimeout(900);
        if (route === 'group-uid') { await page.locator('#uid-tab-auto').click(); await page.waitForTimeout(200); }
        const { root, bad } = await page.evaluate(audit, GUIDE);
        assert.ok(root, `${route}: không thấy màn`);
        for (const item of bad) problems.push(`${width}px ${route}: ${item}`);
      }
      // Xả vải: nút bàn phím chỉ là icon ở mọi khổ, tên nằm ở aria-label
      await page.goto(BASE + '#xa-vai'); await page.locator('#xa-vai-keyboard').waitFor({ state: 'visible' });
      const kb = await page.locator('#xa-vai-keyboard').evaluate(b => ({ w: Math.round(b.getBoundingClientRect().width), font: getComputedStyle(b).fontSize, label: b.getAttribute('aria-label') }));
      assert.ok(kb.w <= 48 && kb.font === '0px' && /bàn phím/.test(kb.label), `${width}px: nút bàn phím Xả vải chỉ icon (${JSON.stringify(kb)})`);
      await page.locator('#xa-vai-keyboard').click();
      assert.match(await page.locator('#xa-vai-keyboard').getAttribute('aria-label'), /bàn phím/, 'bấm xong vẫn có tên');
      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) { console.error(problems.slice(0, 60).join('\n')); console.error(`… ${problems.length} chỗ lệch chuẩn icon`); process.exitCode = 1; return; }
  console.log(`PASS chuẩn icon: ${USER.length} màn × 2 khổ + ${ADMIN.length} màn Admin — icon 16/20/24/32 nét 2, không ký tự làm icon, không chữ hướng dẫn, nút icon có tên`);
})().catch(error => { console.error(error); process.exitCode = 1; });
