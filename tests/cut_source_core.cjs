// Nguồn phiếu từng lần Cut (extension/inside-po-connector/cut-source-core.js, 26/10/2026; kế hoạch
// docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md việc 1): ghép Cut ↔ dòng XUẤT phiếu ADJ / IT của Import/Export theo SKU + tổng
// số lượng + giờ, rồi luồng gán nguồn (Cut chưa nguồn → Import/Export → số phiếu → wms_group_uid_cut_set_source).
// Dữ liệu giả: SKU 9000000xx, UID 1028260000000xxx, mã phiếu / mapping giả.
//   node tests/cut_source_core.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const core = require("../extension/inside-po-connector/cut-source-core.js");
const { matchCutsToDocs, assignSources } = core;

const MIN = 60000, DAY = 86400000;
// Giờ VN ngày (10 + d)/10/2026
const at = (d, h, m, s = 0) => Date.UTC(2026, 9, 10 + d, h - 7, m, s);
let seq = 0;
const cut = (sku, qty, time) => ({ code: String(1028260000000000 + (++seq)), sku, qty, at: time });
const doc = (type, sku, qty, time, mapping = "") => ({ type, sku, qty, at: time, mapping });
const owners = (cuts, docs) => matchCutsToDocs(cuts, docs).map(found => (found ? docs.indexOf(found) : null));

// ---------- matchCutsToDocs ----------
{
  // 22 Cut liền kề × 1.000 = 1 phiếu ADJ 22.000 (Cut cũ hơn chưa ghép không làm hỏng dãy cuối)
  const old = cut("900000011", 1000, at(0, 8, 0));
  const batch = Array.from({ length: 22 }, (_, i) => cut("900000011", 1000, at(1, 8, i)));
  const docs = [doc("ADJ", "900000011", 22000, at(1, 8, 30))];
  assert.deepEqual(owners([old, ...batch], docs), [null, ...batch.map(() => 0)], "22 Cut liền kề = 1 ADJ");
}
{
  // 1 Cut = 1 IT (trễ 11 phút)
  const cuts = [cut("900000012", 5, at(1, 9, 0))];
  assert.deepEqual(owners(cuts, [doc("IT", "900000012", 5, at(1, 9, 11))]), [0], "1 Cut = 1 IT");
}
{
  // Mơ hồ: một Cut 1.000 khớp cả phiếu IT 1.000 lẫn phiếu ADJ 1.000 ngay sau → không gán
  const cuts = [cut("900000013", 1000, at(1, 10, 0))];
  const docs = [doc("IT", "900000013", 1000, at(1, 10, 3)), doc("ADJ", "900000013", 1000, at(1, 10, 5))];
  assert.deepEqual(owners(cuts, docs), [null], "IT và ADJ cùng khớp một Cut → Chưa rõ");
  // Hai phiếu ADJ 3.000 cách nhau 1 phút, 6 Cut × 1.000: không biết dãy nào thuộc phiếu nào → không gán
  const six = Array.from({ length: 6 }, (_, i) => cut("900000023", 1000, at(1, 9, 50 + i)));
  const two = [doc("ADJ", "900000023", 3000, at(1, 10, 0)), doc("ADJ", "900000023", 3000, at(1, 10, 1))];
  assert.deepEqual(owners(six, two), six.map(() => null), "hai phiếu cùng loại tranh nhau → Chưa rõ");
}
{
  // Cut sau giờ phiếu quá 2 phút → không gán; đúng 2 phút → vẫn gán (WMS ghi giờ phiếu và giờ Cut lệch vài giây)
  assert.deepEqual(owners([cut("900000014", 7, at(1, 11, 3))], [doc("IT", "900000014", 7, at(1, 11, 0))]), [null], "Cut sau giờ phiếu → null");
  assert.deepEqual(owners([cut("900000024", 8, at(1, 11, 2))], [doc("IT", "900000024", 8, at(1, 11, 0))]), [0], "Cut ≤ giờ phiếu + 2 phút vẫn gán");
}
{
  // IT trễ 4 ngày vẫn ghép: phiếu ADJ hôm sau lấy dãy 3 Cut × 1.000 trước, nên Cut 5 còn lại là Cut chưa gán cuối cùng trước phiếu IT
  const lone = cut("900000015", 5, at(0, 10, 0));
  const three = Array.from({ length: 3 }, (_, i) => cut("900000015", 1000, at(1, 9, i)));
  const docs = [doc("IT", "900000015", 5, at(4, 8, 0)), doc("ADJ", "900000015", 3000, at(1, 9, 10))];
  assert.deepEqual(owners([lone, ...three], docs), [0, 1, 1, 1], "IT trễ 4 ngày vẫn ghép, ADJ giữ dãy của nó");
}
{
  // Cut cách phiếu hơn 14 ngày → null; đúng 14 ngày → gán
  assert.deepEqual(owners([cut("900000016", 9, at(0, 8, 0))], [doc("IT", "900000016", 9, at(0, 8, 0) + 14 * DAY + MIN)]), [null], "> 14 ngày → null");
  assert.deepEqual(owners([cut("900000026", 9, at(0, 8, 0))], [doc("IT", "900000026", 9, at(0, 8, 0) + 14 * DAY)]), [0], "đúng 14 ngày → gán");
}
{
  // Hai SKU không lẫn: phiếu của SKU B không lấy Cut cùng số lượng của SKU A
  const a = cut("900000017", 10, at(1, 8, 0)), b = cut("900000018", 10, at(1, 8, 1));
  assert.deepEqual(owners([a, b], [doc("IT", "900000018", 10, at(1, 8, 5))]), [null, 0], "hai SKU không lẫn");
  assert.deepEqual(owners([a], [doc("IT", "900000019", 10, at(1, 8, 5))]), [null], "phiếu SKU khác không có Cut");
}
{
  // Dãy cuối không khớp thì thử dãy đầu
  const cuts = [cut("900000020", 4, at(1, 8, 0)), cut("900000020", 6, at(1, 8, 5)), cut("900000020", 2000, at(1, 8, 10))];
  assert.deepEqual(owners(cuts, [doc("ADJ", "900000020", 10, at(1, 8, 11))]), [0, 0, null], "dãy đầu khi dãy cuối vượt số lượng");
}
{
  // Mơ hồ một phần: phiếu IT 1.000 (sau) có thể là Cut cuối của dãy ADJ thay vì Cut lẻ còn lại → cả dãy ADJ lẫn Cut lẻ đều null.
  // Không ghi nửa dãy: lượt sau phiếu ADJ đã dùng bị bỏ qua, phiếu IT sẽ lấy đúng Cut đang tranh chấp (ghép sai).
  const spare = cut("900000021", 1000, at(1, 7, 0));
  const four = Array.from({ length: 4 }, (_, i) => cut("900000021", 1000, at(2, 9, i)));
  const docs = [doc("ADJ", "900000021", 4000, at(2, 9, 10)), doc("IT", "900000021", 1000, at(3, 9, 0))];
  assert.deepEqual(owners([spare, ...four], docs), [null, null, null, null, null], "dãy có Cut tranh chấp → cả dãy Chưa rõ");
  // Không có phiếu nào lấy được Cut của dãy khác → giữ (hai dãy ADJ khác ngày)
  const day1 = Array.from({ length: 3 }, (_, i) => cut("900000025", 1000, at(1, 9, i))), day2 = Array.from({ length: 2 }, (_, i) => cut("900000025", 1000, at(2, 9, i)));
  assert.deepEqual(owners([...day1, ...day2], [doc("ADJ", "900000025", 3000, at(1, 9, 10)), doc("ADJ", "900000025", 2000, at(2, 9, 10))]), [0, 0, 0, 1, 1], "hai dãy ADJ khác ngày không tranh chấp");
}
{
  // Dữ liệu hỏng không làm hỏng cả lượt; không đổi đầu vào; độ dài kết quả = số Cut
  const cuts = [cut("", 5, at(1, 8, 0)), cut("900000022", "abc", at(1, 8, 0)), cut("900000022", 0, at(1, 8, 0)), { sku: "900000022", qty: 5, at: "không phải ngày" }, cut("900000022", 5, at(1, 8, 1))];
  const docs = [doc("IT", "900000022", 5, at(1, 8, 2)), doc("XX", "900000022", 5, at(1, 8, 2)), doc("IT", "900000022", -5, at(1, 8, 2)), null];
  const before = JSON.stringify(cuts);
  assert.deepEqual(owners(cuts, docs), [null, null, null, null, 0]);
  assert.equal(JSON.stringify(cuts), before, "không đổi mảng đầu vào");
  assert.deepEqual(matchCutsToDocs(null, null), []);
  // Giờ dạng chuỗi ISO và giờ WMS không múi giờ (giờ VN)
  assert.deepEqual(owners([{ sku: "900000022", qty: 3, at: "2026-10-11T08:00:00+07:00" }], [doc("IT", "900000022", 3, "2026-10-11 08:01:00")]), [0]);
}
console.log("cut_source_core matchCutsToDocs: 22 Cut = 1 ADJ, 1 Cut = 1 IT, mơ hồ → null, Cut sau phiếu → null, IT trễ 4 ngày, > 14 ngày → null, hai SKU, dãy đầu: PASS");

// ---------- assignSources: luồng gán nguồn ----------
const ISO = ms => new Date(ms).toISOString();
const FIXED = at(16, 10, 0);
// Dòng Import/Export đã chuẩn hoá bởi wms-bridge (normalizeImportExportPage)
const move = (id, over) => ({ id, warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: "900000031", productName: "Vải giả", kind: "out", qty: 0, balance: null, sourceType: "ADJUSTMENT", sourceCode: `100426000000${String(id).padStart(4, "0")}`, mappingId: "", reason: "", fromWarehouse: "", toWarehouse: "", createdAt: "", createdBy: "", ...over });
function fakeWorld({ cuts, used = [], moves, info, pageSize = 2, failOn = null, truncated = false }) {
  const calls = [], rpcs = [];
  const sendTab = async (type, payload) => {
    calls.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    if (failOn === type) { const e = new Error("Phiên WMS đã hết hạn; hãy đăng nhập lại"); e.code = "WMS_AUTH"; e.reason = "session"; throw e; }
    if (type === "GET_STOCK_IMPORT_EXPORT_PAGE") {
      const inRange = moves.filter(m => Date.parse(m.createdAt) >= payload.from && Date.parse(m.createdAt) <= payload.to);
      const pages = Math.max(1, Math.ceil(inRange.length / pageSize)), rows = inRange.slice((payload.page - 1) * pageSize, payload.page * pageSize);
      // sourceRows = số dòng WMS trả ở trang (trước khi lọc), như inventory-audit-core normalizeImportExportPage
      return { rows, sourceRows: rows.length, total: inRange.length, totalPages: pages, page: payload.page, size: pageSize, warehouseIds: payload.warehouseIds };
    }
    if (type === "GET_WMS_DOC_INFO") {
      return { adj: payload.adj.filter(code => info.adj[code]).map(code => ({ mappingCode: code, ...info.adj[code] })), it: payload.it.filter(id => info.it[id]).map(id => ({ mappingId: id, ...info.it[id] })), generatedAt: ISO(FIXED) };
    }
    throw new Error(`lệnh lạ ${type}`);
  };
  const rpc = async (name, args) => {
    rpcs.push({ name, args: JSON.parse(JSON.stringify(args)) });
    if (name === "wms_group_uid_cut_unresolved") return { cuts, used, days: args.p_days, truncated };
    if (name === "wms_group_uid_cut_set_source") return { updated: args.p_rows.length, skipped: 0 };
    throw new Error(`rpc lạ ${name}`);
  };
  return { sendTab, rpc, calls, rpcs };
}

(async () => {
  // Đủ ba loại: dãy 2 Cut = ADJ Xuất test (có PO), 1 Cut = IT (kho nhận + mô tả), 1 Cut không phiếu → Chưa rõ, 1 phiếu đã dùng bị bỏ qua
  const cutRow = (code, qty, ms, sku = "900000031") => ({ groupUid: code, cutAt: ISO(ms).replace(".000Z", "+00:00"), qty, sku });
  const cuts = [
    cutRow("1028260000000101", 1000, at(14, 8, 0)),
    cutRow("1028260000000102", 1000, at(14, 8, 1)),
    cutRow("1028260000000103", 5, at(14, 9, 0)),
    cutRow("1028260000000104", 7, at(14, 9, 30)),
    cutRow("1028260000000105", 30, at(14, 11, 0), "900000032"),
  ];
  const moves = [
    move(1, { qty: 2000, createdAt: "2026-10-24T08:05:00+07:00", mappingId: "100052600000001", reason: "Xuất test" }),
    move(2, { qty: 5, sourceType: "INTERNAL_TRANSFER", createdAt: "2026-10-24T09:20:00+07:00", mappingId: "10022600000002" }),
    move(3, { qty: 30, sku: "900000032", createdAt: "2026-10-24T11:01:00+07:00", mappingId: "100052600000003", reason: "Xuất test" }), // phiếu đã dùng
    move(4, { qty: 7, kind: "in", createdAt: "2026-10-24T09:31:00+07:00", mappingId: "100052600000004" }), // dòng nhập: không phải phiếu xuất
    move(5, { qty: 7, sourceType: "PURCHASE_ORDER", createdAt: "2026-10-24T09:31:00+07:00" }),
    move(6, { qty: 7, warehouseId: 1178, sourceType: "INTERNAL_TRANSFER", createdAt: "2026-10-24T09:31:00+07:00", mappingId: "10022600000006" }), // kho khác
  ];
  const info = {
    adj: { "100052600000001": { number: "1008260000000001", reason: "Xuất test", po: "10012600000001" } },
    it: { "10022600000002": { number: "1007260000000002", toWarehouse: "WH - SEMI PRODUCT - TEST", description: "NPL may mẫu giả " + "x".repeat(300) } },
  };
  const used = [{ sku: "900000032", type: "ADJ", at: "2026-10-24T04:01:00+00:00" }];
  const w = fakeWorld({ cuts, used, moves, info });
  const progress = [];
  const result = await assignSources({ sendTab: w.sendTab, rpc: w.rpc, now: () => FIXED, onProgress: p => progress.push(p) });
  assert.deepEqual(w.rpcs[0], { name: "wms_group_uid_cut_unresolved", args: { p_days: 30 } }, "lấy Cut chưa có nguồn 30 ngày");
  const reads = w.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE");
  assert.deepEqual(reads.map(c => c.payload.page), [1, 2, 3], "đọc hết các trang Import/Export");
  assert.ok(reads.every(c => JSON.stringify(c.payload.warehouseIds) === "[1177]" && c.payload.size === 500 && c.payload.to === FIXED), "kho 1177, 500 dòng/trang, tới bây giờ");
  assert.equal(reads[0].payload.from, at(14, 8, 0) - DAY, "từ Cut chưa nguồn sớm nhất − 1 ngày (phiếu luôn sau Cut, tối đa 14 ngày)");
  const infoCalls = w.calls.filter(c => c.type === "GET_WMS_DOC_INFO");
  assert.deepEqual(infoCalls.map(c => c.payload), [{ adj: ["100052600000001"], it: ["10022600000002"] }], "chỉ tra số phiếu đã ghép, không tra phiếu đã dùng");
  const sets = w.rpcs.filter(r => r.name === "wms_group_uid_cut_set_source");
  assert.equal(sets.length, 1);
  const rows = sets[0].args.p_rows;
  assert.deepEqual(rows.map(r => [r.group_uid_code, r.source_type, r.source_code]), [
    ["1028260000000101", "ADJ", "1008260000000001"], ["1028260000000102", "ADJ", "1008260000000001"], ["1028260000000103", "IT", "1007260000000002"],
  ], "chỉ gửi Cut đã ghép phiếu");
  assert.equal(rows[0].cut_at, cuts[0].cutAt, "cut_at gửi lại nguyên chuỗi của máy chủ (khoá dòng)");
  assert.deepEqual([rows[0].source_reason, rows[0].source_note, rows[0].source_at], ["Xuất test", "10012600000001", "2026-10-24T01:05:00.000Z"], "ADJ: lý do + số PO + giờ phiếu");
  assert.equal(rows[2].source_reason, null);
  assert.ok(rows[2].source_note.startsWith("WH - SEMI PRODUCT - TEST · NPL may mẫu giả "), "IT: kho nhận · mô tả");
  assert.equal(rows[2].source_note.length, 200, "ghi chú cắt ≤ 200 ký tự");
  assert.deepEqual({ ...result }, { unresolved: 5, docs: 2, matched: 3, written: 3, skipped: 0, adj: 2, it: 1, notFound: 0, truncated: false });
  assert.ok(progress.some(p => p.phase === "source"), "báo tiến độ bước nguồn");

  // Phiếu không tra được số → không ghi (để lần sau), đếm notFound; phiếu thiếu mapping cũng vậy
  const w2 = fakeWorld({ cuts: cuts.slice(0, 3), moves: moves.slice(0, 2).map(m => (m.id === 2 ? { ...m, mappingId: "" } : m)), info: { adj: {}, it: {} } });
  const r2 = await assignSources({ sendTab: w2.sendTab, rpc: w2.rpc, now: () => FIXED });
  assert.deepEqual([r2.matched, r2.notFound, r2.written], [3, 2, 0]);
  assert.equal(w2.rpcs.filter(r => r.name === "wms_group_uid_cut_set_source").length, 0, "không có dòng nào thì không gọi set_source");
  assert.deepEqual(w2.calls.filter(c => c.type === "GET_WMS_DOC_INFO").map(c => c.payload), [{ adj: ["100052600000001"], it: [] }], "phiếu thiếu mapping không tra");

  // Không có Cut chưa nguồn → không đọc WMS
  const w3 = fakeWorld({ cuts: [], moves });
  assert.deepEqual(await assignSources({ sendTab: w3.sendTab, rpc: w3.rpc, now: () => FIXED }), { unresolved: 0, docs: 0, matched: 0, written: 0, skipped: 0, adj: 0, it: 0, notFound: 0, truncated: false });
  assert.equal(w3.calls.length, 0);

  // Tra số phiếu theo lô ≤ 20 mỗi loại
  const many = Array.from({ length: 25 }, (_, i) => cutRow(String(1028260000000200 + i), 11 + i, at(14, 8, i), "900000033"));
  const manyMoves = many.map((c, i) => move(100 + i, { sku: "900000033", qty: 11 + i, sourceType: i % 2 ? "INTERNAL_TRANSFER" : "ADJUSTMENT", createdAt: new Date(Date.parse(c.cutAt) + 5 * MIN).toISOString(), mappingId: String(100052600000100 + i) }));
  const w4 = fakeWorld({ cuts: many, moves: manyMoves, info: { adj: {}, it: {} }, pageSize: 500 });
  await assignSources({ sendTab: w4.sendTab, rpc: w4.rpc, now: () => FIXED });
  const lots = w4.calls.filter(c => c.type === "GET_WMS_DOC_INFO").map(c => [c.payload.adj.length, c.payload.it.length]);
  assert.deepEqual(lots, [[13, 12]], "13 ADJ + 12 IT = một lần");
  const w5 = fakeWorld({ cuts: many, moves: manyMoves.map(m => ({ ...m, sourceType: "ADJUSTMENT" })), info: { adj: {}, it: {} }, pageSize: 500 });
  await assignSources({ sendTab: w5.sendTab, rpc: w5.rpc, now: () => FIXED });
  assert.deepEqual(w5.calls.filter(c => c.type === "GET_WMS_DOC_INFO").map(c => [c.payload.adj.length, c.payload.it.length]), [[20, 0], [5, 0]], "25 ADJ = 2 lần (20 + 5)");

  // Lỗi: tab WMS (giữ code / reason), dữ liệu sai dạng, trang đổi giữa lúc đọc, RPC lỗi → ném, không ghi
  const w6 = fakeWorld({ cuts, moves, info, failOn: "GET_STOCK_IMPORT_EXPORT_PAGE" });
  await assert.rejects(assignSources({ sendTab: w6.sendTab, rpc: w6.rpc, now: () => FIXED }), e => e.code === "WMS_AUTH" && e.reason === "session");
  assert.equal(w6.rpcs.filter(r => r.name === "wms_group_uid_cut_set_source").length, 0);
  await assert.rejects(assignSources({ sendTab: w.sendTab, rpc: async () => ({ cuts: "x" }), now: () => FIXED }), /Cut chưa có nguồn phiếu không hợp lệ/);
  await assert.rejects(assignSources({ sendTab: async () => ({ rows: "x" }), rpc: w.rpc, now: () => FIXED }), /Import\/Export 1 không hợp lệ/);
  let pageNo = 0;
  const drifting = async (type, payload) => (type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? { rows: [], total: 600 + (++pageNo), totalPages: 2, page: payload.page } : { adj: [], it: [] });
  await assert.rejects(assignSources({ sendTab: drifting, rpc: w.rpc, now: () => FIXED }), /thay đổi trong lúc đọc/);
  await assert.rejects(assignSources({ sendTab: async (type, payload) => (type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? { rows: [], total: 1, totalPages: 101, page: payload.page } : null), rpc: w.rpc, now: () => FIXED }), /vượt 100 trang/);
  const w7 = fakeWorld({ cuts, moves, info });
  await assert.rejects(assignSources({ sendTab: async (type, payload) => (type === "GET_WMS_DOC_INFO" ? { adj: null } : w7.sendTab(type, payload)), rpc: w7.rpc, now: () => FIXED }), /thông tin phiếu ADJ \/ IT không hợp lệ/);
  await assert.rejects(assignSources({ sendTab: w.sendTab }), /Thiếu hàm/);
  // Đọc Import/Export phải đủ dòng (review 26/10/2026, BC4): cộng sourceRows (số dòng WMS trả ở trang, trước khi lọc) trừ dòng trùng id
  // = total; trang lặp lại → ném. Thiếu dòng phiếu ADJ mà dòng IT còn thì Cut bị ghép sai mà không bao giờ sửa → phải ném, không ghi.
  const pageFake = book => async (type, payload) => {
    if (type !== "GET_STOCK_IMPORT_EXPORT_PAGE") return { adj: [], it: [] };
    const p = book(payload.page), rows = p.rows || p.ids.map(id => move(id, { qty: 1000, createdAt: "2026-10-24T08:05:00+07:00", mappingId: "100052600000001" }));
    return { rows, sourceRows: p.noSource ? undefined : (p.source ?? rows.length), total: p.total, totalPages: p.totalPages, page: payload.page, size: 2 };
  };
  const readCase = async (label, book, pattern) => {
    const wr = fakeWorld({ cuts, moves: [], info });
    const run = assignSources({ sendTab: pageFake(book), rpc: wr.rpc, now: () => FIXED });
    if (pattern) await assert.rejects(run, pattern, label); else await run;
    if (pattern) assert.equal(wr.rpcs.filter(r => r.name === "wms_group_uid_cut_set_source").length, 0, `${label}: không ghi`);
  };
  await readCase("trang lặp", () => ({ ids: [1, 2], total: 4, totalPages: 2 }), /WMS trả lặp lại cùng một trang Import\/Export; hãy chạy lại/);
  await readCase("thiếu dòng", page => ({ ids: [[1, 2], [3, 4], []][page - 1], total: 5, totalPages: 3 }), /Đọc được 4\/5 dòng Import\/Export \(đọc thiếu\); hãy chạy lại/);
  await readCase("thừa dòng", page => ({ ids: [[1, 2], [3, 4]][page - 1], total: 3, totalPages: 2 }), /Đọc được 4\/3 dòng Import\/Export \(đọc thừa\); hãy chạy lại/);
  await readCase("trùng id giữa hai trang (dòng ở ranh trang bị đọc hai lần, một dòng khác bị sót)", page => ({ ids: [[1, 2], [2, 3]][page - 1], total: 4, totalPages: 2 }), /Đọc được 3\/4 dòng Import\/Export \(đọc thiếu\)/);
  // Đủ dòng: dòng bị bộ chuẩn hoá lọc bỏ (sourceRows > rows) không phải đọc thiếu
  await readCase("đủ dòng, có dòng bị lọc", page => ({ ids: [[1, 2], []][page - 1], source: [2, 1][page - 1], total: 3, totalPages: 2 }), null);
  // Dòng không có id (review vòng 2: normalizeImportExportPage cho id null): khoá dòng ghép từ các trường (loại, nguồn, mã phiếu, mapping, SKU,
  // số lượng, giờ, kho) cho cả chữ ký trang lẫn khử trùng; nhiều trang mà phép kiểm đủ dòng không chắc (trang thiếu sourceRows: dòng bị lọc
  // không đếm được) → ném (fail-closed). Không có total thì vẫn ném như trước (total trang 2 ≠ trang 1).
  const noId = (sku, mins) => move(null, { sku, qty: 1000, sourceCode: `100426000000${sku.slice(-4)}`, createdAt: new Date(at(14, 9, 0) + mins * MIN).toISOString(), mappingId: "100052600000001" });
  await readCase("trang lặp, dòng không có id", () => ({ rows: [noId("900000041", 1), noId("900000042", 2)], total: 4, totalPages: 2 }), /WMS trả lặp lại cùng một trang Import\/Export; hãy chạy lại/);
  await readCase("dòng không có id trùng giữa hai trang", page => ({ rows: [[noId("900000041", 1), noId("900000042", 2)], [noId("900000042", 2), noId("900000043", 3)]][page - 1], total: 4, totalPages: 2 }), /Đọc được 3\/4 dòng Import\/Export \(đọc thiếu\)/);
  await readCase("dòng không có id, các trang khác nhau", page => ({ rows: [[noId("900000041", 1), noId("900000042", 2)], [noId("900000043", 3), noId("900000044", 4)]][page - 1], total: 4, totalPages: 2 }), null);
  const fourNoId = page => [[noId("900000041", 1), noId("900000042", 2)], [noId("900000043", 3), noId("900000044", 4)]][page - 1];
  await readCase("dòng không có id, nhiều trang, trang thiếu sourceRows", page => ({ rows: fourNoId(page), noSource: true, total: 4, totalPages: 2 }), /không có mã dòng.*không kiểm được đủ dòng; hãy chạy lại/);
  await readCase("nhiều trang, không có total", page => ({ rows: fourNoId(page), total: undefined, totalPages: 2 }), /thay đổi trong lúc đọc/);
  console.log("cut_source_core readMoves: trang lặp, thiếu dòng, thừa dòng, trùng id giữa trang → ném, không ghi; đủ dòng (kể cả dòng bị lọc) → chạy; dòng không id: lặp / trùng / trang thiếu sourceRows → ném, khác nhau → chạy; không total → ném: PASS");

  // Chi tiết ADJ lỗi tạm (GET_WMS_DOC_INFO trả detailFailed, review vòng 2): coi là CHƯA tra được — không ghi, đếm notFound — vì set_source chỉ
  // ghi Cut chưa nguồn (ghi PO rỗng là mất PO vĩnh viễn); lượt sau chi tiết thành công thì ghi đủ PO.
  {
    const flaky = { adj: { "100052600000001": { number: "1008260000000001", reason: "Xuất test", po: null, detailFailed: true } }, it: info.it };
    const wf = fakeWorld({ cuts: cuts.slice(0, 3), moves: moves.slice(0, 2), info: flaky });
    const rf = await assignSources({ sendTab: wf.sendTab, rpc: wf.rpc, now: () => FIXED });
    assert.deepEqual([rf.matched, rf.notFound, rf.adj, rf.it, rf.written], [3, 1, 0, 1, 1], "phiếu ADJ lỗi chi tiết: chưa tra được");
    assert.deepEqual(wf.rpcs.filter(r => r.name === "wms_group_uid_cut_set_source").flatMap(r => r.args.p_rows).map(r => r.group_uid_code), ["1028260000000103"], "chỉ ghi Cut của phiếu IT");
    const later = fakeWorld({ cuts: cuts.slice(0, 2), moves: moves.slice(0, 1), info });
    const rl = await assignSources({ sendTab: later.sendTab, rpc: later.rpc, now: () => FIXED });
    assert.deepEqual([rl.adj, rl.notFound], [2, 0], "lượt sau chi tiết thành công → ghi");
    assert.deepEqual(later.rpcs.filter(r => r.name === "wms_group_uid_cut_set_source").flatMap(r => r.args.p_rows).map(r => r.source_note), ["10012600000001", "10012600000001"], "ghi đủ PO");
    console.log("cut_source_core chi tiết ADJ lỗi tạm: không ghi, đếm notFound, lượt sau ghi đủ PO: PASS");
  }

  // Phiếu sát mốc đọc (review vòng 2): Cut được ghép khi ≤ giờ phiếu + 2 phút, nên phiếu trong (to − 2 phút, to] có thể có Cut thật sau to (chưa
  // nạp) mà lấy nhầm một Cut cũ đang tự do → để lượt sau. Phiếu cách to 3 phút vẫn ghép.
  {
    const edgeCut = [cutRow("1028260000000301", 9, FIXED - 60 * MIN, "900000034")];
    const edgeMove = mins => [move(301, { sku: "900000034", qty: 9, sourceType: "INTERNAL_TRANSFER", createdAt: new Date(FIXED - mins * MIN).toISOString(), mappingId: "10022600000301" })];
    const edgeInfo = { adj: {}, it: { "10022600000301": { number: "1007260000000301", toWarehouse: "KHO NHẬN GIẢ", description: "" } } };
    const near = fakeWorld({ cuts: edgeCut, moves: edgeMove(1), info: edgeInfo });
    const rn = await assignSources({ sendTab: near.sendTab, rpc: near.rpc, now: () => FIXED });
    assert.deepEqual([rn.docs, rn.matched, rn.written], [0, 0, 0], "phiếu cách mốc đọc 1 phút: chưa ghép lượt này");
    assert.equal(near.calls.filter(c => c.type === "GET_WMS_DOC_INFO").length, 0);
    const far = fakeWorld({ cuts: edgeCut, moves: edgeMove(3), info: edgeInfo });
    const rr = await assignSources({ sendTab: far.sendTab, rpc: far.rpc, now: () => FIXED });
    assert.deepEqual([rr.docs, rr.matched, rr.written], [1, 1, 1], "phiếu cách mốc đọc 3 phút: ghép");
    console.log("cut_source_core phiếu sát mốc đọc (≤ 2 phút) để lượt sau, cách 3 phút vẫn ghép: PASS");
  }
  console.log("cut_source_core assignSources: Cut chưa nguồn → Import/Export 1177 → tra số phiếu (≤ 20/loại) → set_source; bỏ phiếu đã dùng, phiếu không tra được để lần sau, lỗi tab / dữ liệu sai / trang đổi → ném: PASS");

  // index.html chép NGUYÊN VĂN tệp này vào <script id="cut-source-core"> (như group-uid-snapshot-core) — hai bản không được lệch
  const nl = t => t.replace(/\r\n/g, "\n").trim();
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const block = html.match(/<script id="cut-source-core">([\s\S]*?)<\/script>/);
  assert.ok(block, "index.html thiếu khối cut-source-core");
  assert.equal(nl(block[1]), nl(fs.readFileSync(path.join(__dirname, "..", "extension", "inside-po-connector", "cut-source-core.js"), "utf8")), "index.html: khối cut-source-core lệch bản Extension — chép lại nguyên văn");
  console.log("cut_source_core: index.html giữ bản chép nguyên văn: PASS");
})().catch(error => { console.error(error); process.exit(1); });
