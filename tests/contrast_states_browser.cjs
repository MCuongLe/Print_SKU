// Tương phản màu trạng thái + nhãn ô + cỡ chạm bộ lọc (23/10/2026, đợt 2b theo skill UI UX Pro Max; số đo trước sửa trong RULES.md 23/10).
// Chữ thường cần ≥ 4,5:1 (tính cả opacity của phần tử/cha và nền cha). Dựng mẫu đúng lớp CSS của từng màn (dữ liệu giả).
// Chạy với python -m http.server 8000 (đổi bằng BASE). Không gọi mạng thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

// Màu chữ hiệu dụng (alpha + opacity các tầng cha) trên nền hiệu dụng (ghép các nền trong suốt lên trắng) → tỉ lệ tương phản
const ratio = sel => {
  const el = document.querySelector(sel); if (!el) return `không có ${sel}`;
  const rgba = c => { const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const over = (top, bot) => [0, 1, 2].map(i => top[i] * top[3] + bot[i] * (1 - top[3])).concat(1);
  let bg = [255, 255, 255, 1]; const chain = [];
  for (let n = el; n; n = n.parentElement) chain.push(n);
  for (const n of chain.reverse()) { const b = rgba(getComputedStyle(n).backgroundColor); if (b[3] > 0) bg = over(b, bg); }
  let op = 1; for (let n = el; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
  const f = rgba(getComputedStyle(el).color); f[3] *= op;
  const fg = over(f, bg);
  const L = c => { const l = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2]); };
  const a = L(fg), b = L(bg);
  return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
};

(async () => {
  // Bảng Kiểm tra đầu vào: mọi ô trong dòng có tên cho trình đọc màn hình (tiêu đề cột chỉ là span)
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const row = html.match(/<div class="ins-row" data-index="\$\{index\}">([\s\S]*?)<\/div>`\)/);
  assert.ok(row, 'tìm được mẫu dòng bảng Kiểm tra đầu vào');
  const inputs = row[1].match(/<input[^>]*>/g);
  assert.equal(inputs.length, 5);
  for (const i of inputs) assert.match(i, /aria-label="[^"]+"/, `ô thiếu aria-label: ${i.slice(0, 40)}`);
  assert.match(html, /<input data-field="sku" data-sku-cell aria-label="SKU"/, 'ô SKU có aria-label');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.fulfill({ contentType: 'application/json', body: '[]' }));
      // Mỗi nhóm dựng mẫu trong đúng màn thật (màu chữ thừa hưởng từ màn), mở màn đó rồi mới đo
      const GROUPS = [
        ['cut-group-uid', '#cut-group-uid-screen', '<div id="t-adj" class="cut-adj-kpis"><button class="cut-adj-kpi" type="button" data-st="wrong" data-tone="bad" data-zero="true"><span>Sai số lượng</span><b>0</b></button><button class="cut-adj-kpi" type="button" data-st="" data-tone="" data-zero="true"><span>Tất cả</span><b>0</b></button></div>'
          + '<p id="t-st-wrong"><span class="cut-adj-st" data-st="wrong">Sai số lượng</span></p><p id="t-st-pending"><span class="cut-adj-st" data-st="pending">Chờ</span></p>'],
        ['cut-group-uid', '#cs-scan', '<div class="cs-filters"><button class="cs-filter" id="t-cs-filter">Tất cả <b>3</b></button></div><button class="cs-chip" data-role="cut" id="t-cs-chip">Cắt 2</button><table class="cs-table"><tr><td>A<small id="t-cs-small">ghi chú</small></td></tr></table>'],
        ['find-sku', '#find-sku-screen', '<p><span id="t-badge" class="fsk-badge">Combo</span></p>'
          + '<div class="cut-row" data-status="queued"><div class="cut-row__body"><strong>900000821</strong><span>Băng giả</span><small id="t-queued">1 tem · đang chờ</small></div></div>'
          + '<div class="cut-row" data-status="failed" data-gone="true"><div class="cut-row__body"><strong id="t-gone-sku">900000822</strong><span id="t-gone-name">Băng giả</span><small id="t-failed">2 m · 1 tem</small><i class="fsk-tag" data-tone="bad" id="t-gone-tag">SKU không còn</i></div></div>'],
        ['inspection', '#ins-screen', '<span class="ins-connector" id="t-ins-conn">Extension…</span>'],
        ['unit-converter', '#unit-converter-screen', '<details class="cut-card uc-lookup" open><summary><span>1</span><strong>Nhận diện hàng</strong><small id="t-uc-small">SKU 900000001</small></summary></details>'],
        ['uid-block', '#uid-block-screen', '<div class="ub-result" data-tone="blocked" id="t-ub"><p class="ub-result__via" id="t-ub-via">Đã scan lúc 10:05</p><dl class="ub-facts"><div><dt id="t-ub-dt">SKU</dt><dd>900000003</dd></div></dl><i class="ub-new" id="t-ub-new">Mới</i></div><div class="ub-result" data-tone="dup"><p class="ub-result__via" id="t-ub-via2">Đã scan lúc 10:05 20/10/2026</p><dl class="ub-facts"><div><dt id="t-ub-dt2">Tên hàng</dt><dd>Vải giả 3</dd></div></dl></div>'],
        ['storage-risk', '#storage-risk-screen', '<div class="as-tags" id="t-as"><button class="as-tag as-facet-btn" id="t-as-tag">Kho <b>2</b></button><button class="as-export" id="t-as-export">Xuất Excel</button><label class="as-search as-facet-search" id="t-as-search"><input type="search" aria-label="Tìm kho"></label><div class="as-facet-list"><label class="as-opt" id="t-as-opt"><input type="checkbox">MTG</label></div></div>'
          + '<p class="ss-badge" data-status="expired" id="t-expired">Hết hạn</p>'
          + ['#e1ede9', '#f0e8e7', '#f4f7f6', '#f0f5f4', '#ffffff'].map((bg, i) => `<div style="background:${bg}"><b id="t-ok-${i}" style="color:var(--wms-success)">Đã lưu</b><b id="t-bad-${i}" style="color:var(--wms-danger)">Lỗi</b><b id="t-warn-${i}" style="color:var(--wms-warning)">Chờ</b></div>`).join('')],
      ];
      const want = { '#t-adj [data-st="wrong"] span': 'ô lọc 0 dòng (Sai số lượng)', '#t-adj [data-st=""] span': 'ô lọc 0 dòng (Tất cả)', '#t-adj [data-st=""] b': 'số 0 của ô lọc',
        '#t-st-wrong .cut-adj-st': 'chip Sai số lượng', '#t-st-pending .cut-adj-st': 'chip Chờ', '#t-badge': 'nhãn Combo', '#t-queued': 'dòng chờ in: đang chờ',
        '#t-gone-sku': 'dòng SKU không còn: mã', '#t-gone-name': 'dòng SKU không còn: tên', '#t-failed': 'dòng SKU không còn: lỗi', '#t-gone-tag': 'nhãn SKU không còn',
        '#t-expired': 'Admin chip hết hạn', '#t-ins-conn': 'Kiểm tra đầu vào: trạng thái kết nối', '#t-uc-small': 'Nhận diện hàng: tóm tắt', '#t-ub-via': 'UID blocked: Đã scan lúc', '#t-ub-dt': 'UID blocked: nhãn ô dữ kiện', '#t-ub-via2': 'UID blocked (trùng): Đã scan lúc', '#t-ub-dt2': 'UID blocked (trùng): nhãn ô dữ kiện' };
      for (let i = 0; i < 5; i++) Object.assign(want, { [`#t-ok-${i}`]: `màu đạt (nền ${i})`, [`#t-bad-${i}`]: `màu lỗi (nền ${i})`, [`#t-warn-${i}`]: `màu cảnh báo (nền ${i})` });
      const bad = [], small = [];
      const px = sel => page.evaluate(sel => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize), sel);
      for (const [route, host, markup] of GROUPS) {
        if (!page.url().endsWith('#' + route)) { await page.goto(BASE + '#' + route); await page.waitForTimeout(600); }
        await page.locator(host).first().waitFor({ state: 'visible' });
        const ids = await page.evaluate(([host, markup]) => { const h = document.querySelector(host); const before = new Set([...document.querySelectorAll('[id^="t-"]')]); h.insertAdjacentHTML('beforeend', markup); return [...document.querySelectorAll('[id^="t-"]')].filter(e => !before.has(e)).map(e => '#' + e.id); }, [host, markup]);
        for (const [sel, name] of Object.entries(want)) {
          if (!ids.some(id => sel.startsWith(id))) continue;
          const r = await page.evaluate(ratio, sel); if (typeof r !== 'number' || r < 4.5) bad.push(`${name}: ${r}`);
        }
        if (ids.includes('#t-ub-new') && await px('#t-ub-new') < 12) bad.push('nhãn Mới < 12 px');
        if (ids.includes('#t-cs-small') && await px('#t-cs-small') < 12) bad.push('chữ phụ bảng Lấy mẫu theo PO < 12 px');
        if (mobile) for (const sel of ['#t-as-tag', '#t-as-export', '#t-as-search', '#t-as-opt', '#t-cs-filter', '#t-cs-chip'].filter(s => ids.includes(s))) {
          const h = await page.evaluate(sel => document.querySelector(sel).getBoundingClientRect().height, sel);
          if (h < 43.5) small.push(`${sel} ${Math.round(h)}`);
        }
      }
      assert.deepEqual(bad, [], `${width}px: chữ dưới 4,5:1 hoặc < 12 px`);
      assert.deepEqual(small, [], 'điện thoại: chip / bộ lọc / ô tìm / nút xuất ≥ 44 px');
      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      console.log(`PASS ${width}px: ${Object.keys(want).length} chữ trạng thái ≥ 4,5:1 trong đúng màn; nhãn Mới + chữ phụ ≥ 12 px${mobile ? '; chip/bộ lọc/ô tìm/xuất ≥ 44 px' : ''}`);
      await context.close();
    }
    console.log('PASS bảng Kiểm tra đầu vào: 6 ô có aria-label');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
