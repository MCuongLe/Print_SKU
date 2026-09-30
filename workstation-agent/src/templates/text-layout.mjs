// Chia dòng theo bề rộng chữ THẬT (px, đo trước qua GDI+), không đếm đầu người
// như wrapText cũ ở common.mjs. Toàn bộ hàm ở đây thuần logic, đồng bộ, không I/O
// — nhận sẵn bảng bề rộng đã đo, để test được mà không cần PowerShell.

// Tách y hệt cách wrapText cũ tách: mỗi token là một cụm ký tự không phải khoảng
// trắng/dấu / theo sau bởi MỘT khoảng trắng hoặc dấu /, hoặc là phần đuôi cuối
// cùng không còn gì theo sau. Giữ nguyên quy tắc này để không đổi VỊ TRÍ được
// phép ngắt dòng — chỉ đổi ĐIỀU KIỆN khi nào một dòng đã đầy.
export function tokenize(value) {
  return String(value ?? "").trim().match(/[^\s/]*[\s/]|[^\s/]+$/g) || [];
}

// Đo thật ngày 24/09/2026: CỘNG DỒN bề rộng từng token đo RIÊNG LẺ luôn thấp
// hơn bề rộng đo NGUYÊN CẢ CỤM khi ghép lại — ví dụ "Opened end/No.3 Plastic
// Zipper": tổng 5 token đo riêng = 294,7px, đo nguyên cụm = 313,07px, lệch
// 6,2%. GDI+ với GenericTypographic bỏ "side bearing" ở HAI ĐẦU của MỖI lần
// đo độc lập; đo rời từng token nghĩa là bỏ bearing nhiều lần thay vì đúng
// một lần ở đầu và một lần ở cuối dòng thật. Càng nhiều token trong một dòng,
// sai số càng cộng dồn — không phải hằng số cố định.
//
// Vì vậy KHÔNG được tin thẳng tổng token để quyết định tràn tem: phải dùng nó
// làm ranh giới SƠ BỘ (với biên an toàn), rồi đo lại NGUYÊN từng dòng thật để
// xác nhận (xem `verifyLineWidths` + planSkuProductNames ở render.mjs).
export const WRAP_SAFETY_FACTOR = 0.88; // bù cho sai số cộng dồn đã đo được (~6–12% tuỳ số token/dòng)

/**
 * Ghép token thành dòng dựa theo bề rộng thật, không giới hạn số dòng (gọi nơi
 * khác tự cắt bớt nếu cần). `measure(text)` phải là hàm ĐỒNG BỘ trả về px, tra
 * từ bảng đã đo sẵn — đây chỉ là ranh giới SƠ BỘ, xem cảnh báo `WRAP_SAFETY_FACTOR`
 * ở trên; kết quả PHẢI được xác nhận lại bằng đo nguyên dòng trước khi tin.
 *
 * Token đơn lẻ rộng hơn cả một dòng (ví dụ mã hàng dài không có khoảng trắng)
 * vẫn phải cắt cứng để không treo mãi không xuống dòng được — ước lượng điểm
 * cắt theo tỷ lệ bề rộng/độ dài của chính token đó, giống tinh thần bản cũ
 * (`token.slice(0, maxCharacters)`) nhưng theo pixel thay vì đếm ký tự.
 */
export function wrapByWidth(value, measure, maxWidthPx) {
  const tokens = tokenize(value);
  const lines = [];
  let current = "";
  let currentWidth = 0;

  for (let token of tokens) {
    let tokenWidth = measure(token);
    while (tokenWidth > maxWidthPx && token.trim().length > 1) {
      if (current.trim()) { lines.push(current.trimEnd()); current = ""; currentWidth = 0; }
      const trimmed = token.trimEnd();
      const ratio = maxWidthPx / tokenWidth;
      // Bớt 10% cho chắc: bề rộng không tuyến tính tuyệt đối theo số ký tự (mỗi
      // ký tự rộng khác nhau), nên cắt hụt một chút còn hơn cắt dư làm tràn dòng.
      const cut = Math.max(1, Math.min(trimmed.length - 1, Math.floor(trimmed.length * ratio * 0.9)));
      lines.push(trimmed.slice(0, cut));
      token = token.slice(cut);
      tokenWidth = measure(token);
    }
    if (currentWidth + tokenWidth > maxWidthPx && current.trim()) {
      lines.push(current.trimEnd());
      current = token;
      currentWidth = tokenWidth;
    } else {
      current += token;
      currentWidth += tokenWidth;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines;
}

/**
 * Xác nhận lại các dòng đã wrap sơ bộ bằng cách đo NGUYÊN mỗi dòng (không phải
 * tổng từng token) — đây là bước bắt buộc, xem cảnh báo `WRAP_SAFETY_FACTOR`.
 * Dòng nào đo lại vẫn vượt `maxWidthPx` (hiếm, nhờ đã có biên an toàn ở bước
 * wrap sơ bộ) thì tách bớt token cuối xuống một dòng mới chèn ngay sau — bỏ
 * bớt nội dung LUÔN làm dòng hẹp hơn (đúng về mặt toán học, không phụ thuộc
 * đặc tính đo của GDI+), nên an toàn dù không đo lại lần hai để xác nhận
 * tuyệt đối phần còn lại.
 *
 * `measureWholeLine(text)` và `measureToken(text)` đồng bộ, tra từ bảng đã đo
 * sẵn (không tự gọi thêm phép đo nào — mọi giá trị cần dùng phải được đo
 * trước qua measureTextWidths).
 */
export function verifyLineWidths(lines, { measureWholeLine, measureToken }, maxWidthPx) {
  const output = [];
  for (const line of lines) {
    const width = measureWholeLine(line);
    if (width <= maxWidthPx) {
      output.push(line.trimEnd());
      continue;
    }
    const tokens = tokenize(line);
    const excess = width - maxWidthPx;
    const popped = [];
    let poppedWidth = 0;
    while (tokens.length > 1 && poppedWidth < excess) {
      const token = tokens.pop();
      popped.unshift(token);
      poppedWidth += measureToken(token);
    }
    output.push(tokens.join("").trimEnd());
    if (popped.length) output.push(popped.join("").trimEnd());
  }
  return output;
}

// Số dòng tối đa còn vừa khổ tem với một cỡ chữ cho trước, suy ra từ đúng công
// thức bố cục dùng trong sku-label.mjs (qrTop/skuY/lineY) — một nguồn sự thật
// duy nhất, đổi hằng số bố cục ở template thì phải đổi luôn ở đây. Vạch kẻ cố
// định ở `lineY`, nên tên + QR + số SKU phải nằm gọn phía trên nó.
export function maxLinesForSize(fontSizePx, layout) {
  const { lineY, qrSize, skuOffset, lineOffset, pad } = layout;
  const lineHeight = fontSizePx + 3;
  return Math.max(1, Math.floor((lineY - lineOffset - skuOffset - qrSize - pad - 34) / lineHeight));
}

// Hàng cuối tem SKU: số lượng (canh trái x=20) và ngày (canh phải x=300)
// cùng một hàng cố định ở đáy tem. Cả hai phải hiện ĐỦ mọi ký tự, không bao giờ
// cắt: thu nhỏ số lượng trước (tới 18), rồi tới ngày (tới 12), rồi số lượng dưới
// 18; vẫn không vừa thì hạ số lượng theo đúng tỷ lệ bề rộng cho tới khi vừa.
export const FOOTER_SPAN_PX = 280; // x=20 → x=300
export const FOOTER_GAP_PX = 10;   // khoảng trống tối thiểu giữa số lượng và ngày
export const QUANTITY_FONT_SIZES = [40, 38, 36, 34, 32, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12];
export const DATE_FONT_SIZES = [17, 16, 15, 14, 13, 12];
const QUANTITY_PREFERRED_MIN = 18;
const QUANTITY_LAST_RESORT_MIN = 6;

// Ước lượng bề rộng Arial khi KHÔNG đo được bằng GDI+ (preview đơn lẻ, đo lỗi):
// chữ số 0,557em (Arial dùng chữ số rộng đều nhau), dấu câu/khoảng trắng 0,34em,
// M/W/m/w 0,95em, chữ hoa khác 0,8em, chữ thường 0,62em, ký hiệu khác (@ % &…)
// 1,02em — bằng ký tự rộng nhất của Arial. Đã so với GDI+ thật ngày 30/09/2026:
// luôn ước dư. Dư thì chữ chỉ nhỏ hơn cần thiết, thiếu mới làm hai chuỗi đè nhau.
export function estimateTextWidth(text, sizePx) {
  let em = 0;
  for (const char of String(text ?? "")) {
    em += /\d/.test(char) ? 0.557
      : /[\s.,:;/'-]/.test(char) ? 0.34
      : /[MWmw]/.test(char) ? 0.95
      : /\p{Lu}/u.test(char) ? 0.8
      : /\p{L}/u.test(char) ? 0.62
      : 1.02;
  }
  return em * sizePx;
}

/**
 * Chọn cỡ chữ cho số lượng và ngày sao cho hai chuỗi không chạm nhau trên cùng
 * một hàng. `measureQuantity(text, size)` và `measureDate(text, size)`
 * đồng bộ, tra từ bảng đã đo sẵn hoặc dùng estimateTextWidth.
 */
export function fitFooter(quantity, date, { measureQuantity, measureDate }) {
  const dateWidth = (size) => (date ? measureDate(date, size) : 0);
  const smallestDate = DATE_FONT_SIZES[DATE_FONT_SIZES.length - 1];
  if (!quantity) {
    return { quantityFontSize: null, dateFontSize: DATE_FONT_SIZES.find((size) => dateWidth(size) <= FOOTER_SPAN_PX) ?? smallestDate };
  }
  const fits = (quantitySize, dateSize) =>
    measureQuantity(quantity, quantitySize) + FOOTER_GAP_PX + dateWidth(dateSize) <= FOOTER_SPAN_PX;
  for (const dateSize of DATE_FONT_SIZES) {
    for (const quantitySize of QUANTITY_FONT_SIZES) {
      if (quantitySize < QUANTITY_PREFERRED_MIN) break;
      if (fits(quantitySize, dateSize)) return { quantityFontSize: quantitySize, dateFontSize: dateSize };
    }
  }
  for (const quantitySize of QUANTITY_FONT_SIZES) {
    if (quantitySize < QUANTITY_PREFERRED_MIN && fits(quantitySize, smallestDate)) {
      return { quantityFontSize: quantitySize, dateFontSize: smallestDate };
    }
  }
  // Bề rộng chữ tỷ lệ thuận với cỡ chữ: suy ra cỡ vừa khít từ số đo ở cỡ nhỏ nhất.
  const baseSize = QUANTITY_FONT_SIZES[QUANTITY_FONT_SIZES.length - 1];
  const available = FOOTER_SPAN_PX - FOOTER_GAP_PX - dateWidth(smallestDate);
  const scaled = Math.floor((baseSize * available) / Math.max(1, measureQuantity(quantity, baseSize)));
  return { quantityFontSize: Math.max(QUANTITY_LAST_RESORT_MIN, Math.min(baseSize, scaled)), dateFontSize: smallestDate };
}

/**
 * Chọn cỡ chữ lớn nhất (trong `fontSizes`, sắp giảm dần) khiến tên vừa đủ số
 * dòng cho phép ở cỡ đó; nếu không cỡ nào đủ thì dùng cỡ nhỏ nhất và chấp nhận
 * cắt bớt — vẫn tốt hơn bản cũ vì đã thử hết khả năng trước khi cắt.
 *
 * `measureAt(text, size)` đồng bộ, tra từ bảng đã đo sẵn qua measureTextWidths.
 */
export function fitProductName(value, { measureAt, maxWidthPx, fontSizes, layout }) {
  // Dùng maxWidthPx đã bớt biên an toàn cho bước wrap sơ bộ — xem cảnh báo ở
  // WRAP_SAFETY_FACTOR. Kết quả ở đây CHƯA được xác nhận, phải qua
  // verifyLineWidths (render.mjs) trước khi in.
  const safeWidthPx = maxWidthPx * WRAP_SAFETY_FACTOR;
  let smallest = null;
  for (const size of fontSizes) {
    const lines = wrapByWidth(value, (t) => measureAt(t, size), safeWidthPx);
    const cap = maxLinesForSize(size, layout);
    const result = { fontSize: size, lines: lines.slice(0, cap), fits: lines.length <= cap };
    if (result.fits) return result;
    smallest = result;
  }
  return smallest;
}
