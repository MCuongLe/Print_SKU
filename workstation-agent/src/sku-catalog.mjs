import fs from "node:fs";
import path from "node:path";
import { planProductNames } from "./render.mjs";

/**
 * Danh mục SKU trên máy trạm + đo sẵn chữ cho mọi tên — agent 0.8.6.
 *
 * Lúc in agent KHÔNG tra SKU (web gửi sẵn tên trong lệnh); cái lợi của danh mục là đo sẵn bề rộng
 * chữ cho mọi tên trong SKU_Name vào text-cache, để cả SKU in lần đầu cũng không phải mở
 * PowerShell đo chữ (~0,7–1,5 giây/lệnh).
 *
 * Cập nhật: script đồng bộ SKU buổi sáng ghi `updated_at` cho mọi dòng. Cứ `checkMs` (mặc định
 * 15 phút) agent hỏi `updated_at` mới nhất — một truy vấn một dòng; khác lần trước thì tải lại cả
 * danh mục (~22 trang × 1.000 dòng, ~4 MB) và chỉ đo các TÊN chưa đo (tên giữ nguyên thì thôi).
 * Lần đầu đo toàn bộ (~11 nghìn từ + các dòng ngắt) — chạy nền theo từng đợt `chunkSize` tên,
 * CHỈ khi agent rảnh (`isBusy()` false), có lệnh in thì dừng chờ. Mất mạng → giữ danh mục cũ.
 * Bộ đo chữ bị làm lại (đổi phiên bản/font, `cache.generation` đổi) → đo lại toàn bộ.
 */
export const SKU_CATALOG_FORMAT = 1;

const sleepFor = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(done, ms);
  timer.unref?.();
  function done() { clearTimeout(timer); signal?.removeEventListener?.("abort", done); resolve(); }
  signal?.addEventListener?.("abort", done, { once: true });
});

export function createSkuCatalog({
  config, measureText, textCache, baseMeasure, logger, file,
  fetchImpl = globalThis.fetch, isBusy = () => false, checkMs = 900000, initialDelayMs = 30000,
  chunkSize = 300, pageSize = 1000, busyPollMs = 5000, sleep = sleepFor
} = {}) {
  const quiet = { info() {}, warn() {}, error() {} };   // tên quá dài khi đo sẵn: không cần ghi log
  let state = { format: SKU_CATALOG_FORMAT, updatedAt: null, fetchedAt: null, rows: [], generation: null, warmed: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.format === SKU_CATALOG_FORMAT && Array.isArray(data.rows)) state = { ...state, ...data, warmed: Array.isArray(data.warmed) ? data.warmed : [] };
  } catch (error) {
    if (error?.code !== "ENOENT") logger?.warn?.(`File danh mục SKU hỏng, sẽ tải lại: ${String(error?.message || error).slice(0, 160)}`);
  }
  let warmed = new Set(state.warmed);

  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ ...state, warmed: [...warmed] }));
      fs.renameSync(temp, file);
    } catch (error) {
      logger?.warn?.(`Chưa ghi được danh mục SKU: ${String(error?.message || error).slice(0, 160)}`);
    }
  };
  const endpoint = `${String(config.supabaseUrl || "").replace(/\/$/, "")}/rest/v1/SKU_Name`;
  const headers = { apikey: config.supabasePublishableKey, Authorization: `Bearer ${config.supabasePublishableKey}` };
  const getJson = async (url, extraHeaders = {}) => {
    const response = await fetchImpl(url, { headers: { ...headers, ...extraHeaders }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status} khi đọc SKU_Name`);
    return response.json();
  };

  const latestUpdatedAt = async () => {
    const rows = await getJson(`${endpoint}?select=updated_at&order=updated_at.desc.nullslast&limit=1`);
    return Array.isArray(rows) && rows[0]?.updated_at ? String(rows[0].updated_at) : null;
  };
  const download = async () => {
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const page = await getJson(`${endpoint}?select=sku,product_name,status&order=sku.asc`, { Range: `${from}-${from + pageSize - 1}` });
      if (!Array.isArray(page)) throw new Error("SKU_Name trả về không phải danh sách");
      for (const row of page) rows.push([String(row.sku ?? ""), String(row.product_name ?? ""), String(row.status ?? "")]);
      if (page.length < pageSize) break;
    }
    return rows.filter(([sku]) => sku);
  };

  /** Có cập nhật mới thì tải lại danh mục. Trả true nếu đã tải. */
  const refresh = async () => {
    const latest = await latestUpdatedAt();
    if (state.rows.length && latest === state.updatedAt) return false;
    const started = Date.now();
    const rows = await download();
    state = { ...state, rows, updatedAt: latest, fetchedAt: new Date().toISOString() };
    save();
    logger?.info?.(`Danh mục SKU: đã tải ${rows.length} SKU (cập nhật ${latest ?? "?"}) trong ${((Date.now() - started) / 1000).toFixed(1)}s`);
    return true;
  };

  /** Đo sẵn chữ cho các tên chưa đo — từng đợt, chỉ khi agent rảnh. Trả số tên đã đo. */
  const warm = async (signal) => {
    if (!(await textCache.ensureValid(baseMeasure, config))) return 0;
    if (state.generation !== textCache.generation) {
      warmed = new Set();
      state.generation = textCache.generation;
    }
    const todo = [...new Set(state.rows.map((row) => row[1]).filter(Boolean))].filter((name) => !warmed.has(name));
    if (!todo.length) return 0;
    const started = Date.now();
    let done = 0;
    for (let index = 0; index < todo.length && !signal?.aborted; index += chunkSize) {
      while (isBusy() && !signal?.aborted) await sleep(busyPollMs, signal);
      if (signal?.aborted) break;
      const chunk = todo.slice(index, index + chunkSize);
      const entries = chunk.flatMap((productName) => [
        { type: "sku", copies: 1, payload: { sku: "0", productName, quantity: "", printedDate: "" } },
        { type: "group_uid", copies: 1, payload: { sku: "0", productName } }
      ]);
      await planProductNames(entries, config, measureText, quiet);
      if (state.generation !== textCache.generation) return done;   // bộ đo bị làm lại giữa chừng: vòng sau đo lại
      for (const name of chunk) warmed.add(name);
      done += chunk.length;
      if ((index / chunkSize) % 10 === 9) { save(); textCache.flush(); }
    }
    save();
    textCache.flush();
    logger?.info?.(`Danh mục SKU: đã đo sẵn chữ cho ${done} tên trong ${((Date.now() - started) / 1000).toFixed(1)}s (cache ${textCache.size} mục)`);
    return done;
  };

  let running = null;
  const cycle = async (signal) => {
    try { await refresh(); } catch (error) { logger?.warn?.(`Chưa kiểm tra được danh mục SKU, giữ bản đang có: ${String(error?.message || error).slice(0, 160)}`); }
    try { await warm(signal); } catch (error) { logger?.warn?.(`Đo sẵn chữ cho danh mục SKU bị dừng: ${String(error?.message || error).slice(0, 160)}`); }
  };
  return {
    refresh,
    warm,
    get size() { return state.rows.length; },
    get updatedAt() { return state.updatedAt; },
    get warmedCount() { return warmed.size; },
    start(signal) {
      if (running) return running;
      running = (async () => {
        await sleep(initialDelayMs, signal);
        while (!signal?.aborted) {
          await cycle(signal);
          await sleep(checkMs, signal);
        }
      })();
      return running;
    }
  };
}
