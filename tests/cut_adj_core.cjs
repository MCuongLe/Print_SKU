// Lõi tự động Cắt Group UID · Đối chiếu ADJ (extension/inside-po-connector/cut-adj-core.js, Extension 0.10.7): đọc lịch sử Cut WMS
// kho WH - MATERIAL - MTG rồi nạp wms_group_uid_cut_import như nút "Đọc WMS" (syncFromWms trong <script id="cut-adj-reconcile">).
// So với CHÍNH mã web: cắt syncFromWms + sendImport từ index.html, chạy trong vm với Extension/Supabase giả, cùng dữ liệu giả
// (Group UID 1028260000000xxx, SKU 9000000xx) → payload RPC phải giống hệt (trừ tên tệp WMS_AUTO_… thay WMS_API_WH_MATERIAL_…).
// 26/10/2026: sau khi nạp Cut cả hai chạy bước gán nguồn phiếu ADJ / IT (cut-source-core.assignSources: wms_group_uid_cut_unresolved →
// GET_STOCK_IMPORT_EXPORT_PAGE → GET_WMS_DOC_INFO → wms_group_uid_cut_set_source) → cùng chuỗi lệnh tab, cùng payload set_source.
//   node tests/cut_adj_core.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../extension/inside-po-connector/cut-adj-core.js");
const sourceCore = require("../extension/inside-po-connector/cut-source-core.js");

const FIXED = Date.UTC(2026, 9, 22, 3, 15, 30, 123); // 10:15 giờ VN 22/10/2026
const HTML = fs.readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const slice = (from, to) => {
  const a = HTML.indexOf(from);
  assert.ok(a >= 0, `index.html có neo ${from}`);
  const b = HTML.indexOf(to, a);
  assert.ok(b > a, `index.html có neo ${to}`);
  return HTML.slice(a, b);
};
const WEB_SRC = slice("const sendImport=async(parsed,token)=>{", "const extensionRequest=(type,payload={},timeout=90000)=>")
  + slice("const sha256=async value=>", "const finishUpload=async()=>{");

// ---- WMS giả: chia trang như wms-bridge (trang = 500 dòng lịch sử, rows = dòng Cut của trang) ----
const iso = ms => new Date(ms).toISOString();
function makeHistory(count, start = Date.UTC(2026, 9, 20, 1, 0)) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const uid = String(1028260000000000 + (i % 900)), at = start + i * 60000;
    if (i % 7 === 3) out.push({ group_uid_code: uid, at, cut: null }); // dòng không phải Cut (Transfer location)
    else out.push({ group_uid_code: uid, at, cut: { qty: 306 + (i % 5), remaining: 5000 - i, sku: String(900000001 + (i % 40)), by: "user@example.test" } });
  }
  return out;
}
// "Máy chủ + WMS" giả cho bước nguồn phiếu: Cut chưa có nguồn (như wms_group_uid_cut_unresolved), dòng Import/Export đã chuẩn hoá
// (normalizeImportExportPage) và số phiếu (GET_WMS_DOC_INFO). Mặc định: 4 Cut đầu có phiếu (ADJ, IT xen kẽ) 5 phút sau Cut.
function sourceWorld(source, docs = 4) {
  const cuts = source.filter(row => row.cut).map(row => ({ groupUid: row.group_uid_code, cutAt: iso(row.at).replace(".000Z", "+00:00"), qty: row.cut.qty, sku: row.cut.sku }));
  const moves = [], info = { adj: {}, it: {} };
  cuts.slice(0, docs).forEach((cut, i) => {
    const it = i % 2 === 1, mapping = String((it ? 10022600000100 : 100052600000100) + i);
    moves.push({ id: 9000 + i, warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", sku: cut.sku, kind: "out", qty: cut.qty, sourceType: it ? "INTERNAL_TRANSFER" : "ADJUSTMENT", sourceCode: "", mappingId: mapping, reason: it ? "" : "Xuất test", createdAt: iso(Date.parse(cut.cutAt) + 5 * 60000) });
    if (it) info.it[mapping] = { number: String(1007260000000100 + i), toWarehouse: "WH - SEMI PRODUCT - TEST", description: "Chuyển giả" };
    else info.adj[mapping] = { number: String(1008260000000100 + i), reason: "Xuất test", po: "10012600000100" };
  });
  return { unresolved: { cuts, used: [] }, moves, info };
}
const EMPTY_WORLD = { unresolved: { cuts: [], used: [] }, moves: [], info: { adj: {}, it: {} } };
const rpcData = (world, name, args) => {
  if (name === "wms_group_uid_cut_import") return importResult(args);
  if (name === "wms_group_uid_cut_unresolved") return world.unresolved;
  if (name === "wms_group_uid_cut_set_source") return { updated: args.p_rows.length, skipped: 0 };
  throw new Error(`rpc lạ ${name}`);
};

// opts: noTotal (API không trả tổng), repeat (bỏ qua page), driftAt (trang có tổng khác), shortAt (trang thiếu dòng),
// warehouseId, failAt (trang ném lỗi tab), duplicate (trang 2 trả lại 1 dòng Cut của trang 1), world (bước nguồn phiếu),
// failType (lệnh tab ném lỗi), extVersion (PING_WMS của web)
function makeWms(source, opts = {}) {
  const calls = [], world = opts.world || EMPTY_WORLD;
  const send = async (type, payload) => {
    calls.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    if (opts.failType === type) { const e = new Error("Phiên WMS đã hết hạn; hãy đăng nhập lại"); e.code = "WMS_AUTH"; e.reason = "session"; throw e; }
    if (type === "GET_STOCK_IMPORT_EXPORT_PAGE") {
      const list = world.moves.filter(m => Date.parse(m.createdAt) >= payload.from && Date.parse(m.createdAt) <= payload.to);
      return { rows: list.slice((payload.page - 1) * payload.size, payload.page * payload.size), sourceRows: list.length, total: list.length, totalPages: Math.max(1, Math.ceil(list.length / payload.size)), page: payload.page, size: payload.size, warehouseIds: payload.warehouseIds };
    }
    if (type === "GET_WMS_DOC_INFO") {
      return { adj: payload.adj.filter(c => world.info.adj[c]).map(c => ({ mappingCode: c, ...world.info.adj[c] })), it: payload.it.filter(c => world.info.it[c]).map(c => ({ mappingId: c, ...world.info.it[c] })), generatedAt: iso(FIXED) };
    }
    if (type !== "GET_GROUP_UID_HISTORY_PAGE") throw new Error(`lệnh lạ ${type}`);
    const size = payload.size || 500, pageNo = payload.page || 1, at = opts.repeat ? 1 : pageNo;
    if (opts.failAt === pageNo) { const e = new Error("Phiên WMS hết hạn; hãy đăng nhập lại tab WMS"); e.code = "WMS_AUTH"; throw e; }
    const from = payload.from ? Date.parse(payload.from) : -Infinity, to = Date.parse(payload.to);
    const inRange = source.filter(row => row.at >= from && row.at <= to);
    let rowsOfPage = inRange.slice((at - 1) * size, at * size);
    if (opts.shortAt === pageNo) rowsOfPage = rowsOfPage.slice(0, rowsOfPage.length - 3);
    const times = rowsOfPage.map(row => row.at).sort((a, b) => a - b);
    let total = opts.noTotal ? rowsOfPage.length : inRange.length;
    if (opts.driftAt === pageNo) total += 1;
    const rows = rowsOfPage.filter(row => row.cut).map(row => ({ group_uid_code: row.group_uid_code, cut_at: iso(row.at), qty: row.cut.qty, remaining_qty: row.cut.remaining, sku: row.cut.sku, cut_by: row.cut.by, warehouse: "WH - MATERIAL - MTG" }));
    if (opts.duplicate && pageNo === 2) rows.push({ ...calls.dupRow, qty: 999 }); // cùng khoá UID|giờ với trang 1 → bản đọc sau thắng
    if (pageNo === 1) calls.dupRow = rows[0];
    return { page: pageNo, size, total, totalPages: Math.max(1, Math.ceil(total / size)), rows, sourceRows: rowsOfPage.length,
      rangeFrom: times.length ? iso(times[0]) : null, rangeTo: times.length ? iso(times.at(-1)) : null, warehouseId: opts.warehouseId ?? "1177" };
  };
  return { send, calls };
}
const importResult = body => ({ importId: "imp-1", cutRows: body.p_rows.length, newRows: body.p_rows.length ? 1 : 0, changedRows: 0, unchangedRows: Math.max(0, body.p_rows.length - 1) });

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [FIXED])); }
  static now() { return FIXED; }
}
// Đồng hồ chạy tiếp sau khi web lấy mốc to (new Date() = FIXED) — Date.now() lúc bước nguồn phiếu đã muộn hơn (ca E5).
const laterDate = nowMs => class extends FixedDate { static now() { return nowMs; } };

// ---- Chạy mã web trong vm ----
async function runWeb(source, opts, cov) {
  const wms = makeWms(source, opts), imports = [], told = [], world = opts.world || EMPTY_WORLD;
  const ctx = vm.createContext({
    window: { PrintSkuQueue: { supabaseUrl: "https://example.invalid", publishableKey: "test-publishable" }, CutSourceCore: sourceCore },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body), name = String(url).split("/rpc/")[1];
      imports.push({ name, args: body, authorization: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({ ok: true, data: rpcData(world, name, body) }) };
    },
    AbortSignal, crypto: globalThis.crypto, TextEncoder, Date: opts.dateNow ? laterDate(opts.dateNow) : FixedDate, console,
    tell: (text, tone) => told.push({ text, tone }), fmt: value => String(value), syncTick: () => {}, load: async () => {},
    adminToken: async () => "test-admin-token",
    extensionRequest: async (type, payload) => (type === "PING_WMS" ? { version: opts.extVersion || "0.12.0" } : wms.send(type, payload)),
    __cov: cov,
  });
  const fn = vm.runInContext(`let uploading=false,pendingWms=false,cov=__cov;
    const wmsBtn={dataset:{},disabled:false,querySelector:()=>({textContent:""})},uploadBtn={disabled:false};
    ${WEB_SRC}; syncFromWms`, ctx);
  await fn();
  const error = told.find(t => t.tone === "error");
  return { imports, calls: wms.calls.filter(c => c.type !== "PING_WMS"), error: error ? error.text.replace(/^Không đồng bộ được lịch sử WMS: /, "") : null, told, last: told.at(-1) };
}
async function runCore(source, opts, cov, extra = {}) {
  const wms = makeWms(source, opts), rpcs = [], progress = [], world = opts.world || EMPTY_WORLD;
  const rpc = async (name, args) => {
    rpcs.push({ name, args: JSON.parse(JSON.stringify(args)) });
    if (name === "wms_cut_coverage") return cov;
    return rpcData(world, name, args);
  };
  try {
    const result = await core.run({ sendTab: wms.send, rpc, device: "may-test-01", now: () => FIXED, onProgress: p => progress.push(p), ...extra });
    return { result, rpcs, calls: wms.calls, progress, error: null };
  } catch (error) {
    return { result: null, rpcs, calls: wms.calls, progress, error: error.message, thrown: error };
  }
}
const imports = list => list.filter(r => r.name === "wms_group_uid_cut_import");
const named = (list, name) => list.filter(r => r.name === name).map(r => r.args);
const withoutName = list => imports(list).map(r => { const { p_file_name, ...rest } = r.args; return rest; });

(async () => {
  let cases = 0;
  const cov = { from: "2026-10-01T00:00:00.000Z", until: "2026-10-20T05:00:00.000Z", files: 3, importedAt: "2026-10-20T05:01:00.000Z" };

  // ---- D8 + R7 (Extension 0.10.8, review 23/10/2026): chỉ lõi Extension. Ca so khớp web "chia phần" bên dưới chờ chép sang syncFromWms ----
  {
    // D8: khung đọc không có dòng → p_data_until = min(to, giờ server). Máy chạy nhanh 40 phút → dùng giờ server (lượt sau không sót Cut).
    const quiet = makeHistory(5, Date.UTC(2026, 8, 1)), serverAt = FIXED - 40 * 60000;
    const fast = await runCore(quiet, {}, cov, { serverNow: () => serverAt });
    assert.equal(fast.error, null, fast.error);
    assert.equal(imports(fast.rpcs)[0].args.p_data_until, iso(serverAt), "D8: máy nhanh → mốc phủ = giờ server");
    assert.equal(fast.result.until, iso(serverAt));
    // Giờ server sau to (máy chậm) → giữ to; không có / lỗi giờ server → to như cũ.
    const slow = await runCore(quiet, {}, cov, { serverNow: () => FIXED + 10 * 60000 });
    assert.equal(imports(slow.rpcs)[0].args.p_data_until, iso(FIXED), "D8: máy chậm → giữ to");
    for (const serverNow of [() => NaN, () => undefined, () => { throw new Error("không có giờ server"); }, "không phải hàm"]) {
      const none = await runCore(quiet, {}, cov, { serverNow });
      assert.equal(none.error, null, none.error);
      assert.equal(imports(none.rpcs)[0].args.p_data_until, iso(FIXED), "D8: không có giờ server → to (giờ máy)");
    }
    // Mốc phủ cũ đã ở tương lai (máy từng chạy nhanh) và giờ server trước from: from kẹp về until (SQL chặn until < from).
    const ahead = await runCore(quiet, {}, { ...cov, until: iso(FIXED + 60 * 60000) }, { serverNow: () => serverAt });
    assert.equal(ahead.error, null, ahead.error);
    assert.deepEqual([imports(ahead.rpcs)[0].args.p_data_from, imports(ahead.rpcs)[0].args.p_data_until], [iso(serverAt), iso(serverAt)]);
    // Có dòng → mốc phủ theo giờ dữ liệu WMS; giờ server không đổi gì.
    const rowsStart = Date.UTC(2026, 9, 20, 4, 40);
    const withRows = await runCore(makeHistory(40, rowsStart), {}, cov, { serverNow: () => serverAt });
    assert.equal(imports(withRows.rpcs)[0].args.p_data_until, iso(rowsStart + 39 * 60000), "D8: có dòng → until = giờ dòng cuối");
    // R7: nhiều phần → phần i < cuối phủ tới cut_at dòng cuối của phần đó; phần cuối giữ mốc cả lượt.
    const many = makeHistory(6200, Date.UTC(2026, 9, 15)).reverse();
    const split = await runCore(many, {}, null);
    assert.equal(split.error, null, split.error);
    const ps = imports(split.rpcs);
    assert.equal(ps.length, 2);
    assert.equal(ps[0].args.p_data_until, ps[0].args.p_rows.at(-1).cut_at, "R7: phần 1 phủ tới Cut cuối của phần");
    assert.ok(ps[0].args.p_data_until < split.result.until, "R7: phần 1 không phủ qua dữ liệu phần 2");
    assert.ok(ps[0].args.p_data_until <= ps[1].args.p_rows[0].cut_at, "R7: phần 2 bắt đầu sau mốc phần 1");
    assert.equal(ps[1].args.p_data_until, split.result.until, "R7: phần cuối giữ mốc cả lượt");
    assert.ok(ps.every(p => p.args.p_data_from === split.result.from && p.args.p_data_from <= p.args.p_data_until));
    // Phần 2 nạp lỗi → mốc phủ đã ghi chỉ tới phần 1 → lượt sau đọc lại từ đó (trước đây nhảy qua cả phần 2).
    const sent = [];
    await assert.rejects(core.run({ sendTab: makeWms(many).send, device: "may-test-01", now: () => FIXED, rpc: async (name, args) => {
      if (name === "wms_cut_coverage") return null;
      sent.push(args);
      if (sent.length === 2) throw new Error("Supabase HTTP 500");
      return importResult(args);
    } }), /Supabase HTTP 500/);
    assert.equal(sent[0].p_data_until, sent[0].p_rows.at(-1).cut_at, "R7: phần đã nạp không phủ qua phần lỗi");
    console.log("cut_adj_core D8 + R7 (lõi Extension): PASS");
  }
  const same = async (label, source, opts, coverage) => {
    opts = { world: sourceWorld(source), ...opts };
    const web = await runWeb(source, opts, coverage), mine = await runCore(source, opts, coverage);
    assert.equal(web.error, null, `${label}: web không lỗi (${web.error})`);
    assert.equal(mine.error, null, `${label}: core không lỗi (${mine.error})`);
    assert.deepEqual(mine.calls.map(c => c.payload), web.calls.map(c => c.payload), `${label}: cùng chuỗi lệnh đọc WMS`);
    assert.ok(imports(web.imports).length >= 1, `${label}: web có nạp`);
    assert.deepEqual(withoutName(mine.rpcs), withoutName(web.imports), `${label}: payload wms_group_uid_cut_import giống hệt web`);
    assert.deepEqual(mine.rpcs[0], { name: "wms_cut_coverage", args: {} }, `${label}: lấy mốc phủ trước`);
    const names = imports(mine.rpcs).map(r => r.args.p_file_name), webNames = imports(web.imports).map(r => r.args.p_file_name);
    assert.deepEqual(names, webNames.map(n => n.replace(/^WMS_API_WH_MATERIAL_/, "WMS_AUTO_may-test-01_")), `${label}: tên tệp WMS_AUTO_<máy>_<giờ>`);
    const sum = key => imports(mine.rpcs).reduce((s, r) => s + importResult(r.args)[key], 0);
    assert.deepEqual({ cutRows: mine.result.cutRows, newRows: mine.result.newRows, changedRows: mine.result.changedRows, unchangedRows: mine.result.unchangedRows },
      { cutRows: sum("cutRows"), newRows: sum("newRows"), changedRows: sum("changedRows"), unchangedRows: sum("unchangedRows") }, `${label}: cộng kết quả các phần`);
    assert.equal(mine.result.total, imports(web.imports)[0].args.p_total_rows, `${label}: total = số dòng lịch sử đã đọc`);
    // R7 (0.10.8): until của cả lượt = until của phần CUỐI (phần trước chỉ phủ tới Cut cuối của phần).
    assert.deepEqual([mine.result.from, mine.result.until], [imports(web.imports)[0].args.p_data_from, imports(web.imports).at(-1).args.p_data_until], `${label}: from/until = mốc dữ liệu đã nạp`);
    assert.match(web.told.at(-1).text, new RegExp(`^Đã đọc ${mine.result.total.toLocaleString("vi-VN")} dòng`), `${label}: web báo cùng tổng`);
    // Bước nguồn phiếu (26/10/2026): chạy SAU khi nạp xong, cùng một hàm assignSources → cùng lệnh tab, cùng payload set_source
    const order = list => list.map(r => r.name).filter(n => n !== "wms_cut_coverage");
    assert.deepEqual(order(mine.rpcs), [...imports(mine.rpcs).map(() => "wms_group_uid_cut_import"), "wms_group_uid_cut_unresolved", "wms_group_uid_cut_set_source"], `${label}: core nạp Cut rồi mới gán nguồn`);
    assert.deepEqual(order(web.imports), order(mine.rpcs), `${label}: web cùng thứ tự RPC`);
    assert.deepEqual(named(web.imports, "wms_group_uid_cut_unresolved"), [{ p_days: 30 }]);
    assert.deepEqual(named(mine.rpcs, "wms_group_uid_cut_set_source"), named(web.imports, "wms_group_uid_cut_set_source"), `${label}: payload set_source giống hệt web`);
    assert.ok(web.imports.every(r => r.authorization === "Bearer test-admin-token"), `${label}: web gọi RPC bằng phiên Admin`);
    const setRows = named(mine.rpcs, "wms_group_uid_cut_set_source")[0].p_rows;
    assert.deepEqual(setRows.map(r => r.source_type), ["ADJ", "IT", "ADJ", "IT"], `${label}: 4 Cut có phiếu → 2 ADJ + 2 IT`);
    assert.ok(mine.calls.some(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE") && mine.calls.some(c => c.type === "GET_WMS_DOC_INFO"), `${label}: đọc Import/Export + số phiếu`);
    assert.deepEqual([mine.result.source.adj, mine.result.source.it, mine.result.source.written], [2, 2, 4], `${label}: core trả tóm tắt nguồn`);
    // Vòng 2: cùng đại lượng, cùng cụm chữ với tóm tắt tự động (auto-sync summaryOf): đã gán = adj + it, còn chưa nguồn = unresolved − đã gán
    const src0 = mine.result.source, assigned = src0.adj + src0.it, n = v => v.toLocaleString("vi-VN");
    assert.ok(web.last.text.endsWith(` Nguồn phiếu: đã gán ${n(assigned)} · còn chưa nguồn ${n(src0.unresolved - assigned)}.`), `${label}: web báo số Cut đã gán / còn chưa nguồn (${web.last.text})`);
    assert.equal(web.last.tone, "ok");
    cases += 1;
    return { web, mine };
  };

  // 1. Chưa nạp lần nào (mốc phủ null) → đọc toàn bộ, 1 trang
  const small = makeHistory(40);
  const first = await same("toàn bộ 1 trang", small, {}, null);
  assert.equal("from" in first.mine.calls[0].payload, false, "không có mốc phủ → không gửi from");
  assert.equal(first.mine.result.readFrom, null);
  assert.equal(first.mine.result.full, true);
  assert.equal(imports(first.mine.rpcs)[0].args.p_file_name, "WMS_AUTO_may-test-01_20261022031530.json");

  // 2. Gia tăng từ until − 30 phút, 3 trang, có dòng không phải Cut
  const mid = makeHistory(1300, Date.UTC(2026, 9, 20, 4, 0));
  const inc = await same("gia tăng 3 trang", mid, {}, cov);
  assert.equal(inc.mine.calls[0].payload.from, "2026-10-20T04:30:00.000Z", "from = until − 30 phút");
  assert.equal(inc.mine.calls[0].payload.to, new Date(FIXED).toISOString());
  assert.equal(inc.mine.calls.filter(c => c.type === "GET_GROUP_UID_HISTORY_PAGE").length, 3, "3 trang lịch sử (sau đó là lệnh của bước nguồn phiếu)");
  assert.equal(inc.mine.result.full, false);
  assert.equal(inc.mine.result.readFrom, "2026-10-20T04:30:00.000Z");
  assert.ok(inc.mine.progress.some(p => p.phase === "read" && p.page === 3) && inc.mine.progress.some(p => p.phase === "save"), "báo tiến độ đọc + lưu");

  // 3. API không trả tổng (totalPages = 1): đọc tới trang thiếu dòng
  await same("không có tổng", makeHistory(1100), { noTotal: true }, null);

  // 4. Hơn 5.000 dòng Cut → chia 2 phần, sắp theo cut_at, tên tệp _1 / _2
  const big = await same("chia phần", makeHistory(6200, Date.UTC(2026, 9, 15)).reverse(), {}, null); // WMS trả mới nhất trước
  const parts = imports(big.mine.rpcs);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].args.p_rows.length, 5000);
  assert.match(parts[0].args.p_file_name, /^WMS_AUTO_may-test-01_20261022031530_1\.json$/);
  assert.match(parts[1].args.p_file_name, /^WMS_AUTO_may-test-01_20261022031530_2\.json$/);
  const allRows = parts.flatMap(p => p.args.p_rows);
  assert.deepEqual(allRows.map(r => r.cut_at), [...allRows.map(r => r.cut_at)].sort(), "sắp theo cut_at");

  assert.equal(parts[0].args.p_data_until, parts[0].args.p_rows.at(-1).cut_at, "R7: web phần 1 cũng phủ tới Cut cuối của phần");

  // 5. Dòng trùng khoá UID|giờ giữa hai trang → giữ bản đọc sau như web
  const dup = await same("trùng khoá", makeHistory(900), { duplicate: true }, null);
  assert.equal(imports(dup.mine.rpcs)[0].args.p_rows.filter(r => r.qty === 999).length, 1);

  // 6. Không có dòng nào trong khung → vẫn nạp 1 phần rỗng (mốc phủ tiến tới to) như web
  const empty = await same("khung rỗng", makeHistory(5, Date.UTC(2026, 8, 1)), {}, cov);
  assert.equal(imports(empty.mine.rpcs)[0].args.p_rows.length, 0);
  assert.equal(imports(empty.mine.rpcs)[0].args.p_data_until, new Date(FIXED).toISOString());

  // ---- Lỗi: ném, không gọi RPC nạp, cùng thông điệp với web ----
  const fails = [
    ["trang lặp", makeHistory(1200), { repeat: true, noTotal: true }, /WMS trả lặp lại cùng một trang lịch sử/],
    ["tổng đổi giữa trang", makeHistory(1300), { driftAt: 2 }, /Phạm vi lịch sử WMS thay đổi trong lúc đọc/],
    ["đọc thiếu dòng", makeHistory(1300), { shortAt: 2 }, /Đọc được 1297\/1300 dòng lịch sử WMS/],
    ["ngoài kho MTG", makeHistory(10), { warehouseId: "1339" }, /ngoài phạm vi kho WH - MATERIAL - MTG/],
    ["tab lỗi", makeHistory(1300), { failAt: 2 }, /Phiên WMS hết hạn/],
  ];
  for (const [label, source, opts, pattern] of fails) {
    const web = await runWeb(source, opts, null), mine = await runCore(source, opts, null);
    assert.match(String(mine.error), pattern, `${label}: core ném đúng lỗi`);
    assert.equal(mine.error, web.error, `${label}: cùng thông điệp với web`);
    assert.equal(imports(mine.rpcs).length, 0, `${label}: không gọi RPC nạp`);
    assert.equal(imports(web.imports).length, 0, `${label}: web cũng không nạp`);
    cases += 1;
  }
  const tab = await runCore(makeHistory(10), { failAt: 1 }, null);
  assert.equal(tab.thrown.code, "WMS_AUTH", "giữ mã lỗi của tab cho auto-sync phân loại");

  // ---- Bước nguồn phiếu lỗi SAU khi nạp: nạp Cut vẫn giữ (lượt sau ghép lại); core ném kèm câu "Đã nạp …" + mã lỗi tab, web báo vàng ----
  {
    const src = makeHistory(40), opts = { world: sourceWorld(src), failType: "GET_STOCK_IMPORT_EXPORT_PAGE" };
    const web = await runWeb(src, opts, null), mine = await runCore(src, opts, null);
    assert.equal(imports(mine.rpcs).length, 1, "core đã nạp Cut trước bước nguồn");
    assert.equal(imports(web.imports).length, 1, "web đã nạp Cut trước bước nguồn");
    assert.match(String(mine.error), /^Đã nạp \d+ dòng Cut; chưa gán được nguồn phiếu: Phiên WMS đã hết hạn/);
    assert.deepEqual([mine.thrown.code, mine.thrown.reason], ["WMS_AUTH", "session"], "giữ mã + lý do lỗi tab");
    assert.equal(mine.thrown.result.cutRows, imports(mine.rpcs)[0].args.p_rows.length, "lỗi mang kết quả phần đã nạp");
    assert.equal(named(mine.rpcs, "wms_group_uid_cut_set_source").length, 0);
    assert.equal(web.error, null, "web không báo đỏ: Cut đã nạp");
    assert.match(web.last.text, /^Đã đọc .*Chưa gán được nguồn phiếu: Phiên WMS đã hết hạn/);
    assert.equal(web.last.tone, "warn");
    // Phiếu chưa tra được số (notFound > 0) → web cảnh báo, câu cùng cấu trúc với tóm tắt tự động (vòng 2)
    const partWorld = sourceWorld(src);
    delete partWorld.info.it[Object.keys(partWorld.info.it)[0]];
    const part = await runWeb(src, { world: partWorld }, null), partCore = await runCore(src, { world: partWorld }, null);
    const ps = partCore.result.source;
    assert.deepEqual([ps.adj, ps.it, ps.notFound], [2, 1, 1]);
    assert.ok(part.last.text.endsWith(` Nguồn phiếu: đã gán 3 · còn chưa nguồn ${ps.unresolved - 3} · 1 phiếu chưa tra được số.`), part.last.text);
    assert.equal(part.last.tone, "warn", "còn phiếu chưa tra được số: cảnh báo");
    // Không có Cut chưa nguồn → không đọc Import/Export
    const quiet = await runCore(src, { world: EMPTY_WORLD }, null);
    assert.equal(quiet.error, null, quiet.error);
    assert.deepEqual(quiet.calls.map(c => c.type).filter(t => t !== "GET_GROUP_UID_HISTORY_PAGE"), []);
    assert.equal(quiet.result.source.unresolved, 0);
    // Web với Extension cũ (chưa có GET_WMS_DOC_INFO): bỏ bước nguồn, không gọi lệnh mới (cầu nối cũ im lặng tới hết giờ chờ)
    const old = await runWeb(src, { world: sourceWorld(src), extVersion: "0.11.0" }, null);
    assert.equal(old.error, null);
    assert.equal(imports(old.imports).length, 1);
    assert.deepEqual(old.imports.map(r => r.name).filter(n => n !== "wms_group_uid_cut_import"), [], "không gọi RPC nguồn");
    assert.deepEqual(old.calls.map(c => c.type).filter(t => t !== "GET_GROUP_UID_HISTORY_PAGE"), [], "không gửi lệnh tab mới");
    assert.match(old.last.text, /Nguồn phiếu: cần Extension ≥ 0\.12\.0/);
    // Thiếu bộ ghép trong service worker (Extension nạp thiếu tệp) → ném sau khi nạp, nói rõ cần Reload
    const missing = await runCore(src, { world: sourceWorld(src) }, null, { sourceCore: {} });
    assert.match(String(missing.error), /^Đã nạp \d+ dòng Cut; .*Reload Extension/);
    // Khung giờ (review 26/10/2026, A2a): bước nguồn đọc Import/Export tới đúng mốc `to` của lượt đọc lịch sử Cut vừa nạp, không tới giờ
    // hiện tại — phiếu tạo sau mốc mà Cut của nó chưa nạp không được lấy Cut cũ đang tự do. Đồng hồ chạy thêm 10 phút trước bước nguồn.
    let ticks = 0;
    const late = await runCore(src, { world: sourceWorld(src) }, null, { now: () => (ticks++ ? FIXED + 10 * 60000 : FIXED) });
    assert.equal(late.error, null, late.error);
    const histTo = Date.parse(late.calls.find(c => c.type === "GET_GROUP_UID_HISTORY_PAGE").payload.to);
    assert.equal(histTo, FIXED);
    assert.deepEqual(late.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").map(c => c.payload.to), [histTo], "core: Import/Export tới mốc to của lịch sử Cut");
    const lateWeb = await runWeb(src, { world: sourceWorld(src), dateNow: FIXED + 10 * 60000 }, null);
    assert.equal(lateWeb.error, null, lateWeb.error);
    assert.deepEqual(lateWeb.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").map(c => c.payload.to), [Date.parse(lateWeb.calls.find(c => c.type === "GET_GROUP_UID_HISTORY_PAGE").payload.to)], "web: Import/Export tới mốc to của lịch sử Cut");
    assert.deepEqual(lateWeb.calls.map(c => c.payload), late.calls.map(c => c.payload), "web và core cùng payload khi đồng hồ chạy tiếp");
    console.log("cut_adj_core bước nguồn phiếu: lỗi sau khi nạp giữ phần nạp, không Cut chưa nguồn → không đọc thêm, web + Extension cũ bỏ bước, Import/Export tới mốc to của lịch sử (web + core), câu nguồn «đã gán · còn chưa nguồn» như tóm tắt tự động (phiếu chưa tra được số → cảnh báo): PASS");
  }

  // MAX 400 trang: API trả trang đầy mãi (không tổng, mỗi trang khác nhau)
  let endless = 0;
  const sendEndless = async (type, payload) => {
    endless += 1;
    const t = Date.UTC(2026, 9, 1) + payload.page * 1000;
    return { page: payload.page, size: 500, total: 500, totalPages: 1, rows: [{ group_uid_code: "1028260000000001", cut_at: iso(t), qty: 1, remaining_qty: 0, sku: "900000001", cut_by: null, warehouse: null }], sourceRows: 500, rangeFrom: iso(t), rangeTo: iso(t), warehouseId: "1177" };
  };
  const rpcsEndless = [];
  await assert.rejects(core.run({ sendTab: sendEndless, rpc: async (name, args) => { rpcsEndless.push(name); return name === "wms_cut_coverage" ? null : importResult(args); }, device: "may-test-01", now: () => FIXED }),
    /Lịch sử WMS vượt 400 trang/);
  assert.equal(endless, 400);
  assert.deepEqual(rpcsEndless, ["wms_cut_coverage"]);
  cases += 1;

  // Kiểu dữ liệu tab sai, RPC lỗi, tên máy lạ
  await assert.rejects(core.run({ sendTab: async () => null, rpc: async () => null, device: "x", now: () => FIXED }), /không hợp lệ/);
  await assert.rejects(core.run({ sendTab: async () => ({ warehouseId: "1177", rows: "abc", sourceRows: 1, total: 1, totalPages: 1 }), rpc: async () => null, device: "x", now: () => FIXED }), /không hợp lệ/);
  await assert.rejects(core.run({ sendTab: makeWms(small).send, rpc: async name => { if (name === "wms_cut_coverage") return null; throw new Error("Chỉ Admin được nạp file lịch sử WMS"); }, device: "x", now: () => FIXED }), /Chỉ Admin/);
  await assert.rejects(core.run({ sendTab: makeWms(small).send, rpc: async () => ({ until: "không phải ngày" }), device: "x", now: () => FIXED }), /Mốc phủ lịch sử WMS không hợp lệ/);
  assert.equal(core.fileName("Máy kho #1 (tầng 2)", "20261022031530", 0, 1), "WMS_AUTO_Mykho1tng2_20261022031530.json");
  assert.equal(core.fileName("", "20261022031530", 1, 2), "WMS_AUTO_EXT_20261022031530_2.json");
  assert.equal(core.fileName("a".repeat(50), "20261022031530", 0, 1), `WMS_AUTO_${"a".repeat(30)}_20261022031530.json`);
  console.log(`cut_adj_core: ${cases} ca so khớp/lỗi với mã web syncFromWms (gồm bước nguồn phiếu), tên tệp WMS_AUTO_, MAX 400 trang`);
})().catch(error => { console.error(error); process.exit(1); });
