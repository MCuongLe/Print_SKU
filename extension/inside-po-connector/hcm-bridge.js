(() => {
  if (window.__HASAKI_HCM_BRIDGE__) return;
  window.__HASAKI_HCM_BRIDGE__ = true;

  // Cầu nối CHỈ ĐỌC tới app Hasaki Construction Management. Chạy trong tab app đã đăng nhập: cookie Cloudflare Access đi kèm
  // yêu cầu cùng nguồn, còn Bearer token của app lấy từ localStorage của chính tab đó (không bao giờ trả về trang Print SKU).
  const TOKEN_KEY = "hcm_auth_token";
  const RESOURCES = Object.freeze({ stock: "/api/stock", wmsImports: "/api/wms-imports" });
  const PAGE_SIZE = 1000;
  const MAX_ROWS = 50000;

  const clean = (value, limit = 300) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);

  function appBase() {
    return (location.pathname.match(/^\/apps\/[^/]+/) || [""])[0];
  }

  function bearer() {
    let token = "";
    try { token = localStorage.getItem(TOKEN_KEY) || ""; } catch { /* báo lỗi bên dưới */ }
    if (!token) throw new Error("Chưa đăng nhập app xây dựng; hãy đăng nhập trong tab app rồi thử lại");
    return token;
  }

  async function getJson(path) {
    const headers = { Accept: "application/json", Authorization: `Bearer ${bearer()}` };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetch(`${appBase()}${path}`, { headers, credentials: "same-origin" });
      } catch {
        if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1))); continue; }
        throw new Error("App xây dựng tạm ngắt kết nối; hãy tải lại tab app rồi thử lại");
      }
      if (response.status === 401) throw new Error("Phiên app xây dựng đã hết hạn; hãy đăng nhập lại trong tab app");
      if (response.status === 403) throw new Error("Tài khoản app xây dựng không có quyền đọc dữ liệu này");
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new Error(`App xây dựng trả mã ${response.status}`);
      const body = await response.json().catch(() => null);
      if (!body || body.ok === false) throw new Error(clean(body?.error) || "App xây dựng không trả dữ liệu hợp lệ");
      return body;
    }
    throw new Error("App xây dựng tạm ngắt kết nối; hãy thử lại");
  }

  async function readResource(payload) {
    const name = String(payload?.resource || "");
    const path = Object.prototype.hasOwnProperty.call(RESOURCES, name) ? RESOURCES[name] : "";
    if (!path) throw new Error("Nguồn dữ liệu app xây dựng không hợp lệ");
    const rows = [];
    let total = 0, generatedAt = "", offset = 0;
    for (;;) {
      const body = await getJson(`${path}?limit=${PAGE_SIZE}&offset=${offset}`);
      const part = Array.isArray(body.rows) ? body.rows : [];
      total = Math.max(0, Number(body.totalCount) || 0);
      generatedAt = clean(body.generatedAt, 40) || generatedAt;
      rows.push(...part);
      offset += part.length;
      if (!part.length || offset >= total) break;
      if (rows.length > MAX_ROWS) throw new Error("App xây dựng trả quá nhiều dòng; dừng để tránh đọc thiếu dữ liệu");
    }
    if (rows.length !== total) throw new Error("Dữ liệu app xây dựng thay đổi trong lúc đọc; hãy chạy lại");
    return { resource: name, rows, total, generatedAt: generatedAt || new Date().toISOString() };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "GET_HCM_DATA") return false;
    readResource(message.payload || {})
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { code: "HCM_READ_FAILED", message: clean(error?.message || error) || "Không đọc được dữ liệu app xây dựng" } }));
    return true;
  });
})();
