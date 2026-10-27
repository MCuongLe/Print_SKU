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

let runs, skus, links, settings, leases, devices, handler, archiveRpc, archiveCalls;

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
  if (op === "gte") return dates ? a >= b : String(left) >= String(right);
  throw new Error(`toán tử chưa giả lập: ${op}`);
}
function select(rows, params) {
  let result = rows.filter(row => [...params].every(([key, value]) => {
    if (["select", "order", "limit", "on_conflict"].includes(key)) return true;
    if (value.startsWith("in.(")) return value.slice(4, -1).split(",").map(code => code.replace(/"/g, "")).includes(String(row[key]));
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
    if (table === "rpc/sku_archive_missing") {
      const body = JSON.parse(init.body);
      archiveCalls.push(body);
      if (!archiveRpc) throw new Error("rpc sku_archive_missing chưa cấu hình trong ca test");
      const out = archiveRpc(body);
      return out instanceof Response ? out : json(out);
    }
    if (table.startsWith("rpc/")) return json(rpcCall(table.slice(4), JSON.parse(init.body)));
    const leaseRows = [...leases].map(([kind, row]) => ({ kind, ...row }));
    const store = { sku_sync_runs: runs, SKU_Name: skus, sku_combo_links: links, sync_auto_settings: settings, sync_auto_leases: leaseRows, sync_auto_devices: devices }[table];
    if (!store) throw new Error(`fetch không được giả lập: ${url}`);
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `0-0/${store.length}` } });
    if (method === "GET") return json(select(store, params));
    const body = JSON.parse(init.body);
    if (method === "POST") {
      const key = table === "SKU_Name" ? ["sku"] : table === "sku_combo_links" ? ["combo_sku", "normal_sku"] : table === "sync_auto_settings" ? ["singleton"] : table === "sync_auto_devices" ? ["holder"] : null;
      const rows = (Array.isArray(body) ? body : [body]).map(row => ({ ...row }));
      for (const row of rows) {
        const existing = key && store.find(item => key.every(field => item[field] === row[field]));
        // Upsert PostgREST (merge-duplicates) chỉ cập nhật cột có trong payload; chèn mới thì cột vắng lấy mặc định (sync_auto_devices: now()).
        if (existing) Object.assign(existing, row);
        else store.push(table === "sku_sync_runs" ? makeRun({ ...row, id: RUN_B, created_at: iso(0) }) : table === "sync_auto_devices" ? { first_seen_at: iso(0), last_seen_at: iso(0), ...row } : row);
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

beforeEach(() => { runs = []; skus = []; links = []; settings = []; leases = new Map(); devices = []; archiveRpc = null; archiveCalls = []; install(); });

// Giả lập RPC sync_auto_lease / sync_auto_release (sync_auto_v1.sql): hết hạn hoặc cùng máy thì giành được;
// p_cooldown_seconds > 0 và lượt cùng loại vừa kết thúc (last_finished_at, ghi khi nhả khoá với p_finished) → COOLDOWN.
function rpcCall(name, body) {
  if (name === "sync_auto_lease") {
    const current = leases.get(body.p_kind);
    if (current && current.holder && current.holder !== body.p_holder && Date.parse(current.leased_until) >= Date.now()) {
      return { ok: false, holder: current.holder, leasedUntil: current.leased_until };
    }
    const cooldown = Number(body.p_cooldown_seconds || 0), finishedAt = Date.parse(current?.last_finished_at || "");
    const renewing = current && current.holder === body.p_holder && Date.parse(current.leased_until) >= Date.now();
    if (cooldown > 0 && Number.isFinite(finishedAt) && finishedAt > Date.now() - cooldown * 1000 && !renewing) {
      return { ok: false, reason: "COOLDOWN", lastFinishedAt: current.last_finished_at, retryAfter: new Date(finishedAt + cooldown * 1000).toISOString() };
    }
    const row = { ...(current || {}), holder: body.p_holder, leased_until: iso(body.p_ttl_seconds * 1000) };
    leases.set(body.p_kind, row);
    return { ok: true, holder: row.holder, leasedUntil: row.leased_until };
  }
  if (name === "sync_auto_release") {
    const current = leases.get(body.p_kind);
    const released = Boolean(current && current.holder === body.p_holder);
    if (released) leases.set(body.p_kind, { holder: null, leased_until: null, last_finished_at: body.p_finished === true ? iso(0) : current.last_finished_at ?? null });
    return { ok: true, released };
  }
  throw new Error(`rpc chưa giả lập: ${name}`);
}

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

// D4 (review 23/10/2026): đọc sku_combo_links nhiều trang Range phải có order theo khoá chính, nếu không Postgres có thể trả
// lặp / sót dòng giữa các trang (nhất là ngay sau upsert) → Combo thừa sai ở xem trước, "chưa khớp" giả ở xác minh.
test("D4: mọi lần đọc sku_combo_links (xem trước + xác minh khi áp dụng) có order=combo_sku.asc,normal_sku.asc", async () => {
  links.push(remoteLink("C0", "N0"), remoteLink("GONE", "N5"));
  const reads = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    if (target.pathname === "/rest/v1/sku_combo_links" && (init.method ?? "GET") === "GET") reads.push(target.searchParams.get("order"));
    return inner(url, init);
  };
  const preview = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  runs.length = 0;
  runs.push(makeRun({ staged_combo_links: [{
    ...remoteLink("C9", "N9"), normal_name: "SKU N9", combo_category_id: "954", combo_category_name: "x", normal_category_id: "954", normal_category_name: "x",
    combo_product_status: "1", normal_product_status: "1", combo_status: "Active", source_modified_at: "2026-10-07T03:00:00.000Z", source_component_count: 1, combo_scope_complete: true,
  }] }));
  const applied = await call({ action: "apply", runId: RUN_A });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.ok(reads.length >= 2, `phải đọc sku_combo_links ở cả xem trước và áp dụng (đếm ${reads.length})`);
  assert.deepEqual([...new Set(reads)], ["combo_sku.asc,normal_sku.asc"]);
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
  assert.deepEqual(runs[0].staged_missing_skus.map(row => row.sku), ["C"], "lưu danh sách SKU thiếu để lưu trữ khi áp dụng");
  assert.deepEqual(Object.keys(runs[0].staged_missing_skus[0]).sort(), ["category_name", "product_name", "sku", "status"]);
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
  assert.deepEqual(runs.at(-1).staged_missing_skus, [], "lượt toàn bộ luôn có danh sách SKU thiếu (rỗng)");
});

test("full: danh sách SKU thiếu lưu đầy đủ (không cắt 1.000) để lưu trữ hết khi áp dụng", async () => {
  for (let index = 0; index < 1200; index += 1) skus.push(remoteSku(`M${String(index).padStart(5, "0")}`));
  // Database giả trả đúng trang theo Range (bảng > 1.000 dòng).
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const response = await inner(url, init);
    const range = String(init.headers?.Range ?? "");
    if (!range || (init.method ?? "GET") !== "GET" || !new URL(String(url)).pathname.endsWith("/SKU_Name")) return response;
    const [start, end] = range.split("-").map(Number);
    const rows = await response.json();
    return start >= rows.length && start > 0 ? new Response(null, { status: 416 }) : json(rows.slice(start, end + 1));
  };
  const rows = Array.from({ length: 1300 }, (_, index) => sourceSku(`K${String(index).padStart(5, "0")}`));
  const result = await call({ action: "preview", mode: "full", snapshot: fullSnapshot(rows) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.changeCounts.skuMissing, 1200);
  assert.equal(result.body.data.changes.skus.missing.length, 1000, "chi tiết vẫn cắt 1.000");
  assert.equal(runs.at(-1).staged_missing_skus.length, 1200);
  assert.equal(runs.at(-1).missing_sku_codes.length, 1200, "mã SKU thiếu lưu đủ, không cắt");
  assert.equal(result.body.data.changeCounts.skuMissingNew, 1200, "chưa có lượt toàn bộ hoàn tất: mọi SKU thiếu là mới");
  // Lượt đó hoàn tất (changes cắt 1.000 nhưng missing_sku_codes đủ 1.200) → lượt sau cùng 1.200 SKU thiếu: không SKU nào mới.
  Object.assign(runs.at(-1), { status: "completed", completed_at: iso(0) });
  const again = await call({ action: "preview", mode: "full", snapshot: fullSnapshot(rows) });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.data.changeCounts.skuMissing, again.body.data.changeCounts.skuMissingNew], [1200, 0]);
});

test("full: gia tăng không báo SKU thiếu trên Inside dù bảng có SKU khác", async () => {
  skus.push(remoteSku("ZZZ"));
  const result = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.changeCounts.skuMissing, 0);
  assert.deepEqual(result.body.data.changes.skus.missing, []);
  assert.equal(runs[0].mode, "incremental");
  assert.equal(runs[0].staged_missing_skus, null, "gia tăng không lưu trữ gì");
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

test("SKU ngừng hoạt động chưa có trong database: không nạp, chỉ đếm; SKU đã có chuyển sang ngừng vẫn cập nhật; combo tham chiếu SKU bỏ qua bị loại", async () => {
  skus.push({ ...remoteSku("KEEP"), category_name: "Thời Trang (Phụ Liệu)" });
  links.length = 0;
  const combos = Array.from({ length: 1000 }, (_, index) => ({ combo_sku: `C${index}`, normal_sku: `N${index}`, quantity: 1, combo_status: "Active", source_modified_at: "2026-10-07 10:00:00" }));
  combos[0] = { ...combos[0], combo_sku: "KEEP", normal_sku: "OLDX" };
  const rows = [sourceSku("OLDX", { status: "0" }), sourceSku("OLDY", { status: "0" }), sourceSku("NEWA"), sourceSku("KEEP", { status: "0" })];
  for (const mode of ["incremental", "full"]) {
    runs.length = 0;
    const body = mode === "full" ? { action: "preview", mode, snapshot: fullSnapshot(rows, { comboRows: combos }) } : { action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), normalRows: rows, comboRows: combos } };
    const result = await call(body);
    assert.equal(result.status, 200, mode + " " + JSON.stringify(result.body));
    const c = result.body.data.changeCounts;
    assert.deepEqual([c.skuAdded, c.skuUpdated, c.skuSkippedInactive], [1, 1, 2], mode);
    assert.deepEqual(runs[0].staged_skus.map(row => row.sku).sort(), ["KEEP", "NEWA"], mode + ": chỉ NEWA mới và KEEP đổi trạng thái được ghi");
    assert.equal(runs[0].staged_skus.find(row => row.sku === "KEEP").status, "0", mode + ": SKU đã có chuyển sang ngừng vẫn cập nhật");
    assert.equal(result.body.data.sourceCounts.excludedBreakdown.oneMissing, 1, mode + ": combo KEEP → OLDX bị loại vì OLDX không được nạp");
  }
});

test("combo gia tăng (comboScope changed): nhận ít hơn 1.000 dòng, không kết luận Combo thừa; toàn bộ vẫn bắt buộc đọc hết", async () => {
  skus.push({ ...remoteSku("C1"), category_name: "Thời Trang (Phụ Liệu)" }, { ...remoteSku("N1"), category_name: "Thời Trang (Phụ Liệu)" });
  links.push(remoteLink("GONE", "N5"));
  const combos = [{ combo_sku: "C1", normal_sku: "N1", quantity: 2, combo_status: "Active", source_modified_at: "2026-10-15 10:00:00" }];
  const result = await call({ action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), comboScope: "changed", comboCutoff: "2026-10-14 00:00:00", comboRows: combos } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.sourceCounts.comboScope, "changed");
  assert.equal(result.body.data.sourceCounts.comboRows, 1);
  assert.equal(result.body.data.changeCounts.comboAdded, 1);
  assert.equal(result.body.data.changeCounts.comboOrphaned, null, "không đọc hết thì không biết Combo thừa");
  assert.deepEqual(result.body.data.changes.combos.orphaned, []);
  assert.equal(links.length, 1, "xem trước không xoá GONE → N5");
  const blocked = await call({ action: "preview", mode: "full", snapshot: fullSnapshot([sourceSku("C1")], { comboScope: "changed", comboRows: combos }) });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.body.error.code, "INCOMPLETE_SOURCE");
  const old = await call({ action: "preview", snapshot: { ...snapshot(iso(-1 * MIN)), comboRows: combos } });
  assert.equal(old.status, 500, "Extension cũ gửi ít Combo mà không có comboScope vẫn bị chặn như trước");
});

// ---- Đồng bộ tự động qua Extension (sync_auto_v1, 17/10/2026) ----
// holder = tên máy + "#" + mã máy (auto-sync.js holderOf); lượt tự động phải đang giữ khoá thuê còn hạn mới được ghi.
const HOLDER = "may-test-01#abc123";
function holdLease(holder = HOLDER, untilMs = 10 * MIN) { leases.set("sku", { holder, leased_until: iso(untilMs) }); }
function updatedStaged(total) {
  return Array.from({ length: total }, (_, index) => ({ sku: `90000${String(index).padStart(4, "0")}`, product_name: `SKU thu nghiem ${index}`, category_id: "954", category_name: "Thời Trang (Phụ Liệu)", status: "1" }));
}

test("auto: preview ghi nguồn auto + tên máy; thiếu trường thì manual như cũ; history/detail trả source, device, autoHold", async () => {
  holdLease();
  const auto = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), source: "auto", device: "  may-test-01  ", holder: HOLDER });
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.equal(runs[0].run_source, "auto");
  assert.equal(runs[0].device, "may-test-01");
  assert.equal(runs[0].source, "inside-extension", "cột source cũ giữ nguyên giá trị check cứng");
  runs.length = 0;
  const manual = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(manual.status, 200);
  assert.equal(runs[0].run_source, "manual");
  assert.equal(runs[0].device, null);
  runs[0].run_source = "auto"; runs[0].device = "may-test-01"; runs[0].auto_hold = "Giữ lại: thử";
  const history = await call({ action: "history" });
  assert.deepEqual([history.body.data.runs[0].source, history.body.data.runs[0].device, history.body.data.runs[0].autoHold], ["auto", "may-test-01", "Giữ lại: thử"]);
  assert.equal("run_source" in history.body.data.runs[0], false);
  const detail = await call({ action: "detail", runId: runs[0].id });
  assert.deepEqual([detail.body.data.source, detail.body.data.device, detail.body.data.autoHold], ["auto", "may-test-01", "Giữ lại: thử"]);
});

test("auto: apply dưới ngưỡng thì ghi như thường", async () => {
  holdLease();
  runs.push(makeRun({ change_counts: { skuAdded: 1, skuUpdated: 0, skuMissing: 0, comboOrphaned: null } }));
  const result = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "completed");
  assert.equal(result.body.data.held, undefined);
  assert.equal(skus.length, 1);
});

test("auto: vượt ngưỡng (501 SKU cập nhật) thì chuyển held, ghi auto_hold, không ghi SKU; lượt held không áp dụng được nữa", async () => {
  holdLease();
  runs.push(makeRun({ staged_skus: updatedStaged(501), change_counts: { skuAdded: 0, skuUpdated: 501, skuMissing: 0, comboOrphaned: 0 } }));
  const result = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "held");
  assert.match(result.body.data.held.reason, /^Giữ lại: 501 SKU cập nhật vượt ngưỡng 500/);
  assert.equal(result.body.data.held.counts.skuUpdated, 501);
  assert.equal(runs[0].status, "held");
  assert.ok(runs[0].completed_at, "held là trạng thái kết thúc, có giờ kết thúc");
  assert.deepEqual([runs[0].staged_skus, runs[0].staged_combo_links], [[], []], "bỏ dữ liệu chờ ghi của lượt held");
  assert.equal(runs[0].auto_hold, result.body.data.held.reason);
  assert.equal(skus.length, 0);
  for (const body of [{ action: "apply", runId: RUN_A }, { action: "apply", runId: RUN_A, auto: true, holder: HOLDER }]) {
    const again = await call(body);
    assert.deepEqual([again.status, again.body.error.code, again.body.error.message], [409, "RUN_HELD", "Lượt đã giữ lại, chạy lại tay để xem bản mới"]);
  }
  assert.equal(skus.length, 0);
  const history = await call({ action: "history" });
  assert.equal(history.body.data.runs[0].status, "held");
  assert.equal(history.body.data.lastSuccessAt, null, "held không tính là lượt hoàn tất");
});

test("auto: SKU rời nhóm > 20 hoặc Combo thừa > 0 đều giữ lại", async () => {
  holdLease();
  runs.push(makeRun({ change_counts: { skuAdded: 1, skuMissing: 21, comboOrphaned: 3 }, staged_missing_skus: [] }));
  const result = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(result.body.data.status, "held");
  assert.match(result.body.data.held.reason, /21 SKU rời nhóm đồng bộ \(ngưỡng 20\)/);
  assert.match(result.body.data.held.reason, /3 quan hệ Combo thừa/);
  assert.equal(runs[0].staged_missing_skus, null, "lượt held bỏ danh sách chờ lưu trữ");
});

test("auto: ngưỡng SKU rời nhóm mặc định 20 — 19 thiếu vẫn áp dụng, 21 thiếu giữ lại; câu lý do đúng", async () => {
  holdLease();
  runs.push(makeRun({ change_counts: { skuAdded: 1, skuMissing: 19, comboOrphaned: 0 } }));
  const ok = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(ok.body.data.status, "completed", JSON.stringify(ok.body));
  runs.length = 0; skus.length = 0;
  runs.push(makeRun({ change_counts: { skuAdded: 1, skuMissing: 21, comboOrphaned: 0 } }));
  const held = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(held.body.data.status, "held");
  assert.equal(held.body.data.held.reason, "Giữ lại: 21 SKU rời nhóm đồng bộ (ngưỡng 20)");
  assert.equal(skus.length, 0);
  // Ngưỡng ghi trong sync_auto_settings thắng mặc định.
  runs.length = 0;
  settings.push({ singleton: true, enabled: true, thresholds: { sku: { maxMissing: 25 } } });
  runs.push(makeRun({ change_counts: { skuAdded: 1, skuMissing: 21 } }));
  const custom = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(custom.body.data.status, "completed", JSON.stringify(custom.body));
});

test("full: skuMissingNew bỏ SKU lượt toàn bộ hoàn tất trước đã báo thiếu / giữ lại; 26 thiếu trong đó 1 mới thì tự động không held", async () => {
  const code = index => `90000${String(index).padStart(4, "0")}`;
  for (let index = 0; index < 26; index += 1) skus.push(remoteSku(code(index)));
  // Lượt toàn bộ trước: 20 SKU báo thiếu + 5 SKU giữ lại (còn Group UID); một lượt held mới hơn không tính.
  runs.push(makeRun({ id: RUN_B, mode: "full", status: "completed", created_at: iso(-60 * MIN), completed_at: iso(-59 * MIN), source_counts: { normalRows: 1 },
    changes: { skus: { missing: Array.from({ length: 20 }, (_, index) => ({ sku: code(index) })), archiveKept: Array.from({ length: 5 }, (_, index) => ({ sku: code(20 + index), reason: "còn Group UID" })) } } }));
  runs.push(makeRun({ id: "33333333-3333-4333-8333-333333333333", mode: "full", status: "held", created_at: iso(-10 * MIN), completed_at: iso(-9 * MIN), changes: { skus: { missing: [{ sku: code(25) }] } } }));
  holdLease();
  const result = await call({ action: "preview", mode: "full", source: "auto", holder: HOLDER, snapshot: fullSnapshot([sourceSku("900001000")]) });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.data.changeCounts.skuMissing, result.body.data.changeCounts.skuMissingNew], [26, 1]);
  const created = runs.find(row => row.id === RUN_A || (row.status === "previewed" && row.mode === "full"));
  assert.equal(created.change_counts.skuMissingNew, 1);
  assert.equal(created.missing_sku_codes.length, 26);
  // Lượt trước đã có hai cột mã đầy đủ thì dùng hai cột, không dùng changes (cắt 1.000).
  Object.assign(runs.find(row => row.status === "completed"), { changes: {}, missing_sku_codes: Array.from({ length: 20 }, (_, index) => code(index)), archive_kept_codes: Array.from({ length: 5 }, (_, index) => code(20 + index)) });
  runs.splice(runs.indexOf(created), 1);
  const byCodes = await call({ action: "preview", mode: "full", source: "auto", holder: HOLDER, snapshot: fullSnapshot([sourceSku("900001000")]) });
  assert.equal(byCodes.body.data.changeCounts.skuMissingNew, 1);
  const { evaluateSkuHold } = await import(pathToFileURL(file).href);
  assert.equal(evaluateSkuHold(created.change_counts, {}), null, "1 SKU mới ≤ 20: không giữ lại");
  const held = evaluateSkuHold({ skuMissing: 26, skuMissingNew: 21 }, {});
  assert.equal(held.reason, "Giữ lại: 21 SKU mới rời nhóm đồng bộ (ngưỡng 20)");
  assert.equal(held.counts.skuMissingNew, 21);
  assert.equal(evaluateSkuHold({ skuMissing: 26 }, {}).reason, "Giữ lại: 26 SKU rời nhóm đồng bộ (ngưỡng 20)", "lượt cũ không có skuMissingNew: dùng skuMissing");
});

test("full: chưa có lượt toàn bộ hoàn tất thì mọi SKU thiếu đều là mới; gia tăng không có skuMissingNew", async () => {
  skus.push(remoteSku("900000081"), remoteSku("900000082"));
  const full = await call({ action: "preview", mode: "full", snapshot: fullSnapshot([sourceSku("900000081"), sourceSku("900000083")]) });
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.deepEqual([full.body.data.changeCounts.skuMissing, full.body.data.changeCounts.skuMissingNew], [1, 1]);
  const inc = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(inc.body.data.changeCounts.skuMissingNew, undefined);
});

// ---- SKU rời nhóm đồng bộ → lưu trữ (sku_missing_archive_v1, 17/10/2026) ----
function missingRow(sku) { return { sku, product_name: `SKU thu nghiem ${sku}`, category_name: "Thời Trang (Phụ Liệu)", status: "1" }; }

test("archive: lượt toàn bộ áp dụng gọi sku_archive_missing với đủ SKU thiếu; đếm lưu trữ / giữ lại vào change_counts và changes", async () => {
  skus.push(missingRow("900000091"), missingRow("900000092"));
  archiveRpc = () => {
    skus.splice(skus.findIndex(row => row.sku === "900000091"), 1);
    return { archived: 1, archivedSkus: ["900000091"], kept: 1, keptSkus: [{ sku: "900000092", reason: "còn Group UID" }] };
  };
  runs.push(makeRun({ mode: "full", change_counts: { skuAdded: 1, skuMissing: 2 }, changes: { skus: { added: [], updated: [], missing: [missingRow("900000091"), missingRow("900000092")] } }, staged_missing_skus: [missingRow("900000091"), missingRow("900000092")] }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "completed");
  assert.deepEqual(archiveCalls, [{ p_skus: ["900000091", "900000092"], p_reason: "left_sync_scope" }]);
  assert.deepEqual([result.body.data.changeCounts.skuArchived, result.body.data.changeCounts.skuArchiveKept, result.body.data.changeCounts.skuMissing], [1, 1, 2]);
  assert.deepEqual([runs[0].change_counts.skuArchived, runs[0].change_counts.skuArchiveKept], [1, 1]);
  assert.deepEqual(runs[0].changes.skus.archived, [{ sku: "900000091", product_name: "SKU thu nghiem 900000091", category_name: "Thời Trang (Phụ Liệu)" }]);
  assert.deepEqual(runs[0].changes.skus.archiveKept, [{ sku: "900000092", reason: "còn Group UID", product_name: "SKU thu nghiem 900000092" }]);
  assert.equal(runs[0].changes.skus.missing.length, 2, "giữ danh sách thiếu của bản xem trước");
  assert.equal(result.body.data.verification.archiveError, undefined);
  assert.equal(result.body.data.verification.skuCount, 3, "đếm bảng trước khi lưu trữ (lưu trữ chạy sau khi lượt đã completed)");
  assert.deepEqual(runs[0].archive_kept_codes, ["900000092"], "mã giữ lại lưu đủ cho skuMissingNew lượt sau");
  const detail = await call({ action: "detail", runId: RUN_A });
  assert.deepEqual([detail.body.data.change_counts.skuArchived, detail.body.data.change_counts.skuArchiveKept], [1, 1]);
});

test("archive: thứ tự — ghi, xác minh, đếm, ghi lượt completed rồi MỚI gọi RPC lưu trữ, sau đó PATCH bổ sung vào lượt completed", async () => {
  skus.push(missingRow("900000095"));
  const log = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url)), method = init.method ?? "GET", table = target.pathname.replace("/rest/v1/", "");
    if (table === "sku_sync_runs" && method === "PATCH") log.push(`PATCH ${Object.keys(JSON.parse(init.body)).sort().join(",")}`);
    else if (method === "HEAD") log.push(`HEAD ${table}`);
    else if (table === "rpc/sku_archive_missing") log.push("RPC archive");
    else if (table === "SKU_Name" && method === "POST") log.push("UPSERT SKU_Name");
    return inner(url, init);
  };
  archiveRpc = () => { assert.equal(runs[0].status, "completed", "lượt đã completed trước khi lưu trữ"); return { archived: 1, archivedSkus: ["900000095"], kept: 0, keptSkus: [] }; };
  runs.push(makeRun({ mode: "full", change_counts: { skuAdded: 1, skuMissing: 1 }, staged_missing_skus: [missingRow("900000095")] }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(log, [
    "PATCH applied_at,error_message,status",
    "UPSERT SKU_Name",
    "HEAD SKU_Name", "HEAD sku_combo_links",
    "PATCH completed_at,error_message,status,verification",
    "RPC archive",
    "PATCH archive_kept_codes,change_counts,changes",
  ]);
  assert.equal(result.body.data.changeCounts.skuArchived, 1, "phản hồi cho web có số đã lưu trữ");
  assert.deepEqual([runs[0].status, runs[0].change_counts.skuArchived, runs[0].archive_kept_codes.length], ["completed", 1, 0]);
});

test("archive: đếm bảng lỗi thì lượt failed và KHÔNG gọi RPC lưu trữ (không xoá SKU khi lượt chưa completed)", async () => {
  skus.push(missingRow("900000096"));
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === "HEAD" ? new Response(null, { status: 503 }) : inner(url, init));
  archiveRpc = () => { throw new Error("không được gọi"); };
  runs.push(makeRun({ mode: "full", change_counts: { skuAdded: 1, skuMissing: 1 }, staged_missing_skus: [missingRow("900000096")] }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, "APPLY_FAILED");
  assert.equal(runs[0].status, "failed");
  assert.equal(archiveCalls.length, 0);
  assert.ok(skus.some(row => row.sku === "900000096"));
});

test("archive: lỗi RPC không làm hỏng lượt — vẫn completed, ghi verification.archiveError, SKU đã ghi vẫn giữ", async () => {
  skus.push(missingRow("900000093"));
  archiveRpc = () => json({ message: "permission denied for function sku_archive_missing" }, 403);
  runs.push(makeRun({ mode: "full", change_counts: { skuAdded: 1, skuMissing: 1 }, staged_missing_skus: [missingRow("900000093")] }));
  const result = await call({ action: "apply", runId: RUN_A });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "completed");
  assert.equal(runs[0].status, "completed");
  assert.match(result.body.data.verification.archiveError, /sku_archive_missing HTTP 403/);
  assert.match(runs[0].verification.archiveError, /HTTP 403/);
  assert.equal(runs[0].verification.skuCount, 2, "giữ số liệu xác minh đã ghi lúc completed");
  assert.deepEqual(runs[0].archive_kept_codes, []);
  assert.deepEqual([result.body.data.changeCounts.skuArchived, result.body.data.changeCounts.skuArchiveKept], [0, 0]);
  assert.ok(skus.some(row => row.sku === "900000001"), "SKU của bản xem trước đã ghi");
  assert.ok(skus.some(row => row.sku === "900000093"), "SKU thiếu còn nguyên, lượt sau thử lại");
});

test("archive: gia tăng, lượt cũ chưa có danh sách hoặc danh sách rỗng thì không gọi RPC (hành vi cũ)", async () => {
  archiveRpc = () => { throw new Error("không được gọi"); };
  for (const over of [{ mode: "incremental", staged_missing_skus: [missingRow("900000094")] }, { mode: "full" }, { mode: "full", staged_missing_skus: [] }]) {
    runs.length = 0; skus.length = 0;
    runs.push(makeRun(over));
    const result = await call({ action: "apply", runId: RUN_A });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.data.changeCounts.skuArchived, undefined, JSON.stringify(over));
    assert.equal(runs[0].changes.skus, undefined);
  }
  assert.equal(archiveCalls.length, 0);
});

test("auto: ngưỡng đọc từ sync_auto_settings; Admin tạm dừng thì giữ lại", async () => {
  holdLease();
  settings.push({ singleton: true, enabled: true, thresholds: { sku: { maxUpdated: 1000 } } });
  runs.push(makeRun({ staged_skus: updatedStaged(600), change_counts: { skuUpdated: 600 } }));
  const result = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(result.body.data.status, "completed", JSON.stringify(result.body));
  settings[0].enabled = false;
  runs.length = 0; skus.length = 0;
  runs.push(makeRun({ change_counts: { skuAdded: 1 } }));
  const paused = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(paused.body.data.status, "held");
  assert.match(paused.body.data.held.reason, /tạm dừng/);
  assert.equal(skus.length, 0);
});

test("auto: hàng rào khoá thuê — thiếu holder, máy khác đã giành khoá hoặc khoá hết hạn thì LEASE_LOST, không tạo/ghi gì", async () => {
  runs.push(makeRun({ change_counts: { skuAdded: 1 } }));
  const cases = [
    ["không gửi holder", () => holdLease(), {}],
    ["máy khác giữ khoá", () => holdLease("may-test-02#zzz999"), { holder: HOLDER }],
    ["khoá hết hạn", () => holdLease(HOLDER, -1 * MIN), { holder: HOLDER }],
    ["chưa từng thuê khoá", () => leases.clear(), { holder: HOLDER }],
  ];
  for (const [label, setup, extra] of cases) {
    setup();
    const result = await call({ action: "apply", runId: RUN_A, auto: true, ...extra });
    assert.deepEqual([result.status, result.body.error?.code], [409, "LEASE_LOST"], label);
    assert.equal(runs[0].status, "previewed", label);
    assert.equal(skus.length, 0, label);
  }
  holdLease("may-test-02#zzz999");
  const preview = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), source: "auto", device: "may-test-01", holder: HOLDER });
  assert.deepEqual([preview.status, preview.body.error?.code], [409, "LEASE_LOST"]);
  assert.equal(runs.length, 1, "không tạo bản xem trước khi mất khoá");
  const manual = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
  assert.equal(manual.status, 200, "lượt tay trên web không cần khoá thuê");
  const longHolder = "x".repeat(60) + "#abc123";
  leases.clear();
  assert.equal((await call({ action: "lease", kind: "sku", holder: longHolder })).body.data.holder, longHolder, "holder 67 ký tự không bị cắt");
});

test("history: lastAutoFullAt = lượt toàn bộ tự động gần nhất đã hoàn tất hoặc giữ lại", async () => {
  runs.push(makeRun({ id: RUN_A, mode: "full", status: "completed", run_source: "manual", created_at: iso(-2 * MIN) }));
  assert.equal((await call({ action: "history" })).body.data.lastAutoFullAt, null, "lượt tay không tính");
  runs.push(makeRun({ id: RUN_B, mode: "full", status: "held", run_source: "auto", created_at: iso(-5 * MIN) }));
  runs.push(makeRun({ id: "33333333-3333-4333-8333-333333333333", mode: "full", status: "failed", run_source: "auto", created_at: iso(-1 * MIN) }));
  runs.push(makeRun({ id: "44444444-4444-4444-8444-444444444444", mode: "incremental", status: "completed", run_source: "auto", created_at: iso(0) }));
  assert.equal((await call({ action: "history" })).body.data.lastAutoFullAt, runs[1].created_at);
});

test("lease: máy khác đang giữ thì ok:false; cùng máy gia hạn được; nhả sai máy không có tác dụng", async () => {
  const first = await call({ action: "lease", kind: "sku", holder: "may-test-01" });
  assert.equal(first.status, 200);
  assert.equal(first.body.data.ok, true);
  assert.ok(Date.parse(first.body.data.leasedUntil) > Date.now() + 14 * MIN);
  const other = await call({ action: "lease", kind: "sku", holder: "may-test-02" });
  assert.deepEqual([other.body.data.ok, other.body.data.holder], [false, "may-test-01"]);
  const again = await call({ action: "lease", kind: "sku", holder: "may-test-01" });
  assert.equal(again.body.data.ok, true);
  const groupUid = await call({ action: "lease", kind: "group_uid", holder: "may-test-02" });
  assert.equal(groupUid.body.data.ok, true, "khoá theo từng loại");
  const wrong = await call({ action: "release", kind: "sku", holder: "may-test-02" });
  assert.equal(wrong.body.data.released, false);
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-02" })).body.data.ok, false);
  await call({ action: "release", kind: "sku", holder: "may-test-01" });
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-02" })).body.data.ok, true);
  leases.set("sku", { holder: "may-test-02", leased_until: iso(-1 * MIN) });
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-03" })).body.data.ok, true, "khoá hết hạn thì máy khác giành được");
  const invalid = await call({ action: "lease", kind: "khac", holder: "may-test-01" });
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, "INVALID_KIND"]);
  const noHolder = await call({ action: "lease", kind: "sku", holder: "   " });
  assert.deepEqual([noHolder.status, noHolder.body.error.code], [400, "INVALID_HOLDER"]);
});

test("lease: hai loại tự động mới cut_adj / storage_risk (sync_auto_v2.sql) thuê và nhả qua sku-sync, khoá riêng từng loại", async () => {
  for (const kind of ["cut_adj", "storage_risk"]) {
    const got = await call({ action: "lease", kind, holder: "may-test-01", cooldownSeconds: 600 });
    assert.equal(got.status, 200, `${kind}: ${JSON.stringify(got.body)}`);
    assert.equal(got.body.data.ok, true, `${kind} thuê được`);
    assert.equal(leases.get(kind).holder, "may-test-01");
    assert.equal((await call({ action: "lease", kind, holder: "may-test-02" })).body.data.ok, false, `${kind}: máy khác đang giữ`);
    const done = await call({ action: "release", kind, holder: "may-test-01", finished: true });
    assert.equal(done.body.data.released, true, `${kind} nhả được`);
  }
  assert.equal(leases.has("sku"), false, "không đụng khoá sku");
  assert.equal(leases.has("group_uid"), false, "không đụng khoá group_uid");
  const config = await call({ action: "auto-config" });
  assert.deepEqual(Object.keys(config.body.data.thresholds).sort(), ["group_uid", "sku"], "ngưỡng chỉ cho 2 loại có xem trước");
  const invalid = await call({ action: "release", kind: "cut-adj", holder: "may-test-01" });
  assert.deepEqual([invalid.status, invalid.body.error.code], [400, "INVALID_KIND"]);
});

test("lease: giãn cách giữa các máy — lượt theo lịch bị từ chối (COOLDOWN) khi lượt cùng loại vừa kết thúc; chạy ngay / lỗi thì không", async () => {
  const LOOP = 30 * 60 - 120;
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-01", cooldownSeconds: LOOP })).body.data.ok, true, "chưa có mốc kết thúc");
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-01", cooldownSeconds: LOOP })).body.data.ok, true, "gia hạn của máy đang giữ");
  await call({ action: "release", kind: "sku", holder: "may-test-01" });
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-02", cooldownSeconds: LOOP })).body.data.ok, true, "nhả khoá do lỗi / bỏ qua không ghi mốc");
  await call({ action: "release", kind: "sku", holder: "may-test-02", finished: true });
  const cooled = await call({ action: "lease", kind: "sku", holder: "may-test-03", cooldownSeconds: LOOP });
  assert.equal(cooled.status, 200);
  assert.deepEqual([cooled.body.data.ok, cooled.body.data.reason], [false, "COOLDOWN"]);
  assert.ok(Date.parse(cooled.body.data.lastFinishedAt) <= Date.now());
  assert.ok(Date.parse(cooled.body.data.retryAfter) > Date.now() + 27 * MIN);
  assert.equal(leases.get("sku").holder, null, "COOLDOWN không đổi người giữ");
  assert.equal((await call({ action: "lease", kind: "group_uid", holder: "may-test-03", cooldownSeconds: LOOP })).body.data.ok, true, "giãn cách theo từng loại");
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-03", cooldownSeconds: "abc" })).body.data.ok, true, "chạy ngay / Extension cũ không gửi giãn cách");
  leases.set("sku", { holder: null, leased_until: null, last_finished_at: iso(-29 * MIN) });
  assert.equal((await call({ action: "lease", kind: "sku", holder: "may-test-04", cooldownSeconds: LOOP })).body.data.ok, true, "quá nhịp − 2 phút thì chạy");
});

test("auto-config: đọc mặc định khi chưa có dòng; Admin tắt được; nhịp ngoài 15–180 hoặc khoá lạ bị từ chối", async () => {
  const empty = await call({ action: "auto-config" });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.fullWindow, { start: "00:00", end: "05:00" });
  assert.equal(empty.body.data.enabled, true);
  assert.equal(empty.body.data.intervalMinutes, 30);
  assert.deepEqual(empty.body.data.thresholds.sku, { maxUpdated: 500, maxAdded: 500, maxMissing: 20, maxOrphaned: 0 });
  assert.deepEqual(empty.body.data.thresholds.group_uid, { maxChanges: 3000, maxMissing: 0, maxIssues: 0 });
  settings.push({ singleton: true, enabled: true, interval_minutes: 30, full_window_start: "00:00:00", full_window_end: "05:00:00", thresholds: { group_uid: { maxChanges: 3000, maxMissing: 0, maxIssues: 0 }, sku: { maxUpdated: 500, maxAdded: 500, maxMissing: 0, maxOrphaned: 0 } } });
  const off = await call({ action: "auto-config", set: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.data.enabled, false);
  assert.equal(settings[0].enabled, false);
  assert.equal(settings[0].updated_by, "user-1");
  const interval = await call({ action: "auto-config", set: { intervalMinutes: 60 } });
  assert.equal(interval.body.data.intervalMinutes, 60);
  for (const set of [{ intervalMinutes: 10 }, { intervalMinutes: 181 }, { enabled: "false" }, { thresholds: { sku: { maxUpdated: 99999 } } }, {}, []]) {
    const rejected = await call({ action: "auto-config", set });
    assert.equal(rejected.status, 400, JSON.stringify(set));
    assert.equal(rejected.body.error.code, "INVALID_CONFIG");
  }
  assert.equal(settings[0].interval_minutes, 60);
  assert.equal(settings[0].thresholds.sku.maxUpdated, 500, "ngưỡng không đổi được qua Edge");
  // 0.10.7: mốc lượt tự động kết thúc gần nhất theo loại (mọi máy) cho cảnh báo ngừng của Extension.
  assert.deepEqual(empty.body.data.lastFinishedAt, {}, "chưa có khoá nào");
  const finishedAt = iso(-5 * MIN);
  leases.set("group_uid", { holder: null, leased_until: null, last_finished_at: finishedAt });
  leases.set("cut_adj", { holder: "may-test-01#abc", leased_until: iso(10 * MIN), last_finished_at: null });
  const withLeases = await call({ action: "auto-config" });
  assert.deepEqual(withLeases.body.data.lastFinishedAt, { group_uid: finishedAt }, "chỉ loại đã có lượt kết thúc");
});

// ---- Cổng bản Extension + ghi nhận máy (sync_auto_v3.sql, Extension 0.10.10; kế hoạch docs/plans/2026-10-26-nhieu-admin-khac-ban-extension.md) ----
// >>> bảng ca so bản Extension: chép giống hệt giữa hai dòng này ở tests/sku_sync_function.mjs và tests/group_uid_sync_function.mjs
// [extVersion gửi lên (undefined = không gửi khoá), min_extension[loại], bị chặn?] — so từng đoạn số, không so chuỗi; extVersion sai dạng
// = chưa khai báo (bị chặn khi có mức); mức sai dạng / rỗng = không chặn.
const VERSION_CASES = [
  [undefined, "0.10.10", true],
  ["0.10.9", "0.10.10", true],
  ["0.10.10", "0.10.10", false],
  ["0.10.11", "0.10.10", false],
  ["0.11.0", "0.10.10", false],
  ["1.0.0", "0.10.10", false],
  ["0.9.99", "0.10.10", true],
  ["0.10.10", "0.10.9", false],
  ["0.10.8", "0.10.9", true],
  ["0.10.9.1", "0.10.10", true],
  ["abc", "0.10.10", true],
  ["", "0.10.10", true],
  [null, "0.10.10", true],
  [10, "0.10.10", true],
  [" 0.10.10", "0.10.10", true],
  ["0.10.9", "x", false],
  ["0.10.9", 10, false],
  ["0.10.9", { v: "0.10.10" }, false],
  [undefined, "", false],
  [undefined, null, false],
];
// <<< bảng ca so bản Extension
const DAY = 24 * 60 * MIN;
function setMin(minExtension) { settings.length = 0; settings.push({ singleton: true, enabled: true, interval_minutes: 30, min_extension: minExtension }); }
function versioned(body, version) { return version === undefined ? body : { ...body, extVersion: version }; }
function label(version, min) { return `${JSON.stringify(version) ?? "không gửi"} / mức ${JSON.stringify(min)}`; }

test("cổng bản: mức rỗng hoặc thiếu cột min_extension (Edge lên trước migration) → lease và preview đi qua như cũ dù không gửi extVersion", async () => {
  const states = [
    ["chưa có dòng cấu hình", () => { settings.length = 0; }],
    ["dòng cấu hình chưa có cột min_extension", () => { settings.length = 0; settings.push({ singleton: true, enabled: true }); }],
    ["min_extension = {}", () => setMin({})],
  ];
  for (const [name, setup] of states) {
    setup(); leases.clear(); runs.length = 0;
    const lease = await call({ action: "lease", kind: "sku", holder: HOLDER });
    assert.deepEqual([lease.status, lease.body.data?.ok], [200, true], name);
    const manual = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) });
    assert.equal(manual.status, 200, `${name}: ${JSON.stringify(manual.body)}`);
    const auto = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), source: "auto", device: "may-test-01", holder: HOLDER });
    assert.equal(auto.status, 200, `${name}: ${JSON.stringify(auto.body)}`);
    assert.ok(runs.length === 2 && runs.every(row => !("ext_version" in row)), `${name}: không gửi bản thì dòng lượt không có khoá ext_version`);
  }
});

test("cổng bản: bảng ca chung — lease sku và preview (tay, tự động) trả 409 EXTENSION_OUTDATED đúng ca; bị chặn thì không thuê khoá, không tạo lượt, không đọc SKU_Name", async () => {
  const reads = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? "GET") === "GET") reads.push(new URL(String(url)).pathname.replace("/rest/v1/", ""));
    return inner(url, init);
  };
  for (const [version, min, blocked] of VERSION_CASES) {
    const name = label(version, min);
    setMin({ sku: min }); leases.clear(); runs.length = 0;
    const lease = await call(versioned({ action: "lease", kind: "sku", holder: HOLDER }, version));
    if (blocked) {
      assert.deepEqual([lease.status, lease.body.error?.code], [409, "EXTENSION_OUTDATED"], `lease ${name}`);
      assert.equal(leases.has("sku"), false, `lease ${name}: không thuê khoá`);
    } else assert.deepEqual([lease.status, lease.body.data?.ok], [200, true], `lease ${name}: ${JSON.stringify(lease.body)}`);
    for (const extra of [{}, { source: "auto", device: "may-test-01", holder: HOLDER }]) {
      const how = `preview ${extra.source ?? "tay"} ${name}`;
      reads.length = 0; runs.length = 0;
      const preview = await call(versioned({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), ...extra }, version));
      if (blocked) {
        assert.deepEqual([preview.status, preview.body.error?.code], [409, "EXTENSION_OUTDATED"], how);
        assert.equal(runs.length, 0, `${how}: không tạo lượt`);
        assert.equal(reads.includes("SKU_Name"), false, `${how}: chặn trước khi đọc database`);
      } else assert.equal(preview.status, 200, `${how}: ${JSON.stringify(preview.body)}`);
    }
  }
});

test("cổng bản: mức theo loại — sku chỉ chặn lease kind=sku và preview; loại khác vẫn qua; release / apply / history / detail / auto-config không qua cổng", async () => {
  setMin({ sku: "0.10.10" });
  assert.equal((await call({ action: "lease", kind: "sku", holder: HOLDER })).body.error?.code, "EXTENSION_OUTDATED");
  assert.equal((await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) })).body.error?.code, "EXTENSION_OUTDATED");
  for (const kind of ["group_uid", "cut_adj", "storage_risk"]) {
    const got = await call({ action: "lease", kind, holder: HOLDER });
    assert.deepEqual([got.status, got.body.data?.ok], [200, true], kind);
  }
  setMin({ cut_adj: "0.10.10" });
  const cut = await call({ action: "lease", kind: "cut_adj", holder: "may-test-02#zz9999", extVersion: "0.10.9" });
  assert.deepEqual([cut.status, cut.body.error?.code], [409, "EXTENSION_OUTDATED"], "mức cut_adj chặn lease cut_adj");
  assert.equal((await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) })).status, 200, "mức cut_adj không chặn preview SKU");
  setMin({ sku: "0.10.10", group_uid: "0.10.10", cut_adj: "0.10.10", storage_risk: "0.10.10" });
  const invalid = await call({ action: "lease", kind: "khac", holder: HOLDER });
  assert.deepEqual([invalid.status, invalid.body.error?.code], [400, "INVALID_KIND"], "kind sai vẫn INVALID_KIND như cũ");
  const released = await call({ action: "release", kind: "group_uid", holder: HOLDER, finished: true });
  assert.deepEqual([released.status, released.body.data?.released], [200, true], "máy bị chặn vẫn nhả được khoá đang giữ");
  runs.length = 0;
  runs.push(makeRun());
  const applied = await call({ action: "apply", runId: RUN_A });
  assert.deepEqual([applied.status, applied.body.data?.status], [200, "completed"], "apply không qua cổng");
  for (const body of [{ action: "history" }, { action: "detail", runId: RUN_A }, { action: "auto-config" }]) {
    assert.equal((await call(body)).status, 200, body.action);
  }
});

test("ghi nhận máy: lease bị chặn vẫn ghi sync_auto_devices kèm ext_version (trước cổng); gửi lại giữ first_seen_at; lỗi ghi không làm hỏng lượt", async () => {
  setMin({ sku: "0.10.10" });
  const sent = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/rest/v1/sync_auto_devices") && init.method === "POST") sent.push({ url: String(url), prefer: init.headers?.Prefer, body: JSON.parse(init.body) });
    return inner(url, init);
  };
  const blocked = await call({ action: "lease", kind: "sku", holder: HOLDER, extVersion: "0.10.9" });
  assert.deepEqual([blocked.status, blocked.body.error?.code], [409, "EXTENSION_OUTDATED"]);
  assert.equal(devices.length, 1, "máy bị chặn vẫn được ghi nhận");
  assert.deepEqual([devices[0].holder, devices[0].device, devices[0].ext_version, devices[0].last_kind], [HOLDER, "may-test-01", "0.10.9", "sku"]);
  assert.match(sent[0].url, /\/sync_auto_devices\?on_conflict=holder$/);
  assert.equal(sent[0].prefer, "resolution=merge-duplicates,return=minimal");
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["device", "ext_version", "holder", "last_kind", "last_seen_at"], "không gửi first_seen_at (giữ lần đầu thấy)");
  const firstSeen = iso(-3 * DAY);
  Object.assign(devices[0], { first_seen_at: firstSeen, last_seen_at: firstSeen });
  const again = await call({ action: "lease", kind: "cut_adj", holder: HOLDER });
  assert.deepEqual([again.status, again.body.data?.ok], [200, true]);
  assert.equal(devices.length, 1, "cùng holder → một dòng");
  assert.equal(devices[0].first_seen_at, firstSeen, "gửi lần hai không đổi first_seen_at");
  assert.ok(Date.parse(devices[0].last_seen_at) > Date.now() - MIN, "cập nhật last_seen_at");
  assert.deepEqual([devices[0].ext_version, devices[0].last_kind], [null, "cut_adj"], "không khai báo bản → ghi đè null; loại gần nhất");
  await call({ action: "lease", kind: "storage_risk", holder: "may-test-02", extVersion: "0.10.10" });
  assert.deepEqual(devices.find(row => row.holder === "may-test-02")?.device, "may-test-02", "holder không có hậu tố mã → tên máy = holder");
  // Preview tự động có holder cũng ghi nhận trước cổng; lượt tay (không holder) và holder rỗng thì không ghi.
  const blockedPreview = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), source: "auto", device: "may-test-03", holder: "may-test-03#k7p2q9", extVersion: "0.10.9" });
  assert.equal(blockedPreview.body.error?.code, "EXTENSION_OUTDATED");
  assert.deepEqual(["device", "ext_version", "last_kind"].map(key => devices.find(row => row.holder === "may-test-03#k7p2q9")?.[key]), ["may-test-03", "0.10.9", "sku"]);
  const count = devices.length;
  await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), extVersion: "0.10.10" });
  assert.equal((await call({ action: "lease", kind: "sku", holder: "   ", extVersion: "0.10.10" })).body.error?.code, "INVALID_HOLDER");
  assert.equal(devices.length, count, "không holder → không ghi");
  // Bảng chưa có (Edge lên trước migration) hoặc mạng lỗi → bỏ qua, lượt vẫn chạy.
  setMin({});
  globalThis.fetch = async (url, init = {}) => String(url).includes("/rest/v1/sync_auto_devices") ? json({ code: "42P01", message: "relation \"public.sync_auto_devices\" does not exist" }, 404) : inner(url, init);
  leases.clear();
  assert.deepEqual(await call({ action: "lease", kind: "sku", holder: HOLDER, extVersion: "0.10.10" }).then(result => [result.status, result.body.data?.ok]), [200, true], "HTTP lỗi");
  globalThis.fetch = async (url, init = {}) => { if (String(url).includes("/rest/v1/sync_auto_devices")) throw new TypeError("fetch failed"); return inner(url, init); };
  leases.clear();
  assert.deepEqual(await call({ action: "lease", kind: "sku", holder: HOLDER }).then(result => [result.status, result.body.data?.ok]), [200, true], "mạng lỗi");
});

test("ext_version của lượt: có bản → ghi vào sku_sync_runs; không có / sai dạng → không có khoá; database chưa có cột → ghi lại không có cột", async () => {
  const ok = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), extVersion: "0.10.10" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(runs[0].ext_version, "0.10.10");
  for (const version of [undefined, "abc", null, "0.10.9.1"]) {
    runs.length = 0;
    const result = await call(versioned({ action: "preview", snapshot: snapshot(iso(-1 * MIN)) }, version));
    assert.equal(result.status, 200, label(version, null));
    assert.equal("ext_version" in runs[0], false, label(version, null));
  }
  const inner = globalThis.fetch, posted = [];
  globalThis.fetch = async (url, init = {}) => {
    if (new URL(String(url)).pathname === "/rest/v1/sku_sync_runs" && init.method === "POST") {
      const body = JSON.parse(init.body);
      posted.push("ext_version" in body);
      if ("ext_version" in body) return json({ code: "PGRST204", message: "Could not find the 'ext_version' column of 'sku_sync_runs' in the schema cache" }, 400);
    }
    return inner(url, init);
  };
  runs.length = 0;
  const legacy = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), extVersion: "0.10.10" });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
  assert.deepEqual(posted, [true, false], "thử có cột, báo thiếu cột thì ghi lại không có cột");
  assert.ok(runs.length === 1 && !("ext_version" in runs[0]));
  globalThis.fetch = async (url, init = {}) => new URL(String(url)).pathname === "/rest/v1/sku_sync_runs" && init.method === "POST" ? json({ message: "boom" }, 500) : inner(url, init);
  runs.length = 0;
  const broken = await call({ action: "preview", snapshot: snapshot(iso(-1 * MIN)), extVersion: "0.10.10" });
  assert.deepEqual([broken.status, broken.body.error?.code], [500, "SYNC_ERROR"], "lỗi khác vẫn báo như cũ");
  assert.match(broken.body.error.message, /Lưu bản xem trước HTTP 500/);
});

test("auto-config: minExtension đủ 4 loại (chuỗi hợp lệ hoặc null); devices ≤ 20, 14 ngày, mới nhất trước, chỉ 4 ký tự mã máy; bảng rỗng → [], đọc lỗi → vắng khoá devices; set min_extension bị từ chối", async () => {
  const empty = await call({ action: "auto-config" });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.data.minExtension, { sku: null, group_uid: null, cut_adj: null, storage_risk: null });
  assert.deepEqual(empty.body.data.devices, [], "bảng máy rỗng thật → devices: []");
  setMin({ sku: "0.10.10", group_uid: "0.10.9", cut_adj: "x", storage_risk: 10 });
  for (let index = 0; index < 25; index += 1) {
    const name = `may-test-${String(index + 1).padStart(2, "0")}`;
    devices.push({ holder: `${name}#${(index + 10).toString(36)}p7q2`, device: name, ext_version: index % 2 ? "0.12.2" : null, first_seen_at: iso(-30 * DAY), last_seen_at: iso(-index * 15 * 60 * MIN), last_kind: index % 2 ? "sku" : "storage_risk" });
  }
  devices.reverse();
  const config = await call({ action: "auto-config" });
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.data.minExtension, { sku: "0.10.10", group_uid: "0.10.9", cut_adj: null, storage_risk: null });
  const list = config.body.data.devices;
  assert.deepEqual(list.map(row => row.device), Array.from({ length: 20 }, (_, index) => `may-test-${String(index + 1).padStart(2, "0")}`), "20 máy, mới nhất trước");
  const seen = name => devices.find(row => row.device === name).last_seen_at;
  assert.deepEqual(list[0], { device: "may-test-01", id4: "ap7q", version: null, lastSeenAt: seen("may-test-01"), lastKind: "storage_risk" });
  assert.deepEqual(list[1], { device: "may-test-02", id4: "bp7q", version: "0.12.2", lastSeenAt: seen("may-test-02"), lastKind: "sku" });
  assert.equal(JSON.stringify(config.body).includes("p7q2"), false, "không trả holder / mã máy đầy đủ");
  devices.length = 0;
  devices.push(
    { holder: "may-test-01#k7p2q9", device: "may-test-01", ext_version: "0.12.2", first_seen_at: iso(-20 * DAY), last_seen_at: iso(-13 * DAY), last_kind: "group_uid" },
    { holder: "may-test-02#m3n4b5", device: "may-test-02", ext_version: "0.10.9", first_seen_at: iso(-20 * DAY), last_seen_at: iso(-15 * DAY), last_kind: "sku" },
  );
  assert.deepEqual((await call({ action: "auto-config" })).body.data.devices.map(row => [row.device, row.id4, row.version, row.lastKind]), [["may-test-01", "k7p2", "0.12.2", "group_uid"]], "máy không thấy trong 14 ngày bị bỏ");
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => String(url).includes("/rest/v1/sync_auto_devices") ? json({ code: "42P01", message: "relation does not exist" }, 404) : inner(url, init);
  const failed = await call({ action: "auto-config" });
  assert.equal(failed.status, 200, "đọc bảng máy lỗi: cấu hình vẫn dùng được");
  assert.equal("devices" in failed.body.data, false, "đọc bảng máy lỗi (HTTP) → vắng khoá devices, không trả [] giả");
  assert.equal(failed.body.data.minExtension.sku, "0.10.10");
  globalThis.fetch = async (url, init = {}) => { if (String(url).includes("/rest/v1/sync_auto_devices")) throw new TypeError("fetch failed"); return inner(url, init); };
  const offline = await call({ action: "auto-config" });
  assert.deepEqual([offline.status, "devices" in offline.body.data], [200, false], "mạng lỗi khi đọc bảng máy → vắng khoá devices");
  globalThis.fetch = inner;
  for (const set of [{ min_extension: { sku: "0.10.10" } }, { minExtension: { sku: "0.10.10" } }, { enabled: true, min_extension: {} }]) {
    const rejected = await call({ action: "auto-config", set });
    assert.deepEqual([rejected.status, rejected.body.error?.code], [400, "INVALID_CONFIG"], JSON.stringify(set));
  }
  assert.deepEqual(settings[0].min_extension, { sku: "0.10.10", group_uid: "0.10.9", cut_adj: "x", storage_risk: 10 }, "mức tối thiểu không đổi qua Edge");
});

test("cổng bản: câu báo — tự động (lease hoặc source auto) bảo Reload Extension + tab Inside / WMS; lượt tay bảo tải lại trang trước", async () => {
  setMin({ sku: "0.10.10", cut_adj: "0.10.10" });
  const cases = [
    [{ action: "lease", kind: "sku", holder: HOLDER, extVersion: "0.10.9" }, "Extension v0.10.9 quá cũ, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab Inside"],
    [{ action: "lease", kind: "sku", holder: HOLDER }, "Extension chưa khai báo bản, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab Inside"],
    [{ action: "lease", kind: "cut_adj", holder: HOLDER, extVersion: "abc" }, "Extension chưa khai báo bản, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab WMS"],
    [{ action: "preview", snapshot: snapshot(iso(-1 * MIN)), source: "auto", device: "may-test-01", holder: HOLDER, extVersion: "0.9.99" }, "Extension v0.9.99 quá cũ, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab Inside"],
    [{ action: "preview", snapshot: snapshot(iso(-1 * MIN)), extVersion: "0.10.9" }, "Extension v0.10.9 quá cũ, cần ≥ 0.10.10; hãy tải lại trang (Ctrl+F5); nếu vẫn báo, Reload Extension rồi tải lại tab Inside"],
    [{ action: "preview", snapshot: snapshot(iso(-1 * MIN)) }, "Extension chưa khai báo bản, cần ≥ 0.10.10; hãy tải lại trang (Ctrl+F5); nếu vẫn báo, Reload Extension rồi tải lại tab Inside"],
  ];
  for (const [body, message] of cases) {
    const result = await call(body);
    assert.deepEqual([result.status, result.body.ok, result.body.error?.code, result.body.error?.message], [409, false, "EXTENSION_OUTDATED", message], JSON.stringify({ ...body, snapshot: undefined }));
  }
});

const GATE_OPEN = "// >>> cổng bản Extension", GATE_CLOSE = "// <<< cổng bản Extension";
function gateBlock(source) {
  const text = source.replace(/\r\n/g, "\n"), start = text.indexOf(GATE_OPEN), end = text.indexOf(GATE_CLOSE);
  assert.ok(start >= 0 && end > start, "có khối cổng bản Extension giữa hai dòng chú thích mở / đóng");
  assert.equal(text.indexOf(GATE_OPEN, start + 1), -1, "chỉ một khối");
  return text.slice(start, end + GATE_CLOSE.length);
}

test("cổng bản: khối hàm chép GIỐNG HỆT từng ký tự ở sku-sync và group-uid-sync (deploy gửi 1 tệp mỗi hàm); sửa một ký tự ở một bản thì bị bắt", () => {
  const other = fs.readFileSync(new URL("../supabase/functions/group-uid-sync/index.ts", import.meta.url), "utf8");
  const same = (left, right) => assert.equal(gateBlock(left), gateBlock(right), "khối cổng bản Extension phải giống hệt ở hai Edge");
  same(SOURCE, other);
  const block = gateBlock(SOURCE);
  for (const name of ["const VERSION_RE = /^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/;", "function extVersionOf(", "function versionLess(", "function minExtensionFor(", "function extensionGate(", "async function recordDevice(", "async function deviceList("]) {
    assert.ok(block.includes(name), `khối có ${name}`);
  }
  const mutants = [
    other.replace("/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/", "/^\\d{1,3}\\.\\d{1,3}\\.\\d{1,4}$/"),
    other.replace("cần ≥ ", "cần >= "),
    other.replace("const DEVICE_LIST_LIMIT = 20;", "const DEVICE_LIST_LIMIT = 21;"),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(mutant, other, `đột biến ${index + 1} phải đổi được tệp`);
    assert.throws(() => same(SOURCE, mutant), undefined, `đột biến ${index + 1} phải bị bắt`);
  }
});
