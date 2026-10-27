// Kiểm tra Edge Function supabase/functions/group-uid-sync/index.ts (phần đồng bộ tự động, sync_auto_v1) không cần Deno hay Supabase thật:
// Node 24 tự bỏ khai báo kiểu khi import .ts; Deno.serve / Deno.env / fetch được giả lập bằng database trong bộ nhớ.
//   node tests/group_uid_sync_function.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { beforeEach, after } from "node:test";
import { pathToFileURL } from "node:url";

const SOURCE = fs.readFileSync(new URL("../supabase/functions/group-uid-sync/index.ts", import.meta.url), "utf8");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "group-uid-sync-test-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const RUN_A = "11111111-1111-4111-8111-111111111111";
let runs, settings, leases, devices, rpcCalls, requests, posts, handler;
// holder = tên máy + "#" + mã máy (auto-sync.js holderOf); lượt tự động phải đang giữ khoá thuê còn hạn mới được ghi.
const HOLDER = "may-test-01#abc123";
function holdLease(holder = HOLDER, untilMs = 10 * 60 * 1000) { leases.length = 0; leases.push({ kind: "group_uid", holder, leased_until: new Date(Date.now() + untilMs).toISOString() }); }

function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function select(rows, params) {
  let result = rows.filter(row => [...params].every(([key, value]) => {
    if (["select", "order", "limit", "on_conflict"].includes(key)) return true;
    if (value.startsWith("in.(")) return value.slice(4, -1).split(",").includes(String(row[key]));
    const [op, ...rest] = value.split(".");
    if (op === "gte") return Date.parse(row[key]) >= Date.parse(rest.join("."));
    if (op !== "eq") throw new Error(`toán tử chưa giả lập: ${op}`);
    return String(row[key]) === rest.join(".");
  }));
  const order = params.get("order");
  if (order) {
    const [field, direction] = order.split(".");
    result = [...result].sort((x, y) => (Date.parse(x[field]) - Date.parse(y[field])) * (direction === "desc" ? -1 : 1));
  }
  const limit = Number(params.get("limit"));
  return limit ? result.slice(0, limit) : result;
}
function makeRun(over = {}) {
  return { id: RUN_A, mode: "incremental", status: "previewed", change_counts: { added: 2, updated: 1, unchanged: 10, missing: 0, issues: 0, totalChanges: 3 }, source: "auto", device: "may-test-01", auto_hold: null, created_at: new Date().toISOString(), ...over };
}

function install() {
  globalThis.Deno = {
    env: { get: key => ({ SUPABASE_URL: "https://example.invalid", SUPABASE_SERVICE_ROLE_KEY: "test-service-key" })[key] },
    serve: h => { handler = h; },
  };
  globalThis.fetch = async (url, init = {}) => {
    const target = new URL(String(url));
    const method = init.method ?? "GET";
    const table = target.pathname.replace("/rest/v1/", "");
    requests.push(`${method} ${table}?${target.searchParams}`);
    if (target.pathname === "/auth/v1/user") return json({ id: "user-1" });
    if (table === "user_roles") return json([{ username: "admin-test", role: "admin" }]);
    if (table.startsWith("rpc/")) {
      const name = table.slice(4), body = JSON.parse(init.body);
      rpcCalls.push({ name, body });
      if (name === "group_uid_sync_prepare") return json({ runId: RUN_A, mode: body.p_mode, status: "running", rangeFrom: null, rangeTo: body.p_range_to, source: body.p_source, device: body.p_device });
      if (name === "group_uid_sync_apply") { runs[0].status = "completed"; return json({ runId: body.p_run_id, status: "completed", changeCounts: runs[0].change_counts, verification: {} }); }
      if (name === "sync_auto_lease") return json({ ok: true, holder: body.p_holder, leasedUntil: new Date(Date.now() + body.p_ttl_seconds * 1000).toISOString() });
      if (name === "sync_auto_release") return json({ ok: true, released: true });
      if (name === "group_uid_sync_preview") { runs[0].status = "previewed"; return json({ runId: body.p_run_id, status: "previewed", changeCounts: runs[0].change_counts }); }
      throw new Error(`rpc chưa giả lập: ${name}`);
    }
    const store = { group_uid_sync_runs: runs, sync_auto_settings: settings, sync_auto_leases: leases, sync_auto_devices: devices, group_uid_sync_changes: [], group_uid_sync_state: [{ singleton: true, last_successful_full_at: null }], group_uid_sync_pages: [], group_uid_sync_staging: [] }[table];
    if (!store) throw new Error(`fetch không được giả lập: ${url}`);
    if (method === "GET") return json(select(store, target.searchParams));
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "PATCH") {
      const matched = select(store, target.searchParams);
      matched.forEach(row => Object.assign(row, JSON.parse(init.body)));
      return json(matched);
    }
    if (method === "POST") {
      const body = JSON.parse(init.body);
      posts.push({ table, body, prefer: init.headers?.Prefer });
      // Upsert PostgREST (merge-duplicates, on_conflict=holder) chỉ cập nhật cột có trong payload; chèn mới thì cột vắng lấy mặc định now().
      if (table === "sync_auto_devices") {
        const existing = devices.find(row => row.holder === body.holder), now = new Date().toISOString();
        if (existing) Object.assign(existing, body); else devices.push({ first_seen_at: now, last_seen_at: now, ...body });
      }
      return new Response(null, { status: 201 });
    }
    throw new Error(`phương thức chưa giả lập: ${method}`);
  };
}

const file = path.join(TEMP, "group-uid-sync.ts");
fs.writeFileSync(file, SOURCE);
runs = []; settings = []; leases = []; devices = []; rpcCalls = []; requests = []; posts = [];
install();
const { evaluateGroupUidHold } = await import(pathToFileURL(file).href);

beforeEach(() => { runs = []; settings = []; leases = []; devices = []; rpcCalls = []; requests = []; posts = []; install(); });

async function call(body) {
  const response = await handler(new Request("https://example.invalid/functions/v1/group-uid-sync", {
    method: "POST",
    headers: { authorization: "Bearer test-token", "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

test("evaluateGroupUidHold: dưới ngưỡng không giữ; vượt 3.000 thay đổi, thiếu hoặc WMS cũ hơn thì giữ kèm lý do", () => {
  assert.equal(evaluateGroupUidHold({ added: 2000, updated: 1000, missing: 0, issues: 0 }, undefined), null, "đúng 3.000 vẫn tự áp dụng");
  const big = evaluateGroupUidHold({ added: 3000, updated: 512 }, undefined);
  assert.equal(big.reason, "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000");
  assert.equal(big.counts.totalChanges, 3512);
  const warn = evaluateGroupUidHold({ added: 1, missing: 4, issues: 2 }, { maxChanges: 3000, maxMissing: 0, maxIssues: 0 });
  assert.equal(warn.reason, "Giữ lại: 4 UID không còn trên WMS; 2 UID WMS cũ hơn Supabase");
  assert.equal(evaluateGroupUidHold({ added: 5000 }, { maxChanges: 6000 }), null, "ngưỡng riêng từ cấu hình");
  assert.ok(evaluateGroupUidHold({ added: 3001 }, { maxChanges: "abc", maxMissing: -1 }), "ngưỡng hỏng quay về mặc định");
  assert.equal(evaluateGroupUidHold(null, null), null);
});

test("ingest: group_rfid_mapping vào staging viết hoa, rác → null; group_rfid_known = dòng có khoá (Extension cũ không gửi → false, apply giữ RFID cũ)", async () => {
  runs.push(makeRun({ status: "running", expected_pages: null }));
  const base = { qty: 5, status: "Available", updated_date: "2026-10-20T01:00:00.000Z", products: [] };
  const rows = [
    { ...base, group_uid_code: "1028260000000701", group_rfid_mapping: " a00000000004 " },
    { ...base, group_uid_code: "1028260000000702" },
    { ...base, group_uid_code: "1028260000000703", group_rfid_mapping: "A0000-0000004" },
    { ...base, group_uid_code: "1028260000000704", group_rfid_mapping: "A".repeat(41) },
    { ...base, group_uid_code: "1028260000000705", group_rfid_mapping: ["A00000000004"] },
    { ...base, group_uid_code: "1028260000000706", group_rfid_mapping: "" },
    { ...base, group_uid_code: "1028260000000707", group_rfid_mapping: null },
  ];
  const result = await call({ action: "ingest", runId: RUN_A, page: 1, totalPages: 1, total: rows.length, rows });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const staged = posts.find(item => item.table === "group_uid_sync_staging")?.body;
  assert.ok(Array.isArray(staged), "phải lưu trang vào staging");
  assert.deepEqual(staged.map(row => [row.group_uid_code, row.group_rfid_mapping, row.group_rfid_known]), [
    // Codex 20/10: có giá trị nhưng sai dạng (703 ký tự lạ, 704 dài 41, 705 mảng) → known = false (giữ RFID đang lưu, không xoá nhầm)
    ["1028260000000701", "A00000000004", true], ["1028260000000702", null, false], ["1028260000000703", null, false],
    ["1028260000000704", null, false], ["1028260000000705", null, false], ["1028260000000706", null, true],
    ["1028260000000707", null, true],
  ]);
  assert.ok(staged.every(row => row.run_id === RUN_A && "group_rfid_mapping" in row), "mọi dòng staging có run_id + khoá group_rfid_mapping");
});

test("ingest: purchase_order (số PO nguồn, cut_group_uid_po_v1) vào staging; sai dạng / Extension cũ không gửi khoá → purchase_order_known = false (giữ PO đang lưu)", async () => {
  runs.push(makeRun({ status: "running", expected_pages: null }));
  const base = { qty: 5, status: "Available", updated_date: "2026-10-21T01:00:00.000Z", products: [] };
  const rows = [
    { ...base, group_uid_code: "1028260000000801", purchase_order: " 100000001 ", purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000802" },
    { ...base, group_uid_code: "1028260000000803", purchase_order: "PO-100000001", purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000804", purchase_order: "12345", purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000805", purchase_order: "1".repeat(41), purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000806", purchase_order: 100000001, purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000807", purchase_order: "", purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000808", purchase_order: null, purchase_order_known: true },
    { ...base, group_uid_code: "1028260000000809", purchase_order: "1".repeat(40) },
    { ...base, group_uid_code: "1028260000000810", purchase_order: "100000002", purchase_order_known: false },
    { ...base, group_uid_code: "1028260000000811", purchase_order: null },
    { ...base, group_uid_code: "1028260000000812", purchase_order: "100000003", group_rfid_mapping: "a00000000005" },
  ];
  const result = await call({ action: "ingest", runId: RUN_A, page: 1, totalPages: 1, total: rows.length, rows });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const staged = posts.find(item => item.table === "group_uid_sync_staging")?.body;
  assert.ok(Array.isArray(staged), "phải lưu trang vào staging");
  assert.deepEqual(staged.map(row => [row.group_uid_code, row.purchase_order, row.purchase_order_known]), [
    ["1028260000000801", "100000001", true],
    // Extension cũ (≤ 0.10.3) không gửi khoá → không biết, apply giữ PO đang lưu
    ["1028260000000802", null, false],
    // Có giá trị nhưng sai dạng (ký tự lạ, < 6 hoặc > 40 chữ số, không phải chuỗi) → không biết, không xoá nhầm
    ["1028260000000803", null, false], ["1028260000000804", null, false], ["1028260000000805", null, false],
    ["1028260000000806", null, false],
    // Có khoá, rỗng / null = UID không nhận theo PO (kiểm kê, chuyển kho, tạo tay) → biết, PO null
    ["1028260000000807", null, true], ["1028260000000808", null, true],
    ["1028260000000809", "1".repeat(40), true],
    // Extension báo rõ không biết → không ghi
    ["1028260000000810", null, false],
    ["1028260000000811", null, true],
    ["1028260000000812", "100000003", true],
  ]);
  assert.deepEqual([staged[11].group_rfid_mapping, staged[11].group_rfid_known], ["A00000000005", true], "PO không làm hỏng RFID cùng dòng");
  assert.ok(staged.every(row => "purchase_order" in row && typeof row.purchase_order_known === "boolean"), "mọi dòng staging có khoá purchase_order + cờ boolean");
});

test("prepare: lượt tự động truyền source auto + tên máy; thiếu trường thì manual/null như cũ", async () => {
  const auto = await call({ action: "prepare", mode: "incremental", source: "auto", device: " may-test-01 " });
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.deepEqual([rpcCalls[0].body.p_source, rpcCalls[0].body.p_device], ["auto", "may-test-01"]);
  assert.equal(auto.body.data.source, "auto");
  await call({ action: "prepare", mode: "full" });
  assert.deepEqual([rpcCalls[1].body.p_source, rpcCalls[1].body.p_device], ["manual", null]);
  await call({ action: "prepare", mode: "full", source: "khac", device: "x".repeat(200) });
  assert.deepEqual([rpcCalls[2].body.p_source, rpcCalls[2].body.p_device.length], ["manual", 60]);
});

test("apply auto: vượt ngưỡng thì chuyển held, ghi auto_hold, không gọi RPC apply; lượt held không áp dụng được nữa", async () => {
  holdLease();
  runs.push(makeRun({ change_counts: { added: 3000, updated: 512, missing: 0, issues: 0 } }));
  const result = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.status, "held");
  assert.equal(result.body.data.held.reason, "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000");
  assert.equal(runs[0].auto_hold, "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000");
  assert.equal(runs[0].status, "held");
  assert.ok(runs[0].completed_at, "held là trạng thái kết thúc, có giờ kết thúc");
  assert.equal(rpcCalls.length, 0);
  for (const body of [{ action: "apply", runId: RUN_A }, { action: "apply", runId: RUN_A, auto: true, holder: HOLDER }]) {
    const again = await call(body);
    assert.deepEqual([again.status, again.body.error.code, again.body.error.message], [409, "RUN_HELD", "Lượt đã giữ lại, chạy lại tay để xem bản mới"]);
  }
  assert.equal(rpcCalls.length, 0);
  const detail = await call({ action: "detail", runId: RUN_A });
  assert.equal(detail.body.data.status, "held");
});

test("apply auto: hàng rào khoá thuê — thiếu holder, máy khác giữ khoá hoặc khoá hết hạn thì LEASE_LOST, không gọi RPC apply", async () => {
  runs.push(makeRun());
  const cases = [
    ["không gửi holder", () => holdLease(), {}],
    ["máy khác giữ khoá", () => holdLease("may-test-02#zzz999"), { holder: HOLDER }],
    ["khoá hết hạn", () => holdLease(HOLDER, -60 * 1000), { holder: HOLDER }],
    ["chưa từng thuê khoá", () => { leases.length = 0; }, { holder: HOLDER }],
  ];
  for (const [label, setup, extra] of cases) {
    setup();
    const result = await call({ action: "apply", runId: RUN_A, auto: true, ...extra });
    assert.deepEqual([result.status, result.body.error?.code], [409, "LEASE_LOST"], label);
    assert.equal(runs[0].status, "previewed", label);
  }
  assert.equal(rpcCalls.length, 0);
});

test("apply auto: dưới ngưỡng thì áp dụng; không có auto thì áp dụng như cũ dù vượt ngưỡng", async () => {
  holdLease();
  runs.push(makeRun());
  const result = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(result.body.data.status, "completed", JSON.stringify(result.body));
  assert.deepEqual(rpcCalls.map(item => item.name), ["group_uid_sync_apply"]);
  runs.length = 0; rpcCalls.length = 0; requests.length = 0;
  runs.push(makeRun({ change_counts: { added: 9000, missing: 5 } }));
  const manual = await call({ action: "apply", runId: RUN_A });
  assert.equal(manual.body.data.status, "completed");
  assert.equal(runs[0].auto_hold, null);
  assert.equal(requests.some(item => item.includes("sync_auto_settings") || item.includes("sync_auto_leases")), false, "lượt tay không đọc cấu hình / khoá tự động");
});

test("apply auto: Admin tạm dừng hoặc ngưỡng cấu hình riêng", async () => {
  holdLease();
  settings.push({ singleton: true, enabled: false, thresholds: {} });
  runs.push(makeRun());
  const paused = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(paused.body.data.status, "held");
  assert.match(paused.body.data.held.reason, /tạm dừng/);
  settings[0] = { singleton: true, enabled: true, thresholds: { group_uid: { maxChanges: 10000, maxMissing: 10, maxIssues: 0 } } };
  runs[0].status = "previewed";
  runs[0].change_counts = { added: 9000, missing: 5 };
  const allowed = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.equal(allowed.body.data.status, "completed", JSON.stringify(allowed.body));
});

test("history/detail: trả source, device, autoHold; lượt cũ chưa có cột thì manual", async () => {
  runs.push(makeRun({ auto_hold: "Giữ lại: thử" }), makeRun({ id: "22222222-2222-4222-8222-222222222222", source: undefined, device: undefined, auto_hold: undefined }));
  const history = await call({ action: "history" });
  assert.equal(history.status, 200);
  assert.ok(requests.some(item => item.includes("auto_hold")), "history phải chọn cột mới");
  assert.deepEqual(history.body.data.runs.map(run => [run.source, run.device, run.autoHold]), [["auto", "may-test-01", "Giữ lại: thử"], ["manual", null, null]]);
});

test("history: lastAutoFullAt = lượt toàn bộ tự động gần nhất đã hoàn tất hoặc giữ lại (mọi máy cùng thấy)", async () => {
  const at = minutes => new Date(Date.now() + minutes * 60 * 1000).toISOString();
  runs.push(makeRun({ id: "33333333-3333-4333-8333-333333333333", mode: "full", status: "completed", source: "manual", created_at: at(-1) }));
  assert.equal((await call({ action: "history" })).body.data.lastAutoFullAt, null, "lượt tay không tính");
  runs.push(makeRun({ id: "44444444-4444-4444-8444-444444444444", mode: "full", status: "held", source: "auto", created_at: at(-50) }));
  runs.push(makeRun({ id: "55555555-5555-4555-8555-555555555555", mode: "full", status: "completed", source: "auto", created_at: at(-90) }));
  runs.push(makeRun({ id: "66666666-6666-4666-8666-666666666666", mode: "full", status: "failed", source: "auto", created_at: at(-5) }));
  runs.push(makeRun({ id: "77777777-7777-4777-8777-777777777777", mode: "incremental", status: "completed", source: "auto", created_at: at(0) }));
  assert.equal((await call({ action: "history" })).body.data.lastAutoFullAt, runs[1].created_at);
});

test("preview: lượt tự động phải còn giữ khoá thuê; mất khoá → đóng lượt failed, 409 LEASE_LOST, không gọi RPC preview", async () => {
  const cases = [
    ["không gửi holder", () => holdLease(), {}],
    ["máy khác giữ khoá", () => holdLease("may-test-02#zzz999"), { holder: HOLDER }],
    ["khoá hết hạn", () => holdLease(HOLDER, -60 * 1000), { holder: HOLDER }],
  ];
  for (const [label, setup, extra] of cases) {
    runs.length = 0; rpcCalls.length = 0; requests.length = 0;
    runs.push(makeRun({ status: "running", change_counts: null }));
    setup();
    const result = await call({ action: "preview", runId: RUN_A, ...extra });
    assert.deepEqual([result.status, result.body.error?.code, result.body.error?.message], [409, "LEASE_LOST", "Mất khoá thuê; lượt tự động đã dừng"], label);
    assert.deepEqual([runs[0].status, runs[0].error_message], ["failed", "Mất khoá thuê"], `${label}: đóng lượt để không chặn ACTIVE_RUN`);
    assert.ok(runs[0].completed_at, label);
    assert.equal(rpcCalls.length, 0, label);
    assert.ok(requests.some(item => item.startsWith("DELETE group_uid_sync_staging")), `${label}: dọn staging`);
  }
});

test("preview: lượt tự động còn giữ khoá thì xem trước; lượt tay không kiểm khoá như cũ", async () => {
  holdLease();
  runs.push(makeRun({ status: "running", change_counts: null }));
  const auto = await call({ action: "preview", runId: RUN_A, holder: HOLDER });
  assert.equal(auto.status, 200, JSON.stringify(auto.body));
  assert.deepEqual(rpcCalls.map(item => item.name), ["group_uid_sync_preview"]);
  runs.length = 0; rpcCalls.length = 0; requests.length = 0; leases.length = 0;
  runs.push(makeRun({ status: "running", source: "manual", device: null, change_counts: null }));
  const manual = await call({ action: "preview", runId: RUN_A });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  assert.equal(requests.some(item => item.includes("sync_auto_leases")), false, "lượt tay không đọc khoá");
  runs.length = 0; rpcCalls.length = 0;
  runs.push(makeRun({ status: "running", source: undefined, change_counts: null }));
  assert.equal((await call({ action: "preview", runId: RUN_A })).status, 200, "lượt cũ chưa có cột source = tay");
});

test("lease/release: cooldownSeconds và finished chỉ gửi xuống RPC khi hợp lệ (Extension cũ không gửi → như cũ)", async () => {
  const leaseWith = async extra => { rpcCalls.length = 0; await call({ action: "lease", kind: "group_uid", holder: HOLDER, ...extra }); return rpcCalls[0].body; };
  assert.equal("p_cooldown_seconds" in await leaseWith({}), false);
  assert.equal((await leaseWith({ cooldownSeconds: 1680 })).p_cooldown_seconds, 1680);
  assert.equal((await leaseWith({ cooldownSeconds: 99999 })).p_cooldown_seconds, 10800, "tối đa 180 phút");
  for (const value of ["abc", -5, 0, null]) assert.equal("p_cooldown_seconds" in await leaseWith({ cooldownSeconds: value }), false, String(value));
  const releaseWith = async extra => { rpcCalls.length = 0; await call({ action: "release", kind: "group_uid", holder: HOLDER, ...extra }); return rpcCalls[0].body; };
  assert.equal((await releaseWith({ finished: true })).p_finished, true);
  assert.equal("p_finished" in await releaseWith({}), false);
  assert.equal("p_finished" in await releaseWith({ finished: "true" }), false);
});

test("lease + auto-config có trên cả group-uid-sync", async () => {
  const lease = await call({ action: "lease", kind: "group_uid", holder: "may-test-01" });
  assert.equal(lease.body.data.ok, true);
  assert.equal(rpcCalls[0].body.p_ttl_seconds, 900);
  const config = await call({ action: "auto-config" });
  assert.equal(config.body.data.thresholds.group_uid.maxChanges, 3000);
  const longHolder = "x".repeat(60) + "#abc123";
  await call({ action: "lease", kind: "group_uid", holder: longHolder });
  assert.equal(rpcCalls[1].body.p_holder, longHolder, "holder 67 ký tự không bị cắt");
  const bad = await call({ action: "release", kind: "x", holder: "may-test-01" });
  assert.deepEqual([bad.status, bad.body.error.code], [400, "INVALID_KIND"]);
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
const MINUTE = 60 * 1000, DAY = 24 * 60 * MINUTE;
function ago(ms) { return new Date(Date.now() - ms).toISOString(); }
function setMin(minExtension) { settings.length = 0; settings.push({ singleton: true, enabled: true, interval_minutes: 30, min_extension: minExtension }); }
function versioned(body, version) { return version === undefined ? body : { ...body, extVersion: version }; }
function label(version, min) { return `${JSON.stringify(version) ?? "không gửi"} / mức ${JSON.stringify(min)}`; }

test("cổng bản: bảng ca so bản giống hệt tests/sku_sync_function.mjs (một bảng ca cho mọi nơi so bản)", () => {
  const table = text => {
    const body = text.replace(/\r\n/g, "\n"), start = body.indexOf("// >>> bảng ca so bản Extension"), end = body.indexOf("// <<< bảng ca so bản Extension");
    assert.ok(start >= 0 && end > start, "có bảng ca giữa hai dòng chú thích mở / đóng");
    return body.slice(start, end);
  };
  const mine = fs.readFileSync(new URL(import.meta.url), "utf8"), other = fs.readFileSync(new URL("./sku_sync_function.mjs", import.meta.url), "utf8");
  assert.equal(table(mine), table(other), "bảng ca hai tệp test phải giống hệt");
  const mutant = other.replace('["0.10.9", "0.10.10", true],', '["0.10.9", "0.10.10", false],');
  assert.notEqual(mutant, other);
  assert.throws(() => assert.equal(table(mine), table(mutant)), undefined, "sửa một ca ở một bản thì bị bắt");
});

test("cổng bản: mức rỗng hoặc thiếu cột min_extension (Edge lên trước migration) → lease và prepare đi qua như cũ dù không gửi extVersion", async () => {
  const states = [
    ["chưa có dòng cấu hình", () => { settings.length = 0; }],
    ["dòng cấu hình chưa có cột min_extension", () => { settings.length = 0; settings.push({ singleton: true, enabled: true }); }],
    ["min_extension = {}", () => setMin({})],
  ];
  for (const [name, setup] of states) {
    setup(); rpcCalls.length = 0;
    const lease = await call({ action: "lease", kind: "group_uid", holder: HOLDER });
    assert.deepEqual([lease.status, lease.body.data?.ok], [200, true], name);
    for (const extra of [{}, { source: "auto", device: "may-test-01" }]) {
      const prepared = await call({ action: "prepare", mode: "incremental", ...extra });
      assert.equal(prepared.status, 200, `${name}: ${JSON.stringify(prepared.body)}`);
    }
    assert.deepEqual(rpcCalls.map(item => item.name), ["sync_auto_lease", "group_uid_sync_prepare", "group_uid_sync_prepare"], name);
  }
  assert.equal(requests.some(item => item.startsWith("PATCH group_uid_sync_runs")), false, "không gửi bản thì không PATCH ext_version");
});

test("cổng bản: bảng ca chung — lease group_uid và prepare (tay, tự động) trả 409 EXTENSION_OUTDATED đúng ca; bị chặn thì không gọi RPC", async () => {
  for (const [version, min, blocked] of VERSION_CASES) {
    const name = label(version, min);
    setMin({ group_uid: min }); rpcCalls.length = 0;
    const lease = await call(versioned({ action: "lease", kind: "group_uid", holder: HOLDER }, version));
    if (blocked) {
      assert.deepEqual([lease.status, lease.body.error?.code], [409, "EXTENSION_OUTDATED"], `lease ${name}`);
      assert.equal(rpcCalls.length, 0, `lease ${name}: không gọi sync_auto_lease`);
    } else assert.deepEqual([lease.status, lease.body.data?.ok, rpcCalls[0]?.name], [200, true, "sync_auto_lease"], `lease ${name}`);
    for (const extra of [{}, { source: "auto", device: "may-test-01" }]) {
      const how = `prepare ${extra.source ?? "tay"} ${name}`;
      rpcCalls.length = 0;
      const prepared = await call(versioned({ action: "prepare", mode: "incremental", ...extra }, version));
      if (blocked) {
        assert.deepEqual([prepared.status, prepared.body.error?.code], [409, "EXTENSION_OUTDATED"], how);
        assert.equal(rpcCalls.length, 0, `${how}: không gọi group_uid_sync_prepare`);
      } else assert.deepEqual([prepared.status, rpcCalls.map(item => item.name)], [200, ["group_uid_sync_prepare"]], how);
    }
  }
});

test("cổng bản: mức theo loại — group_uid chỉ chặn lease kind=group_uid và prepare; lease sku theo mức sku; ingest / preview / apply / history / detail / cancel / release / auto-config không qua cổng", async () => {
  setMin({ group_uid: "0.10.10" });
  assert.equal((await call({ action: "lease", kind: "group_uid", holder: HOLDER })).body.error?.code, "EXTENSION_OUTDATED");
  assert.equal((await call({ action: "prepare", mode: "full" })).body.error?.code, "EXTENSION_OUTDATED");
  assert.deepEqual(await call({ action: "lease", kind: "sku", holder: HOLDER }).then(result => [result.status, result.body.data?.ok]), [200, true], "mức group_uid không chặn lease sku");
  setMin({ sku: "0.10.10" });
  assert.equal((await call({ action: "lease", kind: "sku", holder: HOLDER })).body.error?.code, "EXTENSION_OUTDATED");
  assert.equal((await call({ action: "prepare", mode: "incremental" })).status, 200, "mức sku không chặn prepare Group UID");
  setMin({ sku: "0.10.10", group_uid: "0.10.10", cut_adj: "0.10.10", storage_risk: "0.10.10" });
  const invalid = await call({ action: "lease", kind: "cut_adj", holder: HOLDER });
  assert.deepEqual([invalid.status, invalid.body.error?.code], [400, "INVALID_KIND"], "group-uid-sync vẫn chỉ nhận sku / group_uid như cũ");
  holdLease();
  runs.push(makeRun({ status: "running", expected_pages: null, change_counts: null }));
  const ingest = await call({ action: "ingest", runId: RUN_A, page: 1, totalPages: 1, total: 1, rows: [{ group_uid_code: "1028260000000901", qty: 5, status: "Available", updated_date: "2026-10-26T01:00:00.000Z", products: [] }] });
  assert.equal(ingest.status, 200, `ingest: ${JSON.stringify(ingest.body)}`);
  const preview = await call({ action: "preview", runId: RUN_A, holder: HOLDER });
  assert.equal(preview.status, 200, `preview: ${JSON.stringify(preview.body)}`);
  const applied = await call({ action: "apply", runId: RUN_A, auto: true, holder: HOLDER });
  assert.deepEqual([applied.status, applied.body.data?.status], [200, "completed"], `apply: ${JSON.stringify(applied.body)}`);
  for (const body of [{ action: "history" }, { action: "detail", runId: RUN_A }, { action: "cancel", runId: RUN_A }, { action: "release", kind: "group_uid", holder: HOLDER, finished: true }, { action: "auto-config" }]) {
    const result = await call(body);
    assert.equal(result.status, 200, `${body.action}: ${JSON.stringify(result.body)}`);
  }
});

test("ghi nhận máy: lease bị chặn vẫn ghi sync_auto_devices kèm ext_version (trước cổng); gửi lại giữ first_seen_at; lỗi ghi không làm hỏng lượt", async () => {
  setMin({ group_uid: "0.10.10" });
  const blocked = await call({ action: "lease", kind: "group_uid", holder: HOLDER, extVersion: "0.10.9" });
  assert.deepEqual([blocked.status, blocked.body.error?.code], [409, "EXTENSION_OUTDATED"]);
  assert.deepEqual(devices.map(row => [row.holder, row.device, row.ext_version, row.last_kind]), [[HOLDER, "may-test-01", "0.10.9", "group_uid"]], "máy bị chặn vẫn được ghi nhận");
  const sent = posts.find(item => item.table === "sync_auto_devices");
  assert.ok(requests.includes("POST sync_auto_devices?on_conflict=holder"));
  assert.equal(sent.prefer, "resolution=merge-duplicates,return=minimal");
  assert.equal("first_seen_at" in sent.body, false, "không gửi first_seen_at (giữ lần đầu thấy)");
  assert.ok(requests.indexOf("POST sync_auto_devices?on_conflict=holder") < requests.findIndex(item => item.startsWith("GET sync_auto_settings")), "ghi nhận trước khi xét cổng");
  const firstSeen = ago(3 * DAY);
  Object.assign(devices[0], { first_seen_at: firstSeen, last_seen_at: firstSeen });
  const again = await call({ action: "lease", kind: "sku", holder: HOLDER });
  assert.deepEqual([again.status, again.body.data?.ok], [200, true]);
  assert.equal(devices.length, 1, "cùng holder → một dòng");
  assert.equal(devices[0].first_seen_at, firstSeen, "gửi lần hai không đổi first_seen_at");
  assert.ok(Date.parse(devices[0].last_seen_at) > Date.now() - MINUTE, "cập nhật last_seen_at");
  assert.deepEqual([devices[0].ext_version, devices[0].last_kind], [null, "sku"], "không khai báo bản → ghi đè null; loại gần nhất");
  // prepare có holder cũng ghi nhận trước cổng; prepare không holder (Extension ≤ 0.10.9, web) thì không ghi.
  await call({ action: "prepare", mode: "incremental", source: "auto", device: "may-test-04", holder: "may-test-04#n8m7k6", extVersion: "0.10.9" });
  assert.deepEqual(["device", "ext_version", "last_kind"].map(key => devices.find(row => row.holder === "may-test-04#n8m7k6")?.[key]), ["may-test-04", "0.10.9", "group_uid"]);
  const count = devices.length;
  await call({ action: "prepare", mode: "incremental", source: "auto", device: "may-test-01", extVersion: "0.10.10" });
  assert.equal(devices.length, count, "không holder → không ghi");
  setMin({});
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { if (String(url).includes("/rest/v1/sync_auto_devices")) throw new TypeError("fetch failed"); return inner(url, init); };
  assert.deepEqual(await call({ action: "lease", kind: "group_uid", holder: HOLDER, extVersion: "0.10.10" }).then(result => [result.status, result.body.data?.ok]), [200, true], "mạng lỗi");
  globalThis.fetch = async (url, init = {}) => String(url).includes("/rest/v1/sync_auto_devices") ? json({ code: "42P01", message: "relation does not exist" }, 404) : inner(url, init);
  assert.deepEqual(await call({ action: "lease", kind: "group_uid", holder: HOLDER }).then(result => [result.status, result.body.data?.ok]), [200, true], "bảng chưa có (Edge lên trước migration)");
});

test("ext_version của lượt Group UID: có bản → PATCH group_uid_sync_runs sau khi prepare trả runId (RPC giữ tham số); không có bản → không PATCH; PATCH lỗi → prepare vẫn thành công", async () => {
  runs.push(makeRun({ status: "running", change_counts: null }));
  const ok = await call({ action: "prepare", mode: "incremental", source: "auto", device: "may-test-01", extVersion: "0.10.10" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.runId, RUN_A);
  assert.equal(runs[0].ext_version, "0.10.10");
  assert.ok(requests.includes(`PATCH group_uid_sync_runs?id=eq.${RUN_A}`));
  assert.deepEqual(Object.keys(rpcCalls[0].body).sort(), ["p_created_by", "p_device", "p_mode", "p_range_to", "p_source"], "RPC prepare không đổi tham số");
  for (const version of [undefined, "abc", null, "0.10.9.1"]) {
    requests.length = 0;
    const result = await call(versioned({ action: "prepare", mode: "full" }, version));
    assert.equal(result.status, 200, label(version, null));
    assert.equal(requests.some(item => item.startsWith("PATCH group_uid_sync_runs")), false, label(version, null));
  }
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === "PATCH" && String(url).includes("/rest/v1/group_uid_sync_runs") ? json({ code: "PGRST204", message: "Could not find the 'ext_version' column of 'group_uid_sync_runs' in the schema cache" }, 400) : inner(url, init));
  const legacy = await call({ action: "prepare", mode: "incremental", extVersion: "0.10.10" });
  assert.deepEqual([legacy.status, legacy.body.data?.runId], [200, RUN_A], "database chưa có cột → bỏ qua, lượt vẫn chạy");
  globalThis.fetch = async (url, init = {}) => { if (init.method === "PATCH" && String(url).includes("/rest/v1/group_uid_sync_runs")) throw new TypeError("fetch failed"); return inner(url, init); };
  assert.equal((await call({ action: "prepare", mode: "incremental", extVersion: "0.10.10" })).status, 200, "mạng lỗi khi PATCH → bỏ qua");
});

test("auto-config (group-uid-sync): minExtension đủ 4 loại; devices ≤ 20, 14 ngày, mới nhất trước, không lộ holder; bảng rỗng → [], đọc lỗi → vắng khoá devices; set min_extension bị từ chối", async () => {
  const empty = await call({ action: "auto-config" });
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.data.minExtension, empty.body.data.devices], [{ sku: null, group_uid: null, cut_adj: null, storage_risk: null }, []], "bảng máy rỗng thật → devices: []");
  setMin({ group_uid: "0.10.10", sku: ["0.10.10"], storage_risk: "0.10.9" });
  for (let index = 0; index < 22; index += 1) {
    const name = `may-test-${String(index + 1).padStart(2, "0")}`;
    devices.push({ holder: `${name}#${(index + 10).toString(36)}x4y5`, device: name, ext_version: index ? "0.12.1" : "abc", first_seen_at: ago(30 * DAY), last_seen_at: ago(index * 10 * MINUTE), last_kind: index ? "group_uid" : "khac" });
  }
  devices.reverse();
  const config = await call({ action: "auto-config" });
  assert.equal(config.status, 200);
  assert.deepEqual(config.body.data.minExtension, { sku: null, group_uid: "0.10.10", cut_adj: null, storage_risk: "0.10.9" });
  const list = config.body.data.devices;
  assert.equal(list.length, 20, "tối đa 20 máy");
  assert.deepEqual(list.slice(0, 2).map(row => [row.device, row.id4, row.version, row.lastKind]), [["may-test-01", "ax4y", null, null], ["may-test-02", "bx4y", "0.12.1", "group_uid"]], "mới nhất trước; bản / loại lạ → null");
  assert.ok(list.every(row => Object.keys(row).sort().join() === "device,id4,lastKind,lastSeenAt,version"), "chỉ 5 trường, không có holder");
  assert.equal(JSON.stringify(config.body).includes("x4y5"), false, "không lộ mã máy đầy đủ");
  devices.length = 0;
  devices.push(
    { holder: "may-test-01#k7p2q9", device: "may-test-01", ext_version: "0.12.1", first_seen_at: ago(20 * DAY), last_seen_at: ago(13 * DAY), last_kind: "group_uid" },
    { holder: "may-test-02#m3n4b5", device: "may-test-02", ext_version: "0.10.9", first_seen_at: ago(20 * DAY), last_seen_at: ago(15 * DAY), last_kind: "sku" },
  );
  assert.deepEqual((await call({ action: "auto-config" })).body.data.devices.map(row => [row.device, row.id4]), [["may-test-01", "k7p2"]], "máy không thấy trong 14 ngày bị bỏ");
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => String(url).includes("/rest/v1/sync_auto_devices") ? json({ code: "42P01", message: "relation does not exist" }, 404) : inner(url, init);
  const failed = await call({ action: "auto-config" });
  assert.deepEqual([failed.status, "devices" in failed.body.data, failed.body.data.minExtension.group_uid], [200, false, "0.10.10"], "đọc bảng máy lỗi (HTTP) → vắng khoá devices, không trả [] giả");
  globalThis.fetch = async (url, init = {}) => { if (String(url).includes("/rest/v1/sync_auto_devices")) throw new TypeError("fetch failed"); return inner(url, init); };
  const offline = await call({ action: "auto-config" });
  assert.deepEqual([offline.status, "devices" in offline.body.data], [200, false], "mạng lỗi khi đọc bảng máy → vắng khoá devices");
  globalThis.fetch = inner;
  for (const set of [{ min_extension: { group_uid: "0.10.10" } }, { enabled: false, min_extension: {} }]) {
    const rejected = await call({ action: "auto-config", set });
    assert.deepEqual([rejected.status, rejected.body.error?.code], [400, "INVALID_CONFIG"], JSON.stringify(set));
  }
  assert.deepEqual([settings[0].enabled, settings[0].min_extension], [true, { group_uid: "0.10.10", sku: ["0.10.10"], storage_risk: "0.10.9" }], "cấu hình không đổi qua Edge");
});

test("cổng bản: câu báo Group UID — tự động (lease / source auto) bảo Reload Extension + tab WMS; lượt tay bảo tải lại trang trước", async () => {
  setMin({ group_uid: "0.10.10", sku: "0.10.10" });
  const cases = [
    [{ action: "lease", kind: "group_uid", holder: HOLDER, extVersion: "0.10.9" }, "Extension v0.10.9 quá cũ, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab WMS"],
    [{ action: "lease", kind: "sku", holder: HOLDER }, "Extension chưa khai báo bản, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab Inside"],
    [{ action: "prepare", mode: "incremental", source: "auto", device: "may-test-01" }, "Extension chưa khai báo bản, cần ≥ 0.10.10; hãy Reload Extension rồi tải lại tab WMS"],
    [{ action: "prepare", mode: "full", extVersion: "0.10.9" }, "Extension v0.10.9 quá cũ, cần ≥ 0.10.10; hãy tải lại trang (Ctrl+F5); nếu vẫn báo, Reload Extension rồi tải lại tab WMS"],
    [{ action: "prepare", mode: "full" }, "Extension chưa khai báo bản, cần ≥ 0.10.10; hãy tải lại trang (Ctrl+F5); nếu vẫn báo, Reload Extension rồi tải lại tab WMS"],
  ];
  for (const [body, message] of cases) {
    const result = await call(body);
    assert.deepEqual([result.status, result.body.ok, result.body.error?.code, result.body.error?.message], [409, false, "EXTENSION_OUTDATED", message], JSON.stringify(body));
  }
});
