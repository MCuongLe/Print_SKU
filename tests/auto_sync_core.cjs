// Bộ điều phối đồng bộ tự động (extension/inside-po-connector/auto-sync.js): hàm decide thuần + luồng chạy với tab/Edge giả.
//   node tests/auto_sync_core.cjs
const assert = require("node:assert/strict");
const { createAutoSync, decide, inFullWindow, vnMinutes } = require("../extension/inside-po-connector/auto-sync.js");
const { readGroupUidSnapshot } = require("../extension/inside-po-connector/group-uid-snapshot-core.js");

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
function harness({ now = DAY, wmsTab = true, insideTab = true, wmsError = null, insideError = null, edgeOverride = {}, applyHeld = null, storage: initial, onWmsPage = null, sessionOverride = {} } = {}) {
  const storage = memoryStorage({ "auto.device": "may-test-01", "auto.enabled": true, "auto.instance": "abc123", ...initial });
  const calls = [], alarms = [], timers = [], signOuts = [];
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
    storage, fetch, now: () => clock.now, config: { url: "https://example.invalid", key: "test-key" },
    session: { getAccessToken: async () => "token-test", getSession: async () => ({ user: { email: "admin-test@example.com" } }), signOut: async () => { signOuts.push(1); }, signIn: async () => ({}), ...sessionOverride },
    snapshotCore: { readGroupUidSnapshot },
    alarms: { create: async (name, info) => alarms.push(["create", name, info?.periodInMinutes]), clear: async name => alarms.push(["clear", name]), get: async name => ({ scheduledTime: now + 30 * 60000, periodInMinutes: name === "auto-sync" ? 30 : 0.5 }) },
    timers: { set: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; }, clear: id => { timers[id - 1].cleared = true; } },
    findWmsTab: async () => (wmsTab ? { id: 1 } : null),
    findInsideTab: async () => (insideTab ? { id: 2 } : null),
    sendToWms: async (tab, message) => {
      calls.push({ tab: "wms", ...message });
      if (onWmsPage) await onWmsPage(message, h);
      if (wmsError) return { ok: false, error: wmsError };
      const page = message.payload.page, size = message.payload.size;
      return { ok: true, data: { page, size, total: wmsRows.length, totalPages: Math.max(1, Math.ceil(wmsRows.length / size)), rows: wmsRows.slice((page - 1) * size, page * size) } };
    },
    sendToInside: async (tab, message) => {
      calls.push({ tab: "inside", ...message });
      if (insideError) return { ok: false, error: insideError };
      return { ok: true, data: { generatedAt: "2026-10-17T03:00:00.000Z", normalRows: [{ sku: "900000001" }], comboRows: [], categories: [] } };
    },
  });
  const h = { sync, storage, calls, alarms, timers, signOuts, clock };
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
      assert.deepEqual(leases.map(call => call.cooldownSeconds), [30 * 60 - 120, undefined], fn);
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
    assert.equal(hourly.calls.find(call => call.action === "lease").cooldownSeconds, 60 * 60 - 120, "giãn cách theo nhịp Admin");
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
    const h = harness({ wmsError: { code: "GROUP_UID_READ_FAILED", message: "Phiên WMS đã hết hạn; hãy đăng nhập lại" }, insideError: { code: "SKU_SYNC_READ_FAILED", message: "Phiên Inside đã hết hạn; hãy đăng nhập lại" } });
    const result = await h.sync.tick();
    assert.deepEqual(result.results.map(item => `${item.kind}:${item.status}`), ["group_uid:skipped", "sku:skipped"]);
    assert.deepEqual(actions(h.calls, "group-uid-sync"), [], "không lease, không prepare khi WMS đăng xuất");
    assert.ok(!actions(h.calls, "sku-sync").includes("preview"));
    assert.equal(h.storage.data["auto.last"], undefined, "bỏ qua không tính là đã chạy");
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

  console.log("auto_sync_core: decide + orchestration passed");
})().catch(error => { console.error(error); process.exit(1); });
