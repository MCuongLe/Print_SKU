// Đối chiếu toàn bộ SKU (GET_SKU_SYNC_DATA {full:true}) với Inside giả trong vm (soát Extension 22/10/2026, G1).
// Danh sách sản phẩm Inside xếp Modified giảm dần: SKU sửa trong lúc đọc nhảy lên trang 1 đã đọc → trước 0.10.7 bị thiếu
// trong ảnh chụp → Edge coi là "rời nhóm" và tự lưu trữ. Nay đọc lại phần đổi từ mốc bắt đầu rồi gộp.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const dir = path.resolve(__dirname, "..", "extension", "inside-po-connector");
const coreSource = fs.readFileSync(path.join(dir, "sku-sync-core.js"), "utf8");
const bridgeSource = fs.readFileSync(path.join(dir, "inside-bridge.js"), "utf8");

const OLD = "26-01-01 00:00:00";
const PAGE = 200;

function runFull({ total = 1300, moveAt = 1250, mutateOnPage = 7, statusOf = () => "Active", filler = false } = {}) {
  const context = { URL, Date, Intl, Map, Set, Array, Number, String, Object, Math, Promise, Error, RegExp, JSON, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.runInNewContext(coreSource, context);
  const stampNow = context.HasakiSkuSyncCore.cutoffKey(new Date().toISOString());
  // Nhóm 954: total SKU giả 9000xxxxx, Modified cũ; nhóm khác và Combo trống.
  let list = Array.from({ length: total }, (_, i) => ({ sku: `9000${String(i + 1).padStart(5, "0")}`, modified: OLD }));
  let mutated = false, moved = null;
  const cell = value => ({ textContent: value, querySelector: () => null });
  const productDoc = rows => ({
    title: "Products",
    querySelector: () => null,
    querySelectorAll: sel => {
      if (sel === "table thead th") return ["SKU", "Product Name", "Status", "Modified"].map(cell);
      // filler: dòng "không có dữ liệu" (1 ô, không SKU) ở cuối mỗi trang — phải bị bỏ qua, không bị coi là trạng thái lạ.
      if (sel === "table tbody tr") return [...rows.map(row => ({ cells: [cell(row.sku), cell(`Vải mẫu ${row.sku}`), cell(statusOf(row)), cell(row.modified)] })), ...(filler ? [{ cells: [cell("Không có dữ liệu")] }] : [])];
      return [];
    },
  });
  const comboDoc = {
    title: "Combo", querySelector: () => null,
    querySelectorAll: sel => sel === "table thead th" ? ["SKU", "Name", "Description", "Modified", "Status"].map(cell) : [],
  };
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith("/combo")) return { ok: true, text: async () => "combo" };
    const page = Number(u.searchParams.get("page"));
    if (u.searchParams.get("category_id") === "954") {
      // Lô 1 (trang 1–6) đã đọc xong; lúc bắt đầu lô 2 có người sửa một SKU đang ở trang chưa đọc → SKU lên đầu danh sách.
      if (page === mutateOnPage && !mutated) {
        mutated = true;
        [moved] = list.splice(moveAt - 1, 1);
        moved = { ...moved, modified: stampNow };
        list = [moved, ...list];
      }
      return { ok: true, text: async () => JSON.stringify(list.slice((page - 1) * PAGE, page * PAGE)) };
    }
    return { ok: true, text: async () => "[]" };
  };
  let listener;
  Object.assign(context, {
    window: {}, location: { hostname: "inside.mastige.vn", origin: "https://inside.mastige.vn" }, fetch: fetchImpl,
    chrome: { runtime: { id: "ext-id", onMessage: { addListener: fn => { listener = fn; } } } },
    DOMParser: class { parseFromString(html) { return html === "combo" ? comboDoc : productDoc(JSON.parse(html)); } },
  });
  vm.runInNewContext(bridgeSource, context);
  return new Promise(resolve => listener({ type: "GET_SKU_SYNC_DATA", payload: { full: true } }, { id: "ext-id" }, value => resolve({ result: JSON.parse(JSON.stringify(value)), moved: () => moved })));
}

(async () => {
  const { result, moved } = await runFull();
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const skus = new Set(result.data.normalRows.map(row => row.sku));
  assert.ok(moved(), "kịch bản phải có SKU bị sửa giữa lượt");
  assert.ok(skus.has(moved().sku), `SKU ${moved().sku} sửa giữa lượt không được thiếu trong ảnh chụp toàn bộ`);
  assert.equal(skus.size, 1300, "đủ mọi SKU, không trùng");
  assert.equal(result.data.normalRows.find(row => row.sku === moved().sku).modified, moved().modified, "giữ bản mới nhất");

  // Không ai sửa giữa lượt: kết quả như cũ.
  const quiet = await runFull({ mutateOnPage: 999 });
  assert.equal(new Set(quiet.result.data.normalRows.map(row => row.sku)).size, 1300);
  // D7 (0.10.8): một SKU có nhãn Trạng thái lạ → cả lượt đọc lỗi (không gửi ảnh chụp để ghi), lỗi nêu mã SKU và nhãn.
  const odd = await runFull({ mutateOnPage: 999, statusOf: row => (row.sku === "900000042" ? "Hoạt động" : "Active") });
  assert.equal(odd.result.ok, false, "nhãn lạ phải làm lượt đọc lỗi");
  assert.equal(odd.result.error.code, "SKU_SYNC_READ_FAILED");
  assert.match(odd.result.error.message, /900000042.*Inside đổi nhãn Trạng thái sản phẩm \("Hoạt động"\)/);
  const blank = await runFull({ mutateOnPage: 999, statusOf: row => (row.sku === "900000043" ? "" : "Active") });
  assert.equal(blank.result.ok, false, "ô trạng thái trống cũng là lỗi đọc, không phải ngừng hoạt động");
  // In-Active vẫn là ngừng ("0"); dòng không có SKU (thông báo trống) không bị xét trạng thái.
  const mixed = await runFull({ mutateOnPage: 999, filler: true, statusOf: row => (row.sku === "900000044" ? "In-Active" : "Active") });
  assert.equal(mixed.result.ok, true, JSON.stringify(mixed.result.error));
  assert.equal(mixed.result.data.normalRows.find(row => row.sku === "900000044").status, "0");
  assert.equal(new Set(mixed.result.data.normalRows.map(row => row.sku)).size, 1300);
  // 0.10.9: SKU "Pending" (mới tạo, chưa kích hoạt) không làm lượt lỗi; đọc là ngừng "0" như trước 0.10.8. Mọi dòng khác vẫn "1".
  const pending = await runFull({ mutateOnPage: 999, filler: true, statusOf: row => (row.sku === "900000045" ? "Pending" : "Active") });
  assert.equal(pending.result.ok, true, JSON.stringify(pending.result.error));
  assert.equal(pending.result.data.normalRows.find(row => row.sku === "900000045").status, "0");
  assert.equal(pending.result.data.normalRows.filter(row => row.status === "0").length, 1);
  assert.equal(new Set(pending.result.data.normalRows.map(row => row.sku)).size, 1300);
  console.log("inside_sku_sync_full: SKU sửa giữa lượt toàn bộ vẫn có trong ảnh chụp; nhãn trạng thái lạ → lỗi đọc; Pending → ngừng");
})().catch(error => { console.error(error); process.exit(1); });
