import test from "node:test";
import assert from "node:assert/strict";
import { tokenize, wrapByWidth, fitProductName, maxLinesForSize, verifyLineWidths } from "../src/templates/text-layout.mjs";

// Bảng đo giả lập: mỗi ký tự rộng cố định theo LOẠI ký tự (chữ hoa rộng, chữ
// thường/số hẹp), để test không phụ thuộc PowerShell mà vẫn thể hiện đúng vấn
// đề của cách đếm ký tự cũ — dòng toàn chữ hẹp phải chứa được NHIỀU ký tự hơn
// dòng toàn chữ rộng, dù cùng 22 ký tự.
const WIDE = 14, NARROW = 6;
function fakeMeasure(text) {
  let width = 0;
  for (const ch of text) width += /[A-Z0-9#]/.test(ch) ? WIDE : NARROW;
  return width;
}
const layout = { labelHeight: 480, qrSize: 147, skuOffset: 28, lineOffset: 16, dateOffset: 28, pad: 10, bottomMargin: 17 };

test("wrapByWidth: dong toan chu hep chua duoc nhieu hon dong toan chu rong", () => {
  const narrowLine = wrapByWidth("o e l s o e l s o e l s", fakeMeasure, 200)[0];
  const wideLine = wrapByWidth("O E L S O E L S O E L S", fakeMeasure, 200)[0];
  assert.ok(narrowLine.length > wideLine.length,
    `dong chu hep (${narrowLine.length} ky tu) phai dai hon dong chu rong (${wideLine.length} ky tu)`);
});

test("wrapByWidth: khop chinh xac vi du O-E L-S / SAB-255LK3557-2 tu tem that", () => {
  // "O-E L-S " toan chu hep/gach ngang, token tiep theo "SAB-255LK3557-2/" toan
  // chu hoa+so rong. Voi be rong thuc, hai token nay co the vua chung mot dong
  // du dem theo ky tu (7+16=23) se bi tach — day chinh la loi ong phat hien.
  const measure = (t) => {
    let w = 0;
    for (const ch of t) w += /[A-Z0-9]/.test(ch) ? 8 : 5;
    return w;
  };
  const lines = wrapByWidth("O-E L-S SAB-255LK3557-2/100% ", measure, 999); // du rong de gop 1 dong, chi kiem tra khong bi tach som
  assert.equal(lines.length, 1, "voi khong gian du rong, hai token phai gop chung 1 dong");
});

test("wrapByWidth: token don le dai hon ca dong van bi cat, khong treo vo han", () => {
  const measure = (t) => t.length * 10; // 1 ky tu = 10px
  const lines = wrapByWidth("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", measure, 100); // toi da ~10 ky tu/dong
  assert.ok(lines.length >= 3, `chuoi dai phai bi cat thanh nhieu dong, dang la ${lines.length}`);
  assert.ok(lines.every((l) => measure(l) <= 100 * 1.15), "moi dong khong duoc vuot qua nhieu so voi gioi han");
  assert.equal(lines.join(""), "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "khong duoc mat ky tu nao khi cat");
});

test("wrapByWidth: chuoi rong tra ve mang rong", () => {
  assert.deepEqual(wrapByWidth("", fakeMeasure, 200), []);
  assert.deepEqual(wrapByWidth("   ", fakeMeasure, 200), []);
});

test("maxLinesForSize: co chu nho hon thi duoc nhieu dong hon, khop cong thuc that trong sku-label.mjs", () => {
  // Gia tri nay phai khop dung voi cong thuc qrTop/skuY/lineY/footerY hien co
  // trong sku-label.mjs cho co chu mac dinh 22 — neu lech nghia la hai noi da
  // choi nhau, phai kiem tra lai ca hai.
  assert.equal(maxLinesForSize(22, layout), 8, "co 22 (mac dinh) phai cho toi da 8 dong, khop ban va truoc");
  assert.ok(maxLinesForSize(18, layout) > maxLinesForSize(22, layout), "co nho hon phai cho nhieu dong hon");
  assert.ok(maxLinesForSize(16, layout) > maxLinesForSize(18, layout));
});

test("fitProductName: dung co lon nhat khi da vua, khong thu nho khong can thiet", () => {
  const measureAt = (text, size) => fakeMeasure(text) * (size / 22);
  const result = fitProductName("Ten ngan", { measureAt, maxWidthPx: 296, fontSizes: [22, 20, 18, 16], layout });
  assert.equal(result.fontSize, 22, "ten ngan thi giu nguyen co chu mac dinh");
});

test("fitProductName: tu dong giam co chu khi ten dai vuot qua so dong cho phep o co mac dinh", () => {
  const longName = Array(30).fill("mot-tu-dai-vua-phai").join(" ");
  const measureAt = (text, size) => fakeMeasure(text) * (size / 22);
  const result = fitProductName(longName, { measureAt, maxWidthPx: 296, fontSizes: [22, 20, 18, 16], layout });
  assert.ok(result.fontSize < 22, `ten dai phai duoc giam co chu, dang la ${result.fontSize}`);
  assert.ok(result.lines.length <= maxLinesForSize(result.fontSize, layout));
});

test("fitProductName: ten qua dai du co nho nhat van khong du thi cat bot, khong lam sap", () => {
  const veryLongName = Array(200).fill("mot-tu-rat-dai-lap-lai-nhieu-lan").join(" ");
  const measureAt = (text, size) => fakeMeasure(text) * (size / 22);
  const result = fitProductName(veryLongName, { measureAt, maxWidthPx: 296, fontSizes: [22, 20, 18, 16], layout });
  assert.equal(result.fontSize, 16, "khong con size nao du thi dung size nho nhat");
  assert.ok(result.lines.length <= maxLinesForSize(16, layout), "van phai cat dung gioi han dong cua size nho nhat");
});

test("tokenize: giu nguyen dau / va khoang trang lam ranh gioi, giong wrapText cu", () => {
  assert.deepEqual(tokenize("A/B C"), ["A/", "B ", "C"]);
});

test("verifyLineWidths: dung y het vi du that da gay loi — 'Opened end/No.3 Plastic Zipper' vuot khung du wrap so bo cho qua", () => {
  // Dung SO LIEU THAT do duoc ngay 24/09/2026: tong tung token rieng = 294,7px
  // (duoi maxWidthPx=296 nen wrap so bo cho qua), nhung do NGUYEN ca dong that
  // su la 313,07px (vuot). Day chinh la loi khien chu "r" cuoi "Zipper" bi cat
  // mat tren tem in that.
  const wholeLineWidths = new Map([["Opened end/No.3 Plastic Zipper", 313.07]]);
  const tokenWidths = new Map([
    ["Opened ", 78.29], ["end/", 42.82], ["No.3 ", 46.47], ["Plastic ", 64.8], ["Zipper", 55],
  ]);
  const result = verifyLineWidths(
    ["Opened end/No.3 Plastic Zipper"],
    {
      measureWholeLine: (t) => wholeLineWidths.get(t) ?? Infinity,
      measureToken: (t) => tokenWidths.get(t.trim()) ?? tokenWidths.get(t) ?? t.length * 8,
    },
    296
  );
  assert.ok(result.length >= 2, `phai tach thanh nhieu dong, dang la ${result.length}`);
  assert.equal(result.join(" ").replace(/\s+/g, " ").trim(), "Opened end/No.3 Plastic Zipper",
    "khong duoc mat chu nao khi tach — day chinh la loi 'Zipper' bi mat chu r");
});

test("verifyLineWidths: dong da vua thi giu nguyen, khong tach thua", () => {
  const result = verifyLineWidths(
    ["O-E L-S"],
    { measureWholeLine: () => 79, measureToken: () => 0 },
    296
  );
  assert.deepEqual(result, ["O-E L-S"]);
});

test("verifyLineWidths: khong bao gio tra ve dong con vuot qua maxWidthPx qua nhieu lan tach lien tiep", () => {
  // Mo phong mot dong rat dai gom nhieu token ngan, dam bao vong lap ket thuc
  // va khong mat noi dung.
  const line = Array(10).fill("tu").join(" ");
  const result = verifyLineWidths(
    [line],
    { measureWholeLine: (t) => t.length * 20, measureToken: (t) => t.length * 20 },
    100
  );
  assert.equal(result.join(" ").replace(/\s+/g, " ").trim(), line);
  assert.ok(result.length > 1);
});
