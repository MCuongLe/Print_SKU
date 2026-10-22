const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("extension/inside-po-connector/group-uid-sync-core.js", "utf8");
const context = { globalThis: null, String, Number, Date, Array, Map, Object, RegExp, Error };
context.globalThis = context;
vm.runInNewContext(source, context);
const core = context.HasakiGroupUidSyncCore;

const raw = {
  group_uid_code: "1028260000000050", batch_code: "1", roll_code: "1",
  warehouse_name: "WH - MATERIAL - MTG", location_description: "F0-KHO-HM-04-01-01",
  status_name: "Available", quality_control_status_name: "Passed", group_rfid_mapping: " a00000000001 ", updated_by_name: "user@example.invalid",
  updated_at_tz: "2026-10-07T08:41:57+07:00", uid_quantity: 7429,
  products: [{ sku: "900000002", quantity: 7429 }],
};
const row = JSON.parse(JSON.stringify(core.normalizeRow(raw)));
assert.deepEqual(row, {
  group_uid_code: "1028260000000050", batch_code: "1", roll_code: "1",
  warehouse: "WH - MATERIAL - MTG", location: "F0-KHO-HM-04-01-01", sku: "900000002",
  qty: 7429, updated_by: "user@example.invalid", updated_date: "2026-10-07T01:41:57.000Z", status: "Available", qc_status: "Passed",
  group_rfid_mapping: "A00000000001",
  products: [{ sku: "900000002", quantity: 7429, product_name: null }],
});

const page = core.normalizePage({ data: { items: [raw, { ...raw, status_name: "Allocated", updated_at_tz: "2026-10-07T09:00:00+07:00" }], total: 28468 } });
assert.equal(page.total, 28468);
assert.equal(page.rows.length, 1);
assert.equal(page.rows[0].status, "Allocated");

const actualWmsShape = core.normalizePage({
  page: 1,
  size: 500,
  count: 28608,
  records: [raw, {
    group_uid_code: "1028260000000140",
    warehouse_name: "WH - MATERIAL - MTG",
    status_name: "New",
    updated_at_tz: "2026-10-08T08:02:01+07:00",
  }],
});
assert.equal(actualWmsShape.total, 28608);
// 22/10/2026: WMS có mã Group UID mang 2 bản ghi (id khác nhau, cùng Canceled) và đếm tổng theo bản ghi → trang trả id bản ghi
// để bộ đọc ảnh chụp đối chiếu tổng theo bản ghi; dòng vẫn gộp theo mã (giữ bản mới nhất).
const twoRecords = core.normalizePage({ count: 3, records: [{ ...raw, id: 39740 }, { ...raw, id: 39735, updated_at_tz: "2026-10-07T08:00:00+07:00" }, { ...raw, id: 39001, group_uid_code: "1028260000000051" }] });
assert.equal(twoRecords.rows.length, 2, "gộp theo mã");
assert.deepEqual(JSON.parse(JSON.stringify(twoRecords.ids)), [39740, 39735, 39001], "id bản ghi WMS theo thứ tự trang");
assert.equal(core.normalizePage({ count: 1, records: [raw] }).ids, null, "WMS không trả id → null (bộ đọc dùng số mã như cũ)");
// 0.10.6 (review Codex 22/10): id bản ghi gắn với từng dòng (rowIds cùng thứ tự rows) và mã của từng id (codes cùng thứ tự ids);
// cùng mã cùng updated_at thì giữ bản ghi id LỚN hơn (WMS xếp id giảm dần nên bản id nhỏ đến sau không được đè).
assert.deepEqual(JSON.parse(JSON.stringify(twoRecords.rowIds)), [39740, 39001], "rowIds = id của dòng được giữ");
assert.deepEqual(JSON.parse(JSON.stringify(twoRecords.codes)), ["1028260000000050", "1028260000000050", "1028260000000051"]);
const tie = core.normalizePage({ count: 2, records: [{ ...raw, id: 39740, status_name: "Canceled" }, { ...raw, id: 39735, status_name: "Available" }] });
assert.equal(tie.rows[0].status, "Canceled", "cùng giờ: giữ id lớn hơn");
assert.deepEqual(JSON.parse(JSON.stringify(tie.rowIds)), [39740]);
const tieUp = core.normalizePage({ count: 2, records: [{ ...raw, id: 39735, status_name: "Available" }, { ...raw, id: 39740, status_name: "Canceled" }] });
assert.equal(tieUp.rows[0].status, "Canceled", "cùng giờ, id lớn đến sau: vẫn giữ id lớn");
assert.ok(!("rowIds" in tie.rows[0]) && !("id" in tie.rows[0]), "dòng gửi Edge không thêm khoá");
assert.equal(core.normalizePage({ count: 1, records: [raw] }).rowIds, null);
assert.equal(actualWmsShape.rows.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(actualWmsShape.rows[1])), {
  group_uid_code: "1028260000000140",
  batch_code: null,
  roll_code: null,
  warehouse: "WH - MATERIAL - MTG",
  location: null,
  sku: null,
  qty: 0,
  updated_by: null,
  updated_date: "2026-10-08T01:02:01.000Z",
  status: "New",
  qc_status: null,
  group_rfid_mapping: null,
  products: [],
});
const multiSku = JSON.parse(JSON.stringify(core.normalizeRow({
  ...raw,
  group_uid_code: "1028260000000067",
  uid_quantity: 44,
  products: [
    { sku: "900000008", quantity: 7, product_name: "Panty XL" },
    { sku: "900000004", quantity: 7, product_name: "Panty M" },
    { sku: "900000005", quantity: 3, product_name: "Panty L" },
    { sku: "900000006", quantity: 10, product_name: "Panty M Blue" },
    { sku: "900000007", quantity: 17, product_name: "Panty L Blue" },
  ],
})));
assert.equal(multiSku.sku, null);
assert.equal(multiSku.qty, 44);
assert.equal(multiSku.products.length, 5);
assert.equal(multiSku.products.reduce((sum, item) => sum + item.quantity, 0), 44);
assert.throws(() => core.normalizeRow({ ...raw, updated_at_tz: "sai-ngày" }), /Ngày cập nhật/);
// RFID (group_rfid_mapping, 20/10/2026): WMS chỉ có khoá khi UID đã gắn tem RFID. Ba trạng thái (Codex 20/10): chuỗi 1–40
// chữ/số → viết hoa; thiếu / null / rỗng → null (chưa gắn hoặc WMS gỡ → xoá theo); có giá trị nhưng SAI dạng → khoá bị bỏ khi
// gửi (JSON) → Edge "không biết" → giữ RFID đang lưu, không xoá nhầm.
const rfidOf = value => core.normalizeRow({ ...raw, group_rfid_mapping: value }).group_rfid_mapping;
const sentKeys = value => Object.keys(JSON.parse(JSON.stringify(core.normalizeRow({ ...raw, group_rfid_mapping: value }))));
assert.equal(rfidOf("B00000000002"), "B00000000002");
for (const gone of ["", "   ", null, undefined]) {
  assert.equal(rfidOf(gone), null, `RFID ${JSON.stringify(gone)} = chưa gắn → null`);
  assert.ok(sentKeys(gone).includes("group_rfid_mapping"), "null vẫn gửi khoá (Edge biết là đã gỡ)");
}
for (const bad of ["A-0001", "A0000 0000001", "Ã00000000001", "A".repeat(41), ["A00000000001"], 12345, { code: "A00000000001" }]) {
  assert.equal(sentKeys(bad).includes("group_rfid_mapping"), false, `RFID sai dạng ${JSON.stringify(bad)} → bỏ khoá khi gửi (không xoá nhầm)`);
}
assert.equal(rfidOf("A".repeat(40)), "A".repeat(40), "đúng 40 ký tự vẫn nhận");
// Số PO nguồn (21/10/2026, lọc theo PO ở CẮT GROUP UID): WMS processing_source_type = PURCHASE_ORDER (không phân biệt hoa thường)
// thì processing_source_code là số PO (đo 21/10: 14 chữ số). Có loại nguồn khác (kiểm kê, phiếu IT) → null (gửi khoá, Edge ghi
// là không có PO). Không chắc → bỏ khoá khi gửi → Edge "không biết", giữ PO đang lưu (review 21/10): thiếu khoá loại nguồn,
// loại nguồn rỗng, PURCHASE_ORDER mà mã trống / sai dạng / số không an toàn.
const poRow = (type, code) => JSON.parse(JSON.stringify(core.normalizeRow({ ...raw, processing_source_type: type, processing_source_code: code })));
assert.equal(poRow("PURCHASE_ORDER", " 100000001 ").purchase_order, "100000001");
assert.equal(poRow("PURCHASE_ORDER", 100000001).purchase_order, "100000001", "WMS trả số vẫn nhận");
assert.equal(poRow(" purchase_order ", "100000001").purchase_order, "100000001", "loại nguồn không phân biệt hoa thường");
assert.equal("purchase_order" in JSON.parse(JSON.stringify(core.normalizeRow(raw))), false, "thiếu khoá loại nguồn → không biết (bỏ khoá)");
for (const [type, code] of [[undefined, undefined], [null, null], ["", "100000001"], ["PURCHASE_ORDER", ""], ["PURCHASE_ORDER", null], ["PURCHASE_ORDER", undefined]]) {
  assert.equal("purchase_order" in poRow(type, code), false, `nguồn ${type}/${code} chưa chắc → bỏ khoá (giữ PO cũ)`);
}
for (const [type, code] of [["WMS_COUNTING_PLAN", "100001"], ["INTERNAL_TRANSFER", "100000002"], ["INTERNAL_TRANSFER", null]]) {
  const sent = poRow(type, code);
  assert.ok("purchase_order" in sent, `nguồn ${type}/${code} vẫn gửi khoá`);
  assert.equal(sent.purchase_order, null, `nguồn ${type}/${code} → không có PO`);
}
for (const bad of ["PO-1", "12345", "1".repeat(41), "10001 2345678", ["100000001"], 10012608011632991, -100000001, 1000000.5]) {
  assert.equal("purchase_order" in poRow("PURCHASE_ORDER", bad), false, `PO sai dạng ${JSON.stringify(bad)} → bỏ khoá (không xoá nhầm)`);
}
// 0.10.7 (soát 22/10, G13): WMS đổi khoá danh sách → trước đây ra 0 dòng + tổng 0 mà vẫn "đủ" (gia tăng bỏ sót im lặng). Nay ném lỗi.
assert.throws(() => core.normalizePage({ data: { list: [raw] }, total: 1 }), /WMS đổi dạng dữ liệu Group UID/);
assert.throws(() => core.normalizePage({ count: 0 }), /WMS đổi dạng dữ liệu Group UID/);
assert.equal(core.normalizePage({ count: 0, page: 1, size: 500, records: [] }).rows.length, 0, "204 (WMS không có dòng) vẫn hợp lệ");
assert.equal(core.normalizePage({ data: { items: [], total: 0 } }).total, 0, "danh sách rỗng đúng khoá vẫn hợp lệ");
console.log("group_uid_sync_extension: ok");
