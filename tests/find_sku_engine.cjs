// Kiểm tra bộ đối chiếu của trang TÌM SKU (index.html, #find-sku) mà không cần trình duyệt.
// Cắt đúng khối NDS_ENGINE nằm giữa hai dấu mốc trong index.html — test và bản chạy thật không
// bao giờ lệch nhau. Danh mục dưới đây là GIẢ, chỉ mô phỏng hình dạng tên hàng thật.
//   node tests/find_sku_engine.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('/* ===== NDS-ENGINE (bat dau) =====');
const end = html.indexOf('/* ===== NDS-ENGINE (ket thuc) ===== */');
assert.ok(start > 0 && end > start, 'index.html phải có đủ hai dấu mốc NDS-ENGINE');
const NDS_ENGINE = new Function(`${html.slice(start, end)}; return NDS_ENGINE;`)();

// Cùng quy tắc với toRow() trong script TÌM SKU.
const row = (sku, pn, status = '1') => ({
  sku, pn,
  type: /^\s*\(combo\)/i.test(pn) ? 'COMBO' : 'NORMAL',
  status: /^(0|false|inactive)$/i.test(status) ? 'INACTIVE' : 'ACTIVE',
  qty: 0
});
const catalog = [
  row('900000001', 'Chỉ may/None/None/Brand-A TX0144/Be/None/5000m/mm'),
  row('900000002', '(Combo) Chỉ may/None/None/Brand-A TX0144/Be/None/5000m/cuộn'),
  row('900000003', 'Chỉ Line-B/QZ3966_Brand-C/Polyester/None/Red Ochre/None/Text 27-60-3-Tkt 120/mm'),
  row('900000004', 'Chỉ Line-D/QZ3966_Brand-C/Polyester/None/Red Ochre/None/Text 24-100D-2- Tkt 120/mm'),
  row('900000005', 'Chỉ Line-B/QZ3967_Brand-C/Polyester/None/Navy/None/Text 27-60-3-Tkt 120/mm'),
  row('900000006', 'Chỉ Line-B/QZ3968_Brand-C/Polyester/None/Black/None/Text 27-60-3-Tkt 120/mm'),
  row('900000007', 'Vải thun thử/KT-5521_NCC thử/95% Cotton/None/Trắng/None/180gsm/kg'),
  row('900000008', 'Nút bấm thử/NB-2001_NCC thử/POM/None/Xanh/None/9mm/pcs', '0')
];
const cm = NDS_ENGINE.dungChiMuc(catalog.map(r => ({ ...r })));

// Cùng đường với match(): chữ thô → từ khoá theo vai → tuAI → timTop.
function search(text, extra = {}) {
  const split = NDS_ENGINE.tuVanBan(text, cm);
  const pack = {
    item_codes: [...split.code, ...(extra.codes || [])], specs: [...split.spec, ...(extra.specs || [])],
    colors: split.color, brands: split.brand, others: []
  };
  const nhan = NDS_ENGINE.tuAI(pack, cm);
  nhan.maChu = NDS_ENGINE.maChuTem(text, cm).filter(t => nhan.code.includes(t));
  const found = NDS_ENGINE.timTop(nhan, cm, { soLuong: 3, chiActive: true });
  return { found, skus: found.map(r => r.sku), coMaKhop: found.coMaKhop };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('mã in trên tem ra đúng SKU, bản Combo xếp sau', () => {
  const { skus, coMaKhop } = search('BRAND-A\nStaple Spun Polyester\n30/3 Tex 60\n3000M\nTX0144');
  assert.equal(skus[0], '900000001');
  assert.ok(skus.includes('900000002'), 'bản Combo cùng mã vẫn phải được gợi ý');
  assert.equal(coMaKhop, true);
});

test('cùng mã nhưng khác thông số: Tex 27 chọn đúng dòng Text 27, không phải Text 24', () => {
  const { skus } = search('Brand-C line-b\nTkt 120\n5000m Tex 27\nCol QZ3966');
  assert.equal(skus[0], '900000003');
  assert.ok(skus.indexOf('900000004') > 0, 'dòng Text 24 cùng mã phải xếp sau');
});

test('chỉ gõ mã (ô "Mã trên tem") vẫn tìm được', () => {
  const { skus } = search('QZ3966');
  assert.deepEqual([...skus].sort(), ['900000003', '900000004']);
});

test('không khớp được mã nào thì báo coMaKhop = false, không tự tin chọn bừa', () => {
  const { found, coMaKhop } = search('Brand-C Polyester Tkt 120');
  assert.ok(found.length > 0);
  assert.equal(coMaKhop, false);
});

test('"Ý bạn là…": mã đọc lệch một ký tự gợi ý mã CÓ THẬT trong danh mục', () => {
  const near = NDS_ENGINE.maGanGiong(NDS_ENGINE.chuan('QZ3969'), cm, 3);
  assert.ok(near.length > 0 && near.every(code => cm.idx[code]), `phải gợi ý mã có thật, được ${JSON.stringify(near)}`);
  assert.ok(near.includes(NDS_ENGINE.chuan('QZ3968')) || near.includes(NDS_ENGINE.chuan('QZ3966')));
});

test('SKU ngừng hoạt động vẫn được gợi ý nhưng mang status INACTIVE để giao diện gắn nhãn "Ngừng"', () => {
  // timTop cố ý KHÔNG loại INACTIVE (xem chú thích trong NDS_ENGINE: còn giữ để gom biến thể).
  const { found } = search('NB-2001');
  const hit = found.find(r => r.sku === '900000008');
  assert.ok(hit, 'mã chỉ có ở SKU ngừng thì vẫn phải tìm ra');
  assert.equal(hit.status, 'INACTIVE');
});

test('dựng chỉ mục theo lô cho cùng kết quả với dựng một hơi', () => {
  const job = NDS_ENGINE.dungChiMucViec(catalog.map(r => ({ ...r })));
  let steps = 0;
  while (!job.buoc(3)) steps++;
  assert.ok(steps > 1, 'phải chia được nhiều lô');
  const nhan = NDS_ENGINE.tuAI({ item_codes: [NDS_ENGINE.chuan('QZ3966')], specs: [NDS_ENGINE.chuan('Tex 27')], colors: [], brands: [], others: [] }, job.cm);
  assert.equal(NDS_ENGINE.timTop(nhan, job.cm, { soLuong: 1 })[0].sku, '900000003');
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed++; console.log(`not ok - ${name}\n  ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} đạt`);
process.exitCode = failed ? 1 : 0;
