import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob } from "../src/job-validator.mjs";
import { renderFabricRelaxationLabel } from "../src/templates/fabric-relaxation-label.mjs";
import { renderJobTspl, renderRowSvg } from "../src/render.mjs";

const job = { id:"test-fabric", nonce:"test-fabric-1", type:"fabric_relaxation", templateVersion:2, copies:3, payload:{ itemCodes:["000TEST-FABRIC-01", "000TEST-FABRIC-02"], lot:"DO-NOT-PRINT" } };
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
test("Fabric giữ mỗi mã một dòng với Ngày/Giờ/Lot ngay bên dưới", () => {
  const itemCodes = ["TEST-01", "TEST-02", "TEST-03", "TEST-04", "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234"];
  const svg = renderFabricRelaxationLabel({ itemCodes, lot:"DO-NOT-PRINT" });
  assert.match(svg, /width="320" height="480"/);
  assert.deepEqual([...svg.matchAll(/font-weight="700"[^>]*>(.*?)<\/text>/g)].map(x => x[1]), itemCodes);
  for (const name of ["Ngày:", "Giờ:", "Lot:"]) assert.equal((svg.match(new RegExp(name, "g")) || []).length, 5);
  assert.equal((svg.match(/stroke-dasharray=/g) || []).length, 15);
  assert.ok(!svg.includes("DO-NOT-PRINT"));
});
test("Fabric v1 vẫn in được job cũ đang chờ", () => {
  const oldJob = { ...job, templateVersion:1, payload:{ itemCode:"OLD-FABRIC-01" } };
  assert.equal(normalizeJob(oldJob).ok, true);
  assert.match(renderFabricRelaxationLabel(oldJob.payload), /OLD-FABRIC-01/);
});
test("Fabric số lẻ để trắng bên phải; TSPL dùng giấy 82 × 60 và đúng số hàng", async () => {
  const normalized = normalizeJob(job).job;
  assert.equal((renderRowSvg([normalized]).match(/Mã hàng/g) || []).length, 1);
  for (const copies of [1, 2, 3, 4]) {
    const tspl = await renderJobTspl({ ...normalized, copies }, { density:10, speed:3 });
    assert.match(tspl.subarray(0,100).toString(), /SIZE 82 mm,60 mm/);
    assert.equal((tspl.toString("latin1").match(/PRINT 1\r\n/g) || []).length, Math.ceil(copies / 2));
  }
});
