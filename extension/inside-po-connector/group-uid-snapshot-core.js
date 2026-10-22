// Đọc ảnh chụp Group UID từ WMS vào bộ nhớ rồi mới đưa lên Supabase: chép quy tắc readWmsSnapshot của index.html (16/10/2026)
// thành hàm thuần để service worker (đồng bộ tự động) và test Node dùng chung.
// WMS chỉ áp to_updated_at khi có cả from_updated_at, và danh sách xếp theo id giảm dần.
// Toàn bộ: api-clinic tạo 1 UID/phút ở đầu danh sách nên trang bị đẩy xuống trong lúc đọc (lặp chứ không sót) → đọc xong, đọc lại
// đầu danh sách (tối đa 5 vòng) tới khi tổng WMS khớp số UID duy nhất. Gia tăng: UID vừa sửa rơi khỏi khung from–to làm trang dịch lên
// (sót mà tổng vẫn khớp) → mọi trang phải cùng totalPages/total và số UID duy nhất = total. Lệch 3 lần → ném lỗi.
(function (root) {
  function num(value) { return Number(value || 0).toLocaleString("vi-VN"); }

  function checkPage(item, page) {
    if (!item || typeof item !== "object" || !Array.isArray(item.rows)
      || !Number.isFinite(Number(item.total)) || Number(item.total) < 0
      || !Number.isInteger(Number(item.totalPages)) || Number(item.totalPages) < 1) {
      throw new Error(`WMS trả trang Group UID ${page} không hợp lệ`);
    }
    return { ...item, page: Number(item.page) || page, total: Number(item.total), totalPages: Number(item.totalPages) };
  }

  async function readGroupUidSnapshot({
    full, rangeFrom, rangeTo, size = 500, readPage, onProgress, tries = 3, sleepMs = 1500, parallel = 4,
    now = () => new Date().toISOString(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    if (typeof readPage !== "function") throw new Error("Thiếu hàm đọc trang WMS");
    const rows = new Map(), records = new Set();
    let byId = true;
    const read = async (params, page) => checkPage(await readPage({ ...params, page }), page);
    // 22/10/2026: WMS đếm tổng theo bản ghi, có mã mang 2 bản ghi (id khác) → có id bản ghi ở mọi trang thì đối chiếu theo id,
    // dòng vẫn gộp theo mã (bản mới nhất). Trang thiếu id (Extension cũ) → đối chiếu theo số mã như trước.
    const merge = items => items.forEach(item => {
      if (Array.isArray(item.ids)) item.ids.forEach(id => records.add(id)); else byId = false;
      item.rows.forEach(row => {
        const before = rows.get(row.group_uid_code);
        if (!before || Date.parse(row.updated_date) >= Date.parse(before.updated_date)) rows.set(row.group_uid_code, row);
      });
    });
    const count = () => (byId ? records.size : rows.size);
    const seen = item => (byId && Array.isArray(item.ids) ? item.ids.length : item.rows.length);
    const done = pages => ({ rows: [...rows.values()], total: rows.size, pages, ...(byId && records.size > rows.size ? { duplicateCodes: records.size - rows.size } : {}) });
    let drift = "";
    for (let attempt = 1; attempt <= tries; attempt += 1) {
      rows.clear(); records.clear(); byId = true;
      // Đọc lại: cận trên không được thấp hơn rangeTo do Edge cấp (đồng hồ máy chậm sẽ làm sót UID sửa trong khoảng đó
      // mà mốc gia tăng vẫn tiến tới rangeTo).
      const params = full ? { size } : { size, from: rangeFrom, to: attempt === 1 ? rangeTo : new Date(Math.max(Date.parse(rangeTo), Date.parse(now()))).toISOString() };
      const first = await read(params, 1), totalPages = first.totalPages, items = [first], totals = [first.total];
      const show = item => { if (onProgress) onProgress({ attempt, tries, page: item.page, totalPages, total: item.total }); };
      show(first);
      for (let start = 2; start <= totalPages; start += parallel) {
        const batch = await Promise.all(Array.from({ length: Math.min(parallel, totalPages - start + 1) }, (_, index) => read(params, start + index)));
        items.push(...batch);
        show(batch[batch.length - 1]);
      }
      merge(items);
      items.forEach(item => { if (!totals.includes(item.total)) totals.push(item.total); });
      if (full) {
        for (let round = 0; round < 5; round += 1) {
          const head = await read(params, 1);
          const extra = Array.from({ length: Math.max(0, Math.ceil((head.total - first.total) / size) - 1) }, (_, index) => index + 2);
          merge([head, ...await Promise.all(extra.map(page => read(params, page)))]);
          if (!totals.includes(head.total)) totals.push(head.total);
          if (head.total === count()) return done(totalPages);
          if (head.total < count()) break;
        }
      } else if (items.every(item => item.totalPages === totalPages) && totals.length === 1 && count() === first.total
        && items.reduce((sum, item) => sum + seen(item), 0) === count()) {
        return done(totalPages);
      }
      drift = `tổng ${totals.map(num).join(" → ")} · ${num(rows.size)} UID duy nhất`;
      if (attempt < tries) await sleep(sleepMs);
    }
    throw new Error(`WMS đổi dữ liệu trong lúc đọc (${drift}); phiên đã dừng để tránh thiếu UID`);
  }

  const api = { readGroupUidSnapshot };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.GroupUidSnapshotCore = api;
})(typeof self !== "undefined" ? self : globalThis);
