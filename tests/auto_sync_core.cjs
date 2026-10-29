// Bộ điều phối đồng bộ tự động (extension/inside-po-connector/auto-sync.js): hàm decide thuần + luồng chạy với tab/Edge giả.
//   node tests/auto_sync_core.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createAutoSync, decide, inFullWindow, vnMinutes, assessHealth, versionLess, parseMinFromMessage, webRunResponse } = require("../extension/inside-po-connector/auto-sync.js");
const { readGroupUidSnapshot } = require("../extension/inside-po-connector/group-uid-snapshot-core.js");

// 0.10.10: bản Extension giả của máy trong ca cổng bản (dữ liệu ca, không phải số phiên bản của manifest).
const OLD_EXT = "0.10.9";
const NEW_EXT = "0.10.10";
// Bảng ca so bản dùng chung với Edge: đoạn giữa hai dòng neo trong tests/sku_sync_function.mjs (chép giống hệt ở group_uid_sync_function.mjs).
function versionCaseBlock(file) {
  const text = fs.readFileSync(path.join(__dirname, file), "utf8").replace(/\r\n/g, "\n");
  const start = text.indexOf("// >>> bảng ca so bản Extension"), end = text.indexOf("// <<< bảng ca so bản Extension");
  assert.ok(start >= 0 && end > start, `${file}: thiếu bảng ca so bản Extension`);
  return text.slice(start, end);
}
function versionCases() { return new Function(`${versionCaseBlock("sku_sync_function.mjs")}\nreturn VERSION_CASES;`)(); }

const HOUR = 3600 * 1000;
const NIGHT = Date.UTC(2026, 9, 16, 18, 0); // 01:00 giờ VN ngày 17/10
const DAY = Date.UTC(2026, 9, 17, 3, 0); // 10:00 giờ VN
const CONFIG = { enabled: true, intervalMinutes: 30, fullWindow: { start: "00:00", end: "05:00" }, thresholds: {} };
const base = { config: CONFIG, last: {}, hasWms: true, hasInside: true, enabledLocal: true, signedIn: true, device: "may-test-01" };
const jobs = plan => plan.jobs.map(job => `${job.kind}:${job.mode}`);

// ---- decide ----
assert.equal(vnMinutes(NIGHT), 60);
assert.equal(vnMinutes(DAY), 600);
assert.equal(inFullWindow(NIGHT, CONFIG.fullWindow), true);
assert.equal(inFullWindow(DAY, CONFIG.fullWindow), false);
assert.equal(inFullWindow(Date.UTC(2026, 9, 16, 22, 0), CONFIG.fullWindow), false, "05:00 VN là hết khung");
assert.equal(inFullWindow(Date.UTC(2026, 9, 16, 16, 0), { start: "22:00", end: "02:00" }), true, "khung qua nửa đêm");

assert.deepEqual(decide({ ...base, now: DAY, signedIn: false }), { jobs: [], skipped: [], reason: "Chưa đăng nhập Admin trong Extension" });
assert.equal(decide({ ...base, now: DAY, device: "  " }).reason, "Chưa đặt tên máy");
assert.equal(decide({ ...base, now: DAY, enabledLocal: false }).reason, "Máy này đã tắt tự động");
assert.equal(decide({ ...base, now: DAY, config: { ...CONFIG, enabled: false } }).reason, "Admin tạm dừng");
assert.deepEqual(jobs(decide({ ...base, now: DAY, config: { ...CONFIG, enabled: false } })), []);

const noTabs = decide({ ...base, now: DAY, hasWms: false, hasInside: false });
assert.deepEqual(jobs(noTabs), []);
assert.equal(noTabs.reason, "Không có tab WMS; Không có tab Inside");
assert.ok(noTabs.skipped.every(item => item.log), "thiếu tab ghi nhật ký bỏ qua");

assert.deepEqual(jobs(decide({ ...base, now: DAY })), ["group_uid:incremental", "sku:incremental"], "ngoài khung đêm → gia tăng");
assert.deepEqual(jobs(decide({ ...base, now: DAY, hasInside: false })), ["group_uid:incremental"], "chỉ có tab WMS → chỉ Group UID");
assert.deepEqual(jobs(decide({ ...base, now: DAY, hasWms: false })), ["sku:incremental"]);

const oldFull = { group_uid: { fullAt: new Date(NIGHT - 21 * HOUR).toISOString() }, sku: { fullAt: new Date(NIGHT - 2 * HOUR).toISOString() } };
assert.deepEqual(jobs(decide({ ...base, now: NIGHT, last: oldFull })), ["group_uid:full", "sku:incremental"], "trong khung đêm: toàn bộ chỉ khi lượt toàn bộ gần nhất quá 20 giờ");
assert.deepEqual(jobs(decide({ ...base, now: NIGHT })), ["group_uid:full", "sku:full"], "chưa từng toàn bộ → toàn bộ");
assert.deepEqual(jobs(decide({ ...base, now: DAY, last: oldFull })), ["group_uid:incremental", "sku:incremental"]);
const held = { group_uid: { fullAt: null, autoFullAt: new Date(NIGHT - HOUR).toISOString(), at: new Date(NIGHT - HOUR).toISOString() } };
assert.deepEqual(jobs(decide({ ...base, now: NIGHT, last: held })), ["group_uid:incremental", "sku:full"], "lượt toàn bộ tự động (mọi máy, kể cả bị giữ) trong 20 giờ → không đọc lại toàn bộ");
const heldLocalOnly = { group_uid: { fullAt: null, fullHeldAt: new Date(NIGHT - HOUR).toISOString(), at: new Date(NIGHT - HOUR).toISOString() } };
assert.deepEqual(jobs(decide({ ...base, now: NIGHT, last: heldLocalOnly })), ["group_uid:full", "sku:full"], "fullHeldAt cục bộ chỉ để hiển thị, quyết định theo mốc server");
const oldAuto = { group_uid: { autoFullAt: new Date(NIGHT - 21 * HOUR).toISOString() } };
assert.deepEqual(jobs(decide({ ...base, now: NIGHT, last: oldAuto })), ["group_uid:full", "sku:full"], "mốc tự động quá 20 giờ thì chạy lại");
const recent = { group_uid: { at: new Date(DAY - 10 * 60000).toISOString() }, sku: { at: new Date(DAY - 29 * 60000).toISOString() } };
assert.deepEqual(jobs(decide({ ...base, now: DAY, last: recent })), ["sku:incremental"], "chưa tới nhịp thì chờ (lệch alarm 2 phút vẫn chạy)");
assert.deepEqual(jobs(decide({ ...base, now: DAY, last: { sku: { at: new Date(DAY - 40 * 60000).toISOString() } }, config: { ...CONFIG, intervalMinutes: 60 } })), ["group_uid:incremental"], "nhịp 60 phút của Admin");

// ---- luồng chạy với tab/Edge giả ----
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { data, get: async key => data[key], set: async (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); } };
}
const uid = index => ({ group_uid_code: String(1028260000000000 + index), updated_date: "2026-10-17T01:00:00.000Z", qty: 1, status: "New" });

const HOLDER = "may-test-01#abc123";
function harness({ now = DAY, wmsTab = true, insideTab = true, wmsError = null, insideError = null, edgeOverride = {}, applyHeld = null, storage: initial, onWmsPage = null, sessionOverride = {}, findWms = null, fetchOverride = null, edgeTimeoutMs, cutAdjCore, storageRiskCore, version, wmsReply = null } = {}) {
  const storage = memoryStorage({ "auto.device": "may-test-01", "auto.enabled": true, "auto.instance": "abc123", ...initial });
  const calls = [], alarms = [], timers = [], signOuts = [], badges = [], protectedTabs = [];
  const clock = { now };
  const wmsRows = Array.from({ length: 3 }, (_, index) => uid(index + 1));
  const edge = {
    "auto-config": () => CONFIG,
    lease: () => ({ ok: true, holder: "may-test-01" }),
    release: () => ({ ok: true }),
    prepare: body => ({ runId: "11111111-1111-4111-8111-111111111111", mode: body.mode, rangeFrom: body.mode === "full" ? null : "2026-10-17T02:00:00.000Z", rangeTo: "2026-10-17T03:00:00.000Z" }),
    ingest: () => ({ ok: true }),
    preview: () => ({ changeCounts: { added: 2, updated: 1 } }),
    apply: () => (applyHeld ? { status: "held", held: { reason: applyHeld } } : { status: "completed" }),
    cancel: () => ({}),
    history: () => ({ lastSnapshotAt: "2026-10-16T03:00:00.000Z", state: {} }),
    ...edgeOverride,
  };
  const fetch = async (url, init) => {
    if (fetchOverride) { const custom = await fetchOverride(url, init); if (custom) return custom; }
    if (url.includes("/rest/v1/rpc/")) {
      const name = url.split("/rest/v1/rpc/")[1];
      calls.push({ rpc: name, args: JSON.parse(init.body), auth: init.headers.Authorization });
      const handler = edge[`rpc:${name}`];
      const body = handler ? handler(JSON.parse(init.body)) : { ok: true, data: null };
      return { status: 200, ok: true, json: async () => body };
    }
    const body = JSON.parse(init.body), fn = url.split("/functions/v1/")[1];
    calls.push({ fn, ...body });
    assert.equal(init.headers.Authorization, "Bearer token-test");
    const handler = edge[body.action];
    if (!handler) throw new Error(`Edge chưa giả lập: ${body.action}`);
    const result = handler(body);
    if (result && result.__error) return { status: result.status || 409, ok: false, json: async () => ({ ok: false, error: result.__error }) };
    return { status: 200, ok: true, json: async () => ({ ok: true, data: result }) };
  };
  const sync = createAutoSync({
    storage, fetch, now: () => clock.now, config: { url: "https://example.invalid", key: "test-key" }, edgeTimeoutMs, cutAdjCore, storageRiskCore, version,
    badge: problems => badges.push(problems), protectTab: async tab => { protectedTabs.push(tab.id); },
    session: { getAccessToken: async () => "token-test", getSession: async () => ({ user: { email: "admin-test@example.com" } }), signOut: async () => { signOuts.push(1); }, signIn: async () => ({}), ...sessionOverride },
    snapshotCore: { readGroupUidSnapshot },
    alarms: { create: async (name, info) => alarms.push(["create", name, info?.periodInMinutes]), clear: async name => alarms.push(["clear", name]), get: async name => ({ scheduledTime: now + 30 * 60000, periodInMinutes: name === "auto-sync" ? 30 : 0.5 }) },
    timers: { set: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; }, clear: id => { timers[id - 1].cleared = true; } },
    findWmsTab: async () => (findWms ? findWms() : wmsTab ? { id: 1 } : null),
    findInsideTab: async () => (insideTab ? { id: 2 } : null),
    sendToWms: async (tab, message) => {
      calls.push({ tab: "wms", tabId: tab.id, ...message });
      if (onWmsPage) await onWmsPage(message, h);
      if (wmsError) return { ok: false, error: wmsError };
      const custom = wmsReply ? wmsReply(message) : null; // dữ liệu trang riêng cho một ca; null = dữ liệu mặc định
      if (custom) return { ok: true, data: custom };
      const page = message.payload.page, size = message.payload.size;
      return { ok: true, data: { page, size, total: wmsRows.length, totalPages: Math.max(1, Math.ceil(wmsRows.length / size)), rows: wmsRows.slice((page - 1) * size, page * size) } };
    },
    sendToInside: async (tab, message) => {
      calls.push({ tab: "inside", ...message });
      if (insideError) return { ok: false, error: insideError };
      return { ok: true, data: { generatedAt: "2026-10-17T03:00:00.000Z", normalRows: [{ sku: "900000001" }], comboRows: [], categories: [] } };
    },
  });
  const h = { sync, storage, calls, alarms, timers, signOuts, clock, badges, protectedTabs };
  return h;
}
const actions = (calls, fn) => calls.filter(call => call.fn === fn).map(call => call.action);

(async () => {
  // Gia tăng cả hai loại: Group UID đọc trang thử rồi lease → prepare(auto) → đọc → ingest → preview → apply(auto) → release.
  {
    const h = harness();
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.mode}:${item.status}`), ["group_uid:incremental:ok", "sku:incremental:ok"]);
    assert.deepEqual(actions(h.calls, "group-uid-sync"), ["lease", "prepare", "lease", "ingest", "preview", "apply", "release"]);
    const prepare = h.calls.find(call => call.action === "prepare");
    assert.deepEqual([prepare.source, prepare.device, prepare.mode], ["auto", "may-test-01", "incremental"]);
    const guApply = h.calls.find(call => call.fn === "group-uid-sync" && call.action === "apply");
    assert.deepEqual([guApply.auto, guApply.holder], [true, HOLDER], "apply gửi holder để Edge kiểm khoá thuê");
    assert.equal(h.calls.find(call => call.action === "ingest").rows.length, 3);
    assert.deepEqual(actions(h.calls, "sku-sync"), ["auto-config", "lease", "history", "lease", "preview", "apply", "release"]);
    const skuRead = h.calls.find(call => call.tab === "inside");
    assert.deepEqual(skuRead.payload, { cutoff: "2026-10-15T03:00:00.000Z" }, "mốc = lastSnapshotAt lùi 1 ngày");
    const skuPreview = h.calls.find(call => call.fn === "sku-sync" && call.action === "preview");
    assert.deepEqual([skuPreview.source, skuPreview.device, skuPreview.mode, skuPreview.holder], ["auto", "may-test-01", "incremental", HOLDER]);
    assert.equal(h.calls.find(call => call.fn === "sku-sync" && call.action === "apply").holder, HOLDER);
    assert.deepEqual(h.timers.map(item => [item.ms, item.cleared]), [[300000, true], [300000, true]], "gia hạn khoá mỗi 5 phút trong lượt, dừng khi xong");
    assert.equal(h.alarms.some(item => item[1] === "auto-sync"), false, "nhịp không đổi thì không tạo lại alarm");
    assert.equal(h.storage.data["auto.last"].group_uid.status, "ok");
    assert.match(h.storage.data["auto.last"].group_uid.message, /Đã cập nhật 3 UID/);
    assert.equal(h.storage.data["auto.log"].length, 2);
    assert.equal(h.storage.data["auto.log"][0].kind, "sku", "nhật ký mới nhất ở đầu");
    assert.deepEqual(h.alarms.filter(item => item[1] === "auto-keepalive").map(item => item[0]), ["create", "clear", "create", "clear"]);
    // Giãn cách giữa các máy: thuê khoá lần đầu gửi nhịp − 2 phút; gia hạn trong lượt không gửi; xong lượt nhả khoá kèm finished.
    for (const fn of ["group-uid-sync", "sku-sync"]) {
      const leases = h.calls.filter(call => call.fn === fn && call.action === "lease");
      assert.deepEqual(leases.map(call => call.cooldownSeconds), [30 * 60 - 600, undefined], fn);
      assert.equal(h.calls.find(call => call.fn === fn && call.action === "release").finished, true, fn);
    }
    assert.equal(h.calls.find(call => call.fn === "group-uid-sync" && call.action === "preview").holder, HOLDER, "preview Group UID gửi holder để Edge kiểm khoá");
    assert.equal(h.storage.data["auto.interval"], 30, "lưu nhịp đã xác minh cho background.js");
  }

  // Máy khác vừa đồng bộ cùng loại trong chu kỳ (COOLDOWN): bỏ qua lặng lẽ, không tạo lượt, không nhả khoá.
  {
    const h = harness({ insideTab: false, edgeOverride: { lease: () => ({ ok: false, reason: "COOLDOWN", lastFinishedAt: "2026-10-17T02:50:00.000Z", retryAfter: "2026-10-17T03:18:00.000Z" }) } });
    const result = await h.sync.tick();
    assert.deepEqual([result.results[0].status, result.results[0].message], ["skipped", "Máy khác vừa đồng bộ lúc 09:50"]);
    assert.deepEqual(actions(h.calls, "group-uid-sync"), ["lease"]);
    assert.deepEqual([h.storage.data["auto.log"][0].status, h.storage.data["auto.log"][0].message], ["skipped", "Máy khác vừa đồng bộ lúc 09:50"]);
    assert.equal(h.storage.data["auto.last"]?.group_uid, undefined, "bỏ qua không tính là đã chạy");
  }

  // Vượt ngưỡng: Edge giữ lại → status held + lý do; toàn bộ bị giữ thì ghi fullHeldAt.
  {
    const h = harness({ now: NIGHT, insideTab: false, applyHeld: "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000" });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.mode}:${item.status}`), ["group_uid:full:held"]);
    assert.equal(h.storage.data["auto.last"].group_uid.fullHeldAt, new Date(NIGHT).toISOString());
    assert.equal(h.storage.data["auto.last"].group_uid.autoFullAt, new Date(NIGHT).toISOString(), "bản sao cục bộ của mốc server");
    assert.equal(h.storage.data["auto.last"].group_uid.fullAt, null, "mốc toàn bộ lấy từ Edge history (chưa có)");
    assert.equal(h.calls.find(call => call.action === "release").finished, true, "lượt bị giữ lại cũng ghi mốc giãn cách");
    assert.equal(h.storage.data["auto.log"][0].message, "Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000");
    assert.equal(h.storage.data["auto.log"][1].message, "Không có tab Inside");
  }

  // Máy khác đã chạy toàn bộ tự động (kể cả bị giữ) trong đêm: history lastAutoFullAt chặn đọc lại toàn bộ.
  {
    const h = harness({ now: NIGHT, insideTab: false, edgeOverride: { history: () => ({ state: { last_successful_full_at: null }, lastAutoFullAt: new Date(NIGHT - 2 * HOUR).toISOString() }) } });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.mode}`), ["group_uid:incremental"]);
    const stale = harness({ now: NIGHT, insideTab: false, storage: { "auto.last": { group_uid: { autoFullAt: new Date(NIGHT - HOUR).toISOString() } } }, edgeOverride: { history: () => ({ state: {}, lastAutoFullAt: null }) } });
    const r2 = await stale.sync.tick();
    assert.deepEqual(r2.results.map(item => `${item.kind}:${item.mode}`), ["group_uid:full"], "server là nguồn đúng: không có lượt toàn bộ tự động thì chạy");
  }

  // Mất khoá thuê giữa lượt Group UID: gia hạn sau khi đọc WMS trả ok:false → hủy lượt "Mất khoá thuê", không ingest/preview/apply.
  {
    let leaseCalls = 0;
    const h = harness({ insideTab: false, edgeOverride: { lease: () => (++leaseCalls === 1 ? { ok: true } : { ok: false, holder: "may-test-02#zzz999" }) } });
    const result = await h.sync.tick();
    assert.deepEqual([result.results[0].status, result.results[0].message], ["error", "Mất khoá thuê: Máy may-test-02 đang chạy"]);
    assert.deepEqual(actions(h.calls, "group-uid-sync"), ["lease", "prepare", "lease", "cancel", "release"]);
    assert.equal(h.calls.find(call => call.action === "cancel").message, "Mất khoá thuê");
    assert.equal(h.storage.data["auto.log"][0].status, "error");
  }

  // Alarm keepalive trong lúc đọc WMS: gia hạn khoá (cách nhau ≥ 2 phút); máy khác đã giành khoá → dừng ở trang kế tiếp.
  {
    let leaseCalls = 0;
    const many = [];
    const h = harness({
      insideTab: false,
      edgeOverride: { lease: () => (++leaseCalls <= 2 ? { ok: true } : { ok: false, holder: "may-test-02#zzz999" }) },
      onWmsPage: async (message, self) => {
        if (message.payload.size !== 500) return;
        assert.equal(await self.sync.onKeepAlive(), true, "chưa tới 2 phút: không gọi Edge");
        for (let round = 0; round < 2; round += 1) {
          self.clock.now += 3 * 60000;
          many.push(await self.sync.onKeepAlive());
        }
      },
    });
    const result = await h.sync.tick();
    assert.equal(result.results[0].status, "error");
    assert.match(result.results[0].message, /^Mất khoá thuê/);
    assert.deepEqual(many, [true, false], "lần 1 gia hạn được, lần 2 máy khác đã giữ");
    assert.equal(leaseCalls, 3);
    assert.deepEqual(actions(h.calls, "group-uid-sync").filter(action => ["ingest", "preview", "apply"].includes(action)), []);
    assert.equal(h.calls.find(call => call.action === "cancel").message, "Mất khoá thuê");
    assert.equal(await h.sync.onKeepAlive(), true, "hết lượt thì keepalive không làm gì");
  }

  // Edge chặn apply vì mất khoá (hàng rào phía server): hủy lượt dù đã xem trước.
  {
    const h = harness({ insideTab: false, edgeOverride: { apply: () => ({ __error: { code: "LEASE_LOST", message: "Mất khoá thuê; lượt tự động đã dừng" } }) } });
    const result = await h.sync.tick();
    assert.deepEqual([result.results[0].status, result.results[0].message], ["error", "Mất khoá thuê; lượt tự động đã dừng"]);
    assert.deepEqual(actions(h.calls, "group-uid-sync").slice(-3), ["apply", "cancel", "release"]);
    assert.equal(h.calls.find(call => call.action === "cancel").message, "Mất khoá thuê");
  }

  // SKU: đọc Inside xong mà máy khác đã giành khoá → không preview, không apply.
  {
    let leaseCalls = 0;
    const h = harness({ wmsTab: false, edgeOverride: { lease: () => (++leaseCalls === 1 ? { ok: true } : { ok: false, holder: "may-test-02#zzz999" }) } });
    const result = await h.sync.tick();
    assert.deepEqual([result.results[0].status, result.results[0].message], ["error", "Mất khoá thuê: Máy may-test-02 đang chạy"]);
    assert.deepEqual(actions(h.calls, "sku-sync"), ["auto-config", "lease", "history", "lease", "release"]);
  }

  // Nhịp Admin đổi (60 phút) → tạo lại alarm "auto-sync"; dưới 15 phút thì kẹp 15.
  {
    const h = harness({ wmsTab: false, insideTab: false, edgeOverride: { "auto-config": () => ({ ...CONFIG, intervalMinutes: 60 }) } });
    await h.sync.tick();
    assert.deepEqual(h.alarms.filter(item => item[1] === "auto-sync"), [["create", "auto-sync", 60]]);
    assert.equal(h.storage.data["auto.interval"], 60);
    const hourly = harness({ insideTab: false, edgeOverride: { "auto-config": () => ({ ...CONFIG, intervalMinutes: 60 }) } });
    await hourly.sync.tick();
    assert.equal(hourly.calls.find(call => call.action === "lease").cooldownSeconds, 60 * 60 - 600, "giãn cách theo nhịp Admin");
    const low = harness({ wmsTab: false, insideTab: false, edgeOverride: { "auto-config": () => ({ ...CONFIG, intervalMinutes: 5 }) } });
    await low.sync.tick();
    assert.deepEqual(low.alarms.filter(item => item[1] === "auto-sync"), [["create", "auto-sync", 15]]);
  }

  // Đăng nhập Options: chỉ ok khi auto-config xác minh được Admin; lỗi mạng/5xx hoặc không phải Admin → xoá phiên vừa tạo.
  {
    const ok = harness();
    assert.deepEqual(await ok.sync.handleMessage({ type: "AUTO_SIGN_IN", email: "admin-test@example.com", password: "x" }), { ok: true });
    assert.equal(ok.signOuts.length, 0);
    const down = harness({ edgeOverride: { "auto-config": () => ({ __error: { code: "SYNC_ERROR", message: "Edge lỗi" }, status: 503 }) } });
    assert.deepEqual(await down.sync.handleMessage({ type: "AUTO_SIGN_IN", email: "admin-test@example.com", password: "x" }), { ok: false, error: "Không kiểm được vai trò Admin, thử lại" });
    assert.equal(down.signOuts.length, 1);
    const net = harness({ edgeOverride: { "auto-config": () => { throw new TypeError("Failed to fetch"); } } });
    assert.deepEqual(await net.sync.handleMessage({ type: "AUTO_SIGN_IN", email: "admin-test@example.com", password: "x" }), { ok: false, error: "Không kiểm được vai trò Admin, thử lại" });
    assert.equal(net.signOuts.length, 1);
    const user = harness({ edgeOverride: { "auto-config": () => ({ __error: { code: "FORBIDDEN", message: "Chỉ Admin" }, status: 403 }) } });
    assert.deepEqual(await user.sync.handleMessage({ type: "AUTO_SIGN_IN", email: "admin-test@example.com", password: "x" }), { ok: false, error: "Tài khoản không phải Admin" });
    assert.equal(user.signOuts.length, 1);
  }

  // Không có tab nào: bỏ qua lặng lẽ, không gọi lease/prepare; lặp lại không làm đầy nhật ký.
  {
    const h = harness({ wmsTab: false, insideTab: false });
    await h.sync.tick();
    await h.sync.tick();
    assert.deepEqual(h.calls.map(call => call.action), ["auto-config", "auto-config"]);
    assert.deepEqual(h.storage.data["auto.log"].map(item => [item.status, item.message, item.repeat || 1]), [["skipped", "Không có tab Inside", 2], ["skipped", "Không có tab WMS", 2]]);
  }

  // Tab WMS đăng xuất / Inside hết phiên: bỏ qua, không tạo lượt.
  {
    const h = harness({ wmsError: { code: "GROUP_UID_READ_FAILED", message: "Phiên WMS đã hết hạn; hãy đăng nhập lại", reason: "session" }, insideError: { code: "SKU_SYNC_READ_FAILED", message: "Phiên Inside đã hết hạn; hãy đăng nhập lại", reason: "session" } });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.status}`), ["group_uid:skipped", "sku:skipped"]);
    assert.deepEqual(actions(h.calls, "group-uid-sync"), [], "không lease, không prepare khi WMS đăng xuất");
    assert.ok(!actions(h.calls, "sku-sync").includes("preview"));
    assert.equal(h.storage.data["auto.last"], undefined, "bỏ qua không tính là đã chạy");
  }

  // 0.12.3 (27/10/2026): trang thử Group UID (không lọc ngày) báo tổng 0 = WMS không thấy UID nào cho tài khoản (vd. mất quyền kho; từ 0.12.4 đọc không gửi company-ids; từ 0.12.2 thân
  // {page, size} của group-uid-infos là 0 dòng) → bỏ qua TRƯỚC khi thuê khoá / tạo lượt, mọi mode; mốc không tiến. Tổng > 0 hoặc thiếu tổng → như cũ.
  {
    const probeOnly = data => message => (message.type === "GET_GROUP_UID_PAGE" && message.payload.size === 1 ? data : null);
    const none = probeOnly({ page: 1, size: 1, total: 0, totalPages: 1, rows: [] });
    const h = harness({ insideTab: false, wmsReply: none });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.mode}:${item.status}`), ["group_uid:incremental:skipped"]);
    assert.match(result.results[0].message, /không thấy UID/);
    assert.deepEqual(actions(h.calls, "group-uid-sync"), [], "không lease / prepare / ingest / release khi WMS không thấy UID");
    assert.deepEqual(h.calls.filter(call => call.tab === "wms").map(call => call.payload), [{ page: 1, size: 1 }], "chỉ gọi trang thử");
    assert.equal(h.storage.data["auto.last"]?.group_uid, undefined, "bỏ qua không tiến mốc");
    assert.deepEqual([h.storage.data["auto.log"][0].kind, h.storage.data["auto.log"][0].status], ["group_uid", "skipped"]);
    assert.match(h.storage.data["auto.log"][0].message, /không thấy UID/);
    assert.match(h.storage.data["auto.health"].kinds.group_uid.reason, /không thấy UID/, "lý do hiện ở Tùy chọn / cảnh báo ngừng");
    // Đối chiếu toàn bộ (Chạy ngay) cũng bỏ qua
    const full = harness({ insideTab: false, wmsReply: none });
    const run = await full.sync.runNow("group_uid", "full");
    assert.deepEqual([run.result.status, actions(full.calls, "group-uid-sync")], ["skipped", []]);
    assert.match(run.result.message, /không thấy UID/);
    // Tổng > 0: chạy như cũ
    const some = harness({ insideTab: false, wmsReply: probeOnly({ page: 1, size: 1, total: 1, totalPages: 1, rows: [uid(1)] }) });
    assert.deepEqual((await some.sync.tick()).results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok"]);
    assert.deepEqual(actions(some.calls, "group-uid-sync"), ["lease", "prepare", "lease", "ingest", "preview", "apply", "release"]);
    // Thiếu tổng (không phải số 0): không đoán, chạy như cũ
    const noTotal = harness({ insideTab: false, wmsReply: probeOnly({ page: 1, size: 1, rows: [] }) });
    assert.deepEqual((await noTotal.sync.tick()).results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok"]);
    assert.ok(actions(noTotal.calls, "group-uid-sync").includes("prepare"));
  }

  // Máy khác giữ khoá; Admin đang xem trước (ACTIVE_RUN); lỗi giữa chừng thì hủy lượt và nhả khoá.
  {
    const busy = harness({ insideTab: false, edgeOverride: { lease: () => ({ ok: false, holder: "may-test-02" }) } });
    const r1 = await busy.sync.tick();
    assert.deepEqual([r1.results[0].status, r1.results[0].message], ["skipped", "Máy may-test-02 đang chạy"]);
    const active = harness({ insideTab: false, edgeOverride: { prepare: () => ({ __error: { code: "ACTIVE_RUN", message: "Đang có một lượt" } }) } });
    const r2 = await active.sync.tick();
    assert.deepEqual([r2.results[0].status, r2.results[0].message], ["skipped", "Đang có lượt khác (Admin đang xem trước)"]);
    assert.equal(actions(active.calls, "group-uid-sync").at(-1), "release");
    const broken = harness({ insideTab: false, edgeOverride: { ingest: () => ({ __error: { code: "PAGE_COUNT_CHANGED", message: "Tổng số trang WMS thay đổi" } }) } });
    const r3 = await broken.sync.tick();
    assert.deepEqual([r3.results[0].status, r3.results[0].message], ["error", "Tổng số trang WMS thay đổi"]);
    assert.deepEqual(actions(broken.calls, "group-uid-sync").slice(-2), ["cancel", "release"]);
    assert.match(broken.calls.find(call => call.action === "cancel").message, /^Tự động: /);
    assert.equal(broken.calls.find(call => call.action === "release").finished, undefined, "lỗi thì không ghi mốc giãn cách");
    assert.equal(active.calls.find(call => call.action === "release").finished, undefined, "bỏ qua (ACTIVE_RUN) thì không ghi mốc");
  }

  // Chưa đăng nhập / chưa đặt tên máy: không gọi Edge; Admin tạm dừng: ghi nhật ký bỏ qua.
  {
    const h = harness({ storage: { "auto.device": "" } });
    assert.equal((await h.sync.tick()).reason, "Chưa đặt tên máy");
    assert.equal(h.calls.length, 0);
    const paused = harness({ edgeOverride: { "auto-config": () => ({ ...CONFIG, enabled: false }) } });
    await paused.sync.tick();
    assert.deepEqual(actions(paused.calls, "sku-sync"), ["auto-config"]);
    assert.equal(paused.storage.data["auto.log"][0].message, "Admin tạm dừng");
  }

  // Lệnh từ trang Tùy chọn.
  {
    const h = harness();
    const status = await h.sync.handleMessage({ type: "AUTO_STATUS" });
    assert.deepEqual([status.ok, status.signedIn, status.email, status.device, status.enabled, status.running], [true, true, "admin-test@example.com", "may-test-01", true, null]);
    assert.deepEqual(status.tabs, { wms: true, inside: true });
    assert.equal(status.config.enabled, true);
    assert.equal(status.nextAlarmAt, DAY + 30 * 60000);
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_SET_DEVICE", device: "   " }), { ok: false, error: "Nhập tên máy" });
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_SET_ENABLED", enabled: "true" }), { ok: false, error: "Giá trị bật/tắt không hợp lệ" });
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_SET_ENABLED", enabled: false }), { ok: true });
    assert.equal(h.storage.data["auto.enabled"], false);
    assert.equal((await h.sync.tick()).reason, "Máy này đã tắt tự động");
    const run = await h.sync.handleMessage({ type: "AUTO_RUN_NOW", kind: "sku", mode: "full" });
    assert.equal(run.ok, true, "chạy ngay bỏ qua lịch và công tắc máy");
    assert.deepEqual(h.calls.find(call => call.tab === "inside").payload, { full: true });
    assert.equal(h.calls.find(call => call.action === "lease").cooldownSeconds, undefined, "chạy ngay không xét giãn cách");
    assert.equal(h.calls.find(call => call.action === "release").finished, true);
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_RUN_NOW", kind: "khac", mode: "full" }), { ok: false, error: "Yêu cầu chạy không hợp lệ" });
  }

  // ---- 0.10.7 (soát Extension 22/10/2026) ----
  // G6: lỗi mạng WMS / mất quyền 403 là LỖI (trước đây câu chữ "tab WMS" / "Phiên WMS" bị tính là bỏ qua).
  {
    const net = harness({ insideTab: false, wmsError: { code: "GROUP_UID_READ_FAILED", message: "WMS tạm ngắt kết nối; hãy tải lại tab WMS rồi thử lại", reason: "network" } });
    assert.equal((await net.sync.tick()).results[0].status, "error");
    const denied = harness({ insideTab: false, wmsError: { code: "GROUP_UID_READ_FAILED", message: "Phiên WMS không còn quyền đọc Group UID; hãy đăng nhập lại", reason: "denied" } });
    assert.equal((await denied.sync.tick()).results[0].status, "error");
    const noReason = harness({ insideTab: false, wmsError: { code: "GROUP_UID_READ_FAILED", message: "Phiên WMS đã hết hạn" } });
    assert.equal((await noReason.sync.tick()).results[0].status, "error", "không có reason thì không đoán theo câu chữ");
  }

  // G4: một lượt dùng đúng một tab WMS (lượt đọc mở thêm tab không đổi tab giữa chừng) + giữ tab không bị Chrome cho ngủ.
  {
    let next = 0;
    const h = harness({ insideTab: false, findWms: () => ({ id: 10 + (next++) }) });
    const result = await h.sync.tick();
    assert.equal(result.results[0].status, "ok");
    const ids = [...new Set(h.calls.filter(call => call.tab === "wms").map(call => call.tabId))];
    assert.equal(ids.length, 1, `mọi trang của lượt gửi cùng một tab: ${ids}`);
    assert.deepEqual(h.protectedTabs, ids);
    await h.sync.runNow("group_uid", "incremental");
    const second = [...new Set(h.calls.filter(call => call.tab === "wms").map(call => call.tabId))];
    assert.equal(second.length, 2, "lượt sau chọn lại tab");
  }

  // G5: Chạy ngay và alarm cùng lúc → chỉ một lượt chạy.
  {
    const h = harness({ wmsTab: false });
    const [now1, tick1] = await Promise.all([h.sync.runNow("sku", "incremental"), h.sync.tick()]);
    assert.equal(now1.ok, true);
    assert.deepEqual(tick1, { ok: false, reason: "Đang chạy" });
    assert.equal(h.calls.filter(call => call.fn === "sku-sync" && call.action === "preview").length, 1);
    const [tick2, now2] = await Promise.all([h.sync.tick(), h.sync.runNow("sku", "incremental")]);
    assert.deepEqual(now2, { ok: false, error: "Đang có lượt tự động chạy" });
    assert.equal(tick2.ok, true);
    assert.equal(h.sync.isRunning(), false, "xong thì nhả chỗ");
    const failed = harness({ wmsTab: false, edgeOverride: { preview: () => ({ __error: { code: "SYNC_ERROR", message: "Edge lỗi" } }) } });
    const run = await failed.sync.runNow("sku", "incremental");
    assert.deepEqual([run.ok, run.error], [false, "Edge lỗi"], "Chạy ngay lỗi trả câu lỗi cho trang Tùy chọn");
  }

  // G2: dấu lượt đang chạy trong storage; worker khởi động lại → hủy lượt dở, nhả khoá, tắt keepalive, ghi nhật ký.
  {
    let seen = null;
    const h = harness({ insideTab: false, onWmsPage: async (message, self) => { if (message.payload.size === 500) seen = await self.storage.get("auto.active"); } });
    await h.sync.tick();
    assert.deepEqual([seen.kind, seen.mode, seen.holder, seen.runId], ["group_uid", "incremental", HOLDER, "11111111-1111-4111-8111-111111111111"]);
    assert.equal(h.storage.data["auto.active"], null, "xong lượt thì xoá dấu");
    const crashed = harness({ storage: { "auto.active": { kind: "group_uid", mode: "full", holder: HOLDER, runId: "22222222-2222-4222-8222-222222222222", startedAt: "2026-10-17T02:00:00.000Z" } } });
    const pendingTick = crashed.sync.recover().then(() => crashed.sync.tick());
    await pendingTick;
    const first = crashed.calls.filter(call => call.fn === "group-uid-sync").slice(0, 2);
    assert.deepEqual(first.map(call => [call.action, call.runId || call.holder]), [["cancel", "22222222-2222-4222-8222-222222222222"], ["release", HOLDER]], "dọn trước khi lượt mới chạy");
    assert.ok(crashed.alarms.some(item => item[0] === "clear" && item[1] === "auto-keepalive"));
    assert.ok(crashed.storage.data["auto.log"].some(item => item.status === "error" && /Lượt bị gián đoạn/.test(item.message)));
    const clean = harness();
    assert.equal(await clean.sync.recover(), null, "không có dấu thì không gọi Edge");
    assert.equal(clean.calls.length, 0);
  }

  // Edge treo → hết giờ, lượt kết thúc là lỗi (không giữ "đang chạy" mãi).
  {
    const h = harness({ wmsTab: false, edgeTimeoutMs: 20, fetchOverride: async (url, init) => (JSON.parse(init.body).action === "preview" ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))) : null) });
    const result = await h.sync.tick();
    assert.deepEqual([result.results[0].status, result.results[0].message], ["error", "Supabase phản hồi quá lâu (preview)"]);
    assert.equal(h.sync.isRunning(), false);
  }

  // Cảnh báo ngừng: chưa đăng nhập / chưa tên máy → "!" ngay; thiếu tab quá 2 nhịp + 10 phút → "!" kèm lý do; máy khác đang lo → không.
  {
    assert.deepEqual(assessHealth({ signedIn: false }), ["Chưa đăng nhập Admin trong Extension"]);
    const out = harness({ sessionOverride: { getSession: async () => null } });
    await out.sync.tick();
    assert.deepEqual(out.badges.at(-1), ["Chưa đăng nhập Admin trong Extension"]);
    assert.equal(out.storage.data["auto.log"][0].message, "Chưa đăng nhập Admin trong Extension", "lý do dừng có trong nhật ký");
    const h = harness({ wmsTab: false, insideTab: false });
    await h.sync.tick();
    assert.deepEqual(h.badges.at(-1), [], "chưa quá ngưỡng");
    h.clock.now += 71 * 60000;
    await h.sync.tick();
    assert.deepEqual(h.badges.at(-1), ["Group UID ngừng 1,2 giờ: Không có tab WMS", "SKU ngừng 1,2 giờ: Không có tab Inside"]);
    const status = await h.sync.handleMessage({ type: "AUTO_STATUS" });
    assert.equal(status.problems.length, 2, "trang Tùy chọn nhận danh sách lý do");
    const covered = harness({ insideTab: false, edgeOverride: { lease: () => ({ ok: false, reason: "COOLDOWN", lastFinishedAt: "2026-10-17T02:50:00.000Z" }) } });
    for (let round = 0; round < 4; round += 1) { await covered.sync.tick(); covered.clock.now += 30 * 60000; }
    assert.ok(!covered.badges.at(-1).some(item => item.startsWith("Group UID")), "máy khác vừa đồng bộ = vẫn sống");
    const paused = harness({ wmsTab: false, insideTab: false, edgeOverride: { "auto-config": () => ({ ...CONFIG, enabled: false }) } });
    await paused.sync.tick(); paused.clock.now += 3 * HOUR; await paused.sync.tick();
    assert.deepEqual(paused.badges.at(-1), [], "Admin tạm dừng là chủ ý, không cảnh báo");
    const ok = harness();
    await ok.sync.tick(); ok.clock.now += 50 * 60000; await ok.sync.tick();
    assert.deepEqual(ok.badges.at(-1), []);
  }

  // ---- 0.10.7: hai loại mới (Đối chiếu ADJ mỗi nhịp, Rủi ro lưu trữ mỗi 2 giờ 07:00–19:30) ----
  {
    const ALL = ["group_uid", "sku", "cut_adj", "storage_risk"];
    assert.deepEqual(jobs(decide({ ...base, now: DAY, kinds: ALL })), ["group_uid:incremental", "sku:incremental", "cut_adj:incremental", "storage_risk:incremental"]);
    assert.deepEqual(jobs(decide({ ...base, now: NIGHT, kinds: ALL })), ["group_uid:full", "sku:full", "cut_adj:incremental"], "đêm: Rủi ro lưu trữ không chạy");
    assert.equal(decide({ ...base, now: NIGHT, kinds: ALL, hasWms: false }).skipped.some(item => item.kind === "storage_risk"), false, "ngoài khung: không ghi bỏ qua");
    const ran = kind => ({ [kind]: { at: new Date(DAY - 61 * 60000).toISOString() } });
    assert.deepEqual(jobs(decide({ ...base, now: DAY, kinds: ["storage_risk"], last: ran("storage_risk") })), [], "Rủi ro lưu trữ: chưa đủ 2 giờ");
    assert.deepEqual(jobs(decide({ ...base, now: DAY, kinds: ["storage_risk"], last: { storage_risk: { at: new Date(DAY - 119 * 60000).toISOString() } } })), ["storage_risk:incremental"], "lệch alarm 2 phút vẫn chạy");
    assert.deepEqual(jobs(decide({ ...base, now: DAY, kinds: ["cut_adj"], last: ran("cut_adj") })), ["cut_adj:incremental"], "Đối chiếu ADJ theo nhịp 30 phút");
    assert.equal(decide({ ...base, now: DAY, kinds: ALL, hasWms: false, hasInside: false }).reason, "Không có tab WMS; Không có tab Inside", "lý do không lặp");
    // Cảnh báo Rủi ro lưu trữ chỉ đếm phút trong khung (đêm không tính).
    const at = (d, h) => Date.UTC(2026, 9, d, h - 7);
    const sr = (now, alive) => assessHealth({ now, signedIn: true, device: "may", kinds: ["storage_risk"], intervalMinutes: 30, health: { since: new Date(alive).toISOString(), kinds: { storage_risk: { aliveAt: new Date(alive).toISOString() } } } });
    assert.deepEqual(sr(at(22, 8), at(21, 19)), [], "19:00 hôm qua → 08:00: chưa ngừng");
    assert.equal(sr(at(22, 12), at(22, 7)).length, 1, "07:00 → 12:00 không có lượt: ngừng");
  }

  // Lõi chưa nạp → không có loại mới (Extension cũ / test cũ); có lõi → chạy sau Group UID/SKU, khoá thuê qua sku-sync, ghi bằng RPC Admin.
  {
    const order = [];
    const cutAdjCore = { run: async ({ sendTab, rpc, device }) => {
      order.push("cut_adj");
      const coverage = await rpc("wms_cut_coverage", {});
      await sendTab("GET_GROUP_UID_HISTORY_PAGE", { page: 1, size: 500, from: coverage.until });
      await rpc("wms_group_uid_cut_import", { p_file_name: `WMS_AUTO_${device}.json`, p_rows: [] });
      return { total: 1234, cutRows: 12, newRows: 10, changedRows: 2 };
    } };
    const storageRiskCore = { run: async ({ sendTab }) => { order.push("storage_risk"); await sendTab("GET_SKU_COUNT_WAREHOUSES", {}); return { ok: true, skuCount: { rows: 641 }, uidTemp: { rows: 5 } }; } };
    const h = harness({ insideTab: false, cutAdjCore, storageRiskCore, edgeOverride: { "rpc:wms_cut_coverage": () => ({ ok: true, data: { until: "2026-10-17T02:30:00.000Z" } }), "rpc:wms_group_uid_cut_import": () => ({ ok: true, data: { cutRows: 12 } }) } });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok", "cut_adj:ok", "storage_risk:ok"]);
    assert.deepEqual(result.results.slice(1).map(item => item.message), ["Nạp 12 dòng Cut: 10 mới, 2 đổi · 1.234 dòng lịch sử đã đọc", "Kiểm kê 641 SKU · UID tạm 5 dòng"]);
    const leases = h.calls.filter(call => call.fn === "sku-sync" && call.action === "lease" && call.cooldownSeconds);
    assert.deepEqual(leases.map(call => [call.kind, call.cooldownSeconds]), [["cut_adj", 30 * 60 - 600], ["storage_risk", 110 * 60]]);
    assert.deepEqual(h.calls.filter(call => call.fn === "sku-sync" && call.action === "release").map(call => [call.kind, call.finished]), [["cut_adj", true], ["storage_risk", true]]);
    assert.deepEqual(h.calls.filter(call => call.rpc).map(call => [call.rpc, call.auth]), [["wms_cut_coverage", "Bearer token-test"], ["wms_group_uid_cut_import", "Bearer token-test"]]);
    assert.equal(h.calls.find(call => call.tab === "wms" && call.type === "GET_GROUP_UID_HISTORY_PAGE").payload.from, "2026-10-17T02:30:00.000Z", "RPC trả {ok,data} → lõi nhận data");
    const status = await h.sync.handleMessage({ type: "AUTO_STATUS" });
    assert.deepEqual(status.kinds, ["group_uid", "sku", "cut_adj", "storage_risk"]);
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_RUN_NOW", kind: "cut_adj", mode: "full" }), { ok: false, error: "Yêu cầu chạy không hợp lệ" }, "loại mới chỉ có một kiểu chạy");
    const plain = harness();
    assert.deepEqual((await plain.sync.handleMessage({ type: "AUTO_STATUS" })).kinds, ["group_uid", "sku"]);
    // RPC từ chối ({ok:false}) → lượt lỗi với câu của hàm; tab hết phiên → bỏ qua.
    const denied = harness({ insideTab: false, cutAdjCore, storageRiskCore, edgeOverride: { "rpc:wms_cut_coverage": () => ({ ok: false, error: { code: "FORBIDDEN", message: "Chỉ Admin được nạp file lịch sử WMS" } }) } });
    const r2 = await denied.sync.tick();
    assert.deepEqual([r2.results[1].kind, r2.results[1].status, r2.results[1].message], ["cut_adj", "error", "Chỉ Admin được nạp file lịch sử WMS"]);
    const expired = harness({ insideTab: false, wmsError: { code: "SKU_COUNT_READ_FAILED", message: "Phiên WMS đã hết hạn; hãy đăng nhập lại", reason: "session" }, storageRiskCore });
    const r3 = await expired.sync.tick();
    assert.deepEqual(r3.results.map(item => `${item.kind}:${item.status}`), ["group_uid:skipped", "storage_risk:skipped"]);
  }

  // Review 26/10/2026: câu tóm tắt nêu kết quả bước nguồn (không im lặng) — Đối chiếu ADJ (vòng 2: đúng đại lượng, cùng cụm chữ với web
  // syncFromWms): "nguồn phiếu: đã gán <adj + it> · còn chưa nguồn <unresolved − adj − it>" + phiếu chưa tra được số + danh sách Cut bị cắt
  // (matched gồm cả Cut ghép được phiếu nhưng phiếu chưa tra được số — không được ghi, không phải "đã gán"); Rủi ro lưu trữ: số cặp
  // SKU × vị trí ảo có nguồn / tổng cặp + lý do khi dừng sớm. Lõi cũ không trả → câu cũ.
  {
    const cutAdjCore = { run: async () => ({ total: 1234, cutRows: 12, newRows: 10, changedRows: 2,
      source: { unresolved: 40, docs: 9, matched: 25, written: 22, skipped: 0, adj: 20, it: 2, notFound: 3, truncated: true } }) };
    const storageRiskCore = { run: async () => ({ ok: true, skuCount: { rows: 641, sources: { done: 58, total: 64, reason: "dừng đọc chuyển vị trí: WMS trả mã 500" } }, uidTemp: { rows: 5 } }) };
    const h = harness({ insideTab: false, cutAdjCore, storageRiskCore });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok", "cut_adj:ok", "storage_risk:ok"]);
    assert.deepEqual(result.results.slice(1).map(item => item.message), [
      "Nạp 12 dòng Cut: 10 mới, 2 đổi · 1.234 dòng lịch sử đã đọc · nguồn phiếu: đã gán 22 · còn chưa nguồn 18 · 3 phiếu chưa tra được số · danh sách Cut bị cắt",
      "Kiểm kê 641 SKU · nguồn 58/64 cặp: dừng đọc chuyển vị trí: WMS trả mã 500 · UID tạm 5 dòng",
    ]);
    const full = harness({ insideTab: false,
      cutAdjCore: { run: async () => ({ total: 5, cutRows: 1, newRows: 1, changedRows: 0, source: { unresolved: 4, matched: 4, written: 4, adj: 3, it: 1, notFound: 0, truncated: false } }) },
      storageRiskCore: { run: async () => ({ ok: true, skuCount: { rows: 3, sources: { done: 2, total: 2, reason: "" } }, uidTemp: { rows: 0 } }) } });
    assert.deepEqual((await full.sync.tick()).results.slice(1).map(item => item.message), [
      "Nạp 1 dòng Cut: 1 mới, 0 đổi · 5 dòng lịch sử đã đọc · nguồn phiếu: đã gán 4 · còn chưa nguồn 0",
      "Kiểm kê 3 SKU · nguồn 2/2 cặp · UID tạm 0 dòng",
    ]);
  }

  // 0.10.8 (D8): auto-sync đưa giờ server (meta.updatedAt của RPC; thiếu thì header Date) cho lõi Cắt/ADJ qua serverNow.
  {
    const seen = [];
    const cutAdjCore = { run: async ({ rpc, serverNow }) => {
      seen.push(typeof serverNow === "function" ? serverNow() : "thiếu serverNow");
      await rpc("wms_cut_coverage", {});
      seen.push(serverNow());
      await rpc("wms_group_uid_cut_import", { p_rows: [] });
      seen.push(serverNow());
      return { total: 0, cutRows: 0, newRows: 0, changedRows: 0 };
    } };
    const h = harness({ insideTab: false, cutAdjCore, edgeOverride: {
      "rpc:wms_cut_coverage": () => ({ ok: true, data: null, meta: { updatedAt: "2026-10-17T03:00:00.123Z", schemaVersion: 1 } }),
      "rpc:wms_group_uid_cut_import": () => ({ ok: true, data: { cutRows: 0 } }),
    } });
    const result = await h.sync.tick();
    assert.equal(result.results.find(item => item.kind === "cut_adj").status, "ok");
    assert.equal(Number.isNaN(seen[0]), true, "chưa gọi RPC → chưa có giờ server");
    assert.equal(seen[1], Date.parse("2026-10-17T03:00:00.123Z"), "giờ server = meta.updatedAt của wms_cut_coverage");
    assert.equal(seen[2], Date.parse("2026-10-17T03:00:00.123Z"), "RPC không có meta / header thì giữ giờ server đã biết");
    // Không có meta → header Date của phản hồi.
    const seen2 = [];
    const core2 = { run: async ({ rpc, serverNow }) => { await rpc("wms_cut_coverage", {}); seen2.push(serverNow()); return { total: 0 }; } };
    const h2 = harness({ insideTab: false, cutAdjCore: core2, fetchOverride: async url => (url.includes("/rpc/wms_cut_coverage")
      ? { status: 200, ok: true, headers: { get: name => (String(name).toLowerCase() === "date" ? "Fri, 17 Oct 2026 03:05:00 GMT" : null) }, json: async () => ({ ok: true, data: null }) }
      : null) });
    await h2.sync.tick();
    assert.equal(seen2[0], Date.parse("2026-10-17T03:05:00.000Z"), "thiếu meta → header Date");
  }

  // ---- review vòng 1 (22/10/2026) ----
  // R2: mốc lượt = giờ BẮT ĐẦU → lượt dài 3 phút không đẩy lượt kế sang nhịp sau (trước đây nhịp thật 60 phút).
  {
    const h = harness({ insideTab: false, onWmsPage: async (message, self) => { if (message.payload.size === 500) self.clock.now += 3 * 60000; } });
    const start = h.clock.now;
    await h.sync.tick();
    assert.equal(h.storage.data["auto.last"].group_uid.at, new Date(start).toISOString(), "last.at = giờ bắt đầu lượt");
    h.clock.now = start + 30 * 60000;
    const next = await h.sync.tick();
    assert.deepEqual(next.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok"], "nhịp kế vẫn chạy");
    const crashed = harness({ storage: { "auto.active": { kind: "group_uid", mode: "incremental", holder: HOLDER, runId: "33333333-3333-4333-8333-333333333333", startedAt: new Date(DAY - 40 * 60000).toISOString() } } });
    await crashed.sync.recover();
    assert.equal(crashed.storage.data["auto.last"].group_uid.at, new Date(DAY - 40 * 60000).toISOString(), "lượt bị gián đoạn: mốc = lúc lượt đó bắt đầu, không hoãn thêm nhịp");
  }

  // R3: máy thiếu tab nhưng máy khác vừa đồng bộ (auto-config lastFinishedAt) → không báo ngừng loại đó; bật lại sau 2 ngày → không '!' ngay;
  // lỗi đọc cấu hình → lý do có trong cảnh báo.
  {
    let serverAt = null;
    const h = harness({ wmsTab: false, insideTab: false, edgeOverride: { "auto-config": () => ({ ...CONFIG, lastFinishedAt: serverAt ? { group_uid: serverAt } : {} }) } });
    await h.sync.tick();
    h.clock.now += 71 * 60000;
    serverAt = new Date(h.clock.now - 5 * 60000).toISOString();
    await h.sync.tick();
    assert.deepEqual(h.badges.at(-1), ["SKU ngừng 1,2 giờ: Không có tab Inside"], "Group UID do máy khác lo → không báo");
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_SET_ENABLED", enabled: false }), { ok: true });
    h.clock.now += 2 * 24 * HOUR;
    assert.deepEqual(await h.sync.handleMessage({ type: "AUTO_SET_ENABLED", enabled: true }), { ok: true });
    assert.deepEqual(h.badges.at(-1), [], "vừa bật lại: chưa báo ngừng");
    const down = harness({ edgeOverride: { "auto-config": () => ({ __error: { code: "SYNC_ERROR", message: "Edge lỗi" }, status: 503 }) } });
    await down.sync.tick();
    down.clock.now += 71 * 60000;
    await down.sync.tick();
    assert.ok(down.badges.at(-1).every(item => /Không đọc được cấu hình: Edge lỗi$/.test(item)) && down.badges.at(-1).length === 2, JSON.stringify(down.badges.at(-1)));
  }

  // R4: lõi Rủi ro lưu trữ thật + tab hết phiên (reason session) → "Bỏ qua" như Group UID / Đối chiếu ADJ.
  {
    const storageRiskCore = require("../extension/inside-po-connector/storage-risk-core.js");
    const h = harness({ insideTab: false, storageRiskCore, wmsError: { code: "SKU_COUNT_READ_FAILED", message: "Phiên WMS đã hết hạn hoặc không có quyền đọc dữ liệu", reason: "session" } });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.status}`), ["group_uid:skipped", "storage_risk:skipped"]);
    const denied = harness({ insideTab: false, storageRiskCore, wmsError: { code: "SKU_COUNT_READ_FAILED", message: "Phiên WMS không còn quyền", reason: "denied" } });
    assert.equal((await denied.sync.tick()).results.find(item => item.kind === "storage_risk").status, "error", "mất quyền là lỗi");
    // Lỗi hỗn hợp (Codex vòng 2): hết phiên ở một bước + mất quyền / mạng ở bước kia → không được thành "bỏ qua", theo cả hai thứ tự.
    for (const order of [["session", "denied"], ["denied", "session"], ["session", "network"]]) {
      let call = 0; // lần gọi đầu (bước Kiểm kê) lỗi order[0], các lần sau (bước UID tạm) lỗi order[1]
      const sendTab = async () => { const reason = order[Math.min(call++, 1)]; throw Object.assign(new Error(`lỗi ${reason}`), { code: "SKU_COUNT_READ_FAILED", fromTab: true, reason }); };
      await assert.rejects(storageRiskCore.run({ sendTab, rpc: async () => ({}) }), error => !error.fromTab && !error.reason, order.join("→"));
    }
    const bothSession = await storageRiskCore.run({ sendTab: async () => { throw Object.assign(new Error("Phiên WMS đã hết hạn"), { code: "SKU_COUNT_READ_FAILED", fromTab: true, reason: "session" }); }, rpc: async () => ({}) }).catch(error => error);
    assert.deepEqual([bothSession.fromTab, bothSession.reason], [true, "session"], "mọi bước hết phiên → bỏ qua được");
  }

  // ---- 0.10.10: khai báo bản Extension (extVersion) + tự dừng khi dưới mức tối thiểu (docs/plans/2026-10-26-nhieu-admin-khac-ban-extension.md) ----
  // Mỗi ca chạy riêng và in PASS/FAIL; một ca hỏng thì cả tệp thoát 1.
  {
    const cases = [];
    const add = (name, fn) => cases.push([name, fn]);
    const ALL = ["group_uid", "sku", "cut_adj", "storage_risk"];
    const edgeCalls = h => h.calls.filter(call => call.fn);
    const outdatedText = (label, min = NEW_EXT) => `${label}: cần Extension ≥ ${min} (đang v${OLD_EXT}); Reload Extension`;
    const skipText = `Cần Extension ≥ ${NEW_EXT} (đang v${OLD_EXT}): Reload Extension rồi tải lại tab`;
    const serverText = tab => `Extension v${OLD_EXT} quá cũ, cần ≥ ${NEW_EXT}; hãy Reload Extension rồi tải lại tab ${tab}`;

    add("(a) mọi lệnh Edge gửi extVersion = bản của máy; RPC Admin giữ nguyên tham số", async () => {
      const cutAdjCore = { run: async ({ rpc }) => { await rpc("wms_cut_coverage", {}); return { total: 0, cutRows: 0, newRows: 0, changedRows: 0 }; } };
      const storageRiskCore = { run: async () => ({ ok: true, skuCount: { rows: 0 }, uidTemp: { rows: 0 } }) };
      const h = harness({ version: NEW_EXT, cutAdjCore, storageRiskCore, storage: { "auto.active": { kind: "group_uid", mode: "incremental", holder: HOLDER, runId: "44444444-4444-4444-8444-444444444444", startedAt: new Date(DAY - 40 * 60000).toISOString() } } });
      await h.sync.recover();
      await h.sync.tick();
      await h.sync.runNow("sku", "full");
      await h.sync.handleMessage({ type: "AUTO_STATUS" });
      await h.sync.handleMessage({ type: "AUTO_SIGN_IN", email: "admin-test@example.com", password: "x" });
      assert.deepEqual([...new Set(edgeCalls(h).map(call => call.action))].sort(), ["apply", "auto-config", "cancel", "history", "ingest", "lease", "prepare", "preview", "release"], "ca phủ mọi lệnh Edge");
      assert.deepEqual(edgeCalls(h).filter(call => call.extVersion !== NEW_EXT).map(call => `${call.fn}:${call.action}`), [], "lệnh thiếu / sai extVersion");
      const rpcs = h.calls.filter(call => call.rpc);
      assert.ok(rpcs.length > 0 && rpcs.every(call => !("extVersion" in call.args)), "RPC Admin (PostgREST) không nhận khoá lạ");
      // Không truyền deps.version → chrome.runtime.getManifest().version đọc lúc gọi; getManifest lỗi / không có chrome → bỏ khoá.
      const saved = globalThis.chrome;
      try {
        let manifest = { version: NEW_EXT };
        globalThis.chrome = { runtime: { getManifest: () => manifest } };
        const m = harness({ wmsTab: false, insideTab: false });
        await m.sync.tick();
        manifest = { version: "9.9.9" };
        await m.sync.handleMessage({ type: "AUTO_STATUS" });
        assert.deepEqual(edgeCalls(m).map(call => call.extVersion), [NEW_EXT, "9.9.9"], "đọc bản lúc gọi (Reload đổi bản)");
        globalThis.chrome = { runtime: { getManifest: () => { throw new Error("Extension context invalidated"); } } };
        const broken = harness({ wmsTab: false, insideTab: false });
        await broken.sync.tick();
        assert.ok(edgeCalls(broken).length === 1 && !("extVersion" in edgeCalls(broken)[0]), "getManifest lỗi → không gửi khoá");
      } finally {
        if (saved === undefined) delete globalThis.chrome; else globalThis.chrome = saved;
      }
      const none = harness({ wmsTab: false, insideTab: false });
      await none.sync.tick();
      assert.ok(!("extVersion" in edgeCalls(none)[0]), "không chrome, không deps.version → không gửi khoá");
    });

    add("(b) versionLess khớp từng ca của bảng ca chung với Edge; đọc mức từ câu 409", () => {
      const block = versionCaseBlock("sku_sync_function.mjs");
      assert.equal(versionCaseBlock("group_uid_sync_function.mjs"), block, "hai tệp test Edge cùng một bảng ca");
      const table = versionCases();
      assert.ok(Array.isArray(table) && table.length >= 20, "bảng ca đủ dòng");
      assert.ok(table.some(([have, min, blocked]) => have === OLD_EXT && min === NEW_EXT && blocked === true), "có ca 0.10.9 < 0.10.10");
      for (const [have, min, blocked] of table) assert.equal(versionLess(have, min), blocked, `${JSON.stringify(have) ?? "không gửi"} / mức ${JSON.stringify(min)}`);
      assert.equal(parseMinFromMessage(serverText("Inside")), NEW_EXT);
      assert.equal(parseMinFromMessage(`Extension chưa khai báo bản, cần ≥ ${NEW_EXT}; hãy Reload Extension rồi tải lại tab WMS`), NEW_EXT);
      assert.equal(parseMinFromMessage("Edge Function trả HTTP 409"), null);
      assert.equal(parseMinFromMessage(undefined), null);
    });

    add("(c) decide: loại dưới mức → bỏ qua kèm outdated, không có việc; loại khác chạy; loại không có mức qua; không truyền version → không xét", () => {
      const cfg = { ...CONFIG, minExtension: { sku: NEW_EXT, group_uid: null, cut_adj: NEW_EXT, storage_risk: NEW_EXT } };
      const plan = decide({ ...base, now: DAY, config: cfg, kinds: ALL, version: OLD_EXT });
      assert.deepEqual(jobs(plan), ["group_uid:incremental"]);
      assert.deepEqual(plan.skipped.map(item => [item.kind, item.reason, item.log, item.outdated]), ["sku", "cut_adj", "storage_risk"].map(kind => [kind, skipText, true, { min: NEW_EXT, version: OLD_EXT }]));
      // Dưới mức xét trước thiếu tab và khung giờ Rủi ro lưu trữ: cảnh báo không tắt bật theo giờ / tab.
      const night = decide({ ...base, now: NIGHT, config: cfg, kinds: ALL, version: OLD_EXT, hasWms: false, hasInside: false });
      assert.deepEqual(night.skipped.map(item => [item.kind, Boolean(item.outdated)]), [["group_uid", false], ["sku", true], ["cut_adj", true], ["storage_risk", true]]);
      assert.equal(night.reason, `Không có tab WMS; ${skipText}`);
      assert.deepEqual(jobs(decide({ ...base, now: DAY, config: cfg, kinds: ALL, version: NEW_EXT })), ALL.map(kind => `${kind}:incremental`), "bằng mức → chạy");
      assert.deepEqual(jobs(decide({ ...base, now: DAY, config: cfg, kinds: ALL })), ALL.map(kind => `${kind}:incremental`), "không truyền version (test cũ) → không xét");
      for (const minExtension of [undefined, null, {}, { sku: "" }, { sku: "x" }, [NEW_EXT], NEW_EXT]) {
        assert.deepEqual(jobs(decide({ ...base, now: DAY, config: { ...CONFIG, minExtension }, kinds: ALL, version: OLD_EXT })), ALL.map(kind => `${kind}:incremental`), `không có mức hợp lệ: ${JSON.stringify(minExtension)}`);
      }
      // Cùng bảng ca với Edge (trừ "không gửi": decide không truyền version là test cũ, không xét).
      for (const [have, min, blocked] of versionCases()) {
        if (have === undefined) continue;
        const one = decide({ ...base, now: DAY, config: { ...CONFIG, minExtension: { sku: min } }, kinds: ["sku"], version: have });
        assert.equal(jobs(one).length === 0, blocked, `decide ${JSON.stringify(have)} / mức ${JSON.stringify(min)}`);
      }
    });

    add("(d) tick: mức sku 0.10.10, máy 0.10.9 → không thuê khoá, không đọc Inside, '!' ngay; hạ mức → chạy lại; máy 0.10.10 chạy bình thường", async () => {
      const cfg = { ...CONFIG, minExtension: { sku: NEW_EXT, group_uid: null, cut_adj: null, storage_risk: null } };
      const h = harness({ version: OLD_EXT, edgeOverride: { "auto-config": () => cfg } });
      const r1 = await h.sync.tick();
      assert.deepEqual(r1.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok"]);
      assert.deepEqual(actions(h.calls, "sku-sync"), ["auto-config"], "SKU: không lease / history / preview");
      assert.equal(h.calls.some(call => call.tab === "inside"), false, "không đọc Inside");
      assert.deepEqual(h.badges.at(-1), [outdatedText("SKU")], "báo ngay, không chờ 2 nhịp + 10 phút");
      const skuLog = h.storage.data["auto.log"].find(row => row.kind === "sku");
      assert.deepEqual([skuLog.status, skuLog.message], ["skipped", skipText]);
      assert.deepEqual(h.storage.data["auto.health"].kinds.sku.outdated, { min: NEW_EXT, version: OLD_EXT, at: new Date(DAY).toISOString() });
      const status = await h.sync.handleMessage({ type: "AUTO_STATUS" });
      assert.deepEqual([status.version, status.minExtension, status.problems], [OLD_EXT, cfg.minExtension, [outdatedText("SKU")]], "Tùy chọn nhận bản máy + mức tối thiểu + thẻ đỏ");
      h.clock.now += 30 * 60000;
      await h.sync.tick();
      assert.equal(h.storage.data["auto.log"].find(row => row.kind === "sku").repeat, 2, "dòng bỏ qua lặp tự gộp");
      // Admin hạ mức lúc tab Inside đã đóng: SKU không chạy được nhưng dấu dưới mức (và lý do của nó) vẫn phải bỏ ngay ở lượt này.
      const closed = harness({ version: OLD_EXT, insideTab: false, storage: JSON.parse(JSON.stringify(h.storage.data)), edgeOverride: { "auto-config": () => ({ ...CONFIG, minExtension: {} }) } });
      await closed.sync.tick();
      assert.deepEqual([closed.storage.data["auto.health"].kinds.sku.outdated, closed.storage.data["auto.health"].kinds.sku.reason], [null, "Không có tab Inside"]);
      assert.deepEqual(closed.badges.at(-1), [], "hết dưới mức, chưa quá 2 nhịp");
      cfg.minExtension.sku = null; // Admin hạ mức
      h.clock.now += 30 * 60000;
      const r3 = await h.sync.tick();
      assert.deepEqual(r3.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok", "sku:ok"]);
      assert.equal(h.storage.data["auto.health"].kinds.sku.outdated, null, "bỏ dấu dưới mức");
      assert.deepEqual(h.badges.at(-1), []);
      const up = harness({ version: NEW_EXT, edgeOverride: { "auto-config": () => ({ ...CONFIG, minExtension: { sku: NEW_EXT, group_uid: NEW_EXT } }) } });
      const r4 = await up.sync.tick();
      assert.deepEqual(r4.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok", "sku:ok"]);
      assert.deepEqual(up.badges.at(-1), []);
    });

    add("(e) 409 EXTENSION_OUTDATED ở lease → bỏ qua kèm outdated, không chạm tab, không nhả khoá; Chạy ngay trả câu server", async () => {
      const reject = body => ({ __error: { code: "EXTENSION_OUTDATED", message: serverText(body.kind === "sku" ? "Inside" : "WMS") }, status: 409 });
      const coreRuns = [];
      const cutAdjCore = { run: async () => { coreRuns.push("cut_adj"); return {}; } };
      let gate = true;
      const h = harness({ version: OLD_EXT, cutAdjCore, edgeOverride: { lease: body => (body.kind === "group_uid" || !gate ? { ok: true } : reject(body)) } });
      const result = await h.sync.tick();
      assert.deepEqual(result.results.map(item => `${item.kind}:${item.status}`), ["group_uid:ok", "sku:skipped", "cut_adj:skipped"]);
      const sku = result.results.find(item => item.kind === "sku");
      assert.deepEqual([sku.message, sku.outdated], [serverText("Inside"), { min: NEW_EXT, version: OLD_EXT }]);
      assert.equal(h.calls.some(call => call.tab === "inside"), false, "không đọc Inside");
      assert.deepEqual(coreRuns, [], "không chạy lõi Đối chiếu ADJ");
      assert.deepEqual(h.calls.filter(call => call.fn === "sku-sync").map(call => `${call.action}:${call.kind ?? ""}`), ["auto-config:", "lease:sku", "lease:cut_adj"], "không history, không nhả khoá chưa giành");
      assert.deepEqual(h.badges.at(-1), [outdatedText("SKU"), outdatedText("Đối chiếu ADJ")]);
      assert.deepEqual(h.storage.data["auto.health"].kinds.sku.outdated, { min: NEW_EXT, version: OLD_EXT, at: new Date(DAY).toISOString() });
      const skuLog = h.storage.data["auto.log"].find(row => row.kind === "sku");
      assert.deepEqual([skuLog.status, skuLog.message], ["skipped", serverText("Inside")]);
      assert.equal(h.storage.data["auto.last"].sku, undefined, "bỏ qua không tính là đã chạy");
      const run = await h.sync.runNow("sku", "incremental");
      assert.deepEqual([run.ok, run.error], [false, serverText("Inside")], "Chạy ngay: Tùy chọn hiện câu server");
      gate = false; // Admin hạ mức: Chạy ngay thuê được khoá → bỏ dấu ngay, không chờ tick
      assert.equal((await h.sync.runNow("sku", "incremental")).ok, true);
      assert.equal(h.storage.data["auto.health"].kinds.sku.outdated, null);
      assert.deepEqual(h.badges.at(-1), [outdatedText("Đối chiếu ADJ")]);
      // Group UID: chỉ trang thử 1 dòng (có từ trước, trước khi thuê), không prepare, không nhả khoá.
      const gu = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { lease: reject } });
      const r2 = await gu.sync.tick();
      assert.deepEqual([r2.results[0].kind, r2.results[0].status, r2.results[0].message], ["group_uid", "skipped", serverText("WMS")]);
      assert.deepEqual(actions(gu.calls, "group-uid-sync"), ["lease"]);
      assert.deepEqual(gu.calls.filter(call => call.tab === "wms").map(call => call.payload.size), [1]);
      // Câu server không có mức → vẫn bỏ qua + báo ngay, câu không số.
      const odd = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { lease: () => ({ __error: { code: "EXTENSION_OUTDATED", message: "Extension quá cũ" }, status: 409 }) } });
      await odd.sync.tick();
      assert.deepEqual(odd.badges.at(-1), [`Group UID: cần Extension mới hơn (đang v${OLD_EXT}); Reload Extension`]);
    });

    add("(f) assessHealth: dấu dưới mức của đúng bản này báo ngay thay câu 'ngừng'; dấu của bản khác (vừa Reload) không báo gì tới tick kế; tắt / tạm dừng không báo", async () => {
      const recent = new Date(DAY - 60000).toISOString(), old = new Date(DAY - 3 * HOUR).toISOString();
      const mark = { min: NEW_EXT, version: OLD_EXT, at: recent };
      const health = { since: old, kinds: { group_uid: { aliveAt: old, reason: skipText, outdated: mark }, sku: { aliveAt: recent, reason: skipText, outdated: mark } } };
      const args = { now: DAY, signedIn: true, device: "may-test-01", intervalMinutes: 30, health, kinds: ["group_uid", "sku"] };
      assert.deepEqual(assessHealth({ ...args, version: OLD_EXT }), [outdatedText("Group UID"), outdatedText("SKU")], "một câu mỗi loại, không chờ 2 nhịp");
      assert.deepEqual(assessHealth({ ...args, version: NEW_EXT }), [], "đã Reload: dấu của bản cũ = loại bị chặn chủ ý, không báo ngừng (tick kế dọn dấu)");
      assert.deepEqual(assessHealth(args), [`Group UID ngừng 3 giờ: ${skipText}`], "không truyền version (test cũ) → như trước");
      assert.deepEqual(assessHealth({ ...args, version: OLD_EXT, paused: true }), [], "Admin tạm dừng");
      assert.deepEqual(assessHealth({ ...args, version: OLD_EXT, enabledLocal: false }), [], "máy tắt tự động");
      // Reload thật: service worker bản mới đọc cùng storage → '!' tắt ngay, không chờ tick.
      const before = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { "auto-config": () => ({ ...CONFIG, minExtension: { group_uid: NEW_EXT } }) } });
      await before.sync.tick();
      assert.deepEqual(before.badges.at(-1), [outdatedText("Group UID")]);
      const after = harness({ version: NEW_EXT, insideTab: false, storage: before.storage.data });
      assert.deepEqual(await after.sync.refreshBadge(), []);
      assert.deepEqual((await after.sync.handleMessage({ type: "AUTO_STATUS" })).problems, []);
      after.clock.now += 3 * HOUR; // Reload sau 3 giờ bị chặn: vẫn không báo "ngừng" cho loại đó trước tick kế
      assert.deepEqual(await after.sync.refreshBadge(), ["SKU ngừng 3 giờ: Không có tab Inside"]);
      await after.sync.tick();
      assert.equal(after.storage.data["auto.health"].kinds.group_uid.outdated, null, "tick kế dọn dấu");
    });

    add("(g) mức nâng giữa lượt: 409 ở prepare (Group UID) / preview (SKU) → bỏ qua kèm outdated, nhả khoá đã giành (không ghi mốc), không apply", async () => {
      const reject = tab => () => ({ __error: { code: "EXTENSION_OUTDATED", message: serverText(tab) }, status: 409 });
      const h = harness({ version: OLD_EXT, edgeOverride: { prepare: reject("WMS"), preview: reject("Inside") } });
      const result = await h.sync.tick();
      assert.deepEqual(result.results.map(item => [item.kind, item.status, item.message, item.outdated]), [["group_uid", "skipped", serverText("WMS"), { min: NEW_EXT, version: OLD_EXT }], ["sku", "skipped", serverText("Inside"), { min: NEW_EXT, version: OLD_EXT }]]);
      assert.deepEqual(actions(h.calls, "group-uid-sync"), ["lease", "prepare", "release"], "chưa có lượt nên không hủy");
      assert.deepEqual(actions(h.calls, "sku-sync"), ["auto-config", "lease", "history", "lease", "preview", "release"]);
      assert.ok(h.calls.filter(call => call.action === "release").every(call => call.finished === undefined), "không ghi mốc giãn cách");
      assert.deepEqual(h.badges.at(-1), [outdatedText("Group UID"), outdatedText("SKU")]);
    });

    // ---- review vòng 1 (nhóm E1): máy trạng thái outdated / guard ----
    add("(h) gia hạn khoá trả 409 → dừng lượt ngay: Group UID hủy lượt, không ingest; ADJ / Rủi ro lưu trữ không ghi RPC; SKU không preview / apply; lỗi mạng vẫn chịu ≤ 14 phút", async () => {
      const deny = tab => ({ __error: { code: "EXTENSION_OUTDATED", message: serverText(tab) }, status: 409 });
      const thenDeny = tab => { let n = 0; return () => (++n === 1 ? { ok: true } : deny(tab)); };
      const mark = { min: NEW_EXT, version: OLD_EXT };
      // (a) Group UID: thuê đầu được, gia hạn sau khi đọc WMS (confirmLease) bị 409.
      const gu = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { lease: thenDeny("WMS") } });
      const r1 = (await gu.sync.tick()).results[0];
      assert.deepEqual([r1.kind, r1.status, r1.message, r1.outdated], ["group_uid", "skipped", serverText("WMS"), mark]);
      assert.deepEqual(actions(gu.calls, "group-uid-sync"), ["lease", "prepare", "lease", "cancel", "release"], "hủy lượt đã prepare, không ingest / preview / apply");
      assert.match(gu.calls.find(call => call.action === "cancel").message, /Extension dưới mức tối thiểu/);
      assert.equal(gu.calls.find(call => call.action === "release").finished, undefined, "không ghi mốc giãn cách");
      assert.deepEqual(gu.badges.at(-1), [outdatedText("Group UID")]);
      // (a2) Group UID: gia hạn (alarm keepalive) bị 409 lúc đang xem trước → vẫn hủy lượt dù đã xem trước, không apply.
      let lateLeases = 0;
      const late = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { lease: () => (++lateLeases <= 2 ? { ok: true } : deny("WMS")) }, fetchOverride: async (url, init) => {
        if (JSON.parse(init.body).action === "preview" && url.includes("group-uid-sync")) { late.clock.now += 3 * 60000; await late.sync.onKeepAlive(); }
        return null;
      } });
      const r1b = (await late.sync.tick()).results[0];
      assert.deepEqual([r1b.status, r1b.message, r1b.outdated], ["skipped", serverText("WMS"), mark]);
      assert.deepEqual(actions(late.calls, "group-uid-sync"), ["lease", "prepare", "lease", "ingest", "lease", "preview", "cancel", "release"], "đã xem trước vẫn hủy, không apply");
      assert.match(late.calls.find(call => call.action === "cancel").message, /Extension dưới mức tối thiểu/);
      // (b) Đối chiếu ADJ: gia hạn (alarm keepalive) bị 409 giữa đọc lịch sử và ghi → không gọi wms_group_uid_cut_import.
      let adj;
      const adjLease = thenDeny("WMS"), adjRenew = [];
      const cutAdjCore = { run: async ({ sendTab, rpc }) => {
        await rpc("wms_cut_coverage", {});
        await sendTab("GET_GROUP_UID_HISTORY_PAGE", { page: 1, size: 500 });
        adj.clock.now += 3 * 60000;
        adjRenew.push(await adj.sync.onKeepAlive());
        await rpc("wms_group_uid_cut_import", { p_rows: [] });
        return { total: 0, cutRows: 0, newRows: 0, changedRows: 0 };
      } };
      adj = harness({ version: OLD_EXT, insideTab: false, cutAdjCore, edgeOverride: { lease: body => (body.kind === "cut_adj" ? adjLease() : { ok: true }) } });
      const r2 = (await adj.sync.tick()).results.find(item => item.kind === "cut_adj");
      assert.deepEqual([r2.status, r2.message, r2.outdated, adjRenew], ["skipped", serverText("WMS"), mark, [false]]);
      assert.deepEqual(adj.calls.filter(call => call.rpc).map(call => call.rpc), ["wms_cut_coverage"], "không ghi sau 409");
      // (c) Rủi ro lưu trữ: như lõi thật, bước lỗi vẫn chạy bước sau, lỗi gộp có thể mất mã → không RPC nào sau 409, vẫn là bỏ qua kèm outdated.
      let sr;
      const srLease = thenDeny("WMS");
      const storageRiskCore = { run: async ({ sendTab, rpc }) => {
        await sendTab("GET_SKU_COUNT_WAREHOUSES", {});
        sr.clock.now += 3 * 60000;
        await sr.sync.onKeepAlive();
        const failures = [];
        for (const name of ["sku_count_save_start", "uid_temp_save"]) { try { await rpc(name, {}); } catch (error) { failures.push(`${name}: ${error.message}`); } }
        if (failures.length) throw new Error(failures.join(" · "));
        return { ok: true, skuCount: { rows: 0 }, uidTemp: { rows: 0 } };
      } };
      sr = harness({ version: OLD_EXT, insideTab: false, storageRiskCore, edgeOverride: { lease: body => (body.kind === "storage_risk" ? srLease() : { ok: true }) } });
      const r3 = (await sr.sync.tick()).results.find(item => item.kind === "storage_risk");
      assert.deepEqual([r3.status, r3.message, r3.outdated], ["skipped", serverText("WMS"), mark]);
      assert.deepEqual(sr.calls.filter(call => call.rpc), [], "không RPC ghi nào sau 409");
      // (d) SKU: gia hạn sau khi đọc Inside bị 409 → không preview, không apply.
      const sku = harness({ version: OLD_EXT, wmsTab: false, edgeOverride: { lease: thenDeny("Inside") } });
      const r4 = (await sku.sync.tick()).results[0];
      assert.deepEqual([r4.kind, r4.status, r4.message, r4.outdated], ["sku", "skipped", serverText("Inside"), mark]);
      assert.deepEqual(actions(sku.calls, "sku-sync"), ["auto-config", "lease", "history", "lease", "release"]);
      // Không đổi: lỗi mạng khi gia hạn chịu tới 14 phút (lượt chạy tiếp), quá 14 phút mới là mất khoá.
      const netLease = () => { let n = 0; return () => { if (++n === 1) return { ok: true }; throw new TypeError("Failed to fetch"); }; };
      const net = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { lease: netLease() } });
      assert.equal((await net.sync.tick()).results[0].status, "ok");
      assert.deepEqual(actions(net.calls, "group-uid-sync").slice(-3), ["preview", "apply", "release"]);
      const slow = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { lease: netLease() }, onWmsPage: async (message, self) => { if (message.payload.size === 500) self.clock.now += 15 * 60000; } });
      const r6 = (await slow.sync.tick()).results[0];
      assert.deepEqual([r6.status, r6.message, r6.outdated], ["error", "Mất khoá thuê: không gia hạn được", undefined]);
      assert.equal(slow.calls.find(call => call.action === "cancel").message, "Mất khoá thuê");
    });

    add("(i) dấu dưới mức không kẹt ở nhánh lỗi: Edge nhận lease → bỏ dấu ngay trong lượt; hạ mức rồi Chạy ngay SKU mà tab Inside lỗi; auto-config lỗi kéo dài", async () => {
      const cfg = { ...CONFIG, minExtension: { sku: NEW_EXT, group_uid: NEW_EXT } };
      let during = "chưa đọc";
      const h = harness({
        version: OLD_EXT, edgeOverride: { "auto-config": () => cfg },
        insideError: { code: "SKU_SYNC_READ_FAILED", message: "Phiên Inside đã hết hạn; hãy đăng nhập lại", reason: "session" },
        onWmsPage: async (message, self) => { if (message.payload.size === 500) during = self.storage.data["auto.health"].kinds.group_uid.outdated; },
      });
      await h.sync.tick();
      assert.deepEqual(h.badges.at(-1), [outdatedText("Group UID"), outdatedText("SKU")]);
      cfg.minExtension = {}; // Admin hạ mức
      const run = await h.sync.runNow("sku", "incremental");
      assert.deepEqual([run.result.status, run.result.message], ["skipped", "Phiên Inside đã hết hạn; hãy đăng nhập lại"]);
      assert.equal(h.storage.data["auto.health"].kinds.sku.outdated, null, "bỏ qua (không do bản) cũng bỏ dấu");
      assert.deepEqual(h.badges.at(-1), [outdatedText("Group UID")], "không còn câu 'cần Extension' cho SKU");
      await h.sync.runNow("group_uid", "incremental");
      assert.equal(during, null, "Edge nhận lease → bỏ dấu ngay, trước khi lượt xong");
      // Lượt dừng trước cả lúc thuê khoá (tab WMS hết phiên ở trang thử) cũng bỏ dấu cũ.
      const gcfg = { ...CONFIG, minExtension: { group_uid: NEW_EXT } };
      const probe = harness({ version: OLD_EXT, insideTab: false, wmsError: { code: "GROUP_UID_READ_FAILED", message: "Phiên WMS đã hết hạn; hãy đăng nhập lại", reason: "session" }, edgeOverride: { "auto-config": () => gcfg } });
      await probe.sync.tick();
      assert.deepEqual(probe.badges.at(-1), [outdatedText("Group UID")]);
      gcfg.minExtension = {};
      const pr = await probe.sync.runNow("group_uid", "incremental");
      assert.deepEqual([pr.result.status, actions(probe.calls, "group-uid-sync")], ["skipped", []]);
      assert.equal(probe.storage.data["auto.health"].kinds.group_uid.outdated, null);
      assert.deepEqual(probe.badges.at(-1), []);
      // auto-config lỗi kéo dài: dấu cũ bị xoá, lý do là câu lỗi cấu hình.
      let failing = false;
      const down = harness({ version: OLD_EXT, insideTab: false, edgeOverride: { "auto-config": () => (failing ? { __error: { code: "SYNC_ERROR", message: "Edge lỗi" }, status: 503 } : { ...CONFIG, minExtension: { group_uid: NEW_EXT } }) } });
      await down.sync.tick();
      assert.deepEqual(down.badges.at(-1), [outdatedText("Group UID")]);
      failing = true;
      await down.sync.tick();
      const gu = down.storage.data["auto.health"].kinds.group_uid;
      assert.deepEqual([gu.outdated, gu.reason], [null, "Không đọc được cấu hình: Edge lỗi"]);
      down.clock.now += 71 * 60000;
      await down.sync.tick();
      assert.deepEqual(down.badges.at(-1), ["Group UID ngừng 1,2 giờ: Không đọc được cấu hình: Edge lỗi", "SKU ngừng 1,2 giờ: Không đọc được cấu hình: Edge lỗi"]);
    });

    const failed = [];
    for (const [name, fn] of cases) {
      try { await fn(); console.log(`PASS 0.10.10 ${name}`); }
      catch (error) { failed.push(name); console.error(`FAIL 0.10.10 ${name}: ${error.message}`); }
    }
    assert.deepEqual(failed, [], "ca 0.10.10 hỏng");
  }

  // 0.12.5: đáp án runNow → phản hồi cho lệnh web RUN_GROUP_UID_SYNC (nút Đọc WMS ở Tiến độ A5000)
  {
    const ok = webRunResponse({ ok: true, result: { status: "ok", runId: "r1", message: "Đã cập nhật 12 UID · 340 UID đã đọc" } });
    assert.deepEqual(ok, { ok: true, data: { status: "ok", message: "Đã cập nhật 12 UID · 340 UID đã đọc", runId: "r1", covered: false } });
    const held = webRunResponse({ ok: true, result: { status: "held", runId: "r2", message: "Thay đổi lớn: cần Admin xem" } });
    assert.deepEqual([held.ok, held.data.status, held.data.message], [true, "held", "Thay đổi lớn: cần Admin xem"], "lượt bị giữ lại không phải lỗi: web nói rõ để Admin xem xét");
    const covered = webRunResponse({ ok: true, result: { status: "skipped", covered: true, message: "Đang có lượt khác (Admin đang xem trước)" } });
    assert.deepEqual([covered.ok, covered.data.status, covered.data.covered, covered.data.runId], [true, "skipped", true, null]);
    const noTab = webRunResponse({ ok: true, result: { status: "skipped", message: "Hãy mở một tab WMS và đăng nhập trước" } });
    assert.deepEqual([noTab.ok, noTab.data.status], [true, "skipped"]);
    assert.deepEqual(webRunResponse({ ok: false, result: { status: "error", message: "WMS HTTP 500" }, error: "WMS HTTP 500" }), { ok: false, error: { code: "SYNC_ERROR", message: "WMS HTTP 500" } });
    assert.deepEqual(webRunResponse({ ok: false, result: { status: "skipped", outdated: { min: "0.12.5" }, message: "Cần Extension 0.12.5" }, error: "Cần Extension 0.12.5" }).error.code, "EXTENSION_OUTDATED");
    assert.deepEqual(webRunResponse({ ok: false, error: "Chưa đặt tên máy" }), { ok: false, error: { code: "AUTO_REFUSED", message: "Chưa đặt tên máy" } });
    assert.deepEqual(webRunResponse({ ok: false, error: "Đang có lượt tự động chạy" }).error.code, "AUTO_REFUSED");
    assert.equal(webRunResponse(undefined).error.code, "AUTO_REFUSED", "không có đáp án → từ chối, không ném lỗi");
    assert.equal(webRunResponse({ ok: false, error: "  a\n  b  " }).error.message, "a b", "gọn khoảng trắng như mọi câu của Extension");
  }

  console.log("auto_sync_core: decide + orchestration passed");
})().catch(error => { console.error(error); process.exit(1); });
