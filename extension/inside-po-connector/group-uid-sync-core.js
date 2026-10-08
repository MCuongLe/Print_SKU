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

  globalThis.HasakiGroupUidSyncCore = Object.freeze({ clean, normalizeRow, normalizePage, responseRows, responseTotal });
})();
