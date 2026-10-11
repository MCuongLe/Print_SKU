// Ảnh nền 4 nhóm (11/10/2026, khối #group-banners): thanh trên mọi màn mang ảnh của nhóm (In tem xanh lá, Vận hành kho xanh dương, Kiểm tra cam,
// Quản trị tím), thanh tiêu đề 4 thẻ nhóm ở trang chủ cũng vậy; máy tính thanh trên cao 80 px; chữ trắng đủ tương phản (≥ 4,5 đo trên điểm ảnh sáng
// nhất dưới chữ). Dữ liệu giả, không gọi Supabase thật. Chạy với python -m http.server 8000 (đổi bằng biến BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const JWT = `${b64({ alg: 'HS256' })}.${b64({ sub: '1', exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
const FILL = { print: '#1d7651', ops: '#0b47a6', check: '#b9500c', admin: '#4f3cad' };
const SCREENS = [
  ['worker', '#root > header', '#root > header h1', 'print'], ['group-uid', '#uid-screen .uid-topbar', '#uid-title', 'print'], ['location', '#location-screen .uid-topbar', '#loc-title', 'print'],
  ['cut-group-uid', '#cut-group-uid-screen .uid-topbar', '#cut-title', 'ops'], ['group-uid-history', '#uidhist-screen .uid-topbar', '#uh-title', 'ops'], ['find-sku', '#find-sku-screen .uid-topbar', '#fsk-title', 'ops'],
  ['unit-converter', '#unit-converter-screen .uid-topbar', '#uc-title', 'ops'], ['xa-vai', '#xa-vai-screen .uid-topbar', '#xa-vai-title', 'ops'],
  ['inspection', '#ins-screen .uid-topbar', '#ins-title', 'check'], ['storage-risk', '#storage-risk-screen .uid-topbar', '#storage-risk-title', 'check'],
  ['admin/lenh-in', '#print-jobs-screen .ss-top', '#print-jobs-heading', 'admin'], ['admin/sku-sync', '#sku-sync-screen .ss-top', '#sku-sync-heading', 'admin'], ['admin/cauhinh', '#root header.ss-command-react', '#root header.ss-command-react h1', 'admin']
];

// Tương phản chữ trắng với điểm ảnh sáng nhất trong vùng chữ (ẩn chữ rồi chụp)
const contrast = async (page, selector) => {
  const box = await page.evaluate(sel => {
    const el = document.querySelector(sel), range = document.createRange(); el.scrollIntoView({ block: 'center' }); range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter(r => r.width);
    const left = Math.max(0, Math.min(...rects.map(r => r.left))), top = Math.min(...rects.map(r => r.top));
    const right = Math.min(innerWidth, Math.max(...rects.map(r => r.right))), bottom = Math.max(...rects.map(r => r.bottom));
    el.style.visibility = 'hidden';
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, selector);
  const png = await page.screenshot({ clip: box });
  const value = await page.evaluate(async data => {
    const img = new Image(); img.src = 'data:image/png;base64,' + data; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data, lin = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; };
    let max = 0; for (let i = 0; i < d.length; i += 4) max = Math.max(max, .2126 * lin(d[i]) + .7152 * lin(d[i + 1]) + .0722 * lin(d[i + 2]));
    return 1.05 / (max + .05);
  }, png.toString('base64'));
  await page.evaluate(sel => { document.querySelector(sel).style.visibility = ''; }, selector);
  return value;
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      await context.addInitScript(token => sessionStorage.setItem('print-sku-admin-session-v1', JSON.stringify({ access_token: token, refresh_token: 'r' })), JWT);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith('/auth/v1/user')) return json({ id: '1' });
        if (url.includes('/rest/v1/user_roles')) return json([{ username: 'A', role: 'admin' }]);
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
        return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [], devices: [] } });
      });
      const lows = [];
      for (const [route, bar, title, tone] of SCREENS) {
        if (mobile && route.startsWith('admin')) continue; // Admin chỉ dùng trên máy tính
        await page.goto(BASE + '#' + route);
        await page.locator(bar).first().waitFor({ state: 'visible' });
        await page.waitForTimeout(300);
        const m = await page.evaluate(([bar, title]) => {
          const el = document.querySelector(bar), cs = getComputedStyle(el), h = document.querySelector(title);
          return { img: /data:image\/webp;base64,/.test(cs.backgroundImage), fill: cs.getPropertyValue('--gb-fill').trim(), h: Math.round(el.getBoundingClientRect().height), color: getComputedStyle(h).color };
        }, [bar, title]);
        assert.equal(m.img, true, `${route}: thanh trên có ảnh nền nhóm`);
        assert.equal(m.fill, FILL[tone], `${route}: đúng nhóm ${tone}`);
        assert.equal(m.color, 'rgb(255, 255, 255)', `${route}: tên màn chữ trắng`);
        if (!mobile) assert.equal(m.h, 80, `${route}: thanh trên máy tính cao 80 px (${m.h})`);
        else assert.ok(m.h <= 72, `${route}: điện thoại giữ thanh trên gọn (${m.h})`);
        const c = await contrast(page, title);
        if (c < 4.5) lows.push(`${route} ${c.toFixed(2)}`);
      }
      // Trang chủ: thanh tiêu đề 4 thẻ nhóm
      await page.goto(BASE + '#home');
      await page.locator('#barcode-home .barcode-home__group-head').first().waitFor();
      const heads = await page.evaluate(() => [...document.querySelectorAll('#barcode-home .barcode-home__group')].map(g => { const h = g.querySelector('.barcode-home__group-head'), cs = getComputedStyle(h); return `${g.dataset.tone}|${/data:image\/webp;base64,/.test(cs.backgroundImage)}|${cs.getPropertyValue('--gb-fill').trim()}|${getComputedStyle(g.querySelector('h2')).color}`; }));
      for (const head of heads) { const [tone, img, fill, color] = head.split('|'); assert.equal(img, 'true', `trang chủ ${tone}: có ảnh`); assert.equal(fill, FILL[tone]); assert.equal(color, 'rgb(255, 255, 255)'); }
      for (const tone of ['print', 'ops', 'check', 'admin']) {
        const c = await contrast(page, `#barcode-home [data-tone="${tone}"] .barcode-home__group-title`);
        if (c < 4.5) lows.push(`trang chủ ${tone} ${c.toFixed(2)}`);
      }
      assert.deepEqual(lows, [], `${width}px: chữ trắng thiếu tương phản trên ảnh`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: thanh trên ${mobile ? 10 : 13} màn đúng ảnh nhóm${mobile ? '' : ', cao 80 px'}, 4 thẻ nhóm trang chủ, chữ trắng tương phản ≥ 4,5`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
