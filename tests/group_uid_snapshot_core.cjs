// Bộ đọc ảnh chụp Group UID (extension/inside-po-connector/group-uid-snapshot-core.js) — quy tắc giống readWmsSnapshot của index.html.
//   node tests/group_uid_snapshot_core.cjs
const assert = require("node:assert/strict");
const { readGroupUidSnapshot } = require("../extension/inside-po-connector/group-uid-snapshot-core.js");

const uid = index => ({ group_uid_code: String(1028260000000000 + index), updated_date: "2026-10-17T01:00:00.000Z", qty: 1, status: "New" });
// WMS giả: danh sách xếp theo id giảm dần (UID mới ở đầu); hook chạy trước mỗi lần đọc trang để mô phỏng api-clinic.
function fakeWms(count, { hook, totalOffset = () => 0, totalPagesOf } = {}) {
  const list = Array.from({ length: count }, (_, index) => uid(count - index));
  const calls = [];
  const readPage = async params => {
    calls.push(params);
    if (hook) hook(list, params, calls.length);
    const size = params.size, total = list.length + totalOffset(calls.length);
    return { page: params.page, size, total, totalPages: totalPagesOf ? totalPagesOf(params, calls.length) : Math.max(1, Math.ceil(total / size)), rows: list.slice((params.page - 1) * size, params.page * size) };
  };
  return { list, calls, readPage };
}
const noSleep = { sleep: async () => {} };

(async () => {
  // 1. Toàn bộ, dữ liệu đứng yên: đọc đủ 3 trang, không lặp.
  {
    const wms = fakeWms(1203);
    const result = await readGroupUidSnapshot({ full: true, readPage: wms.readPage, ...noSleep });
    assert.equal(result.total, 1203);
    assert.equal(result.rows.length, 1203);
    assert.equal(result.pages, 3);
    assert.ok(wms.calls.every(params => params.from === undefined && params.to === undefined), "toàn bộ không gửi from/to");
  }

  // 2. api-clinic chèn 1 UID sau khi đọc trang 1: trang sau bị đẩy xuống (lặp UID cuối trang 1), đọc lại đầu danh sách thì khớp.
  {
    let inserted = false;
    const wms = fakeWms(1203, { hook: (list, params, n) => { if (n === 2 && !inserted) { inserted = true; list.unshift(uid(5000)); } } });
    const progress = [];
    const result = await readGroupUidSnapshot({ full: true, readPage: wms.readPage, onProgress: item => progress.push(item.page), ...noSleep });
    assert.equal(result.total, 1204);
    assert.equal(new Set(result.rows.map(row => row.group_uid_code)).size, 1204, "không sót, không trùng");
    assert.ok(result.rows.some(row => row.group_uid_code === uid(5000).group_uid_code), "UID mới được đọc ở vòng đọc lại đầu danh sách");
    assert.deepEqual(progress, [1, 3]);
  }

  // 3. Tổng WMS lệch mãi (nhiều hơn số UID duy nhất): 3 lần × (đọc hết + 5 vòng đầu danh sách) rồi ném lỗi, nghỉ giữa các lần.
  {
    const slept = [];
    const wms = fakeWms(600, { totalOffset: () => 3 });
    await assert.rejects(
      readGroupUidSnapshot({ full: true, readPage: wms.readPage, sleep: async ms => slept.push(ms) }),
      /^Error: WMS đổi dữ liệu trong lúc đọc \(tổng 603 · 600 UID duy nhất\); phiên đã dừng để tránh thiếu UID$/,
    );
    assert.deepEqual(slept, [1500, 1500]);
    assert.equal(wms.calls.length, 3 * (2 + 5));
  }

  // 4. Gia tăng: lần 1 một trang báo totalPages khác → đọc lại với to = bây giờ; lần 2 ổn định thì trả kết quả.
  {
    const wms = fakeWms(900, { totalPagesOf: (params, n) => (n === 2 ? 3 : 2) });
    const result = await readGroupUidSnapshot({
      full: false, rangeFrom: "2026-10-17T00:00:00.000Z", rangeTo: "2026-10-17T01:00:00.000Z", readPage: wms.readPage,
      now: () => "2026-10-17T01:05:00.000Z", ...noSleep,
    });
    assert.equal(result.total, 900);
    assert.equal(result.rows.length, 900);
    assert.deepEqual(wms.calls.map(params => [params.page, params.to]), [
      [1, "2026-10-17T01:00:00.000Z"], [2, "2026-10-17T01:00:00.000Z"],
      [1, "2026-10-17T01:05:00.000Z"], [2, "2026-10-17T01:05:00.000Z"],
    ]);
    assert.ok(wms.calls.every(params => params.from === "2026-10-17T00:00:00.000Z" && params.size === 500));
  }

  // 4b. Gia tăng, đồng hồ máy chậm hơn rangeTo của Edge: lần đọc lại vẫn dùng to = rangeTo (không lùi cận trên).
  {
    const wms = fakeWms(900, { totalPagesOf: (params, n) => (n === 2 ? 3 : 2) });
    const result = await readGroupUidSnapshot({
      full: false, rangeFrom: "2026-10-17T00:00:00.000Z", rangeTo: "2026-10-17T01:00:00.000Z", readPage: wms.readPage,
      now: () => "2026-10-17T00:00:00.000Z", ...noSleep,
    });
    assert.equal(result.total, 900);
    assert.equal(wms.calls.length, 4, "lần 1 lệch, lần 2 đọc lại");
    assert.ok(wms.calls.every(params => params.to === "2026-10-17T01:00:00.000Z"), "to luôn = rangeTo khi máy chậm");
  }

  // 5. Gia tăng: UID rơi khỏi khung làm trang dịch lên (sót mà tổng vẫn khớp) cả 3 lần → ném lỗi.
  {
    const wms = fakeWms(700, { hook: (list, params) => { if (params.page === 2) list.splice(0, 1); } });
    await assert.rejects(
      readGroupUidSnapshot({ full: false, rangeFrom: "2026-10-17T00:00:00.000Z", rangeTo: "2026-10-17T01:00:00.000Z", readPage: wms.readPage, ...noSleep }),
      /WMS đổi dữ liệu trong lúc đọc/,
    );
  }

  // 6. Trang sai kiểu (Extension/WMS trả rác) → lỗi rõ ràng, không đưa lên Supabase.
  await assert.rejects(readGroupUidSnapshot({ full: true, readPage: async () => ({ rows: null, total: 1, totalPages: 1 }), ...noSleep }), /trang Group UID 1 không hợp lệ/);
  await assert.rejects(readGroupUidSnapshot({ full: true }), /Thiếu hàm đọc trang WMS/);

  console.log("group_uid_snapshot_core: full/incremental drift rules passed");
})().catch(error => { console.error(error); process.exit(1); });
