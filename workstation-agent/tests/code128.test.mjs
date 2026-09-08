import test from "node:test";
import assert from "node:assert/strict";
import { barcodeRects, encodeCode128 } from "../src/templates/code128.mjs";

test("mã hóa được SKU số và Group UID", () => {
  assert.match(encodeCode128("204900073"), /^[01]+$/);
  assert.match(encodeCode128("A40000258795"), /^[01]+$/);
});

test("module barcode luôn là số dot nguyên", () => {
  const barcode = barcodeRects("A40000258795", { width: 296 });
  assert.equal(Number.isInteger(barcode.moduleWidth), true);
  assert.ok(barcode.moduleWidth >= 1);
  assert.match(barcode.rects, /<rect/);
});
