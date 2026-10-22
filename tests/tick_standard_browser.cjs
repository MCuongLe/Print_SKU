// Ô tick chọn một kiểu cho toàn app (22/10/2026, khối <style id="tick-standard">): ô vuông tự vẽ 22 px (≤ 800 px: 24 px), bo 6,
// viền #6f8f83 trên nền trắng (tương phản ~3,5:1; #9fb6ad cũ chỉ ~2,2:1); đã tick = nền #005F41 + dấu tích trắng; một phần = nền #005F41 + gạch; tắt = mờ.
// Kiểm mọi ô tick có sẵn trong trang + ô tick đặt thử vào đúng các khung mà JS vẽ (danh sách chờ in, Phiếu IT, Lệnh in, bảng Cắt…).
// Chạy với python -m http.server 8000 (đổi bằng BASE). Không gọi mạng thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
// Khung chứa của các ô tick do JS vẽ (đặt thử một ô vào mỗi khung để đo đúng quy tắc của màn đó).
const HOSTS = [
  ['#uid-wms', '<label class="uid-wms__item"><input type="checkbox"></label>'],
  ['#uid-screen', '<label class="uid-select uid-auto__pick"><input type="checkbox"></label>'],
  ['#uid-screen', '<label class="uid-select"><input type="checkbox"></label>'],
  ['#cut-group-uid-screen', '<table class="cut-table"><tbody><tr><td><input type="checkbox"></td></tr></tbody></table>'],
  ['#cut-group-uid-screen', '<div class="cut-row"><input type="checkbox"></div>'],
  ['#find-sku-screen', '<div class="cut-row"><input type="checkbox"></div>'],
  ['#location-screen', '<div class="loc-item"><input type="checkbox" data-act="pick"></div>'],
  ['body', '<div class="skq-item"><label class="skq-check"><input type="checkbox"></label></div><label class="skq-all"><input type="checkbox"></label>'],
  ['body', '<div id="sku-it"><label class="skit__pick"><input type="checkbox"></label></div>'],
  ['body', '<table class="pj-d-table"><tr><td class="c"><input type="checkbox"></td></tr></table>'],
  ['body', '<div class="as-facet-list"><label class="as-opt"><input type="checkbox"></label></div>'],
  ['body', '<div class="pa-rows"><div class="pa-row"><input type="checkbox" data-pa-on></div></div>'],
];

const audit = mobile => {
  const want = mobile ? '24px' : '22px', bad = [];
  const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
  for (const box of boxes) {
    const name = box.id || box.closest('[class]')?.className?.toString().split(' ')[0] || 'input';
    const s = getComputedStyle(box);
    if (s.appearance !== 'none') bad.push(`${name}: appearance ${s.appearance}`);
    if (s.width !== want || s.height !== want) bad.push(`${name}: cỡ ${s.width}×${s.height}, cần ${want}`);
    if (s.borderTopLeftRadius !== '6px') bad.push(`${name}: bo ${s.borderTopLeftRadius}`);
    if (s.borderTopWidth !== '2px' || s.borderTopColor !== 'rgb(111, 143, 131)') bad.push(`${name}: viền ${s.borderTopWidth} ${s.borderTopColor}`);
    if (s.backgroundColor !== 'rgb(255, 255, 255)') bad.push(`${name}: nền chưa tick ${s.backgroundColor}`);
    const was = box.checked; box.checked = true;
    const c = getComputedStyle(box);
    if (c.backgroundColor !== 'rgb(0, 95, 65)' || c.borderTopColor !== 'rgb(0, 95, 65)') bad.push(`${name}: đã tick nền ${c.backgroundColor} viền ${c.borderTopColor}`);
    if (!/^url\(/.test(c.backgroundImage)) bad.push(`${name}: đã tick thiếu dấu tích`);
    box.checked = was;
  }
  return { count: boxes.length, bad: [...new Set(bad)] };
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const mobile = width < 800;
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route('**/*', route => route.request().url().startsWith(BASE) ? route.continue() : route.fulfill({ contentType: 'application/json', body: '[]' }));
      await page.goto(BASE + '#home');
      await page.waitForTimeout(800);
      await page.evaluate(hosts => hosts.forEach(([sel, html]) => { const host = document.querySelector(sel); if (host) host.insertAdjacentHTML('beforeend', html); }), HOSTS);
      const { count, bad } = await page.evaluate(audit, mobile);
      assert.ok(count >= 20, `phải đo được nhiều ô tick (có ${count})`);
      assert.deepEqual(bad, [], `${width}px: ô tick chưa cùng một kiểu`);
      // Một phần (indeterminate) và tắt
      const extra = await page.evaluate(() => {
        const a = document.createElement('input'); a.type = 'checkbox'; a.indeterminate = true; document.body.append(a);
        const d = document.createElement('input'); d.type = 'checkbox'; d.disabled = true; document.body.append(d);
        const sa = getComputedStyle(a), sd = getComputedStyle(d);
        return { indBg: sa.backgroundColor, indImg: /^url\(/.test(sa.backgroundImage), disabledOpacity: sd.opacity };
      });
      assert.equal(extra.indBg, 'rgb(0, 95, 65)', 'một phần: nền xanh');
      assert.equal(extra.indImg, true, 'một phần: có gạch');
      assert.equal(extra.disabledOpacity, '0.4', 'tắt: mờ');
      console.log(`PASS ${width}px: ${count} ô tick cùng một kiểu (${mobile ? 24 : 22} px, bo 6, tick nền #005F41)`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
