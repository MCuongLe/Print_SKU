(() => {
  if (window.__HASAKI_WMS_GROUP_UID_BRIDGE__) return;
  window.__HASAKI_WMS_GROUP_UID_BRIDGE__ = true;

  const core = globalThis.HasakiGroupUidSyncCore;
  const auditCore = globalThis.HasakiInventoryAuditCore;
  const API = "https://wms-gw.inshasaki.com/api/v1/wms/group-uid-infos";
  const HISTORY_API = "https://wms-gw.inshasaki.com/api/v1/wms/group-uid-info-histories";
  const WAREHOUSE_API = "https://wms-gw.inshasaki.com/api/v1/wms/master-data/warehouse/by-user";
  const COMPANY_API = "https://wms-gw.inshasaki.com/api/v1/wms/master-data/company";
  const APPROVED_COUNT_API = "https://wms-gw.inshasaki.com/api/v1/wms/counting-plan/checklists/type-sku";
  const INVENTORY_API = "https://wms-gw.inshasaki.com/api/v1/wms/report-management/report-inventories";
  const CUT_WAREHOUSE_ID = "1177"; // WH - MATERIAL - MTG

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

  function requestHeaders(companyIds = "") {
    const session = auth();
    const headers = { Accept: "application/json", Authorization: `Bearer ${session.token}` };
    if (companyIds || session.company) headers["company-ids"] = String(companyIds || session.company);
    return headers;
  }

  async function getJson(url, deniedMessage, companyIds = "") {
    const response = await fetch(url, { headers: requestHeaders(companyIds), credentials: "omit" });
    if (response.status === 401 || response.status === 403) throw new Error(deniedMessage || "Phiên WMS đã hết hạn hoặc không có quyền đọc dữ liệu");
    if (response.status === 204) return { count: 0, page: 1, size: 500, records: [] };
    if (!response.ok) throw new Error(`WMS trả mã ${response.status}`);
    return response.json();
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

  async function readHistoryPage(payload) {
    if (!core?.normalizeHistoryPage) throw new Error("Extension chưa tải bộ đọc lịch sử Group UID; hãy Reload extension");
    const page = Math.max(1, Number(payload?.page) || 1);
    const size = Math.min(500, Math.max(1, Number(payload?.size) || 500));
    const url = new URL(HISTORY_API);
    url.searchParams.set("active_tab", "group-history");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("warehouse_ids", CUT_WAREHOUSE_ID);
    if (payload?.from) url.searchParams.set("from_updated_at", String(new Date(payload.from).getTime()));
    if (payload?.to) url.searchParams.set("to_updated_at", String(new Date(payload.to).getTime()));
    const session = auth();
    const headers = { Accept: "application/json", Authorization: `Bearer ${session.token}` };
    if (session.company) headers["company-ids"] = session.company;
    const response = await fetch(url, { headers, credentials: "omit" });
    if (response.status === 401 || response.status === 403) throw new Error("Phiên WMS không còn quyền đọc lịch sử Group UID; hãy đăng nhập lại bằng tài khoản Admin");
    if (!response.ok) throw new Error(`WMS lịch sử trả mã ${response.status}`);
    const normalized = core.normalizeHistoryPage(await response.json());
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      rangeFrom: normalized.rangeFrom,
      rangeTo: normalized.rangeTo,
      warehouseId: CUT_WAREHOUSE_ID,
      generatedAt: new Date().toISOString(),
    };
  }

  function pageInput(payload) {
    return { page: Math.max(1, Number(payload?.page) || 1), size: Math.min(500, Math.max(1, Number(payload?.size) || 500)) };
  }

  function wmsToday() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }

  function warehouseIds(payload) {
    const ids = [...new Set((payload?.warehouseIds || []).map(Number).filter(Number.isInteger))].slice(0, 20);
    if (!ids.length) throw new Error("Chưa xác định được kho cần đối chiếu");
    return ids;
  }

  async function readCountWarehouses(payload) {
    if (!auditCore) throw new Error("Extension chưa tải bộ đọc kiểm kê; hãy Reload extension");
    const companyUrl = new URL(COMPANY_API);
    companyUrl.searchParams.set("page", "1");
    companyUrl.searchParams.set("size", "10000");
    companyUrl.searchParams.set("check_permission", "true");
    companyUrl.searchParams.set("status", "1");
    const companyData = await getJson(companyUrl, "Phiên WMS không còn quyền đọc danh mục công ty; hãy đăng nhập lại");
    const companies = (companyData.records || companyData.data || []).map(row => ({
      companyId: Number(row.company_id ?? row.id),
      companyCode: auditCore.fold(row.company_code ?? row.code),
      companyName: auditCore.clean(row.company_name ?? row.name, 160),
    })).filter(row => Number.isInteger(row.companyId));
    const requested = payload?.warehouseNames || auditCore.DEFAULT_WAREHOUSES;
    const companyIds = [...new Set(requested.map(name => {
      const folded = auditCore.fold(name);
      const wantedCode = folded.includes("garment") ? "garment" : folded.includes("mtg") ? "mastige" : "";
      return companies.find(company => company.companyCode === wantedCode || (wantedCode && auditCore.fold(company.companyName).includes(wantedCode)))?.companyId;
    }).filter(Number.isInteger))];
    const allRows = [];
    for (const companyId of companyIds) {
      const url = new URL(WAREHOUSE_API);
      url.searchParams.set("page", "1");
      url.searchParams.set("size", "10000");
      const company = companies.find(row => row.companyId === companyId);
      const data = await getJson(url, "Phiên WMS không còn quyền đọc danh mục kho; hãy đăng nhập lại", companyId);
      for (const row of data.records || data.data || []) allRows.push({ ...row, _company_id: companyId, _company_name: company?.companyName || "" });
    }
    return { ...auditCore.selectWarehouses({ records: allRows }, requested), companies, generatedAt: new Date().toISOString() };
  }

  async function readApprovedCountPage(payload) {
    if (!auditCore) throw new Error("Extension chưa tải bộ đọc kiểm kê; hãy Reload extension");
    const { page, size } = pageInput(payload), ids = warehouseIds(payload), url = new URL(APPROVED_COUNT_API);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("warehouse_ids", ids.join(","));
    url.searchParams.set("status_ids", "6");
    url.searchParams.set("from_plan_date_str", String(payload?.from || "2020-01-01"));
    url.searchParams.set("to_plan_date_str", String(payload?.to || wmsToday()));
    const normalized = auditCore.normalizeApprovedPage(await getJson(url, "Phiên WMS không còn quyền đọc kết quả kiểm kê; hãy đăng nhập lại", payload?.companyId));
    return { ...normalized, totalPages: Math.max(1, Math.ceil(normalized.total / size)), warehouseIds: ids, generatedAt: new Date().toISOString() };
  }

  async function readInventoryPage(payload) {
    if (!auditCore) throw new Error("Extension chưa tải bộ đọc kiểm kê; hãy Reload extension");
    const { page, size } = pageInput(payload), ids = warehouseIds(payload), url = new URL(INVENTORY_API);
    url.searchParams.set("status_ids", "6");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("warehouse_ids", ids.join(","));
    url.searchParams.set("keywords_type", "uids");
    url.searchParams.set("keywords_type_2", "purchase_order_numbers");
    const normalized = auditCore.normalizeInventoryPage(await getJson(url, "Phiên WMS không còn quyền đọc tồn kho theo vị trí; hãy đăng nhập lại", payload?.companyId));
    return { ...normalized, totalPages: Math.max(1, Math.ceil(normalized.total / size)), warehouseIds: ids, generatedAt: new Date().toISOString() };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !["GET_GROUP_UID_PAGE", "GET_GROUP_UID_HISTORY_PAGE", "GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE"].includes(message?.type)) return false;
    const readers = {
      GET_GROUP_UID_PAGE: readPage,
      GET_GROUP_UID_HISTORY_PAGE: readHistoryPage,
      GET_SKU_COUNT_WAREHOUSES: readCountWarehouses,
      GET_SKU_COUNT_APPROVED_PAGE: readApprovedCountPage,
      GET_SKU_COUNT_INVENTORY_PAGE: readInventoryPage,
    };
    readers[message.type](message.payload || {})
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { code: message.type.startsWith("GET_SKU_COUNT_") ? "SKU_COUNT_READ_FAILED" : "GROUP_UID_READ_FAILED", message: (auditCore || core)?.clean(error?.message || error, 300) || "Không đọc được dữ liệu WMS" } }));
    return true;
  });
})();
