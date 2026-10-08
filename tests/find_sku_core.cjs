// Kiểm tra phần lõi thuần logic của trang TÌM SKU (FSK_CORE trong index.html): đọc số, quy đổi
// cân → mm, đơn vị/quy cách từ tên SKU, độ nét/độ yên và máy tự chụp. Không cần trình duyệt.
//   node tests/find_sku_core.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('/* ===== FSK-CORE (bat dau) =====');
const end = html.indexOf('/* ===== FSK-CORE (ket thuc) ===== */');
assert.ok(start > 0 && end > start, 'index.html phải có đủ hai dấu mốc FSK-CORE');
const CORE = new Function(`${html.slice(start, end)}; return FSK_CORE;`)();

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('parseNumber đọc số kiểu Việt lẫn Anh', () => {
  assert.equal(CORE.parseNumber('10'), 10);
  assert.equal(CORE.parseNumber('1.200,5'), 1200.5);
  assert.equal(CORE.parseNumber('1,200.5'), 1200.5);
  assert.equal(CORE.parseNumber('1.200'), 1200);
  assert.equal(CORE.parseNumber('1,5'), 1.5);
  assert.equal(CORE.parseNumber('5 000'), 5000);
  assert.ok(Number.isNaN(CORE.parseNumber('')));
  assert.ok(Number.isNaN(CORE.parseNumber('abc')));
});

test('convertWeight: đúng công thức AuditFactory (lô 0,9 kg · 10 cuộn · lõi 50 gr · cuộn nguyên 120 gr cả lõi · 5.000.000 mm)', () => {
  const r = CORE.convertWeight({ specMm: 5000000, total: 0.9, unit: 'kg', cones: 10, coreG: 50, fullG: 120, fullIncludesCore: true });
  assert.equal(r.ok, true);
  assert.equal(r.totalG, 900);
  assert.equal(r.coreTotalG, 500);
  assert.equal(r.threadG, 400);
  assert.equal(r.fullThreadG, 70);
  assert.equal(Math.round(r.mmPerG), 71429);
  assert.equal(r.mm, Math.round(400 * 5000000 / 70));
  assert.equal(Math.round(r.tex), 14, 'Tex = gram chỉ trên 1.000 m');
  assert.equal(r.flag, null, 'mỗi cuộn thừa ≈ 2,86 triệu mm < 5 triệu: hợp lý');
});

test('convertWeight: cờ đỏ khi cuộn thừa dài hơn cuộn nguyên, gần nguyên khi ≥ 99,5%', () => {
  const bad = CORE.convertWeight({ specMm: 5000000, total: 10, unit: 'kg', cones: 10, coreG: 50, fullG: 120, fullIncludesCore: true });
  assert.equal(bad.ok, true);
  assert.equal(bad.flag, 'impossible');
  const full = CORE.convertWeight({ specMm: 5000000, total: 1200, unit: 'g', cones: 10, coreG: 50, fullG: 120, fullIncludesCore: true });
  assert.equal(full.flag, 'nearly_full');
  assert.equal(full.mm, 50000000);
});

test('convertWeight: "chỉ riêng chỉ" không trừ lõi ở cuộn nguyên; thiếu ô hoặc số vô lý thì ok=false', () => {
  const r = CORE.convertWeight({ specMm: 5000000, total: 3, unit: 'kg', cones: 10, coreG: 50, fullG: 70, fullIncludesCore: false });
  assert.equal(r.fullThreadG, 70);
  assert.deepEqual(CORE.convertWeight({ specMm: 0, total: 3, unit: 'kg', cones: 10, coreG: 50, fullG: 120 }).missing, ['quy cách cuộn nguyên', 'khối lượng cuộn nguyên hoặc chỉ số Tex']);
  assert.match(CORE.convertWeight({ specMm: 5000000, total: 3, unit: 'kg', cones: 10, coreG: 130, fullG: 120, fullIncludesCore: true }).reason, /phần chỉ còn ≤ 0/);
  assert.match(CORE.convertWeight({ specMm: 5000000, total: 0.4, unit: 'kg', cones: 10, coreG: 50, fullG: 120, fullIncludesCore: true }).reason, /không còn chỉ nào/);
});

test('convertWeight: tính theo Tex khi không cân cuộn nguyên; cân cuộn nguyên luôn được ưu tiên', () => {
  const tex = CORE.convertWeight({ specMm: 5000000, total: 10000, unit: 'g', cones: 10, coreG: 14, fullG: NaN, tex: 27 });
  assert.equal(tex.ok, true);
  assert.equal(tex.method, 'tex');
  assert.equal(tex.threadG, 9860);
  assert.equal(Math.round(tex.mmPerG), 37037);
  assert.equal(tex.mm, 365185185);
  const scale = CORE.convertWeight({ specMm: 5000000, total: 0.9, unit: 'kg', cones: 10, coreG: 50, fullG: 120, tex: 27, fullIncludesCore: true });
  assert.equal(scale.method, 'scale');
  assert.equal(scale.mm, Math.round(400 * 5000000 / 70));
  assert.ok(scale.differencePct > 5);
});

test('convertFabric: GSM × khổ hoặc cân cuộn nguyên; cân thật được ưu tiên', () => {
  const nominal = CORE.convertFabric({ total: 10, unit: 'kg', width: 150, widthUnit: 'cm', gsm: 200, rollLength: NaN, fullG: NaN });
  assert.equal(nominal.ok, true);
  assert.equal(nominal.method, 'gsm');
  assert.equal(nominal.gPerM, 300);
  assert.equal(nominal.mm, 33333);
  const scale = CORE.convertFabric({ total: 10, unit: 'kg', width: 150, widthUnit: 'cm', gsm: 200, rollLength: 100, rollUnit: 'm', fullG: 33000 });
  assert.equal(scale.method, 'scale');
  assert.equal(scale.gPerM, 330);
  assert.equal(scale.mm, 30303);
  assert.ok(scale.differencePct > 5);
});

test('đọc Tex, khổ vải/GSM và loại hàng từ tên SKU', () => {
  assert.equal(CORE.texFromName('Chỉ may/COATS/Text 27 - 60-3/mm'), 27);
  assert.equal(CORE.texFromName('Chỉ may/Tex 24/Cuộn 5000m'), 24);
  assert.equal(CORE.materialOf('Vải chính/Polyester/170GSM/W180cm/g'), 'fabric');
  assert.equal(CORE.materialOf('Chỉ may/Coats/Tex 27/mm'), 'thread');
  assert.deepEqual(CORE.fabricFromName('Vải dệt/170GSM/W180cm/g'), { gsm: 170, widthCm: 180, source: 'cm' });
  const ranged = CORE.fabricFromName('Vải mẫu/220gsm/58_60in/g');
  assert.equal(ranged.gsm, 220);
  assert.equal(Number(ranged.widthCm.toFixed(2)), 149.86);
});

test('unitOf lấy ô cuối tên SKU, bỏ dấu', () => {
  assert.deepEqual(CORE.unitOf('Chỉ may/None/None/Roman TX0144/Be/None/5000m/mm'), { raw: 'mm', key: 'mm', isLength: true });
  assert.equal(CORE.unitOf('Nút bấm/T09/POM/none/Dark Blue/none/9mm/pcs').key, 'pcs');
  assert.equal(CORE.unitOf('(Combo) Chỉ may/Roman/Be/5000m/cuộn').key, 'cuon');
  assert.equal(CORE.unitOf('Dây luồn/81T/None/Navy/Size 140cm/8mm/Sợi').key, 'soi');
  assert.equal(CORE.unitOf('').key, '');
});

test('specFromName đọc quy cách cuộn nguyên, không bắt nhầm cm/mm/gsm', () => {
  assert.equal(CORE.specFromName('Chỉ may/Roman TX0144/Be/None/5000m/mm'), 5000000);
  assert.equal(CORE.specFromName('Chỉ astra/QZ3966_Brand/Polyester/None/Red/None/Text 27-60-3-Tkt 120/Cuộn 3.000M'), 3000000);
  assert.equal(CORE.specFromName('Chỉ mẫu/VP41779435_Coats/Cometa/None/dark grey/none/Tex 27-tkt120/Mét 5000'), 5000000);
  assert.equal(CORE.specFromName('Vải Rib/TN109/93% Cotton/260gsm-130cm/Xanh/g'), null);
  assert.equal(CORE.specFromName('Nút bấm/T09/POM/none/Dark Blue/none/9mm/pcs'), null);
});

test('frameStats: ảnh phẳng không nét, ảnh có cạnh nét hơn; đứng yên thì motion ≈ 0', () => {
  const w = 8, h = 6;
  const flat = new Uint8Array(w * h).fill(120);
  const edges = new Uint8Array(w * h).map((_, i) => ((i % w) < 4 ? 20 : 220));
  assert.equal(CORE.frameStats(flat, null, w, h).sharp, 0);
  assert.ok(CORE.frameStats(edges, null, w, h).sharp > 30);
  assert.equal(CORE.frameStats(flat, flat, w, h).motion, 0);
  assert.ok(CORE.frameStats(edges, flat, w, h).motion > 50);
  assert.equal(CORE.frameStats(flat, null, w, h).motion, 255, 'chưa có khung trước thì coi như đang động');
});

test('createAutoCapture: chụp khi yên + nét, phải di chuyển rồi yên lại mới chụp tiếp, tối đa 3 lần', () => {
  const auto = CORE.createAutoCapture({ stableMs: 600, maxAttempts: 3, cooldownMs: 0 });
  const still = { sharp: 12, motion: 1 }, moving = { sharp: 12, motion: 30 }, blur = { sharp: 2, motion: 1 };
  let t = 0;
  assert.equal(auto.feed(still, t), null, 'vừa yên chưa đủ lâu');
  assert.equal(auto.feed(still, t += 400), null);
  assert.equal(auto.feed(still, t += 300), 'capture', 'yên 700 ms và nét thì chụp');
  assert.equal(auto.feed(still, t += 1000), null, 'cùng khung hình đứng yên thì không chụp lại');
  assert.equal(auto.feed(moving, t += 200), null);
  assert.equal(auto.feed(still, t += 200), null);
  assert.equal(auto.feed(blur, t += 700), null, 'mờ hơn hẳn khung nét nhất thì chưa chụp');
  assert.equal(auto.feed(still, t += 100), 'capture');
  assert.equal(auto.remaining(), 1);
  auto.feed(moving, t += 100);
  auto.feed(still, t += 100);
  assert.equal(auto.feed(still, t += 700), 'capture');
  assert.equal(auto.exhausted(), true);
  auto.feed(moving, t += 100); auto.feed(still, t += 100);
  assert.equal(auto.feed(still, t += 700), null, 'hết 3 lần thì dừng');
});

test('createAutoCapture: finish() khoá lại sau khi đã khớp SKU', () => {
  const auto = CORE.createAutoCapture({ stableMs: 0, cooldownMs: 0 });
  auto.finish();
  assert.equal(auto.feed({ sharp: 50, motion: 0 }, 1000), null);
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (error) { failed++; console.log(`not ok - ${name}\n  ${error.message}`); }
}
console.log(`\n${cases.length - failed}/${cases.length} đạt`);
process.exitCode = failed ? 1 : 0;
