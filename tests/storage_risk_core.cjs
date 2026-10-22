// Lõi tự động RỦI RO LƯU TRỮ (extension/inside-po-connector/storage-risk-core.js, Extension 0.10.7): Kiểm kê 2 kho (sku_count_save_*)
// rồi UID tạm (uid_temp_save), như nút sr-run trên web (run của <script id="inventory-audit-script"> rồi run của
// <script id="storage-risk-temp-script">). So với CHÍNH mã web: cắt các hàm đó từ index.html, chạy trong vm với Extension/Supabase giả,
// cùng dữ liệu giả (SKU 9000000xx, mã phiếu 1001260000000xxx) → chuỗi lệnh WMS và payload RPC phải giống hệt.
//   node tests/storage_risk_core.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const core = require("../extension/inside-po-connector/storage-risk-core.js");

const FIXED = Date.UTC(2026, 9, 22, 3, 15, 30, 123);
const DAY = 86400000;
const HTML = fs.readFileSync("index.html", "utf8").replace(/\r\n/g, "\n");
const slice = (start, from, to) => {
  const s = HTML.indexOf(start);
  assert.ok(s >= 0, `index.html có ${start}`);
  const a = HTML.indexOf(from, s);
  assert.ok(a >= 0, `index.html có neo ${from}`);
  const b = HTML.indexOf(to, a);
  assert.ok(b > a, `index.html có neo ${to}`);
  return HTML.slice(a, b);
};
const IA = '<script id="inventory-audit-script">', SRT = '<script id="storage-risk-temp-script">';
const WEB_AUDIT = [
  slice(IA, "const requestedWarehouses=", "const TABS="),
  slice(IA, "function parseDate(value){", "function extensionRequest(type,payload={},timeout=180000){"),
  slice(IA, "async function readPages(type,payload,label){", "const keyOf=r=>"),
  slice(IA, "async function run(){", "// ---- Admin: đăng nhập bằng hộp dùng chung"),
].join("\n");
const WEB_TEMP = [
  slice(SRT, 'const ROUTE="storage-risk",DAY=86400000,RANGE_DAYS=90', "const FILTERS="),
  slice(SRT, "async function saveRun(now){", "const list=UI.createList("),
  slice(SRT, "const shortWh=n=>", 'function say(text,tone=""){'),
  slice(SRT, "async function readPages(type,payload,label){", "// ---- Hiển thị ----"),
  slice(SRT, "const daysOf=(r,now)=>", "const countOf="),
  slice(SRT, "async function run(){", "// Bấm ở tab này:"),
].join("\n");

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [FIXED])); }
  static now() { return FIXED; }
}

// ---- WMS giả (cùng dạng dữ liệu wms-bridge trả: inventory-audit-core.js) ----
const MTG = { warehouseId: 1177, warehouseName: "WH - MATERIAL - MTG", companyId: 1002, companyName: "Cty Mastige" };
const GAR = { warehouseId: 1339, warehouseName: "WH - MATERIAL - GARMENT", companyId: 1005, companyName: "Cty Garment" };
const vnAgo = days => `${new Date(FIXED - days * DAY + 7 * 3600000).toISOString().slice(0, 19)}+07:00`;
const wmsAgo = days => vnAgo(days).slice(0, 19).replace("T", " ");
function inventoryOf(wh) {
  if (wh.warehouseId === GAR.warehouseId) return [
    { warehouseId: 1339, warehouseName: GAR.warehouseName, sku: "900000090", productName: "Chỉ mẫu/Cuộn", location: "G-01", qty: 2, total: 2, modified: wmsAgo(3), created: wmsAgo(40), uom: "cuộn" },
    { warehouseId: 1339, warehouseName: GAR.warehouseName, sku: "900000091", productName: "Chỉ giữ chỗ", location: "G-02", qty: 0, total: 4, modified: wmsAgo(1), created: wmsAgo(9), uom: "cuộn" },
  ];
  const rows = [];
  for (let i = 0; i < 640; i += 1) {
    const sku = String(900000100 + i);
    rows.push({ warehouseId: 1177, warehouseName: MTG.warehouseName, sku, productName: `Vải mẫu ${i}/Cuộn`, location: `F0-A${i % 9}-01-01-01-0${i % 3}`, qty: 1 + (i % 4), total: 1 + (i % 4) + (i % 5 === 0 ? 2 : 0), modified: wmsAgo(i % 50), created: wmsAgo(60), uom: "m" });
    if (i % 10 === 0) rows.push({ warehouseId: 1177, warehouseName: MTG.warehouseName, sku, productName: `Vải mẫu ${i}/Cuộn`, location: "F0-00-00-00-00-00", qty: 0.5, total: 0.5, modified: wmsAgo(2), created: wmsAgo(5), uom: "m" });
  }
  rows.push({ warehouseId: 1177, warehouseName: MTG.warehouseName, sku: "900000099", productName: "Vải giữ chỗ", location: "F0-B1-01-01-01-01", qty: 0, total: 7, modified: wmsAgo(4), created: wmsAgo(8), uom: "m" });
  return rows;
}
function approvedOf(wh) {
  if (wh.warehouseId === GAR.warehouseId) return [];
  return [
    { warehouseId: 1177, warehouseName: MTG.warehouseName, sku: "900000100", productName: "Vải mẫu 0/Cuộn", approvedAt: wmsAgo(10), approvedBy: "kiemke@example.test" },
    { warehouseId: 1177, warehouseName: MTG.warehouseName, sku: "900000100", productName: "Vải mẫu 0/Cuộn", approvedAt: wmsAgo(45), approvedBy: "cu@example.test" },
    { warehouseId: 1177, warehouseName: MTG.warehouseName, sku: "900000101", productName: "Vải mẫu 1/Cuộn", approvedAt: vnAgo(45), approvedBy: "kiemke@example.test" },
  ];
}
function movesOf(wh) {
  const base = { sourceType: "ADJUSTMENT", reason: "Tạo UID Temp", kind: "in", createdBy: "api@example.test", balance: 100 };
  if (wh.warehouseId === GAR.warehouseId) return [
    { ...base, id: 5, warehouseId: 1339, sku: "900000013", productName: "Sợi mẫu ba/Cuộn", qty: 2, sourceCode: "1001260000000013", mappingId: "1001260000000004", createdAt: vnAgo(5) },
    { ...base, id: 6, warehouseId: 1339, sku: "900000017", productName: "Nhiễu: lý do khác", reason: "Xuất test", qty: 6, sourceCode: "1001260000000017", createdAt: vnAgo(1) },
  ];
  return [
    { ...base, id: 1, warehouseId: 1177, sku: "900000012", productName: "Vải mẫu hai/Cuộn", qty: 8, sourceCode: "1001260000000012", mappingId: "1001260000000002", createdAt: vnAgo(20) },
    { ...base, id: 2, warehouseId: 1177, sku: "900000011", productName: "Vải mẫu một/Cuộn", qty: 25.5, sourceCode: "1001260000000001", mappingId: "1001260000000003", createdAt: vnAgo(1) },
    { ...base, id: 3, warehouseId: 1177, sku: "900000019", productName: "Nhiễu: xuất", kind: "out", qty: 3, sourceCode: "1001260000000019", createdAt: vnAgo(2) },
    { ...base, id: 4, warehouseId: 1177, sku: "900000018", productName: "Nhiễu: nguồn khác", sourceType: "PURCHASE_ORDER", qty: 4, sourceCode: "1001260000000018", createdAt: vnAgo(2) },
    { ...base, id: 7, warehouseId: 1177, sku: "900000021", productName: "Vải mẫu bốn/Cuộn", qty: 1, sourceCode: "1001260000000021", mappingId: "1001260000000005", createdAt: "2026-10-21 09:00:00" },
    { ...base, id: 2, warehouseId: 1177, sku: "900000011", productName: "Vải mẫu một/Cuộn (trùng id ở trang sau)", qty: 25.5, sourceCode: "1001260000000001", mappingId: "1001260000000003", createdAt: vnAgo(1) },
    { ...base, id: 8, warehouseId: 1177, sku: "900000022", productName: "Không có giờ", qty: 1, sourceCode: "1001260000000022", mappingId: "1001260000000006", createdAt: "" },
  ];
}
// opts: noGarment, fail {TYPE: message}, failAll, driftType (TYPE: trang 2 đổi totalPages), emptyInventory, shortTotal {id: total}
function makeWms(opts = {}) {
  const calls = [];
  const pageOf = (rows, page, perPage) => rows.slice((page - 1) * perPage, page * perPage);
  const send = async (type, payload) => {
    calls.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    if (opts.failAll || opts.fail?.[type]) { const e = new Error(opts.fail?.[type] || "Không có tab WMS"); e.code = opts.failAll ? "WMS_TAB_MISSING" : "MOCK"; throw e; }
    if (type === "GET_SKU_COUNT_WAREHOUSES") return { warehouses: opts.noGarment ? [MTG] : [MTG, GAR], missingNames: opts.noGarment ? ["WH - MATERIAL - GARMENT"] : [] };
    const wh = [MTG, GAR].find(w => w.warehouseId === payload.warehouseIds[0]);
    const source = type === "GET_SKU_COUNT_INVENTORY_PAGE" ? (opts.emptyInventory ? [] : inventoryOf(wh)) : type === "GET_SKU_COUNT_APPROVED_PAGE" ? approvedOf(wh) : movesOf(wh);
    // Chia trang nhỏ (300 / 4 dòng) để có nhiều trang và lô song song; WMS thật 500 dòng/trang.
    const perPage = type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? 4 : 300;
    let totalPages = Math.max(1, Math.ceil(source.length / perPage));
    if (opts.driftType === type && payload.page === 2) totalPages += 1;
    const total = opts.shortTotal?.[wh.warehouseId] && type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? opts.shortTotal[wh.warehouseId] : source.length;
    return { page: payload.page, size: payload.size, total, totalPages, rows: pageOf(source, payload.page, perPage) };
  };
  return { send, calls };
}
const rpcResult = (name, args) => (name === "sku_count_save_start" ? { runId: "run-new" } : name === "sku_count_save_chunk" ? { saved: args.p_rows.length }
  : name === "sku_count_save_finish" ? { runId: "run-new", rowCount: 1 } : name === "uid_temp_save" ? { runId: "tmp-1", rowCount: args.p_rows.length } : null);
const clone = value => JSON.parse(JSON.stringify(value));

// ---- Mã web trong vm: Kiểm kê (run của inventory-audit-script) rồi UID tạm (run của storage-risk-temp-script) ----
async function runWeb(opts = {}) {
  const wms = makeWms(opts), rpcs = [], said = { audit: [], temp: [] };
  const rpc = async (name, args) => {
    rpcs.push({ name, args: clone(args) });
    if (opts.rpcFail?.[name]) throw new Error(opts.rpcFail[name]);
    return rpcResult(name, args);
  };
  const ext = (type, payload) => (type === "PING_WMS" ? Promise.resolve({ version: "0.10.7" }) : wms.send(type, payload));
  const num = v => Number(v || 0).toLocaleString("vi-VN");
  const audit = vm.runInContext(`const DAY=86400000;const state={busy:false,admin:true};
    ${WEB_AUDIT}; run`, vm.createContext({
    Date: FixedDate, console, Promise, Map, Number, String, Math, Array,
    setBusy() {}, progress() {}, async checkExtension() {}, async load() {}, num,
    say: (text, tone) => said.audit.push({ text, tone }), $: () => ({ dataset: {}, textContent: "" }),
    extensionRequest: ext, adminRpc: rpc,
  }));
  await audit();
  const temp = vm.runInContext(`const state={rows:[],warehouses:[],warn:[],scanned:0,pages:0,readAt:0,filter:"all",busy:false,admin:true,loaded:false};
    let fetched=false,loadGen=0,readFailed=false,fromSaved=false;
    ${WEB_TEMP}; run`, vm.createContext({
    Date: FixedDate, console, Promise, Set, Number, String, Math, Array,
    window: { PrintSkuAdminAccess: { getToken: async () => "test-admin-token" }, PrintSkuAdminAuth: { accessToken: async () => "test-admin-token" } },
    setBusy() {}, syncAdmin() {}, reset() {}, render() {}, load() {}, num,
    say: (text, tone) => said.temp.push({ text, tone }), ext, rpcCall: (name, args) => rpc(name, args),
  }));
  await temp();
  const err = list => list.find(s => s.tone === "error")?.text || null;
  return { calls: wms.calls.filter(c => c.type !== "PING_WMS"), rpcs, auditError: err(said.audit), tempError: err(said.temp), said };
}
async function runCore(opts = {}) {
  const wms = makeWms(opts), rpcs = [], progress = [];
  const rpc = async (name, args) => {
    rpcs.push({ name, args: clone(args) });
    if (opts.rpcFail?.[name]) throw new Error(opts.rpcFail[name]);
    return rpcResult(name, args);
  };
  try {
    const result = await core.run({ sendTab: wms.send, rpc, now: () => FIXED, onProgress: p => progress.push(p) });
    return { result, calls: wms.calls, rpcs, progress, error: null };
  } catch (error) {
    return { result: error.result || null, calls: wms.calls, rpcs, progress, error };
  }
}
const names = list => list.map(r => r.name);

(async () => {
  let cases = 0;
  const compare = async (label, opts) => {
    const web = await runWeb(opts), mine = await runCore(opts);
    assert.deepEqual(mine.calls, web.calls, `${label}: cùng chuỗi lệnh WMS (loại + payload)`);
    assert.deepEqual(mine.rpcs, web.rpcs, `${label}: cùng chuỗi RPC + payload`);
    cases += 1;
    return { web, mine };
  };

  // 1. Đủ 2 kho: Kiểm kê lưu start → 2 chunk (> 500 SKU) → finish, rồi UID tạm lưu
  const ok = await compare("đủ 2 kho", {});
  assert.equal(ok.web.auditError, null, ok.web.auditError);
  assert.equal(ok.web.tempError, null, ok.web.tempError);
  assert.equal(ok.mine.error, null, ok.mine.error && ok.mine.error.message);
  assert.deepEqual(names(ok.mine.rpcs), ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish", "uid_temp_save"]);
  const start = ok.mine.rpcs[0].args;
  assert.deepEqual(start.p_warehouses, [{ warehouseId: 1177, warehouseName: MTG.warehouseName, companyName: "Cty Mastige" }, { warehouseId: 1339, warehouseName: GAR.warehouseName, companyName: "Cty Garment" }]);
  assert.equal(start.p_source_counts.heldTotal, 2, "dòng In-BIN 0 nhưng tổng > 0 vào held");
  const saved = ok.mine.rpcs.filter(r => r.name === "sku_count_save_chunk").flatMap(r => r.args.p_rows);
  assert.equal(saved.length, 641);
  assert.deepEqual(saved.find(r => r.sku === "900000100").locations.map(l => l.location), ["F0-A0-01-01-01-00", "F0-00-00-00-00-00"]);
  const temp = ok.mine.rpcs.at(-1).args;
  assert.deepEqual(temp.p_rows.map(r => r.sku), ["900000011", "900000021", "900000013", "900000012", "900000022"], "lọc Tạo UID Temp, bỏ trùng id, mới nhất trước, thiếu giờ cuối");
  assert.equal(temp.p_run.readAt, new Date(FIXED).toISOString());
  assert.equal(temp.p_run.rangeDays, 90);
  assert.equal(ok.mine.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE")[0].payload.from, FIXED - 90 * DAY);
  const r = ok.mine.result;
  assert.equal(r.ok, true);
  assert.deepEqual(r.skuCount, { ok: true, runId: "run-new", rows: 641, summary: r.skuCount.summary, warehouses: [MTG.warehouseName, GAR.warehouseName], missing: [], stockRows: 707, approvedRows: 3, held: 2 });
  assert.deepEqual(r.skuCount.summary, { total: 641, never: 639, overdue: 1, recent: 1, qty: r.skuCount.summary.qty });
  assert.deepEqual(r.uidTemp, { ok: true, runId: "tmp-1", rows: 5, scanned: 9, pages: 3, warn: [], readAt: new Date(FIXED).toISOString() });
  assert.ok(ok.mine.progress.some(p => p.step === "skuCount") && ok.mine.progress.some(p => p.step === "uidTemp"), "báo tiến độ hai bước");

  // 2. Thiếu kho Garment: vẫn đồng bộ MTG, cảnh báo như web
  const one = await compare("thiếu Garment", { noGarment: true });
  assert.equal(one.mine.error, null);
  assert.deepEqual(one.mine.result.skuCount.missing, ["WH - MATERIAL - GARMENT"]);
  assert.deepEqual(one.mine.result.uidTemp.warn, ["Chưa đọc được kho: WH - MATERIAL - GARMENT"]);

  // 3. WMS báo nhiều dòng nhập xuất hơn số đọc được → cảnh báo trong bản lưu, như web
  const gap = await compare("WMS báo thiếu dòng", { shortTotal: { 1339: 5 } });
  assert.deepEqual(gap.mine.result.uidTemp.warn, ["WH - MATERIAL - GARMENT: WMS báo 5 dòng, đọc được 2"]);

  // ---- Lỗi: cùng thông điệp, cùng điều kiện dừng như web; core ném sau khi chạy đủ 2 bước ----
  const fails = [
    // tab lỗi ngay từ đầu: không ghi gì
    ["tab lỗi", { failAll: true }, /Không có tab WMS/, /Không có tab WMS/, []],
    // tồn kho đổi giữa trang: Kiểm kê dừng, không ghi; UID tạm vẫn chạy và lưu (như web)
    ["tồn kho đổi giữa trang", { driftType: "GET_SKU_COUNT_INVENTORY_PAGE" }, /Tồn kho theo vị trí · WH - MATERIAL - MTG · Cty Mastige thay đổi trong lúc đọc/, null, ["uid_temp_save"]],
    // Kiểm kê không có SKU nào: giữ bản cũ
    ["không có tồn", { emptyInventory: true }, /WMS không trả SKU nào có tồn kho; giữ nguyên bản đồng bộ cũ/, null, ["uid_temp_save"]],
    // đọc nhập xuất lỗi: Kiểm kê đã lưu, UID tạm không lưu
    ["nhập xuất lỗi", { fail: { GET_STOCK_IMPORT_EXPORT_PAGE: "Phiên WMS hết hạn" } }, null, /Phiên WMS hết hạn/, ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish"]],
    // nhập xuất đổi giữa trang
    ["nhập xuất đổi giữa trang", { driftType: "GET_STOCK_IMPORT_EXPORT_PAGE" }, null, /MTG nhập xuất thay đổi trong lúc đọc/, ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish"]],
    // Supabase lỗi khi ghi Kiểm kê / UID tạm
    ["ghi Kiểm kê lỗi", { rpcFail: { sku_count_save_chunk: "Chỉ Admin được đồng bộ kiểm kê" } }, /^Chưa lưu được bản đồng bộ: Chỉ Admin được đồng bộ kiểm kê$/, null, ["sku_count_save_start", "sku_count_save_chunk", "uid_temp_save"]],
    ["mất mạng khi ghi", { rpcFail: { sku_count_save_start: "Failed to fetch" } }, /mất kết nối tới Supabase, kiểm tra mạng rồi bấm lại/, null, ["sku_count_save_start", "uid_temp_save"]],
    ["ghi UID tạm lỗi", { rpcFail: { uid_temp_save: "Chỉ Admin được lưu UID tạm" } }, null, /^Đã đọc 5 dòng nhưng chưa lưu được: Chỉ Admin được lưu UID tạm$/, ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish", "uid_temp_save"]],
  ];
  for (const [label, opts, auditPattern, tempPattern, rpcNames] of fails) {
    const { web, mine } = await compare(label, opts);
    assert.ok(mine.error, `${label}: core ném`);
    assert.equal(mine.result.ok, false);
    assert.deepEqual(names(mine.rpcs), rpcNames, `${label}: chỉ ghi phần chạy được`);
    for (const [part, pattern, webError] of [["skuCount", auditPattern, web.auditError], ["uidTemp", tempPattern, web.tempError]]) {
      const got = mine.result[part];
      if (pattern) {
        assert.equal(got.ok, false, `${label}: ${part} lỗi`);
        assert.match(got.error, pattern, `${label}: ${part} đúng thông điệp`);
        assert.equal(got.error, webError, `${label}: ${part} cùng thông điệp với web`);
        assert.ok(mine.error.message.includes(got.error), `${label}: lỗi ném gồm thông điệp ${part}`);
      } else {
        assert.equal(got.ok, true, `${label}: ${part} vẫn chạy (${got.error})`);
        assert.equal(webError, null, `${label}: web ${part} cũng không lỗi`);
      }
    }
  }
  const tab = await runCore({ failAll: true });
  assert.equal(tab.error.code, "WMS_TAB_MISSING", "giữ mã lỗi tab đầu tiên cho auto-sync phân loại");
  assert.equal(tab.error.fromTab, undefined);
  await assert.rejects(core.run({ sendTab: async () => null, rpc: async () => null, now: () => FIXED }), /không hợp lệ/);
  await assert.rejects(core.run({}), /Thiếu hàm/);
  console.log(`storage_risk_core: ${cases} ca so khớp chuỗi lệnh WMS + payload RPC với mã web (Kiểm kê + UID tạm), lỗi dừng đúng bước`);
})().catch(error => { console.error(error); process.exit(1); });
