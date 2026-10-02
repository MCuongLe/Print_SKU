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
export const TEXT_CACHE_FORMAT = 2;
// Chuỗi mẫu đo lại mỗi lần khởi động. Mười chữ số đo RIÊNG LẺ ở cuối: nếu mọi chữ số rộng bằng nhau (Arial: có,
// đã đo 18 cỡ chữ 02/10/2026) thì cache gộp mọi chữ số về "0" — số lượng và ngày lần nào cũng khác ("28.571.429",
// "02/10/26") vẫn trúng cache "00.000.000", "00/00/00". Font không còn chữ số đều nhau thì tự tắt cách gộp.
export const DIGIT_PROBES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const PROBE_TEXTS = ["Chỉ may/None/None/Roman N0144/Be/None/5000m/mm", "Vải Pique ", "422475229", "1.000.000", "30/09/26", "WWW iii ", ...DIGIT_PROBES];
export const PROBE_SIZES = [22, 16];

const keyOf = (text, size) => `${size}|${text}`;
const digitsUniformIn = (widths) => PROBE_SIZES.every((size) => {
  const values = DIGIT_PROBES.map((digit) => widths[keyOf(digit, size)]);
  return values.every(Number.isFinite) && Math.max(...values) - Math.min(...values) < 0.01;
});

export function createTextCache({ file, version, maxEntries = 400000, saveDelayMs = 3000, logger } = {}) {
  const entries = new Map();
  let probe = null;
  let generation = null;   // đổi mỗi khi cache được làm lại — sku-catalog dựa vào đây để biết phải đo lại
  let digitsUniform = false;   // mọi chữ số rộng bằng nhau → khoá cache gộp chữ số về "0" (chỉ đúng sau validate)
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
      digitsUniform = data.digitsUniform === true;
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
      fs.writeFileSync(temp, JSON.stringify({ format: TEXT_CACHE_FORMAT, version, generation, digitsUniform, savedAt: new Date().toISOString(), probe, entries: Object.fromEntries(entries) }));
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
    get digitsUniform() { return digitsUniform; },
    // Khoá cache: chữ số gộp về "0" khi font có mọi chữ số bằng nhau (kiểm tra ở validate()).
    get(text, size) { return ready ? entries.get(keyOf(digitsUniform ? text.replace(/[0-9]/g, "0") : text, size)) : undefined; },
    set(text, size, width) {
      if (!ready || !Number.isFinite(width)) return;
      entries.set(keyOf(digitsUniform ? text.replace(/[0-9]/g, "0") : text, size), width);
      trim();
      touch();
    },
    /** Đo lại chuỗi mẫu bằng `measure` (measureTextWidths); số khác lần trước thì xoá hết. */
    async validate(measure, config) {
      const result = await measure(config, PROBE_TEXTS, PROBE_SIZES);
      const now = {};
      for (const text of PROBE_TEXTS) for (const size of PROBE_SIZES) now[keyOf(text, size)] = result?.get(text)?.get(size);
      if (Object.values(now).some((width) => !Number.isFinite(width))) throw new Error("đo chuỗi mẫu không đủ kết quả");
      const uniformNow = digitsUniformIn(now);
      // Đổi cách gộp chữ số (hoặc chuỗi mẫu lệch) = khoá cũ không còn đúng nghĩa → xoá hết.
      const same = Boolean(probe) && uniformNow === digitsUniform && Object.keys(now).every((key) => Math.abs(Number(probe[key]) - now[key]) < 0.01);
      if (!same || !generation) {
        if (!same && entries.size) logger?.warn?.(`Font hoặc cách đo chữ trên máy đã đổi — xoá ${entries.size} mục cache đo chữ`);
        if (!same) entries.clear();
        digitsUniform = uniformNow;
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
 * Các mẫu số lượng và ngày phổ biến nhất của tem SKU, đã gộp chữ số về "0": số lượng có/không có dấu chấm
 * hàng nghìn tới 12 chữ số, và các kiểu ngày thường gặp. Nạp sẵn một lần (một lần gọi PowerShell) để lệnh in
 * đầu tiên sau khi nâng cấp cũng không phải đo số lượng/ngày.
 */
export function footerPatterns() {
  const quantities = new Set();
  for (let digits = 1; digits <= 12; digits += 1) {
    const run = "0".repeat(digits);
    quantities.add(run);
    quantities.add(run.replace(/\B(?=(\d{3})+(?!\d))/g, "."));
  }
  return { quantities: [...quantities], dates: ["00/00/00", "00-00-00", "00/00/0000", "00-00-0000", "00.00.00"] };
}

export async function seedFooterPatterns(measure, config, { quantitySizes, dateSizes }) {
  const { quantities, dates } = footerPatterns();
  await measure(config, [], [], { extra: [{ texts: quantities, sizes: quantitySizes }, { texts: dates, sizes: dateSizes }] });
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
