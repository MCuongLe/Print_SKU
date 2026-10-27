// Đồng bộ tự động Group UID / SKU trong service worker (auto-sync v1, 17/10/2026).
// Nhịp: gia tăng theo alarm "auto-sync" (30 phút); toàn bộ 1 lần/đêm trong khung giờ VN của cấu hình nếu lượt toàn bộ gần nhất đã quá 20 giờ.
// Chỉ chạy khi có tab WMS (Group UID) / Inside (SKU) đang đăng nhập; thiếu tab hoặc tab hết phiên → bỏ qua lặng lẽ (ghi nhật ký "bỏ qua").
// Token WMS/Inside không rời tab (đọc qua content script); Supabase dùng phiên Admin riêng của Extension (supabase-session.js).
// Áp dụng gửi auto:true + holder → Edge tự giữ lại khi vượt ngưỡng (status "held") để Admin xem; Edge từ chối ghi khi máy đã mất khoá thuê.
// Khoá thuê (15 phút) được gia hạn suốt lượt: mỗi 5 phút (setInterval) và khi alarm "auto-keepalive" đánh thức (cách nhau ≥ 2 phút);
// mất khoá → dừng lượt (Group UID: hủy lượt), không xem trước / áp dụng.
// Giãn cách giữa các máy: lượt theo lịch thuê khoá kèm cooldownSeconds = nhịp − 2 phút; lượt cùng loại (máy nào cũng vậy) vừa kết thúc
// trong khoảng đó → server từ chối (COOLDOWN), bỏ qua lặng lẽ. Lượt hoàn tất / giữ lại nhả khoá với finished:true để ghi mốc đó.
// Nhịp đã xác minh lưu ở auto.interval để background.js tạo lại alarm đúng nhịp khi Chrome làm mất alarm.
(function (root) {
  // 0.10.7: thêm cut_adj (lịch sử Cut WMS cho Đối chiếu ADJ, mỗi nhịp) và storage_risk (Rủi ro lưu trữ = Kiểm kê + UID tạm, mỗi 2 giờ
  // 07:00–19:30 giờ VN). Hai loại mới chỉ bật khi service worker đã nạp lõi đọc tương ứng (cut-adj-core.js / storage-risk-core.js).
  const BASE_KINDS = ["group_uid", "sku"];
  const KINDS = ["group_uid", "sku", "cut_adj", "storage_risk"];
  const NEEDS_WMS = new Set(["group_uid", "cut_adj", "storage_risk"]);
  const STORAGE_EVERY_MS = 120 * 60 * 1000;
  const STORAGE_WINDOW = { start: 7 * 60, end: 19 * 60 + 30 };
  const STORAGE_STALE_WORK_MINUTES = 2 * 120 + 10;
  // Giãn cách gửi server (cooldown) = nhịp − 10 phút (review 22/10, R2): last_finished_at là giờ XONG lượt; trừ 2 phút như trước thì
  // lượt dài hơn 2 phút làm lượt kế bị COOLDOWN → nhịp thật gấp đôi. Mỗi máy đã tự giữ nhịp bằng decide (mốc = giờ BẮT ĐẦU lượt).
  const COOLDOWN_SLACK_S = 10 * 60;
  const FULL_STALE_MS = 20 * 60 * 60 * 1000;
  const INTERVAL_SLACK_MS = 2 * 60 * 1000;
  const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
  const LOG_LIMIT = 50;
  const KEYS = { device: "auto.device", enabled: "auto.enabled", last: "auto.last", log: "auto.log", interval: "auto.interval", active: "auto.active", health: "auto.health", paused: "auto.paused" };
  // cut_adj / storage_risk chỉ dùng Edge sku-sync cho khoá thuê (lease/release); dữ liệu ghi bằng RPC Admin (PostgREST).
  const FN = { group_uid: "group-uid-sync", sku: "sku-sync", cut_adj: "sku-sync", storage_risk: "sku-sync" };
  const TAB_NAME = { group_uid: "WMS", sku: "Inside", cut_adj: "WMS", storage_risk: "WMS" };
  const WMS_PAGE_TIMEOUT_MS = 90 * 1000;
  const INSIDE_TIMEOUT_MS = { full: 900 * 1000, incremental: 210 * 1000 };
  const KEEPALIVE = "auto-keepalive";
  const AUTO_ALARM = "auto-sync";
  const LEASE_RENEW_EVERY_MS = 5 * 60 * 1000;
  const LEASE_RENEW_MIN_GAP_MS = 2 * 60 * 1000;
  // Không gia hạn được (lỗi mạng) quá 14 phút kể từ lần gia hạn được gần nhất = coi như mất khoá (hạn thuê 15 phút).
  const LEASE_SAFE_MS = 14 * 60 * 1000;
  // 0.10.7: hết giờ chờ Edge (trước đây fetch treo giữ "đang chạy" mãi). Ghi/xem trước Group UID toàn bộ đo được tới ~3 phút.
  const EDGE_TIMEOUT_MS = { ingest: 120 * 1000, preview: 300 * 1000, apply: 300 * 1000 };
  const EDGE_DEFAULT_TIMEOUT_MS = 60 * 1000;
  // Cảnh báo "ngừng" (người dùng chốt 22/10/2026): quá 2 nhịp + 10 phút không có lượt nào chạy được (máy này hoặc máy khác).
  const STALE_SLACK_MS = 10 * 60 * 1000;
  const LABEL = { group_uid: "Group UID", sku: "SKU", cut_adj: "Đối chiếu ADJ", storage_risk: "Rủi ro lưu trữ" };
  const RPC_TIMEOUT_MS = 120 * 1000;

  function clean(value, max = 300) { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
  function num(value) { return Number(value || 0).toLocaleString("vi-VN"); }
  function minutesOf(text, fallback) {
    const match = String(text ?? "").match(/^(\d{1,2}):(\d{2})/);
    if (!match) return fallback;
    const value = Number(match[1]) * 60 + Number(match[2]);
    return value >= 0 && value < 1440 ? value : fallback;
  }
  // Giờ VN (Asia/Ho_Chi_Minh, UTC+7, không đổi giờ mùa hè) tính bằng phút trong ngày.
  function vnMinutes(now) { return Math.floor((((now + VN_OFFSET_MS) % 86400000) + 86400000) % 86400000 / 60000); }
  function intervalOf(minutes) { const value = Number(minutes); return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), 15), 180) : 30; }
  function vnClock(iso) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const minute = vnMinutes(at);
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  }
  function inStorageWindow(now) { const minute = vnMinutes(now); return minute >= STORAGE_WINDOW.start && minute < STORAGE_WINDOW.end; }
  // Số phút trong khung tự động Rủi ro lưu trữ giữa hai mốc (đêm không chạy thì không tính là ngừng); cùng cách tính với web (PrintSkuAutoStale).
  function storageWorkMinutes(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
    if (to - from > 14 * 86400000) return Infinity;
    let minutes = 0;
    for (let t = from; t < to; t += 15 * 60000) if (inStorageWindow(t)) minutes += 15;
    return minutes;
  }
  function inFullWindow(now, fullWindow) {
    const start = minutesOf(fullWindow?.start, 0), end = minutesOf(fullWindow?.end, 300), minute = vnMinutes(now);
    if (start === end) return false;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }
  // 0.10.10: so bản Extension cùng nghĩa với Edge (khối "cổng bản Extension" của sku-sync / group-uid-sync; bảng ca chung trong
  // tests/sku_sync_function.mjs): chỉ chuỗi x.y.z (mỗi đoạn 1–3 chữ số, không khoảng trắng) là bản; so theo từng đoạn số (0.10.10 > 0.10.9).
  const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
  function extVersionOf(value) { return typeof value === "string" && VERSION_RE.test(value) ? value : null; }
  // true = bản `version` thấp hơn mức `min`. Mức rỗng / sai dạng = không có mức → false; bản chưa khai báo / sai dạng → thấp hơn mọi mức.
  function versionLess(version, min) {
    const need = extVersionOf(min);
    if (!need) return false;
    const have = extVersionOf(version);
    if (!have) return true;
    const a = have.split(".").map(Number), b = need.split(".").map(Number);
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index];
    return false;
  }
  // Mức tối thiểu trong câu 409 EXTENSION_OUTDATED của Edge ("…, cần ≥ 0.10.10; …"); không đọc được → null.
  function parseMinFromMessage(message) {
    const match = String(message ?? "").match(/≥\s*(\d{1,3}\.\d{1,3}\.\d{1,3})(?!\d)/);
    return match ? match[1] : null;
  }
  function shownVersion(version) { return extVersionOf(version) ? `v${version}` : "chưa rõ bản"; }

  // Hàm thuần: quyết định việc cần chạy ở lượt alarm này. Trả {jobs:[{kind,mode}], skipped:[{kind,reason,log}], reason}.
  // last[kind] = {at, status, fullAt, autoFullAt, fullHeldAt}: at = lần chạy thật gần nhất; fullAt = lượt toàn bộ hoàn tất gần nhất (Edge history);
  // autoFullAt = lượt toàn bộ tự động gần nhất đã hoàn tất hoặc bị giữ, của BẤT KỲ máy nào (Edge history lastAutoFullAt) — không đọc lại
  // toàn bộ trong 20 giờ để khỏi dồn WMS/Inside; fullHeldAt chỉ để hiển thị trên trang Tùy chọn.
  // 0.10.10: version = bản của máy này; loại có mức config.minExtension[kind] mà bản thấp hơn → skipped kèm outdated {min, version}, không có
  // việc (không thuê khoá, không đọc tab). version không truyền → không xét.
  function decide({ now = Date.now(), config, last, hasWms, hasInside, enabledLocal, signedIn, device, kinds = BASE_KINDS, version } = {}) {
    const stop = reason => ({ jobs: [], skipped: [], reason });
    if (!signedIn) return stop("Chưa đăng nhập Admin trong Extension");
    if (device !== undefined && !clean(device, 60)) return stop("Chưa đặt tên máy");
    if (enabledLocal === false) return stop("Máy này đã tắt tự động");
    if (!config) return stop("Chưa đọc được cấu hình đồng bộ tự động");
    if (config.enabled === false) return stop("Admin tạm dừng");
    const intervalMs = intervalOf(config.intervalMinutes) * 60000;
    const windowOpen = inFullWindow(now, config.fullWindow);
    const jobs = [], skipped = [];
    for (const kind of kinds) {
      // Dưới mức tối thiểu xét trước khung giờ / tab: cảnh báo không tắt bật theo giờ hay theo tab.
      const min = version === undefined ? null : extVersionOf(config.minExtension?.[kind]);
      if (min && versionLess(version, min)) {
        skipped.push({ kind, reason: `Cần Extension ≥ ${min} (đang ${shownVersion(version)}): Reload Extension rồi tải lại tab`, log: true, outdated: { min, version } });
        continue;
      }
      // Rủi ro lưu trữ ngoài khung 07:00–19:30: không chạy, không ghi nhật ký.
      if (kind === "storage_risk" && !inStorageWindow(now)) continue;
      const hasTab = NEEDS_WMS.has(kind) ? hasWms : hasInside;
      if (!hasTab) { skipped.push({ kind, reason: `Không có tab ${TAB_NAME[kind]}`, log: true }); continue; }
      const info = last?.[kind] || {};
      const fullAt = Date.parse(info.fullAt), autoFullAt = Date.parse(info.autoFullAt), lastAt = Date.parse(info.at);
      if (kind === "cut_adj" || kind === "storage_risk") {
        const every = kind === "storage_risk" ? STORAGE_EVERY_MS : intervalMs;
        if (lastAt && now - lastAt < every - INTERVAL_SLACK_MS) { skipped.push({ kind, reason: "Chưa tới lượt", log: false }); continue; }
        jobs.push({ kind, mode: "incremental" });
        continue;
      }
      const fullDue = windowOpen && !(fullAt && now - fullAt <= FULL_STALE_MS) && !(autoFullAt && now - autoFullAt <= FULL_STALE_MS);
      if (fullDue) { jobs.push({ kind, mode: "full" }); continue; }
      if (lastAt && now - lastAt < intervalMs - INTERVAL_SLACK_MS) { skipped.push({ kind, reason: "Chưa tới lượt", log: false }); continue; }
      jobs.push({ kind, mode: "incremental" });
    }
    return { jobs, skipped, reason: jobs.length ? "" : [...new Set(skipped.map(item => item.reason))].join("; ") };
  }

  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
  }
  function edgeError(code, message) { const error = new Error(message); error.code = code; return error; }
  // Lỗi do tab (không có tab, hết phiên WMS/Inside, cầu nối chưa nạp) → bỏ qua (ghi nhật ký "Bỏ qua", quá ngưỡng thì cảnh báo ngừng).
  // Chỉ xét lỗi phát sinh khi gửi lệnh tới tab (fromTab); tab phản hồi quá lâu vẫn là lỗi.
  // 0.10.7 (soát 22/10, G6): xét theo mã + reason do cầu nối gửi ("session" = hết phiên / chưa đăng nhập), không theo câu chữ —
  // trước đây lỗi mạng "…hãy tải lại tab WMS…" và 403 mất quyền "Phiên WMS không còn quyền…" bị tính là bỏ qua.
  function tabUnavailable(error) {
    if (!error?.fromTab || error.code === "TAB_TIMEOUT") return false;
    return /_TAB_MISSING$|_BRIDGE_ERROR$/.test(String(error.code || "")) || error.reason === "session";
  }
  // Danh sách lý do cảnh báo (rỗng = ổn). Máy tắt tự động hoặc Admin tạm dừng là chủ ý → không cảnh báo.
  // 0.10.10: health.kinds[kind].outdated ghi khi đúng bản `version` này dưới mức tối thiểu → báo ngay (không chờ 2 nhịp), thay câu "ngừng"
  // của loại đó. Dấu ghi khi máy còn bản khác (vừa Reload): loại đó bị chặn chủ ý tới lúc này, không phải ngừng → không báo gì cho tới
  // tick kế (vòng dọn đầu tick bỏ dấu). version không truyền → không xét dấu.
  function assessHealth({ now = Date.now(), signedIn, device, enabledLocal, paused, intervalMinutes, health, kinds = BASE_KINDS, version } = {}) {
    if (!signedIn) return ["Chưa đăng nhập Admin trong Extension"];
    if (!clean(device, 60)) return ["Chưa đặt tên máy"];
    if (enabledLocal === false || paused === true) return [];
    const limit = 2 * intervalOf(intervalMinutes) * 60000 + STALE_SLACK_MS;
    const since = Date.parse(health?.since || "");
    const problems = [];
    for (const kind of kinds) {
      const info = health?.kinds?.[kind] || {};
      const outdated = version !== undefined && info.outdated && typeof info.outdated === "object" ? info.outdated : null;
      if (outdated) {
        if (outdated.version !== version) continue;
        const min = extVersionOf(outdated.min);
        problems.push(`${LABEL[kind]}: cần Extension ${min ? `≥ ${min}` : "mới hơn"} (đang ${shownVersion(version)}); Reload Extension`);
        continue;
      }
      const alive = Date.parse(info.aliveAt || "") || since;
      if (!Number.isFinite(alive)) continue;
      if (kind === "storage_risk" ? storageWorkMinutes(alive, now) <= STORAGE_STALE_WORK_MINUTES : now - alive <= limit) continue;
      const hours = (now - alive) / 3600000;
      const age = hours < 1 ? `${Math.round(hours * 60)} phút` : `${Math.round(hours * 10) / 10} giờ`.replace(".", ",");
      problems.push(`${LABEL[kind]} ngừng ${age}${info.reason ? `: ${clean(info.reason, 120)}` : ""}`);
    }
    return problems;
  }

  function createAutoSync(deps = {}) {
    const storage = deps.storage || {
      get: async key => (await chrome.storage.local.get(key))[key],
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
    };
    const session = deps.session || root.SupabaseSession;
    const config = () => deps.config || (typeof SUPABASE_CONFIG !== "undefined" ? SUPABASE_CONFIG : null);
    const fetchImpl = (...args) => (deps.fetch ? deps.fetch(...args) : root.fetch(...args));
    const now = () => (deps.now ? deps.now() : Date.now());
    const snapshotCore = () => deps.snapshotCore || root.GroupUidSnapshotCore;
    const alarms = deps.alarms || (typeof chrome !== "undefined" ? chrome.alarms : null);
    const timers = deps.timers || { set: (fn, ms) => setInterval(fn, ms), clear: id => clearInterval(id) };
    // 0.10.10: bản của máy này = deps.version (test) hoặc manifest, đọc lúc gọi; không đọc được → undefined (không gửi, không xét).
    const extVersion = () => {
      if (deps.version !== undefined) return deps.version;
      try {
        const value = typeof chrome !== "undefined" ? chrome.runtime?.getManifest?.()?.version : undefined;
        return typeof value === "string" ? value : undefined;
      } catch { return undefined; }
    };
    let running = null;
    let guard = null;
    // 0.10.7 (G4): tab WMS/Inside chọn một lần đầu lượt và dùng cho cả lượt (trước đây chọn lại mỗi trang → mở thêm tab giữa lượt là hỏng lượt).
    let pinned = {};
    // 0.10.7 (G2): dọn lượt dở khi service worker khởi động lại; tick/runNow chờ xong mới chạy.
    let startup = null;
    const badge = deps.badge || (typeof chrome !== "undefined" && chrome.action ? problems => {
      try {
        chrome.action.setBadgeText({ text: problems.length ? "!" : "" });
        chrome.action.setBadgeBackgroundColor({ color: "#d4483f" });
        chrome.action.setTitle({ title: problems.length ? `Đồng bộ tự động ngừng\n${problems.join("\n")}` : chrome.runtime.getManifest().name });
      } catch { /* không có icon thì thôi */ }
    } : null);

    // 0.10.10: mọi lệnh Edge (lease, release, prepare, ingest, preview, apply, cancel, history, auto-config) gửi extVersion = bản của máy
    // để Edge ghi nhận máy và chặn bản dưới mức tối thiểu (409 EXTENSION_OUTDATED); không đọc được bản thì bỏ khoá (Edge coi chưa khai báo).
    async function edge(kind, action, payload = {}, retried = false) {
      const target = config();
      if (!target?.url || !target?.key) throw edgeError("NO_CONFIG", "Extension thiếu cấu hình Supabase");
      const token = await session.getAccessToken({ force: retried });
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), deps.edgeTimeoutMs ?? (EDGE_TIMEOUT_MS[action] || EDGE_DEFAULT_TIMEOUT_MS)) : null;
      const version = extVersion();
      let response, result;
      try {
        try {
          response = await fetchImpl(`${target.url.replace(/\/$/, "")}/functions/v1/${FN[kind]}`, {
            method: "POST", headers: { apikey: target.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ action, ...payload, ...(typeof version === "string" && version ? { extVersion: version } : {}) }),
            ...(controller ? { signal: controller.signal } : {}),
          });
        } catch {
          if (controller?.signal.aborted) throw edgeError("EDGE_TIMEOUT", `Supabase phản hồi quá lâu (${action})`);
          throw edgeError("NETWORK", "Không kết nối được Supabase");
        }
        result = await response.json().catch(() => ({}));
        if (controller?.signal.aborted) throw edgeError("EDGE_TIMEOUT", `Supabase phản hồi quá lâu (${action})`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      // 401 = token bị từ chối dù chưa tới hạn theo đồng hồ máy: gia hạn một lần rồi gọi lại (xác thực chạy trước mọi thao tác nên gọi lại an toàn).
      if (response.status === 401 && !retried) return edge(kind, action, payload, true);
      if (!response.ok || !result?.ok) throw edgeError(result?.error?.code || "EDGE_ERROR", clean(result?.error?.message, 300) || `Edge Function trả HTTP ${response.status}`);
      return result.data;
    }

    // RPC Admin qua PostgREST bằng phiên Admin của Extension (cùng hàm web gọi: wms_group_uid_cut_import, sku_count_save_*, uid_temp_save…).
    // Trả nguyên JSON của RPC; HTTP lỗi → ném lỗi kèm câu của PostgREST. 401 → gia hạn phiên một lần rồi gọi lại.
    // onServerTime(epochMs) (0.10.8, D8): giờ server của phản hồi — meta.updatedAt của hàm Admin (now() trong SQL), thiếu thì header Date.
    async function rpc(name, args = {}, retried = false, onServerTime = null) {
      const target = config();
      if (!target?.url || !target?.key) throw edgeError("NO_CONFIG", "Extension thiếu cấu hình Supabase");
      if (!/^[a-z0-9_]{1,63}$/.test(String(name))) throw edgeError("RPC_ERROR", "Tên hàm Supabase không hợp lệ");
      const token = await session.getAccessToken({ force: retried });
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), deps.edgeTimeoutMs ?? RPC_TIMEOUT_MS) : null;
      let response, data;
      try {
        try {
          response = await fetchImpl(`${target.url.replace(/\/$/, "")}/rest/v1/rpc/${name}`, {
            method: "POST", headers: { apikey: target.key, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(args),
            ...(controller ? { signal: controller.signal } : {}),
          });
        } catch {
          if (controller?.signal.aborted) throw edgeError("EDGE_TIMEOUT", `Supabase phản hồi quá lâu (${name})`);
          throw edgeError("NETWORK", "Không kết nối được Supabase");
        }
        data = await response.json().catch(() => null);
        if (controller?.signal.aborted) throw edgeError("EDGE_TIMEOUT", `Supabase phản hồi quá lâu (${name})`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (response.status === 401 && !retried) return rpc(name, args, true, onServerTime);
      if (typeof onServerTime === "function" && response.ok) {
        let header = "";
        try { header = response.headers?.get?.("date") || ""; } catch { /* không có header Date */ }
        const metaAt = Date.parse(data?.meta?.updatedAt ?? ""), at = Number.isFinite(metaAt) ? metaAt : Date.parse(header);
        if (Number.isFinite(at)) onServerTime(at);
      }
      if (!response.ok || data === null) throw edgeError("RPC_ERROR", clean(data?.message || data?.error?.message, 300) || `Supabase HTTP ${response.status}`);
      // Hàm Admin trả {ok, data | error} (như adminRpc của web): ok:false → ném câu lỗi của hàm; ok:true → trả data.
      if (data && typeof data === "object" && !Array.isArray(data) && "ok" in data) {
        if (!data.ok) throw edgeError(data.error?.code || "RPC_ERROR", clean(data.error?.message, 300) || `Supabase từ chối (${name})`);
        return data.data;
      }
      return data;
    }

    const cores = { cut_adj: () => deps.cutAdjCore || root.CutAdjCore, storage_risk: () => deps.storageRiskCore || root.StorageRiskCore };
    // Loại đang bật: 2 loại gốc luôn có; loại mới chỉ khi lõi đọc đã nạp (Extension đủ tệp).
    const activeKinds = () => KINDS.filter(kind => BASE_KINDS.includes(kind) || typeof cores[kind]?.()?.run === "function");

    async function readState() {
      const [current, device, enabled, last, log] = await Promise.all([
        session.getSession(), storage.get(KEYS.device), storage.get(KEYS.enabled), storage.get(KEYS.last), storage.get(KEYS.log),
      ]);
      return { session: current, device: clean(device, 60), enabled: enabled !== false, last: last && typeof last === "object" ? last : {}, log: Array.isArray(log) ? log : [] };
    }

    // Nhật ký mới nhất đầu mảng, tối đa 50. Dòng "bỏ qua"/lỗi trùng một trong 4 dòng gần nhất (cùng loại, cùng câu) được đưa lên đầu,
    // cập nhật giờ + số lần, để thiếu tab mỗi 30 phút không làm đầy nhật ký.
    async function addLog(entry) {
      const stored = await storage.get(KEYS.log);
      const log = Array.isArray(stored) ? stored : [];
      const item = { at: new Date(now()).toISOString(), kind: entry.kind || null, mode: entry.mode || null, status: entry.status, message: clean(entry.message, 300), runId: entry.runId || null };
      if (["skipped", "error"].includes(item.status)) {
        const index = log.slice(0, 4).findIndex(row => row && row.status === item.status && row.kind === item.kind && row.message === item.message);
        if (index >= 0) {
          const [same] = log.splice(index, 1);
          const merged = { ...same, at: item.at, repeat: Number(same.repeat || 1) + 1 };
          await storage.set(KEYS.log, [merged, ...log]);
          return merged;
        }
      }
      await storage.set(KEYS.log, [item, ...log].slice(0, LOG_LIMIT));
      return item;
    }

    async function setLast(kind, patch) {
      const last = (await storage.get(KEYS.last)) || {};
      last[kind] = { ...(last[kind] || {}), ...patch };
      await storage.set(KEYS.last, last);
    }

    async function keepAlive(on) {
      if (!alarms) return;
      try {
        if (on) await alarms.create(KEEPALIVE, { periodInMinutes: 0.5 });
        else await alarms.clear(KEEPALIVE);
      } catch { /* chỉ để giữ service worker thức */ }
    }

    async function sendTab(kind, type, payload, timeoutMs) {
      try { return await sendTabRaw(kind, type, payload, timeoutMs); }
      catch (error) { error.fromTab = true; throw error; }
    }
    async function sendTabRaw(kind, type, payload, timeoutMs) {
      const side = kind === "sku" ? "inside" : "wms";
      let tab = pinned[side];
      if (!tab) {
        tab = side === "wms" ? await deps.findWmsTab() : await deps.findInsideTab();
        if (tab) { pinned[side] = tab; try { await deps.protectTab?.(tab); } catch { /* chỉ để Chrome không cho tab ngủ */ } }
      }
      if (!tab) throw edgeError(side === "wms" ? "WMS_TAB_MISSING" : "INSIDE_TAB_MISSING", `Không có tab ${TAB_NAME[kind]}`);
      let result;
      try {
        const send = side === "wms" ? deps.sendToWms : deps.sendToInside;
        result = await withTimeout(send(tab, { type, payload }), timeoutMs, `Tab ${TAB_NAME[kind]} phản hồi quá lâu`);
      } catch (error) {
        if (/quá lâu/.test(error?.message || "")) throw edgeError("TAB_TIMEOUT", error.message);
        const cause = clean(error?.message, 100);
        throw edgeError(side === "wms" ? "WMS_BRIDGE_ERROR" : "INSIDE_BRIDGE_ERROR", `Tab ${TAB_NAME[kind]} chưa sẵn sàng; hãy tải lại tab${cause ? ` (${cause})` : ""}`);
      }
      if (!result || typeof result !== "object") throw edgeError("TAB_ERROR", `Tab ${TAB_NAME[kind]} không trả dữ liệu`);
      if (!result.ok) {
        const error = edgeError(result.error?.code || "TAB_ERROR", clean(result.error?.message, 300) || `Tab ${TAB_NAME[kind]} không trả dữ liệu`);
        if (result.error?.reason) error.reason = String(result.error.reason);
        throw error;
      }
      if (!result.data || typeof result.data !== "object") throw edgeError("TAB_ERROR", `Tab ${TAB_NAME[kind]} trả dữ liệu không hợp lệ`);
      return result.data;
    }

    // Hai máy đặt trùng tên vẫn phải là hai người thuê khác nhau: holder = tên máy + "#" + mã ngẫu nhiên sinh một lần cho máy này.
    async function holderOf(device) {
      let id = await storage.get("auto.instance");
      if (!id) { id = Math.random().toString(36).slice(2, 8); await storage.set("auto.instance", id); }
      return `${device}#${id}`;
    }
    async function lease(kind, device, cooldownSeconds = 0) {
      const payload = { kind, holder: await holderOf(device) };
      if (cooldownSeconds > 0) payload.cooldownSeconds = cooldownSeconds;
      const data = await edge(kind, "lease", payload);
      if (data && data.ok === true) return null;
      if (data?.reason === "COOLDOWN") { const at = vnClock(data.lastFinishedAt); return at ? `Máy khác vừa đồng bộ lúc ${at}` : "Máy khác vừa đồng bộ"; }
      return `Máy ${clean(String(data?.holder || "").replace(/#[a-z0-9]+$/, ""), 60) || "khác"} đang chạy`;
    }
    async function releaseLease(kind, device, finished = false) {
      const payload = { kind, holder: await holderOf(device) };
      if (finished) payload.finished = true;
      await edge(kind, "release", payload).catch(() => {});
    }
    // 0.10.10: Edge từ chối bản Extension (409 EXTENSION_OUTDATED; máy lệch giữa lúc đọc cấu hình và lúc thuê / xem trước) → bỏ qua kèm
    // outdated (cảnh báo ngay trên icon + Tùy chọn), không phải lỗi chung. Lỗi khác → null.
    function outdatedOutcome(error, runId = null) {
      if (error?.code !== "EXTENSION_OUTDATED") return null;
      const version = extVersion();
      return { status: "skipped", runId, message: clean(error.message, 300) || "Extension quá cũ; Reload Extension", outdated: { min: parseMinFromMessage(error.message), version: typeof version === "string" ? version : null } };
    }
    // Thuê khoá đầu lượt: null = đã giành khoá; ngược lại kết quả "bỏ qua" (máy khác đang giữ / vừa chạy, hoặc bản dưới mức tối thiểu).
    // Chưa giành khoá nên không nhả. Edge trả lời được (giành được hoặc máy khác đang giữ / vừa chạy) = máy đã qua cổng bản → bỏ dấu
    // dưới mức ngay (giữ lý do), không đợi lượt kết thúc.
    async function firstLease(kind, device, cooldownSeconds) {
      let busy;
      try { busy = await lease(kind, device, cooldownSeconds); }
      catch (error) {
        const outdated = outdatedOutcome(error);
        if (outdated) return outdated;
        throw error;
      }
      // Lỗi ghi storage ở đây không được làm rơi khoá vừa giành (chưa có guard / finally nhả khoá).
      try { if ((await storage.get(KEYS.health))?.kinds?.[kind]?.outdated) await noteHealth(kind, { outdated: null }); } catch { /* chỉ là dấu cảnh báo */ }
      return busy ? { status: "skipped", message: busy, covered: true } : null;
    }

    // Giữ khoá thuê suốt lượt. lost = câu lý do khi đã mất khoá (máy khác giành được hoặc không gia hạn được quá lâu);
    // error = lỗi 409 EXTENSION_OUTDATED khi gia hạn (0.10.10), ném lại nguyên lỗi này để lượt kết thúc là "bỏ qua kèm outdated".
    function startGuard(kind, device) {
      const g = { kind, device, lost: "", error: null, lastOkAt: now(), pending: null, timer: null };
      g.timer = timers.set(() => { renewLease(g).catch(() => {}); }, LEASE_RENEW_EVERY_MS);
      guard = g;
      return g;
    }
    function stopGuard(g) {
      if (g?.timer) timers.clear(g.timer);
      if (guard === g) guard = null;
    }
    async function renewLease(g, force = false) {
      if (!g) return true;
      if (g.lost) return false;
      if (!force && now() - g.lastOkAt < LEASE_RENEW_MIN_GAP_MS) return true;
      if (!g.pending) {
        g.pending = (async () => {
          try {
            const busy = await lease(g.kind, g.device);
            if (busy) { g.lost = `Mất khoá thuê: ${busy}`; return false; }
            g.lastOkAt = now();
            return true;
          } catch (error) {
            // 0.10.10: Edge từ chối bản Extension khi gia hạn (Admin nâng mức giữa lượt) → dừng lượt ngay, không chịu 14 phút như lỗi mạng.
            if (error?.code === "EXTENSION_OUTDATED") { g.lost = clean(error.message, 300); g.error = error; return false; }
            if (now() - g.lastOkAt > LEASE_SAFE_MS) { g.lost = "Mất khoá thuê: không gia hạn được"; return false; }
            return true;
          } finally {
            g.pending = null;
          }
        })();
      }
      return g.pending;
    }
    function checkLease(g) { if (g.lost) throw g.error || edgeError("LEASE_LOST", g.lost); }
    async function confirmLease(g) { if (!(await renewLease(g, true))) throw g.error || edgeError("LEASE_LOST", g.lost); }
    // alarm "auto-keepalive" (30 giây) đánh thức service worker: tiện gia hạn khoá của lượt đang chạy.
    async function onKeepAlive() { return guard ? renewLease(guard) : true; }
    // Nhịp alarm "auto-sync" theo cấu hình Admin (15–180 phút); đổi thì tạo lại alarm.
    async function syncAlarm(minutes) {
      const value = Number(minutes);
      if (!Number.isFinite(value)) return;
      const period = Math.min(Math.max(Math.round(value), 15), 180);
      try { if ((await storage.get(KEYS.interval)) !== period) await storage.set(KEYS.interval, period); } catch { /* lần sau lưu lại */ }
      if (!alarms) return;
      try {
        const current = await alarms.get(AUTO_ALARM);
        if (!current || Number(current.periodInMinutes) !== period) await alarms.create(AUTO_ALARM, { periodInMinutes: period });
      } catch { /* giữ alarm cũ */ }
    }

    // Nhịp sống từng loại cho cảnh báo ngừng: aliveAt = lần gần nhất loại này được đồng bộ (máy này chạy xong, hoặc máy khác đang /
    // vừa chạy); reason = lý do bỏ qua / lỗi gần nhất để hiện trên icon và trang Tùy chọn.
    async function noteHealth(kind, patch) {
      const stored = (await storage.get(KEYS.health)) || {};
      const next = { since: stored.since || new Date(now()).toISOString(), kinds: { ...(stored.kinds || {}) } };
      if (kind) next.kinds[kind] = { ...(next.kinds[kind] || {}), ...patch };
      await storage.set(KEYS.health, next);
    }

    // Bật lại tự động / đăng nhập lại / Admin bỏ tạm dừng: tính "sống" từ lúc này (không báo ngừng ngay vì quãng đã tắt).
    async function resetHealth() { await storage.set(KEYS.health, { since: new Date(now()).toISOString(), kinds: {} }); }
    // Mốc lượt tự động kết thúc gần nhất theo loại của MỌI máy (Edge auto-config lastFinishedAt, review R3): máy thiếu tab vẫn biết
    // máy khác đang đồng bộ, không báo ngừng nhầm.
    async function noteServerAlive(lastFinishedAt) {
      if (!lastFinishedAt || typeof lastFinishedAt !== "object") return;
      const health = (await storage.get(KEYS.health)) || {};
      for (const kind of activeKinds()) {
        const server = Date.parse(lastFinishedAt[kind] || ""), local = Date.parse(health.kinds?.[kind]?.aliveAt || "");
        if (Number.isFinite(server) && server <= now() + 60000 && !(local >= server)) await noteHealth(kind, { aliveAt: new Date(server).toISOString() });
      }
    }

    // startedAt: giờ bắt đầu lượt → last.at (decide so nhịp với mốc này; lượt dài không đẩy lượt kế sang nhịp sau).
    // 0.10.10: outcome.outdated (409 EXTENSION_OUTDATED) → ghi dấu dưới mức cho cảnh báo ngay; bỏ qua / lỗi khác → bỏ dấu (vd. Chạy ngay
    // sau khi Admin hạ mức mà tab lỗi). Hoàn tất / giữ lại / máy khác đang lo đều đã qua lease nên firstLease đã bỏ dấu.
    async function finish(kind, mode, outcome, startedAt = null) {
      const at = new Date(now()).toISOString();
      await addLog({ kind, mode, ...outcome });
      if (["ok", "held"].includes(outcome.status) || outcome.covered) await noteHealth(kind, { aliveAt: at, reason: outcome.covered ? clean(outcome.message, 120) : "" });
      else await noteHealth(kind, { reason: clean(outcome.message, 120), outdated: outcome.outdated ? { ...outcome.outdated, at } : null });
      if (outcome.status === "skipped") return outcome;
      const patch = { at: startedAt || at, status: outcome.status, runId: outcome.runId || null, message: clean(outcome.message, 300), mode };
      if (mode === "full" && outcome.status === "ok") patch.fullAt = at;
      if (mode === "full" && outcome.status === "held") patch.fullHeldAt = at;
      // Bản sao cục bộ của mốc server (history lastAutoFullAt) cho tới lần đọc history kế tiếp.
      if (mode === "full" && ["ok", "held"].includes(outcome.status)) patch.autoFullAt = at;
      await setLast(kind, patch);
      return outcome;
    }

    async function runGroupUid(mode, device, cooldownSeconds = 0) {
      // Thử 1 trang nhỏ trước khi thuê khoá / tạo lượt: tab WMS đăng xuất thì bỏ qua lặng lẽ.
      try { await sendTab("group_uid", "GET_GROUP_UID_PAGE", { page: 1, size: 1 }, WMS_PAGE_TIMEOUT_MS); }
      catch (error) {
        if (tabUnavailable(error)) return { status: "skipped", message: error.message };
        throw error;
      }
      const skip = await firstLease("group_uid", device, cooldownSeconds);
      if (skip) return skip;
      const g = startGuard("group_uid", device), holder = await holderOf(device);
      let prepared = null, previewed = false, finished = false;
      try {
        try { prepared = await edge("group_uid", "prepare", { mode, source: "auto", device }); }
        catch (error) {
          if (error.code === "ACTIVE_RUN") return { status: "skipped", message: "Đang có lượt khác (Admin đang xem trước)", covered: true };
          if (error.code === "FULL_REQUIRED") return { status: "skipped", message: "Cần đối chiếu toàn bộ lần đầu" };
          throw error; // 409 EXTENSION_OUTDATED ở prepare: khối catch ngoài trả "bỏ qua kèm outdated" (chưa có lượt nên không hủy)
        }
        await markActive({ runId: prepared.runId });
        const snapshot = await snapshotCore().readGroupUidSnapshot({
          full: !prepared.rangeFrom, rangeFrom: prepared.rangeFrom, rangeTo: prepared.rangeTo,
          readPage: params => { checkLease(g); return sendTab("group_uid", "GET_GROUP_UID_PAGE", params, WMS_PAGE_TIMEOUT_MS); },
        });
        await confirmLease(g);
        const stagePages = Math.max(1, Math.ceil(snapshot.rows.length / 500));
        for (let page = 1; page <= stagePages; page += 1) {
          checkLease(g);
          await edge("group_uid", "ingest", { runId: prepared.runId, page, totalPages: stagePages, total: snapshot.total, rows: snapshot.rows.slice((page - 1) * 500, page * 500) });
        }
        checkLease(g);
        const report = await edge("group_uid", "preview", { runId: prepared.runId, holder });
        previewed = true;
        checkLease(g);
        const result = await edge("group_uid", "apply", { runId: prepared.runId, auto: true, holder });
        finished = true;
        if (result?.held) return { status: "held", runId: prepared.runId, message: result.held.reason };
        const c = report?.changeCounts || {};
        return { status: "ok", runId: prepared.runId, message: `Đã cập nhật ${num(Number(c.added || 0) + Number(c.updated || 0))} UID · ${num(snapshot.total)} UID đã đọc` };
      } catch (error) {
        // Mất khoá hoặc Edge từ chối bản khi gia hạn (0.10.10: checkLease / confirmLease ném lại lỗi 409): hủy cả khi đã xem trước, để
        // lượt này không chặn máy đang giữ khoá (ACTIVE_RUN) / máy đủ bản.
        const lost = error.code === "LEASE_LOST", outdated = error.code === "EXTENSION_OUTDATED";
        if (prepared?.runId && (!previewed || lost || outdated)) {
          const message = lost ? "Mất khoá thuê" : outdated ? clean(`Extension dưới mức tối thiểu: ${error.message}`, 500) : clean(`Tự động: ${error.message}`, 500);
          await edge("group_uid", "cancel", { runId: prepared.runId, message }).catch(() => {});
        }
        const skip = outdatedOutcome(error, prepared?.runId || null);
        if (skip) return skip;
        if (tabUnavailable(error) && !previewed) return { status: "skipped", runId: prepared?.runId, message: error.message };
        return { status: "error", runId: prepared?.runId || null, message: error.message || "Không đồng bộ được Group UID" };
      } finally {
        stopGuard(g);
        await releaseLease("group_uid", device, finished);
      }
    }

    async function runSku(mode, device, cooldownSeconds = 0) {
      const skip = await firstLease("sku", device, cooldownSeconds);
      if (skip) return skip;
      const g = startGuard("sku", device), holder = await holderOf(device);
      let runId = null, finished = false;
      try {
        const full = mode === "full";
        let payload = { full: true };
        if (!full) {
          // Như index.html: mốc = lúc đọc nguồn của lượt hoàn tất gần nhất lùi 1 ngày; chưa có thì 7 ngày.
          const history = await edge("sku", "history", { limit: 1 });
          const from = Date.parse(history?.lastSnapshotAt || history?.lastSuccessAt || "");
          payload = { cutoff: new Date(Number.isFinite(from) ? from - 86400000 : now() - 7 * 86400000).toISOString() };
        }
        let snapshot;
        try { snapshot = await sendTab("sku", "GET_SKU_SYNC_DATA", payload, INSIDE_TIMEOUT_MS[full ? "full" : "incremental"]); }
        catch (error) {
          if (tabUnavailable(error)) return { status: "skipped", message: error.message };
          throw error;
        }
        if (!Array.isArray(snapshot.normalRows) || !Array.isArray(snapshot.comboRows)) throw new Error("Inside trả dữ liệu SKU không hợp lệ");
        await confirmLease(g);
        const preview = await edge("sku", "preview", { snapshot, mode, source: "auto", device, holder });
        runId = preview?.runId || null;
        checkLease(g);
        const result = await edge("sku", "apply", { runId, auto: true, holder });
        finished = true;
        if (result?.held) return { status: "held", runId, message: result.held.reason };
        const c = preview?.changeCounts || {};
        const changes = ["skuAdded", "skuUpdated", "comboAdded", "comboUpdated"].reduce((sum, key) => sum + Number(c[key] || 0), 0);
        return { status: "ok", runId, message: `Đã cập nhật ${num(changes)} thay đổi · ${num(snapshot.normalRows.length)} SKU đã đọc` };
      } catch (error) {
        // preview và gia hạn khoá (confirmLease ném lại lỗi 409) cũng qua cổng bản Extension (mức nâng giữa lượt): bỏ qua kèm outdated.
        return outdatedOutcome(error, runId) || { status: "error", runId, message: error.message || "Không đồng bộ được SKU" };
      } finally {
        stopGuard(g);
        await releaseLease("sku", device, finished);
      }
    }

    // Đối chiếu ADJ / Rủi ro lưu trữ: thuê khoá → lõi đọc WMS qua tab đã ghim rồi ghi bằng RPC Admin (cùng luồng nút trên web) → nhả khoá.
    // Review 26/10/2026: nêu kết quả bước nguồn để không im lặng — Đối chiếu ADJ (vòng 2, cùng đại lượng + cụm chữ với web syncFromWms):
    // "nguồn phiếu: đã gán <adj + it> · còn chưa nguồn <unresolved − đã gán>" (+ phiếu chưa tra được số, danh sách Cut bị cắt); không dùng
    // matched (gồm cả Cut ghép được phiếu mà phiếu chưa tra được số — không được ghi). Rủi ro lưu trữ: số cặp SKU × vị trí ảo đã đọc nguồn /
    // tổng cặp (+ lý do khi thiếu). Lõi cũ không trả → câu cũ.
    function summaryOf(kind, result) {
      if (kind === "cut_adj") {
        const s = result?.source && typeof result.source === "object" ? result.source : null;
        const assigned = s ? (Number(s.adj) || 0) + (Number(s.it) || 0) : 0, left = s ? Math.max(0, (Number(s.unresolved) || 0) - assigned) : 0;
        const source = s ? ` · nguồn phiếu: đã gán ${num(assigned)} · còn chưa nguồn ${num(left)}${Number(s.notFound) > 0 ? ` · ${num(s.notFound)} phiếu chưa tra được số` : ""}${s.truncated === true ? " · danh sách Cut bị cắt" : ""}` : "";
        return `Nạp ${num(result?.cutRows)} dòng Cut: ${num(result?.newRows)} mới, ${num(result?.changedRows)} đổi · ${num(result?.total)} dòng lịch sử đã đọc${source}`;
      }
      const s = result?.skuCount?.sources && typeof result.skuCount.sources === "object" ? result.skuCount.sources : null;
      const reason = s && typeof s.reason === "string" ? s.reason.trim().slice(0, 200) : "";
      const source = s && (Number(s.total) > 0 || reason) ? ` · nguồn ${num(s.done)}/${num(s.total)} cặp${reason ? `: ${reason}` : ""}` : "";
      return `Kiểm kê ${num(result?.skuCount?.rows)} SKU${source} · UID tạm ${num(result?.uidTemp?.rows)} dòng`;
    }
    async function runCore(kind, device, cooldownSeconds = 0) {
      const core = cores[kind]?.();
      if (typeof core?.run !== "function") return { status: "error", message: `Extension thiếu bộ đọc ${LABEL[kind]}; hãy Reload Extension` };
      const skip = await firstLease(kind, device, cooldownSeconds);
      if (skip) return skip;
      const g = startGuard(kind, device);
      let finished = false, serverAt = NaN;
      try {
        const result = await core.run({
          // Thời gian chờ mỗi lệnh như web: lịch sử Cut 90 giây/trang, Kiểm kê / UID tạm 180 giây.
          sendTab: (type, payload) => { checkLease(g); return sendTab(kind, type, payload, kind === "storage_risk" ? 180 * 1000 : WMS_PAGE_TIMEOUT_MS); },
          rpc: async (name, args) => { checkLease(g); return rpc(name, args, false, at => { serverAt = at; }); },
          // 0.10.8 (D8): giờ server của lần RPC gần nhất (Cắt/ADJ gọi wms_cut_coverage đầu lượt) để lõi không ghi mốc phủ theo đồng hồ máy.
          device, now: () => now(), serverNow: () => serverAt,
        });
        await confirmLease(g);
        finished = true;
        return { status: "ok", message: summaryOf(kind, result) };
      } catch (error) {
        // Gia hạn khoá bị 409 (g.error): lõi có thể bọc lỗi (Rủi ro lưu trữ gộp lỗi hai bước) → xét theo khoá đã mất, không theo mã lỗi bọc.
        const skip = outdatedOutcome(g.error || error);
        if (skip) return skip;
        if (tabUnavailable(error)) return { status: "skipped", message: error.message };
        return { status: "error", message: error.message || `Không đồng bộ được ${LABEL[kind]}` };
      } finally {
        stopGuard(g);
        await releaseLease(kind, device, finished);
      }
    }

    // cooldownSeconds > 0 chỉ cho lượt theo lịch (tick); "Chạy ngay" gửi 0.
    // Dấu lượt đang chạy trong storage (G2): service worker bị Chrome tắt giữa lượt thì lần khởi động sau (recover) hủy lượt Group UID
    // dở, nhả khoá thuê, tắt alarm giữ thức và ghi nhật ký — thay vì để lượt mồ côi chặn tới 30 phút.
    async function markActive(patch) {
      const current = await storage.get(KEYS.active);
      if (current && typeof current === "object") await storage.set(KEYS.active, { ...current, ...patch });
    }

    async function runJob(kind, mode, device, cooldownSeconds = 0) {
      // tick / runNow giữ chỗ running suốt các việc; trả lại giá trị trước để lệnh "chạy ngay" không chen vào giữa hai việc.
      const previous = running;
      running = { kind, mode };
      pinned = {};
      await keepAlive(true);
      const startedAt = new Date(now()).toISOString();
      try {
        await storage.set(KEYS.active, { kind, mode, holder: await holderOf(device), startedAt });
        let outcome;
        try {
          outcome = kind === "group_uid" ? await runGroupUid(mode, device, cooldownSeconds)
            : kind === "sku" ? await runSku(mode, device, cooldownSeconds)
              : await runCore(kind, device, cooldownSeconds);
        }
        catch (error) { outcome = { status: "error", message: error.message || "Không đồng bộ được" }; }
        return await finish(kind, mode, outcome, startedAt);
      } finally {
        pinned = {};
        running = previous;
        await storage.set(KEYS.active, null).catch(() => {});
        await keepAlive(false);
      }
    }

    async function recoverNow() {
      await keepAlive(false);
      const active = await storage.get(KEYS.active);
      if (!active || typeof active !== "object" || !FN[active.kind]) return null;
      await storage.set(KEYS.active, null);
      if (active.kind === "group_uid" && active.runId) await edge("group_uid", "cancel", { runId: active.runId, message: "Lượt bị gián đoạn" }).catch(() => {});
      if (active.holder) await edge(active.kind, "release", { kind: active.kind, holder: active.holder }).catch(() => {});
      await finish(active.kind, active.mode, { status: "error", runId: active.runId || null, message: "Lượt bị gián đoạn: Chrome tắt Extension giữa chừng" }, active.startedAt || null);
      return active;
    }
    // background.js gọi một lần ở đầu service worker (worker vừa khởi động chắc chắn không có lượt nào đang chạy).
    function recover() {
      startup = recoverNow().catch(() => null).finally(() => refreshBadge());
      return startup;
    }

    async function healthNow() {
      const [state, paused, interval, health] = await Promise.all([readState(), storage.get(KEYS.paused), storage.get(KEYS.interval), storage.get(KEYS.health)]);
      return assessHealth({ now: now(), signedIn: Boolean(state.session), device: state.device, enabledLocal: state.enabled, paused: paused === true, intervalMinutes: interval, health, kinds: activeKinds(), version: extVersion() });
    }
    async function refreshBadge() {
      try { const problems = await healthNow(); badge?.(problems); return problems; } catch { return []; }
    }

    // Mốc từ Edge: lượt toàn bộ hoàn tất gần nhất (Admin có thể đã chạy tay trên web) và lượt toàn bộ tự động gần nhất
    // (hoàn tất hoặc giữ lại, của mọi máy). Edge cũ chưa trả lastAutoFullAt thì giữ bản sao cục bộ.
    async function refreshFullAt(kind) {
      const data = await edge(kind, "history", { limit: 1 });
      const fullAt = kind === "group_uid" ? data?.state?.last_successful_full_at : data?.lastFullAt;
      const patch = { fullAt: fullAt || null };
      if (data && Object.prototype.hasOwnProperty.call(data, "lastAutoFullAt")) patch.autoFullAt = data.lastAutoFullAt || null;
      await setLast(kind, patch);
    }

    async function tick() {
      if (running) return { ok: false, reason: "Đang chạy" };
      const mine = { kind: null, mode: null };
      running = mine;
      try {
        if (startup) await startup;
        const state = await readState();
        const base = { signedIn: Boolean(state.session), device: state.device, enabledLocal: state.enabled, now: now() };
        const early = decide({ ...base, config: { enabled: true } });
        if (!early.jobs.length && !early.skipped.length) {
          // 0.10.7: ghi lý do dừng (chưa đăng nhập / chưa đặt tên máy / máy tắt) — trước đây im lặng; dòng lặp được gộp.
          await addLog({ status: "skipped", message: early.reason });
          return { ok: true, reason: early.reason };
        }
        await noteHealth(null);
        let autoConfig;
        try { autoConfig = await edge("sku", "auto-config"); }
        catch (error) {
          await addLog({ status: "error", message: `Không đọc được cấu hình: ${error.message}` });
          // 0.10.10: không đọc được mức tối thiểu → bỏ dấu dưới mức cũ (không treo "cần Extension" mãi); lý do là câu lỗi cấu hình.
          for (const kind of activeKinds()) await noteHealth(kind, { reason: clean(`Không đọc được cấu hình: ${error.message}`, 120), outdated: null });
          return { ok: false, reason: error.message };
        }
        await syncAlarm(autoConfig?.intervalMinutes);
        if ((await storage.get(KEYS.paused)) === true && autoConfig?.enabled !== false) await resetHealth();
        await storage.set(KEYS.paused, autoConfig?.enabled === false);
        await noteServerAlive(autoConfig?.lastFinishedAt);
        const hasWms = Boolean(await deps.findWmsTab()), hasInside = Boolean(await deps.findInsideTab());
        if (autoConfig?.enabled !== false && inFullWindow(now(), autoConfig?.fullWindow)) {
          for (const kind of BASE_KINDS) if (kind === "group_uid" ? hasWms : hasInside) await refreshFullAt(kind).catch(() => {});
        }
        const plan = decide({ ...base, config: autoConfig, last: (await storage.get(KEYS.last)) || {}, hasWms, hasInside, kinds: activeKinds(), version: extVersion() });
        if (autoConfig?.enabled === false) await addLog({ status: "skipped", message: plan.reason });
        // 0.10.10: loại không còn dưới mức ở lượt này (Admin hạ mức / máy đã lên bản) → bỏ dấu và lý do cũ của nó trước khi ghi lý do mới / chạy.
        const outdatedNow = new Set(plan.skipped.filter(item => item.outdated).map(item => item.kind));
        const healthBefore = (await storage.get(KEYS.health)) || {};
        for (const kind of activeKinds()) if (!outdatedNow.has(kind) && healthBefore.kinds?.[kind]?.outdated) await noteHealth(kind, { outdated: null, reason: "" });
        const checkedAt = new Date(now()).toISOString();
        for (const item of plan.skipped) {
          if (!item.log) continue;
          await addLog({ kind: item.kind, status: "skipped", message: item.reason });
          await noteHealth(item.kind, item.outdated ? { reason: item.reason, outdated: { ...item.outdated, at: checkedAt } } : { reason: item.reason });
        }
        const results = [];
        // Nhịp − 2 phút (cùng độ lệch với decide): máy khác vừa chạy cùng loại trong chu kỳ này thì server từ chối khoá.
        const cooldownSeconds = Math.max(0, intervalOf(autoConfig?.intervalMinutes) * 60 - COOLDOWN_SLACK_S);
        const storageCooldown = Math.max(0, STORAGE_EVERY_MS / 1000 - COOLDOWN_SLACK_S);
        for (const job of plan.jobs) results.push({ ...job, ...(await runJob(job.kind, job.mode, state.device, job.kind === "storage_risk" ? storageCooldown : cooldownSeconds)) });
        return { ok: true, reason: plan.reason, results };
      } catch (error) {
        // 0.10.7: lỗi bất ngờ của bộ điều phối ghi nhật ký (background.js trước đây nuốt bằng .catch(() => {})).
        await addLog({ status: "error", message: `Lỗi bộ điều phối: ${clean(error?.message, 200) || "không rõ"}` }).catch(() => {});
        return { ok: false, reason: error?.message || "Lỗi bộ điều phối" };
      } finally {
        if (running === mine) running = null;
        await refreshBadge();
      }
    }

    async function runNow(kind, mode) {
      if (!activeKinds().includes(kind) || !["incremental", "full"].includes(mode) || (!BASE_KINDS.includes(kind) && mode !== "incremental")) return { ok: false, error: "Yêu cầu chạy không hợp lệ" };
      if (running) return { ok: false, error: "Đang có lượt tự động chạy" };
      // 0.10.7 (G5): giữ chỗ trước mọi await — trước đây alarm tick chen vào khoảng readState() và hai lượt chạy chồng.
      const mine = { kind: null, mode: null };
      running = mine;
      try {
        if (startup) await startup;
        const state = await readState();
        if (!state.session) return { ok: false, error: "Chưa đăng nhập Admin" };
        if (!state.device) return { ok: false, error: "Chưa đặt tên máy" };
        const result = await runJob(kind, mode, state.device);
        // 0.10.10: Edge từ chối bản Extension (bỏ qua kèm outdated) → trang Tùy chọn hiện câu của Edge như lỗi.
        const failed = result.status === "error" || Boolean(result.outdated);
        return { ok: !failed, result, ...(failed ? { error: result.message } : {}) };
      } finally {
        if (running === mine) running = null;
        await refreshBadge();
      }
    }

    async function tabs() {
      const [wms, inside] = await Promise.all([deps.findWmsTab().catch(() => null), deps.findInsideTab().catch(() => null)]);
      return { wms: Boolean(wms), inside: Boolean(inside) };
    }

    async function status() {
      const state = await readState();
      let autoConfig = null;
      if (state.session) autoConfig = await edge("sku", "auto-config").catch(() => null);
      let nextAlarmAt = null;
      try { nextAlarmAt = (await alarms?.get("auto-sync"))?.scheduledTime || null; } catch { /* không có alarm */ }
      const problems = await refreshBadge();
      const version = extVersion();
      return {
        signedIn: Boolean(state.session), email: state.session?.user?.email || "", device: state.device, enabled: state.enabled,
        last: state.last, log: state.log, tabs: await tabs(), nextAlarmAt, config: autoConfig, running: running?.kind ? { kind: running.kind, mode: running.mode } : null,
        problems, kinds: activeKinds(),
        // 0.10.10: bản của máy + mức tối thiểu theo loại (auto-config) cho trang Tùy chọn; thẻ đỏ đã nằm trong problems.
        version: typeof version === "string" ? version : null, minExtension: autoConfig?.minExtension ?? null,
      };
    }

    async function signIn(email, password) {
      try {
        await session.signIn(email, password);
      } catch (error) {
        return { ok: false, error: error.message || "Không đăng nhập được" };
      }
      // Edge chỉ nhận Admin: chỉ báo đăng nhập được khi auto-config xác minh xong. Không phải Admin, hoặc chưa kiểm được
      // (lỗi mạng / Edge lỗi) → xoá phiên vừa tạo.
      try { await edge("sku", "auto-config"); }
      catch (error) {
        await session.signOut();
        if (error.code === "FORBIDDEN" || error.code === "AUTH") return { ok: false, error: "Tài khoản không phải Admin" };
        return { ok: false, error: "Không kiểm được vai trò Admin, thử lại" };
      }
      if ((await storage.get(KEYS.enabled)) === undefined) await storage.set(KEYS.enabled, true);
      return { ok: true };
    }

    // Lệnh từ trang Tùy chọn của Extension (background.js đã kiểm người gửi là trang Extension).
    async function handleMessage(message) {
      const type = message?.type;
      try {
        if (type === "AUTO_STATUS") return { ok: true, ...(await status()) };
        if (type === "AUTO_SIGN_IN") { const result = await signIn(message.email, message.password); if (result.ok) await resetHealth(); await refreshBadge(); return result; }
        if (type === "AUTO_SIGN_OUT") { await session.signOut(); await refreshBadge(); return { ok: true }; }
        if (type === "AUTO_SET_DEVICE") {
          const device = clean(message.device, 60);
          if (!device) return { ok: false, error: "Nhập tên máy" };
          await storage.set(KEYS.device, device);
          await refreshBadge();
          return { ok: true };
        }
        if (type === "AUTO_SET_ENABLED") {
          if (typeof message.enabled !== "boolean") return { ok: false, error: "Giá trị bật/tắt không hợp lệ" };
          const before = await storage.get(KEYS.enabled);
          await storage.set(KEYS.enabled, message.enabled);
          if (message.enabled && before === false) await resetHealth();
          await refreshBadge();
          return { ok: true };
        }
        if (type === "AUTO_RUN_NOW") return await runNow(message.kind, message.mode);
        return { ok: false, error: "Yêu cầu không hợp lệ" };
      } catch (error) {
        return { ok: false, error: clean(error?.message, 300) || "Tiện ích gặp lỗi" };
      }
    }

    return { tick, runNow, status, handleMessage, edge, onKeepAlive, recover, refreshBadge, isRunning: () => Boolean(running) };
  }

  const api = { createAutoSync, decide, inFullWindow, vnMinutes, tabUnavailable, assessHealth, storageWorkMinutes, versionLess, parseMinFromMessage, MESSAGE_TYPES: ["AUTO_STATUS", "AUTO_SIGN_IN", "AUTO_SIGN_OUT", "AUTO_SET_DEVICE", "AUTO_SET_ENABLED", "AUTO_RUN_NOW"] };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AutoSyncModule = api;
})(typeof self !== "undefined" ? self : globalThis);
