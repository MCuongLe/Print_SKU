(() => {
  if (window.__HASAKI_WMS_GROUP_UID_BRIDGE__) return;
  window.__HASAKI_WMS_GROUP_UID_BRIDGE__ = true;

  const core = globalThis.HasakiGroupUidSyncCore;
  const API = "https://wms-gw.inshasaki.com/api/v1/wms/group-uid-infos";

  function auth() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem("auth_store") || "{}"); } catch { /* báo lỗi bên dưới */ }
    const raw = store?.state?.token ?? store?.token;
    const token = (typeof raw === "string" ? raw : raw?.access_token ?? raw?.token)?.replace?.(/^Bearer\s+/i, "");
    let company = localStorage.getItem("company_id") || "";
    try { company = JSON.parse(company); } catch { /* giữ chuỗi gốc */ }
    if (Array.isArray(company)) company = company.map(value => value?.id ?? value?.value ?? value).filter(Boolean).join(",");
    else if (company && typeof company === "object") company = company.id ?? company.value ?? company.company_id ?? "";
    if (!token) throw new Error("Phiên WMS đã hết hạn; hãy đăng nhập lại");
    return { token: String(token), company: String(company || "") };
  }

  async function readPage(payload) {
    if (!core) throw new Error("Extension chưa tải bộ đọc Group UID; hãy Reload extension");
    const page = Math.max(1, Number(payload?.page) || 1);
    const size = Math.min(500, Math.max(1, Number(payload?.size) || 500));
    const url = new URL(API);
    url.searchParams.set("active_tab", "group-list");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    if (payload?.from) url.searchParams.set("from_updated_at", String(new Date(payload.from).getTime()));
    if (payload?.to) url.searchParams.set("to_updated_at", String(new Date(payload.to).getTime()));
    const session = auth();
    const headers = { Accept: "application/json", Authorization: `Bearer ${session.token}` };
    if (session.company) headers["company-ids"] = session.company;
    const response = await fetch(url, { headers, credentials: "omit" });
    if (response.status === 401 || response.status === 403) throw new Error("Phiên WMS không còn quyền đọc Group UID; hãy đăng nhập lại");
    if (!response.ok) throw new Error(`WMS trả mã ${response.status}`);
    const normalized = core.normalizePage(await response.json());
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      generatedAt: new Date().toISOString(),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== "GET_GROUP_UID_PAGE") return false;
    readPage(message.payload || {})
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { code: "GROUP_UID_READ_FAILED", message: core?.clean(error?.message || error, 300) || "Không đọc được Group UID" } }));
    return true;
  });
})();
