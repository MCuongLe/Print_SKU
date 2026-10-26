// Đồng bộ tự động (0.10.0): phiên Admin Supabase riêng, đọc ảnh chụp Group UID, bộ điều phối theo alarm.
// Token Admin nằm ở chrome.storage.local: chỉ trang của Extension (service worker, Tùy chọn) được đọc, content script trên
// Print SKU / Inside / WMS / app xây dựng thì không (mặc định Chrome mở cho cả content script). Không content script nào dùng chrome.storage.
try { chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {}); } catch { /* Chrome cũ: giữ mặc định */ }
// 0.10.7: cut-adj-core.js / storage-risk-core.js = lõi đọc Đối chiếu ADJ và Rủi ro lưu trữ (chép luồng nút web) cho đồng bộ tự động.
importScripts("supabase-config.js", "supabase-session.js", "group-uid-snapshot-core.js", "cut-adj-core.js", "storage-risk-core.js", "auto-sync.js");

const APP_URL_PATTERN = /^(?:http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/|https:\/\/mcuongle\.github\.io\/Print_SKU(?:\/|$))/i;
// 0.11.0: hai Inside cùng phần mềm, khác công ty. PO đọc theo site (không nói thì mastige); đồng bộ SKU luôn Inside Mastige.
const INSIDE_SITES = {
  mastige: { query: "https://inside.mastige.vn/*", pattern: /^https:\/\/inside\.mastige\.vn\//i, label: "Inside Mastige" },
  garment: { query: "https://garment.inshasaki.com/*", pattern: /^https:\/\/garment\.inshasaki\.com\//i, label: "Inside Garment" },
};
const WMS_URL_PATTERN = /^https:\/\/wms\.inshasaki\.com\//i;
const HCM_URL_PATTERN = /^https:\/\/apps-mastige\.inshasaki\.com\/apps\/hasaki-construction-management(?:[/?#]|$)/i;
const WMS_READ_TYPES = ["GET_GROUP_UID_PAGE", "GET_GROUP_UID_HISTORY_PAGE", "GET_GROUP_UID_MOVES_PAGE", "GET_GROUP_UID_NEW_PAGE", "GET_PACKING_LIST_PAGE", "GET_PO_GROUP_UID_PAGE", "GET_PO_ASN_PAGE", "GET_INTERNAL_TRANSFER", "GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE", "GET_STOCK_IMPORT_EXPORT_PAGE"];

function errorResponse(code, message) {
  return { ok: false, error: { code, message } };
}

// 0.10.7 (soát 22/10, G4): bỏ tab Chrome đã cho ngủ (discarded — gửi lệnh luôn lỗi), ưu tiên tab đã tải xong, rồi tab dùng gần nhất.
function pickTab(tabs, pattern) {
  return tabs
    .filter(tab => tab.id && !tab.discarded && pattern.test(tab.url || ""))
    .sort((a, b) => Number(b.status === "complete") - Number(a.status === "complete") || Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
}

// Không đối số = Inside Mastige (đồng bộ tự động và đồng bộ SKU gọi như vậy).
async function findInsideTab(site = "mastige") {
  const info = typeof site === "string" && Object.hasOwn(INSIDE_SITES, site) ? INSIDE_SITES[site] : null;
  return info ? pickTab(await chrome.tabs.query({ url: info.query }), info.pattern) : null;
}

// Tab mở trước khi Reload Extension chưa có bridge: bơm lại. Tab Garment chỉ nhận inside-bridge.js (bộ đọc SKU chỉ ở Inside Mastige).
async function sendToInside(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    const files = INSIDE_SITES.garment.pattern.test(tab.url || "") ? ["inside-bridge.js"] : ["sku-sync-core.js", "inside-bridge.js"];
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function findWmsTab() {
  return pickTab(await chrome.tabs.query({ url: "https://wms.inshasaki.com/*" }), WMS_URL_PATTERN);
}

async function sendToWms(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["group-uid-sync-core.js", "inventory-audit-core.js", "wms-bridge.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function findHcmTab() {
  return pickTab(await chrome.tabs.query({ url: "https://apps-mastige.inshasaki.com/*" }), HCM_URL_PATTERN);
}

async function sendToHcm(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["hcm-bridge.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

// Bộ điều phối dùng lại đúng các hàm tìm tab / gửi lệnh ở trên (token WMS/Inside vẫn không rời tab).
// protectTab: tab dùng cho lượt tự động không bị Chrome cho ngủ (Memory Saver); không cần thêm quyền.
const AutoSync = self.AutoSyncModule.createAutoSync({
  findWmsTab, findInsideTab, sendToWms, sendToInside,
  protectTab: tab => chrome.tabs.update(tab.id, { autoDiscardable: false }),
});
// Worker vừa khởi động chắc chắn không có lượt nào đang chạy: dọn lượt dở của lần trước (Chrome tắt worker giữa lượt),
// tắt alarm giữ thức mồ côi, cập nhật dấu "!" trên icon. tick / Chạy ngay chờ bước này xong.
AutoSync.recover();
// Bấm icon Extension (có dấu "!" khi đồng bộ tự động ngừng) → mở trang Tùy chọn.
chrome.action?.onClicked?.addListener(() => { chrome.runtime.openOptionsPage().catch?.(() => {}); });
const AUTO_ALARM = "auto-sync";
const AUTO_MESSAGE_TYPES = ["AUTO_STATUS", "AUTO_SIGN_IN", "AUTO_SIGN_OUT", "AUTO_SET_DEVICE", "AUTO_SET_ENABLED", "AUTO_RUN_NOW"];
// Nhịp đã xác minh từ auto-config gần nhất (auto-sync.js lưu auto.interval); chưa có thì 30 phút, kẹp 15–180.
async function autoPeriod() {
  try {
    const value = Number((await chrome.storage.local.get("auto.interval"))["auto.interval"]);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), 15), 180) : 30;
  } catch { return 30; }
}
function ensureAutoAlarm() {
  chrome.alarms.get(AUTO_ALARM).then(async alarm => {
    if (!alarm) chrome.alarms.create(AUTO_ALARM, { periodInMinutes: await autoPeriod() });
  }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(() => { autoPeriod().then(period => chrome.alarms.create(AUTO_ALARM, { periodInMinutes: period })).catch(() => {}); });
chrome.runtime.onStartup.addListener(ensureAutoAlarm);
ensureAutoAlarm();
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTO_ALARM) AutoSync.tick().catch(() => {});
  // "auto-keepalive": đánh thức service worker trong lúc đang chạy và gia hạn khoá thuê của lượt đó (cách nhau ≥ 2 phút).
  if (alarm.name === "auto-keepalive") AutoSync.onKeepAlive().catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Trang của chính Extension (Tùy chọn): chỉ nhận các lệnh AUTO_*. Xét theo URL người gửi, không theo sender.tab:
  // options_page mở trong một tab nên sender.tab vẫn có; content script trên trang web có sender.url là địa chỉ web.
  if (sender.id === chrome.runtime.id && String(sender.url || "").startsWith(chrome.runtime.getURL(""))) {
    if (!message || !AUTO_MESSAGE_TYPES.includes(message.type)) {
      sendResponse({ ok: false, error: "Yêu cầu không hợp lệ" });
      return false;
    }
    AutoSync.handleMessage(message).then(sendResponse).catch(() => sendResponse({ ok: false, error: "Tiện ích gặp lỗi" }));
    return true;
  }
  const senderUrl = sender.tab?.url || "";
  if (!APP_URL_PATTERN.test(senderUrl)) {
    sendResponse(errorResponse("FORBIDDEN_ORIGIN", "Ứng dụng không nằm trên địa chỉ Print SKU được cho phép"));
    return false;
  }
  if (!message || !["PING", "PING_WMS", "PING_HCM", "GET_PO", "GET_SKU_SYNC_DATA", "GET_HCM_DATA", ...WMS_READ_TYPES].includes(message.type)) {
    sendResponse(errorResponse("INVALID_REQUEST", "Yêu cầu kết nối không hợp lệ"));
    return false;
  }
  if (message.type === "PING") {
    sendResponse({ ok: true, data: { version: chrome.runtime.getManifest().version } });
    return false;
  }

  if (message.type === "PING_WMS") {
    findWmsTab().then(tab => sendResponse(tab
      ? { ok: true, data: { version: chrome.runtime.getManifest().version } }
      : errorResponse("WMS_TAB_MISSING", "Hãy mở một tab WMS và đăng nhập trước")));
    return true;
  }

  if (message.type === "PING_HCM") {
    findHcmTab().then(tab => sendResponse(tab
      ? { ok: true, data: { version: chrome.runtime.getManifest().version } }
      : errorResponse("HCM_TAB_MISSING", "Hãy mở tab app xây dựng và đăng nhập trước")));
    return true;
  }

  if (message.type === "GET_HCM_DATA") {
    (async () => {
      const hcmTab = await findHcmTab();
      if (!hcmTab) return errorResponse("HCM_TAB_MISSING", "Hãy mở tab app xây dựng và đăng nhập trước");
      try {
        const result = await sendToHcm(hcmTab, { type: message.type, payload: message.payload || {} });
        return result?.ok ? result : errorResponse(result?.error?.code || "HCM_ERROR", result?.error?.message || "App xây dựng không trả dữ liệu yêu cầu");
      } catch {
        return errorResponse("HCM_BRIDGE_ERROR", "Không kết nối được tab app xây dựng; hãy tải lại tab app rồi thử lại");
      }
    })().then(sendResponse).catch(() => sendResponse(errorResponse("CONNECTOR_ERROR", "Tiện ích gặp lỗi khi đọc dữ liệu app xây dựng")));
    return true;
  }

  if (WMS_READ_TYPES.includes(message.type)) {
    (async () => {
      const wmsTab = await findWmsTab();
      if (!wmsTab) return errorResponse("WMS_TAB_MISSING", "Hãy mở một tab WMS và đăng nhập trước");
      try {
        const result = await sendToWms(wmsTab, { type: message.type, payload: message.payload || {} });
        return result?.ok ? result : errorResponse(result?.error?.code || "WMS_ERROR", result?.error?.message || "WMS không trả dữ liệu yêu cầu");
      } catch {
        return errorResponse("WMS_BRIDGE_ERROR", "Không kết nối được tab WMS; hãy tải lại tab WMS rồi thử lại");
      }
    })().then(sendResponse).catch(() => sendResponse(errorResponse("CONNECTOR_ERROR", "Tiện ích gặp lỗi khi đọc dữ liệu WMS")));
    return true;
  }

  (async () => {
    // GET_SKU_SYNC_DATA luôn Inside Mastige và chỉ chuyển full / cutoff (bridge chỉ đọc hai khoá này): site và khoá lạ bị bỏ; SKU của Garment không được vào danh mục.
    const site = message.type === "GET_PO" && message.payload?.site !== undefined ? message.payload.site : "mastige";
    if (typeof site !== "string" || !Object.hasOwn(INSIDE_SITES, site)) return errorResponse("INVALID_SITE", "Nguồn PO không hợp lệ");
    const insideTab = await findInsideTab(site);
    if (!insideTab) {
      return errorResponse("INSIDE_TAB_MISSING", `Hãy mở một tab ${INSIDE_SITES[site].label} và đăng nhập trước`);
    }
    try {
      if (message.type === "GET_PO") {
        const poCode = String(message.payload?.poCode || "").trim();
        if (!/^[A-Za-z0-9._/-]{3,50}$/.test(poCode)) return errorResponse("INVALID_PO", "Mã PO không hợp lệ");
        const result = await sendToInside(insideTab, { type: "GET_PO", payload: { poCode, site } });
        return result?.ok ? result : errorResponse(result?.error?.code || "INSIDE_ERROR", result?.error?.message || "Inside không trả dữ liệu PO");
      }
      const syncPayload = {};
      if (message.payload?.full === true) syncPayload.full = true;
      if (message.payload?.cutoff !== undefined) syncPayload.cutoff = message.payload.cutoff;
      const result = await sendToInside(insideTab, { type: "GET_SKU_SYNC_DATA", payload: syncPayload });
      return result?.ok ? result : errorResponse(result?.error?.code || "INSIDE_ERROR", result?.error?.message || "Inside không trả dữ liệu SKU");
    } catch {
      return errorResponse("INSIDE_BRIDGE_ERROR", "Không kết nối được tab Inside; hãy tải lại tab Inside rồi thử lại");
    }
  })().then(sendResponse).catch(() => sendResponse(errorResponse("CONNECTOR_ERROR", "Tiện ích gặp lỗi khi đọc dữ liệu Inside")));
  return true;
});
