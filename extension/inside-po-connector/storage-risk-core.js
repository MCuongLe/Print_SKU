// Tự động RỦI RO LƯU TRỮ (Extension 0.10.7, 22/10/2026): Kiểm kê 2 kho (Hàng chưa lên kệ) rồi UID tạm, bằng phiên Admin của Extension.
// Chép ĐÚNG luồng nút sr-run của web: run() trong <script id="inventory-audit-script"> (GET_SKU_COUNT_WAREHOUSES →
// GET_SKU_COUNT_APPROVED_PAGE / GET_SKU_COUNT_INVENTORY_PAGE theo từng kho + pháp nhân → reconcile → sku_count_save_start/chunk/finish),
// rồi run() trong <script id="storage-risk-temp-script"> (GET_SKU_COUNT_WAREHOUSES → GET_STOCK_IMPORT_EXPORT_PAGE 90 ngày → lọc
// "Tạo UID Temp" → uid_temp_save). Như web: Kiểm kê lỗi thì UID tạm VẪN chạy; mỗi bước lỗi thì không ghi phần của bước đó.
// Khác web (cố ý): không PING_WMS (auto-sync tự tìm/ghim tab); kiểm kiểu dữ liệu trang trước khi dùng; hết hai bước mà có bước lỗi
// thì NÉM (error.result giữ kết quả từng bước) để auto-sync ghi "Lỗi". Test: tests/storage_risk_core.cjs so với chính mã web.
//
// Hợp đồng (người gọi = auto-sync.js):
//   run({ sendTab, rpc, now, onProgress }) → Promise<{ ok:true, skuCount, uidTemp }>
//     skuCount = { ok:true, runId, rows, summary:{total,never,overdue,recent,qty}, warehouses:[tên kho], missing:[tên kho],
//                  stockRows, approvedRows, held }
//     uidTemp  = { ok:true, runId, rows, scanned, pages, warn:[…], readAt }
//   Có bước lỗi → ném Error(message = "Kiểm kê: … · UID tạm: …"), error.result = { ok:false, skuCount, uidTemp } (bước lỗi là
//   { ok:false, error, code }), error.code / error.fromTab = của lỗi đầu tiên.
//   * sendTab(type, payload) → Promise<data> tới tab WMS (GET_SKU_COUNT_WAREHOUSES, GET_SKU_COUNT_APPROVED_PAGE,
//     GET_SKU_COUNT_INVENTORY_PAGE, GET_STOCK_IMPORT_EXPORT_PAGE); lỗi / không có tab / quá giờ thì NÉM.
//   * rpc(name, args) → Promise<data>: POST /rest/v1/rpc/<name> với JWT Admin của Extension; HTTP lỗi → ném result.message hoặc
//     "Supabase HTTP <status>"; {ok:false,error} → ném error.message; {ok:true,data} → trả data (giống adminRpc của web).
//   * now(): epoch ms (mặc định Date.now); onProgress({step:"skuCount"|"uidTemp", label, page, pages} | {step:"skuCount",
//     phase:"save", done, total}) tuỳ chọn.
(function (root) {
  const DAY = 86400000;
  const PAGE_SIZE = 500;
  const CHUNK_ROWS = 500;
  const MAX_PAGES = 2000;
  const RANGE_DAYS = 90;
  const REQUESTED_WAREHOUSES = ["WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT"];
  const WANT = [
    { key: "mtg", name: "WH - MATERIAL - MTG", test: /MATERIAL\s*-\s*MTG/i },
    { key: "garment", name: "WH - MATERIAL - GARMENT", test: /MATERIAL\s*-\s*GARMENT/i },
  ];

  const num = value => Number(value || 0).toLocaleString("vi-VN");
  const shortWh = n => String(n || "").replace(/^WH\s*-\s*MATERIAL\s*-\s*/i, "") || String(n || "—");
  // Giờ WMS "yyyy-mm-dd hh:mm[:ss]" không kèm múi giờ là giờ VN (parseDate của Kiểm kê = timeOf của UID tạm).
  function parseDate(value) {
    const raw = String(value || "").trim();
    if (!raw) return NaN;
    return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}+07:00` : raw);
  }
  const isTempUid = r => r.kind === "in" && /^adjustment$/i.test(String(r.sourceType || "").trim()) && /uid\s*temp|temporary\s*uid/i.test(r.reason || "");

  // Bản chép reconcile của Kiểm kê (index.html): gộp tồn In-BIN theo kho + SKU + vị trí, lần APPROVED gần nhất, dòng In-BIN 0 mà tổng > 0
  // vào held (giữ chỗ). Trạng thái tính theo now (không vào payload lưu).
  function reconcile(inventoryRows, approvedRows, now = Date.now(), thresholdDays = 30) {
    const latest = new Map(), stock = new Map(), key = r => `${r.warehouseId}|${r.sku}`;
    for (const row of approvedRows) {
      const time = parseDate(row.approvedAt), k = key(row), old = latest.get(k);
      if (Number.isFinite(time) && (!old || time > old.time)) latest.set(k, { ...row, time });
    }
    const held = [];
    for (const row of inventoryRows) {
      const qty = Number(row.qty) || 0, total = Number(row.total) || 0;
      if (!row.sku) continue;
      const loc = row.location || "Chưa có vị trí";
      if (qty <= 0) {
        if (total > 0) held.push({ warehouseId: Number(row.warehouseId), warehouseName: row.warehouseName || "—", sku: String(row.sku), productName: row.productName || "", uom: row.uom || "", location: loc, total, modified: row.modified || "", created: row.created || "" });
        continue;
      }
      const k = key(row);
      let item = stock.get(k);
      if (!item) {
        item = { warehouseId: Number(row.warehouseId), warehouseName: row.warehouseName || "—", sku: String(row.sku), productName: row.productName || "", uom: row.uom || "", qty: 0, locations: new Map() };
        stock.set(k, item);
      }
      item.qty += qty;
      const cur = item.locations.get(loc) || { qty: 0, total: 0, modified: "", created: "" };
      cur.qty += qty; cur.total += Math.max(total, qty);
      if (row.modified && row.modified > cur.modified) cur.modified = row.modified;
      if (row.created && (!cur.created || row.created < cur.created)) cur.created = row.created;
      item.locations.set(loc, cur);
    }
    const rows = [...stock.entries()].map(([k, item]) => {
      const checked = latest.get(k), elapsed = checked ? Math.max(0, now - checked.time) : null, status = !checked ? "never" : elapsed > thresholdDays * DAY ? "overdue" : "recent";
      return {
        ...item, qty: Number(item.qty.toFixed(6)),
        locations: [...item.locations.entries()].map(([location, v]) => ({ location, qty: Number(v.qty.toFixed(6)), ...(v.total > v.qty ? { total: Number(v.total.toFixed(6)) } : {}), ...(v.modified ? { modified: v.modified } : {}), ...(v.created ? { created: v.created } : {}) })).sort((a, b) => b.qty - a.qty),
        lastApprovedAt: checked?.approvedAt || "", lastApprovedBy: checked?.approvedBy || "", daysSinceApproved: checked ? Math.floor(elapsed / DAY) : null, status,
      };
    }).sort((a, b) => ({ never: 0, overdue: 1, recent: 2 }[a.status] - ({ never: 0, overdue: 1, recent: 2 }[b.status]) || (b.daysSinceApproved ?? 1e9) - (a.daysSinceApproved ?? 1e9) || a.sku.localeCompare(b.sku)));
    const summary = rows.reduce((s, r) => (s.total++, s[r.status]++, s.qty += r.qty, s), { total: 0, never: 0, recent: 0, overdue: 0, qty: 0 });
    summary.qty = Number(summary.qty.toFixed(6));
    return { rows, summary, held };
  }

  function createRun({ sendTab, rpc, now, onProgress }) {
    const show = info => { if (onProgress) { try { onProgress(info); } catch { /* chỉ để hiển thị */ } } };
    const ask = async (type, payload, label) => {
      const data = await sendTab(type, payload);
      if (!data || typeof data !== "object" || (data.rows != null && !Array.isArray(data.rows))
        || (data.warehouses != null && !Array.isArray(data.warehouses))) throw new Error(`WMS trả ${label} không hợp lệ`);
      return data;
    };
    // readPages của web: trang 1 rồi từng lô 4 trang song song; mọi trang phải cùng totalPages; quá 2.000 trang thì dừng.
    // exact (chỉ Kiểm kê, 0.10.8 D2): thêm mọi trang cùng total với trang 1 và tổng số dòng WMS trả (sourceRows của từng trang,
    // trước khi lọc) phải bằng total. Danh sách tồn kho đổi giữa lúc đọc song song (nhận/xuất hàng trong giờ làm) làm dòng ở ranh trang
    // bị đọc 2 lần (cộng đôi tồn) hoặc bị sót mà totalPages không đổi. Trang thiếu sourceRows (Extension cũ) thì bỏ phép so số dòng.
    const drift = (label, detail) => Object.assign(new Error(`${label} thay đổi trong lúc đọc${detail ? ` (${detail})` : ""}; hãy chạy lại để tránh thiếu dữ liệu`), { drift: true, detail });
    async function readPages(step, type, payload, label, exact = false) {
      const first = await ask(type, { ...payload, page: 1, size: PAGE_SIZE }, label), pages = Math.max(1, Number(first.totalPages) || 1);
      if (pages > MAX_PAGES) throw new Error(`${label} có ${num(pages)} trang; dừng để tránh tải thiếu dữ liệu`);
      const rows = [...(first.rows || [])], total = Number(first.total), counted = item => Number.isInteger(item.sourceRows);
      let done = 1, seen = counted(first) ? first.sourceRows : NaN;
      show({ step, label, page: 1, pages });
      for (let start = 2; start <= pages; start += 4) {
        const pageNos = Array.from({ length: Math.min(4, pages - start + 1) }, (_, i) => start + i);
        const batch = await Promise.all(pageNos.map(page => ask(type, { ...payload, page, size: PAGE_SIZE }, label)));
        for (const item of batch) {
          if (Number(item.totalPages) !== pages) throw drift(label, "");
          if (exact && Number.isFinite(total) && Number(item.total) !== total) throw drift(label, `WMS báo ${num(total)} → ${num(item.total)} dòng`);
          rows.push(...(item.rows || []));
          seen = counted(item) ? seen + item.sourceRows : NaN;
          done++;
          show({ step, label, page: done, pages });
        }
      }
      if (exact && Number.isFinite(total) && Number.isFinite(seen) && seen !== total) throw drift(label, `WMS báo ${num(total)} dòng, đọc được ${num(seen)}`);
      return { rows, pages, total: total || rows.length };
    }
    // Kiểm kê (0.10.8 D2): lệch thì đọc lại cả danh sách đó, tối đa 2 lần (như readGroupUidSnapshot), vẫn lệch thì ném — không lưu bản sai.
    const RETRIES = 2;
    async function readExact(step, type, payload, label) {
      for (let attempt = 0; ; attempt += 1) {
        try { return await readPages(step, type, payload, label, true); } catch (error) {
          if (!error?.drift) throw error;
          if (attempt >= RETRIES) throw drift(label, `${error.detail ? `${error.detail}; ` : ""}đã đọc lại ${RETRIES} lần`);
        }
      }
    }
    async function readAcrossCompanies(type, warehouses, extra, label) {
      const out = { rows: [], pages: 0, total: 0 };
      for (const warehouse of warehouses) {
        const company = warehouse.companyName ? ` · ${warehouse.companyName}` : "";
        const part = await readExact("skuCount", type, { ...extra, warehouseIds: [warehouse.warehouseId], companyId: warehouse.companyId }, `${label} · ${warehouse.warehouseName}${company}`);
        out.rows.push(...part.rows); out.pages += part.pages; out.total += part.total;
      }
      return out;
    }

    // Kiểm kê SKU (run của inventory-audit-script).
    async function skuCount() {
      const meta = await ask("GET_SKU_COUNT_WAREHOUSES", { warehouseNames: REQUESTED_WAREHOUSES }, "danh sách kho"), warehouses = meta.warehouses || [];
      if (!warehouses.length) throw new Error(`Tài khoản WMS không có quyền xem ${REQUESTED_WAREHOUSES.join(" hoặc ")}`);
      const missing = meta.missingNames || [];
      const approved = await readAcrossCompanies("GET_SKU_COUNT_APPROVED_PAGE", warehouses, { from: "2020-01-01" }, "Lịch sử APPROVED");
      const inventory = await readAcrossCompanies("GET_SKU_COUNT_INVENTORY_PAGE", warehouses, {}, "Tồn kho theo vị trí");
      const result = reconcile(inventory.rows, approved.rows, now());
      if (!result.rows.length) throw new Error("WMS không trả SKU nào có tồn kho; giữ nguyên bản đồng bộ cũ.");
      const payload = result.rows.map(r => {
        const t = parseDate(r.lastApprovedAt);
        return { warehouse_id: r.warehouseId, warehouse_name: r.warehouseName, sku: r.sku, product_name: r.productName || null, qty: r.qty, uom: r.uom || null, locations: r.locations, last_approved_at: Number.isFinite(t) ? new Date(t).toISOString() : null, last_approved_by: r.lastApprovedBy || null };
      });
      show({ step: "skuCount", phase: "save", done: 0, total: payload.length });
      let started;
      try {
        started = await rpc("sku_count_save_start", { p_warehouses: warehouses.map(w => ({ warehouseId: w.warehouseId, warehouseName: w.warehouseName, companyName: w.companyName || "" })), p_missing: missing, p_source_counts: { stockRows: inventory.rows.length, approvedRows: approved.rows.length, heldTotal: result.held.length, held: result.held.slice(0, 500) } });
        for (let i = 0; i < payload.length; i += CHUNK_ROWS) {
          await rpc("sku_count_save_chunk", { p_run_id: started.runId, p_rows: payload.slice(i, i + CHUNK_ROWS) });
          show({ step: "skuCount", phase: "save", done: Math.min(payload.length, i + CHUNK_ROWS), total: payload.length });
        }
        await rpc("sku_count_save_finish", { p_run_id: started.runId });
      } catch (error) {
        throw carry(new Error(`Chưa lưu được bản đồng bộ: ${/Failed to fetch|NetworkError|Timeout|aborted/i.test(String(error?.message)) ? "mất kết nối tới Supabase, kiểm tra mạng rồi bấm lại" : error.message}`), error);
      }
      return { ok: true, runId: started?.runId ?? null, rows: payload.length, summary: result.summary, warehouses: warehouses.map(w => w.warehouseName), missing, stockRows: inventory.rows.length, approvedRows: approved.rows.length, held: result.held.length };
    }

    // UID tạm (run của storage-risk-temp-script).
    async function uidTemp() {
      let rows, warehouses, warn, scanned = 0, pages = 0, to;
      try {
        const meta = await ask("GET_SKU_COUNT_WAREHOUSES", { warehouseNames: WANT.map(w => w.name) }, "danh sách kho");
        const found = WANT.map(w => ({ w, wh: (meta.warehouses || []).find(x => w.test.test(x.warehouseName || "")) }));
        const missing = found.filter(f => !f.wh).map(f => f.w.name);
        if (missing.length === found.length) throw new Error(`Tài khoản WMS không thấy kho: ${missing.join(", ")}`);
        to = now();
        const from = to - RANGE_DAYS * DAY, seen = new Set(), gaps = [];
        rows = []; warehouses = [];
        for (const { w, wh } of found) {
          if (!wh) continue;
          const moves = await readPages("uidTemp", "GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [wh.warehouseId], companyId: wh.companyId, from, to }, `${shortWh(wh.warehouseName)} nhập xuất`);
          scanned += moves.rows.length; pages += moves.pages; warehouses.push(wh);
          if (moves.total > moves.rows.length) gaps.push(`${wh.warehouseName}: WMS báo ${num(moves.total)} dòng, đọc được ${num(moves.rows.length)}`);
          for (const m of moves.rows) {
            if (!m || typeof m !== "object" || !isTempUid(m)) continue;
            const key = m.id ? `${wh.warehouseId}|${m.id}` : "";
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            rows.push({ wh: w.key, warehouseName: wh.warehouseName, sku: String(m.sku || ""), productName: m.productName || "", qty: Number(m.qty) || 0, sourceCode: m.sourceCode || "", mappingId: m.mappingId || "", createdBy: m.createdBy || "", at: parseDate(m.createdAt) });
          }
        }
        rows.sort((a, b) => (Number.isFinite(b.at) ? b.at : -Infinity) - (Number.isFinite(a.at) ? a.at : -Infinity) || a.sku.localeCompare(b.sku));
        warn = [...missing.map(n => `Chưa đọc được kho: ${n}`), ...gaps];
      } catch (error) {
        const m = String(error?.message || "");
        throw carry(new Error(/Failed to fetch|NetworkError|load failed/i.test(m) ? "WMS ngắt kết nối giữa chừng; tải lại tab WMS rồi bấm lại." : m || "Không đọc được dữ liệu."), error);
      }
      const readAt = new Date(to).toISOString();
      let saved;
      try {
        saved = await rpc("uid_temp_save", {
          p_run: { readAt, warehouses: warehouses.map(w => ({ warehouseId: w.warehouseId, warehouseName: w.warehouseName, companyName: w.companyName || "" })), warn, scanned, pages, rangeDays: RANGE_DAYS },
          p_rows: rows.map(r => ({ wh: r.wh, warehouseName: r.warehouseName, sku: r.sku, productName: r.productName, qty: r.qty, sourceCode: r.sourceCode, mappingId: r.mappingId, createdBy: r.createdBy, createdAt: Number.isFinite(r.at) ? new Date(r.at).toISOString() : null })),
        });
      } catch (error) {
        throw carry(new Error(`Đã đọc ${num(rows.length)} dòng nhưng chưa lưu được: ${error?.message || "lỗi không rõ"}`), error);
      }
      return { ok: true, runId: saved?.runId || null, rows: rows.length, scanned, pages, warn, readAt };
    }
    return { skuCount, uidTemp };
  }

  // Bọc lỗi giữ mã, lý do (reason: session/denied/network của cầu nối WMS) và cờ lỗi tab để auto-sync phân loại Bỏ qua / Lỗi (review 22/10, R4).
  function carry(wrapped, error) {
    if (error?.code) wrapped.code = error.code;
    if (error?.reason) wrapped.reason = error.reason;
    if (error?.fromTab) wrapped.fromTab = true;
    return wrapped;
  }

  async function run({ sendTab, rpc, now = () => Date.now(), onProgress } = {}) {
    if (typeof sendTab !== "function" || typeof rpc !== "function") throw new Error("Thiếu hàm gửi lệnh tab WMS hoặc gọi Supabase");
    const steps = createRun({ sendTab, rpc, now, onProgress });
    const failures = [];
    const attempt = async (fn, label) => {
      try { return await fn(); } catch (error) {
        const message = String(error?.message || "Lỗi không rõ");
        failures.push({ label, message, error });
        return { ok: false, error: message, ...(error?.code ? { code: error.code } : {}) };
      }
    };
    // Như sr-run: Kiểm kê trước; lỗi vẫn đọc tiếp UID tạm.
    const skuCount = await attempt(steps.skuCount, "Kiểm kê");
    const uidTemp = await attempt(steps.uidTemp, "UID tạm");
    if (!failures.length) return { ok: true, skuCount, uidTemp };
    const error = new Error(failures.map(f => `${f.label}: ${f.message}`).join(" · "));
    const first = failures[0].error;
    if (first?.code) error.code = first.code;
    // Chỉ coi cả lượt là "bỏ qua được" (auto-sync ghi Bỏ qua) khi MỌI bước lỗi đều là hết phiên / thiếu tab / cầu nối chưa sẵn sàng
    // và không bước nào đã lưu; có bước lỗi quyền (403), mạng hay hết giờ thì cả lượt là Lỗi (review Codex vòng 2).
    const skippable = e => Boolean(e?.fromTab) && e.code !== "TAB_TIMEOUT" && (e.reason === "session" || /_TAB_MISSING$|_BRIDGE_ERROR$/.test(String(e.code || "")));
    if (failures.every(f => skippable(f.error)) && !skuCount?.ok && !uidTemp?.ok) {
      error.fromTab = true;
      if (first?.reason) error.reason = first.reason;
    }
    error.result = { ok: false, skuCount, uidTemp };
    throw error;
  }

  const api = { run, reconcile, parseDate, isTempUid, REQUESTED_WAREHOUSES, RANGE_DAYS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StorageRiskCore = api;
})(typeof self !== "undefined" ? self : globalThis);
