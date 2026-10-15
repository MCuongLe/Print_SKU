const APP_URL_PATTERN = /^(?:http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/|https:\/\/mcuongle\.github\.io\/Print_SKU(?:\/|$))/i;
const INSIDE_URL_PATTERN = /^https:\/\/inside\.mastige\.vn\//i;
const WMS_URL_PATTERN = /^https:\/\/wms\.inshasaki\.com\//i;
const HCM_URL_PATTERN = /^https:\/\/apps-mastige\.inshasaki\.com\/apps\/hasaki-construction-management(?:[/?#]|$)/i;
const WMS_READ_TYPES = ["GET_GROUP_UID_PAGE", "GET_GROUP_UID_HISTORY_PAGE", "GET_GROUP_UID_MOVES_PAGE", "GET_GROUP_UID_NEW_PAGE", "GET_PACKING_LIST_PAGE", "GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE", "GET_STOCK_IMPORT_EXPORT_PAGE"];

function errorResponse(code, message) {
  return { ok: false, error: { code, message } };
}

async function findInsideTab() {
  const tabs = await chrome.tabs.query({ url: "https://inside.mastige.vn/*" });
  return tabs
    .filter(tab => tab.id && INSIDE_URL_PATTERN.test(tab.url || ""))
    .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
}

async function sendToInside(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["sku-sync-core.js", "inside-bridge.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

async function findWmsTab() {
  const tabs = await chrome.tabs.query({ url: "https://wms.inshasaki.com/*" });
  return tabs.filter(tab => tab.id && WMS_URL_PATTERN.test(tab.url || ""))
    .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
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
  const tabs = await chrome.tabs.query({ url: "https://apps-mastige.inshasaki.com/*" });
  return tabs.filter(tab => tab.id && HCM_URL_PATTERN.test(tab.url || ""))
    .sort((a, b) => Number(b.lastAccessed || 0) - Number(a.lastAccessed || 0))[0] || null;
}

async function sendToHcm(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["hcm-bridge.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    const insideTab = await findInsideTab();
    if (!insideTab) {
      return errorResponse("INSIDE_TAB_MISSING", "Hãy mở một tab Inside và đăng nhập trước");
    }
    try {
      if (message.type === "GET_PO") {
        const poCode = String(message.payload?.poCode || "").trim();
        if (!/^[A-Za-z0-9._/-]{3,50}$/.test(poCode)) return errorResponse("INVALID_PO", "Mã PO không hợp lệ");
        const result = await sendToInside(insideTab, { type: "GET_PO", payload: { poCode } });
        return result?.ok ? result : errorResponse(result?.error?.code || "INSIDE_ERROR", result?.error?.message || "Inside không trả dữ liệu PO");
      }
      const result = await sendToInside(insideTab, { type: "GET_SKU_SYNC_DATA", payload: message.payload || {} });
      return result?.ok ? result : errorResponse(result?.error?.code || "INSIDE_ERROR", result?.error?.message || "Inside không trả dữ liệu SKU");
    } catch {
      return errorResponse("INSIDE_BRIDGE_ERROR", "Không kết nối được tab Inside; hãy tải lại tab Inside rồi thử lại");
    }
  })().then(sendResponse).catch(() => sendResponse(errorResponse("CONNECTOR_ERROR", "Tiện ích gặp lỗi khi đọc dữ liệu Inside")));
  return true;
});
