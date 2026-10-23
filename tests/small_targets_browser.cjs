// Đợt 5 (23/10/2026, dọn việc nhỏ theo skill UI UX Pro Max): nút 40–42 px lên 44; ô tick KHÔNG bọc <label> trên điện thoại có vùng
// chạm 44 (::after, đã đo không chồng phần tử khác ở bảng Cắt, hộp ADJ, dòng chờ in TÌM SKU); icon có nghĩa ≥ 3:1 (icon sắp xếp
// tiêu đề cột, tay nắm kéo dòng UID). Mẫu dựng trong đúng màn thật, dữ liệu giả. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

// Màu hiệu dụng (alpha + opacity) của phần tử (hoặc ::before) trên nền hiệu dụng → tỉ lệ tương phản
const contrastOf = ([sel, pseudo]) => {
  const el = document.querySelector(sel); if (!el) return `không có ${sel}`;
  const rgba = c => { const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const over = (t, b) => [0, 1, 2].map(i => t[i] * t[3] + b[i] * (1 - t[3])).concat(1);
  let bg = [255, 255, 255, 1]; const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n);
  for (const n of chain.reverse()) { const b = rgba(getComputedStyle(n).backgroundColor); if (b[3] > 0) bg = over(b, bg); }
  let op = 1; for (let n = el; n; n = n.parentElement) op *= Number(getComputedStyle(n).opacity);
  const s = getComputedStyle(el, pseudo || null);
  const f = rgba(pseudo ? s.backgroundColor : (s.stroke && s.stroke !== 'none' && !/url/.test(s.stroke) ? s.stroke : s.color)); f[3] *= op;
  const L = c => { const l = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2]); };
  const a = L(over(f, bg)), b = L(bg);
  return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.fulfill({ contentType: 'application/json', body: '[]' }));
      const open = async (route, host) => { await page.goto(BASE + '#' + route); await page.locator(host).first().waitFor({ state: 'visible' }); await page.waitForTimeout(500); };
      const add = (host, html) => page.evaluate(([host, html]) => document.querySelector(host).insertAdjacentHTML('afterbegin', html), [host, html]);
      const size = sel => page.evaluate(sel => { const r = document.querySelector(sel).getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }, sel);
      const bad = [];
      const need = async (sel, name, min) => { const [w, h] = await size(sel); if (w < min - 0.5 || h < min - 0.5) bad.push(`${name} ${w}×${h} < ${min}`); };

      await open('group-uid', '#uid-screen');
      await add('#uid-screen', '<div class="uid-panel__head"><button class="uid-sheet-open" id="t-sheet" type="button" aria-label="Mở danh sách"></button></div>'
        + '<div class="uid-row uid-row--rich has-drag" style="display:grid"><button class="uid-row__drag" id="t-drag" type="button" aria-label="Kéo"></button></div>');
      if (mobile) await need('#t-sheet', 'IN TEM GROUP UID: nút mở danh sách (chỉ hiện trên điện thoại)', 44);
      const drag = await page.evaluate(contrastOf, ['#t-drag', '::before']);
      if (typeof drag !== 'number' || drag < 3) bad.push(`tay nắm kéo dòng: icon ${drag}:1 < 3`);

      await open('group-uid-history', '#uidhist-screen');
      await add('#uidhist-screen', '<button class="pj-icon" id="t-pj" type="button" aria-label="Làm mới"></button>');
      await need('#t-pj', 'Lịch sử UID: nút icon', 44);
      await add('body', '<div class="sku-combo-dialog"><button class="sku-combo-close" id="t-combo-close" type="button" aria-label="Đóng"></button></div>');
      await need('#t-combo-close', 'Chọn SKU Combo: nút đóng', 44);

      await open('inspection', '#ins-screen');
      await add('#ins-screen', '<div class="ins-row" id="t-ins"><input data-field="sku" data-sku-cell aria-label="SKU" value="900100001"><input data-field="name" aria-label="Tên phụ liệu" value="Nhãn"></div>');
      for (const i of [1, 2]) await need(`#t-ins > input:nth-child(${i})`, `Kiểm tra đầu vào: ô ${i}`, 44);

      if (mobile) {
        // Ô tick không bọc label: vùng chạm 44 (điểm cách mép 9,5 px vẫn trúng ô); ô trong label không cần nới (không có ::after)
        await open('find-sku', '#find-sku-screen');
        await add('#find-sku-screen', '<div class="cut-row" id="t-row"><input type="checkbox" id="t-cb" aria-label="Chọn"><div class="cut-row__body"><strong>900000001</strong></div></div><label id="t-lab"><input type="checkbox" id="t-cb2"> Chọn</label>');
        const reach = await page.evaluate(() => {
          const b = document.getElementById('t-cb'), r = b.getBoundingClientRect(), cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
          const at = (x, y) => document.elementFromPoint(x, y) === b;
          return { w: r.width, out: [at(r.left - 9.5, cy), at(r.right + 9.5, cy), at(cx, r.top - 9.5), at(cx, r.bottom + 9.5)], labelled: getComputedStyle(document.getElementById('t-cb2'), '::after').content };
        });
        if (reach.out.some(x => !x)) bad.push(`ô tick không bọc label: vùng chạm chưa tới 44 (${JSON.stringify(reach.out)}, ô ${reach.w}px)`);
        if (reach.labelled !== 'none') bad.push('ô tick trong label không được nới thêm');
      } else {
        // Icon sắp xếp tiêu đề cột (chưa sắp): ≥ 3:1 trên nền đầu bảng
        await open('storage-risk', '#storage-risk-screen .as-th');
        const ico = await page.evaluate(contrastOf, ['#storage-risk-screen th:not([aria-sort="ascending"]):not([aria-sort="descending"]) .as-th .as-ico']);
        if (typeof ico !== 'number' || ico < 3) bad.push(`icon sắp xếp tiêu đề cột: ${ico}:1 < 3`);
      }
      assert.deepEqual(bad, [], `${width}px`);
      assert.deepEqual(errors, [], `${width}px: lỗi JavaScript`);
      console.log(`PASS ${width}px: nút ≥ 44 (mở danh sách UID, Lịch sử UID, đóng Combo, ô Kiểm tra đầu vào), tay nắm kéo ≥ 3:1${mobile ? ', ô tick không label vùng chạm 44' : ', icon sắp xếp ≥ 3:1'}`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
