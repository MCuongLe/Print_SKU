(() => {
  if (globalThis.HasakiGroupUidSyncCore) return;

  const clean = (value, max = 800) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const numberValue = value => {
    const parsed = Number(String(value ?? "").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : NaN;
  };
  const isoDate = value => {
    const date = new Date(String(value ?? ""));
    if (!Number.isFinite(date.getTime())) throw new Error(`Ngày cập nhật Group UID không hợp lệ: ${clean(value, 80)}`);
    return date.toISOString();
  };
  // Mã RFID dán trên cuộn (WMS group_rfid_mapping, 20/10/2026: 1 chữ + 11 số; khoá chỉ có khi UID đã gắn RFID).
  // Ba trạng thái (Codex 20/10): thiếu khoá / null / rỗng → null (= chưa gắn hoặc WMS đã gỡ → Supabase xoá theo); chuỗi 1–40
  // chữ/số → viết hoa; giá trị có nhưng SAI dạng (ký tự lạ, dài quá 40, không phải chuỗi) → undefined: khoá bị bỏ khi gửi
  // (JSON bỏ undefined) → Edge coi là "không biết" và giữ RFID đang lưu, không xoá nhầm.
  const rfidCode = value => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") return undefined;
    const code = value.trim();
    if (!code) return null;
    return /^[A-Za-z0-9]{1,40}$/.test(code) ? code.toUpperCase() : undefined;
  };
  // Số PO nguồn của Group UID (21/10/2026, lọc theo PO ở CẮT GROUP UID): WMS processing_source_type = PURCHASE_ORDER thì
  // processing_source_code là số PO (đo 21/10: 14 chữ số). Có loại nguồn khác (WMS_COUNTING_PLAN, INTERNAL_TRANSFER) → null
  // (= không có PO, Edge ghi theo). Không chắc → undefined: bỏ khoá khi gửi, Edge "không biết", giữ PO cũ (review 21/10) —
  // thiếu khoá / loại nguồn rỗng (UID không nguồn, hoặc WMS đổi dạng phản hồi), PURCHASE_ORDER mà mã trống / sai dạng.
  const purchaseOrderCode = raw => {
    const type = typeof raw?.processing_source_type === "string" ? raw.processing_source_type.trim().toUpperCase() : "";
    if (!type) return undefined;
    if (type !== "PURCHASE_ORDER") return null;
    const value = raw?.processing_source_code;
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    // Số JSON vượt số nguyên an toàn có thể đã bị làm tròn khi JSON.parse (Codex 21/10) → coi là không biết, giữ PO cũ.
    if (typeof value === "number" && !(Number.isSafeInteger(value) && value >= 0)) return undefined;
    const code = String(value).trim();
    if (!code) return undefined;
    return /^\d{6,40}$/.test(code) ? code : undefined;
  };
  const CUT_NOTE = /^Cut\s+([\d.,]+)\s+out of group\s+(\S+)\s+\(remaining\s+([\d.,]+)\)\s*$/i;

  function responseRows(payload) {
    const candidates = [
      payload?.data?.items, payload?.data?.rows, payload?.data?.data,
      payload?.data?.group_uid_infos, payload?.data?.records,
      payload?.items, payload?.rows, payload?.records,
      Array.isArray(payload?.data) ? payload.data : null,
    ];
    return candidates.find(Array.isArray) || [];
  }

  function responseTotal(payload, fallback = 0) {
    const candidates = [
      payload?.data?.total, payload?.data?.pagination?.total, payload?.data?.meta?.total,
      payload?.data?.count, payload?.pagination?.total, payload?.meta?.total,
      payload?.total, payload?.count,
    ];
    const total = candidates.map(Number).find(Number.isFinite);
    return Number.isFinite(total) && total >= 0 ? total : fallback;
  }

  function normalizeRow(raw, index = 0) {
    const sourceProducts = Array.isArray(raw?.products) ? raw.products : [];
    const productMap = new Map();
    sourceProducts.forEach((item, productIndex) => {
      const sku = clean(item?.sku, 80);
      const quantity = numberValue(item?.quantity);
      if (!sku || !Number.isFinite(quantity)) throw new Error(`Group UID ${clean(raw?.group_uid_code) || index + 1} có SKU thành phần ${productIndex + 1} không hợp lệ`);
      const existing = productMap.get(sku);
      productMap.set(sku, {
        sku,
        quantity: quantity + (existing?.quantity || 0),
        product_name: clean(item?.product_name, 500) || existing?.product_name || null,
      });
    });
    const products = [...productMap.values()].sort((left, right) => left.sku.localeCompare(right.sku));
    const product = products.length === 1 ? products[0] : {};
    const code = clean(raw?.group_uid_code, 40);
    const rawQty = raw?.uid_quantity ?? products.reduce((sum, item) => sum + item.quantity, 0);
    const qty = numberValue(rawQty);
    const updated = raw?.updated_at_tz ?? raw?.updated_at;
    const status = clean(raw?.status_name ?? raw?.status, 100);
    if (!code || !/^\d{6,40}$/.test(code)) throw new Error(`Dòng ${index + 1} có Group UID không hợp lệ`);
    if (!Number.isFinite(qty)) throw new Error(`Group UID ${code} có số lượng không hợp lệ`);
    if (!status) throw new Error(`Group UID ${code} thiếu trạng thái`);
    return {
      group_uid_code: code,
      batch_code: clean(raw?.batch_code, 120) || null,
      roll_code: clean(raw?.roll_code, 120) || null,
      warehouse: clean(raw?.warehouse_name ?? raw?.warehouse, 240) || null,
      location: clean(raw?.location_description ?? raw?.location, 240) || null,
      sku: clean(product?.sku ?? raw?.sku, 80) || null,
      qty,
      updated_by: clean(raw?.updated_by_name ?? raw?.updated_by, 240) || null,
      updated_date: isoDate(updated),
      status,
      qc_status: clean(raw?.quality_control_status_name, 60) || null,
      group_rfid_mapping: rfidCode(raw?.group_rfid_mapping),
      purchase_order: purchaseOrderCode(raw),
      products,
    };
  }

  function normalizePage(payload) {
    const rows = responseRows(payload);
    const unique = new Map();
    rows.forEach((raw, index) => {
      const row = normalizeRow(raw, index);
      const before = unique.get(row.group_uid_code);
      if (!before || new Date(row.updated_date) >= new Date(before.updated_date)) unique.set(row.group_uid_code, row);
    });
    return { rows: [...unique.values()], total: responseTotal(payload, rows.length) };
  }

  function normalizeHistoryPage(payload) {
    const source = responseRows(payload);
    const unique = new Map();
    let rangeFrom = "", rangeTo = "";
    source.forEach((raw, index) => {
      const updatedDate = isoDate(raw?.updated_at_tz ?? raw?.updated_at);
      if (!rangeFrom || updatedDate < rangeFrom) rangeFrom = updatedDate;
      if (!rangeTo || updatedDate > rangeTo) rangeTo = updatedDate;
      const note = clean(raw?.note, 800);
      const match = CUT_NOTE.exec(note);
      if (!match) {
        if (/^Cut\b/i.test(note)) throw new Error(`Lịch sử Group UID dòng ${index + 1} có ghi chú Cut không hợp lệ`);
        return;
      }
      const code = clean(raw?.group_uid_code ?? match[2], 40);
      if (!code || code !== clean(match[2], 40)) throw new Error(`Lịch sử Group UID dòng ${index + 1} có mã Cut không khớp`);
      const qty = numberValue(match[1]);
      const remaining = numberValue(match[3]);
      if (!Number.isFinite(qty) || !Number.isFinite(remaining)) throw new Error(`Lịch sử Group UID ${code} có số lượng Cut không hợp lệ`);
      const row = {
        group_uid_code: code,
        cut_at: updatedDate,
        qty,
        remaining_qty: remaining,
        sku: clean(raw?.sku, 80) || null,
        cut_by: clean(raw?.updated_by_name ?? raw?.updated_by, 240) || null,
        warehouse: clean(raw?.warehouse_name ?? raw?.warehouse, 240) || null,
      };
      unique.set(`${row.group_uid_code}|${row.cut_at}`, row);
    });
    return {
      rows: [...unique.values()],
      total: responseTotal(payload, source.length),
      sourceRows: source.length,
      rangeFrom: rangeFrom || null,
      rangeTo: rangeTo || null,
    };
  }

  // WMS Group UID History: action 4 = "Transfer location" (đổi vị trí). Dòng này không có SKU/số lượng.
  const TRANSFER_ACTION = 4;

  function normalizeMovesPage(payload) {
    const source = responseRows(payload);
    const unique = new Map();
    source.forEach((raw, index) => {
      const actionCode = Number(raw?.action);
      const actionName = clean(raw?.action_name, 80);
      if (actionCode !== TRANSFER_ACTION && !/^transfer\s+location$/i.test(actionName)) return;
      const id = Number(raw?.id);
      const code = clean(raw?.group_uid_code, 40);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`Lịch sử chuyển vị trí dòng ${index + 1} thiếu mã dòng`);
      if (!/^\d{6,40}$/.test(code)) throw new Error(`Lịch sử chuyển vị trí dòng ${index + 1} có Group UID không hợp lệ`);
      const warehouseId = raw?.warehouse_id == null || raw.warehouse_id === "" ? NaN : Number(raw.warehouse_id);
      unique.set(id, {
        history_id: id,
        group_uid_code: code,
        warehouse_id: Number.isInteger(warehouseId) ? warehouseId : null,
        warehouse: clean(raw?.warehouse_name ?? raw?.warehouse, 240) || null,
        action_code: Number.isFinite(actionCode) ? actionCode : TRANSFER_ACTION,
        action_name: actionName || "Transfer location",
        from_location: clean(raw?.old_location_description ?? raw?.old_location, 240) || null,
        to_location: clean(raw?.location_description ?? raw?.location, 240) || null,
        moved_by: clean(raw?.updated_by_name ?? raw?.updated_by ?? raw?.created_by_name, 240) || null,
        moved_at: isoDate(raw?.updated_at_tz ?? raw?.updated_at ?? raw?.created_at_tz ?? raw?.created_at),
      });
    });
    return { rows: [...unique.values()], total: responseTotal(payload, source.length), sourceRows: source.length };
  }

  // Group UID trạng thái New (status_id 1) để chọn in tem. Dòng group-uid-infos có created_by_name / created_at_tz; UID mới chưa có SKU/sản phẩm
  // (đo 14/10/2026: 5.590 UID New ở hai kho WH - MATERIAL, 0 UID có products), một phần đã có batch_code/roll_code.
  const NEW_STATUS_ID = 1;

  function normalizeNewUidPage(payload) {
    const source = responseRows(payload);
    const unique = new Map();
    source.forEach((raw, index) => {
      const status = clean(raw?.status_name ?? raw?.status, 100);
      if (Number(raw?.status_id) !== NEW_STATUS_ID && !/^new$/i.test(status)) return;
      const code = clean(raw?.group_uid_code, 40);
      if (!/^\d{6,40}$/.test(code)) throw new Error(`UID mới dòng ${index + 1} có Group UID không hợp lệ`);
      const created = raw?.created_at_tz ?? raw?.created_at;
      const warehouseId = raw?.warehouse_id == null || raw.warehouse_id === "" ? NaN : Number(raw.warehouse_id);
      unique.set(code, {
        group_uid_code: code,
        warehouse_id: Number.isInteger(warehouseId) ? warehouseId : null,
        warehouse: clean(raw?.warehouse_name ?? raw?.warehouse, 240) || null,
        type: clean(raw?.group_uid_type_name, 80) || null,
        created_by: clean(raw?.created_by_name ?? raw?.created_by, 240) || null,
        created_at: isoDate(created),
        updated_at: isoDate(raw?.updated_at_tz ?? raw?.updated_at ?? created),
        location: clean(raw?.location_description ?? raw?.location, 240) || null,
        batch_code: clean(raw?.batch_code, 120) || null,
        roll_code: clean(raw?.roll_code, 120) || null,
      });
    });
    return { rows: [...unique.values()], total: responseTotal(payload, source.length), sourceRows: source.length };
  }

  // Packing List PO của WMS (inbound-packing-lists): mỗi dòng là một cuộn của PO. SKU thường là Combo (kg), mã cuộn `code`, Lot `batch_code`.
  // Mỗi dòng Approved là một cuộn, kể cả dòng quantity 1 / code "1" (chốt 14/10/2026); việc đếm UID do trang làm.
  function normalizePackingListPage(payload) {
    const source = responseRows(payload);
    const rows = source.map((raw, index) => {
      const purchaseOrder = clean(raw?.purchase_order_number, 40), sku = clean(raw?.sku, 40), quantity = Number(raw?.quantity);
      if (!/^\d{6,40}$/.test(purchaseOrder)) throw new Error(`Packing List dòng ${index + 1} có mã PO không hợp lệ`);
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error(`Packing List dòng ${index + 1} có SKU không hợp lệ`);
      if (!Number.isFinite(quantity) || quantity < 0) throw new Error(`Packing List dòng ${index + 1} có số lượng không hợp lệ`);
      return {
        purchase_order: purchaseOrder,
        shipment: clean(raw?.inbound_shmt_number, 40) || null,
        sku,
        product_name: clean(raw?.product_name, 300) || null,
        quantity,
        code: clean(raw?.code, 60) || null,
        batch_code: clean(raw?.batch_code, 120) || null,
        status: clean(raw?.status_name, 60) || null,
        delivery: clean(raw?.delivery_method, 30) || null,
        // 0.10.3: cuộn đã tạo Group UID (WMS trả số) — trang IN TEM GROUP UID bỏ cuộn này khi gán tem. WMS BỎ HẲN khoá group_uid_code khi cuộn
        // chưa có UID (đo 21/10/2026: PO 79 dòng = 26 có khoá + 53 không khoá), nên thiếu khoá = chưa có UID. Khoá group_uid luôn có (null khi chưa có UID)
        // để trang phân biệt với Extension cũ không trả khoá.
        group_uid: raw?.group_uid_code == null ? null : clean(String(raw.group_uid_code), 40) || null,
      };
    });
    return { rows, total: responseTotal(payload, source.length), sourceRows: source.length };
  }

  // Group UID của một PO (CẮT GROUP UID · lấy mẫu cắt/QC, 16/10/2026): WMS lọc theo `processing_source_code` (số PO) và các tên tham số
  // khác bị BỎ QUA IM LẶNG (đã đo: purchase_order_number(s), keyword… đều trả cả kho) nên kiểm lại số PO của TỪNG dòng — lệch thì báo
  // lỗi thay vì trộn UID của PO khác vào phiên. Giữ nguyên quy tắc dòng của normalizeRow, thêm số PO nguồn và loại nguồn.
  function normalizePoGroupUidPage(payload, purchaseOrder) {
    const source = responseRows(payload);
    const unique = new Map();
    source.forEach((raw, index) => {
      const sourceCode = clean(raw?.processing_source_code, 60);
      if (sourceCode !== purchaseOrder) throw new Error(`Group UID ${clean(raw?.group_uid_code) || index + 1} thuộc nguồn "${sourceCode || "trống"}", không phải PO ${purchaseOrder}`);
      const row = normalizeRow(raw, index);
      unique.set(row.group_uid_code, { ...row, purchase_order: sourceCode, source_type: clean(raw?.processing_source_type, 40) || null });
    });
    return { rows: [...unique.values()], total: responseTotal(payload, source.length), sourceRows: source.length };
  }

  // Các ASN (đợt nhận hàng) của một PO: lọc bằng `purchase_order_numbers` (SỐ NHIỀU); cũng kiểm số PO từng dòng.
  function normalizePoAsnPage(payload, purchaseOrder) {
    const source = responseRows(payload);
    const rows = source.map((raw, index) => {
      const order = clean(raw?.purchase_order_number, 60);
      if (order !== purchaseOrder) throw new Error(`ASN dòng ${index + 1} thuộc "${order || "trống"}", không phải PO ${purchaseOrder}`);
      const asnId = Number(raw?.asn_id), asnNumber = clean(raw?.asn_number, 40);
      if (!Number.isInteger(asnId) || asnId <= 0 || !/^\d{6,40}$/.test(asnNumber)) throw new Error(`ASN dòng ${index + 1} không hợp lệ`);
      let createdAt = null;
      try { createdAt = isoDate(raw?.created_at_tz ?? raw?.created_at); } catch { createdAt = null; }
      return {
        asn_id: asnId,
        asn_number: asnNumber,
        type: clean(raw?.asn_type, 40) || null,
        status: clean(raw?.status_name, 60) || null,
        shipment: clean(raw?.inbound_shmt_number, 40) || null,
        warehouse: clean(raw?.warehouse_name, 240) || null,
        created_at: createdAt,
      };
    });
    return { rows, total: responseTotal(payload, source.length), sourceRows: source.length };
  }

  // Phiếu IT (chuyển kho nội bộ) cho IN TEM SKU: đầu phiếu từ internal-transfers, các dòng từ transfer/internal-transfer-items/list-details
  // (WMS trả hết các dòng một lần). Mỗi dòng: SKU, tên, số lượng theo đơn vị SKU (pcs / mm / g …, có phiếu không ghi đơn vị).
  function normalizeInternalTransfer(head, itemsPayload) {
    const number = clean(head?.internal_transfer_number, 40), id = Number(head?.internal_transfer_id);
    if (!/^\d{6,40}$/.test(number) || !Number.isInteger(id) || id <= 0) throw new Error("Phiếu IT trả về không hợp lệ");
    const items = responseRows(itemsPayload).map((raw, index) => {
      const sku = clean(raw?.sku, 40), quantity = Number(raw?.quantity);
      if (!/^[A-Za-z0-9._-]{1,40}$/.test(sku)) throw new Error(`Phiếu IT dòng ${index + 1} có SKU không hợp lệ`);
      if (raw?.quantity === null || raw?.quantity === "" || !Number.isFinite(quantity) || quantity < 0) throw new Error(`Phiếu IT dòng ${index + 1} có số lượng không hợp lệ`);
      return { sku, name: clean(raw?.product_name, 300) || null, quantity, unit: clean(raw?.uom, 20) || null };
    });
    const created = head?.created_at_tz ?? head?.created_at;
    let createdAt = null;
    try { createdAt = created ? isoDate(created) : null; } catch { createdAt = null; }
    return {
      number, id,
      status: clean(head?.status_name, 60) || null,
      type: clean(head?.type_name, 60) || null,
      fromWarehouse: clean(head?.from_warehouse_name, 240) || null,
      toWarehouse: clean(head?.to_warehouse_name, 240) || null,
      description: clean(head?.description, 500) || null,
      createdBy: clean(head?.created_user_name, 240) || null,
      createdAt,
      totalItems: Number(head?.total_it_items) || items.length,
      items,
    };
  }

  globalThis.HasakiGroupUidSyncCore = Object.freeze({ clean, normalizeRow, normalizePage, normalizeHistoryPage, normalizeMovesPage, normalizeNewUidPage, normalizePackingListPage, normalizeInternalTransfer, responseRows, responseTotal, normalizePoGroupUidPage, normalizePoAsnPage });
})();
