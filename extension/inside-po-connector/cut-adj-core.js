// Tự động Cắt Group UID · Đối chiếu ADJ (Extension 0.10.7, 22/10/2026): đọc lịch sử Cut kho WH - MATERIAL - MTG trên WMS rồi nạp
// wms_group_uid_cut_import bằng phiên Admin của Extension. Chép ĐÚNG luồng nút "Đọc WMS" của web (syncFromWms trong
// <script id="cut-adj-reconcile"> của index.html): cùng tham số trang, cùng phép kiểm, cùng gộp/sắp/chia phần, cùng payload RPC.
// Khác web (cố ý): tên tệp WMS_AUTO_<máy>_<giờ>[_i].json (web: WMS_API_WH_MATERIAL_…); mốc phủ lấy bằng rpc wms_cut_coverage
// (sync_auto_v2.sql, cùng biểu thức coverage với cut_group_uid_reconcile) thay vì bản đối chiếu đang mở trên màn; không PING_WMS
// (auto-sync tự tìm/ghim tab); kiểm kiểu dữ liệu trang trước khi dùng. Test: tests/cut_adj_core.cjs so payload với chính mã web.
//
// Hợp đồng (người gọi = auto-sync.js):
//   run({ sendTab, rpc, device, now, onProgress }) → Promise<{ total, cutRows, newRows, changedRows, unchangedRows,
//                                                               from, until, readFrom, to, full, parts }>
//   * sendTab(type, payload) → Promise<data>: gửi lệnh tới tab WMS (ở đây chỉ GET_GROUP_UID_HISTORY_PAGE), trả `data` của phản hồi
//     {ok:true,data}; phản hồi lỗi / không có tab / quá giờ thì NÉM (giữ error.code để auto-sync phân loại).
//   * rpc(name, args) → Promise<data>: POST `${url}/rest/v1/rpc/${name}` với apikey + Authorization: Bearer <JWT Admin của Extension>,
//     body = JSON args; HTTP lỗi hoặc thân không phải JSON → ném `result.message || "Supabase HTTP <status>"`; thân {ok:false,error}
//     → ném error.message; {ok:true,data} → trả `data` (giống adminRpc của web). Gọi: wms_cut_coverage {} → null | {from,until,…};
//     wms_group_uid_cut_import {p_file_name,p_file_sha256,p_total_rows,p_data_from,p_data_until,p_rows} → {cutRows,newRows,…}.
//   * device: tên máy (Tùy chọn Extension); now(): epoch ms (mặc định Date.now); onProgress({phase:"read",page,totalPages} |
//     {phase:"save",part,parts,rows}) tuỳ chọn.
//   * serverNow() (0.10.8, tuỳ chọn): epoch ms giờ server Supabase đã biết (auto-sync lấy từ meta.updatedAt / header Date của RPC);
//     khung đọc không có dòng thì p_data_until = min(to, serverNow) (D8). Thiếu / lỗi → to như cũ.
//   Lỗi đọc (trang lặp, tổng đổi giữa trang, đọc thiếu dòng, ngoài kho 1177, quá 400 trang, tab lỗi) → ném TRƯỚC mọi lần nạp.
//   Lỗi nạp ở phần i > 1 thì các phần trước đã nạp (như web; nạp lại chồng không nhân đôi: khoá UID + giờ Cut); từ 0.10.8 (R7) phần
//   i < cuối gửi p_data_until = cut_at dòng cuối của phần nên mốc phủ không nhảy qua phần chưa nạp.
//   Nguồn phiếu (26/10/2026): nạp xong thì gọi CutSourceCore.assignSources (cut-source-core.js, cùng hàm nút Đọc WMS của web gọi):
//   rpc wms_group_uid_cut_unresolved → sendTab GET_STOCK_IMPORT_EXPORT_PAGE (tới mốc to của lượt đọc lịch sử) / GET_WMS_DOC_INFO → rpc wms_group_uid_cut_set_source;
//   kết quả trả thêm `source` {unresolved, docs, matched, written, skipped, adj, it, notFound, truncated}. Bước này lỗi thì Cut đã nạp
//   vẫn giữ (lượt sau ghép lại vì Cut còn chưa có nguồn) nhưng run() NÉM "Đã nạp N dòng Cut; chưa gán được nguồn phiếu: …" (giữ
//   code / reason / fromTab của lỗi gốc, error.result = phần đã nạp) để auto-sync ghi Lỗi. sourceCore (tuỳ chọn) để test thay bộ ghép.
(function (root) {
  const WAREHOUSE_ID = "1177";
  const PAGE_SIZE = 500;
  const MAX_PAGES = 400;
  const PART_ROWS = 5000;
  const OVERLAP_MS = 30 * 60000;

  function stampOf(to) { return to.replace(/[-:.TZ]/g, "").slice(0, 14); }
  function fileName(device, stamp, index, parts) {
    const tag = String(device ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 30) || "EXT";
    return `WMS_AUTO_${tag}_${stamp}${parts > 1 ? `_${index + 1}` : ""}.json`;
  }
  async function sha256(value) {
    const digest = await root.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Giờ server (epoch ms) hoặc NaN khi không có / lỗi; mốc nhỏ hơn của hai chuỗi ISO (bỏ qua giá trị không phải ngày).
  function safeNow(serverNow) {
    if (typeof serverNow !== "function") return NaN;
    try { const at = Number(serverNow()); return Number.isFinite(at) ? at : NaN; } catch { return NaN; }
  }
  function minIso(iso, other) {
    const a = Date.parse(iso), b = typeof other === "number" ? other : Date.parse(other);
    return Number.isFinite(b) && (!Number.isFinite(a) || b < a) ? new Date(b).toISOString() : iso;
  }

  async function run({ sendTab, rpc, device = "", now = () => Date.now(), serverNow, onProgress, sourceCore } = {}) {
    if (typeof sendTab !== "function" || typeof rpc !== "function") throw new Error("Thiếu hàm gửi lệnh tab WMS hoặc gọi Supabase");
    const show = info => { if (onProgress) { try { onProgress(info); } catch { /* chỉ để hiển thị */ } } };
    const cov = await rpc("wms_cut_coverage", {});
    if (cov != null && (typeof cov !== "object" || (cov.until != null && !Number.isFinite(Date.parse(cov.until))))) {
      throw new Error("Mốc phủ lịch sử WMS không hợp lệ");
    }
    const to = new Date(now()).toISOString(), from = cov?.until ? new Date(Date.parse(cov.until) - OVERLAP_MS).toISOString() : null;
    const params = { size: PAGE_SIZE, to, ...(from ? { from } : {}) };
    // Đọc tới khi gặp trang thiếu dòng, không chỉ tin tổng số trang (API không trả tổng thì extension lấy số dòng của trang làm
    // tổng, totalPages = 1). Tổng > 1 trang là tổng thật: kiểm không đổi giữa các trang và khớp số dòng đã đọc.
    const byKey = new Map();
    let total = 0, totalPages = 1, read = 0, dataFrom = "", dataUntil = "", lastSig = "";
    for (let page = 1; ; page += 1) {
      if (page > MAX_PAGES) throw new Error(`Lịch sử WMS vượt ${MAX_PAGES} trang; hãy nạp ZIP/XLSX`);
      show({ phase: "read", page, totalPages: page <= totalPages ? totalPages : null });
      const result = await sendTab("GET_GROUP_UID_HISTORY_PAGE", { ...params, page });
      if (!result || typeof result !== "object" || (result.rows != null && !Array.isArray(result.rows))) {
        throw new Error(`WMS trả trang lịch sử ${page} không hợp lệ`);
      }
      if (String(result.warehouseId || "") !== WAREHOUSE_ID) throw new Error("Extension trả dữ liệu ngoài phạm vi kho WH - MATERIAL - MTG");
      const size = Number(result.size) || params.size, count = Number(result.sourceRows) || 0, pageTotal = Number(result.total) || 0;
      if (page === 1) { total = pageTotal; totalPages = Number(result.totalPages) || 1; }
      else if (total > size && (pageTotal !== total || Number(result.totalPages) !== totalPages)) throw new Error("Phạm vi lịch sử WMS thay đổi trong lúc đọc; hãy chạy lại");
      const rows = result.rows || [];
      const keys = rows.map(row => `${row.group_uid_code}|${row.cut_at}`), sig = `${count}|${result.rangeFrom}|${result.rangeTo}|${keys.join(",")}`;
      if (page > 1 && count && sig === lastSig) throw new Error("WMS trả lặp lại cùng một trang lịch sử; hãy nạp ZIP/XLSX");
      lastSig = sig; read += count;
      if (result.rangeFrom && (!dataFrom || result.rangeFrom < dataFrom)) dataFrom = result.rangeFrom;
      if (result.rangeTo && (!dataUntil || result.rangeTo > dataUntil)) dataUntil = result.rangeTo;
      rows.forEach((row, i) => byKey.set(keys[i], row));
      if (page >= totalPages && count < size) break;
    }
    if (total > params.size && read !== total) throw new Error(`Đọc được ${read}/${total} dòng lịch sử WMS; hãy chạy lại`);
    total = read;
    const cuts = [...byKey.values()].sort((a, b) => String(a.cut_at).localeCompare(String(b.cut_at))), parts = [];
    if (cuts.length) for (let i = 0; i < cuts.length; i += PART_ROWS) parts.push(cuts.slice(i, i + PART_ROWS)); else parts.push([]);
    const out = { cutRows: 0, newRows: 0, changedRows: 0, unchangedRows: 0 };
    // D8 (0.10.8): khung đọc không có dòng thì mốc phủ = min(to, giờ server) — to là đồng hồ máy; máy chạy nhanh hơn OVERLAP_MS mà
    // ghi to thì wms_cut_coverage().until nằm ở tương lai và lượt sau sót Cut vĩnh viễn. Giờ server do người gọi đưa (serverNow,
    // lấy từ phản hồi RPC wms_cut_coverage); không có thì giữ to như cũ. from kẹp ≤ until (SQL chặn until < from).
    const stamp = stampOf(to), sentUntil = dataUntil || minIso(to, safeNow(serverNow)), sentFrom = minIso(dataFrom || from || to, sentUntil);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      show({ phase: "save", part: i + 1, parts: parts.length, rows: cuts.length });
      // R7 (0.10.8): phần i < cuối chỉ phủ tới cut_at dòng cuối của phần (cuts đã sắp theo cut_at); phần sau nạp lỗi thì lượt kế
      // đọc lại từ đó, không bị mốc phủ của cả lượt nhảy qua. Phần cuối giữ mốc cả lượt.
      const partUntil = i < parts.length - 1 ? String(part[part.length - 1].cut_at) : sentUntil;
      const saved = await rpc("wms_group_uid_cut_import", {
        p_file_name: fileName(device, stamp, i, parts.length), p_file_sha256: await sha256(JSON.stringify(part)), p_total_rows: total,
        p_data_from: sentFrom, p_data_until: partUntil, p_rows: part,
      });
      for (const key of Object.keys(out)) out[key] += Number(saved?.[key] || 0);
    }
    const result = { total, ...out, from: sentFrom, until: sentUntil, readFrom: from, to, full: !from, parts: parts.length };
    // Nguồn phiếu ADJ / IT chạy SAU khi nạp: lỗi ở đây không làm mất phần nạp, nhưng vẫn báo lỗi (không im lặng).
    const matcher = sourceCore || root.CutSourceCore || (typeof require === "function" ? require("./cut-source-core.js") : null);
    try {
      if (typeof matcher?.assignSources !== "function") throw new Error("Extension thiếu bộ ghép nguồn phiếu (cut-source-core.js); hãy Reload Extension");
      // Khung giờ (review 26/10/2026): Import/Export chỉ đọc tới mốc to của lượt đọc lịch sử Cut vừa nạp (như web syncFromWms) — phiếu tạo sau
      // mốc mà Cut của nó chưa nạp không được lấy Cut cũ đang tự do; lượt sau ghép tiếp.
      result.source = await matcher.assignSources({ sendTab, rpc, now: () => Date.parse(to), onProgress: show });
    } catch (error) {
      const wrapped = new Error(`Đã nạp ${out.cutRows} dòng Cut; chưa gán được nguồn phiếu: ${error?.message || "lỗi không rõ"}`);
      for (const key of ["code", "reason", "fromTab"]) if (error?.[key]) wrapped[key] = error[key];
      wrapped.result = result;
      throw wrapped;
    }
    return result;
  }

  const api = { run, fileName, WAREHOUSE_ID, MAX_PAGES, PART_ROWS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CutAdjCore = api;
})(typeof self !== "undefined" ? self : globalThis);
