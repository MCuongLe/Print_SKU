// Màn #admin/sku-sync: icon Lucide thay ký tự, không có câu hướng dẫn dài, tiêu đề bảng đổi theo nhóm, ô cảnh báo, preview hết hạn.
// Run against python -m http.server 8000. Supabase, Edge Function và Extension được giả lập; không ghi dữ liệu.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const MIN = 60000;
const ago = minutes => new Date(Date.now() - minutes * MIN).toISOString();

const CHANGES = {
  skus: {
    added: [
      { sku: '900000001', after: { product_name: 'SKU thử', category_name: 'Thời Trang (Phụ Liệu)' } },
      { sku: '900000002', after: { product_name: 'Chỉ Irisa/F6-8012/100% Polyester/Navy', category_name: 'Thời Trang (Phụ Liệu)' } },
    ],
    updated: [{ sku: '422292491', fields: { product_name: { before: 'Thẻ bài/S/pcs', after: 'Thẻ bài/S/cái' }, status: { before: '1', after: '0' } } }],
  },
  combos: {
    added: [], updated: [],
    orphaned: [
      { comboSku: 'C0', normalSku: 'OLD', quantity: 2, comboName: 'Combo C0', reason: 'component_removed' },
      { comboSku: 'GONE', normalSku: 'N5', quantity: 1, comboName: '', reason: 'combo_missing' },
    ],
    excluded: [{ comboSku: 'C1', normalSku: 'N1', quantity: 1000, missing: 'combo' }, { comboSku: 'C2', normalSku: 'N2', quantity: 6, missing: 'normal' }],
  },
  sourceIssues: [
    { type: 'partial_combo_description', combo_sku: 'C3', combo_name: 'Combo ba', description: 'Combo C3=A1 + B 1', reason: 'Bỏ qua thành phần: B 1' },
    { type: 'unparsed_combo_description', combo_sku: 'C4', description: 'Ghi chú <b>tự do</b>', reason: 'Mô tả không đúng dạng Combo A=B+C' },
  ],
};
const SOURCE_COUNTS = { normalRows: 3, comboRows: 1000, selectedComboLinks: 10, excludedBreakdown: { bothMissing: 990, oneMissing: 2, outOfCategory: 0 }, sourceIssues: 2 };
const CHANGE_COUNTS = { skuAdded: 2, skuUpdated: 1, comboAdded: 0, comboUpdated: 0, comboOrphaned: 2 };
const RUNS = [
  { id: 'run-fresh', status: 'previewed', created_at: ago(5), change_counts: CHANGE_COUNTS },
  { id: 'run-old', status: 'previewed', created_at: ago(45), change_counts: CHANGE_COUNTS },
  { id: 'run-done', status: 'completed', created_at: ago(120), completed_at: ago(119), change_counts: {} },
  { id: 'run-auto', status: 'previewed', created_at: ago(200), source: 'auto', device: 'may-test', autoHold: 'Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000', change_counts: CHANGE_COUNTS },
];

// Mốc lượt Toàn bộ gần nhất mà history trả về (null = chưa chạy); đổi để đo ô "Đối chiếu toàn bộ" quá hạn.
let histFullAt = null;
// Giữ phản hồi preview của Edge để chặn được pha "đang đọc" (nút đổi nhãn, icon vòng xoay); đặt lại null để thả.
let hold = null;
// Giữ phản hồi apply (ghi Supabase) để chặn được pha "đang cập nhật": nút Cập nhật mang data-busy + vạch load dưới nút; đặt lại null để thả.
let holdApply = null;

const mockRoutes = async page => { let autoEnabled = true; return page.route('**/*', async route => {
  const url = route.request().url();
  const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith('/auth/v1/user')) return json({ id: '00000000-0000-0000-0000-000000000001' });
  if (url.includes('/rest/v1/user_roles')) return json([{ username: 'Test Admin', role: 'admin' }]);
  if (url.includes('/functions/v1/sku-sync')) {
    const { action, runId, mode } = JSON.parse(route.request().postData() || '{}');
    const ok = data => json({ ok: true, data });
    if (action === 'auto-config') {
      const set = JSON.parse(route.request().postData() || '{}').set;
      if (set && typeof set.enabled === 'boolean') autoEnabled = set.enabled;
      return ok({ enabled: autoEnabled, intervalMinutes: 30, fullWindow: { start: '00:00', end: '05:00' }, thresholds: {}, updatedAt: ago(1) });
    }
    if (action === 'history') return ok({ runs: RUNS, lastSuccessAt: ago(119), lastSnapshotAt: ago(120), lastFullAt: histFullAt });
    if (action === 'preview' && hold) await hold;
    if (action === 'preview' && mode === 'full') return ok({ runId: 'run-full', status: 'previewed', mode: 'full', sourceCounts: { ...SOURCE_COUNTS, normalRows: 97 }, changeCounts: { ...CHANGE_COUNTS, skuMissing: 1, skuSkippedInactive: 2629 }, changes: { ...CHANGES, skus: { ...CHANGES.skus, missing: [{ sku: '900000009', product_name: 'SKU cũ', category_name: 'Thời Trang', status: '0' }] } }, verification: { previousFullCount: 100, baselineCount: 100, fullDropPercent: 3, skuMissing: 1 } });
    if (action === 'preview') return ok({ runId: 'run-fresh', status: 'previewed', sourceCounts: SOURCE_COUNTS, changeCounts: CHANGE_COUNTS, changes: CHANGES });
    // sku_missing_archive_v1 (17/10/2026): lượt toàn bộ áp dụng trả số SKU rời nhóm đã lưu trữ / giữ lại.
    if (action === 'apply' && holdApply) await holdApply;
    if (action === 'apply') return ok({ status: 'completed', changeCounts: { ...CHANGE_COUNTS, skuArchived: 1, skuArchiveKept: 2 }, verification: { skuVerified: 3, comboVerified: 0, skuCount: 100 } });
    if (action === 'detail') {
      const run = RUNS.find(item => item.id === runId);
      // Lượt tự động bị giữ lại (held): detail trả status held + autoHold.
      const held = runId === 'run-auto' ? { status: 'held', autoHold: 'Giữ lại: 21 SKU rời nhóm đồng bộ (ngưỡng 20)', completed_at: ago(199) } : {};
      return ok({ ...run, cutoff: 'x', source_counts: SOURCE_COUNTS, change_counts: run.change_counts, changes: CHANGES, verification: {}, error_message: null, ...held });
    }
    return json({ ok: false, error: { message: 'chưa giả lập ' + action } }, 400);
  }
  if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
}); };

// Extension giả: trả lời PING và GET_SKU_SYNC_DATA qua postMessage như app-bridge.js.
const fakeExtension = () => addEventListener('message', event => {
  const request = event.data;
  if (!request || request.source !== 'PRINT_SKU_APP') return;
  const data = request.type === 'PING'
    ? { version: '0.3.3' }
    : { generatedAt: new Date().toISOString(), cutoff: 'x', categories: [], normalRows: [], comboRows: [], sourceCounts: {} };
  postMessage({ source: 'HASAKI_INSIDE_CONNECTOR', requestId: request.requestId, ok: true, data }, location.origin);
});

// Popup chi tiết (#ss-dialog): bấm ô số liệu để mở, Esc để đóng; xem trước xong không tự mở.
const dlg = page => page.locator('#ss-dialog');
const openKind = async (page, kind) => { await page.locator(`[data-change-kind="${kind}"]`).click(); await dlg(page).waitFor({ state: 'visible' }); };
const closeDlg = async page => { await page.keyboard.press('Escape'); await dlg(page).waitFor({ state: 'hidden' }); };
const headers = page => page.locator('#ss-change-head th').allInnerTexts();
// Nhóm cảnh báo phải hiện đủ cả 4 cột kể cả ở điện thoại (quy tắc ẩn cột 3 chỉ dành cho bảng thay đổi thường)
const allVisible = async page => { for (const th of await page.locator('#ss-change-head th').all()) assert.equal(await th.isVisible(), true); };
const cells = async page => (await page.locator('#ss-change-body tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent.trim()))));

// Khuôn hero (17/10/2026, khối #hero-standard): thanh lệnh gọn một hàng, h2 vẫn trong DOM nhưng ẩn kiểu sr-only (rộng ≤ 1 px),
// nút đọc nguồn một kiểu .src-read (icon mask ở ::before), nhóm ghi đẩy sang phải. Trả về danh sách điểm lệch (rỗng = đạt).
const heroAudit = (page, screenSel, specs) => page.evaluate(({ screenSel, specs }) => {
  const bad = [], hero = document.querySelector(`${screenSel} .ss-hero`), box = hero.getBoundingClientRect();
  const h2 = hero.querySelector('h2'), h2w = h2.getBoundingClientRect().width;
  if (h2w > 1) bad.push(`h2 hero rộng ${Math.round(h2w)}px, cần ≤ 1px (ẩn kiểu sr-only)`);
  if (!h2.textContent.trim()) bad.push('h2 hero không còn trong DOM');
  const buttons = [...hero.querySelectorAll('button')], tops = buttons.map(b => Math.round(b.getBoundingClientRect().top));
  if (new Set(tops).size !== 1) bad.push(`nút hero không cùng một hàng (top ${tops.join(', ')})`);
  if (box.height > 96) bad.push(`hero cao ${Math.round(box.height)}px, cần thanh lệnh gọn ≤ 96px`);
  if (buttons[0].getBoundingClientRect().left - box.left > 40) bad.push('nút đọc đầu tiên không nằm sát trái hero');
  if (box.right - buttons.at(-1).getBoundingClientRect().right > 40) bad.push('nhóm ghi không được đẩy sang phải hero');
  for (const spec of specs) {
    const b = document.getElementById(spec.id), before = getComputedStyle(b, '::before'), mask = before.maskImage || before.webkitMaskImage;
    for (const cls of spec.classes || []) if (!b.classList.contains(cls)) bad.push(`#${spec.id} thiếu lớp ${cls}`);
    if (b.innerText.trim() !== spec.text) bad.push(`#${spec.id} chữ "${b.innerText.trim()}", cần "${spec.text}"`);
    if (spec.title && b.title !== spec.title) bad.push(`#${spec.id} title "${b.title}", cần "${spec.title}"`);
    if (spec.aria && b.getAttribute('aria-label') !== spec.aria) bad.push(`#${spec.id} aria-label "${b.getAttribute('aria-label')}", cần "${spec.aria}"`);
    if (!mask || mask === 'none' || before.content === 'none') bad.push(`#${spec.id}::before không có icon mask`);
  }
  return bad;
}, { screenSel, specs });
const HERO_SPECS = [
  { id: 'sku-sync-preview', classes: ['src-read'], text: 'Đọc Inside', title: 'Đọc thay đổi từ Inside' },
  { id: 'sku-sync-full', classes: ['src-read', 'src-read--all'], text: 'Toàn bộ', title: 'Đối chiếu toàn bộ dữ liệu Inside' },
  { id: 'ss-apply', classes: ['ss-primary'], text: 'Cập nhật' },
];

// Dưới hero (18/10/2026, khối #hero-standard): dải mốc giờ + dải Tự động là bề mặt phẳng lùi sau hero (không bóng, nền không phải trắng thuần, ô cũ vẫn vàng);
// ô số liệu phân tầng: số 0 phẳng + chữ xám đủ tương phản (không dùng opacity), thay đổi > 0 viền/nền xanh nhạt + số đậm #005F41, cảnh báo giữ vàng, ô nguồn trung tính.
// Trả về danh sách điểm lệch (rỗng = đạt). `needAlert`: trạng thái đang xem phải có ít nhất một ô cảnh báo.
const belowHeroAudit = (page, screenSel, stripIds, needAlert) => page.evaluate(async ({ screenSel, stripIds, needAlert }) => {
  await Promise.all(document.getAnimations().filter(a => a instanceof CSSTransition).map(a => a.finished.catch(() => {}))); // chờ chuyển màu .15s xong mới đo
  const bad = [], rgb = c => c.match(/[\d.]+/g).map(Number), same = (a, b) => a === b;
  const lum = ([r, g, b]) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const effBg = el => { for (let n = el; n; n = n.parentElement) { const c = rgb(getComputedStyle(n).backgroundColor); if ((c.length < 4 ? 1 : c[3]) > 0.99) return c; } return [255, 255, 255]; };
  const contrast = (fg, bg) => { const a = lum(rgb(fg)), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  for (const id of stripIds) {
    const strip = document.getElementById(id), s = getComputedStyle(strip);
    if (s.boxShadow !== 'none') bad.push(`#${id} còn box-shadow: ${s.boxShadow}`);
    if (s.backgroundColor === 'rgb(255, 255, 255)') bad.push(`#${id} nền trắng thuần, cần nền nhẹ lùi sau hero`);
    for (const cell of strip.querySelectorAll('[data-stale="true"]')) if (getComputedStyle(cell).backgroundColor !== 'rgb(255, 250, 235)') bad.push(`#${id} ô cũ mất nền vàng: ${getComputedStyle(cell).backgroundColor}`);
  }
  const sel = x => [...document.querySelectorAll(`${screenSel} ${x}`)];
  const zero = sel('button.ss-metric[data-zero="true"]'), change = sel('button.ss-metric[data-zero="false"]:not([data-alert="true"])'), alert = sel('button.ss-metric[data-alert="true"]'), source = sel('div.ss-metric');
  if (!zero.length) bad.push('không có ô số 0 để kiểm');
  if (!change.length) bad.push('không có ô thay đổi > 0 để kiểm');
  if (needAlert && !alert.length) bad.push('không có ô cảnh báo để kiểm');
  if (!source.length) bad.push('không có ô nguồn để kiểm');
  const name = el => `"${el.querySelector('span').textContent.trim()}"`;
  for (const el of zero) {
    const s = getComputedStyle(el), num = getComputedStyle(el.querySelector('strong')), label = getComputedStyle(el.querySelector('span')), bg = effBg(el);
    if (s.boxShadow !== 'none') bad.push(`ô 0 ${name(el)} còn box-shadow`);
    if (s.opacity !== '1' || num.opacity !== '1') bad.push(`ô 0 ${name(el)} dùng opacity ${s.opacity}/${num.opacity} (phải dùng màu xám đủ tương phản)`);
    if (contrast(num.color, bg) < 4.5) bad.push(`ô 0 ${name(el)} số ${num.color} trên nền ${bg} tương phản ${contrast(num.color, bg).toFixed(2)} < 4.5`);
    if (contrast(label.color, bg) < 4.5) bad.push(`ô 0 ${name(el)} nhãn ${label.color} trên nền ${bg} tương phản ${contrast(label.color, bg).toFixed(2)} < 4.5`);
  }
  const z = zero[0] && getComputedStyle(zero[0]), zNum = zero[0] && getComputedStyle(zero[0].querySelector('strong'));
  for (const el of change) {
    const s = getComputedStyle(el), num = getComputedStyle(el.querySelector('strong'));
    if (num.color !== 'rgb(0, 95, 65)') bad.push(`ô thay đổi ${name(el)} số ${num.color}, cần #005F41`);
    if (Number(num.fontWeight) < 600) bad.push(`ô thay đổi ${name(el)} số đậm ${num.fontWeight}, cần ≥ 600`);
    if (z && same(s.borderTopColor, z.borderTopColor)) bad.push(`ô thay đổi ${name(el)} viền ${s.borderTopColor} trùng viền ô số 0`);
    if (z && same(s.backgroundColor, z.backgroundColor)) bad.push(`ô thay đổi ${name(el)} nền ${s.backgroundColor} trùng nền ô số 0`);
    if (zNum && same(num.color, zNum.color)) bad.push(`ô thay đổi ${name(el)} số cùng màu ô số 0 (${num.color})`);
    if (contrast(num.color, effBg(el)) < 4.5) bad.push(`ô thay đổi ${name(el)} số tương phản ${contrast(num.color, effBg(el)).toFixed(2)} < 4.5`);
    if (contrast(getComputedStyle(el.querySelector('span')).color, effBg(el)) < 4.5) bad.push(`ô thay đổi ${name(el)} nhãn tương phản thấp`);
  }
  for (const el of alert) if (getComputedStyle(el).backgroundColor !== 'rgb(255, 250, 235)') bad.push(`ô cảnh báo ${name(el)} mất nền vàng: ${getComputedStyle(el).backgroundColor}`);
  for (const el of source) {
    const s = getComputedStyle(el), num = getComputedStyle(el.querySelector('strong'));
    if (s.boxShadow !== 'none') bad.push(`ô nguồn ${name(el)} còn box-shadow`);
    if (s.backgroundColor !== 'rgb(255, 255, 255)') bad.push(`ô nguồn ${name(el)} nền ${s.backgroundColor}, cần trung tính (trắng)`);
    if (num.color === 'rgb(0, 95, 65)') bad.push(`ô nguồn ${name(el)} số xanh thương hiệu, cần trung tính`);
  }
  return bad;
}, { screenSel, stripIds, needAlert });

// Lưới không rơi ô lẻ: mỗi nhóm ô (.as-cards) và mỗi dải (.as-strip) không có hàng chỉ một ô khi nhóm có từ 2 ô; nhóm SKU 4 ô nằm một hàng khi `oneRow`.
const layoutAudit = (page, screenSel, stripIds, oneRow) => page.evaluate(({ screenSel, stripIds, oneRow }) => {
  const bad = [], rows = nodes => { const map = new Map(); for (const n of nodes) { const k = Math.round(n.getBoundingClientRect().top); map.set(k, (map.get(k) || 0) + 1); } return map; };
  const lone = (label, nodes) => { if (nodes.length > 1) for (const [top, count] of rows(nodes)) if (count === 1) bad.push(`${label}: ô lẻ một mình một hàng (top ${top})`); };
  const groups = [...document.querySelectorAll(`${screenSel} .as-cards`)];
  groups.forEach((g, i) => lone(`nhóm ô ${i + 1}`, [...g.children])); // mọi khổ ≥ 1024: nhóm 4 ô không còn 3 + 1 (≥ 1200 px xếp 2 × 2)
  if (oneRow && rows([...groups[0].children]).size !== 1) bad.push(`nhóm SKU ${groups[0].children.length} ô không nằm một hàng (${[...rows([...groups[0].children])].map(([top, n]) => `${n} ô ở top ${top}`).join('; ')})`);
  for (const id of stripIds) {
    const strip = document.getElementById(id), box = strip.getBoundingClientRect();
    lone(`#${id}`, [...strip.children]);
    for (const c of strip.children) if (c.getBoundingClientRect().right > box.right + 1) bad.push(`#${id}: ô tràn khỏi dải`);
    const rowRight = new Map(); for (const c of strip.children) { const r = c.getBoundingClientRect(), k = Math.round(r.top); rowRight.set(k, Math.max(rowRight.get(k) || 0, r.right)); }
    for (const [top, right] of rowRight) if (box.right - right > 3) bad.push(`#${id}: hàng top ${top} chưa phủ hết dải, còn trống ${Math.round(box.right - right)}px`);
  }
  return bad;
}, { screenSel, stripIds, oneRow });

// Ô Tự động nằm trong dải mốc giờ (18/10/2026): ô con của dải, nút icon 36×36 nằm trong ô, chữ nhãn/giờ/ghi chú không bị nút che hay cắt, ô không tràn.
const autoCellAudit = (page, stripId, cellId) => page.evaluate(({ stripId, cellId }) => {
  const bad = [], strip = document.getElementById(stripId), cell = document.getElementById(cellId), btn = cell && cell.querySelector('button');
  if (!cell || cell.parentElement !== strip) return [`#${cellId} không phải ô con của #${stripId}`];
  const c = cell.getBoundingClientRect(), b = btn.getBoundingClientRect();
  if (Math.abs(b.width - 36) > 0.5 || Math.abs(b.height - 36) > 0.5) bad.push(`nút ${Math.round(b.width)}×${Math.round(b.height)}, cần 36×36`);
  if (b.left < c.left || b.right > c.right + 0.5 || b.top < c.top || b.bottom > c.bottom + 0.5) bad.push('nút nằm ngoài ô Tự động');
  for (const el of cell.querySelectorAll('span, strong, em')) {
    if (!el.textContent.trim()) continue;
    const range = document.createRange(); range.selectNodeContents(el); const t = range.getBoundingClientRect();
    if (t.right > c.right + 0.5) bad.push(`chữ "${el.textContent.trim()}" tràn khỏi ô`);
    if (!btn.hidden && t.right > b.left - 2 && t.left < b.right && t.bottom > b.top && t.top < b.bottom) bad.push(`nút che chữ "${el.textContent.trim()}" (chữ tới ${Math.round(t.right)}, nút từ ${Math.round(b.left)})`);
    if (el.tagName !== 'SPAN' && el.scrollWidth > el.clientWidth + 1) bad.push(`"${el.textContent.trim()}" bị cắt (${el.scrollWidth} > ${el.clientWidth})`);
  }
  return bad;
}, { stripId, cellId });

// Dòng load dưới nút đang chạy (18/10/2026, khối #hero-standard): vạch 3 px bo tròn ở ::after của nút, nằm dưới mép nút, không bị cắt hay chồng (điểm giữa vạch trỏ về chính nút);
// không có tiến độ thật (--p) → đoạn 38 % trượt qua lại; có --p (0–1) → tô theo % bề rộng nút. Trả về thông số đo được.
const barInfo = (page, id) => page.evaluate(id => {
  const b = document.getElementById(id), s = getComputedStyle(b, '::after'), r = b.getBoundingClientRect();
  const h = parseFloat(s.height) || 0, w = parseFloat(s.width) || 0, top = r.top + b.clientTop + (parseFloat(s.top) || 0), left = r.left + b.clientLeft + (parseFloat(s.left) || 0);
  const token = s.backgroundSize.split(',')[0].trim().split(' ')[0], fillOfTrack = token.endsWith('%') ? parseFloat(token) / 100 : w ? parseFloat(token) / w : NaN;
  const hit = h ? document.elementFromPoint(left + w / 2, top + h / 2) : null;
  return { content: s.content, position: s.position, height: h, track: w, btn: r.width, below: top >= r.bottom - 0.5, hit: hit === b, fillOfTrack, fill: fillOfTrack * w, animated: s.animationName !== 'none', p: b.style.getPropertyValue('--p') };
}, id);
const expectBar = (info, tag, ratio) => {
  assert.equal(info.content, '""', `${tag}: không có vạch load dưới nút (::after content ${info.content})`);
  assert.equal(info.position, 'absolute', `${tag}: vạch phải nằm tuyệt đối dưới nút`);
  assert.equal(info.height, 3, `${tag}: vạch cao ${info.height}px, cần 3px`);
  assert.ok(info.below, `${tag}: vạch phải nằm dưới mép nút`);
  assert.ok(info.hit, `${tag}: vạch bị cắt hoặc bị phần tử khác chồng lên`);
  assert.ok(Math.abs(info.track / info.btn - 1) <= 0.03, `${tag}: nền vạch rộng ${info.track.toFixed(1)}px, cần bằng bề rộng nút ${info.btn.toFixed(1)}px`);
  if (ratio === undefined) { assert.ok(info.animated, `${tag}: chưa có tiến độ thật thì đoạn vạch phải trượt qua lại`); assert.ok(Math.abs(info.fillOfTrack - 0.38) < 0.01, `${tag}: đoạn trượt chiếm ${(info.fillOfTrack * 100).toFixed(1)}%, cần 38%`); }
  else assert.ok(Math.abs(info.fill / info.btn - ratio) <= 0.05, `${tag}: vạch ${(info.fill / info.btn * 100).toFixed(1)}% bề rộng nút, cần ≈ ${ratio * 100}% ± 5%`);
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const width of [1280, 375]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await mockRoutes(page);
      await page.goto(BASE + '#admin/sku-sync');
      await page.locator('#sku-sync-screen').waitFor({ state: 'visible' });
      await page.locator('#ss-history tr[data-run]').first().waitFor({ state: 'attached' });
      const calls = []; page.on('request', request => { if (request.url().includes('/functions/v1/sku-sync')) { const body = JSON.parse(request.postData() || '{}'); calls.push(body.action + (body.mode === 'full' ? ':full' : '')); } });

      // Menu và nút Về trang chủ/Đăng xuất dùng icon SVG, không dùng ký tự
      const navButtons = page.locator('#sku-sync-screen .ss-nav button');
      assert.equal(await navButtons.count(), 4); // Lệnh in, Cấu hình, Đồng bộ SKU, Đồng bộ Group UID (08/10/2026: Tổng quan + Đợt đã gửi gộp thành Lệnh in; 12/10/2026: Kiểm kê SKU ra trang chủ)
      for (let index = 0; index < 4; index += 1) assert.equal(await navButtons.nth(index).locator('svg').count(), 1, `mục menu ${index + 1} có icon`);
      assert.equal(await page.locator('#sku-sync-screen .ss-side-foot button svg').count(), 2);
      const chrome = await page.locator('#sku-sync-screen .ss-side, #sku-sync-screen .ss-top').allInnerTexts();
      for (const glyph of ['▦', '☷', '⚙', '⇄', '←']) assert.equal(chrome.join('').includes(glyph), false, `không còn ký tự ${glyph}`);

      // Không có câu hướng dẫn/giải thích dài
      const screenText = await page.locator('#sku-sync-screen').innerText();
      for (const phrase of ['Extension đọc phiên Inside', 'Edge Function đối chiếu', 'Không tự xóa SKU', 'Chọn một lượt để xem', 'Bấm “Kiểm tra']) assert.equal(screenText.includes(phrase), false, `đã bỏ câu "${phrase}"`);
      assert.equal(await page.locator('.ss-hero p, .ss-note').count(), 0);
      assert.equal((await page.locator('#ss-change-note').innerText()).trim(), '');
      if (width === 1280) assert.deepEqual(await heroAudit(page, '#sku-sync-screen', HERO_SPECS), [], 'khuôn hero (thanh lệnh gọn một hàng, nút .src-read)');

      // Đồng bộ tự động (17/10/2026): dải trạng thái đọc auto-config, nút Tạm dừng gửi set.enabled=false rồi đổi chữ; lịch sử có chip Tự động · máy và Chờ Admin
      const autoBodies = []; page.on('request', request => { if (request.url().includes('/functions/v1/sku-sync')) { const body = JSON.parse(request.postData() || '{}'); if (body.action === 'auto-config') autoBodies.push(body); } });
      // 18/10/2026: ô Tự động gộp vào dải mốc giờ (không còn khối #ss-auto-strip riêng): strong = giờ lượt tự động gần nhất, em = máy · x giờ trước,
      // nút Tạm dừng / Tiếp tục là nút chỉ icon 36×36 có aria-label + title; tạm dừng → ô vàng.
      assert.equal(await page.locator('#ss-auto-strip').count(), 0, 'không còn khối Tự động riêng dưới dải mốc giờ');
      const cell = page.locator('#ss-strip > #ss-strip-auto');
      await cell.waitFor({ state: 'visible' });
      assert.deepEqual(await page.locator('#ss-strip').evaluate(strip => [...strip.children].map(c => c.id || c.className)), ['ss-strip-done', '', 'ss-strip-full', 'ss-strip-auto', 'as-histcell'], 'dải 5 ô, ô Tự động đứng ngay trước ô Lịch sử');
      assert.equal((await cell.locator(':scope > span').innerText()).trim(), 'Tự động');
      assert.match(await page.locator('#ss-auto-text').innerText(), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
      assert.match(await page.locator('#ss-auto-note').innerText(), /^may-test · \d+ (phút|giờ|ngày) trước$/);
      assert.equal(await cell.getAttribute('data-stale'), 'false');
      const toggle = page.locator('#ss-auto-toggle');
      assert.equal((await toggle.innerText()).trim(), '', 'nút chỉ icon, không chữ');
      assert.equal(await toggle.getAttribute('aria-label'), 'Tạm dừng tự động');
      assert.equal(await toggle.getAttribute('title'), 'Tạm dừng tự động');
      assert.equal(await toggle.locator('svg').count(), 1, 'nút tự động có icon');
      assert.equal(await cell.locator('svg').count(), 2, 'ô tự động có icon đầu ô và icon nút');
      assert.deepEqual(await autoCellAudit(page, 'ss-strip', 'ss-strip-auto'), [], 'ô Tự động: nút 36×36 trong ô, không che chữ');
      await toggle.click();
      await page.waitForFunction(() => document.getElementById('ss-strip-auto').dataset.stale === 'true');
      assert.deepEqual(autoBodies.at(-1), { action: 'auto-config', set: { enabled: false } });
      assert.equal((await page.locator('#ss-auto-note').innerText()).trim(), 'Admin đã tạm dừng');
      assert.equal(await toggle.getAttribute('aria-label'), 'Tiếp tục tự động');
      assert.equal(await toggle.getAttribute('title'), 'Tiếp tục tự động');
      assert.equal(await cell.evaluate(c => getComputedStyle(c).backgroundColor), 'rgb(255, 250, 235)', 'tạm dừng: ô tự động vàng');
      assert.equal(await page.locator('#ss-strip').getAttribute('data-stale'), null, 'chỉ ô Tự động vàng, không phải cả dải');
      assert.deepEqual(await autoCellAudit(page, 'ss-strip', 'ss-strip-auto'), [], 'ô Tự động (đã tạm dừng): nút trong ô, không che chữ');
      await toggle.click();
      await page.waitForFunction(() => document.getElementById('ss-strip-auto').dataset.stale === 'false');
      assert.deepEqual(autoBodies.at(-1), { action: 'auto-config', set: { enabled: true } });
      assert.equal(await toggle.getAttribute('aria-label'), 'Tạm dừng tự động');

      // Lịch sử gọn: một ô trong dải (kết quả lượt gần nhất + số lượt), bảng chỉ mở khi bấm; không có bảng chi tiết nằm sẵn trong trang
      assert.equal(await page.locator('#ss-hist-dialog').evaluate(node => node.open), false);
      assert.equal(await page.locator('#ss-history').isVisible(), false);
      assert.equal(await dlg(page).isVisible(), false);
      assert.equal((await page.locator('#ss-hist-last').innerText()).trim(), 'Chờ cập nhật');
      assert.match(await page.locator('#ss-hist-count').innerText(), /4 lượt$/);
      await page.locator('#ss-history-btn').click();
      await page.locator('#ss-hist-dialog').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#ss-hist-note').innerText()).trim(), '4 lượt gần nhất');
      // Lịch sử: preview quá 30 phút hiện "Hết hạn" và khóa nút Cập nhật; bảng có cột thời lượng và chip kết quả
      const badges = await page.locator('#ss-history .ss-badge').allInnerTexts();
      assert.deepEqual(badges, ['Chờ cập nhật', 'Hết hạn', 'Hoàn tất', 'Hết hạn']);
      assert.deepEqual((await page.locator('#ss-history tr[data-run="run-auto"] .as-auto-chips .as-chip').allInnerTexts()).map(t => t.trim()), ['Tự động · may-test', 'Chờ Admin']);
      assert.equal(await page.locator('#ss-history tr[data-run="run-auto"] .as-chip[data-tone="warn"]').getAttribute('title'), 'Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000');
      assert.equal(await page.locator('#ss-history tr[data-run="run-done"] .as-auto-chips').count(), 0, 'lượt bấm tay không có chip tự động');
      assert.deepEqual(await page.locator('#ss-hist-dialog thead th').allInnerTexts(), ['Thời gian', 'Trạng thái', 'SKU', 'Normal–Combo', 'Thời lượng']);
      assert.match(await page.locator('#ss-history tr[data-run="run-done"]').innerText(), /1 phút/);
      await page.locator('#ss-history tr[data-run="run-old"]').click();
      await page.locator('#ss-hist-dialog').waitFor({ state: 'hidden' }); // chọn một lượt thì popup lịch sử tự đóng
      await page.waitForFunction(() => /Lượt đang ở trạng thái/.test(document.getElementById('sku-sync-status').textContent) && !document.getElementById('sku-sync-preview').disabled);
      assert.equal(await dlg(page).isVisible(), false, 'mở lượt cũ không tự bật popup chi tiết');
      assert.equal(await page.locator('#ss-apply').isDisabled(), true);

      // Đối chiếu toàn bộ (14/10/2026): thẻ mốc toàn bộ cảnh báo khi chưa chạy; nút riêng gửi mode full; ô Thiếu trên Inside; cảnh báo giảm so với mốc
      assert.equal(await page.locator('#ss-strip-full').getAttribute('data-stale'), 'true');
      assert.equal((await page.locator('#ss-last-full-rel').innerText()).trim(), 'Chưa chạy', 'chưa có lượt toàn bộ: chỉ ghi "Chưa chạy", không còn câu khuyên (18/10/2026)');
      // Đang đọc: nút vừa bấm có data-busy="true", nhãn "Đang đọc…", icon đổi sang mũi tên vòng xoay; nút kia chỉ khoá, giữ nhãn
      const idleMask = await page.locator('#sku-sync-full').evaluate(b => getComputedStyle(b, '::before').maskImage);
      assert.equal((await barInfo(page, 'sku-sync-full')).content, 'none', 'rảnh: không có vạch load dưới nút');
      assert.equal(await page.locator('#sku-sync-progress').evaluate(n => n.getClientRects().length), 0, 'rảnh: thanh tiến độ rời không hiện');
      let release; hold = new Promise(resolve => { release = resolve; });
      await page.locator('#sku-sync-full').click();
      await page.waitForFunction(() => document.getElementById('sku-sync-full').dataset.busy === 'true');
      assert.equal((await page.locator('#sku-sync-full').innerText()).trim(), 'Đang đọc…');
      assert.equal(await page.locator('#sku-sync-full').evaluate(b => getComputedStyle(b, '::before').maskImage !== 'none' && getComputedStyle(b, '::before').animationName !== 'none'), true, 'icon vòng xoay khi đang đọc');
      assert.notEqual(await page.locator('#sku-sync-full').evaluate(b => getComputedStyle(b, '::before').maskImage), idleMask, 'icon khác lúc rảnh');
      expectBar(await barInfo(page, 'sku-sync-full'), '#sku-sync-full đang đọc'); // Đồng bộ SKU không có tiến độ trang: đoạn 38 % trượt qua lại
      assert.equal(await page.locator('#sku-sync-progress').evaluate(n => n.getClientRects().length), 0, 'đang đọc: thanh tiến độ rời chạy ngang màn không còn hiện');
      assert.equal((await barInfo(page, 'sku-sync-preview')).content, 'none', 'nút kia chỉ khoá, không có vạch');
      assert.equal(await page.locator('#sku-sync-preview').isDisabled(), true);
      assert.notEqual(await page.locator('#sku-sync-preview').getAttribute('data-busy'), 'true');
      assert.equal((await page.locator('#sku-sync-preview').innerText()).trim(), 'Đọc Inside');
      release(); hold = null;
      await page.waitForFunction(() => /Đối chiếu xong/.test(document.getElementById('sku-sync-status').textContent));
      assert.notEqual(await page.locator('#sku-sync-full').getAttribute('data-busy'), 'true');
      assert.equal((await page.locator('#sku-sync-full').innerText()).trim(), 'Toàn bộ', 'đọc xong trả nhãn cũ');
      assert.equal((await barInfo(page, 'sku-sync-full')).content, 'none', 'đọc xong: vạch load mất');
      assert.equal(calls.includes('preview:full'), true, 'Edge nhận mode full');
      assert.match(await page.locator('#sku-sync-status').innerText(), /Có 7 cảnh báo\. Tổng SKU nguồn giảm 3% so với mốc 100\./);
      assert.equal((await page.locator('#ss-sku-missing').innerText()).trim(), '1');
      assert.equal((await page.locator('#ss-sku-skipped').innerText()).trim(), '2.629', 'SKU ngừng chưa có trong database: chỉ đếm, không nạp');
      assert.equal(await page.locator('#ss-sku-skipped').evaluate(node => node.closest('.ss-metric').tagName), 'DIV', 'ô bỏ qua không mở popup');
      assert.equal(await page.locator('#ss-sku-missing').evaluate(node => node.closest('.ss-metric').dataset.alert), 'true');
      await openKind(page, 'sku-missing');
      assert.equal((await page.locator('#ss-change-title').innerText()).trim(), 'SKU không còn trên Inside');
      assert.deepEqual(await headers(page), ['SKU', 'Sản phẩm', 'Nhóm hàng', 'Trong Supabase']);
      assert.deepEqual(await cells(page), [['900000009', 'SKU cũ', 'Thời Trang', 'Ngừng']]);
      await closeDlg(page);
      assert.equal(await page.locator('#sku-sync-full').isDisabled(), false);

      // Tạo preview: ô cảnh báo sáng lên, tiêu đề bảng đổi theo từng nhóm
      await page.locator('#sku-sync-preview').click();
      await page.waitForFunction(() => /cảnh báo/.test(document.getElementById('sku-sync-status').textContent));
      assert.equal(await page.locator('#ss-apply').isDisabled(), false);
      assert.equal((await page.locator('#sku-sync-status').innerText()).includes('Xem chi tiết'), false);
      for (const [id, count] of [['ss-combo-orphaned', '2'], ['ss-combo-excluded', '2'], ['ss-source-issues', '2']]) {
        assert.equal((await page.locator('#' + id).innerText()).trim(), count);
        assert.equal(await page.locator('#' + id).evaluate(node => node.closest('.ss-metric').dataset.alert), 'true');
      }

      assert.equal(await dlg(page).evaluate(node => node.open), false, 'xem trước xong không tự mở popup');
      if (width === 1280) assert.deepEqual(await belowHeroAudit(page, '#sku-sync-screen', ['ss-strip'], true), [], 'dưới hero: dải phẳng, ô số liệu phân tầng (0 xám phẳng, thay đổi xanh, cảnh báo vàng, nguồn trung tính)');
      if (width === 1280) assert.deepEqual(await layoutAudit(page, '#sku-sync-screen', ['ss-strip'], false), [], '1280 px: dải không rơi ô lẻ');
      assert.equal(await page.locator('#ss-apply').getAttribute('data-count'), '3', 'nút Cập nhật ghi số thay đổi');
      assert.equal(await page.locator('[data-change-kind="combo-added"]').getAttribute('data-zero'), 'true');
      await page.locator('[data-change-kind="combo-added"]').click(); await page.waitForTimeout(150);
      assert.equal(await dlg(page).evaluate(node => node.open), false, 'ô 0 dòng không mở popup');
      await openKind(page, 'sku-added');
      assert.equal((await page.locator('#ss-change-title').innerText()).trim(), 'SKU mới');
      assert.equal(await dlg(page).locator('.as-d-mark svg').count(), 1, 'popup có icon nhóm');
      assert.deepEqual(await headers(page), ['SKU', 'Sản phẩm', 'Nhóm hàng']); // nhóm mặc định (SKU mới)
      assert.deepEqual(await cells(page), [['900000001', 'SKU thử', 'Thời Trang (Phụ Liệu)'], ['900000002', 'Chỉ Irisa / F6-8012 / 100% Polyester / Navy', 'Thời Trang (Phụ Liệu)']]);
      assert.equal(await page.locator('#ss-change-body .as-name b').count(), 2, 'phần đầu tên sản phẩm in đậm');
      // Thẻ chia 3 cụm có tiêu đề, mọi thẻ có icon
      assert.deepEqual(await page.locator('.as-group > h3').evaluateAll(nodes => nodes.map(n => n.textContent.trim())), ['SKU · 3 thay đổi', 'Combo', 'Cảnh báo · 6'], 'tiêu đề cụm ghi tổng (review 16/10)');
      assert.equal(await page.locator('#sku-sync-status').getAttribute('data-tone'), 'warn', 'dòng kết luận tông vàng khi có cảnh báo');
      assert.equal((await page.locator('#ss-apply').innerText()).trim(), 'Cập nhật', 'nhãn nút cố định; số thay đổi nằm ở huy hiệu (17/10/2026)');
      assert.equal(await page.locator('#ss-apply').getAttribute('data-count'), '3');
      assert.equal(await page.locator('#ss-apply').evaluate(b => getComputedStyle(b, '::after').content), '"3"', 'huy hiệu ::after ghi số thay đổi');
      assert.equal(await page.locator('.as-group .ss-metric > span svg').count(), 11, 'mỗi thẻ có icon');
      assert.equal((await page.locator('#ss-last-done').innerText()).trim() !== '—', true, 'dải lần đồng bộ gần nhất có dữ liệu');
      // Tìm không phân biệt dấu + xuất Excel
      await page.locator('#ss-tools input').fill('chi irisa'); assert.equal(await page.locator('#ss-change-body tr').count(), 1); assert.equal((await page.locator('#ss-change-note').innerText()).trim(), '1 / 2 dòng');
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#ss-tools [data-as-export]').click()]);
      assert.match(download.suggestedFilename(), /^sku-sync-sku-added-\d{8}-\d{4}\.xlsx$/);
      const book = require('./xlsx_read.cjs').readXlsx(require('node:fs').readFileSync(await download.path())); assert.deepEqual(book.table[0], ['SKU', 'Sản phẩm', 'Nhóm hàng'], 'tiêu đề cột tiếng Việt đọc đúng'); assert.equal(book.table[1][0], '900000002'); assert.equal(JSON.stringify(book.table).includes('900000001'), false, 'chỉ xuất các dòng đang lọc'); assert.equal(book.table.length, 2, 'tiêu đề + 1 dòng đang lọc');
      await page.locator('#ss-tools input').fill('');
      // Esc đóng popup; bấm nền (ngoài hộp) cũng đóng
      await closeDlg(page); await openKind(page, 'sku-added');
      await page.mouse.click(5, 5); await dlg(page).waitFor({ state: 'hidden' });
      // SKU cập nhật: nhãn tiếng Việt, không lộ tên trường kỹ thuật, trạng thái dịch sang chữ
      await openKind(page, 'sku-updated');
      assert.deepEqual(await headers(page), ['SKU', 'Thay đổi']);
      const updatedText = await page.locator('#ss-change-body').innerText();
      for (const label of ['Tên sản phẩm', 'Trạng thái', 'Hoạt động', 'Ngừng', 'Thẻ bài/S/pcs', 'Thẻ bài/S/cái']) assert.equal(updatedText.includes(label), true, label);
      for (const raw of ['product_name', 'category_name', 'status:']) assert.equal(updatedText.includes(raw), false, `không lộ ${raw}`);
      await closeDlg(page); await openKind(page, 'combo-orphaned');
      assert.deepEqual(await headers(page), ['Combo → Normal', 'Lý do', 'Trong Supabase', 'Trên Inside']);
      await allVisible(page);
      assert.deepEqual(await cells(page), [
        ['C0 → OLD', 'Thành phần không còn', 'Số lượng: 2 · Combo C0', 'Không còn'],
        ['GONE → N5', 'Combo không còn', 'Số lượng: 1', 'Không còn'],
      ]);
      assert.equal((await page.locator('#ss-change-note').innerText()).trim(), '2 dòng');

      await closeDlg(page); await openKind(page, 'combo-excluded');
      assert.deepEqual(await headers(page), ['Combo → Normal', 'Loại', 'Số lượng', 'SKU chưa có trong database']);
      await allVisible(page);
      assert.deepEqual(await cells(page), [['C1 → N1', 'Thiếu SKU', '1000', 'Combo'], ['C2 → N2', 'Thiếu SKU', '6', 'Normal']]);

      await closeDlg(page); await openKind(page, 'source-issues');
      assert.deepEqual(await headers(page), ['Mã', 'Loại lỗi', 'Nội dung trên Inside', 'Lý do']);
      await allVisible(page);
      const issues = await cells(page);
      assert.deepEqual(issues[0], ['C3', 'Thiếu thành phần', 'Combo C3=A1 + B 1', 'Bỏ qua thành phần: B 1']);
      assert.equal(issues[1][2], 'Ghi chú <b>tự do</b>');
      assert.equal(await page.locator('#ss-change-body b').count(), 0, 'nội dung từ Inside không được chèn thành HTML');

      await closeDlg(page); await openKind(page, 'sku-added');
      assert.deepEqual(await headers(page), ['SKU', 'Sản phẩm', 'Nhóm hàng']);
      await closeDlg(page);

      // Cập nhật Supabase luôn hỏi xác nhận trước: Giữ lại = không gọi apply; Đồng ý = gọi một lần rồi khóa nút
      await page.locator('#ss-apply').click();
      const confirm = page.locator('dialog.whd'); await confirm.waitFor({ state: 'visible' });
      assert.match(await confirm.locator('.whd-title').innerText(), /^Cập nhật 3 thay đổi vào Supabase$/);
      assert.deepEqual(await confirm.locator('.whd-facts li').allInnerTexts(), ['2 SKU mới', '1 SKU cập nhật']);
      await confirm.locator('.whd-cancel').click(); await confirm.waitFor({ state: 'hidden' });
      assert.equal(calls.includes('apply'), false, 'Huỷ thì không ghi vào Supabase');
      assert.equal(await page.locator('#ss-apply').isDisabled(), false);
      await page.locator('#ss-apply').click(); await confirm.waitFor({ state: 'visible' });
      // Đang cập nhật (ghi Supabase): nút Cập nhật giữ chữ + mang data-busy, vạch load dưới nút (đoạn trượt), thanh tiến độ rời không hiện
      assert.equal((await barInfo(page, 'ss-apply')).content, '"3"', 'rảnh: ::after của nút Cập nhật là huy hiệu số, chưa phải vạch');
      let releaseApply; holdApply = new Promise(resolve => { releaseApply = resolve; });
      await confirm.locator('.whd-ok').click();
      await page.waitForFunction(() => document.getElementById('ss-apply').dataset.busy === 'true');
      assert.equal((await page.locator('#ss-apply').innerText()).trim(), 'Cập nhật', 'đang ghi giữ chữ Cập nhật');
      assert.equal(await page.locator('#ss-apply').isDisabled(), true);
      expectBar(await barInfo(page, 'ss-apply'), '#ss-apply đang ghi');
      assert.equal(await page.locator('#ss-apply').evaluate(b => getComputedStyle(b).opacity), '1', 'đang ghi: nút không mờ để vạch đủ nét');
      assert.equal(await page.locator('#sku-sync-progress').evaluate(n => n.getClientRects().length), 0, 'đang ghi: thanh tiến độ rời không hiện');
      releaseApply(); holdApply = null;
      await page.waitForFunction(() => /^Hoàn tất: xác minh 3 SKU/.test(document.getElementById('sku-sync-status').textContent));
      await page.waitForFunction(() => document.getElementById('ss-apply').dataset.busy !== 'true');
      assert.notEqual((await barInfo(page, 'ss-apply')).content, '""', 'ghi xong: vạch load dưới nút mất');
      assert.equal(calls.filter(action => action === 'apply').length, 1);
      assert.equal(await page.locator('#ss-apply').isDisabled(), true);
      assert.equal((await page.locator('#sku-sync-status').innerText()).trim(), 'Hoàn tất: xác minh 3 SKU và 0 quan hệ; database có 100 SKU. · Đã lưu trữ 1 SKU rời nhóm, giữ lại 2', 'câu hoàn tất ghi số SKU rời nhóm đã lưu trữ');
      assert.equal(await page.locator('#sku-sync-status').getAttribute('data-tone'), 'ok');

      // Lượt tự động bị giữ lại (held): mở từ lịch sử hiện lý do + gợi ý chạy lại, nút Cập nhật khoá
      await page.locator('#ss-history-btn').click();
      await page.locator('#ss-hist-dialog').waitFor({ state: 'visible' });
      await page.locator('#ss-history tr[data-run="run-auto"]').click();
      await page.locator('#ss-hist-dialog').waitFor({ state: 'hidden' });
      await page.waitForFunction(() => /Giữ lại \(tự động\)/.test(document.getElementById('sku-sync-status').textContent));
      assert.equal((await page.locator('#sku-sync-status').innerText()).trim(), 'Giữ lại (tự động): 21 SKU rời nhóm đồng bộ (ngưỡng 20). Lượt này không cập nhật được; bấm Toàn bộ để có bản mới.');
      assert.equal(await page.locator('#sku-sync-status').getAttribute('data-tone'), 'warn');
      assert.equal(await page.locator('#ss-apply').isDisabled(), true, 'lượt held không cập nhật được');

      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      assert.deepEqual(errors, []);
      await context.close();
      console.log(`PASS ${width}px: menu icon SVG, không câu hướng dẫn, tiêu đề bảng theo nhóm, ô cảnh báo, preview hết hạn, không tràn ngang/lỗi`);
    }
    // Ô Đối chiếu toàn bộ quá 36 giờ (18/10/2026): chỉ ghi "<x> trước · quá 36 giờ" và đổi sang nền vàng, không còn câu khuyên "nên đối chiếu toàn bộ"; trong hạn thì chỉ ghi "<x> trước"
    for (const [agoMin, stale, pattern] of [[40 * 60, 'true', /^.+ trước · quá 36 giờ$/], [20 * 60, 'false', /^.+ trước$/]]) {
      histFullAt = ago(agoMin);
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page = await context.newPage();
      await mockRoutes(page);
      await page.goto(BASE + '#admin/sku-sync');
      await page.locator('#sku-sync-screen').waitFor({ state: 'visible' });
      await page.locator('#ss-history tr[data-run]').first().waitFor({ state: 'attached' });
      await page.waitForFunction(() => document.getElementById('ss-strip-full').dataset.stale !== undefined && /trước/.test(document.getElementById('ss-last-full-rel').textContent));
      assert.equal(await page.locator('#ss-strip-full').getAttribute('data-stale'), stale, `toàn bộ cách ${agoMin / 60} giờ: data-stale ${stale}`);
      assert.match((await page.locator('#ss-last-full-rel').innerText()).trim(), pattern, `toàn bộ cách ${agoMin / 60} giờ`);
      assert.doesNotMatch(await page.locator('#ss-last-full-rel').innerText(), /nên/, 'không còn câu khuyên');
      if (stale === 'true') assert.equal(await page.locator('#ss-strip-full').evaluate(e => getComputedStyle(e).backgroundColor), 'rgb(255, 250, 235)', 'ô quá hạn có nền vàng nhạt');
      await context.close();
      console.log(`PASS ô Toàn bộ cách ${agoMin / 60} giờ: ${stale === 'true' ? 'quá 36 giờ, nền vàng, không câu khuyên' : 'trong hạn, không cảnh báo'}`);
    }
    histFullAt = null;
    // 1024 → 1440 px (Admin chỉ xét máy tính; 1024 hẹp nhất còn thanh trái 264): hero vẫn một hàng; sau khi đọc có kết quả: dải phẳng, ô số liệu phân tầng,
    // ≤ 1199 px nhóm SKU 4 ô nằm một hàng và không có ô lẻ (trước khối #hero-standard: ô thứ 4 rơi xuống hàng riêng).
    for (const width of [1024, 1100, 1199, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 800 } });
      await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: 'test-admin-token', refresh_token: 'test-refresh-token' })), SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page = await context.newPage();
      await mockRoutes(page);
      await page.goto(BASE + '#admin/sku-sync');
      await page.locator('#sku-sync-screen').waitFor({ state: 'visible' });
      await page.locator('#ss-history tr[data-run]').first().waitFor({ state: 'attached' });
      assert.deepEqual(await heroAudit(page, '#sku-sync-screen', HERO_SPECS), [], `hero ${width} px một hàng`);
      await page.locator('#ss-auto-toggle').waitFor({ state: 'visible' });
      assert.deepEqual(await autoCellAudit(page, 'ss-strip', 'ss-strip-auto'), [], `${width} px: ô Tự động — nút 36×36 trong ô, không che chữ`);
      await page.locator('#sku-sync-preview').click();
      await page.waitForFunction(() => /cảnh báo/.test(document.getElementById('sku-sync-status').textContent));
      assert.deepEqual(await belowHeroAudit(page, '#sku-sync-screen', ['ss-strip'], true), [], `${width} px dưới hero: dải phẳng, ô số liệu phân tầng`);
      assert.deepEqual(await layoutAudit(page, '#sku-sync-screen', ['ss-strip'], width <= 1199), [], `${width} px: nhóm SKU một hàng (≤ 1199), dải không ô lẻ`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      await context.close();
      console.log(`PASS ${width}px: hero một hàng, dải phẳng, ô số liệu phân tầng, ${width <= 1199 ? 'nhóm SKU 4 ô một hàng, ' : ''}dải không ô lẻ, không tràn ngang`);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
