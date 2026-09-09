import test from "node:test";
import assert from "node:assert/strict";
import { renderGroupUidLabel } from "../src/templates/group-uid-label.mjs";
import { renderSkuLabel } from "../src/templates/sku-label.mjs";

test("template Group UID có đủ hai mã", () => {
  const svg = renderGroupUidLabel({ groupUid: "A40000258795", sku: "204900073", productName: "Vải Rayon Tropical Firal" });
  assert.match(svg, /A40000258795/);
  assert.match(svg, /204900073/);
  assert.match(svg, /Vải Rayon/);
});

test("template Group UID không vẽ vùng SKU khi bỏ trống", () => {
  const svg = renderGroupUidLabel({ groupUid: "A40000258795", sku: "", productName: "Vải Rayon Tropical Firal" });
  assert.doesNotMatch(svg, />SKU:</);
});

const LONG_NAME = "Thun nhung 7mm/W.TT.S-07-323H_Triều Vĩ/65%polyester,*35%spandex/None/XANH NAVY KHÓI 19-4117 TCX_ WKF-12473/none/7mm/mm";

test("template SKU in đủ tên sản phẩm dài, không cắt mất phần màu", () => {
  const svg = renderSkuLabel({ sku: "422486996", productName: LONG_NAME, quantity: "", printedDate: "09-09-26" });
  assert.match(svg, /XANH NAVY/);
  assert.match(svg, /WKF-12473/);
  const lineCount = (svg.match(/font-size="22"/g) || []).length;
  assert.ok(lineCount >= 5 && lineCount <= 7, `số dòng tên = ${lineCount}`);
});

test("template Group UID có SKU giữ tên tối đa 6 dòng, không tràn vào vùng SKU", () => {
  const svg = renderGroupUidLabel({ groupUid: "1028260903000012", sku: "422486996", productName: LONG_NAME });
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)].map(match => Number(match[1]));
  assert.ok(lines.length <= 6, `số dòng tên = ${lines.length}`);
  assert.ok(Math.max(...lines) < 332, `dòng cuối y=${Math.max(...lines)}`);
  assert.match(svg, /XANH NAVY/);
});

test("template SKU escape nội dung HTML", () => {
  const svg = renderSkuLabel({ sku: "204900073", productName: "Áo & quần <test>", quantity: "12", printedDate: "08-09-26" });
  assert.match(svg, /Áo &amp; quần &lt;test&gt;/);
});

test("template SKU xếp barcode, mã SKU và tên SP giống Group UID", () => {
  const svg = renderSkuLabel({ sku: "204900073", productName: "Sản phẩm mẫu", quantity: "12", printedDate: "08-09-26" });
  assert.match(svg, /y="15"/);
  assert.match(svg, /y="103" font-size="25"[^>]*>204900073<\/text>/);
  assert.match(svg, /x="12" y="145" font-size="22">Sản phẩm mẫu<\/text>/);
  assert.match(svg, /y="466" font-size="40"[^>]*>12<\/text>/);
  assert.match(svg, /y="466" font-size="17"[^>]*>08-09-26<\/text>/);
});
