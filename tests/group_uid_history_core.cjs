const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('extension/inside-po-connector/group-uid-sync-core.js', 'utf8');
const context = { globalThis: {} };
vm.runInNewContext(source, context);
const core = context.globalThis.HasakiGroupUidSyncCore;

const payload = { data: { count: 3, records: [
  { group_uid_code: '1028260414000214', warehouse_name: 'WH - MATERIAL - MTG', sku: '422292719', quantity: 12000, note: 'Cut 12000 out of group 1028260414000214 (remaining 68000)', updated_by_name: 'user@example.test', updated_at_tz: '2026-10-08T13:47:00+07:00' },
  { group_uid_code: '1028260120000096', warehouse_name: 'WH - MATERIAL - MTG', sku: '422376718', quantity: 1000, note: 'Cut 1000 out of group 1028260120000096 (remaining 96600)', updated_by_name: 'user@example.test', updated_at_tz: '2026-10-08T11:20:00+07:00' },
  { group_uid_code: '1028260925000113', warehouse_name: 'WH - MATERIAL - MTG', quantity: 0, note: null, updated_at_tz: '2026-10-08T10:39:00+07:00' },
] } };

const result = core.normalizeHistoryPage(payload);
assert.equal(result.total, 3);
assert.equal(result.sourceRows, 3);
assert.equal(result.rows.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(result.rows[0])), {
  group_uid_code: '1028260414000214', cut_at: '2026-10-08T06:47:00.000Z', qty: 12000,
  remaining_qty: 68000, sku: '422292719', cut_by: 'user@example.test', warehouse: 'WH - MATERIAL - MTG'
});
assert.equal(result.rangeFrom, '2026-10-08T03:39:00.000Z');
assert.equal(result.rangeTo, '2026-10-08T06:47:00.000Z');

assert.throws(() => core.normalizeHistoryPage({ records: [{
  group_uid_code: '1028260414000214', note: 'Cut unknown', updated_at: '2026-10-08T13:47:00+07:00'
}] }), /ghi chú Cut không hợp lệ/);

assert.throws(() => core.normalizeHistoryPage({ records: [{
  group_uid_code: '1028260414000999', note: 'Cut 1 out of group 1028260414000214 (remaining 2)', updated_at: '2026-10-08T13:47:00+07:00'
}] }), /mã Cut không khớp/);

console.log('PASS Group UID history core: lọc Cut, chuẩn hóa số lượng/ngày, chặn dữ liệu nguồn sai');
