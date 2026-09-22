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

test("chấp nhận một lệnh gồm nhiều Group UID", () => {
  const result = normalizeJob({ id: "4", nonce: "n4", type: "group_uid", copies: 3, payload: { items: [
    { groupUid: "[UID_DA_XOA]", sku: "[SKU_DA_XOA]", productName: "Vải woven NSB", copies: 1 },
    { groupUid: "[UID_DA_XOA]", sku: "", productName: "Vải woven NSB", copies: 2 }
  ] } });
  assert.equal(result.ok, true);
  assert.equal(result.job.payload.items.length, 2);
});

test("batch Group UID phải khớp tổng số bản", () => {
  const result = normalizeJob({ id: "5", nonce: "n5", type: "group_uid", copies: 5, payload: { items: [
    { groupUid: "[UID_DA_XOA]", productName: "Vải woven NSB", copies: 1 }
  ] } });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /không khớp/);
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

test("group_uid nhan Lot va Roll, va chung khong bat buoc", () => {
  const coLot = normalizeJob({
    id: "j1", nonce: "n1", type: "group_uid", templateVersion: 1, copies: 1,
    payload: { items: [{ groupUid: "[UID_DA_XOA]", sku: "[SKU_DA_XOA]",
                         productName: "Vai Pique", lot: "B", roll: "56", copies: 1 }] }
  });
  assert.equal(coLot.ok, true, coLot.errors?.join("; "));
  assert.equal(coLot.job.payload.items[0].lot, "B");
  assert.equal(coLot.job.payload.items[0].roll, "56");

  const khongLot = normalizeJob({
    id: "j2", nonce: "n2", type: "group_uid", templateVersion: 1, copies: 1,
    payload: { items: [{ groupUid: "[UID_DA_XOA]", productName: "Vai Pique", copies: 1 }] }
  });
  assert.equal(khongLot.ok, true, khongLot.errors?.join("; "));
  assert.equal(khongLot.job.payload.items[0].lot, "");
});
