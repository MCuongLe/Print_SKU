(() => {
  if (window.__HASAKI_WMS_GROUP_UID_BRIDGE__) return;
  window.__HASAKI_WMS_GROUP_UID_BRIDGE__ = true;

  const core = globalThis.HasakiGroupUidSyncCore;
  const auditCore = globalThis.HasakiInventoryAuditCore;
  const API = "https://wms-gw.inshasaki.com/api/v1/wms/group-uid-infos";
  const PACKING_API = "https://wms-gw.inshasaki.com/api/v1/wms/inbound-packing-lists";
  const IT_API = "https://wms-gw.inshasaki.com/api/v1/wms/internal-transfers";
  const IT_ITEMS_API = "https://wms-gw.inshasaki.com/api/v1/wms/transfer/internal-transfer-items/list-details";
  const HISTORY_API = "https://wms-gw.inshasaki.com/api/v1/wms/group-uid-info-histories";
  const WAREHOUSE_API = "https://wms-gw.inshasaki.com/api/v1/wms/master-data/warehouse/by-user";
  const COMPANY_API = "https://wms-gw.inshasaki.com/api/v1/wms/master-data/company";
  const APPROVED_COUNT_API = "https://wms-gw.inshasaki.com/api/v1/wms/counting-plan/checklists/type-sku";
  const INVENTORY_API = "https://wms-gw.inshasaki.com/api/v1/wms/report-management/stock-locations/bins/count/v3";
  const IMPORT_EXPORT_API = "https://wms-gw.inshasaki.com/api/v2/wms/report-management/stock-import-exports";
  const CUT_WAREHOUSE_ID = "1177"; // WH - MATERIAL - MTG
  const MOVE_ACTION = "4"; // Transfer location trong Group UID History

  // 0.10.7: lý do lỗi cho đồng bộ tự động (auto-sync.js xét theo reason, không theo câu chữ): session = hết phiên / chưa đăng nhập
  // (bỏ qua), denied = mất quyền, network = mạng/máy chủ WMS (lỗi).
  function withReason(error, reason) { error.reason = reason; return error; }

  function auth() {
    let store = {};
    try { store = JSON.parse(localStorage.getItem("auth_store") || "{}"); } catch { /* báo lỗi bên dưới */ }
    const raw = store?.state?.token ?? store?.token;
    const token = (typeof raw === "string" ? raw : raw?.access_token ?? raw?.token)?.replace?.(/^Bearer\s+/i, "");
    let company = localStorage.getItem("company_id") || "";
    try { company = JSON.parse(company); } catch { /* giữ chuỗi gốc */ }
    if (Array.isArray(company)) company = company.map(value => value?.id ?? value?.value ?? value).filter(Boolean).join(",");
    else if (company && typeof company === "object") company = company.id ?? company.value ?? company.company_id ?? "";
    if (!token) throw withReason(new Error("Phiên WMS đã hết hạn; hãy đăng nhập lại"), "session");
    return { token: String(token), company: String(company || "") };
  }

  // 0.12.4 (28/10/2026): `allCompanies` = không gửi `company-ids` (kết quả không phụ thuộc công ty đang chọn trên tab WMS). Mặc định (tham số rỗng)
  // vẫn lấy công ty của tab (localStorage `company_id`). `company-ids` CÓ lọc nhiều endpoint WMS (đo 28/10, chỉ đếm): group-uid-infos không header 40.534
  // UID, 1002 Mastige 24.855, 1005 Garment 12.164; group-uid-info-histories actions=4 (30 ngày) 988 / 881 / 49; asns, inbound-packing-lists, internal-transfers
  // cũng lọc. Lệnh nạp dữ liệu vào Supabase hoặc ghép theo PO mà không có công ty cụ thể phải bật `allCompanies`, không thì đọc thiếu im lặng.
  function requestHeaders(companyIds = "", { allCompanies = false } = {}) {
    const session = auth();
    const headers = { Accept: "application/json", Authorization: `Bearer ${session.token}` };
    if (!allCompanies && (companyIds || session.company)) headers["company-ids"] = String(companyIds || session.company);
    return headers;
  }

  async function getJson(url, deniedMessage, companyIds = "", { emptyPage = false, allCompanies = false } = {}) {
    // Lấy phiên trước vòng thử lại: hết phiên phải báo "đăng nhập lại" ngay, không bị coi là lỗi mạng rồi thử lại.
    const headers = requestHeaders(companyIds, { allCompanies });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let response;
      try {
        response = await fetch(url, { headers, credentials: "omit" });
      } catch {
        if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1))); continue; }
        throw withReason(new Error("WMS tạm ngắt kết nối; hãy tải lại tab WMS rồi thử lại"), "network");
      }
      if (response.status === 401 || response.status === 403) throw withReason(new Error(deniedMessage || "Phiên WMS đã hết hạn hoặc không có quyền đọc dữ liệu"), response.status === 401 ? "session" : "denied");
      if (response.status === 204) return { count: 0, page: 1, size: 500, records: [] };
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
        continue;
      }
      // status: để người gọi phân biệt "không có" (404) với lỗi tạm (5xx, 429 sau thử lại) — vd. chi tiết ADJ của readDocInfo.
      if (!response.ok) throw Object.assign(withReason(new Error(`WMS trả mã ${response.status}`), "network"), { status: response.status });
      const body = await response.json();
      return emptyPage ? emptyPageAsList(body) : body;
    }
    throw withReason(new Error("WMS tạm ngắt kết nối; hãy thử lại"), "network");
  }

  // 27/10/2026: danh sách rỗng WMS có khi trả HTTP 200 chỉ {page, size} (không count, không records) thay vì 204 — đo ở transfer-bins,
  // group-uid-infos, group-uid-info-histories (lịch sử Cắt / chuyển vị trí, 0.12.3) và stock-import-exports (cả config_query=1 lẫn 2, 0.12.3:
  // readImportExportPage còn đối chiếu lệnh đếm). Chỉ bật `emptyPage` ở các lệnh đã đo: tồn kho (bins/count/v3) cũng trả {page, size} khi
  // kho / công ty không khớp, nên ở đó dạng này vẫn phải báo "WMS đổi dạng" (chặn R8a, 0.10.7). Dạng lạ khác (thừa khoá, count không kèm danh sách) không đổi.
  const emptyPageAsList = body => {
    const keys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body) : [];
    if (keys.length !== 2 || !keys.includes("page") || !keys.includes("size") || !Number.isFinite(body.page) || !Number.isFinite(body.size)) return body;
    return { count: 0, page: body.page, size: body.size, records: [] };
  };

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
    const normalized = core.normalizePage(await getJson(url, "Phiên WMS không còn quyền đọc Group UID; hãy đăng nhập lại", "", { emptyPage: true, allCompanies: true }));
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      ids: normalized.ids,
      rowIds: normalized.rowIds,
      codes: normalized.codes,
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
    // 0.12.4: kho 1177 là của Mastige nhưng tab WMS chọn công ty khác (vd. 1005) thì WMS trả HTTP 400 / {page,size}; không header cho cùng 4.611 dòng như 1002 (đo 28/10).
    const normalized = core.normalizeHistoryPage(await getJson(url, "Phiên WMS không còn quyền đọc lịch sử Group UID; hãy đăng nhập lại bằng tài khoản Admin", "", { emptyPage: true, allCompanies: true }));
    // 0.12.3: như Import/Export — danh sách rỗng mà count báo còn dòng ở trang này là WMS tự mâu thuẫn → lỗi, không thành 0 dòng + tiến mốc phủ.
    if (normalized.sourceRows === 0 && normalized.total > (page - 1) * size) throw withReason(new Error("WMS trả trang lịch sử rỗng mâu thuẫn với tổng; hãy thử lại"), "network");
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

  // Lịch sử đổi vị trí Group UID (action 4 = Transfer location). Không truyền warehouse_ids. Đo 10/10/2026: 3 công ty cùng trả 5.072 dòng (không lọc
  // `company-ids`); đo lại 28/10/2026: CÓ lọc (30 ngày: không header 988 dòng, 1002 881, 1005 49). Nơi gọi không truyền công ty (web LỊCH SỬ GROUP UID
  // ghi mốc `p_company_id` 0) thì không gửi `company-ids`: đọc toàn bộ phạm vi WMS trả cho token, không giới hạn theo tab; truyền công ty thì đọc đúng công ty đó.
  async function readMovesPage(payload) {
    if (!core?.normalizeMovesPage) throw new Error("Extension chưa tải bộ đọc lịch sử chuyển vị trí; hãy Reload extension");
    const { page, size } = pageInput(payload), companyId = payload?.companyId == null || payload.companyId === "" ? "" : Number(payload.companyId);
    if (companyId !== "" && (!Number.isSafeInteger(companyId) || companyId <= 0)) throw new Error("Công ty cần đọc lịch sử không hợp lệ");
    const url = new URL(HISTORY_API);
    url.searchParams.set("active_tab", "group-history");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("actions", MOVE_ACTION);
    if (payload?.from) url.searchParams.set("from_updated_at", String(new Date(payload.from).getTime()));
    if (payload?.to) url.searchParams.set("to_updated_at", String(new Date(payload.to).getTime()));
    const normalized = core.normalizeMovesPage(await getJson(url, "Phiên WMS không còn quyền đọc lịch sử chuyển vị trí; hãy đăng nhập lại", companyId, { emptyPage: true, allCompanies: companyId === "" }));
    if (normalized.sourceRows === 0 && normalized.total > (page - 1) * size) throw withReason(new Error("WMS trả trang lịch sử rỗng mâu thuẫn với tổng; hãy thử lại"), "network");
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      companyId: companyId || null,
      generatedAt: new Date().toISOString(),
    };
  }

  // Group UID trạng thái New của hai kho WH - MATERIAL (MTG 1177, GARMENT 1339) để chọn in tem. WMS lọc được status_ids, warehouse_ids và
  // from/to_updated_at (cần đủ cả hai mốc); KHÔNG lọc ngày tạo / người tạo — app lọc hai điều kiện đó phía trình duyệt.
  // UID New chưa đổi thì updated_at = created_at, nên mốc from (= ngày tạo sớm nhất) là tập cha an toàn của khoảng ngày tạo.
  const NEW_UID_WAREHOUSES = [1177, 1339];
  async function readNewUidPage(payload) {
    if (!core?.normalizeNewUidPage) throw new Error("Extension chưa tải bộ đọc UID mới; hãy Reload extension");
    const { page, size } = pageInput(payload);
    const wanted = Array.isArray(payload?.warehouseIds) && payload.warehouseIds.length ? payload.warehouseIds : NEW_UID_WAREHOUSES;
    const ids = [...new Set(wanted.map(Number).filter(id => NEW_UID_WAREHOUSES.includes(id)))];
    if (!ids.length) throw new Error("Chưa chọn kho hợp lệ (WH - MATERIAL - MTG hoặc GARMENT)");
    const url = new URL(API);
    url.searchParams.set("active_tab", "group-list");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("status_ids", "1");
    url.searchParams.set("warehouse_ids", ids.join(","));
    if (payload?.from) {
      url.searchParams.set("from_updated_at", String(new Date(payload.from).getTime()));
      url.searchParams.set("to_updated_at", String(payload?.to ? new Date(payload.to).getTime() : Date.now()));
    }
    const normalized = core.normalizeNewUidPage(await getJson(url, "Phiên WMS không còn quyền đọc Group UID; hãy đăng nhập lại", "", { allCompanies: true }));
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      warehouseIds: ids,
      generatedAt: new Date().toISOString(),
    };
  }

  // Packing List của một hay nhiều PO (tối đa 20): lọc theo `purchase_order_numbers`, 500 dòng/trang; không có dòng nào thì trả danh sách rỗng.
  async function readPackingListPage(payload) {
    if (!core?.normalizePackingListPage) throw new Error("Extension chưa tải bộ đọc Packing List; hãy Reload extension");
    const { page, size } = pageInput(payload);
    const orders = [...new Set((Array.isArray(payload?.purchaseOrders) ? payload.purchaseOrders : []).map(value => String(value ?? "").trim()).filter(value => /^\d{6,40}$/.test(value)))].slice(0, 20);
    if (!orders.length) throw new Error("Chưa có mã PO hợp lệ");
    const url = new URL(PACKING_API);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("purchase_order_numbers", orders.join(","));
    const normalized = core.normalizePackingListPage(await getJson(url, "Phiên WMS không còn quyền đọc Packing List; hãy đăng nhập lại"));
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      purchaseOrders: orders,
      generatedAt: new Date().toISOString(),
    };
  }

  const ASN_API = "https://wms-gw.inshasaki.com/api/v2/wms/asns";
  const poInput = payload => {
    const order = String(payload?.purchaseOrder ?? "").trim();
    if (!/^\d{6,40}$/.test(order)) throw new Error("Chưa có mã PO hợp lệ");
    return order;
  };

  // Group UID của một PO (lấy mẫu cắt/QC): `processing_source_code` = số PO. Hai tham số from_updated_at/to_updated_at phải đủ cặp,
  // lấy khoảng rộng từ 2020; không lọc kho vì PO có thể nhận ở nhiều kho. Core kiểm lại số PO từng dòng.
  async function readPoGroupUidPage(payload) {
    if (!core?.normalizePoGroupUidPage) throw new Error("Extension chưa tải bộ đọc Group UID theo PO; hãy Reload extension");
    const { page, size } = pageInput(payload);
    const order = poInput(payload);
    const url = new URL(API);
    url.searchParams.set("active_tab", "group-list");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("processing_source_code", order);
    url.searchParams.set("from_updated_at", String(Date.UTC(2020, 0, 1)));
    url.searchParams.set("to_updated_at", String(Date.now() + 86400000));
    const normalized = core.normalizePoGroupUidPage(await getJson(url, "Phiên WMS không còn quyền đọc Group UID; hãy đăng nhập lại", "", { allCompanies: true }), order);
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      purchaseOrder: order,
      generatedAt: new Date().toISOString(),
    };
  }

  // Các ASN (đợt nhận hàng) của một PO: cho biết còn ASN chưa nhận (Open) hay không. `purchase_order_numbers` (số nhiều) mới lọc.
  async function readPoAsnPage(payload) {
    if (!core?.normalizePoAsnPage) throw new Error("Extension chưa tải bộ đọc ASN; hãy Reload extension");
    const { page, size } = pageInput(payload);
    const order = poInput(payload);
    const url = new URL(ASN_API);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("from_date", String(Date.UTC(2020, 0, 1)));
    url.searchParams.set("to_date", String(Date.now() + 86400000));
    url.searchParams.set("purchase_order_numbers", order);
    // 0.12.4: cùng phạm vi với readPoGroupUidPage (một lượt "Theo PO" không được đọc UID mọi công ty mà ASN chỉ công ty của tab).
    const normalized = core.normalizePoAsnPage(await getJson(url, "Phiên WMS không còn quyền đọc ASN; hãy đăng nhập lại", "", { allCompanies: true }), order);
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      purchaseOrder: order,
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
    url.searchParams.set("ignore_zero_total", "1");
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    url.searchParams.set("warehouse_ids", ids.join(","));
    if (payload?.companyId) url.searchParams.set("company_ids", String(payload.companyId));
    const normalized = auditCore.normalizeInventoryPage(await getJson(url, "Phiên WMS không còn quyền đọc tồn kho theo vị trí; hãy đăng nhập lại", payload?.companyId));
    return { ...normalized, totalPages: Math.max(1, Math.ceil(normalized.total / size)), warehouseIds: ids, generatedAt: new Date().toISOString() };
  }

  // Báo cáo Import/Export của kho (Kiểm soát công trình). Mốc ngày là ISO hoặc mili giây; WMS đòi cả from_date lẫn to_date.
  // Mỗi trang kèm một lệnh config_query=2 (như màn WMS) để lấy tổng dòng, nhờ vậy mọi trang cùng báo một totalPages.
  async function readImportExportPage(payload) {
    if (!auditCore?.normalizeImportExportPage) throw new Error("Extension chưa tải bộ đọc nhập xuất; hãy Reload extension");
    const { page, size } = pageInput(payload), ids = warehouseIds(payload);
    const stamp = value => /^\d{10,}$/.test(String(value ?? "")) ? Number(value) : new Date(value).getTime();
    const from = stamp(payload?.from), to = payload?.to ? stamp(payload.to) : Date.now();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error("Khoảng ngày đọc nhập xuất không hợp lệ");
    const build = query => {
      const url = new URL(IMPORT_EXPORT_API);
      url.searchParams.set("from_date", String(from));
      url.searchParams.set("to_date", String(to));
      url.searchParams.set("page", String(page));
      url.searchParams.set("size", String(size));
      url.searchParams.set("warehouse_ids", ids.join(","));
      url.searchParams.set("config_query", String(query));
      return url;
    };
    const denied = "Phiên WMS không còn quyền đọc báo cáo Import/Export; hãy đăng nhập lại";
    // 0.12.3: lệnh danh sách trả {page, size} khi khoảng ngày rỗng (đo 27/10/2026) → {count:0, records:[]}; lệnh đếm không cần cờ (thiếu count = 0). Danh sách rỗng chỉ được tin khi lệnh
    // đếm cũng không còn dòng ở trang này; đếm > (page − 1) × size mà danh sách rỗng là mâu thuẫn → lỗi, không thành 0 dòng im lặng.
    const [list, count] = await Promise.all([getJson(build(1), denied, payload?.companyId, { emptyPage: true }), getJson(build(2), denied, payload?.companyId)]);
    const normalized = auditCore.normalizeImportExportPage(list);
    if (normalized.sourceRows === 0 && Number(count?.count) > (page - 1) * size) throw withReason(new Error("WMS trả trang nhập xuất rỗng mâu thuẫn với tổng; hãy thử lại"), "network");
    const total = Math.max(normalized.sourceRows, Number(count?.count) || 0);
    return { ...normalized, total, totalPages: Math.max(1, Math.ceil(total / size)), warehouseIds: ids, from, to, generatedAt: new Date().toISOString() };
  }

  // Transfer Location History (RỦI RO LƯU TRỮ · Hàng chưa lên kệ, 26/10/2026): các lần chuyển VÀO một vị trí của một SKU, mới nhất trước,
  // tối đa 50 dòng/trang. Lọc `warehouse_id` (số ít), `bin_in`, `keywords` (SKU); chưa biết tham số lọc ngày nên không lọc ngày.
  // Mã Group UID: source_id của dòng chuyển tay / EDIT_UID_GROUP là group_uid_id → tra lịch sử Group UID cùng kho, ±2 phút quanh giờ
  // chuyển (tối đa 3 lần gọi, mốc gần nhất trước); không ra hoặc lỗi thì uid = "" (web hiện "Group UID #id"), lệnh vẫn thành công.
  const TRANSFER_BIN_API = "https://wms-gw.inshasaki.com/api/v1/wms/transfer-bins";
  const UID_WINDOW_MS = 2 * 60000, UID_LOOKUPS = 3;
  const wmsTime = value => {
    const raw = String(value ?? "").trim();
    if (!raw) return NaN;
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}+07:00` : raw);
  };
  async function readTransferBinPage(payload) {
    if (!auditCore?.normalizeTransferBinPage) throw new Error("Extension chưa tải bộ đọc chuyển vị trí; hãy Reload extension");
    const warehouseId = Number(payload?.warehouseId);
    if (!Number.isSafeInteger(warehouseId) || warehouseId <= 0) throw new Error("Kho cần đọc lịch sử chuyển vị trí không hợp lệ");
    const binIn = String(payload?.binIn ?? "").trim(), sku = String(payload?.sku ?? "").trim();
    // Mã vị trí có thể mang chữ tiếng Việt (vd. vùng ĐG): nhận chữ / số Unicode, khoảng trắng và . _ ( ) -
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,79}$/u.test(binIn)) throw new Error("Vị trí cần đọc lịch sử chuyển không hợp lệ");
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(sku)) throw new Error("SKU cần đọc lịch sử chuyển không hợp lệ");
    const companyId = payload?.companyId == null || payload.companyId === "" ? "" : Number(payload.companyId);
    if (companyId !== "" && (!Number.isSafeInteger(companyId) || companyId <= 0)) throw new Error("Công ty cần đọc lịch sử chuyển không hợp lệ");
    const page = Math.max(1, Number(payload?.page) || 1), size = Math.min(50, Math.max(1, Number(payload?.size) || 20));
    const url = new URL(TRANSFER_BIN_API);
    url.searchParams.set("warehouse_id", String(warehouseId));
    url.searchParams.set("bin_in", binIn);
    url.searchParams.set("keywords", sku);
    url.searchParams.set("page", String(page));
    url.searchParams.set("size", String(size));
    const normalized = auditCore.normalizeTransferBinPage(await getJson(url, "Phiên WMS không còn quyền đọc lịch sử chuyển vị trí; hãy đăng nhập lại", companyId, { emptyPage: true }), { binIn, sku });
    // Tra mã Group UID: gộp các mốc giờ gần nhau thành một khoảng, tối đa UID_LOOKUPS lần gọi.
    const need = normalized.rows.filter(row => row.uidId).map(row => wmsTime(row.at)).filter(Number.isFinite).sort((a, b) => b - a), windows = [];
    for (const time of need) {
      const last = windows[windows.length - 1];
      if (last && time + UID_WINDOW_MS >= last.from) last.from = Math.min(last.from, time - UID_WINDOW_MS);
      else if (windows.length < UID_LOOKUPS) windows.push({ from: time - UID_WINDOW_MS, to: time + UID_WINDOW_MS });
    }
    const codes = new Map();
    for (const window of windows) {
      const historyUrl = new URL(HISTORY_API);
      historyUrl.searchParams.set("active_tab", "group-history");
      historyUrl.searchParams.set("page", "1");
      historyUrl.searchParams.set("size", "500");
      historyUrl.searchParams.set("warehouse_ids", String(warehouseId));
      historyUrl.searchParams.set("from_updated_at", String(window.from));
      historyUrl.searchParams.set("to_updated_at", String(window.to));
      let data;
      try { data = await getJson(historyUrl, "", companyId); } catch { break; }
      for (const raw of Array.isArray(data?.records) ? data.records : Array.isArray(data?.data) ? data.data : []) {
        const id = Number(raw?.group_uid_id), code = auditCore.clean(raw?.group_uid_code, 40);
        if (Number.isSafeInteger(id) && /^\d{6,40}$/.test(code) && !codes.has(id)) codes.set(id, code);
      }
    }
    for (const row of normalized.rows) if (row.uidId && codes.has(row.uidId)) row.uid = codes.get(row.uidId);
    return {
      page, size, total: normalized.total,
      totalPages: Math.max(1, Math.ceil(normalized.total / size)),
      rows: normalized.rows,
      sourceRows: normalized.sourceRows,
      warehouseId, binIn, sku,
      generatedAt: new Date().toISOString(),
    };
  }

  // Phiếu IT theo số phiếu (cho IN TEM SKU): tìm đúng số phiếu (không cần khoảng ngày), rồi đọc các dòng của phiếu
  async function readInternalTransfer(payload) {
    if (!core?.normalizeInternalTransfer) throw new Error("Extension chưa tải bộ đọc phiếu IT; hãy Reload extension");
    const number = String(payload?.number ?? "").trim();
    if (!/^\d{6,40}$/.test(number)) throw new Error("Số phiếu IT không hợp lệ");
    const denied = "Phiên WMS không còn quyền đọc phiếu IT; hãy đăng nhập lại";
    const listUrl = new URL(IT_API);
    listUrl.searchParams.set("page", "1");
    listUrl.searchParams.set("size", "5");
    listUrl.searchParams.set("internal_transfer_numbers", number);
    const head = core.responseRows(await getJson(listUrl, denied)).find(row => String(row?.internal_transfer_number ?? "").trim() === number);
    if (!head) throw new Error(`Không tìm thấy phiếu IT ${number}`);
    const itemsUrl = new URL(IT_ITEMS_API);
    itemsUrl.searchParams.set("internal_transfer_id", String(head.internal_transfer_id));
    itemsUrl.searchParams.set("page", "1");
    itemsUrl.searchParams.set("size", "500");
    return { ...core.normalizeInternalTransfer(head, await getJson(itemsUrl, denied)), generatedAt: new Date().toISOString() };
  }

  // Số phiếu cho nguồn Cut (Đối chiếu ADJ, 26/10/2026): `source_mapping_id` của dòng Import/Export → phiếu ADJ (`adjustments?mapping_codes=`
  // rồi chi tiết lấy `reference_code` = số PO) / phiếu IT (`internal-transfers?mapping_ids=`). Chỉ GET; tối đa 20 mã mỗi loại một lần;
  // WMS bỏ qua bộ lọc thì phiếu khác mã bị loại. Trả { adj:[{mappingCode, number, reason, po, detailFailed?}], it:[{mappingId, number, toWarehouse,
  // description, status}] } — mã không tìm thấy thì không có trong kết quả.
  const ADJ_API = "https://wms-gw.inshasaki.com/api/v1/wms/adjustments";
  const ADJ_DETAIL_API = "https://wms-gw.inshasaki.com/api/v1/wms/adjustment/adjustments/detail";
  async function readDocInfo(payload) {
    if (!core?.responseRows) throw new Error("Extension chưa tải bộ đọc phiếu ADJ / IT; hãy Reload extension");
    const codes = value => [...new Set((Array.isArray(value) ? value : []).map(item => String(item ?? "").trim()).filter(item => /^\d{6,40}$/.test(item)))];
    if ((Array.isArray(payload?.adj) && payload.adj.length > 20) || (Array.isArray(payload?.it) && payload.it.length > 20)) throw new Error("Mỗi lần tra tối đa 20 phiếu ADJ và 20 phiếu IT");
    const adj = codes(payload?.adj), it = codes(payload?.it), out = { adj: [], it: [], generatedAt: "" };
    if (!adj.length && !it.length) throw new Error("Chưa có mã phiếu ADJ / IT hợp lệ cần tra");
    if (adj.length) {
      const deniedAdj = "Phiên WMS không còn quyền đọc phiếu ADJ; hãy đăng nhập lại";
      const url = new URL(ADJ_API);
      url.searchParams.set("page", "1");
      url.searchParams.set("size", "100");
      url.searchParams.set("mapping_codes", adj.join(","));
      const heads = new Map();
      for (const row of core.responseRows(await getJson(url, deniedAdj))) {
        const mapping = core.clean(row?.mapping_code, 60), id = Number(row?.adjustment_id), number = core.clean(row?.adjustment_number, 40);
        if (adj.includes(mapping) && !heads.has(mapping) && Number.isSafeInteger(id) && id > 0 && /^\d{6,40}$/.test(number)) heads.set(mapping, { id, number, reason: core.clean(row?.reason_name, 120) });
      }
      for (const [mapping, head] of heads) {
        const detailUrl = new URL(ADJ_DETAIL_API);
        detailUrl.searchParams.set("adjustment_id", String(head.id));
        // Chi tiết chỉ để lấy PO (review 26/10/2026): lỗi riêng một phiếu không làm hỏng cả lệnh, vẫn trả số phiếu + lý do của danh sách;
        // hết phiên / mất quyền là lỗi chung → ném cả lệnh như trước. Vòng 2: chỉ 404 / thân rỗng (204) là chắc chắn không có chi tiết → po null;
        // lỗi tạm (5xx / 429 sau thử lại, mất mạng, thân hỏng) → detailFailed: true để bộ ghép (cut-source-core) coi là chưa tra được, thử lại
        // lượt sau (set_source chỉ ghi Cut chưa nguồn: ghi PO rỗng lúc lỗi tạm là mất PO vĩnh viễn).
        let raw = null, detailFailed = false;
        try { raw = await getJson(detailUrl, deniedAdj); } catch (error) {
          if (error?.reason === "session" || error?.reason === "denied") throw error;
          detailFailed = error?.status !== 404;
        }
        const detail = raw?.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : core.responseRows(raw)[0] || raw;
        const same = detail?.adjustment_number == null || core.clean(detail.adjustment_number, 40) === head.number;
        out.adj.push({ mappingCode: mapping, number: head.number, reason: head.reason || null, po: same ? core.clean(detail?.reference_code, 60) || null : null, ...(detailFailed ? { detailFailed: true } : {}) });
      }
    }
    if (it.length) {
      const url = new URL(IT_API);
      url.searchParams.set("page", "1");
      url.searchParams.set("size", "100");
      url.searchParams.set("mapping_ids", it.join(","));
      const seen = new Set();
      for (const row of core.responseRows(await getJson(url, "Phiên WMS không còn quyền đọc phiếu IT; hãy đăng nhập lại"))) {
        const mapping = core.clean(row?.mapping_id, 60), number = core.clean(row?.internal_transfer_number, 40);
        if (!it.includes(mapping) || seen.has(mapping) || !/^\d{6,40}$/.test(number)) continue;
        seen.add(mapping);
        out.it.push({ mappingId: mapping, number, toWarehouse: core.clean(row?.to_warehouse_name, 160) || null, description: core.clean(row?.description, 500) || null, status: core.clean(row?.status_name, 60) || null });
      }
    }
    out.generatedAt = new Date().toISOString();
    return out;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !["GET_GROUP_UID_PAGE", "GET_GROUP_UID_HISTORY_PAGE", "GET_GROUP_UID_MOVES_PAGE", "GET_GROUP_UID_NEW_PAGE", "GET_PACKING_LIST_PAGE", "GET_PO_GROUP_UID_PAGE", "GET_PO_ASN_PAGE", "GET_INTERNAL_TRANSFER", "GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE", "GET_STOCK_IMPORT_EXPORT_PAGE", "GET_WMS_DOC_INFO", "GET_TRANSFER_BIN_PAGE"].includes(message?.type)) return false;
    const readers = {
      GET_GROUP_UID_PAGE: readPage,
      GET_GROUP_UID_HISTORY_PAGE: readHistoryPage,
      GET_GROUP_UID_MOVES_PAGE: readMovesPage,
      GET_GROUP_UID_NEW_PAGE: readNewUidPage,
      GET_PACKING_LIST_PAGE: readPackingListPage,
      GET_PO_GROUP_UID_PAGE: readPoGroupUidPage,
      GET_PO_ASN_PAGE: readPoAsnPage,
      GET_INTERNAL_TRANSFER: readInternalTransfer,
      GET_SKU_COUNT_WAREHOUSES: readCountWarehouses,
      GET_SKU_COUNT_APPROVED_PAGE: readApprovedCountPage,
      GET_SKU_COUNT_INVENTORY_PAGE: readInventoryPage,
      GET_STOCK_IMPORT_EXPORT_PAGE: readImportExportPage,
      GET_WMS_DOC_INFO: readDocInfo,
      GET_TRANSFER_BIN_PAGE: readTransferBinPage,
    };
    const failure = message.type === "GET_WMS_DOC_INFO" ? "WMS_DOC_READ_FAILED" : message.type === "GET_TRANSFER_BIN_PAGE" ? "TRANSFER_BIN_READ_FAILED" : message.type === "GET_STOCK_IMPORT_EXPORT_PAGE" ? "IMPORT_EXPORT_READ_FAILED" : message.type === "GET_INTERNAL_TRANSFER" ? "INTERNAL_TRANSFER_READ_FAILED" : message.type.startsWith("GET_SKU_COUNT_") ? "SKU_COUNT_READ_FAILED" : "GROUP_UID_READ_FAILED";
    readers[message.type](message.payload || {})
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { code: failure, message: (auditCore || core)?.clean(error?.message || error, 300) || "Không đọc được dữ liệu WMS", ...(error?.reason ? { reason: error.reason } : {}) } }));
    return true;
  });
})();
