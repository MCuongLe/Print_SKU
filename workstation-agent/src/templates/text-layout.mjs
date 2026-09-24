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
// thức bố cục dùng trong sku-label.mjs (qrTop/skuY/lineY/footerY) — một nguồn
// sự thật duy nhất, đổi hằng số bố cục ở template thì phải đổi luôn ở đây.
export function maxLinesForSize(fontSizePx, layout) {
  const { labelHeight, qrSize, skuOffset, lineOffset, dateOffset, pad, bottomMargin } = layout;
  const lineHeight = fontSizePx + 3;
  const footer = qrSize + skuOffset + lineOffset + dateOffset + bottomMargin + pad;
  return Math.max(1, Math.floor((labelHeight - footer - 34) / lineHeight));
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
