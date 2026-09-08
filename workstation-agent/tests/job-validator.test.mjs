import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob } from "../src/job-validator.mjs";

test("chấp nhận lệnh Group UID hợp lệ", () => {
  const result = normalizeJob({ id: "1", nonce: "n1", type: "group_uid", copies: 2, payload: { groupUid: "A40000258795", sku: "204900073", productName: "Vải Rayon Tropical Firal" } });
  assert.equal(result.ok, true);
  assert.equal(result.job.copies, 2);
});

test("Group UID cho phép bỏ trống SKU", () => {
  const result = normalizeJob({ id: "2", nonce: "n2", type: "group_uid", copies: 1, payload: { groupUid: "A40000258795", sku: "", productName: "Vải Rayon Tropical Firal" } });
  assert.equal(result.ok, true);
});

test("chấp nhận một lệnh gồm nhiều SKU", () => {
  const result = normalizeJob({ id: "3", nonce: "n3", type: "sku", copies: 3, payload: { items: [
    { sku: "204900073", productName: "Vải A", quantity: "10 m", copies: 1 },
    { sku: "204900074", productName: "Vải B", quantity: "20 m", copies: 2 }
  ] } });
  assert.equal(result.ok, true);
  assert.equal(result.job.payload.items.length, 2);
});

test("từ chối loại tem lạ", () => {
  const result = normalizeJob({ id: "1", nonce: "n1", type: "unknown", copies: 1, payload: {} });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /không được hỗ trợ/);
});

test("không cho in quá 500 tem", () => {
  const result = normalizeJob({ id: "1", nonce: "n1", type: "sku", copies: 501, payload: { sku: "204900073", productName: "Test" } });
  assert.equal(result.ok, false);
});
