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
  // Neo không kèm ")" để nhận cả bản web có tham số exact (D2, 0.10.8).
  slice(IA, "async function readPages(type,payload,label", "const keyOf=r=>"),
  // run(opts): sr-run / srt-run truyền opts.enrich (nguồn Hàng chưa lên kệ, 26/10/2026); nút Kiểm kê gọi run(event) như cũ.
  slice(IA, "async function run(", "// ---- Admin: đăng nhập bằng hộp dùng chung"),
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
    // 64 cặp SKU × vị trí ảo (> 60/lượt): cặp 900000100 cũ nhất nên được đọc nguồn trước (Hàng chưa lên kệ, 26/10/2026).
    if (i % 10 === 0) rows.push({ warehouseId: 1177, warehouseName: MTG.warehouseName, sku, productName: `Vải mẫu ${i}/Cuộn`, location: "F0-00-00-00-00-00", qty: 0.5, total: 0.5, modified: wmsAgo(i === 0 ? 200 : 2), created: wmsAgo(i === 0 ? 210 : 5), uom: "m" });
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
  // Phiếu gốc của UID tạm (26/10/2026): dòng XUẤT (kind out) có sourceCode = mappingId của dòng "Tạo UID Temp" — ba loại IT / ADJ / lệnh sản xuất.
  const out = { kind: "out", balance: 0, reason: "", approvedBy: "" };
  if (wh.warehouseId === GAR.warehouseId) return [
    { ...base, id: 5, warehouseId: 1339, sku: "900000013", productName: "Sợi mẫu ba/Cuộn", qty: 2, sourceCode: "1001260000000013", mappingId: "1001260000000004", createdAt: vnAgo(5) },
    { ...base, id: 6, warehouseId: 1339, sku: "900000017", productName: "Nhiễu: lý do khác", reason: "Xuất test", qty: 6, sourceCode: "1001260000000017", createdAt: vnAgo(1) },
    { ...out, id: 34, warehouseId: 1339, sku: "900000013", productName: "Sợi mẫu ba/Cuộn", qty: 2, sourceType: "WORK_ORDER", sourceCode: "1001260000000004", mappingId: "1601260000000004-1", fromWarehouse: GAR.warehouseName, toWarehouse: "XƯỞNG GIẢ", createdBy: "sx@example.test", createdAt: vnAgo(5.2) },
  ];
  return [
    { ...base, id: 1, warehouseId: 1177, sku: "900000012", productName: "Vải mẫu hai/Cuộn", qty: 8, sourceCode: "1001260000000012", mappingId: "1001260000000002", createdAt: vnAgo(20) },
    { ...base, id: 2, warehouseId: 1177, sku: "900000011", productName: "Vải mẫu một/Cuộn", qty: 25.5, sourceCode: "1001260000000001", mappingId: "1001260000000003", createdAt: vnAgo(1) },
    { ...base, id: 3, warehouseId: 1177, sku: "900000019", productName: "Nhiễu: xuất", kind: "out", qty: 3, sourceCode: "1001260000000019", createdAt: vnAgo(2) },
    { ...base, id: 4, warehouseId: 1177, sku: "900000018", productName: "Nhiễu: nguồn khác", sourceType: "PURCHASE_ORDER", qty: 4, sourceCode: "1001260000000018", createdAt: vnAgo(2) },
    { ...base, id: 7, warehouseId: 1177, sku: "900000021", productName: "Vải mẫu bốn/Cuộn", qty: 1, sourceCode: "1001260000000021", mappingId: "1001260000000005", createdAt: "2026-10-21 09:00:00" },
    { ...base, id: 2, warehouseId: 1177, sku: "900000011", productName: "Vải mẫu một/Cuộn (trùng id ở trang sau)", qty: 25.5, sourceCode: "1001260000000001", mappingId: "1001260000000003", createdAt: vnAgo(1) },
    { ...base, id: 8, warehouseId: 1177, sku: "900000022", productName: "Không có giờ", qty: 1, sourceCode: "1001260000000022", mappingId: "1001260000000006", createdAt: "" },
    // IT: một phiếu nhiều dòng (gộp theo SKU), có người duyệt; dòng trùng id ở trang sau không cộng hai lần
    { ...out, id: 30, warehouseId: 1177, sku: "900000011", qty: 25.5, sourceType: "INTERNAL_TRANSFER", sourceCode: "1001260000000003", mappingId: "10022600000003", fromWarehouse: MTG.warehouseName, toWarehouse: "KHO NHẬN GIẢ", createdBy: "it@example.test", approvedBy: "duyet.it@example.test", createdAt: vnAgo(1.1) },
    { ...out, id: 31, warehouseId: 1177, sku: "900000014", qty: 3, sourceType: "INTERNAL_TRANSFER", sourceCode: "1001260000000003", mappingId: "10022600000003", fromWarehouse: MTG.warehouseName, toWarehouse: "KHO NHẬN GIẢ", createdBy: "it@example.test", approvedBy: "duyet.it@example.test", createdAt: vnAgo(1.1) },
    { ...out, id: 32, warehouseId: 1177, sku: "900000011", qty: 0.5, sourceType: "INTERNAL_TRANSFER", sourceCode: "1001260000000003", mappingId: "10022600000003", fromWarehouse: MTG.warehouseName, toWarehouse: "KHO NHẬN GIẢ", createdBy: "it@example.test", approvedBy: "duyet.it@example.test", createdAt: vnAgo(1.1) },
    { ...out, id: 30, warehouseId: 1177, sku: "900000011", qty: 25.5, sourceType: "INTERNAL_TRANSFER", sourceCode: "1001260000000003", mappingId: "10022600000003", fromWarehouse: MTG.warehouseName, toWarehouse: "KHO NHẬN GIẢ", createdBy: "it@example.test", approvedBy: "duyet.it@example.test", createdAt: vnAgo(1.1) },
    // ADJ "Xuất test": không có người duyệt → người tạo
    { ...out, id: 33, warehouseId: 1177, sku: "900000012", qty: 8, sourceType: "ADJUSTMENT", reason: "Xuất test", sourceCode: "1001260000000002", mappingId: "100052600000033", fromWarehouse: MTG.warehouseName, toWarehouse: "", createdBy: "kho@example.test", createdAt: vnAgo(20.1) },
    // Phiếu nhập (nguồn Hàng chưa lên kệ): SKU 900000100 có hai lần nhập → lấy lần mới nhất (IT); 900000110 nhập ADJ
    { ...base, id: 40, warehouseId: 1177, sku: "900000100", qty: 50, sourceType: "PURCHASE_ORDER", reason: "", sourceCode: "1001260000000040", mappingId: "10012600000040", createdBy: "nhan@example.test", approvedBy: "duyet.nhan@example.test", createdAt: vnAgo(40) },
    { ...base, id: 41, warehouseId: 1177, sku: "900000100", qty: 5, sourceType: "INTERNAL_TRANSFER", reason: "", sourceCode: "1001260000000041", mappingId: "10022600000041", createdBy: "api@example.test", createdAt: vnAgo(3) },
    { ...base, id: 42, warehouseId: 1177, sku: "900000110", qty: 2, sourceType: "ADJUSTMENT", reason: "Điều chỉnh kiểm kê", sourceCode: "1001260000000042", mappingId: "100052600000042", createdBy: "kk@example.test", createdAt: vnAgo(8) },
  ];
}
// Transfer Location History giả (GET_TRANSFER_BIN_PAGE): dòng đã chuẩn hoá như wms-bridge trả (uid đã tra / "" khi không ra).
function transfersOf(payload) {
  if (payload.warehouseId !== 1177 || payload.binIn !== "F0-00-00-00-00-00" || payload.sku !== "900000100") return { page: 1, size: payload.size, total: 0, totalPages: 1, rows: [], sourceRows: 0 };
  const row = (id, type, by, days, uidId, uid) => ({ id, sku: "900000100", qty: 0.5, from: "F0-KHO-01-01-01-01", to: "F0-00-00-00-00-00", type, by, at: wmsAgo(days), uidId, uid });
  return { page: 1, size: payload.size, total: 25, totalPages: 13, sourceRows: 3, rows: [
    row(501, "EDIT_UID_GROUP", "cat@example.test", 2, 7001, "1028260000000701"),
    row(502, "", "chuyen@example.test", 4, 7002, ""),
    row(503, "RE_PO", "nhan", 6, null, ""),
  ] };
}
// opts: noGarment, fail {TYPE: message}, failAll, driftType (TYPE: trang 2 đổi totalPages), emptyInventory, shortTotal {id: total},
//   insert {type, times} (D2: sau khi đọc trang 1 kho MTG, có dòng mới chen đầu danh sách — `times` lượt đọc đầu; dòng đã chen thì ở lại),
//   dropRow TYPE (D2: trang 2 kho MTG thiếu 1 dòng dù total không đổi), filtered TYPE (D2: mỗi trang có 1 dòng WMS bị bộ chuẩn hoá lọc bỏ:
//   sourceRows = rows + 1, total = số dòng WMS — không được coi là lệch), manyApproved (APPROVED kho MTG có 2 trang).
// failOnce {TYPE: message}: chỉ lần gọi ĐẦU của lệnh đó lỗi (lỗi tạm thời), các lần sau trả bình thường.
function makeWms(opts = {}) {
  const calls = [], live = new Map(), failedOnce = new Set();
  const pageOf = (rows, page, perPage) => rows.slice((page - 1) * perPage, page * perPage);
  const extraRow = (type, n) => type === "GET_SKU_COUNT_APPROVED_PAGE"
    ? { warehouseId: 1177, warehouseName: MTG.warehouseName, sku: `90000095${n}`, productName: `Vải duyệt mới ${n}`, approvedAt: wmsAgo(0), approvedBy: "moi@example.test" }
    : { warehouseId: 1177, warehouseName: MTG.warehouseName, sku: `90000095${n}`, productName: `Vải nhận mới ${n}/Cuộn`, location: "F0-C1-01-01-01-01", qty: 3, total: 3, modified: wmsAgo(0), created: wmsAgo(0), uom: "m" };
  const send = async (type, payload) => {
    calls.push({ type, payload: JSON.parse(JSON.stringify(payload)) });
    if (opts.failAll || opts.fail?.[type]) { const e = new Error(opts.fail?.[type] || "Không có tab WMS"); e.code = opts.failAll ? "WMS_TAB_MISSING" : "MOCK"; throw e; }
    if (opts.failOnce?.[type] && !failedOnce.has(type)) { failedOnce.add(type); const e = new Error(opts.failOnce[type]); e.code = "MOCK"; throw e; }
    if (type === "GET_SKU_COUNT_WAREHOUSES") return { warehouses: opts.noGarment ? [MTG] : [MTG, GAR], missingNames: opts.noGarment ? ["WH - MATERIAL - GARMENT"] : [] };
    // transferThrows: dòng chuyển vị trí làm mã xử lý ném TypeError (giả lập lỗi lập trình ở bước nguồn, không phải lỗi lệnh WMS)
    if (type === "GET_TRANSFER_BIN_PAGE" && opts.transferThrows) return { page: 1, total: 1, totalPages: 1, rows: [{ get type() { throw new TypeError("lỗi giả khi xử lý dòng chuyển vị trí"); } }] };
    if (type === "GET_TRANSFER_BIN_PAGE") return opts.transferNoRows ? { page: 1 } : transfersOf(payload);
    const wh = [MTG, GAR].find(w => w.warehouseId === payload.warehouseIds[0]);
    let source = type === "GET_SKU_COUNT_INVENTORY_PAGE" ? (opts.emptyInventory ? [] : inventoryOf(wh)) : type === "GET_SKU_COUNT_APPROVED_PAGE" ? approvedOf(wh) : movesOf(wh);
    // manyApproved: thêm 400 lần duyệt cũ ở MTG để APPROVED có 2 trang (ca D2).
    if (opts.manyApproved && type === "GET_SKU_COUNT_APPROVED_PAGE" && wh === MTG) source = [...source, ...Array.from({ length: 400 }, (_, i) => ({ warehouseId: 1177, warehouseName: MTG.warehouseName, sku: String(900000200 + i), productName: `Vải mẫu ${100 + i}/Cuộn`, approvedAt: wmsAgo(60 + (i % 30)), approvedBy: "cu@example.test" }))];
    if (opts.insert?.type === type && wh === MTG) {
      const st = live.get(type) || { rows: source, reads: 0, pending: false };
      live.set(type, st);
      if (payload.page === 1) { st.reads += 1; st.pending = st.reads <= opts.insert.times; }
      else if (st.pending) { st.pending = false; st.rows = [extraRow(type, st.reads), ...st.rows]; }
      source = st.rows;
    }
    // Chia trang nhỏ (300 / 4 dòng) để có nhiều trang và lô song song; WMS thật 500 dòng/trang.
    const perPage = type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? 4 : 300;
    let totalPages = Math.max(1, Math.ceil(source.length / perPage));
    if (opts.driftType === type && payload.page === 2) totalPages += 1;
    let total = opts.shortTotal?.[wh.warehouseId] && type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? opts.shortTotal[wh.warehouseId] : source.length;
    let rows = pageOf(source, payload.page, perPage), sourceRows = rows.length;
    if (opts.dropRow === type && wh === MTG && payload.page === 2) { rows = rows.slice(1); sourceRows = rows.length; }
    if (opts.filtered === type) { total += totalPages; sourceRows += 1; }
    // sourceRows = số dòng WMS trả ở trang (trước khi lọc), như inventory-audit-core.js 0.10.8.
    return { page: payload.page, size: payload.size, total, totalPages, rows, sourceRows };
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
  // opts.extVersion: phiên bản Extension trả cho PING_WMS (web kiểm trước khi đọc nguồn); opts.noAdmin: chưa xác minh được Admin.
  const ext = (type, payload) => (type === "PING_WMS" ? Promise.resolve({ version: opts.extVersion || "0.12.4" }) : wms.send(type, payload));
  const num = v => Number(v || 0).toLocaleString("vi-VN");
  const audit = vm.runInContext(`const DAY=86400000;const state={busy:false,admin:true};
    ${WEB_AUDIT}; run`, vm.createContext({
    Date: FixedDate, console, Promise, Map, Number, String, Math, Array,
    setBusy() {}, progress() {}, async checkExtension() {}, async load() {}, num,
    say: (text, tone) => said.audit.push({ text, tone }), $: () => ({ dataset: {}, textContent: "" }),
    extensionRequest: ext, adminRpc: rpc,
  }));
  // sr-run: Kiểm kê đọc xong gọi opts.enrich (= sources của storage-risk-temp-script: đọc Import/Export một lần + Transfer Location
  // History) trước khi lưu; run của UID tạm dùng lại lượt đọc Import/Export đó.
  const temp = vm.runInContext(`const state={rows:[],warehouses:[],warn:[],scanned:0,pages:0,readAt:0,filter:"all",busy:false,admin:true,loaded:false};
    let fetched=false,loadGen=0,readFailed=false,fromSaved=false;
    ${WEB_TEMP}; ({run, sources: typeof sources === "function" ? sources : undefined})`, vm.createContext({
    Date: FixedDate, console, Promise, Set, Map, Number, String, Math, Array, Object,
    window: { PrintSkuAdminAccess: { getToken: async () => (opts.noAdmin ? "" : "test-admin-token") }, PrintSkuAdminAuth: { accessToken: async () => "test-admin-token" } },
    setBusy() {}, syncAdmin() {}, reset() {}, render() {}, load() {}, num,
    say: (text, tone) => said.temp.push({ text, tone }), ext, rpcCall: (name, args) => rpc(name, args),
  }));
  // sources() trả { done, total, reason } (review 26/10/2026) — giữ lại để so với skuCount.sources của Extension.
  let sources;
  await audit({ enrich: temp.sources ? async (payload, warehouses) => (sources = await temp.sources(payload, warehouses)) : undefined });
  await temp.run();
  const err = list => list.find(s => s.tone === "error")?.text || null;
  return { calls: wms.calls.filter(c => c.type !== "PING_WMS"), rpcs, auditError: err(said.audit), tempError: err(said.temp), said, sources: sources === undefined ? undefined : clone(sources) };
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
    if (mine.result?.skuCount?.ok) assert.deepEqual(web.sources, mine.result.skuCount.sources, `${label}: cùng kết quả bước nguồn {done,total,reason}`);
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
  // ---- UID tạm: phiếu gốc (origin) dựng từ dòng xuất cùng mã trong lượt đọc Import/Export (26/10/2026) ----
  const isoOf = s => new Date(Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? `${s.replace(" ", "T")}+07:00` : s)).toISOString();
  assert.deepEqual(Object.keys(temp.p_rows[0]).sort(), ["createdAt", "createdBy", "mappingId", "origin", "productName", "qty", "sku", "sourceCode", "warehouseName", "wh"], "dòng UID tạm gửi thêm origin");
  const origins = Object.fromEntries(temp.p_rows.map(r => [r.sku, r.origin]));
  assert.deepEqual(origins["900000011"], { type: "INTERNAL_TRANSFER", code: "1001260000000003", reason: "", by: "duyet.it@example.test", at: isoOf(vnAgo(1.1)), from: MTG.warehouseName, to: "KHO NHẬN GIẢ", lines: [{ sku: "900000011", qty: 26 }, { sku: "900000014", qty: 3 }] }, "IT: người duyệt, kho đến, các dòng cùng phiếu gộp theo SKU, không cộng dòng trùng id");
  assert.deepEqual(origins["900000012"], { type: "ADJUSTMENT", code: "1001260000000002", reason: "Xuất test", by: "kho@example.test", at: isoOf(vnAgo(20.1)), from: MTG.warehouseName, to: "", lines: [{ sku: "900000012", qty: 8 }] }, "ADJ: lý do; thiếu người duyệt thì người tạo");
  assert.deepEqual(origins["900000013"], { type: "WORK_ORDER", code: "1001260000000004", reason: "", by: "sx@example.test", at: isoOf(vnAgo(5.2)), from: GAR.warehouseName, to: "XƯỞNG GIẢ", lines: [{ sku: "900000013", qty: 2 }] }, "lệnh sản xuất ở kho Garment");
  assert.equal(origins["900000021"], null, "không có dòng xuất cùng mã → origin null");
  assert.equal(origins["900000022"], null);
  // ---- Hàng chưa lên kệ: nguồn của cặp SKU × vị trí ảo lưu trong locations[].sources (26/10/2026) ----
  const loc100 = saved.find(r => r.sku === "900000100").locations;
  assert.equal(loc100[0].sources, undefined, "vị trí kệ thật: không đọc nguồn");
  assert.deepEqual(loc100[1].sources, [
    { kind: "move", type: "EDIT_UID_GROUP", qty: 0.5, by: "cat", at: isoOf(wmsAgo(2)), from: "F0-KHO-01-01-01-01", uid: "1028260000000701", uidId: 7001 },
    { kind: "move", type: "", qty: 0.5, by: "chuyen", at: isoOf(wmsAgo(4)), from: "F0-KHO-01-01-01-01", uid: "", uidId: 7002 },
    { kind: "move", type: "RE_PO", qty: 0.5, by: "nhan", at: isoOf(wmsAgo(6)), from: "F0-KHO-01-01-01-01", uid: "", uidId: null },
    { kind: "in", type: "INTERNAL_TRANSFER", code: "1001260000000041", mapping: "10022600000041", reason: "", by: "api", at: isoOf(vnAgo(3)), qty: 5 },
  ], "lần chuyển vào (mới nhất trước) + phiếu nhập gần nhất của SKU; người chỉ phần trước @ (N1185)");
  assert.equal(loc100[1].movesTotal, 25, "WMS có nhiều lần chuyển hơn số đã lưu");
  const loc110 = saved.find(r => r.sku === "900000110").locations.find(l => l.location === "F0-00-00-00-00-00");
  assert.deepEqual(loc110.sources, [{ kind: "in", type: "ADJUSTMENT", code: "1001260000000042", mapping: "100052600000042", reason: "Điều chỉnh kiểm kê", by: "kk", at: isoOf(vnAgo(8)), qty: 2 }], "không có lần chuyển vào: chỉ còn phiếu nhập");
  assert.equal(loc110.movesTotal, undefined);
  assert.deepEqual(saved.find(r => r.sku === "900000120").locations.find(l => l.location === "F0-00-00-00-00-00").sources, [], "đã đọc mà không có nguồn → mảng rỗng");
  const transfers = ok.mine.calls.filter(c => c.type === "GET_TRANSFER_BIN_PAGE");
  assert.equal(transfers.length, 60, "tối đa 60 cặp SKU × vị trí ảo mỗi lượt");
  assert.deepEqual(transfers[0].payload, { warehouseId: 1177, companyId: 1002, binIn: "F0-00-00-00-00-00", sku: "900000100", page: 1, size: 20 }, "cặp cũ nhất đọc trước; một lời gọi ≤ 20 dòng");
  assert.equal(saved.flatMap(r => r.locations).filter(l => Array.isArray(l.sources)).length, 60);
  assert.ok(saved.every(r => r.locations.every(l => (l.sources || []).every(s => !String(s.by).includes("@")))), "không lưu email đầy đủ vào bản chụp ai cũng xem (N1185)");
  const order = ok.mine.calls.map(c => c.type);
  assert.ok(order.lastIndexOf("GET_STOCK_IMPORT_EXPORT_PAGE") < order.indexOf("GET_TRANSFER_BIN_PAGE"), "đọc Import/Export trước khi đọc chuyển vị trí");
  assert.equal(order.filter(t => t === "GET_SKU_COUNT_WAREHOUSES").length, 2, "Import/Export chỉ đọc một lần cho cả hai bước");
  const r = ok.mine.result;
  assert.equal(r.ok, true);
  // sources (review 26/10/2026): 64 cặp SKU × vị trí ảo, đọc 60 cặp cũ nhất → không im lặng: số cặp + lý do
  assert.deepEqual(r.skuCount, { ok: true, runId: "run-new", rows: 641, summary: r.skuCount.summary, warehouses: [MTG.warehouseName, GAR.warehouseName], missing: [], stockRows: 707, approvedRows: 3, held: 2,
    sources: { done: 60, total: 64, reason: "mỗi lượt chỉ đọc 60 cặp cũ nhất" } });
  assert.deepEqual(ok.web.sources, r.skuCount.sources, "web sources() trả cùng {done,total,reason}");
  assert.deepEqual(r.skuCount.summary, { total: 641, never: 639, overdue: 1, recent: 1, qty: r.skuCount.summary.qty });
  assert.deepEqual(r.uidTemp, { ok: true, runId: "tmp-1", rows: 5, scanned: 18, pages: 5, warn: [], readAt: new Date(FIXED).toISOString() });
  assert.ok(ok.mine.progress.some(p => p.step === "skuCount") && ok.mine.progress.some(p => p.step === "uidTemp"), "báo tiến độ hai bước");

  // ---- D2 (Extension 0.10.8, review 23/10/2026): Kiểm kê đọc trang song song phải khớp total; lệch thì đọc lại ≤ 2 lần rồi ném ----
  // Phần này chỉ chạy lõi Extension; các ca so khớp web tương ứng ở danh sách lỗi bên dưới.
  const MTG_INV = "Tồn kho theo vị trí · WH - MATERIAL - MTG · Cty Mastige";
  const firstPages = (run, type) => run.calls.filter(c => c.type === type && c.payload.page === 1 && c.payload.warehouseIds[0] === 1177).length;
  const savedOf = run => run.rpcs.filter(r => r.name === "sku_count_save_chunk").flatMap(r => r.args.p_rows);
  {
    // Nhận hàng giữa lúc đọc: dòng mới chen đầu danh sách sau trang 1 → dòng ở ranh trang bị đọc 2 lần (cộng đôi tồn), dòng mới bị sót.
    // Lần đọc lại thấy danh sách đã ổn định → lưu đúng: đủ SKU cũ (không SKU nào bị cộng đôi) + SKU mới đúng một lần.
    const ins = await runCore({ insert: { type: "GET_SKU_COUNT_INVENTORY_PAGE", times: 1 } });
    assert.equal(ins.error, null, ins.error && ins.error.message);
    const want = savedOf(ok.mine), got = savedOf(ins);
    assert.deepEqual(got.filter(r => r.sku !== "900000951"), want, "D2: không SKU nào bị cộng đôi tồn / mất vị trí");
    assert.equal(got.filter(r => r.sku === "900000951").length, 1, "D2: SKU mới chen vào có đúng một lần");
    assert.equal(firstPages(ins, "GET_SKU_COUNT_INVENTORY_PAGE"), 2, "D2: tồn kho lệch total ở lượt 1 → đọc lại 1 lần");
    assert.equal(ins.rpcs[0].args.p_source_counts.stockRows, 708, "MTG 705 + 1 dòng mới + Garment 2");
    // Lịch sử APPROVED cũng phải khớp total.
    const app = await runCore({ insert: { type: "GET_SKU_COUNT_APPROVED_PAGE", times: 1 }, manyApproved: true });
    assert.equal(app.error, null, app.error && app.error.message);
    assert.equal(firstPages(app, "GET_SKU_COUNT_APPROVED_PAGE"), 2, "D2: APPROVED lệch total → đọc lại");
    assert.equal(app.rpcs[0].args.p_source_counts.approvedRows, 404, "APPROVED: 3 + 400 + 1 dòng mới, không trùng");
    // Lệch mãi (kho nhận hàng liên tục): đọc 3 lần (lần đầu + 2 lần đọc lại) rồi ném, không ghi Kiểm kê; UID tạm vẫn chạy.
    const busy = await runCore({ insert: { type: "GET_SKU_COUNT_INVENTORY_PAGE", times: 99 } });
    assert.ok(busy.error, "D2: lệch mãi phải ném");
    assert.equal(firstPages(busy, "GET_SKU_COUNT_INVENTORY_PAGE"), 3, "D2: tối đa 2 lần đọc lại");
    assert.equal(busy.result.skuCount.ok, false);
    assert.ok(busy.result.skuCount.error.startsWith(`${MTG_INV} thay đổi trong lúc đọc (`), busy.result.skuCount.error);
    assert.ok(busy.result.skuCount.error.endsWith("đã đọc lại 2 lần); hãy chạy lại để tránh thiếu dữ liệu"), busy.result.skuCount.error);
    assert.deepEqual(names(busy.rpcs), ["uid_temp_save"], "D2: không lưu bản Kiểm kê lệch");
    // total không đổi nhưng một trang thiếu dòng (đọc được < WMS báo): cũng lệch → đọc lại → ném, câu lỗi nêu hai con số.
    const short = await runCore({ dropRow: "GET_SKU_COUNT_INVENTORY_PAGE" });
    assert.equal(firstPages(short, "GET_SKU_COUNT_INVENTORY_PAGE"), 3);
    assert.equal(short.result.skuCount.error, `${MTG_INV} thay đổi trong lúc đọc (WMS báo 705 dòng, đọc được 704; đã đọc lại 2 lần); hãy chạy lại để tránh thiếu dữ liệu`);
    assert.deepEqual(names(short.rpcs), ["uid_temp_save"]);
    // Dòng bị bộ chuẩn hoá lọc bỏ (sourceRows > rows) không phải lệch: so bằng sourceRows, không đọc lại.
    const filt = await runCore({ filtered: "GET_SKU_COUNT_INVENTORY_PAGE" });
    assert.equal(filt.error, null, filt.error && filt.error.message);
    assert.equal(firstPages(filt, "GET_SKU_COUNT_INVENTORY_PAGE"), 1, "D2: so bằng sourceRows, không đọc lại thừa");
    // UID tạm giữ hành vi cũ (chỉ cảnh báo thiếu dòng, không đọc lại).
    assert.equal(busy.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE" && c.payload.page === 1).length, 2, "UID tạm: mỗi kho đọc 1 lần");
    console.log("storage_risk_core D2 (lõi Extension): PASS — lệch total đọc lại ≤ 2 lần rồi ném, không cộng đôi tồn");
  }

  // 2. Thiếu kho Garment: vẫn đồng bộ MTG, cảnh báo như web
  const one = await compare("thiếu Garment", { noGarment: true });
  assert.equal(one.mine.error, null);
  assert.deepEqual(one.mine.result.skuCount.missing, ["WH - MATERIAL - GARMENT"]);
  assert.deepEqual(one.mine.result.uidTemp.warn, ["Chưa đọc được kho: WH - MATERIAL - GARMENT"]);

  // D2: lệch total một lần rồi ổn định → web cũng đọc lại và lưu cùng payload; dòng bị lọc (sourceRows > rows) không phải lệch
  await compare("D2 tồn kho lệch một lần", { insert: { type: "GET_SKU_COUNT_INVENTORY_PAGE", times: 1 } });
  await compare("D2 APPROVED lệch một lần", { insert: { type: "GET_SKU_COUNT_APPROVED_PAGE", times: 1 }, manyApproved: true });
  await compare("D2 dòng bị lọc", { filtered: "GET_SKU_COUNT_INVENTORY_PAGE" });

  // 3. WMS báo nhiều dòng nhập xuất hơn số đọc được → cảnh báo trong bản lưu, như web
  const gap = await compare("WMS báo thiếu dòng", { shortTotal: { 1339: 5 } });
  assert.deepEqual(gap.mine.result.uidTemp.warn, ["WH - MATERIAL - GARMENT: WMS báo 5 dòng, đọc được 3"]);

  // 4. Extension cũ / tab WMS chưa tải lại (lệnh đọc chuyển vị trí lỗi): dừng ở lời gọi đầu, Kiểm kê vẫn lưu (không có nguồn), UID tạm vẫn có phiếu gốc
  for (const [label, opts, reason] of [["lệnh chuyển vị trí lỗi", { fail: { GET_TRANSFER_BIN_PAGE: "Yêu cầu kết nối không hợp lệ" } }, "dừng đọc chuyển vị trí: Yêu cầu kết nối không hợp lệ"], ["chuyển vị trí trả sai dạng", { transferNoRows: true }, "lịch sử chuyển vị trí trả sai dạng"]]) {
    const old = await compare(label, opts);
    assert.equal(old.mine.error, null, old.mine.error && old.mine.error.message);
    assert.deepEqual(old.mine.result.skuCount.sources, { done: 0, total: 64, reason }, `${label}: báo số cặp + lý do, không im lặng`);
    assert.equal(old.mine.calls.filter(c => c.type === "GET_TRANSFER_BIN_PAGE").length, 1, `${label}: lỗi ở lời gọi đầu thì dừng đọc nguồn`);
    assert.ok(old.mine.rpcs.filter(x => x.name === "sku_count_save_chunk").flatMap(x => x.args.p_rows).every(row => row.locations.every(l => l.sources === undefined)), `${label}: không lưu nguồn dở dang`);
    assert.equal(old.mine.rpcs.at(-1).args.p_rows.find(row => row.sku === "900000011").origin.type, "INTERNAL_TRANSFER", `${label}: UID tạm vẫn có phiếu gốc`);
  }

  // ---- Lỗi: cùng thông điệp, cùng điều kiện dừng như web; core ném sau khi chạy đủ 2 bước ----
  const fails = [
    // tab lỗi ngay từ đầu: không ghi gì
    ["tab lỗi", { failAll: true }, /Không có tab WMS/, /Không có tab WMS/, []],
    // tồn kho đổi giữa trang: Kiểm kê dừng, không ghi; UID tạm vẫn chạy và lưu (như web)
    ["tồn kho đổi giữa trang", { driftType: "GET_SKU_COUNT_INVENTORY_PAGE" }, /Tồn kho theo vị trí · WH - MATERIAL - MTG · Cty Mastige thay đổi trong lúc đọc/, null, ["uid_temp_save"]],
    // Kiểm kê không có SKU nào: giữ bản cũ
    ["không có tồn", { emptyInventory: true }, /WMS không trả SKU nào có tồn kho; giữ nguyên bản đồng bộ cũ/, null, ["uid_temp_save"]],
    // D2: tồn kho lệch total mãi / thiếu dòng → đọc lại 2 lần rồi dừng, không ghi Kiểm kê (web sr-run phải giống)
    ["D2 tồn kho lệch total mãi", { insert: { type: "GET_SKU_COUNT_INVENTORY_PAGE", times: 99 } }, /Tồn kho theo vị trí · WH - MATERIAL - MTG · Cty Mastige thay đổi trong lúc đọc \(.*đã đọc lại 2 lần\)/, null, ["uid_temp_save"]],
    ["D2 tồn kho thiếu dòng", { dropRow: "GET_SKU_COUNT_INVENTORY_PAGE" }, /WMS báo 705 dòng, đọc được 704; đã đọc lại 2 lần/, null, ["uid_temp_save"]],
    // đọc nhập xuất lỗi: Kiểm kê đã lưu, UID tạm không lưu
    ["nhập xuất lỗi", { fail: { GET_STOCK_IMPORT_EXPORT_PAGE: "Phiên WMS hết hạn" } }, null, /Phiên WMS hết hạn/, ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish"]],
    // nhập xuất đổi giữa trang
    ["nhập xuất đổi giữa trang", { driftType: "GET_STOCK_IMPORT_EXPORT_PAGE" }, null, /MTG nhập xuất thay đổi trong lúc đọc/, ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish"]],
    // Supabase lỗi khi ghi Kiểm kê / UID tạm
    ["ghi Kiểm kê lỗi", { rpcFail: { sku_count_save_chunk: "Chỉ Admin được đồng bộ kiểm kê" } }, /^Chưa lưu được bản đồng bộ: Chỉ Admin được đồng bộ kiểm kê$/, null, ["sku_count_save_start", "sku_count_save_chunk", "uid_temp_save"]],
    ["mất mạng khi ghi", { rpcFail: { sku_count_save_start: "Failed to fetch" } }, /mất kết nối tới Supabase, kiểm tra mạng rồi bấm lại/, null, ["sku_count_save_start", "uid_temp_save"]],
    ["ghi UID tạm lỗi", { rpcFail: { uid_temp_save: "Chỉ Admin được lưu UID tạm" } }, null, /^Đã đọc 5 dòng nhưng chưa lưu được: Chỉ Admin được lưu UID tạm$/, ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish", "uid_temp_save"]],
    // Review 26/10/2026: bước nguồn chỉ bắt lỗi của lệnh WMS; lỗi lập trình (xử lý dòng) không bị nuốt — Kiểm kê báo lỗi như Extension, không lưu
    ["lỗi lập trình ở bước nguồn", { transferThrows: true }, /^lỗi giả khi xử lý dòng chuyển vị trí$/, null, ["uid_temp_save"]],
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
  // Import/Export lỗi: không đọc chuyển vị trí, Kiểm kê lưu không có nguồn (nguồn chỉ là phần làm giàu), UID tạm báo lỗi như cũ
  {
    const noMoves = await runCore({ fail: { GET_STOCK_IMPORT_EXPORT_PAGE: "Phiên WMS hết hạn" } });
    assert.equal(noMoves.calls.filter(c => c.type === "GET_TRANSFER_BIN_PAGE").length, 0, "Import/Export lỗi: không đọc chuyển vị trí");
    // Review 26/10/2026: lượt đọc dùng chung chỉ nhớ kết quả THÀNH CÔNG — lỗi thì bước UID tạm đọc lại một lần (trước đây phát lại lỗi cũ).
    assert.equal(noMoves.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").length, 2, "Import/Export lỗi: bước UID tạm đọc lại một lần, không dùng lại lỗi");
    assert.ok(noMoves.rpcs.filter(x => x.name === "sku_count_save_chunk").flatMap(x => x.args.p_rows).every(row => row.locations.every(l => l.sources === undefined)));
    assert.deepEqual(noMoves.result.skuCount.sources, { done: 0, total: 64, reason: "không đọc được nhập xuất: Phiên WMS hết hạn" }, "Kiểm kê báo bước nguồn không đọc được");
  }
  // Lỗi tạm thời (chỉ lần đọc đầu lỗi): Kiểm kê lưu không có nguồn, UID tạm đọc lại thành công và lưu đủ phiếu gốc — web giống hệt
  {
    const once = await compare("nhập xuất lỗi một lần", { failOnce: { GET_STOCK_IMPORT_EXPORT_PAGE: "WMS tạm ngắt kết nối; hãy thử lại" } });
    assert.equal(once.mine.error, null, once.mine.error && once.mine.error.message);
    assert.equal(once.web.auditError, null, once.web.auditError);
    assert.equal(once.web.tempError, null, once.web.tempError);
    assert.deepEqual(names(once.mine.rpcs), ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish", "uid_temp_save"]);
    assert.equal(once.mine.calls.filter(c => c.type === "GET_STOCK_IMPORT_EXPORT_PAGE" && c.payload.page === 1 && c.payload.warehouseIds[0] === 1177).length, 2, "đọc lại kho MTG sau lần lỗi");
    assert.equal(once.mine.calls.filter(c => c.type === "GET_TRANSFER_BIN_PAGE").length, 0, "lần đọc nguồn lỗi: không đọc chuyển vị trí");
    assert.equal(once.mine.rpcs.at(-1).args.p_rows.find(r => r.sku === "900000011").origin.type, "INTERNAL_TRANSFER", "UID tạm có phiếu gốc từ lượt đọc lại");
    assert.equal(once.mine.result.uidTemp.ok, true);
    assert.deepEqual(once.mine.result.skuCount.sources, { done: 0, total: 64, reason: "không đọc được nhập xuất: WMS tạm ngắt kết nối; hãy thử lại" });
  }
  // Chỉ web: Extension < 0.12.0 (chưa có GET_TRANSFER_BIN_PAGE, cầu nối cũ im lặng tới hết 30 giây) → kiểm PING_WMS rồi bỏ bước nguồn ngay;
  // chưa xác minh được Admin → không đọc. Cả hai báo lý do, Kiểm kê vẫn lưu (không có nguồn).
  {
    const oldWeb = await runWeb({ extVersion: "0.11.0" });
    assert.deepEqual(oldWeb.sources, { done: 0, total: 64, reason: "cần Extension ≥ 0.12.0" });
    assert.equal(oldWeb.calls.filter(c => c.type === "GET_TRANSFER_BIN_PAGE").length, 0, "Extension cũ: không gửi lệnh đọc chuyển vị trí");
    assert.deepEqual([oldWeb.auditError, oldWeb.tempError], [null, null]);
    assert.deepEqual(names(oldWeb.rpcs), ["sku_count_save_start", "sku_count_save_chunk", "sku_count_save_chunk", "sku_count_save_finish", "uid_temp_save"]);
    assert.ok(oldWeb.rpcs.filter(x => x.name === "sku_count_save_chunk").flatMap(x => x.args.p_rows).every(row => row.locations.every(l => l.sources === undefined)));
    const guest = await runWeb({ noAdmin: true });
    assert.deepEqual(guest.sources, { done: 0, total: 64, reason: "chưa xác minh Admin" });
    assert.equal(guest.calls.filter(c => c.type === "GET_TRANSFER_BIN_PAGE" || c.type === "GET_STOCK_IMPORT_EXPORT_PAGE").length, 0);
  }
  const tab = await runCore({ failAll: true });
  assert.equal(tab.error.code, "WMS_TAB_MISSING", "giữ mã lỗi tab đầu tiên cho auto-sync phân loại");
  assert.equal(tab.error.fromTab, undefined);
  await assert.rejects(core.run({ sendTab: async () => null, rpc: async () => null, now: () => FIXED }), /không hợp lệ/);
  await assert.rejects(core.run({}), /Thiếu hàm/);
  console.log(`storage_risk_core: ${cases} ca so khớp chuỗi lệnh WMS + payload RPC với mã web (Kiểm kê + UID tạm), lỗi dừng đúng bước; bước nguồn trả {done,total,reason} khớp web, lỗi lập trình không bị nuốt, Extension cũ / chưa Admin (web) báo lý do, lỗi Import/Export không được nhớ (UID tạm đọc lại): PASS`);
})().catch(error => { console.error(error); process.exit(1); });
