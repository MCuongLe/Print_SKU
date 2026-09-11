import qrcode from "qrcode-generator";

// Sinh ma trận QR (mức sửa lỗi M) cho một chuỗi; type 0 = tự chọn version nhỏ nhất vừa dữ liệu.
export function qrMatrix(text) {
  const qr = qrcode(0, "M");
  qr.addData(String(text ?? ""));
  qr.make();
  const count = qr.getModuleCount();
  const rows = [];
  for (let row = 0; row < count; row += 1) {
    const line = [];
    for (let col = 0; col < count; col += 1) line.push(qr.isDark(row, col));
    rows.push(line);
  }
  return { count, rows };
}

// Dựng các <rect> đen của QR, canh giữa trong ô rộng `box` dot tại (centerX là tâm ngang), đỉnh y = top.
// Gộp các ô đen liền nhau trên cùng hàng để giảm số rect. Trả về cả kích thước thực để đặt chữ bên dưới.
export function qrRects(text, { centerX, top, box }) {
  const { count, rows } = qrMatrix(text);
  const module = Math.max(4, Math.floor(box / count));
  const size = module * count;
  const x0 = Math.round(centerX - size / 2);
  let rects = "";
  for (let row = 0; row < count; row += 1) {
    let start = -1;
    for (let col = 0; col <= count; col += 1) {
      const dark = col < count && rows[row][col];
      if (dark && start < 0) start = col;
      else if (!dark && start >= 0) {
        rects += `<rect x="${x0 + start * module}" y="${top + row * module}" width="${(col - start) * module}" height="${module}"/>`;
        start = -1;
      }
    }
  }
  return { rects, size };
}
