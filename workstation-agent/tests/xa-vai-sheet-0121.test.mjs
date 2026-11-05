// 0.12.1 (05/11/2026, sau tờ in thử 0.12.0): barcode phiếu IT ở giữa mép trên, một ô ký "Người xả" ghi tên máy gửi lệnh (deviceName, máy chủ
// xa_vai_a4_v3), bỏ ô "Người kiểm". Dữ liệu giả: SKU 9000000xx, Group UID 1028260000000xxx, phiếu IT 1007260000000xxx.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob } from "../src/job-validator.mjs";
import { XA_VAI_PAGE, renderXaVaiSheetSvgs, xaVaiTopBarcodeLayout } from "../src/templates/xa-vai-sheet.mjs";

const uid = (n) => `1028260000000${String(n).padStart(3, "0")}`;
const IT1 = "1007260000000001", IT2 = "1007260000000002";
const rich = (n, sku, overrides = {}) => ({
  groupUid: uid(n), sku, lot: `LOT-${n}`, roll: `R${n}`, systemMm: 50000, actualMm: 49500, measuredAt: "2026-11-05T02:00:00Z",
  unit: "mm", systemQty: 50000, actualQty: 49500, fabricCode: "M001_NCC", color: "Đen", itNumber: IT1, ...overrides
});
const job = (items, payload = {}) => ({
  id: "job-xv-0121", nonce: "nonce-xv-0121", type: "xa_vai_sheet", templateVersion: 1, copies: 1, requestedBy: "xa-vai",
  payload: { itemCode: "TEST01", productName: null, printedAt: "2026-11-05T03:00:00.000Z", reprint: false, itNumbers: [IT1], deviceName: "MAY-THU-01", items, ...payload }
});
const payloadOf = (items, payload) => { const n = normalizeJob(job(items, payload)); assert.equal(n.ok, true, n.errors.join("; ")); return n.job.payload; };
const tableTop = (svg) => Number(svg.match(/<rect x="\d+" y="(\d+)" width="\d+" height="72" fill="#dcdcdc"\/>/)[1]);

test("validator: deviceName giữ ≤ 60 ký tự ở lệnh mẫu mới; thiếu → null; lệnh cũ không có khoá", () => {
  assert.equal(payloadOf([rich(1, "900000001")]).deviceName, "MAY-THU-01");
  assert.equal(payloadOf([rich(1, "900000001")], { deviceName: "  " }).deviceName, null);
  assert.equal(payloadOf([rich(1, "900000001")], { deviceName: undefined }).deviceName, null);
  assert.equal(payloadOf([rich(1, "900000001")], { deviceName: "X".repeat(80) }).deviceName.length, 60);
  const legacy = normalizeJob(job([{ groupUid: uid(1), sku: "900000001", lot: "L", roll: "R", systemMm: 1, actualMm: 1, measuredAt: "2026-11-05T02:00:00Z" }]));
  assert.equal(legacy.ok, true); assert.equal("deviceName" in legacy.job.payload, false);
});

test("một phiếu IT: barcode ở mép trên, giữa trang, không đè tiêu đề / Trang; bảng không lùi xuống", () => {
  const payload = payloadOf([rich(1, "900000001"), rich(2, "900000002")]);
  const layout = xaVaiTopBarcodeLayout(payload);
  assert.ok(layout, "vừa mép trên");
  assert.equal(layout.module, 6, "module lớn nhất");
  const [item] = layout.items;
  const mid = item.x + item.width / 2;
  assert.ok(Math.abs(mid - XA_VAI_PAGE.width / 2) <= 2, `giữa trang (${mid})`);
  const svg = renderXaVaiSheetSvgs(payload)[0];
  const free = renderXaVaiSheetSvgs(payloadOf([rich(1, "900000001", { itNumber: null }), rich(2, "900000002", { itNumber: null })], { itNumbers: [] }))[0];
  assert.equal(tableTop(svg), tableTop(free), "không còn dải barcode dưới biển");
  // Vạch barcode nằm trong lề trên + dòng tiêu đề (y 66 → 175), trên vạch kẻ y = 181.
  const bars = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="#000"\/>/g)].map((m) => m.slice(1).map(Number));
  assert.ok(bars.length > 20);
  for (const [x, y, w, h] of bars.filter(([, y]) => y < 200)) {
    assert.ok(y >= 66 && y + h <= XA_VAI_PAGE.marginY + 56, "vạch trong dải mép trên");
    assert.ok(x >= item.x && x + w <= item.x + item.width, "vạch trong khung đã đo");
  }
  assert.match(svg, new RegExp(`data-role="it-number">IT ${IT1}<`));
  // In lại (ô IN LẠI bên trái) vẫn vừa.
  assert.ok(xaVaiTopBarcodeLayout({ ...payload, reprint: true }));
});

test("nhiều phiếu IT không vừa mép trên → dải dưới biển như 0.12.0", () => {
  const payload = payloadOf([rich(1, "900000001"), rich(2, "900000002", { itNumber: IT2 })], { itNumbers: [IT1, IT2] });
  assert.equal(xaVaiTopBarcodeLayout(payload), null);
  const svg = renderXaVaiSheetSvgs(payload)[0];
  assert.equal((svg.match(/data-role="it-number"/g) || []).length, 2);
  const one = renderXaVaiSheetSvgs(payloadOf([rich(1, "900000001"), rich(2, "900000002")]))[0];
  assert.equal(tableTop(svg) - tableTop(one), 165, "dải barcode dưới biển");
  assert.equal(xaVaiTopBarcodeLayout(payloadOf([rich(1, "900000001", { itNumber: null })], { itNumbers: [] })), null, "không phiếu IT: không barcode");
});

test("ô ký: chỉ \"Người xả\" + tên máy; thiếu tên thì ô trống; mẫu cũ (mm) giữ hai ô", () => {
  const svg = renderXaVaiSheetSvgs(payloadOf([rich(1, "900000001")]))[0];
  assert.ok(svg.includes(">Người xả<"));
  assert.equal(svg.includes("Người kiểm"), false);
  assert.match(svg, /data-role="device-name">MAY-THU-01</);
  const noName = renderXaVaiSheetSvgs(payloadOf([rich(1, "900000001")], { deviceName: null }))[0];
  assert.ok(noName.includes(">Người xả<") && !noName.includes('data-role="device-name"'));
  const long = renderXaVaiSheetSvgs(payloadOf([rich(1, "900000001")], { deviceName: "TÊN MÁY RẤT DÀI ".repeat(4) }))[0];
  assert.match(long, /data-role="device-name">[^<]*…</, "tên dài cắt trong ô");
  const legacy = renderXaVaiSheetSvgs(normalizeJob(job([{ groupUid: uid(1), sku: "900000001", lot: "L", roll: "R", systemMm: 1000, actualMm: 990, measuredAt: "2026-11-05T02:00:00Z" }])).job.payload)[0];
  assert.ok(legacy.includes("Người xả") && legacy.includes("Người kiểm"), "mẫu cũ không đổi");
});
