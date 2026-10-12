(() => {
  const DEFAULT_WAREHOUSES = ["WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT"];

  const clean = (value, limit = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const fold = value => clean(value).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
  const recordsOf = payload => Array.isArray(payload?.records) ? payload.records : Array.isArray(payload?.data) ? payload.data : [];
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
    return { rows, total: Math.max(rows.length, finite(payload?.count)), page: Math.max(1, finite(payload?.page) || 1), size: Math.max(1, finite(payload?.size) || 500) };
  }

  function normalizeInventoryPage(payload) {
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

  globalThis.HasakiInventoryAuditCore = Object.freeze({ DEFAULT_WAREHOUSES, clean, fold, selectWarehouses, normalizeApprovedPage, normalizeInventoryPage });
})();
