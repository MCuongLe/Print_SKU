import fs from "node:fs";
import path from "node:path";

/**
 * Cache kết quả đo bề rộng chữ (GDI+) trên máy trạm — agent 0.8.6.
 *
 * Mỗi lệnh in tốn ~0,7–1,5 giây chỉ để MỞ tiến trình PowerShell đo chữ (đo thật thì gần như
 * miễn phí). 30 ngày tới 01/10/2026: 83% dòng tem có tên sản phẩm đã từng in trước đó, và
 * sku-catalog.mjs còn đo sẵn mọi tên trong SKU_Name — nên đa số lệnh không phải gọi PowerShell.
 *
 * Khoá = cỡ chữ + chuỗi: measure-text.ps1 đo mọi nhóm (tên, số lượng, ngày) cùng font, cùng
 * StringFormat (GenericTypographic + MeasureTrailingSpaces), chỉ khác cỡ. GDI+ đo cùng font trên
 * cùng máy luôn ra cùng số, nên cache không bao giờ "cũ" — trừ khi font hoặc cách đo đổi:
 *   - `version` (phiên bản agent + font) khác → bỏ cả file, đo lại từ đầu;
 *   - chuỗi mẫu đo lại khi khởi động khác số đã lưu (Windows cập nhật font) → xoá hết.
 * Chưa đối chiếu được chuỗi mẫu thì KHÔNG dùng cache (đo như bản cũ).
 * Ghi file tạm rồi đổi tên (mất điện giữa chừng không làm hỏng file cũ); file hỏng → làm lại.
 */
export const TEXT_CACHE_FORMAT = 1;
export const PROBE_TEXTS = ["Chỉ may/None/None/Roman N0144/Be/None/5000m/mm", "Vải Pique ", "422475229", "1.000.000", "30/09/26", "WWW iii "];
export const PROBE_SIZES = [22, 16];

const keyOf = (text, size) => `${size}|${text}`;

export function createTextCache({ file, version, maxEntries = 400000, saveDelayMs = 3000, logger } = {}) {
  const entries = new Map();
  let probe = null;
  let generation = null;   // đổi mỗi khi cache được làm lại — sku-catalog dựa vào đây để biết phải đo lại
  let ready = false;
  let dirty = false;
  let timer = null;
  let validating = null;

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.format === TEXT_CACHE_FORMAT && data.version === version && data.entries && typeof data.entries === "object") {
      for (const [key, width] of Object.entries(data.entries)) if (Number.isFinite(width)) entries.set(key, width);
      probe = data.probe && typeof data.probe === "object" ? data.probe : null;
      generation = typeof data.generation === "string" ? data.generation : null;
    } else {
      logger?.info?.(`Cache đo chữ thuộc phiên bản khác (${data?.version ?? "?"}) — làm lại từ đầu`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") logger?.warn?.(`Cache đo chữ hỏng, làm lại từ đầu: ${String(error?.message || error).slice(0, 160)}`);
  }

  const save = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ format: TEXT_CACHE_FORMAT, version, generation, savedAt: new Date().toISOString(), probe, entries: Object.fromEntries(entries) }));
      fs.renameSync(temp, file);
    } catch (error) {
      dirty = true;
      logger?.warn?.(`Chưa ghi được cache đo chữ: ${String(error?.message || error).slice(0, 160)}`);
    }
  };
  const touch = () => {
    dirty = true;
    if (!timer) {
      timer = setTimeout(save, saveDelayMs);
      timer.unref?.();
    }
  };
  // Map giữ thứ tự thêm vào: vượt trần thì bỏ 10% mục cũ nhất.
  const trim = () => {
    if (entries.size <= maxEntries) return;
    let drop = entries.size - Math.floor(maxEntries * 0.9);
    for (const key of entries.keys()) {
      if (drop-- <= 0) break;
      entries.delete(key);
    }
  };

  const cache = {
    get ready() { return ready; },
    get generation() { return generation; },
    get size() { return entries.size; },
    get(text, size) { return ready ? entries.get(keyOf(text, size)) : undefined; },
    set(text, size, width) {
      if (!ready || !Number.isFinite(width)) return;
      entries.set(keyOf(text, size), width);
      trim();
      touch();
    },
    /** Đo lại chuỗi mẫu bằng `measure` (measureTextWidths); số khác lần trước thì xoá hết. */
    async validate(measure, config) {
      const result = await measure(config, PROBE_TEXTS, PROBE_SIZES);
      const now = {};
      for (const text of PROBE_TEXTS) for (const size of PROBE_SIZES) now[keyOf(text, size)] = result?.get(text)?.get(size);
      if (Object.values(now).some((width) => !Number.isFinite(width))) throw new Error("đo chuỗi mẫu không đủ kết quả");
      const same = Boolean(probe) && Object.keys(now).every((key) => Math.abs(Number(probe[key]) - now[key]) < 0.01);
      if (!same || !generation) {
        if (!same && entries.size) logger?.warn?.(`Font hoặc cách đo chữ trên máy đã đổi — xoá ${entries.size} mục cache đo chữ`);
        if (!same) entries.clear();
        probe = now;
        generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        dirty = true;
        save();
      }
      ready = true;
      return same;
    },
    /**
     * Đối chiếu chuỗi mẫu đúng một lần (các lời gọi đồng thời dùng chung); lỗi thì lần sau thử lại.
     * Trả true khi cache dùng được (khác validate(): validate trả "chuỗi mẫu có giống lần trước").
     */
    ensureValid(measure, config) {
      if (ready) return Promise.resolve(true);
      if (!validating) {
        validating = cache.validate(measure, config).then(() => true, (error) => {
          logger?.warn?.(`Chưa đối chiếu được chuỗi mẫu, tạm đo không dùng cache: ${String(error?.message || error).slice(0, 160)}`);
          return false;
        }).finally(() => { validating = null; });
      }
      return validating;
    },
    flush: save
  };
  return cache;
}

/**
 * Bọc measureTextWidths: trả cùng dạng kết quả (Map chuỗi → Map cỡ → bề rộng, kèm `.extra`),
 * chỉ gọi PowerShell — vẫn đúng MỘT lần — cho những (chuỗi, cỡ) chưa có trong cache.
 * Cache chưa sẵn sàng thì gọi thẳng `base` như bản cũ.
 */
export function cachedMeasure(base, cache) {
  return async (config, texts, sizes, options = {}) => {
    await cache.ensureValid(base, config);
    if (!cache.ready) return base(config, texts, sizes, options);
    const unique = (values) => [...new Set((values || []).filter((text) => text))];
    const groups = [{ texts: unique(texts), sizes: sizes || [] }, ...(options.extra || []).map((group) => ({ texts: unique(group.texts), sizes: group.sizes || [] }))];
    const got = new Map();
    const remember = (text, size, width) => { if (Number.isFinite(width)) got.set(keyOf(text, size), width); };
    for (const group of groups) for (const text of group.texts) for (const size of group.sizes) remember(text, size, cache.get(text, size));

    const missing = groups.map((group) => ({ texts: group.texts.filter((text) => group.sizes.some((size) => !got.has(keyOf(text, size)))), sizes: group.sizes }));
    if (missing.some((group) => group.texts.length)) {
      const [main, ...extra] = missing;
      const fresh = await base(config, main.texts, main.sizes, { extra });
      const store = (map, group) => {
        for (const text of group.texts) {
          for (const size of group.sizes) {
            const width = map?.get(text)?.get(size);
            remember(text, size, width);
            cache.set(text, size, width);
          }
        }
      };
      store(fresh, main);
      extra.forEach((group, index) => store(fresh?.extra?.[index], group));
    }
    const build = (group) => {
      const map = new Map();
      for (const text of group.texts) {
        const row = new Map();
        for (const size of group.sizes) {
          const width = got.get(keyOf(text, size));
          if (width !== undefined) row.set(size, width);
        }
        map.set(text, row);
      }
      return map;
    };
    return Object.assign(build(groups[0]), { extra: groups.slice(1).map(build) });
  };
}
