import test from "node:test";
import assert from "node:assert/strict";
import { rawToMonochrome, renderJobTspl } from "../src/render.mjs";

const config = { density: 10, speed: 3 };

test("TSPL giữ nền trắng và in nội dung màu đen", () => {
  const { bitmap } = rawToMonochrome(Buffer.from([255, 255, 255, 255, 0, 0, 0, 0]), 8, 1);
  assert.equal(bitmap[0], 0xf0);
});

test("dựng TSPL Group UID hai tem mà không gọi máy in", async () => {
  const job = {
    id: "dry-uid",
    nonce: "dry-uid-1",
    type: "group_uid",
    copies: 2,
    templateVersion: 1,
    payload: {
      groupUid: "A40000258795",
      sku: "204900073",
      productName: "Vải Rayon Tropical Firal"
    }
  };
  const tspl = await renderJobTspl(job, config);
  assert.match(tspl.subarray(0, 200).toString("ascii"), /SIZE 82 mm,60 mm/);
  assert.match(tspl.subarray(0, 300).toString("ascii"), /BITMAP 0,0,82,480,0,/);
  assert.equal(tspl.includes(Buffer.from("PRINT 1\r\n", "ascii")), true);
});

test("hai Group UID khác nhau ghép chung một hàng giấy", async () => {
  const job = {
    id: "dry-uid-batch", nonce: "dry-uid-batch-1", type: "group_uid", copies: 2, templateVersion: 1,
    payload: { items: [
      { groupUid: "1028260903000004", sku: "422494672", productName: "Vải woven NSB", copies: 1 },
      { groupUid: "1028260903000005", sku: "422494672", productName: "Vải woven NSB", copies: 1 }
    ] }
  };
  const tspl = await renderJobTspl(job, config);
  assert.equal(tspl.toString("latin1").match(/PRINT 1\r\n/g)?.length, 1);
});

test("ba tem Group UID chỉ tốn hai hàng giấy", async () => {
  const job = {
    id: "dry-uid-odd", nonce: "dry-uid-odd-1", type: "group_uid", copies: 3, templateVersion: 1,
    payload: { items: [
      { groupUid: "1028260903000006", sku: "", productName: "Vải woven NSB", copies: 1 },
      { groupUid: "1028260903000007", sku: "", productName: "Vải woven NSB", copies: 2 }
    ] }
  };
  const tspl = await renderJobTspl(job, config);
  assert.equal(tspl.toString("latin1").match(/PRINT 1\r\n/g)?.length, 2);
});

test("dựng một batch gồm nhiều SKU", async () => {
  const job = {
    id: "dry-batch", nonce: "dry-batch-1", type: "sku", copies: 3, templateVersion: 1,
    payload: { items: [
      { sku: "204900073", productName: "Vải A", quantity: "10 m", printedDate: "08-09-26", copies: 1 },
      { sku: "204900074", productName: "Vải B", quantity: "20 m", printedDate: "08-09-26", copies: 2 }
    ] }
  };
  const tspl = await renderJobTspl(job, config);
  assert.equal(tspl.toString("latin1").match(/PRINT 1\r\n/g)?.length, 2);
});
