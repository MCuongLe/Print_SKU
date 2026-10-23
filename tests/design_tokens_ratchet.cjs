// Chặn nợ giao diện quay lại (23/10/2026, Đợt 3 theo skill UI UX Pro Max; người dùng chọn "Có, chặn tăng"):
// 1) Số giá trị KHÁC NHAU viết cứng trong CSS (màu: hex 3/4/6/8 + rgb()/rgba()/hsl(); cỡ chữ: font-size + font rút gọn; bo góc; bóng;
//    z-index) không được vượt mức trần đo ngày 23/10/2026. Đếm theo khai báo (phần giá trị), không đếm bộ chọn / chú thích / url().
//    CSS mới dùng token ở khối <style id="wms-design-system"> :root (--wms-*, --fs-*, --fw-*, --radius-*, --shadow-*, --space-*).
//    Thật sự cần giá trị mới (vd. tem in, màu thương hiệu bên ngoài) → tăng mức trần dưới đây trong cùng commit, ghi lý do vào RULES.md.
// 2) Các khối chuẩn chung không viết cứng giá trị đã có token; cỡ chữ ở đó chỉ dùng --fs-* (mọi cỡ px viết cứng đều bị chặn). Giá trị giảm → nên hạ mức trần (test in gợi ý).
// Không cần máy chủ / trình duyệt: chỉ đọc index.html.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CEILING = { color: 429, fontSize: 20, radius: 45, shadow: 83, zIndex: 23 };
const STANDARD = ['type-standard', 'ui-standard', 'app-nav-theme', 'hero-standard', 'tick-standard'];
const TOKEN_SIZES = [12, 13, 14, 16, 18, 22, 28];

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const clean = css => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()');
const styles = [...html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)].map(m => ({ id: (m[1].match(/id="([^"]+)"/) || [])[1] || '', css: clean(m[2]) }));
// Khai báo trong khối { … } trong cùng → [thuộc tính, giá trị]
const decls = css => [...css.matchAll(/\{([^{}]*)\}/g)].flatMap(m => m[1].split(';').map(d => { const i = d.indexOf(':'); return i > 0 ? [d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()] : null; }).filter(Boolean));
const norm = v => v.toLowerCase().replace(/\s+/g, ' ').replace(/\s*!important$/, '').trim();
const COLOR = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b|(?:rgba?|hsla?)\([^()]*\)/gi;
// Mọi kích thước px/rem/em trong giá trị cỡ chữ (kể cả trong clamp()/calc()); với font rút gọn bỏ chiều cao dòng sau dấu /
const fontSizesOf = (prop, val) => prop === 'font-size' ? val.match(/[0-9.]+(?:px|rem|em)\b/gi) || [] : prop === 'font' ? [...val.matchAll(/(?<!\/\s*)(?<![\w.])([0-9.]+(?:px|rem|em))\b/gi)].map(m => m[1]) : [];

const all = styles.flatMap(s => decls(s.css));
const got = { color: new Set(), fontSize: new Set(), radius: new Set(), shadow: new Set(), zIndex: new Set() };
for (const [prop, raw] of all) {
  const val = norm(raw);
  for (const c of val.match(COLOR) || []) got.color.add(c.replace(/\s+/g, ''));
  for (const fsz of fontSizesOf(prop, val)) got.fontSize.add(fsz);
  if (/^border(-[a-z]+)*-radius$/.test(prop)) got.radius.add(val);
  if (prop === 'box-shadow') got.shadow.add(val);
  if (prop === 'z-index' && /^-?\d+$/.test(val)) got.zIndex.add(val);
}
const over = Object.entries(CEILING).filter(([k, max]) => got[k].size > max).map(([k, max]) => `${k}: ${got[k].size} > trần ${max}`);
assert.deepEqual(over, [], 'CSS có thêm giá trị viết cứng mới — dùng token ở wms-design-system (xem đầu tệp test)');
const under = Object.entries(CEILING).filter(([k, max]) => got[k].size < max).map(([k, max]) => `${k} ${got[k].size} (trần ${max})`);

// Token phải tồn tại ở :root
const root = (html.match(/<style id="wms-design-system">[\s\S]*?:root\s*\{([\s\S]*?)\n\s*\}/) || [])[1] || '';
const tok = Object.fromEntries([...root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map(m => [m[1], m[2].trim().toLowerCase()]));
for (const name of ['--wms-brand', '--wms-text', '--wms-text-2', '--wms-muted', '--wms-border', '--wms-bg', '--wms-surface', '--wms-on-brand', '--wms-control-border',
  '--wms-border-accent', '--wms-focus-ring', '--wms-success', '--wms-warning', '--wms-danger', '--fs-12', '--fs-28', '--fw-semibold', '--radius-control', '--radius-pill', '--shadow-card'])
  assert.ok(tok[name], `thiếu token ${name}`);

// Khối chuẩn: không viết cứng giá trị đã có token (bỏ qua giá trị dự phòng trong var())
const tokenValues = new Map(Object.entries(tok).map(([k, v]) => [v, k]));
const literal = [];
for (const id of STANDARD) {
  const block = styles.find(s => s.id === id);
  assert.ok(block, `thiếu khối ${id}`);
  for (const [prop, raw] of decls(block.css)) {
    let val = norm(raw);
    while (/var\([^()]*\)/.test(val)) val = val.replace(/var\([^()]*\)/g, 'VAR');
    for (const c of val.match(COLOR) || []) if (c !== '#fff' && c !== '#ffffff' && tokenValues.has(c)) literal.push(`${id}: ${prop}: ${c} → var(${tokenValues.get(c)})`);
    for (const fsz of fontSizesOf(prop, val)) literal.push(`${id}: ${prop} ${fsz} → var(--fs-*)${TOKEN_SIZES.includes(parseFloat(fsz)) ? '' : ' (cỡ ngoài thang chữ)'}`);
    if (/^border(-[a-z]+)*-radius$/.test(prop) && val.split(/[\s/]+/).some(v => ['12px', '16px', '999px'].includes(v))) literal.push(`${id}: ${prop} ${val} → token --radius-*`);
  }
}
assert.deepEqual(literal, [], 'khối chuẩn viết cứng giá trị đã có token');

console.log(`PASS token: màu ${got.color.size}, cỡ chữ ${got.fontSize.size}, bo góc ${got.radius.size}, bóng ${got.shadow.size}, z-index ${got.zIndex.size} (không vượt trần); ${STANDARD.length} khối chuẩn chỉ dùng token`);
if (under.length) console.log(`  Gợi ý: đã giảm — hạ mức trần trong test: ${under.join(', ')}`);
