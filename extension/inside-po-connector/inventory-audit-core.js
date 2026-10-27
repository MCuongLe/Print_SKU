(() => {
  const DEFAULT_WAREHOUSES = ["WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT"];

  const clean = (value, limit = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const fold = value => clean(value).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
  const recordsOf = payload => Array.isArray(payload?.records) ? payload.records : Array.isArray(payload?.data) ? payload.data : [];
  // 0.10.7 (review R8a, cùng mẫu G13): không thấy khoá danh sách = WMS đổi dạng phản hồi → lỗi, không lưu bản chụp 0 dòng.
  // 204 của WMS đã được wms-bridge đổi thành {records: []} nên vẫn hợp lệ.
  const requireList = (payload, label) => {
    if (!Array.isArray(payload?.records) && !Array.isArray(payload?.data)) throw new Error(`WMS đổi dạng dữ liệu ${label} (không thấy danh sách); hãy báo để cập nhật Extension`);
  };
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;

  function selectWarehouses(payload, requestedNames = DEFAULT_WAREHOUSES) {
    const rows = recordsOf(payload).map(row => ({
      warehouseId: Number(row.warehouse_id ?? row.id),
      companyId: Number(row._company_id ?? row.company_id) || null,
      companyName: clean(row._company_name ?? row.company_name, 160),
      warehouseCode: clean(row.warehouse_code ?? row.code, 40),
      warehouseName: clean(row.warehouse_name ?? row.name, 160),
    })).filter(row => Number.isInteger(row.warehouseId) && row.warehouseName);
    const selected = [], missingNames = [];
    for (const requested of requestedNames.map(name => clean(name, 160)).filter(Boolean)) {
      const wanted = fold(requested), wantedTokens = wanted.split(" ");
      const exact = rows.find(row => fold(row.warehouseName) === wanted);
      const tokenMatch = rows.find(row => wantedTokens.every(token => fold(row.warehouseName).split(" ").includes(token)));
      const match = exact || tokenMatch;
      if (match && !selected.some(row => row.warehouseId === match.warehouseId)) selected.push(match);
      else if (!match) missingNames.push(requested);
    }
    return { warehouses: selected, missingNames, availableCount: rows.length };
  }

  function normalizeApprovedPage(payload) {
    requireList(payload, "kiểm kê");
    const rows = recordsOf(payload).filter(row => clean(row.status_name, 40).toUpperCase() === "APPROVED").map(row => ({
      checklistId: Number(row.checklist_id) || null,
      planId: Number(row.plan_id) || null,
      warehouseId: Number(row.warehouse_id),
      warehouseName: clean(row.warehouse_name, 160),
      sku: clean(row.plan_object_code ?? row.sku, 80),
      productName: clean(row.product_name, 500),
      approvedAt: clean(row.approved_at_tz ?? row.approved_at ?? row.updated_at_tz ?? row.updated_at, 80),
      approvedBy: clean(row.approved_by_name, 160),
      countedAt: clean(row.checklist_at_tz ?? row.checklist_at, 80),
    })).filter(row => Number.isInteger(row.warehouseId) && row.sku && row.approvedAt);
    // 0.10.8 (D2): sourceRows = số dòng WMS trả (trước khi lọc) để Kiểm kê so tổng các trang với total; total tính trên số dòng WMS
    // (như normalizeInventoryPage), không trên số dòng đã lọc — thiếu count mà có dòng bị lọc thì không thành lệch giả.
    const sourceRows = recordsOf(payload).length;
    return { rows, sourceRows, total: Math.max(sourceRows, finite(payload?.count)), page: Math.max(1, finite(payload?.page) || 1), size: Math.max(1, finite(payload?.size) || 500) };
  }

  function normalizeInventoryPage(payload) {
    requireList(payload, "tồn kho");
    const sourceRows = recordsOf(payload);
    const rows = sourceRows.map(row => {
      // Stock Location đã gộp theo SKU/vị trí. count_inbin là tồn trạng thái In-BIN;
      // quantity chỉ là fallback cho phiên bản WMS cũ có cùng ý nghĩa.
      const qty = finite(row.count_inbin ?? row.quantity ?? row.qty);
      return {
        inventoryId: Number(row.inventory_id) || null,
        warehouseId: Number(row.warehouse_id),
        warehouseName: clean(row.warehouse_name, 160),
        sku: clean(row.sku, 80),
        productName: clean(row.product_name, 500),
        location: clean(row.location_description, 160),
        qty,
        // Tổng mọi trạng thái (In-BIN + picklist/đóng gói...). Dòng In-BIN = 0 nhưng total > 0 vẫn được giữ lại
        // (qty = 0) để màn Rủi ro lưu trữ không bỏ sót hàng giữ chỗ; Kiểm kê chỉ tính dòng qty > 0.
        total: Math.max(finite(row.quantity), qty),
        // Modified date (giờ WMS) là mốc tính số ngày ở vị trí: dòng tồn có thể tạo từ lâu nhưng vừa bị sửa (lấy hàng, điều chỉnh).
        // Ngày tạo giữ kèm để dự phòng khi WMS không trả updated_at.
        modified: clean(row.updated_at, 40),
        created: clean(row.created_at, 40),
        uom: clean(row.uom, 40),
      };
    }).filter(row => Number.isInteger(row.warehouseId) && row.sku && (row.qty > 0 || row.total > 0));
    return { rows, sourceRows: sourceRows.length, total: Math.max(sourceRows.length, finite(payload?.count)), page: Math.max(1, finite(payload?.page) || 1), size: Math.max(1, finite(payload?.size) || 500) };
  }

  // Báo cáo Import/Export của WMS: type 1 = nhập, 2 = xuất. current_quantity là tồn của SKU ngay sau dòng đó (có thể trống).
  // Giờ lấy từ created_at_tz (có múi giờ); created_at của WMS là giờ địa phương không kèm múi giờ.
  function normalizeImportExportPage(payload) {
    requireList(payload, "nhập xuất");
    const sourceRows = recordsOf(payload);
    const rows = sourceRows.map(row => {
      const type = Number(row.type);
      return {
        id: Number(row.id) || null,
        warehouseId: Number(row.warehouse_id),
        warehouseName: clean(row.warehouse_name, 160),
        sku: clean(row.sku, 80),
        productName: clean(row.product_name, 500),
        kind: type === 1 ? "in" : type === 2 ? "out" : "",
        qty: finite(row.quantity),
        balance: row.current_quantity === undefined || row.current_quantity === null ? null : finite(row.current_quantity),
        sourceType: clean(row.source_type, 40),
        sourceCode: clean(row.source_code, 60),
        mappingId: clean(row.source_mapping_id, 60),
        reason: clean(row.reason_name, 120),
        fromWarehouse: clean(row.stock_out, 160),
        toWarehouse: clean(row.stock_in, 160),
        createdAt: clean(row.created_at_tz ?? row.created_at, 40),
        createdBy: clean(row.created_user_name, 120),
        // 26/10/2026: người duyệt (RỦI RO LƯU TRỮ: phiếu gốc UID tạm, phiếu nhập của Hàng chưa lên kệ); thiếu thì rỗng.
        approvedBy: clean(row.approved_user_name, 120),
      };
    }).filter(row => Number.isInteger(row.warehouseId) && row.sku && row.kind);
    return { rows, sourceRows: sourceRows.length, total: Math.max(sourceRows.length, finite(payload?.count)), page: Math.max(1, finite(payload?.page) || 1), size: Math.max(1, finite(payload?.size) || 500) };
  }

  // Transfer Location History của WMS (transfer-bins, 26/10/2026, Hàng chưa lên kệ): mỗi dòng một lần chuyển vị trí, mới nhất trước.
  // Chỉ giữ dòng đúng vị trí đến + SKU đã hỏi (WMS bỏ qua bộ lọc lạ thì không trộn dòng khác); khi đó count không còn tin được → total = số dòng giữ.
  // source_id là id Group UID khi loại chuyển trống (chuyển tay) hoặc EDIT_UID_GROUP; loại khác là id phiếu khác (ASN, phiếu xuất…) → uidId null.
  const UID_MOVE_TYPES = new Set(["", "EDIT_UID_GROUP"]);
  function normalizeTransferBinPage(payload, wanted = {}) {
    requireList(payload, "chuyển vị trí");
    const sourceRows = recordsOf(payload), bin = clean(wanted.binIn, 160).toUpperCase(), sku = clean(wanted.sku, 80);
    const rows = sourceRows.map(row => {
      const type = clean(row.transfer_type, 60).toUpperCase(), sourceId = Number(row.source_id);
      return {
        id: Number(row.id) || null,
        sku: clean(row.sku, 80),
        qty: finite(row.quantity),
        from: clean(row.bin_out, 160),
        to: clean(row.bin_in, 160),
        type,
        by: clean(row.created_user_name, 120) || clean(row.created_by, 120),
        at: clean(row.created_at_tz ?? row.created_at, 40),
        uidId: UID_MOVE_TYPES.has(type) && Number.isSafeInteger(sourceId) && sourceId > 0 ? sourceId : null,
        uid: "",
      };
    }).filter(row => row.sku && (!sku || row.sku === sku) && (!bin || row.to.toUpperCase() === bin));
    const exact = rows.length === sourceRows.length;
    return { rows, sourceRows: sourceRows.length, total: exact ? Math.max(rows.length, finite(payload?.count)) : rows.length, page: Math.max(1, finite(payload?.page) || 1), size: Math.max(1, finite(payload?.size) || 20) };
  }

  globalThis.HasakiInventoryAuditCore = Object.freeze({ DEFAULT_WAREHOUSES, clean, fold, selectWarehouses, normalizeApprovedPage, normalizeInventoryPage, normalizeImportExportPage, normalizeTransferBinPage });
})();
