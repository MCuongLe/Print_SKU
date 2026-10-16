// Kiểm tra bộ chia mẫu cắt / QC (CUT-SAMPLE-CORE trong index.html): cắt 20% cây nhỏ nhất + QC 10% cây lớn nhất, và QUY TẮC BẮT BUỘC
// cắt + QC ≥ 30% số cây của MỖI lot (làm tròn lên), mỗi bên ≥ 1 cây khi lot có từ 2 cây, hai nhóm không trùng nhau. Không cần trình duyệt.
//   node tests/cut_sample_core.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('/* ===== CUT-SAMPLE-CORE (bat dau) =====');
const end = html.indexOf('/* ===== CUT-SAMPLE-CORE (ket thuc) ===== */');
assert.ok(start > 0 && end > start, 'index.html phải có đủ hai dấu mốc CUT-SAMPLE-CORE');
assert.ok(!html.slice(start, end).includes('\u0000'), 'khối chia mẫu không được chứa ký tự NUL thật (phải là \\u0000 trong chuỗi)');
const CORE = new Function(`${html.slice(start, end)}; return CUT_SAMPLE_CORE;`)();

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// Lot n cây: qty = 1000 + i * 100 (cây 1 nhỏ nhất, cây n lớn nhất), mã UID tăng theo i.
const lot = (sku, lotCode, count, qtyOf = i => 1000 + i * 100) => Array.from({ length: count }, (_, k) => {
  const i = k + 1;
  return { groupUid: `${sku}${lotCode}${String(i).padStart(3, '0')}`, sku, lot: lotCode, qty: qtyOf(i) };
});
const rolesOf = (result, role) => result.items.filter(row => row.role === role).map(row => row.groupUid);
const ceilDiv = (a, b) => Math.floor((a + b - 1) / b); // ceil độc lập với bộ chia mẫu

test('đúng ví dụ của người dùng: lot 10 cây → cắt 2 cây nhỏ nhất, QC 1 cây lớn nhất (đúng 30%)', () => {
  const result = CORE.plan(lot('S1', 'L1', 10));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(rolesOf(result, 'cut'), ['S1L1001', 'S1L1002']);
  assert.deepEqual(rolesOf(result, 'qc'), ['S1L1010']);
  assert.equal(rolesOf(result, 'store').length, 7);
  assert.deepEqual(result.groups, [{ sku: 'S1', lot: 'L1', total: 10, cut: 2, qc: 1, store: 7, sample: 3, qcShort: false }]);
});

test('QUY TẮC: mọi lot 1..2000 cây có cắt + QC ≥ 30% (làm tròn lên), mỗi bên ≥ 1 khi lot ≥ 2 cây, không vượt số cây', () => {
  for (let n = 1; n <= 2000; n += 1) {
    const { sample, cut, qc } = CORE.quota(n);
    assert.equal(sample, cut + qc, `n=${n}`);
    assert.ok(cut >= 1, `n=${n}: phải có cây cắt`);
    assert.ok(cut + qc <= n, `n=${n}: không lấy quá số cây`);
    assert.ok((cut + qc) * 10 >= 3 * n, `n=${n}: ${cut}+${qc} chưa đạt 30%`);
    if (n >= 2) assert.ok(qc >= 1, `n=${n}: phải có cây QC`);
    // Tối thiểu đúng mức cần: không lấy dư so với 30% làm tròn lên (trừ sàn 2 cây cho lot nhỏ).
    assert.equal(cut + qc, n === 1 ? 1 : Math.min(n, Math.max(2, ceilDiv(3 * n, 10))), `n=${n}: tổng mẫu`);
  }
});

test('lot 7 cây (trường hợp 20% + 10% làm tròn chỉ ra 2 cây = 28,6%) nay lấy 3 cây; lot 11, 12, 14 cũng được nâng lên 30%', () => {
  const expected = { 1: [1, 0], 2: [1, 1], 3: [1, 1], 4: [1, 1], 5: [1, 1], 6: [1, 1], 7: [2, 1], 8: [2, 1], 9: [2, 1], 10: [2, 1], 11: [3, 1], 12: [3, 1], 13: [3, 1], 14: [3, 2], 15: [3, 2], 20: [4, 2], 100: [20, 10] };
  for (const [n, [cut, qc]] of Object.entries(expected)) {
    const got = CORE.quota(Number(n));
    assert.deepEqual([got.cut, got.qc], [cut, qc], `lot ${n} cây`);
  }
});

test('lot chia hết cho 10 giữ đúng 20% cắt + 10% QC (như ví dụ ban đầu)', () => {
  for (let n = 10; n <= 1000; n += 10) assert.deepEqual([CORE.quota(n).cut, CORE.quota(n).qc], [n / 5, n / 10], `n=${n}`);
});

test('cắt : QC theo tỷ lệ 2 : 1 của tổng mẫu (làm tròn gần nhất, không lệch quá 0,5 cây)', () => {
  for (let n = 2; n <= 2000; n += 1) {
    const { sample, cut } = CORE.quota(n);
    assert.ok(Math.abs(cut - (2 * sample) / 3) <= 0.5 + 1e-9, `n=${n}: cắt ${cut} / mẫu ${sample}`);
  }
});

test('PO thật (323 UID, 51 lot, 2–8 cây/lot): mọi lot ≥ 30%; tổng cắt 80 + QC 51 = 131 cây (40,6%)', () => {
  const histogram = { 2: 1, 3: 2, 5: 4, 6: 15, 7: 27, 8: 2 }; // số cây mỗi lot → số lot
  const rows = [];
  let lotNo = 0;
  for (const [size, lots] of Object.entries(histogram)) {
    for (let k = 0; k < lots; k += 1) { lotNo += 1; rows.push(...lot('422494672', `L${String(lotNo).padStart(2, '0')}`, Number(size))); }
  }
  const result = CORE.plan(rows);
  assert.deepEqual(result.errors, []);
  assert.equal(result.items.length, 323);
  assert.equal(result.groups.length, 51);
  assert.equal(rolesOf(result, 'cut').length, 80);
  assert.equal(rolesOf(result, 'qc').length, 51);
  assert.ok(result.groups.every(g => g.sample * 10 >= 3 * g.total), 'mọi lot đạt 30%');
  assert.equal(result.groups.filter(g => g.qcShort).length, 0, 'mọi lot ≥ 2 cây đều đủ QC');
  assert.ok(result.groups.filter(g => g.total === 7).every(g => g.sample === 3), 'lot 7 cây lấy 3 cây');
});

test('nhiều lot cỡ ngẫu nhiên trong một phiên: lot nào cũng đạt 30%, và tổng phiên ≥ 30%', () => {
  let seed = 12345;
  const rand = max => { seed = (seed * 1103515245 + 12345) % 2147483648; return 1 + (seed % max); };
  const rows = [];
  for (let k = 0; k < 300; k += 1) rows.push(...lot(`S${k % 7}`, `L${k}`, rand(45), i => 500 + ((i * 37 + k) % 90)));
  const result = CORE.plan(rows);
  assert.deepEqual(result.errors, []);
  for (const g of result.groups) assert.ok(g.sample * 10 >= 3 * g.total, `${g.sku} ${g.lot}: ${g.sample}/${g.total}`);
  assert.ok(result.items.filter(i => i.role !== 'store').length * 10 >= 3 * result.items.length);
});

test('lot 1 cây: chỉ cắt, QC báo thiếu; lot 2 cây: nhỏ → cắt, lớn → QC', () => {
  const one = CORE.plan(lot('S1', 'L1', 1));
  assert.deepEqual([rolesOf(one, 'cut'), rolesOf(one, 'qc')], [['S1L1001'], []]);
  assert.deepEqual(one.groups[0], { sku: 'S1', lot: 'L1', total: 1, cut: 1, qc: 0, store: 0, sample: 1, qcShort: true });
  assert.deepEqual(one.errors, [], 'lot 1 cây lấy cả cây (100%) nên vẫn đạt 30%');
  const two = CORE.plan(lot('S1', 'L1', 2));
  assert.deepEqual([rolesOf(two, 'cut'), rolesOf(two, 'qc'), rolesOf(two, 'store')], [['S1L1001'], ['S1L1002'], []]);
  assert.equal(two.groups[0].qcShort, false);
});

test('hai nhóm không bao giờ trùng nhau và không vượt quá số cây của lot', () => {
  for (let n = 1; n <= 60; n += 1) {
    const result = CORE.plan(lot('S1', 'L1', n));
    const cut = new Set(rolesOf(result, 'cut')), qc = rolesOf(result, 'qc');
    assert.equal(qc.filter(code => cut.has(code)).length, 0, `lot ${n} cây: cắt và QC trùng`);
    assert.equal(result.items.length, n);
    assert.equal(result.groups[0].cut + result.groups[0].qc + result.groups[0].store, n);
  }
});

test('mỗi nhóm là (SKU + Lot): cùng mã lot ở hai SKU, hoặc hai lot của một SKU, chia riêng', () => {
  const rows = [...lot('S1', 'L1', 5), ...lot('S2', 'L1', 5), ...lot('S1', 'L2', 5)];
  const result = CORE.plan(rows);
  assert.deepEqual(result.groups.map(g => [g.sku, g.lot, g.cut, g.qc]), [['S1', 'L1', 1, 1], ['S1', 'L2', 1, 1], ['S2', 'L1', 1, 1]]);
  assert.deepEqual(result.skus, [{ sku: 'S1', total: 10, cut: 2, qc: 2, store: 6 }, { sku: 'S2', total: 5, cut: 1, qc: 1, store: 3 }]);
});

test('số lượng bằng nhau: chọn theo mã UID nên kết quả không phụ thuộc thứ tự dữ liệu vào', () => {
  const rows = lot('S1', 'L1', 8, () => 5000);
  const a = CORE.plan(rows), b = CORE.plan([...rows].reverse()), c = CORE.plan([...rows].sort(() => 0.5 - Math.random()));
  assert.deepEqual(rolesOf(a, 'cut'), ['S1L1001', 'S1L1002']);
  assert.deepEqual(rolesOf(a, 'qc'), ['S1L1003']);
  assert.deepEqual(a.items, b.items);
  assert.deepEqual(a.items, c.items);
});

test('ưu tiên theo số lượng, không theo thứ tự nhập', () => {
  const rows = [
    { groupUid: 'U1', sku: 'S1', lot: 'L', qty: 900 }, { groupUid: 'U2', sku: 'S1', lot: 'L', qty: 300 },
    { groupUid: 'U3', sku: 'S1', lot: 'L', qty: 1200 }, { groupUid: 'U4', sku: 'S1', lot: 'L', qty: 100 },
    { groupUid: 'U5', sku: 'S1', lot: 'L', qty: 700 }, { groupUid: 'U6', sku: 'S1', lot: 'L', qty: 1500 }
  ];
  const result = CORE.plan(rows);
  assert.deepEqual(rolesOf(result, 'cut'), ['U4'], '6 cây: 2 mẫu → 1 cây nhỏ nhất cắt');
  assert.deepEqual(rolesOf(result, 'qc'), ['U6'], '1 cây lớn nhất QC');
  assert.deepEqual(rolesOf(result, 'store').sort(), ['U1', 'U2', 'U3', 'U5']);
  const seven = CORE.plan([...rows, { groupUid: 'U7', sku: 'S1', lot: 'L', qty: 50 }]);
  assert.deepEqual(rolesOf(seven, 'cut'), ['U7', 'U4'], '7 cây: 3 mẫu → 2 cây nhỏ nhất cắt');
  assert.deepEqual(rolesOf(seven, 'qc'), ['U6'], 'và 1 cây lớn nhất QC');
});

test('dữ liệu sai thì báo lỗi, không im lặng bỏ qua: thiếu mã/SKU, số lượng ≤ 0 hoặc trống, trùng UID', () => {
  const result = CORE.plan([
    { groupUid: '', sku: 'S1', lot: 'L', qty: 1 }, { groupUid: 'A', sku: '', lot: 'L', qty: 1 },
    { groupUid: 'B', sku: 'S1', lot: 'L', qty: 0 }, { groupUid: 'C', sku: 'S1', lot: 'L', qty: '' },
    { groupUid: 'D', sku: 'S1', lot: 'L', qty: 'abc' }, { groupUid: 'E', sku: 'S1', lot: 'L', qty: 10 },
    { groupUid: 'E', sku: 'S1', lot: 'L', qty: 20 }
  ]);
  assert.equal(result.errors.length, 6);
  assert.match(result.errors.join('|'), /thiếu Group UID/);
  assert.match(result.errors.join('|'), /A: thiếu SKU/);
  assert.match(result.errors.join('|'), /E: trùng Group UID/);
  assert.equal(result.items.length, 1, 'chỉ dòng hợp lệ đầu tiên của E còn lại');
});

test('Roll đi theo từng UID qua bước chia (cần khi đẩy sang luồng Cắt UID); không có Roll thì rỗng', () => {
  const rows = lot('S1', 'L1', 5).map((row, i) => ({ ...row, roll: i === 0 ? ' 4-1 ' : i === 1 ? undefined : `R${i}` }));
  const byCode = Object.fromEntries(CORE.plan(rows).items.map(item => [item.groupUid, item.roll]));
  assert.deepEqual(byCode, { S1L1001: '4-1', S1L1002: '', S1L1003: 'R2', S1L1004: 'R3', S1L1005: 'R4' });
});

test('không có Lot vẫn chia thành một nhóm riêng; dữ liệu rỗng không lỗi', () => {
  const result = CORE.plan(lot('S1', '', 5));
  assert.deepEqual(result.groups.map(g => [g.lot, g.cut, g.qc]), [['', 1, 1]]);
  assert.deepEqual(CORE.plan([]), { items: [], groups: [], skus: [], errors: [] });
  assert.deepEqual(CORE.plan(null).errors, []);
});

test('tỷ lệ tuỳ chọn hợp lệ được dùng (mức tối thiểu = cắt % + QC %), không hợp lệ thì về 20% / 10%', () => {
  const custom = CORE.plan(lot('S1', 'L', 10), { cutPercent: 30, qcPercent: 20 }).groups[0];
  assert.deepEqual([custom.cut, custom.qc], [3, 2], 'mức 50% của 10 cây = 5 mẫu, chia 3 : 2');
  const fallback = CORE.plan(lot('S1', 'L', 10), { cutPercent: 0, qcPercent: 1.5 }).groups[0];
  assert.deepEqual([fallback.cut, fallback.qc], [2, 1]);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failed) { console.error(`${failed}/${cases.length} test lỗi`); process.exitCode = 1; } else console.log(`PASS cut sample core: ${cases.length} nhóm kiểm tra`);
