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
let runs, settings, leases, rpcCalls, requests, posts, handler;
// holder = tên máy + "#" + mã máy (auto-sync.js holderOf); lượt tự động phải đang giữ khoá thuê còn hạn mới được ghi.
const HOLDER = "may-test-01#abc123";
function holdLease(holder = HOLDER, untilMs = 10 * 60 * 1000) { leases.length = 0; leases.push({ kind: "group_uid", holder, leased_until: new Date(Date.now() + untilMs).toISOString() }); }

function json(body, status = 200) { return new Response(JSON.stringify(body), { status }); }
function select(rows, params) {
  let result = rows.filter(row => [...params].every(([key, value]) => {
    if (["select", "order", "limit", "on_conflict"].includes(key)) return true;
    if (value.startsWith("in.(")) return value.slice(4, -1).split(",").includes(String(row[key]));
    const [op, ...rest] = value.split(".");
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
    const store = { group_uid_sync_runs: runs, sync_auto_settings: settings, sync_auto_leases: leases, group_uid_sync_changes: [], group_uid_sync_state: [{ singleton: true, last_successful_full_at: null }], group_uid_sync_pages: [], group_uid_sync_staging: [] }[table];
    if (!store) throw new Error(`fetch không được giả lập: ${url}`);
    if (method === "GET") return json(select(store, target.searchParams));
    if (method === "DELETE") return new Response(null, { status: 204 });
    if (method === "PATCH") {
      const matched = select(store, target.searchParams);
      matched.forEach(row => Object.assign(row, JSON.parse(init.body)));
      return json(matched);
    }
    if (method === "POST") { posts.push({ table, body: JSON.parse(init.body) }); return new Response(null, { status: 201 }); }
    throw new Error(`phương thức chưa giả lập: ${method}`);
  };
}

const file = path.join(TEMP, "group-uid-sync.ts");
fs.writeFileSync(file, SOURCE);
runs = []; settings = []; leases = []; rpcCalls = []; requests = []; posts = [];
install();
const { evaluateGroupUidHold } = await import(pathToFileURL(file).href);

beforeEach(() => { runs = []; settings = []; leases = []; rpcCalls = []; requests = []; posts = []; install(); });

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
