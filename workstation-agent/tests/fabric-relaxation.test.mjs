import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob } from "../src/job-validator.mjs";
import { renderFabricRelaxationLabel } from "../src/templates/fabric-relaxation-label.mjs";
import { renderJobTspl, renderRowSvg } from "../src/render.mjs";

const job = { id:"test-fabric", nonce:"test-fabric-1", type:"fabric_relaxation", templateVersion:2, copies:3, payload:{ itemCodes:["000TEST-FABRIC-01", "000TEST-FABRIC-02"], lot:"DO-NOT-PRINT" } };
const handwrittenJob = { id:"test-fabric-v3", nonce:"test-fabric-v3-1", type:"fabric_relaxation", templateVersion:3, copies:3, payload:{ handwritten:true } };
test("Fabric v3 chỉ nhận tem viết tay không có mã hàng", () => {
  const result = normalizeJob(handwrittenJob);
  assert.equal(result.ok, true);
  assert.deepEqual(result.job.payload, { handwritten:true });
  for (const payload of [{}, { handwritten:false }, { handwritten:"true" }, { itemCodes:["SHOULD-NOT-PRINT"] }]) {
    assert.equal(normalizeJob({ ...handwrittenJob, payload }).ok, false);
  }
});
test("Fabric v3 chừa khoảng ghi tay dưới Mã hàng rồi in Lot, Ngày và Giờ cỡ 28", () => {
  const svg = renderFabricRelaxationLabel({ handwritten:true });
  assert.match(svg, /<text x="160" y="50" font-size="28" text-anchor="middle">Mã hàng<\/text>/);
  assert.match(svg, /<text x="16" y="200" font-size="28">Lot:<\/text>/);
  assert.match(svg, /<text x="16" y="305" font-size="28">Ngày:<\/text><text x="104" y="305" font-size="28">\.\.\.\.\. \/ \.\.\.\.\.<\/text>/);
  assert.match(svg, /<text x="16" y="415" font-size="28">Giờ:<\/text><text x="104" y="415" font-size="28">\.\.\.\.\. : \.\.\.\.\.<\/text>/);
  assert.ok(!svg.includes("itemCodes"));
});
test("Fabric v2 giữ 1–5 mã hàng riêng và chặn danh sách không hợp lệ", () => {
  const result = normalizeJob(job);
  assert.equal(result.ok, true);
  assert.deepEqual(result.job.payload, { itemCodes:["000TEST-FABRIC-01", "000TEST-FABRIC-02"] });
  for (const itemCodes of [[], Array(6).fill("TEST"), [""], ["A".repeat(41)], ["<script>"], ["A\nB"]]) {
    assert.equal(normalizeJob({ ...job, payload:{ itemCodes } }).ok, false);
  }
  for (const copies of [0, -1, 1.5, 501]) assert.equal(normalizeJob({ ...job, copies }).ok, false);
  for (const copies of [1, 500]) assert.equal(normalizeJob({ ...job, copies }).ok, true);
});
test("Fabric xếp mã liên tiếp phía trên và chỉ có một bộ Ngày/Giờ/Lot dùng chung", () => {
  const itemCodes = ["TEST-01", "TEST-02", "TEST-03", "TEST-04", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"];
  const svg = renderFabricRelaxationLabel({ itemCodes, lot:"DO-NOT-PRINT" });
  assert.match(svg, /width="320" height="480"/);
  assert.deepEqual([...svg.matchAll(/font-weight="700"[^>]*>(.*?)<\/text>/g)].map(x => x[1]), itemCodes);
  for (const name of ["Ngày:", "Giờ:", "Lot:"]) assert.equal((svg.match(new RegExp(name, "g")) || []).length, 1);
  assert.equal((svg.match(/stroke-dasharray=/g) || []).length, 3);
  const codeYs = [...svg.matchAll(/<text x="160" y="(\d+)"[^>]*font-weight="700"/g)].map(match => Number(match[1]));
  const fieldYs = [...svg.matchAll(/<text x="16" y="(\d+)"/g)].map(match => Number(match[1]));
  assert.equal(codeYs.length, 5);
  assert.ok(Math.max(...codeYs) < Math.min(...fieldYs));
  assert.equal(new Set(fieldYs).size, 3);
  assert.ok(!svg.includes("DO-NOT-PRINT"));
});
test("Fabric v1 vẫn in được job cũ đang chờ", () => {
  const oldJob = { ...job, templateVersion:1, payload:{ itemCode:"OLD-FABRIC-01" } };
  assert.equal(normalizeJob(oldJob).ok, true);
  assert.match(renderFabricRelaxationLabel(oldJob.payload), /OLD-FABRIC-01/);
});
test("Fabric số lẻ để trắng bên phải; TSPL dùng giấy 82 × 60 và đúng số hàng", async () => {
  const normalized = normalizeJob(handwrittenJob).job;
  assert.equal((renderRowSvg([normalized]).match(/Mã hàng/g) || []).length, 1);
  for (const copies of [1, 2, 3, 4]) {
    const tspl = await renderJobTspl({ ...normalized, copies }, { density:10, speed:3 });
    assert.match(tspl.subarray(0,100).toString(), /SIZE 82 mm,60 mm/);
    assert.equal((tspl.toString("latin1").match(/PRINT 1\r\n/g) || []).length, Math.ceil(copies / 2));
  }
});
