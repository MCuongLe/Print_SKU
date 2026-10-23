// Chuẩn báo lỗi / khung chờ / trạng thái rỗng / thẻ trạng thái (23/10/2026, Đợt 6 theo đánh giá frontend; người dùng chọn "Làm Đợt 6").
// 1) Lỗi kỹ thuật (Failed to fetch, Supabase HTTP …, internal error) hiện thành lời dễ hiểu; câu nghiệp vụ giữ nguyên.
// 2) Lỗi khi tải dữ liệu có nút Thử lại (gọi lại máy chủ), khung lỗi dạng dải có icon.
// 3) Đang tải: thẻ số "—" và dòng "Chưa có…" thành vạch chờ; xong thì bỏ.
// 4) Trạng thái rỗng có icon; thẻ trạng thái chỉ tô màu khi có số.
// Chạy với python -m http.server 8000 (đổi bằng BASE). Không gọi mạng thật: mọi request ra ngoài bị cắt / trả lỗi giả.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const RAW = /Failed to fetch|Supabase|HTTP \d|internal error|NetworkError/i;
const SCREENS = [
  ['storage-risk', 'sr-status'], ['inventory-audit', 'ia-status'], ['group-uid-history', 'uh-message'], ['uid-block', 'ub-message'],
  ['cap-vai', 'cap-vai-message'], ['xa-vai', 'xa-vai-message'], ['cut-group-uid', 'cut-message'],
];

const open = async (browser, hash, { width = 1280, height = 900, mobile = false, route } = {}) => {
  const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
  const errors = []; page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', route || (q => q.request().url().startsWith(BASE) ? q.continue() : q.abort('internetdisconnected')));
  await page.goto(BASE + hash, { waitUntil: 'load' });
  page.errors = errors;
  return page;
};
const notice = (page, id) => page.evaluate(id => {
  const el = document.getElementById(id); if (!el) return null;
  const b = el.querySelector(':scope > .ps-retry'), r = b && b.getBoundingClientRect(), s = getComputedStyle(el), before = getComputedStyle(el, '::before');
  return { text: el.textContent.trim(), tone: el.dataset.tone, retry: b ? { label: b.getAttribute('aria-label'), h: Math.round(r.height), w: Math.round(r.width) } : null,
    bg: s.backgroundColor, icon: /svg/.test(before.maskImage || before.webkitMaskImage || '') };
}, id);
const waitNotice = async (page, id, ms = 6000) => {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(150)) { const n = await notice(page, id); if (n && n.tone === 'error' && n.retry) return n; }
  return notice(page, id);
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // 1) Lời dễ hiểu: bảng chuyển chữ kỹ thuật; câu nghiệp vụ giữ nguyên
    {
      const page = await open(browser, '#location');
      const r = await page.evaluate(async () => {
        const N = window.PrintSkuNotice; if (!N) return null;
        const cases = ['Failed to fetch', 'Không tải được: TypeError: Failed to fetch', 'Supabase HTTP 503', 'Supabase HTTP 404', 'Supabase HTTP 401', 'Supabase HTTP 200',
          'Supabase từ chối yêu cầu', 'internal error', 'JWT expired', 'signal is aborted without reason', 'UID không tồn tại', 'Máy chưa kích hoạt'].map(t => [t, N.clean(t)]);
        // Theo dõi data-tone: phần tử báo lỗi của module được đổi chữ, câu nghiệp vụ không đổi
        const p = document.createElement('p'); p.className = 'cut-message'; document.body.append(p);
        p.textContent = 'Không lưu được: Failed to fetch'; p.dataset.tone = 'error'; await new Promise(r => setTimeout(r, 0)); const a = p.textContent;
        p.textContent = 'UID đã cắt rồi'; p.dataset.tone = 'error'; await new Promise(r => setTimeout(r, 0)); const b = p.textContent;
        p.remove(); return { cases: Object.fromEntries(cases), a, b };
      });
      assert.ok(r, 'thiếu window.PrintSkuNotice');
      const c = r.cases;
      assert.equal(c['Failed to fetch'], 'Mất kết nối mạng');
      assert.equal(c['Không tải được: TypeError: Failed to fetch'], 'Không tải được: mất kết nối mạng');
      assert.equal(c['Supabase HTTP 503'], 'Máy chủ đang lỗi');
      assert.equal(c['Supabase HTTP 404'], 'Máy chủ chưa có chức năng này');
      assert.equal(c['Supabase HTTP 401'], 'Hết phiên hoặc không có quyền');
      assert.equal(c['Supabase HTTP 200'], 'Dữ liệu trả về không đúng');
      assert.equal(c['Supabase từ chối yêu cầu'], 'Máy chủ từ chối yêu cầu');
      assert.equal(c['internal error'], 'Máy chủ đang lỗi');
      assert.equal(c['JWT expired'], 'Hết phiên đăng nhập');
      assert.equal(c['signal is aborted without reason'], 'Hết thời gian chờ');
      assert.equal(c['UID không tồn tại'], 'UID không tồn tại');
      assert.equal(c['Máy chưa kích hoạt'], 'Máy chưa kích hoạt');
      assert.equal(r.a, 'Không lưu được: mất kết nối mạng');
      assert.equal(r.b, 'UID đã cắt rồi');
      assert.deepEqual(page.errors, []);
      await page.close();
    }

    // 2) Mất mạng ở 7 màn tải dữ liệu: lời dễ hiểu + dải lỗi có icon + nút Thử lại (máy tính ≥ 36 px, điện thoại ≥ 44 px)
    for (const [width, mobile, minH] of [[1280, false, 36], [390, true, 44]]) {
      for (const [route, id] of SCREENS) {
        const page = await open(browser, '#' + route, { width, mobile, height: 844 });
        const n = await waitNotice(page, id);
        const at = `${route} ${width}`;
        assert.ok(n && n.tone === 'error', `${at}: không thấy lỗi ở #${id} (${JSON.stringify(n)})`);
        assert.ok(!RAW.test(n.text), `${at}: còn chữ kỹ thuật "${n.text}"`);
        assert.match(n.text, /mất kết nối mạng/i, `${at}: "${n.text}"`);
        assert.match(n.text, /^(Không|Chưa) (tải|tra cứu) được [^:]*\S: /, `${at}: lỗi chưa nói phần nào không tải được "${n.text}"`);
        assert.ok(n.retry, `${at}: thiếu nút Thử lại`);
        assert.equal(n.retry.label, 'Thử lại');
        assert.ok(n.retry.h >= minH, `${at}: nút Thử lại cao ${n.retry.h} < ${minH}`);
        assert.notEqual(n.bg, 'rgba(0, 0, 0, 0)', `${at}: lỗi chưa thành dải`);
        assert.ok(n.icon, `${at}: dải lỗi thiếu icon`);
        assert.deepEqual(page.errors, [], at);
        await page.close();
      }
    }

    // 3) Thử lại gọi lại máy chủ; lỗi lần hai vẫn có nút
    {
      let calls = 0;
      const page = await open(browser, '#storage-risk', { route: q => { const u = q.request().url(); if (u.startsWith(BASE)) return q.continue(); if (/\/rest\/v1\/rpc\//.test(u)) calls++; return q.abort('internetdisconnected'); } });
      await waitNotice(page, 'sr-status');
      const before = calls;
      await page.click('#sr-status .ps-retry');
      const n = await waitNotice(page, 'sr-status');
      assert.ok(calls > before, `Thử lại không gọi lại máy chủ (${before} → ${calls})`);
      assert.ok(n.retry, 'lỗi lần hai thiếu nút Thử lại');
      await page.close();
    }

    // 4) Khung chờ: đang tải → aria-busy + thẻ "—" thành vạch + dòng "Chưa có…" ẩn chữ; xong thì bỏ
    {
      const page = await open(browser, '#storage-risk', { route: async q => { const u = q.request().url(); if (u.startsWith(BASE)) return q.continue(); await new Promise(r => setTimeout(r, 1600)); return q.abort('internetdisconnected'); } });
      await page.waitForTimeout(800);
      const busy = await page.evaluate(() => ({
        busy: document.getElementById('storage-risk-screen').getAttribute('aria-busy'),
        skel: document.querySelectorAll('#storage-risk-screen .ss-metric strong.ps-skel').length,
        emptyColor: getComputedStyle(document.querySelector('#sr-body td.ss-empty')).color,
      }));
      assert.equal(busy.busy, 'true', 'đang tải mà màn chưa aria-busy');
      assert.ok(busy.skel >= 3, `thẻ số chưa thành vạch chờ (${busy.skel})`);
      assert.equal(busy.emptyColor, 'rgba(0, 0, 0, 0)', 'đang tải mà vẫn hiện chữ "Chưa có…"');
      await waitNotice(page, 'sr-status', 9000);
      const done = await page.evaluate(() => ({ busy: document.getElementById('storage-risk-screen').getAttribute('aria-busy'), skel: document.querySelectorAll('.ps-skel').length }));
      assert.notEqual(done.busy, 'true', 'tải xong mà màn vẫn aria-busy');
      assert.equal(done.skel, 0, 'tải xong mà còn vạch chờ');
      await page.close();
    }
    // Tải nhanh (< 350 ms) không nháy vạch chờ: ghi nhận MỌI lần aria-busy được bật từ lúc mở trang, không chỉ trạng thái cuối
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.addInitScript(() => { window.__busySeen = 0; new MutationObserver(rs => rs.forEach(r => { if (r.target.getAttribute('aria-busy') === 'true') window.__busySeen++; })).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['aria-busy'] }); });
      await page.route('**/*', q => q.request().url().startsWith(BASE) ? q.continue() : q.abort('internetdisconnected'));
      await page.goto(BASE + '#inventory-audit', { waitUntil: 'load' });
      await page.waitForTimeout(1200);
      assert.equal(await page.evaluate(() => window.__busySeen), 0, 'tải nhanh mà vẫn bật vạch chờ');
      await page.close();
    }
    // Xả vải: tra cứu chậm cũng có khung chờ
    {
      const page = await open(browser, '#xa-vai', { route: async q => { const u = q.request().url(); if (u.startsWith(BASE)) return q.continue(); await new Promise(r => setTimeout(r, 1600)); return q.abort('internetdisconnected'); } });
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => document.getElementById('xa-vai-screen').getAttribute('aria-busy')), 'true', 'Xả vải tra cứu chậm mà không có khung chờ');
      await page.close();
    }
    // Lịch sử Group UID: tổng quan lỗi nhưng tra cứu thành công về sau → lỗi + Thử lại vẫn còn (không bị tra cứu xoá)
    {
      const page = await open(browser, '#group-uid-history', { route: async q => {
        const u = q.request().url(); if (u.startsWith(BASE)) return q.continue();
        if (u.endsWith('/rpc/group_uid_moves_lookup')) { await new Promise(r => setTimeout(r, 500)); return q.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { items: [], total: 0, truncated: false } }) }); }
        return q.abort('internetdisconnected');
      } });
      await page.waitForTimeout(2200);
      const n = await notice(page, 'uh-message');
      assert.equal(n.tone, 'error', `tra cứu thành công đã xoá lỗi tổng quan (${JSON.stringify(n)})`);
      assert.ok(n.retry, 'lỗi tổng quan mất nút Thử lại');
      assert.match(n.text, /lịch sử Group UID/);
      await page.close();
    }

    // 5) Thẻ trạng thái chỉ tô màu khi có số
    for (const route of ['storage-risk', 'site-control']) {
      const page = await open(browser, '#' + route);
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const cards = [...document.querySelectorAll('section.cut-screen:not([hidden]) .ss-metric[data-tone][data-zero="true"]')].filter(c => c.getBoundingClientRect().width);
        const bgs = cards.map(c => getComputedStyle(c).backgroundColor);
        const c = cards[0]; if (c) c.dataset.zero = 'false';
        return { n: cards.length, bgs, on: c && getComputedStyle(c).backgroundColor };
      });
      assert.ok(r.n >= 2, `${route}: không thấy thẻ có màu (${r.n})`);
      assert.ok(r.bgs.every(b => b === 'rgb(255, 255, 255)'), `${route}: thẻ chưa có số vẫn tô màu ${r.bgs.join(' ')}`);
      assert.notEqual(r.on, 'rgb(255, 255, 255)', `${route}: có số mà thẻ không tô màu`);
      await page.close();
    }

    // Lịch sử Group UID: thẻ Trả NCC chỉ tô vàng khi có số (data-zero của module giữ nghĩa "đã tải và bằng 0")
    {
      const page = await open(browser, '#group-uid-history');
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => { const s = document.querySelector('[data-uh-kind="vr"] strong'); const t = s.textContent.trim(), dash = getComputedStyle(s).color, plain = getComputedStyle(document.querySelector('[data-uh-kind="all"] strong')).color; s.textContent = '3'; s.closest('[data-uh-kind]').removeAttribute('data-empty'); return { t, dash, plain, num: getComputedStyle(s).color }; });
      assert.equal(r.t, '—');
      assert.equal(r.dash, r.plain, `Trả NCC chưa có số vẫn tô màu ${r.dash} (thẻ thường ${r.plain})`);
      assert.equal(r.num, 'rgb(138, 91, 0)', `Trả NCC có số mà không tô vàng (${r.num})`);
      await page.close();
    }

    // 6) Trạng thái rỗng có icon (mask Lucide inbox) và căn giữa
    for (const [route, sel] of [['location', '#loc-empty'], ['storage-risk', '#sr-body td.ss-empty'], ['worker', '#root section p.text-center.text-sm.text-slate-500'], ['group-uid', '#uid-pending .uid-empty']]) {
      const page = await open(browser, '#' + route);
      await page.waitForTimeout(900);
      const r = await page.evaluate(sel => { const el = document.querySelector(sel); if (!el) return null; const b = getComputedStyle(el, '::before'); return { icon: /svg/.test(b.maskImage || b.webkitMaskImage || ''), h: parseFloat(b.height), align: getComputedStyle(el).textAlign }; }, sel);
      assert.ok(r, `${route}: không thấy ${sel}`);
      assert.ok(r.icon && r.h >= 20, `${route}: trạng thái rỗng thiếu icon (${JSON.stringify(r)})`);
      assert.equal(r.align, 'center', `${route}: trạng thái rỗng chưa căn giữa`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('PASS notice standard: lời dễ hiểu (12 mẫu + theo dõi data-tone), 7 màn × 2 khổ có dải lỗi + Thử lại, Thử lại gọi lại máy chủ, khung chờ (bật/tắt, không nháy khi nhanh), thẻ chỉ tô khi có số, 4 trạng thái rỗng có icon');
})().catch(e => { console.error(e); process.exitCode = 1; });
