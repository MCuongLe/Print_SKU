// Cỡ chạm + ký hiệu trạng thái (22/10/2026, đợt 1 theo skill UI UX Pro Max): điện thoại ≥ 44 px, máy tính ≥ 24 px (WCAG 2.5.8),
// hai nút khác việc đứng cạnh nhau cách ≥ 8 px; ✓ ✗ ⚠ trong chuỗi thông báo thay bằng icon Lucide gắn theo màu trạng thái.
// kg/gr và tiêu đề cột sắp xếp giữ nguyên hình, chỉ nới vùng bấm (::after) — đo bằng elementFromPoint ngay ngoài mép hình.
// Chạy với python -m http.server 8000 (đổi bằng BASE). Dữ liệu giả rỗng, không gọi mạng thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '00000000-0000-0000-0000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

// Vùng bấm theo chiều dọc: điểm cách mép trên/dưới `out` px (ngoài khung hình) vẫn trúng chính nút đó
const hitHeight = ([selector, out]) => {
  const els = [...document.querySelectorAll(selector)].filter(el => el.getBoundingClientRect().height > 0);
  return els.map(el => {
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2;
    const hit = y => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
    return { name: (el.textContent || '').trim().slice(0, 12), h: Math.round(r.height), above: hit(r.top - out), below: hit(r.bottom + out) };
  });
};

(async () => {
  // Chuỗi thông báo không còn ký hiệu chữ làm icon
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  for (const bad of ['T(`✓ ', 'T(`✗ ', 'T("✗ ', '`⚠ <b>Máy in đang mắc', 's.ok?"✓ ":"✗ "', '`✓ ${code}'])assert.ok(!html.includes(bad), `còn ký hiệu chữ: ${bad}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
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
      const open = async (route, selector) => { await page.goto(BASE + '#' + route); await page.locator(selector).first().waitFor({ state: 'visible' }); await page.waitForTimeout(600); };

      if (mobile) {
        await open('worker', '#f-ban');
        const ban = await page.locator('#f-ban').boundingBox();
        assert.ok(ban.width >= 44 && ban.height >= 44, `IN TEM SKU: ô Số bản in ${Math.round(ban.width)}×${Math.round(ban.height)}, cần ≥ 44`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'IN TEM SKU: không cuộn ngang');

        await open('cut-group-uid', '#cs-mode-free');
        for (const id of ['#cs-mode-free', '#cs-mode-po']) {
          const b = await page.locator(id).boundingBox();
          assert.ok(b.height >= 44, `CẮT GROUP UID: ${id} cao ${Math.round(b.height)}, cần ≥ 44`);
        }

        await open('unit-converter', '#uc-weight-unit');
        for (const r of await page.evaluate(hitHeight, ['#uc-weight-unit button', 4.9])) {
          assert.ok(r.h + 2 * 4.9 >= 43.5 && r.above && r.below, `CHUYỂN ĐỔI ĐƠN VỊ: nút ${r.name} vùng bấm chưa đủ 44 (cao ${r.h}, trên ${r.above}, dưới ${r.below})`);
        }
        const gap = await page.evaluate(() => document.querySelector('#uc-code-form').getBoundingClientRect().top - document.querySelector('#uc-lookup-details > summary').getBoundingClientRect().bottom);
        assert.ok(gap >= 8, `CHUYỂN ĐỔI ĐƠN VỊ: tiêu đề "Nhận diện hàng" cách hàng mã ${gap} px, cần ≥ 8`);

        await open('cap-vai', '#cap-vai-sound');
        const tools = await page.evaluate(() => document.querySelector('#cap-vai-fold').getBoundingClientRect().left - document.querySelector('#cap-vai-sound').getBoundingClientRect().right);
        assert.ok(tools >= 8, `CẤP VẢI: nút Âm báo và Thu gọn cách ${tools} px, cần ≥ 8`);
      } else {
        for (const [route, selector] of [['storage-risk', '#storage-risk-screen .as-th'], ['inventory-audit', '#inventory-audit-screen .as-th']]) {
          await open(route, selector);
          const heads = await page.evaluate(hitHeight, [selector, 3.9]);
          assert.ok(heads.length >= 4, `${route}: phải thấy tiêu đề cột`);
          for (const r of heads) assert.ok(r.h + 2 * 3.9 >= 23.5 && r.above && r.below, `${route}: tiêu đề cột "${r.name}" vùng bấm chưa đủ 24 (cao ${r.h}, trên ${r.above}, dưới ${r.below})`);
        }
      }

      // Icon trạng thái theo màu: thông báo in / Thử kết nối (bundle React) và nhãn quét trên camera IN TEM SKU
      const icons = await page.evaluate(() => {
        const root = document.getElementById('root'), mk = (cls, parent, attrs = {}) => { const p = document.createElement('p'); p.className = cls; Object.assign(p.dataset, attrs); p.textContent = 'Mẫu'; parent.append(p); return p; };
        const mask = el => { const s = getComputedStyle(el, '::before'); return s.content !== 'none' && s.width === '16px' ? (s.webkitMaskImage || s.maskImage) : 'none'; };
        return {
          ok: mask(mk('tt-msg text-tt-ok', root)), xau: mask(mk('tt-msg text-tt-xau', root)), canh: mask(mk('tt-msg text-tt-canh', root)), muted: mask(mk('tt-msg text-slate-500', root)),
          scanOk: mask(mk('pss-status', document.body, { tone: 'ok' })), scanWarn: mask(mk('pss-status', document.body, { tone: 'warn' })),
        };
      });
      for (const k of ['ok', 'xau', 'canh', 'scanOk', 'scanWarn']) assert.match(icons[k], /^url\("data:image\/svg\+xml/, `icon trạng thái ${k}`);
      assert.equal(new Set([icons.ok, icons.xau, icons.canh]).size, 3, 'ok / xau / canh mỗi loại một icon');
      assert.equal(icons.ok, icons.scanOk, 'nhãn quét đúng dùng cùng icon với thông báo đúng');
      assert.equal(icons.canh, icons.scanWarn, 'nhãn quét cảnh báo dùng cùng icon với thông báo cảnh báo');
      assert.equal(icons.muted, 'none', 'thông báo trung tính không có icon');
      // Nhãn quét trên camera: chữ trắng 14 px trên nền trạng thái ≥ 4.5:1 (Codex 22/10: nền cũ 3.8:1 và 4.1:1)
      const contrast = await page.evaluate(() => [...document.querySelectorAll('p.pss-status[data-tone]')].map(p => {
        const [r, g, b] = getComputedStyle(p).backgroundColor.match(/[\d.]+/g).map(Number);
        const lin = c => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        return [p.dataset.tone, Math.round(105 / (0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) + 0.05)) / 100];
      }));
      for (const [tone, ratio] of contrast) assert.ok(ratio >= 4.5, `nhãn quét ${tone}: tương phản ${ratio}:1, cần ≥ 4.5`);

      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      console.log(`PASS ${width}px: cỡ chạm ${mobile ? '≥ 44 (Số bản in, Cắt tự do/Theo PO, kg/gr) + khoảng cách ≥ 8 (Nhận diện hàng, Cấp vải)' : '≥ 24 (tiêu đề cột Rủi ro lưu trữ, Kiểm kê)'}; icon trạng thái Lucide`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
