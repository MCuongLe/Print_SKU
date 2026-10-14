// Kiểm tra Edge Function supabase/functions/sku-sync/index.ts mà không cần Deno hay Supabase thật:
// Node 24 tự bỏ khai báo kiểu khi import .ts; Deno.serve / Deno.env / fetch được giả lập bằng database trong bộ nhớ.
//   node tests/sku_sync_function.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach, after } from "node:test";
import { pathToFileURL } from "node:url";

const SOURCE = fs.readFileSync(new URL("../supabase/functions/sku-sync/index.ts", import.meta.url), "utf8");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "sku-sync-test-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const MIN = 60 * 1000;
const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";
const CATEGORIES = [
  ["954", "Thời Trang (Phụ Liệu)"], ["957", "Thời Trang (NVL)"], ["960", "Thời Trang"],
  ["961", "Thực phẩm"], ["962", "Mẫu Thời Trang"], ["963", "Nhận hàng gia công"], ["964", "Nguyên liệu nhận Gia công"],
].map(([id, name]) => ({ id, name }));

let runs, skus, links, handler;

function iso(offsetMs) { return new Date(Date.now() + offsetMs).toISOString(); }
function makeRun(over = {}) {
  return {
    id: RUN_A, status: "previewed", source: "inside-extension", mode: "incremental", cutoff: "26-10-01 00:00:00",
    source_generated_at: iso(-2 * MIN), source_counts: {}, change_counts: { skuAdded: 1 }, changes: {},
    staged_skus: [{ sku: "900000001", product_name: "SKU thu nghiem", category_id: "954", category_name: "Thời Trang (Phụ Liệu)", status: "1" }],
    staged_combo_links: [], verification: {}, error_message: null, created_by: "user-1",
    created_at: iso(-2 * MIN), applied_at: null, completed_at: null, ...over,
  };
}
function same(left, op, right) {
  const a = Date.parse(left), b = Date.parse(right);
  const dates = Number.isFinite(a) && Number.isFinite(b) && /\d{4}-\d{2}-\d{2}T/.test(String(left));
  if (op === "eq") return dates ? a === b : String(left) === String(right);
  if (op === "gt") return dates ? a > b : String(left) > String(right);
  throw new Error(`toán tử chưa giả lập: ${op}`);
}
function select(rows, params) {
  let result = rows.filter(row => [...params].every(([key, value]) => {
    if (["select", "order", "limit", "on_conflict"].includes(key)) return true;
    if (key === "sku" && value.startsWith("in.(")) return value.slice(4, -1).split(",").map(code => code.replace(/"/g, "")).includes(row.sku);
    const [op, ...rest] = value.split(".");
    return same(row[key], op, rest.join("."));
  }));
  const order = params.get("order");
  if (order) {
    const [field, direction] = order.split(".");
    result = [...result].sort((x, y) => (Date.parse(x[field]) - Date.parse(y[field])) * (direction === "desc" ? -1 : 1));
  }
  const limit = Number(params.get("limit"));
  return limit ? result.slice(0, limit) : result;
}
function json(body, status = 200, headers = {}) { return new Response(JSON.stringify(body), { status, headers }); }

function install() {
  globalThis.Deno = {
    env: { get: key => ({ SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-service-key" })[key] },
    serve: h => { handler = h; },
  };
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const params = target.searchParams;
    const method = init.method ?? "GET";
    const table = target.pathname.replace("/rest/v1/", "");
    if (target.pathname === "/auth/v1/user") return json({ id: "user-1" });
    if (table === "user_roles") return json([{ username: "admin-test", role: "admin" }]);
    const store = { sku_sync_runs: runs, SKU_Name: skus, sku_combo_links: links }[table];
    if (!store) throw new Error(`fetch không được giả lập: ${url}`);
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `0-0/${store.length}` } });
    if (method === "GET") return json(select(store, params));
    const body = JSON.parse(init.body);
    if (method === "POST") {
      const key = table === "SKU_Name" ? ["sku"] : table === "sku_combo_links" ? ["combo_sku", "normal_sku"] : null;
      const rows = (Array.isArray(body) ? body : [body]).map(row => ({ ...row }));
      for (const row of rows) {
        const existing = key && store.find(item => key.every(field => item[field] === row[field]));
        if (existing) Object.assign(existing, row);
        else store.push(table === "sku_sync_runs" ? makeRun({ ...row, id: RUN_B, created_at: iso(0) }) : row);
      }
      return json(table === "sku_sync_runs" ? [store[store.length - 1]] : null, 201);
    }
    if (method === "PATCH") {
      const matched = select(store, params);
      matched.forEach(row => Object.assign(row, body));
      return json(matched);
    }
    throw new Error(`phương thức chưa giả lập: ${method}`);
  };
}

const file = path.join(TEMP, "sku-sync.ts");
fs.writeFileSync(file, SOURCE);
install();
await import(pathToFileURL(file).href);

beforeEach(() => { runs = []; skus = []; links = []; install(); });

async function call(body) {
  const response = await handler(new Request("https://example.invalid/functions/v1/sku-sync", {
    method: "POST",
    headers: { authorization: "Bearer test-token", origin: "http://localhost:8000", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("apply: bản xem trước mới được ghi và xác minh", async () => {
  runs.push(makeRun());
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.status, "completed");
  assert.equal(skus.length, 1);
  assert.equal(runs[0].status, "completed");
});

test("apply: bản xem trước quá 30 phút bị chặn, không ghi gì", async () => {
  runs.push(makeRun({ created_at: iso(-31 * MIN) }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "STALE_PREVIEW");
  assert.match(result.body.error.message, /30 phút/);
  assert.equal(skus.length, 0);
  assert.equal(runs[0].status, "previewed");
});

test("apply: đã có lượt khác hoàn tất sau bản xem trước thì chặn", async () => {
  runs.push(makeRun({ created_at: iso(-5 * MIN) }));
  runs.push(makeRun({ id: RUN_B, status: "completed", created_at: iso(-4 * MIN), source_generated_at: iso(-4 * MIN), completed_at: iso(-1 * MIN) }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, "STALE_PREVIEW");
  assert.equal(skus.length, 0);
  assert.equal(runs[0].status, "previewed");
});

test("apply: lượt hoàn tất từ trước khi tạo bản xem trước không cản", async () => {
  runs.push(makeRun({ created_at: iso(-5 * MIN) }));
  runs.push(makeRun({ id: RUN_B, status: "completed", created_at: iso(-60 * MIN), source_generated_at: iso(-60 * MIN), completed_at: iso(-59 * MIN) }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 200);
  assert.equal(skus.length, 1);
});

test("history: mốc đọc là lúc đọc nguồn của lượt hoàn tất, kể cả khi 20 lượt mới nhất đều chưa hoàn tất", async () => {
  runs.push(makeRun({ id: RUN_B, status: "completed", created_at: iso(-3 * 24 * 60 * MIN), source_generated_at: iso(-3 * 24 * 60 * MIN), completed_at: iso(-2 * 24 * 60 * MIN) }));
  for (let index = 0; index < 25; index += 1) runs.push(makeRun({ id: `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, "0")}`, created_at: iso(-(index + 1) * MIN) }));
  const result = await call({ action: "history", limit: 20 });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.runs.length, 20);
  assert.equal(result.body.data.lastSnapshotAt, runs[0].source_generated_at);
  assert.equal(result.body.data.lastSuccessAt, runs[0].completed_at);
});

test("history: chưa có lượt hoàn tất thì không có mốc", async () => {
  runs.push(makeRun());
  const result = await call({ action: "history" });
  assert.equal(result.body.data.lastSnapshotAt, null);
  assert.equal(result.body.data.lastSuccessAt, null);
});

function snapshot(generatedAt) {
  return {
    generatedAt, cutoff: "26-10-01 00:00:00", categories: CATEGORIES,
    normalRows: [{ sku: "900000001", product_name: "SKU thu nghiem", category_id: "954", category_name: "x", status: "1", modified: "26-10-07 10:00:00" }],
    comboRows: Array.from({ length: 1000 }, (_, index) => ({ combo_sku: `C${index}`, normal_sku: `N${index}`, quantity: 1, combo_status: "Active", source_modified_at: "2026-10-07 10:00:00" })),
  };
}

test("preview: thời điểm đọc nguồn ở tương lai bị đưa về hiện tại", async () => {
  const before = Date.now();
  const result = await call({ action: "preview", snapshot: snapshot(iso(6 * 60 * MIN)) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const stored = Date.parse(runs[0].source_generated_at);
  assert.ok(stored >= before && stored <= Date.now(), "source_generated_at phải nằm trong lúc gọi, không phải tương lai");
});

test("preview: thời điểm đọc nguồn hợp lệ trong quá khứ được giữ nguyên", async () => {
  const generatedAt = iso(-3 * MIN);
  const result = await call({ action: "preview", snapshot: snapshot(generatedAt) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(runs[0].source_generated_at, generatedAt);
});

test("preview: thời điểm đọc nguồn sai định dạng không làm hỏng lượt", async () => {
  const result = await call({ action: "preview", snapshot: snapshot("khong-phai-ngay") });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(Number.isFinite(Date.parse(runs[0].source_generated_at)));
});

function remoteLink(comboSku, normalSku, over = {}) {
  return { combo_sku: comboSku, normal_sku: normalSku, quantity: 1, combo_name: `Combo ${comboSku}`, ...over };
}
function remoteSku(sku, categoryId = "954") {
  return { sku, product_name: `SKU ${sku}`, category_id: categoryId, category_name: "x", status: "1" };
}

test("preview: quan hệ có trong database nhưng không còn trong nguồn được báo là Combo thừa, không bị xóa", async () => {
  links.push(
    remoteLink("C0", "N0"), // vẫn còn trong nguồn
    remoteLink("C0", "OLD", { quantity: 2 }), // Combo C0 còn nhưng đổi thành phần
    remoteLink("GONE", "N5"), // cả Combo vắng khỏi nguồn
  );
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.changeCounts.comboOrphaned, 2);
  assert.deepEqual(result.body.data.changes.combos.orphaned.map(row => [row.comboSku, row.normalSku, row.reason]), [
    ["C0", "OLD", "component_removed"],
    ["GONE", "N5", "combo_missing"],
  ]);
  assert.equal(links.length, 3, "xem trước không được ghi hay xóa quan hệ nào");
  assert.equal(runs[0].change_counts.comboOrphaned, 2, "báo cáo được lưu cùng lượt");
});

test("preview: không có quan hệ thừa thì không báo gì", async () => {
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.body.data.changeCounts.comboOrphaned, 0);
  assert.deepEqual(result.body.data.changes.combos.orphaned, []);
});

test("preview: quan hệ bị loại được phân loại, chỉ liệt kê trường hợp thiếu một đầu", async () => {
  skus.push(remoteSku("N1"), remoteSku("C2"), remoteSku("N2", "959"), remoteSku("C3"), remoteSku("N3"));
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const counts = result.body.data.sourceCounts;
  assert.deepEqual(counts.excludedBreakdown, { bothMissing: 997, oneMissing: 1, outOfCategory: 1 });
  assert.equal(counts.excludedComboLinks, 999);
  assert.equal(counts.selectedComboLinks, 1);
  assert.deepEqual(result.body.data.changes.combos.excluded, [{ comboSku: "C1", normalSku: "N1", quantity: 1, missing: "combo" }]);
});

test("preview: lỗi nguồn từ Extension được làm sạch, đếm đủ và lưu kèm lượt", async () => {
  const issues = [
    { type: "unparsed_combo_description", combo_sku: "C9", combo_name: "Combo chín", description: "Ghi chú tự do", reason: "Mô tả không đúng dạng Combo A=B+C" },
    { type: "invalid_combo_relation", combo_sku: "C8", normal_sku: "C8", quantity: -1, reason: "SKU Combo tự tham chiếu" },
    { type: "loai-la", combo_sku: `  C7${"x".repeat(100)}  `, quantity: "abc" },
    null,
  ];
  const result = await call({ action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), sourceIssues: issues } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.sourceCounts.sourceIssues, 4);
  const stored = result.body.data.changes.sourceIssues;
  assert.equal(stored.length, 4);
  assert.equal(stored[0].type, "unparsed_combo_description");
  assert.equal(stored[0].description, "Ghi chú tự do");
  assert.equal(stored[1].quantity, -1);
  assert.equal(stored[2].type, "unknown");
  assert.equal(stored[2].quantity, null);
  assert.equal(stored[2].combo_sku.length, 64);
  assert.equal(stored[3].type, "unknown");
  assert.deepEqual(runs[0].changes.sourceIssues, stored, "lưu cùng lượt để xem lại trong lịch sử");
});

test("preview: lỗi nguồn nhiều hơn giới hạn thì lưu 1.000 dòng nhưng đếm đủ", async () => {
  const issues = Array.from({ length: 1500 }, (_, index) => ({ type: "unparsed_combo_description", combo_sku: `X${index}` }));
  const result = await call({ action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), sourceIssues: issues } });
  assert.equal(result.body.data.sourceCounts.sourceIssues, 1500);
  assert.equal(result.body.data.changes.sourceIssues.length, 1000);
});

test("preview: Extension cũ không gửi lỗi nguồn vẫn dùng được", async () => {
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.sourceCounts.sourceIssues, 0);
  assert.deepEqual(result.body.data.changes.sourceIssues, []);
});

test("detail: báo cáo cảnh báo xem lại được từ lịch sử", async () => {
  links.push(remoteLink("GONE", "N5"));
  const created = await call({ action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), sourceIssues: [{ type: "partial_combo_description", combo_sku: "C4", reason: "Bỏ qua thành phần: B 1" }] } });
  const result = await call({ action: "detail", runId: created.body.data.runId });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.changes.combos.orphaned[0].comboSku, "GONE");
  assert.equal(result.body.data.changes.sourceIssues[0].type, "partial_combo_description");
  assert.equal(result.body.data.change_counts.comboOrphaned, 1);
});

test("preview: bảng đúng 1000 dòng, database trả 416 ở trang kế thì vẫn đọc đủ, không báo lỗi", async () => {
  for (let index = 0; index < 1000; index += 1) links.push(remoteLink(`C${index}`, `N${index}`));
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const start = Number(String(init.headers?.Range ?? "").split("-")[0]);
    if (String(url).includes("/sku_combo_links") && start >= links.length) return new Response("{}", { status: 416 });
    return inner(url, init);
  };
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
});

test("auth: token sai hoặc hết hạn trả 401 AUTH, không phải 500", async () => {
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => new URL(String(url)).pathname === "/auth/v1/user" ? json({ message: "invalid JWT" }, 401) : inner(url, init);
  const result = await call({ action: "history" });
  assert.equal(result.status, 401, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "AUTH");
});

// ---- Đối chiếu toàn bộ (sku_sync_full_v1, 14/10/2026) ----
function fullSnapshot(rows, over = {}) {
  return { ...snapshot(iso(-1 * MIN)), full: true, mode: "full", cutoff: "", normalRows: rows, ...over };
}
function sourceSku(sku, over = {}) {
  return { sku, product_name: `SKU ${sku}`, category_id: "954", category_name: "x", status: "1", modified: "26-10-07 10:00:00", ...over };
}

test("full: so với cả bảng — SKU mới, sửa, không đổi và SKU không còn trên Inside (chỉ báo, không xoá)", async () => {
  const cat = "Thời Trang (Phụ Liệu)";
  skus.push({ ...remoteSku("A"), category_name: cat }, { ...remoteSku("B"), category_name: cat }, remoteSku("C"));
  const result = await call({ action: "preview", mode: "full", snapshot: fullSnapshot([sourceSku("A"), sourceSku("B", { product_name: "SKU B doi ten" }), sourceSku("D")]) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const c = result.body.data.changeCounts;
  assert.deepEqual([c.skuAdded, c.skuUpdated, c.skuUnchanged, c.skuMissing], [1, 1, 1, 1]);
  assert.deepEqual(result.body.data.changes.skus.missing.map(row => row.sku), ["C"]);
  assert.equal(result.body.data.mode, "full");
  assert.equal(runs[0].mode, "full");
  assert.equal(runs[0].verification.fullDropPercent, 0, "3 SKU nguồn so với 3 SKU database: không giảm");
  assert.equal(runs[0].verification.previousFullCount, null);
  assert.equal(skus.length, 3, "xem trước không ghi gì");
});

test("full: Extension cũ không gửi cờ full thì từ chối, không tạo lượt", async () => {
  const result = await call({ action: "preview", mode: "full", snapshot: { ...fullSnapshot([sourceSku("A")]), full: undefined } });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.code, "INCOMPLETE_SOURCE");
  assert.equal(runs.length, 0);
});

test("full: nguồn ít hơn 20% so với bảng hiện có (lần đầu) thì chặn, không tạo lượt", async () => {
  for (let index = 0; index < 10; index += 1) skus.push(remoteSku(`S${index}`));
  const result = await call({ action: "preview", mode: "full", snapshot: fullSnapshot(Array.from({ length: 7 }, (_, index) => sourceSku(`S${index}`))) });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, "SAFETY_LIMIT");
  assert.match(result.body.error.message, /30%/);
  assert.equal(runs.length, 0);
});

test("full: có lần toàn bộ trước thì so với số SKU nguồn của lần đó; giảm 5% chỉ ghi nhận, không chặn", async () => {
  runs.push(makeRun({ id: RUN_B, mode: "full", status: "completed", source_counts: { normalRows: 100 }, created_at: iso(-60 * MIN), source_generated_at: iso(-60 * MIN), completed_at: iso(-59 * MIN) }));
  for (let index = 0; index < 10; index += 1) skus.push(remoteSku(`S${index}`));
  const result = await call({ action: "preview", mode: "full", snapshot: fullSnapshot(Array.from({ length: 95 }, (_, index) => sourceSku(`S${index}`))) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.data.verification.previousFullCount, result.body.data.verification.baselineCount, result.body.data.verification.fullDropPercent], [100, 100, 5]);
});

test("full: trần 30.000 dòng ghi (gia tăng vẫn 2.000); danh sách chi tiết cắt 1.000 nhưng đếm đủ", async () => {
  const rows = Array.from({ length: 2500 }, (_, index) => sourceSku(`N${String(index).padStart(5, "0")}`));
  const blocked = await call({ action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), normalRows: rows } });
  assert.equal(blocked.status, 409, "gia tăng 2.500 dòng mới vượt ngưỡng 2.000");
  assert.equal(blocked.body.error.code, "SAFETY_LIMIT");
  const result = await call({ action: "preview", mode: "full", snapshot: fullSnapshot(rows) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.changeCounts.skuAdded, 2500);
  assert.equal(result.body.data.changes.skus.added.length, 1000);
  assert.equal(runs.at(-1).staged_skus.length, 2500, "mọi dòng vẫn chờ ghi");
});

test("full: gia tăng không báo SKU thiếu trên Inside dù bảng có SKU khác", async () => {
  skus.push(remoteSku("ZZZ"));
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.changeCounts.skuMissing, 0);
  assert.deepEqual(result.body.data.changes.skus.missing, []);
  assert.equal(runs[0].mode, "incremental");
});

test("history: mốc Toàn bộ gần nhất chỉ tính lượt toàn bộ đã hoàn tất", async () => {
  runs.push(makeRun({ id: RUN_A, status: "completed", created_at: iso(-10 * MIN), source_generated_at: iso(-10 * MIN), completed_at: iso(-9 * MIN) }));
  let result = await call({ action: "history" });
  assert.equal(result.body.data.lastFullAt, null, "chỉ có lượt gia tăng");
  assert.equal(result.body.data.lastSuccessAt, runs[0].completed_at);
  runs.push(makeRun({ id: RUN_B, mode: "full", status: "completed", created_at: iso(-3 * 24 * 60 * MIN), source_generated_at: iso(-3 * 24 * 60 * MIN), completed_at: iso(-3 * 24 * 60 * MIN + MIN) }));
  result = await call({ action: "history" });
  assert.equal(result.body.data.lastFullAt, runs[1].completed_at);
  assert.equal(result.body.data.runs[0].mode, "incremental");
});

test("apply: lượt toàn bộ hơn 3.000 dòng ghi được và xác minh bằng cả bảng; giữ số liệu kiểm chứng của bản xem trước", async () => {
  const staged = Array.from({ length: 3100 }, (_, index) => ({ sku: `F${index}`, product_name: `SKU F${index}`, category_id: "954", category_name: "Thời Trang (Phụ Liệu)", status: index % 2 ? "1" : "0" }));
  runs.push(makeRun({ mode: "full", staged_skus: staged, verification: { previousFullCount: 3000, fullDropPercent: 0, skuMissing: 2 } }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(skus.length, 3100);
  assert.equal(result.body.data.verification.skuVerified, 3100);
  assert.equal(result.body.data.verification.previousFullCount, 3000);
  assert.equal(result.body.data.verification.skuMissing, 2);
});
