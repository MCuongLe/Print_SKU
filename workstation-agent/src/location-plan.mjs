import { estimateTextWidth, tokenize } from "./templates/text-layout.mjs";
import { fitLocationName, LOCATION_LABEL_LAYOUT, LOCATION_NAME_SAFETY, locationGeometry } from "./templates/location-label.mjs";

/**
 * Đo bề rộng THẬT (GDI+ Arial, cùng hàm đo + cache với tên sản phẩm tem SKU/Group UID) của tên
 * trên tem vị trí rồi chọn cỡ chữ/xuống dòng trước khi dựng tem. Cả lệnh chỉ đo MỘT lần: tên
 * nguyên dòng, từng từ (có và không có dấu cách cuối) ở mọi cỡ chữ của tem vị trí.
 *
 * Đo thêm từng ký tự để mảnh của một từ quá dài bị cắt cứng (không có trong danh sách đo) vẫn
 * được cộng theo số đo thật thay vì ước lượng (ước lượng rộng gấp ~3 lần với chữ hẹp như "i").
 *
 * Kết quả gắn vào payload.nameFit; template dùng nguyên văn. Không có hàm đo (preview đơn lẻ)
 * hoặc đo lỗi thì để template tự ước lượng — vẫn không bỏ ký tự nào.
 */
export async function planLocationLabels(entries, config, measureText, logger) {
  const targets = entries.filter((entry) => entry.type === "location" && String(entry.payload?.name ?? "").trim());
  if (!measureText || !targets.length) return entries;
  const sizes = LOCATION_LABEL_LAYOUT.nameFontSizes;
  const texts = new Set();
  for (const entry of targets) {
    const name = String(entry.payload.name).trim();
    texts.add(name);
    for (const token of tokenize(name)) { texts.add(token); texts.add(token.trimEnd()); }
    for (const char of name) texts.add(char);
  }

  let widths;
  try {
    widths = await measureText(config, [...texts], sizes);
  } catch (error) {
    logger?.warn?.(`Không đo được chữ tem vị trí, dùng ước lượng: ${String(error?.message || error).slice(0, 160)}`);
    return entries;
  }

  // Chuỗi đã đo thì lấy số đo; dòng ghép từ nhiều từ thì cộng từng từ (MeasureTrailingSpaces nên
  // tổng các từ bằng đúng cả dòng); mảnh từ bị cắt cứng thì cộng từng ký tự (GDI+ không tính
  // kerning, máy in có kerning làm chữ hẹp lại — cộng ký tự luôn ra rộng hơn hoặc bằng, an toàn).
  const measured = (text, size) => widths?.get(text)?.get(size);
  const byChars = (text, size) => [...text].reduce((sum, char) => sum + (measured(char, size) ?? estimateTextWidth(char, size)), 0);
  const measure = (text, size) => measured(text, size)
    ?? tokenize(text).reduce((sum, token) => sum + (measured(token, size) ?? byChars(token, size)), 0);

  const plans = new Map();
  return entries.map((entry) => {
    if (!targets.includes(entry)) return entry;
    const code = String(entry.payload.code ?? "");
    const name = String(entry.payload.name).trim();
    const key = `${code}\u0000${name}`;
    if (!plans.has(key)) {
      const { nameTop } = locationGeometry(code);
      plans.set(key, fitLocationName(name, nameTop, { measure, safety: LOCATION_NAME_SAFETY.measured }));
    }
    return { ...entry, payload: { ...entry.payload, nameFit: plans.get(key) } };
  });
}
