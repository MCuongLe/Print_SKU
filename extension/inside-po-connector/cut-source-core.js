// Nguồn phiếu của từng lần Cut (Đối chiếu ADJ · CẮT GROUP UID, 26/10/2026, kế hoạch docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md).
// Dòng Cut của WMS không mang số phiếu: ghép bằng SKU + tổng số lượng + giờ với dòng XUẤT (type 2) của báo cáo Import/Export kho
// WH - MATERIAL - MTG có nguồn ADJUSTMENT (phiếu ADJ, "xuất test" khi lý do Xuất test) hoặc INTERNAL_TRANSFER (phiếu IT, chuyển nội bộ).
// Dùng chung: Extension (cut-adj-core.js, lượt tự động) và web (index.html chép NGUYÊN VĂN tệp này vào khối script id "cut-source-core",
// nút Đọc WMS của tab Đối chiếu ADJ). Test: tests/cut_source_core.cjs (gồm so khớp hai bản), tests/cut_adj_core.cjs.
//
// matchCutsToDocs(cuts, docs) → mảng cùng độ dài cuts: phần tử i = phiếu (chính đối tượng trong docs) hoặc null (Chưa rõ).
//   cuts: [{ sku, at, qty }], docs: [{ sku, at, qty, type: "ADJ" | "IT" }]; at = mili giây hoặc chuỗi ngày (không múi giờ = giờ VN).
//   Theo từng SKU: Cut sắp theo giờ, phiếu duyệt theo giờ; mỗi phiếu lấy dãy Cut liền kề CHƯA gán có tổng = số lượng phiếu (thử dãy
//   cuối trước, rồi dãy đầu) trong khung giờ phiếu − 14 ngày ≤ Cut ≤ giờ phiếu + 2 phút. Mơ hồ: nhả dãy của phiếu P mà phiếu Q khác
//   (kể cả khác loại) lấy được một Cut của P → cả dãy của P lẫn dãy của Q đều null (không ghi nửa dãy: lượt sau P đã dùng bị bỏ qua
//   nên Q sẽ lấy đúng Cut đang tranh chấp). Phiếu đến sau không xét lại Cut đã ghi nguồn ở lượt trước.
//
// assignSources({ sendTab, rpc, now, onProgress }) → Promise<{ unresolved, docs, matched, written, skipped, adj, it, notFound, truncated }>
//   1. rpc wms_group_uid_cut_unresolved {p_days: 30} → { cuts:[{groupUid,cutAt,qty,sku}], used:[{sku,type,at}], truncated }.
//   2. Không có Cut chưa nguồn → dừng, không đọc WMS.
//   3. sendTab GET_STOCK_IMPORT_EXPORT_PAGE {warehouseIds:[1177], from: Cut sớm nhất − 1 ngày, to: now, page, size: 500} tới hết trang
//      (phiếu luôn sau Cut nên không cần đọc trước đó); mọi trang cùng total / totalPages, không trang lặp, số dòng không trùng = total.
//   4. Bỏ phiếu đã gán cho Cut khác (used: SKU + loại + giờ phiếu) và phiếu sau to − 2 phút (để lượt sau) rồi ghép.
//   5. sendTab GET_WMS_DOC_INFO {adj:[mapping…], it:[mapping…]} (≤ 20 mỗi loại / lần) → số phiếu 1008… / 1007…, lý do, PO / kho nhận + mô tả;
//      phiếu ADJ có detailFailed (chi tiết lỗi tạm, chưa biết PO) coi như chưa tra được.
//   6. rpc wms_group_uid_cut_set_source {p_rows} (≤ 5.000 dòng / lần), chỉ Cut có phiếu tra được số; phiếu chưa tra được để lượt sau.
//   Lỗi đọc / ghi → ném nguyên lỗi (giữ code / reason của lỗi tab).
(function (root) {
  const DAY = 86400000, MINUTE = 60000;
  const BEFORE_MS = 14 * DAY, AFTER_MS = 2 * MINUTE;
  const SOURCE_DAYS = 30, READ_BACK_MS = DAY, WAREHOUSE_ID = 1177, PAGE_SIZE = 500, MAX_PAGES = 100;
  const INFO_CHUNK = 20, WRITE_CHUNK = 5000, NOTE_MAX = 200, EPS = 1e-6;
  const TYPES = { ADJUSTMENT: "ADJ", INTERNAL_TRANSFER: "IT" };
  const CODE = /^\d{6,40}$/;

  const clean = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  function timeOf(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    const raw = String(value ?? "").trim();
    if (!raw) return NaN;
    return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw) ? `${raw.replace(" ", "T")}+07:00` : raw);
  }
  const fits = (cutAt, docAt) => cutAt >= docAt - BEFORE_MS && cutAt <= docAt + AFTER_MS;

  // Dãy Cut liền kề (trong các Cut free của khung phiếu) có tổng = số lượng phiếu: dãy cuối trước, rồi dãy đầu. Trả chỉ số trong cs.
  function findRun(cs, d, free) {
    const pick = [];
    for (let k = 0; k < cs.length; k += 1) if (fits(cs[k].at, d.at) && free(k)) pick.push(k);
    let sum = 0;
    for (let n = pick.length - 1; n >= 0; n -= 1) {
      sum += cs[pick[n]].qty;
      if (Math.abs(sum - d.qty) < EPS) return pick.slice(n);
      if (sum > d.qty) break;
    }
    sum = 0;
    for (let n = 0; n < pick.length; n += 1) {
      sum += cs[pick[n]].qty;
      if (Math.abs(sum - d.qty) < EPS) return pick.slice(0, n + 1);
      if (sum > d.qty) break;
    }
    return null;
  }

  function matchCutsToDocs(cuts, docs) {
    const list = Array.isArray(cuts) ? cuts : [], result = list.map(() => null), groups = new Map();
    list.forEach((cut, index) => {
      const sku = clean(cut?.sku, 80), at = timeOf(cut?.at), qty = Number(cut?.qty);
      if (!sku || !Number.isFinite(at) || !Number.isFinite(qty) || qty <= 0) return;
      if (!groups.has(sku)) groups.set(sku, { cs: [], ds: [] });
      groups.get(sku).cs.push({ index, at, qty });
    });
    (Array.isArray(docs) ? docs : []).forEach((doc, index) => {
      const sku = clean(doc?.sku, 80), at = timeOf(doc?.at), qty = Number(doc?.qty);
      if (!groups.has(sku) || (doc.type !== "ADJ" && doc.type !== "IT") || !Number.isFinite(at) || !Number.isFinite(qty) || qty <= 0) return;
      groups.get(sku).ds.push({ index, at, qty, doc });
    });
    for (const { cs, ds } of groups.values()) {
      if (!ds.length) continue;
      cs.sort((a, b) => a.at - b.at || a.index - b.index);
      ds.sort((a, b) => a.at - b.at || a.index - b.index);
      const owner = cs.map(() => -1), runs = new Map();
      ds.forEach((d, p) => {
        const run = findRun(cs, d, k => owner[k] < 0);
        if (run) { runs.set(p, run); run.forEach(k => { owner[k] = p; }); }
      });
      const dropDocs = new Set();
      for (const [p, run] of runs) {
        const mine = new Set(run);
        ds.forEach((d, q) => {
          if (q === p || !run.some(k => fits(cs[k].at, d.at))) return;
          const alt = findRun(cs, d, k => owner[k] < 0 || owner[k] === p || owner[k] === q);
          if (alt && alt.some(k => mine.has(k))) { dropDocs.add(p); dropDocs.add(q); }
        });
      }
      for (const [p, run] of runs) if (!dropDocs.has(p)) for (const k of run) result[cs[k].index] = ds[p].doc;
    }
    return result;
  }

  // Dòng Import/Export (đã chuẩn hoá bởi wms-bridge normalizeImportExportPage) → phiếu xuất ADJ / IT của kho 1177, hoặc null.
  function docOf(row) {
    if (!row || typeof row !== "object" || row.kind !== "out" || Number(row.warehouseId) !== WAREHOUSE_ID) return null;
    const type = TYPES[clean(row.sourceType, 40).toUpperCase()], sku = clean(row.sku, 80), at = timeOf(row.createdAt), qty = Number(row.qty);
    if (!type || !sku || !Number.isFinite(at) || !Number.isFinite(qty) || qty <= 0) return null;
    const mapping = clean(row.mappingId, 60);
    return { type, sku, at, qty, mapping: CODE.test(mapping) ? mapping : "", reason: clean(row.reason, 120) };
  }
  const usedKey = (sku, type, at) => `${sku}|${type}|${at}`;

  // Đọc đủ dòng (review 26/10/2026): mọi trang cùng total / totalPages; trang có cùng danh sách khoá dòng với trang trước = WMS bỏ qua tham số
  // page → ném; cuối vòng số dòng không trùng = tổng sourceRows (số dòng WMS trả ở trang, trước khi lọc; thiếu thì số dòng đã chuẩn hoá)
  // trừ dòng trùng khoá phải bằng total — thiếu một dòng phiếu ADJ mà dòng IT còn thì Cut bị ghép sai và không bao giờ sửa.
  // Khoá dòng = id; dòng không có id (normalizeImportExportPage cho id null) dùng khoá ghép từ các trường (vòng 2). Nhiều trang có dòng không
  // id mà trang thiếu sourceRows (dòng bị lọc không đếm được) thì không chắc đủ dòng → ném (fail-closed).
  const rowKey = row => {
    if (!row || typeof row !== "object") return "";
    if (row.id != null && String(row.id) !== "") return `id:${row.id}`;
    return `f:${["kind", "sourceType", "sourceCode", "mappingId", "sku", "qty", "createdAt", "warehouseId"].map(k => String(row[k] ?? "")).join("|")}`;
  };
  async function readMoves(sendTab, from, to, show) {
    const rows = [], seen = new Set();
    let pages = 1, total = NaN, read = 0, lastSig = "", noId = false, counted = true;
    for (let page = 1; page <= pages; page += 1) {
      show({ phase: "source", step: "moves", page, pages });
      const data = await sendTab("GET_STOCK_IMPORT_EXPORT_PAGE", { warehouseIds: [WAREHOUSE_ID], from, to, page, size: PAGE_SIZE });
      if (!data || typeof data !== "object" || !Array.isArray(data.rows)) throw new Error(`WMS trả trang Import/Export ${page} không hợp lệ`);
      const count = Math.max(1, Number(data.totalPages) || 1);
      if (page === 1) {
        pages = count; total = Number(data.total);
        if (pages > MAX_PAGES) throw new Error(`Báo cáo Import/Export vượt ${MAX_PAGES} trang; dừng ghép nguồn phiếu`);
      } else if (count !== pages || Number(data.total) !== total) throw new Error("Báo cáo Import/Export thay đổi trong lúc đọc; hãy chạy lại");
      const keys = data.rows.map(rowKey), sig = keys.filter(Boolean).join(",");
      if (page > 1 && sig && sig === lastSig) throw new Error("WMS trả lặp lại cùng một trang Import/Export; hãy chạy lại");
      lastSig = sig;
      if (keys.some(k => k.startsWith("f:"))) noId = true;
      if (Number.isInteger(data.sourceRows) && data.sourceRows >= 0) read += data.sourceRows;
      else { read += data.rows.length; counted = false; }
      data.rows.forEach((row, i) => {
        if (keys[i] && seen.has(keys[i])) { read -= 1; return; }
        if (keys[i]) seen.add(keys[i]);
        rows.push(row);
      });
    }
    if (pages > 1 && noId && !counted) throw new Error("Báo cáo Import/Export có dòng không có mã dòng mà trang thiếu số dòng gốc: không kiểm được đủ dòng; hãy chạy lại");
    if (Number.isFinite(total) && read !== total) throw new Error(`Đọc được ${read}/${total} dòng Import/Export (${read < total ? "đọc thiếu" : "đọc thừa"}); hãy chạy lại`);
    return rows;
  }

  async function readDocInfo(sendTab, docs, show) {
    const info = { ADJ: new Map(), IT: new Map() };
    const adj = [...new Set(docs.filter(d => d.type === "ADJ" && d.mapping).map(d => d.mapping))];
    const it = [...new Set(docs.filter(d => d.type === "IT" && d.mapping).map(d => d.mapping))];
    const rounds = Math.max(Math.ceil(adj.length / INFO_CHUNK), Math.ceil(it.length / INFO_CHUNK));
    for (let i = 0; i < rounds; i += 1) {
      show({ phase: "source", step: "docs", part: i + 1, parts: rounds });
      const ask = { adj: adj.slice(i * INFO_CHUNK, (i + 1) * INFO_CHUNK), it: it.slice(i * INFO_CHUNK, (i + 1) * INFO_CHUNK) };
      const data = await sendTab("GET_WMS_DOC_INFO", ask);
      if (!data || typeof data !== "object" || !Array.isArray(data.adj) || !Array.isArray(data.it)) throw new Error("WMS trả thông tin phiếu ADJ / IT không hợp lệ");
      for (const row of data.adj) {
        const key = clean(row?.mappingCode, 60), number = clean(row?.number, 40);
        // detailFailed (vòng 2): chi tiết ADJ lỗi tạm nên chưa biết PO → coi như chưa tra được (không ghi, đếm notFound), lượt sau thử lại;
        // set_source chỉ ghi Cut chưa nguồn nên ghi PO rỗng bây giờ là mất PO vĩnh viễn.
        if (ask.adj.includes(key) && CODE.test(number) && row?.detailFailed !== true) info.ADJ.set(key, { number, reason: clean(row?.reason, 120), po: clean(row?.po, NOTE_MAX) });
      }
      for (const row of data.it) {
        const key = clean(row?.mappingId, 60), number = clean(row?.number, 40);
        if (ask.it.includes(key) && CODE.test(number)) info.IT.set(key, { number, reason: "", toWarehouse: clean(row?.toWarehouse, 160), description: clean(row?.description, 500) });
      }
    }
    return info;
  }
  const noteOf = (type, found) => (type === "ADJ" ? found.po : [found.toWarehouse, found.description].filter(Boolean).join(" · ").slice(0, NOTE_MAX)) || null;

  async function assignSources({ sendTab, rpc, now = () => Date.now(), onProgress } = {}) {
    if (typeof sendTab !== "function" || typeof rpc !== "function") throw new Error("Thiếu hàm gửi lệnh tab WMS hoặc gọi Supabase");
    const show = info => { if (typeof onProgress === "function") { try { onProgress(info); } catch { /* chỉ để hiển thị */ } } };
    const open = await rpc("wms_group_uid_cut_unresolved", { p_days: SOURCE_DAYS });
    if (!open || typeof open !== "object" || !Array.isArray(open.cuts) || (open.used != null && !Array.isArray(open.used))) {
      throw new Error("Danh sách Cut chưa có nguồn phiếu không hợp lệ");
    }
    const cuts = open.cuts.map(c => ({ code: clean(c?.groupUid, 40), cutAt: typeof c?.cutAt === "string" ? c.cutAt : "", sku: clean(c?.sku, 80), qty: Number(c?.qty), at: timeOf(c?.cutAt) }))
      .filter(c => c.code && c.cutAt && c.sku && Number.isFinite(c.at) && Number.isFinite(c.qty) && c.qty > 0);
    const out = { unresolved: cuts.length, docs: 0, matched: 0, written: 0, skipped: 0, adj: 0, it: 0, notFound: 0, truncated: open.truncated === true };
    if (!cuts.length) return out;
    const to = Number(now()), from = Math.min(to, Math.min(...cuts.map(c => c.at)) - READ_BACK_MS);
    const used = new Set((open.used || []).map(u => usedKey(clean(u?.sku, 80), u?.type, timeOf(u?.at))));
    // Phiếu sát mốc đọc (vòng 2): Cut được ghép khi ≤ giờ phiếu + AFTER_MS, nên phiếu trong (to − AFTER_MS, to] có thể có Cut thật sau to (chưa
    // nạp) mà lấy nhầm một Cut cũ đang tự do → chỉ ghép phiếu at ≤ to − AFTER_MS; phiếu bị loại ghép ở lượt sau.
    const docs = (await readMoves(sendTab, from, to, show)).map(docOf).filter(d => d && d.at <= to - AFTER_MS && !used.has(usedKey(d.sku, d.type, d.at)));
    out.docs = docs.length;
    const matches = matchCutsToDocs(cuts, docs), picked = [...new Set(matches.filter(Boolean))];
    out.matched = matches.filter(Boolean).length;
    if (!picked.length) return out;
    const info = await readDocInfo(sendTab, picked, show), found = doc => (doc.mapping ? info[doc.type].get(doc.mapping) : null);
    out.notFound = picked.filter(doc => !found(doc)).length;
    const rows = [];
    matches.forEach((doc, i) => {
      const hit = doc && found(doc);
      if (!hit) return;
      rows.push({ group_uid_code: cuts[i].code, cut_at: cuts[i].cutAt, source_type: doc.type, source_code: hit.number,
        source_reason: hit.reason || doc.reason || null, source_at: new Date(doc.at).toISOString(), source_note: noteOf(doc.type, hit) });
    });
    out.adj = rows.filter(r => r.source_type === "ADJ").length;
    out.it = rows.length - out.adj;
    for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
      show({ phase: "source", step: "save", done: i, total: rows.length });
      const saved = await rpc("wms_group_uid_cut_set_source", { p_rows: rows.slice(i, i + WRITE_CHUNK) });
      out.written += Number(saved?.updated) || 0;
      out.skipped += Number(saved?.skipped) || 0;
    }
    return out;
  }

  const api = { matchCutsToDocs, assignSources, docOf, SOURCE_DAYS, BEFORE_MS, AFTER_MS, WAREHOUSE_ID };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CutSourceCore = api;
})(typeof self !== "undefined" ? self : globalThis);
