import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatQuantity } from "../src/templates/common.mjs";
import { QUANTITY_TOP_RATIO, renderSkuLabel, SKU_LABEL_LAYOUT } from "../src/templates/sku-label.mjs";
import {
  DATE_FONT_SIZES, estimateTextWidth, fitFooter, FOOTER_GAP_PX, FOOTER_SPAN_PX, QUANTITY_FONT_SIZES
} from "../src/templates/text-layout.mjs";
import { planProductNames } from "../src/render.mjs";
import { measureTextWidths } from "../src/text-metrics.mjs";

// Đáy tem SKU (30/09/2026): vạch kẻ + hàng số lượng/ngày cố định, số lượng có
// dấu chấm hàng nghìn, hai chuỗi hiện đủ ký tự và không bao giờ chạm nhau.
// Dữ liệu dưới đây là giả, chỉ mô phỏng đúng hình dạng số liệu thật đã gặp.

const NAME_8_LINES = "Thun nhung 7mm/W.TT.S-07-323H_Triều Vĩ/65%polyester,*35%spandex/None/XANH NAVY KHÓI 19-4117 TCX_ WKF-12473 phu lieu them chi tiet mau sac/none/7mm/mm";
const lineYOf = (svg) => Number(svg.match(/<line x1="20" y1="(\d+)"/)[1]);
const footerOf = (svg, text) => {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = svg.match(new RegExp(`<text x="(\\d+)" y="(\\d+)" font-size="(\\d+)"( text-anchor="end")?>${escaped}</text>`));
  assert.ok(match, `không thấy "${text}" nguyên vẹn ở đáy tem`);
  return { x: Number(match[1]), y: Number(match[2]), size: Number(match[3]) };
};

test("so luong co dau cham hang nghin, khong dong vao so da dinh dang, thap phan, phan so, ma", () => {
  const cases = {
    "300000000": "300.000.000", "35416667": "35.416.667", "1000000": "1.000.000", "1234": "1.234",
    "999": "999", "": "", "1.000.000": "1.000.000", "1234,5": "1.234,5", "1.200,50 mét": "1.200,50 mét",
    "12.5": "12.5", "5000m": "5.000m", "1/2": "1/2", "TEST12345": "TEST12345", "0012345": "0012345", " 1500 cuộn ": "1.500 cuộn"
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(formatQuantity(input), expected, `"${input}"`);
});

test("vach ke va hang so luong/ngay co dinh o day tem, khong troi theo so dong ten", () => {
  const short = renderSkuLabel({ sku: "100000001", productName: "SP ngắn", quantity: "12", printedDate: "30/09/26" });
  const long = renderSkuLabel({ sku: "100000001", productName: NAME_8_LINES, quantity: "12", printedDate: "30/09/26" });
  assert.equal([...long.matchAll(/<text x="12" y="\d+" font-size="22">/g)].length, 8, "tên vẫn chứa đủ 8 dòng cỡ 22");
  assert.equal(lineYOf(short), SKU_LABEL_LAYOUT.lineY);
  assert.equal(lineYOf(long), SKU_LABEL_LAYOUT.lineY);
  assert.equal(footerOf(short, "30/09/26").y, SKU_LABEL_LAYOUT.footerY);
  assert.equal(footerOf(long, "30/09/26").y, SKU_LABEL_LAYOUT.footerY);
  assert.equal(footerOf(long, "12").y, SKU_LABEL_LAYOUT.footerY, "số lượng và ngày cùng một hàng");
});

test("so SKU luon nam tren vach ke, ke ca ten 8 dong va QR lon hon uoc luong", () => {
  for (const sku of ["100000001", "TEST-SKU-abc-0001"]) {
    const svg = renderSkuLabel({ sku, productName: NAME_8_LINES, quantity: "12", printedDate: "30/09/26" });
    const skuY = Number(svg.match(/<text x="160" y="(\d+)" font-size="32"/)[1]);
    assert.ok(skuY <= lineYOf(svg) - 6, `SKU ${sku}: chân chữ y=${skuY} quá sát vạch kẻ y=${lineYOf(svg)}`);
  }
});

test("so luong co lon nhat van khong cham vach ke, hang cuoi khong tran mep tem", () => {
  const { lineY, footerY } = SKU_LABEL_LAYOUT;
  const tallestTop = footerY - QUANTITY_TOP_RATIO * QUANTITY_FONT_SIZES[0];
  assert.ok(tallestTop >= lineY + 1 + 2, `đỉnh chữ cỡ ${QUANTITY_FONT_SIZES[0]} ở y=${tallestTop}, vạch kẻ tới y=${lineY + 1}`);
  assert.ok(footerY + 0.21 * QUANTITY_FONT_SIZES[0] <= 480, "chân chữ có móc (g, p) vẫn trong tem");
});

test("so luong va ngay hien du ky tu, khong bao gio cham nhau", () => {
  const quantities = ["12", "300000000", "35416667", "1.200,50 mét", "1500 cuộn", "Q".repeat(40), "9".repeat(40)];
  for (const date of ["30/09/26", "30/09/2026"]) {
    for (const quantity of quantities) {
      const text = formatQuantity(quantity);
      const svg = renderSkuLabel({ sku: "100000001", productName: "SP", quantity, printedDate: date });
      const qty = footerOf(svg, text);
      const day = footerOf(svg, date);
      const right = qty.x + estimateTextWidth(text, qty.size);
      const left = day.x - estimateTextWidth(date, day.size);
      assert.ok(right + FOOTER_GAP_PX <= left + 0.01, `"${text}" cỡ ${qty.size} (tới x=${right}) chạm ngày "${date}" cỡ ${day.size} (từ x=${left})`);
    }
  }
});

test("thu nho so luong truoc, chi thu nho ngay khi so luong da xuong 18", () => {
  const measure = { measureQuantity: estimateTextWidth, measureDate: estimateTextWidth };
  assert.deepEqual(fitFooter("12", "30/09/26", measure), { quantityFontSize: 40, dateFontSize: 17 });
  const long = fitFooter("300.000.000", "30/09/26", measure);
  assert.ok(long.quantityFontSize < 40 && long.quantityFontSize >= 18);
  assert.equal(long.dateFontSize, 17, "số lượng còn thu nhỏ được thì ngày giữ cỡ 17");
  const huge = fitFooter("Q".repeat(40), "30/09/2026", measure);
  assert.equal(huge.dateFontSize, DATE_FONT_SIZES[DATE_FONT_SIZES.length - 1]);
  assert.ok(estimateTextWidth("Q".repeat(40), huge.quantityFontSize) + FOOTER_GAP_PX + estimateTextWidth("30/09/2026", huge.dateFontSize) <= FOOTER_SPAN_PX);
  assert.deepEqual(fitFooter("", "30/09/26", measure), { quantityFontSize: null, dateFontSize: 17 });
});

// measureText giả có hỗ trợ nhóm đo thêm (extra), giống measureTextWidths thật.
function fakeMeasureText(widthPerChar) {
  const calls = [];
  const table = (texts, sizes) => new Map(texts.map((text) => [text, new Map(sizes.map((size) => [size, text.length * widthPerChar * (size / 22)]))]));
  const fn = async (config, texts, sizes, options = {}) => {
    calls.push({ texts: [...texts], sizes: [...sizes], extra: options.extra });
    return Object.assign(table(texts, sizes), { extra: (options.extra || []).map((group) => table(group.texts, group.sizes)) });
  };
  fn.calls = calls;
  return fn;
}

test("planProductNames do so luong va ngay trong vong 1, van dung HAI lan goi", async () => {
  const measureText = fakeMeasureText(20); // rộng gấp ~3 lần Arial thật để buộc phải thu nhỏ
  const entries = [{ type: "sku", copies: 1, payload: { sku: "100000001", productName: "SP", quantity: "300000000", printedDate: "30/09/26" } }];
  const [planned] = await planProductNames(entries, {}, measureText, null);
  assert.equal(measureText.calls.length, 2);
  assert.deepEqual(measureText.calls[0].extra.map((group) => group.texts), [["300.000.000"], ["30/09/26"]]);
  assert.deepEqual(measureText.calls[0].extra.map((group) => group.sizes), [QUANTITY_FONT_SIZES, DATE_FONT_SIZES]);
  const width = (text, size) => text.length * 20 * (size / 22);
  const { quantityFontSize, dateFontSize } = planned.payload.footerFit;
  assert.ok(width("300.000.000", quantityFontSize) + FOOTER_GAP_PX + width("30/09/26", dateFontSize) <= FOOTER_SPAN_PX, "phải dùng số đo thật, không phải ước lượng");
  assert.ok(quantityFontSize < fitFooter("300.000.000", "30/09/26", { measureQuantity: estimateTextWidth, measureDate: estimateTextWidth }).quantityFontSize);
});

test("measureTextWidths tach ket qua nhom do them theo chi so group", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "footer-metrics-"));
  try {
    let request;
    const __exec = async (scriptFile, inputFile, outputFile) => {
      request = JSON.parse(fs.readFileSync(inputFile, "utf8"));
      const results = [{ text: "SP", size: 22, width: 30 }];
      request.extra.forEach((group, index) => {
        for (const size of group.sizes) for (const text of group.texts) results.push({ group: index, text, size, width: size });
      });
      fs.writeFileSync(outputFile, JSON.stringify({ ok: true, results }), "utf8");
    };
    const result = await measureTextWidths({ tempDir: dir }, ["SP"], [22], {
      __exec, extra: [{ texts: ["300.000.000", "300.000.000"], sizes: [40, 18] }, { texts: ["30/09/26"], sizes: [17] }]
    });
    assert.deepEqual(request.extra[0].texts, ["300.000.000"], "loại trùng trong từng nhóm");
    assert.equal(result.get("SP").get(22), 30);
    assert.equal(result.extra[0].get("300.000.000").get(18), 18);
    assert.equal(result.extra[1].get("30/09/26").get(17), 17);
    assert.equal(result.get("30/09/26"), undefined, "kết quả nhóm thêm không lẫn vào nhóm chính");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
