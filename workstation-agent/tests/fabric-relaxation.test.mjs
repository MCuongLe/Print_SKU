import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob } from "../src/job-validator.mjs";
import { renderFabricRelaxationLabel } from "../src/templates/fabric-relaxation-label.mjs";
import { renderJobTspl, renderRowSvg } from "../src/render.mjs";

const job = { id:"test-fabric", nonce:"test-fabric-1", type:"fabric_relaxation", templateVersion:1, copies:3, payload:{ itemCode:"000TEST-FABRIC-01", lot:"DO-NOT-PRINT", printedDate:"DO-NOT-PRINT" } };
test("Fabric giữ mã hàng, bỏ dữ liệu ghi tay và chặn mã/số lượng không hợp lệ", () => {
  const result = normalizeJob(job);
  assert.equal(result.ok, true);
  assert.deepEqual(result.job.payload, { itemCode:"000TEST-FABRIC-01" });
  for (const itemCode of ["", "A".repeat(41), "<script>", "A\nB"]) assert.equal(normalizeJob({ ...job, payload:{ itemCode } }).ok, false);
  for (const copies of [0, -1, 1.5, 501]) assert.equal(normalizeJob({ ...job, copies }).ok, false);
  for (const copies of [1, 500]) assert.equal(normalizeJob({ ...job, copies }).ok, true);
});
test("Fabric có đủ mã dài 40 ký tự và ba dòng ghi tay trên tem 40 × 60", () => {
  const itemCode = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ1234";
  const svg = renderFabricRelaxationLabel({ itemCode, lot:"DO-NOT-PRINT" });
  assert.match(svg, /width="320" height="480"/);
  assert.equal([...svg.matchAll(/font-weight="700"[^>]*>(.*?)<\/text>/g)].map(x => x[1]).join(""), itemCode);
  for (const name of ["Ngày:", "Giờ:", "Lot:"]) assert.ok(svg.includes(name));
  assert.equal((svg.match(/stroke-dasharray=/g) || []).length, 3);
  assert.ok(!svg.includes("DO-NOT-PRINT"));
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
