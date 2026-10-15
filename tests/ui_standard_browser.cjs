// Chuẩn giao diện chung (11/10/2026, khối CSS #ui-standard) cho mọi ô trang chủ (390 + 1280 px) và Admin (1280 px):
// thẻ bo 22 / 14; tiêu đề khối = chấm tròn số 30 / 22 + chữ 18/600 (không ẩn ở khổ nào); ô nhập + nút hành động cao 52 / 48,
// nút viên thuốc / bo 12, chữ 16/600, ô nhập bo 13 / 10; nút chỉ có icon cạnh ô nhập vuông 52 / 48; ô Group UID liền (Cắt UID, Xả vải, Cấp vải) có camera · bàn phím nằm trong ô
// cao 44 / 40; điều khiển gọn (tab, ô tìm/lọc,
// chip lọc, nút trong dòng, nút icon thanh công cụ Admin) cao 44. Dữ liệu giả rỗng. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const MODULES = ['worker', 'group-uid', 'location', 'cut-group-uid', 'find-sku', 'unit-converter', 'xa-vai', 'inspection', 'storage-risk', 'group-uid-history', 'inventory-audit', 'site-control'];
const ADMIN = ['admin/lenh-in', 'admin/sku-sync', 'admin/group-uid-sync', 'admin/cauhinh'];
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '00000000-0000-0000-0000-000000000001', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;

const audit = mobile => {
  let root = document.elementFromPoint(innerWidth / 2 + (document.querySelector('.ss-screen:not([hidden]), #root aside') ? 140 : 0), 260);
  while (root && root.parentElement && root.parentElement !== document.body) root = root.parentElement;
  const vis = e => { const b = e.getBoundingClientRect(), s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0'; };
  const cs = e => getComputedStyle(e);
  const nm = e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const brand = c => /rgb\(0, (95|103), (65|71)\)/.test(c);
  const S = mobile ? { cardR: 14, num: 22, ctl: 48, btnR: 12, inR: 10 } : { cardR: 22, num: 30, ctl: 52, btnR: 26, inR: 13 };
  const near = (a, b, d = 1) => Math.abs(a - b) <= d;
  const bad = [];
  const admin = Boolean(root && (root.classList.contains('ss-screen') || root.id === 'root' && root.querySelector('aside')));
  // Thẻ
  const metric = '.ss-metric, .storage-risk__card, .pj-stat';
  const cards = [...root.querySelectorAll(`section, article, div, form, ${metric}`)].filter(e => vis(e) && !e.closest('header, dialog, .uid-topbar, aside, .pss') && (e.matches(metric) ? e.getBoundingClientRect().width > 60 : e.getBoundingClientRect().width > 260 && cs(e).backgroundColor === 'rgb(255, 255, 255)' && parseFloat(cs(e).borderTopLeftRadius) >= 10));
  for (const c of cards.filter(c => !cards.some(o => o !== c && o.contains(c)))) { const r = Math.round(parseFloat(cs(c).borderTopLeftRadius)); if (r !== S.cardR) bad.push(`thẻ bo ${r} · ${nm(c)}`); }
  // Tiêu đề khối có số
  for (const n of root.querySelectorAll('.uid-panel__num, .cut-card h2 > span, .uc-lookup > summary > span:first-child, #root > main > section > p.items-baseline > b')) {
    const h = n.closest('h2') || n.parentElement.querySelector('h2, strong') || n.nextElementSibling, host = n.closest('.cut-card, .uid-panel, .uid-card, section, details');
    if (!vis(n)) { if (host && vis(host)) bad.push(`tiêu đề khối bị ẩn · "${(h?.textContent || '').trim().slice(0, 20)}"`); continue; }
    const w = Math.round(n.getBoundingClientRect().width); if (w !== S.num || !brand(cs(n).backgroundColor) || cs(n).borderRadius !== '50%') bad.push(`số ${w}px · ${nm(n)}`);
    if (h && `${cs(h).fontSize}/${cs(h).fontWeight}` !== '18px/600') bad.push(`tiêu đề ${cs(h).fontSize}/${cs(h).fontWeight} · "${h.textContent.trim().slice(0, 20)}"`);
  }
  // Nút hành động (chữ, nền xanh hoặc trắng có viền, rộng ≥ 96)
  for (const b of root.querySelectorAll('button')) {
    if (!vis(b) || b.closest('[role=tablist], .cut-tabs, .as-tabs, .uh-seg, .fsk-seg, .uc-kind, .pss, dialog, table, .uid-row, .as-tags, aside, header, .ss-top, .as-strip, .uid-auto__qty') || b.matches(`${metric}, .as-tab, .pj-type, .min-h-\\[42px\\], .min-h-\\[38px\\]`)) continue;
    const bb = b.getBoundingClientRect(), s = cs(b), text = b.innerText.trim();
    if (bb.width < 96 || !text) continue;
    const prim = brand(s.backgroundColor), sec = s.backgroundColor === 'rgb(255, 255, 255)' && parseFloat(s.borderTopWidth) >= 1;
    if (!prim && !sec) continue;
    const h = Math.round(bb.height), r = Math.round(Math.min(parseFloat(s.borderTopLeftRadius), bb.height / 2));
    if (!near(h, S.ctl) || !(mobile ? near(r, S.btnR) : r >= Math.floor(bb.height / 2) - 1) || s.fontSize !== '16px' || s.fontWeight !== '600') bad.push(`${prim ? 'nút chính' : 'nút phụ'} ${h}px r${r} ${s.fontSize}/${s.fontWeight} · ${nm(b)} "${text.slice(0, 18)}"`);
  }
  // Ô nhập thường (bỏ ô tìm/lọc trên thanh công cụ = điều khiển gọn, ô số trong bộ tăng giảm)
  for (const i of root.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=range]), select')) {
    if (!vis(i) || i.closest('.pss, dialog, table, .uid-row, .as-tags, .uid-auto__qty, .fsk-stepper, .as-search, .pj-day, .pj-search, .as-tools') || i.getBoundingClientRect().width < 80) continue;
    const wrap = i.closest('.uh-field, .fsk-inrow'), box = wrap && cs(wrap).borderTopWidth !== '0px' ? wrap : i, s = cs(i);
    const h = Math.round(box.getBoundingClientRect().height), r = Math.round(parseFloat(cs(box).borderTopLeftRadius));
    if (!near(h, S.ctl) || !near(r, S.inR) || s.fontSize !== '16px') bad.push(`ô nhập ${h}px r${r} ${s.fontSize} · ${nm(box)}`);
  }
  // Nút chỉ có icon cạnh ô nhập: vuông bằng điều khiển thường
  for (const b of root.querySelectorAll('#uid-camera, #uc-camera, #fsk-more-open, #f-sku-kb, .ss-hero .as-icon-btn')) {
    if (!vis(b)) continue; const r = b.getBoundingClientRect();
    if (!near(r.width, S.ctl) || !near(r.height, S.ctl)) bad.push(`nút icon ${Math.round(r.width)}×${Math.round(r.height)} · ${nm(b)}`);
  }
  // Ô Group UID liền (#scan-field, 14/10/2026): camera · bàn phím nằm gọn trong ô, cao = ô nhập − 8
  for (const b of root.querySelectorAll('.scan-field__tools > button')) {
    if (!vis(b)) continue; const r = b.getBoundingClientRect(), f = b.closest('.scan-field').querySelector('input').getBoundingClientRect();
    if (!near(r.height, S.ctl - 8) || r.top < f.top || r.bottom > f.bottom || r.left < f.left || r.right > f.right) bad.push(`nút trong ô ${Math.round(r.width)}×${Math.round(r.height)} · ${nm(b)}`);
  }
  // Điều khiển gọn: 44
  for (const e of root.querySelectorAll('.cut-tab, .as-tab, .pj-type, .pj-day, .pj-search, .as-search, .pj-icon, .ss-top-refresh, #root aside ~ div button.min-h-\\[42px\\], #root aside ~ div button.min-h-\\[38px\\]')) {
    if (!vis(e) || e.closest('dialog')) continue; const h = Math.round(e.getBoundingClientRect().height);
    if (!near(h, 44)) bad.push(`điều khiển gọn ${h}px · ${nm(e)}`);
  }
  if (admin) for (const h of root.querySelectorAll('.ss-hero h2, .adm-group')) if (vis(h)) { const want = h.matches('.adm-group') ? '18px/600' : '22px/600'; if (`${cs(h).fontSize}/${cs(h).fontWeight}` !== want) bad.push(`tiêu đề ${cs(h).fontSize}/${cs(h).fontWeight} · "${h.textContent.trim().slice(0, 20)}"`); }
  return { root: root && (root.id || root.className), bad: [...new Set(bad)] };
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
        return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [], runs: [], devices: [] } });
      });
      for (const route of mobile ? MODULES : [...MODULES, ...ADMIN]) {
        await page.goto(BASE + '#' + route);
        await page.waitForTimeout(1000);
        const { root, bad } = await page.evaluate(audit, mobile);
        assert.ok(root, `${route}: không thấy màn`);
        for (const item of bad) problems.push(`${width}px ${route}: ${item}`);
      }
      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) { console.error(problems.slice(0, 60).join('\n')); console.error(`… ${problems.length} chỗ lệch chuẩn chung`); process.exitCode = 1; return; }
  console.log(`PASS chuẩn chung: ${MODULES.length} module × 2 khổ + ${ADMIN.length} màn Admin — thẻ, tiêu đề khối, ô nhập, nút, nút icon, điều khiển gọn`);
})().catch(error => { console.error(error); process.exitCode = 1; });
