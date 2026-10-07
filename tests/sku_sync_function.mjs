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
    id: RUN_A, status: "previewed", source: "inside-extension", cutoff: "26-10-01 00:00:00",
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
