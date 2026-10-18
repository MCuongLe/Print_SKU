// Nút đọc dữ liệu gộp vào dải mốc giờ (18/10/2026, khối #strip-read): bỏ thẻ thanh lệnh (hero) ở KIỂM KÊ, KIỂM SOÁT CÔNG TRÌNH, LỊCH SỬ GROUP UID;
// nút Admin nằm trong ô đầu của dải "Cập nhật lúc / Kho đã đọc…" (cạnh mốc giờ); RỦI RO LƯU TRỮ: nút ở cuối hàng tab (tab nào đang mở thì nút của tab đó).
// Máy tính: nút gọn cao 36, chữ 14/600 + icon; điện thoại: nút tròn chỉ icon 44 (chữ vẫn là tên truy cập). Trạng thái Extension = chấm màu ở góc nút.
// Admin giả lập (sessionStorage + /auth/v1/user), dữ liệu rỗng giả, không gọi Supabase thật. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const CELL = [
  { screen: 'inventory-audit', tools: 'ia-admin-tools', strip: 'ia-strip', buttons: ['ia-run'], chip: 'ia-connection' },
  { screen: 'site-control', tools: 'sc-admin-tools', strip: 'sc-strip', buttons: ['sc-run'], chip: 'sc-connection' },
  { screen: 'group-uid-history', tools: 'uh-admin-tools', strip: 'uh-strip', buttons: ['uh-run', 'uh-full'] },
];
const SCREEN_ID = { 'inventory-audit': 'inventory-audit-screen', 'site-control': 'site-control-screen', 'group-uid-history': 'uidhist-screen', 'storage-risk': 'storage-risk-screen' };

const measure = ({ tools, buttons, chip, screenId }) => {
  const r = e => { if (!e) return null; const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const wrap = document.getElementById(tools), hero = document.querySelector(`#${screenId} .ss-hero`);
  return {
    heroRects: [...document.querySelectorAll(`#${screenId} .ss-hero`)].reduce((n, h) => n + h.getClientRects().length, 0),
    heroH2: hero ? hero.querySelector('h2')?.textContent.trim() : null,
    wrap: r(wrap), wrapVisible: !!wrap && wrap.getClientRects().length > 0, parentIsFirstCell: !!wrap && wrap.parentElement === wrap.parentElement?.parentElement?.firstElementChild && wrap.parentElement.parentElement.classList.contains('as-strip'),
    cell: wrap && r(wrap.parentElement), strip: wrap && r(wrap.parentElement.parentElement),
    label: wrap && r(wrap.parentElement.querySelector(':scope > span')), value: wrap && r(wrap.parentElement.querySelector(':scope > strong')),
    buttons: buttons.map(id => { const b = document.getElementById(id), s = getComputedStyle(b), t = b.querySelector('.src-read__t');
      return { id, ...r(b), font: `${s.fontSize}/${s.fontWeight}`, name: (b.getAttribute('aria-label') || b.innerText || b.textContent).trim(), textW: t ? t.getBoundingClientRect().width : 0, bg: s.backgroundColor }; }),
    chip: chip ? (c => ({ ...r(c), bg: getComputedStyle(c, '::before').backgroundColor || getComputedStyle(c).backgroundColor, state: c.dataset.state, text: c.textContent.trim() }))(document.getElementById(chip)) : null,
    overflow: document.documentElement.scrollWidth > innerWidth,
  };
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems = [], ran = [];
  const near = (a, b, d = 1) => Math.abs(a - b) <= d;
  try {
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const mobile = width <= 760, tag = `${width}px`;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 800, hasTouch: width < 800 });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => {
        const url = route.request().url(), json = b => route.fulfill({ contentType: 'application/json', body: JSON.stringify(b) });
        if (url.startsWith(BASE)) return route.continue();
        if (url.endsWith('/auth/v1/user')) return json({ id: 'test-admin' });
        if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
        return json({ ok: true, data: { run: null, rows: [], items: [], runs: [] } });
      });

      for (const c of CELL) {
        const bad = m => problems.push(`${tag} · ${c.screen}: ${m}`);
        await page.goto(BASE + '#' + c.screen);
        await page.locator('#' + c.tools).waitFor({ state: 'visible', timeout: 8000 }).catch(() => bad('Admin không thấy nút đọc'));
        await page.waitForTimeout(300);
        const m = await page.evaluate(measure, { ...c, screenId: SCREEN_ID[c.screen] });
        if (m.heroRects) bad('còn thẻ thanh lệnh (hero) chiếm chỗ');
        if (!m.heroH2) bad('mất tiêu đề h2 của hero (giữ cho trình đọc màn hình)');
        if (!m.parentIsFirstCell) bad('nhóm nút không nằm trong ô đầu của dải mốc giờ');
        if (!m.wrapVisible) continue;
        const cell = m.cell;
        if (cell.h > (mobile ? 96 : 92)) bad(`ô mốc giờ cao ${Math.round(cell.h)}px (nút làm ô phình)`);
        for (const b of m.buttons) {
          if (b.l < cell.l - 1 || b.r > cell.r + 1 || b.t < cell.t - 1 || b.b > cell.b + 1) bad(`#${b.id} tràn khỏi ô`);
          if (m.label && b.l < m.label.r - 1 && b.t < m.label.b && b.b > m.label.t) bad(`#${b.id} đè lên nhãn ô`);
          if (m.value && b.l < m.value.r - 1 && b.t < m.value.b && b.b > m.value.t) bad(`#${b.id} đè lên giá trị ô`);
          if (!/Đọc/.test(b.name)) bad(`#${b.id} mất tên truy cập (${b.name})`);
          if (mobile) {
            if (!near(b.w, 44) || !near(b.h, 44)) bad(`#${b.id} điện thoại ${Math.round(b.w)}×${Math.round(b.h)} ≠ 44×44 tròn`);
            if (b.textW > 1) bad(`#${b.id} điện thoại còn hiện chữ (chỉ icon)`);
          } else {
            if (!near(b.h, 36)) bad(`#${b.id} cao ${Math.round(b.h)} ≠ 36`);
            if (b.id !== 'uh-full') { if (b.font !== '14px/600') bad(`#${b.id} chữ ${b.font} ≠ 14px/600`); if (b.textW < 20) bad(`#${b.id} máy tính phải có chữ`); }
            else if (!near(b.w, 36)) bad(`#uh-full rộng ${Math.round(b.w)} ≠ 36 (tròn)`);
          }
        }
        if (m.chip) {
          const btn = m.buttons[0], ch = m.chip;
          if (ch.w > 12 || ch.h > 12) bad(`chip Extension ${Math.round(ch.w)}×${Math.round(ch.h)} — phải là chấm ≤ 12 px`);
          if (Math.abs(ch.r - btn.r) > 8 || Math.abs(ch.t - btn.t) > 8) bad('chấm trạng thái không nằm ở góc trên phải nút');
          if (!ch.text) bad('chip mất chữ trạng thái (vẫn cần cho trình đọc màn hình)');
          if (ch.state === 'error' && !/rgb\(2[0-9]{2}, [0-9]{2}, [0-9]{2}\)/.test(ch.bg)) bad(`chấm lỗi không đỏ (${ch.bg})`);
        }
        // Codex 18/10/2026: điện thoại — nhãn ô đầu một dòng; Lịch sử UID: dải mốc giờ (có nút đọc) ngay sau khối tìm, trước thẻ số liệu (không tụt xuống cuối màn)
        if (mobile) {
          const extra = await page.evaluate(id => {
            const lead = document.querySelector(`#${id} > .as-strip__lead > span`), lh = parseFloat(getComputedStyle(lead).lineHeight) || 16;
            const strip = document.getElementById(id).getBoundingClientRect(), search = document.querySelector('#uidhist-screen .uh-search'), metrics = document.querySelector('#uidhist-screen .uh-metrics');
            return { labelLines: Math.round(lead.getBoundingClientRect().height / lh), stripTop: strip.top, searchBottom: search?.getBoundingClientRect().bottom ?? null, metricsTop: metrics?.getBoundingClientRect().top ?? null };
          }, c.strip);
          if (extra.labelLines > 1) bad(`nhãn ô đầu xuống ${extra.labelLines} dòng`);
          if (c.screen === 'group-uid-history' && !(extra.stripTop >= extra.searchBottom && extra.stripTop < extra.metricsTop)) bad('dải mốc giờ (nút đọc) không nằm giữa khối tìm và thẻ số liệu');
        }
        if (m.overflow) bad('trang tràn ngang');
        ran.push(`${tag} ${c.screen}`);
      }

      // RỦI RO LƯU TRỮ: nút cuối hàng tab, đổi theo tab
      {
        const bad = m => problems.push(`${tag} · storage-risk: ${m}`);
        await page.goto(BASE + '#storage-risk');
        await page.locator('#sr-admin-tools').waitFor({ state: 'visible', timeout: 8000 }).catch(() => bad('Admin không thấy nút đọc'));
        await page.waitForTimeout(300);
        const read = () => page.evaluate(() => {
          const r = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height, on: e.getClientRects().length > 0 && b.width > 0 }; };
          const tabs = document.getElementById('srt-tabs'), row = tabs.parentElement;
          return { heroRects: [...document.querySelectorAll('#storage-risk-screen .ss-hero')].reduce((n, h) => n + h.getClientRects().length, 0), rowIsWrap: row.classList.contains('sr-tabrow'),
            inRow: ['sr-admin-tools', 'srt-admin-tools'].every(id => document.getElementById(id).parentElement === row),
            tabs: r(tabs), row: r(row), sr: r(document.getElementById('sr-run')), srt: r(document.getElementById('srt-run')), overflow: document.documentElement.scrollWidth > innerWidth };
        });
        const check = (s, on, off, view) => {
          if (s.heroRects) bad(`${view}: còn thẻ thanh lệnh (hero)`);
          if (!s.rowIsWrap || !s.inRow) bad(`${view}: nút không nằm trong hàng tab (.sr-tabrow)`);
          if (!s[on].on) bad(`${view}: không thấy #${on === 'sr' ? 'sr-run' : 'srt-run'}`);
          if (s[off].on) bad(`${view}: nút của tab kia vẫn hiện`);
          const b = s[on];
          if (Math.abs((b.t + b.h / 2) - (s.tabs.t + s.tabs.h / 2)) > 4) bad(`${view}: nút không cùng hàng với tab`);
          if (Math.abs(b.r - s.row.r) > 1) bad(`${view}: nút không sát mép phải hàng tab`);
          if (b.l < s.tabs.r) bad(`${view}: nút đè lên tab`);
          if (mobile ? !(near(b.w, 44) && near(b.h, 44)) : !near(b.h, 36)) bad(`${view}: cỡ nút ${Math.round(b.w)}×${Math.round(b.h)}`);
          if (s.overflow) bad(`${view}: trang tràn ngang`);
        };
        const main = await read(); check(main, 'sr', 'srt', 'tab Hàng chưa lên kệ');
        await page.locator('#srt-tab-temp').click(); await page.waitForTimeout(300);
        const temp = await read(); check(temp, 'srt', 'sr', 'tab UID tạm');
        // Hai tab có bề rộng khung nội dung khác nhau từ trước (UID tạm rộng hơn) → chỉ kiểm nút sát mép phải hàng tab ở mỗi tab (trong check).
        ran.push(`${tag} storage-risk ×2 tab`);
      }
      if (errors.length) problems.push(`${tag}: lỗi JavaScript: ${errors.slice(0, 3).join(' | ')}`);
      await context.close();
    }
  } finally { await browser.close(); }
  if (problems.length) { console.error(problems.join('\n')); console.error(`… ${problems.length} chỗ lệch`); process.exitCode = 1; return; }
  console.log(`PASS nút đọc trong dải mốc giờ: ${ran.length} lượt (Kiểm kê, Công trình, Lịch sử UID, Rủi ro lưu trữ 2 tab × 1280 / 390) — không còn thẻ hero, nút gọn 36 / tròn 44 chỉ icon, chấm trạng thái Extension, không tràn`);
})().catch(error => { console.error(error); process.exitCode = 1; });
