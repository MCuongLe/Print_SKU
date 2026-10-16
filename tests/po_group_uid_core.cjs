// Kiểm tra bộ đọc Group UID / ASN theo PO của Extension (group-uid-sync-core.js): dữ liệu giả có đúng hình dạng phản hồi
// WMS đã dò 16/10/2026. Không cần trình duyệt.   node tests/po_group_uid_core.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { globalThis: {} };
vm.runInNewContext(fs.readFileSync('extension/inside-po-connector/group-uid-sync-core.js', 'utf8'), context);
const core = context.globalThis.HasakiGroupUidSyncCore;
const plain = value => JSON.parse(JSON.stringify(value));
const PO = '10012600000001';

// group_uid_code là SỐ (không phải chuỗi) trong phản hồi thật.
const uid = (code, over = {}) => ({
  id: 1, group_uid_code: code, group_uid_type: 2, warehouse_id: 1177, location_description: 'F0-BAIXE-PL-00-00-01', status_id: 2,
  warehouse_name: 'WH - MATERIAL - MTG', status_name: 'Available', uid_quantity: 70000, processing_source_code: PO, processing_source_type: 'PURCHASE_ORDER',
  batch_code: '1/12', roll_code: '4-1', updated_by_name: 'api@hasaki.vn', updated_at_tz: '2026-10-15T18:50:51+07:00',
  products: [{ product_id: 1, sku: '422494672', product_name: 'Vải woven', quantity: 70000 }], ...over
});

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('đọc dòng Group UID của PO: mã số → chuỗi, Lot, Roll, SKU Normal, số lượng, PO nguồn', () => {
  const out = core.normalizePoGroupUidPage({ count: 323, records: [uid(1028261015000611)] }, PO);
  assert.equal(out.total, 323);
  assert.equal(out.sourceRows, 1);
  assert.deepEqual(plain(out.rows[0]), {
    group_uid_code: '1028261015000611', batch_code: '1/12', roll_code: '4-1', warehouse: 'WH - MATERIAL - MTG', location: 'F0-BAIXE-PL-00-00-01',
    sku: '422494672', qty: 70000, updated_by: 'api@hasaki.vn', updated_date: '2026-10-15T11:50:51.000Z', status: 'Available',
    products: [{ sku: '422494672', quantity: 70000, product_name: 'Vải woven' }], purchase_order: PO, source_type: 'PURCHASE_ORDER'
  });
});

test('WMS bỏ qua bộ lọc (trả UID của PO khác) thì báo lỗi, không trộn dữ liệu', () => {
  const rows = [uid(1028261015000611), uid(1028261015000612, { processing_source_code: '10012699999999' })];
  assert.throws(() => core.normalizePoGroupUidPage({ count: 2, records: rows }, PO), /thuộc nguồn "10012699999999", không phải PO 10012600000001/);
  assert.throws(() => core.normalizePoGroupUidPage({ count: 1, records: [uid(1028261015000613, { processing_source_code: null })] }, PO), /thuộc nguồn "trống"/);
});

test('UID chưa nhận (không SKU) và UID nhiều SKU vẫn trả về để ứng dụng tự loại; trùng mã giữ một dòng', () => {
  const none = uid(1028261015000620, { status_name: 'New', uid_quantity: 0, products: [], batch_code: null, roll_code: null });
  const multi = uid(1028261015000621, { uid_quantity: 100, products: [{ sku: 'A1', quantity: 40 }, { sku: 'B2', quantity: 60 }] });
  const out = core.normalizePoGroupUidPage({ count: 4, records: [none, multi, uid(1028261015000622), uid(1028261015000622, { uid_quantity: 71000 })] }, PO);
  assert.equal(out.rows.length, 3);
  assert.equal(out.sourceRows, 4);
  const byCode = Object.fromEntries(out.rows.map(row => [row.group_uid_code, row]));
  assert.deepEqual([byCode['1028261015000620'].sku, byCode['1028261015000620'].qty, byCode['1028261015000620'].batch_code], [null, 0, null]);
  assert.equal(byCode['1028261015000621'].sku, null, 'nhiều SKU: sku trống, ứng dụng loại');
  assert.equal(byCode['1028261015000622'].qty, 71000, 'trùng mã: giữ dòng sau');
});

test('dòng sai dữ liệu nguồn bị chặn: mã không phải số, thiếu trạng thái, số lượng âm; số lượng trống đọc là 0', () => {
  assert.throws(() => core.normalizePoGroupUidPage({ records: [uid('ABC123')] }, PO), /Group UID không hợp lệ/);
  assert.throws(() => core.normalizePoGroupUidPage({ records: [uid(1028261015000630, { status_name: '' })] }, PO), /thiếu trạng thái/);
  assert.throws(() => core.normalizePoGroupUidPage({ records: [uid(1028261015000631, { uid_quantity: -5, products: [] })] }, PO), /số lượng không hợp lệ/);
  // Số lượng trống/hỏng được bộ đọc chung (normalizeRow, dùng cả cho đồng bộ) đọc thành 0, không báo lỗi: ứng dụng loại UID qty ≤ 0.
  for (const bad of ['abc', '', null]) {
    assert.equal(core.normalizePoGroupUidPage({ records: [uid(1028261015000632, { uid_quantity: bad, products: [] })] }, PO).rows[0].qty, 0);
  }
});

const asn = (id, over = {}) => ({
  asn_id: id, asn_number: `10022610150${id}`, asn_type: 'PURCHASE_ORDER', status_name: 'Received', inbound_shmt_number: '1001260618081586',
  purchase_order_number: PO, warehouse_name: 'WH - MATERIAL - MTG', created_at_tz: '2026-10-15T18:51:03+07:00', ...over
});

test('đọc các ASN của PO: số, loại, trạng thái Received/Open, chuyến hàng, giờ tạo', () => {
  const out = core.normalizePoAsnPage({ count: 2, records: [asn(60611), asn(35563, { status_name: 'Open', created_at_tz: '2026-10-15T14:05:23+07:00' })] }, PO);
  assert.equal(out.total, 2);
  assert.deepEqual(plain(out.rows[0]), {
    asn_id: 60611, asn_number: '1002261015060611', type: 'PURCHASE_ORDER', status: 'Received', shipment: '1001260618081586',
    warehouse: 'WH - MATERIAL - MTG', created_at: '2026-10-15T11:51:03.000Z'
  });
  assert.equal(out.rows[1].status, 'Open');
});

test('ASN của PO khác hoặc dòng hỏng thì báo lỗi', () => {
  assert.throws(() => core.normalizePoAsnPage({ records: [asn(60611, { purchase_order_number: '10012699999999' })] }, PO), /không phải PO/);
  assert.throws(() => core.normalizePoAsnPage({ records: [asn(60611, { asn_number: 'x' })] }, PO), /ASN dòng 1 không hợp lệ/);
  assert.throws(() => core.normalizePoAsnPage({ records: [asn(0)] }, PO), /không hợp lệ/);
  assert.deepEqual(plain(core.normalizePoAsnPage({ count: 0, records: [] }, PO)), { rows: [], total: 0, sourceRows: 0 });
});

let failed = 0;
for (const [name, fn] of cases) {
  try { fn(); console.log(`PASS ${name}`); } catch (error) { failed += 1; console.error(`FAIL ${name}\n${error.stack}`); }
}
if (failed) { console.error(`${failed}/${cases.length} test lỗi`); process.exitCode = 1; } else console.log(`PASS PO Group UID core: ${cases.length} nhóm kiểm tra`);
