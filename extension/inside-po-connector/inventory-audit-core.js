(() => {
  const DAY_MS = 86400000;
  const DEFAULT_WAREHOUSES = ["WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT"];

  const clean = (value, limit = 500) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const fold = value => clean(value).toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, " ").trim();
  const recordsOf = payload => Array.isArray(payload?.records) ? payload.records : Array.isArray(payload?.data) ? payload.data : [];
  const finite = value => Number.isFinite(Number(value)) ? Number(value) : 0;
  const keyOf = (warehouseId, sku) => `${clean(warehouseId, 30)}|${clean(sku, 80)}`;

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
    const rows = sourceRows.map(row => ({
      inventoryId: Number(row.inventory_id) || null,
      warehouseId: Number(row.warehouse_id),
      warehouseName: clean(row.warehouse_name, 160),
      sku: clean(row.sku, 80),
      productName: clean(row.product_name, 500),
      location: clean(row.location_description, 160),
      qty: finite(row.qty),
      uom: clean(row.uom, 40),
    })).filter(row => Number.isInteger(row.warehouseId) && row.sku && row.qty > 0);
    return { rows, sourceRows: sourceRows.length, total: Math.max(sourceRows.length, finite(payload?.count)), page: Math.max(1, finite(payload?.page) || 1), size: Math.max(1, finite(payload?.size) || 500) };
  }

  function parseWmsDate(value) {
    const raw = clean(value, 80);
    if (!raw) return NaN;
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw)
      ? `${raw.replace(" ", "T")}+07:00`
      : raw;
    return Date.parse(normalized);
  }

  function reconcile(inventoryRows, approvedRows, now = Date.now(), thresholdDays = 30) {
    const thresholdMs = Math.max(1, Number(thresholdDays) || 30) * DAY_MS;
    const latest = new Map();
    for (const row of approvedRows || []) {
      const key = keyOf(row.warehouseId, row.sku), time = parseWmsDate(row.approvedAt);
      if (!key || !Number.isFinite(time)) continue;
      const current = latest.get(key);
      if (!current || time > current.time) latest.set(key, { ...row, time });
    }
    const stock = new Map();
    for (const row of inventoryRows || []) {
      const qty = finite(row.qty);
      if (qty <= 0 || !clean(row.sku)) continue;
      const key = keyOf(row.warehouseId, row.sku);
      let item = stock.get(key);
      if (!item) {
        item = { warehouseId: Number(row.warehouseId), warehouseName: clean(row.warehouseName, 160), sku: clean(row.sku, 80), productName: clean(row.productName, 500), qty: 0, uom: clean(row.uom, 40), locations: new Map() };
        stock.set(key, item);
      }
      item.qty += qty;
      if (!item.productName && row.productName) item.productName = clean(row.productName, 500);
      const location = clean(row.location, 160) || "Chưa có vị trí";
      item.locations.set(location, (item.locations.get(location) || 0) + qty);
    }
    const rows = [...stock.entries()].map(([key, item]) => {
      const checked = latest.get(key), elapsedMs = checked ? Math.max(0, Number(now) - checked.time) : null;
      const status = !checked ? "never" : elapsedMs > thresholdMs ? "overdue" : "recent";
      return {
        ...item,
        qty: Number(item.qty.toFixed(6)),
        locations: [...item.locations.entries()].map(([location, qty]) => ({ location, qty: Number(qty.toFixed(6)) })).sort((a, b) => b.qty - a.qty || a.location.localeCompare(b.location, "vi")),
        lastApprovedAt: checked?.approvedAt || "",
        lastApprovedBy: checked?.approvedBy || "",
        daysSinceApproved: checked ? Math.floor(elapsedMs / DAY_MS) : null,
        status,
      };
    }).sort((a, b) => ({ never: 0, overdue: 1, recent: 2 }[a.status] - ({ never: 0, overdue: 1, recent: 2 }[b.status]) || (b.daysSinceApproved ?? 1e9) - (a.daysSinceApproved ?? 1e9) || a.sku.localeCompare(b.sku)));
    const summary = rows.reduce((out, row) => { out.total += 1; out[row.status] += 1; out.qty += row.qty; return out; }, { total: 0, never: 0, recent: 0, overdue: 0, qty: 0 });
    summary.qty = Number(summary.qty.toFixed(6));
    return { rows, summary, thresholdDays: thresholdMs / DAY_MS, generatedAt: new Date(Number(now)).toISOString() };
  }

  globalThis.HasakiInventoryAuditCore = Object.freeze({ DEFAULT_WAREHOUSES, clean, fold, selectWarehouses, normalizeApprovedPage, normalizeInventoryPage, parseWmsDate, reconcile });
})();
