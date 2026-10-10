(() => {
  if (window.__HASAKI_INSIDE_APP_BRIDGE__) return;
  window.__HASAKI_INSIDE_APP_BRIDGE__ = true;

  const allowedLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  const allowedGithubPages = location.hostname === "mcuongle.github.io" && /^\/Print_SKU(?:\/|$)/i.test(location.pathname);
  if (!allowedLocal && !allowedGithubPages) return;

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const request = event.data;
    if (!request || request.source !== "PRINT_SKU_APP" || !["PING", "PING_WMS", "GET_PO", "GET_SKU_SYNC_DATA", "GET_GROUP_UID_PAGE", "GET_GROUP_UID_HISTORY_PAGE", "GET_GROUP_UID_MOVES_PAGE", "GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE"].includes(request.type) || !request.requestId) return;

    const reply = fields => window.postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ...fields }, location.origin);
    try {
      chrome.runtime.sendMessage({ type: request.type, payload: request.payload || {} })
        .then(response => reply({ ok: Boolean(response?.ok), data: response?.data, error: response?.error }))
        .catch(() => reply({ ok: false, error: { code: "EXTENSION_UNAVAILABLE", message: "Tiện ích kết nối Inside chưa sẵn sàng" } }));
    } catch {
      // Extension vừa được Reload/cập nhật: cầu nối còn sót trong tab này không còn nối được và sendMessage ném lỗi ngay.
      // Phải trả lời, nếu không trang chỉ biết chờ hết hạn mà không rõ nguyên nhân.
      reply({ ok: false, error: { code: "EXTENSION_RELOADED", message: "Tiện ích vừa được cập nhật; hãy tải lại trang" } });
    }
  });
})();
