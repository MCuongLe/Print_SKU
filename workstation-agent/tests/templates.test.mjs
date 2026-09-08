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
