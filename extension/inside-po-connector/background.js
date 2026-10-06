const APP_URL_PATTERN = /^(?:http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/|https:\/\/mcuongle\.github\.io\/Print_SKU(?:\/|$))/i;
const INSIDE_URL_PATTERN = /^https:\/\/inside\.mastige\.vn\//i;

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
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["inside-bridge.js"] });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const senderUrl = sender.tab?.url || "";
  if (!APP_URL_PATTERN.test(senderUrl)) {
    sendResponse(errorResponse("FORBIDDEN_ORIGIN", "Ứng dụng không nằm trên địa chỉ Print SKU được cho phép"));
    return false;
  }
  if (!message || !["PING", "GET_PO"].includes(message.type)) {
    sendResponse(errorResponse("INVALID_REQUEST", "Yêu cầu kết nối không hợp lệ"));
    return false;
  }
  if (message.type === "PING") {
    sendResponse({ ok: true, data: { version: chrome.runtime.getManifest().version } });
    return false;
  }

  (async () => {
    const poCode = String(message.payload?.poCode || "").trim();
    if (!/^[A-Za-z0-9._/-]{3,50}$/.test(poCode)) {
      return errorResponse("INVALID_PO", "Mã PO không hợp lệ");
    }
    const insideTab = await findInsideTab();
    if (!insideTab) {
      return errorResponse("INSIDE_TAB_MISSING", "Hãy mở một tab Inside và đăng nhập trước");
    }
    try {
      const result = await sendToInside(insideTab, { type: "GET_PO", payload: { poCode } });
      return result?.ok ? result : errorResponse(result?.error?.code || "INSIDE_ERROR", result?.error?.message || "Inside không trả dữ liệu PO");
    } catch {
      return errorResponse("INSIDE_BRIDGE_ERROR", "Không kết nối được tab Inside; hãy tải lại tab Inside rồi thử lại");
    }
  })().then(sendResponse).catch(() => sendResponse(errorResponse("CONNECTOR_ERROR", "Tiện ích gặp lỗi khi lấy PO")));
  return true;
});
