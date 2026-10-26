(() => {
  if (globalThis.HasakiSkuSyncCore) return;

  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();

  // D7 (0.10.8, review 23/10/2026): chỉ nhận nhãn Inside đã biết, "Active" → "1", "In-Active" (hoặc "Inactive") → "0",
  // không phân biệt hoa thường. Nhãn lạ hoặc ô trống thì NÉM lỗi đọc: cả lượt dừng, không ghi. Trước đây mọi giá trị lạ thành "0"
  // nên Inside đổi nhãn là SKU bị ẩn + chặn in hàng loạt ở lượt gia tăng (≤ 500 dòng nên không bị giữ lại).
  // 0.10.9: Inside có 4 trạng thái (Active, Pending, In-Active, Reject; Reject hiện "Inactive" trên bảng). "Pending" = SKU mới tạo
  // chưa kích hoạt → "0" như trước 0.10.8; 0.10.8 bỏ sót nhãn này nên một dòng Pending trong trang đang đọc làm cả lượt lỗi.
  function statusCode(value) {
    const label = clean(value).toLowerCase();
    if (label === "active") return "1";
    if (label === "in-active" || label === "inactive" || label === "pending") return "0";
    throw new Error(`Inside đổi nhãn Trạng thái sản phẩm ("${clean(value).slice(0, 40) || "trống"}"); dừng đồng bộ để không ẩn nhầm SKU, hãy báo để cập nhật Extension`);
  }

  // matched=false: không có dạng "Combo A=..."; rejected: thành phần không đọc được (bị bỏ khỏi relations).
  function parseComboDetail(value) {
    const text = clean(value);
    const equation = text.match(/\bCombo\s+([^\s=]+)\s*=\s*(.+)$/i);
    if (!equation) return { matched: false, relations: [], rejected: [] };
    const comboSku = clean(equation[1]);
    const relations = [], rejected = [];
    for (const part of equation[2].split("+")) {
      const component = clean(part);
      if (!component) continue;
      const match = component.match(/^([^\s,;+]+?)(?:\s*[xX×]\s*([0-9][0-9.,]*))?$/);
      const quantity = match ? (match[2] ? Number(match[2].replace(/,/g, "")) : 1) : NaN;
      if (!Number.isFinite(quantity) || quantity <= 0) { rejected.push(component); continue; }
      relations.push({ comboSku, normalSku: clean(match[1]), quantity });
    }
    return { matched: true, relations, rejected };
  }

  function parseComboDescriptions(value) {
    return parseComboDetail(value).relations;
  }

  function parseComboDescription(value) {
    return parseComboDescriptions(value)[0] || null;
  }

  function cutoffKey(value) {
    const date = new Date(value || Date.now() - 7 * 86400000);
    const safe = Number.isFinite(date.getTime()) ? date : new Date(Date.now() - 7 * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "2-digit", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(safe).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  // Trang Combo của Inside ghi Modified dạng "YYYY-MM-DD HH:MM:SS" (năm đủ 4 số), khác trang sản phẩm ("YY-MM-DD ...").
  function comboCutoffKey(value) {
    const date = new Date(value || Date.now() - 7 * 86400000);
    const safe = Number.isFinite(date.getTime()) ? date : new Date(Date.now() - 7 * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(safe).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  const COMBO_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  // Gia tăng Combo: Inside phải liệt kê Modified giảm dần, đúng định dạng và không có ô trống; sai một trong ba thì đọc toàn bộ để không bỏ sót
  // (ô trống mà bỏ qua thì dòng đó bị loại lặng lẽ vì "" < mốc — review Codex 16/10/2026).
  function comboStampsOrdered(stamps, previous = "") {
    let last = previous;
    for (const stamp of stamps) {
      if (!stamp || !COMBO_STAMP.test(stamp)) return false;
      if (last && stamp > last) return false;
      last = stamp;
    }
    return true;
  }

  globalThis.HasakiSkuSyncCore = Object.freeze({ clean, statusCode, parseComboDetail, parseComboDescription, parseComboDescriptions, cutoffKey, comboCutoffKey, comboStampsOrdered });
})();
