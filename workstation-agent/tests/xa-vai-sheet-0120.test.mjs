// 0.12.0 (05/11/2026): phiếu A4 xả vải bản mới — cùng lệnh xa_vai_sheet v1, máy chủ xa_vai_a4_v2 thêm itNumbers + trường đơn vị gốc / mã vải /
// màu ở từng dòng. Mọi dòng có khoá `unit` → mẫu mới: barcode phiếu IT, nhóm theo SKU (tiêu đề + cộng nhóm), cột Mã vải / Màu, số theo đơn vị gốc.
// Lệnh không có khoá `unit` in mẫu 0.11.0. Dữ liệu giả: SKU 9000000xx, Group UID 1028260000000xxx, phiếu IT 1007260000000xxx.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { normalizeJob } from "../src/job-validator.mjs";
import {
  XA_VAI_COLUMNS, XA_VAI_PAGE, XA_VAI_RICH_COLUMNS, formatViQty, isRichXaVai, paginateXaVaiRich, renderXaVaiSheetPages, renderXaVaiSheetSvgs,
  qtyNote, xaVaiGroups, xaVaiQtyTotals, xaVaiRichEntries, xaVaiRichRowsPerFullPage, xaVaiRichRowsPerPage, xaVaiRichTotals
} from "../src/templates/xa-vai-sheet.mjs";

const uid = (n) => `1028260000000${String(n).padStart(3, "0")}`;
const IT1 = "1007260000000001", IT2 = "1007260000000002";
const rich = (n, sku, overrides = {}) => ({
  groupUid: uid(n), sku, lot: `LOT-${n}`, roll: `R${n}`, systemMm: 50000, actualMm: 49500, measuredAt: "2026-11-05T02:00:00Z",
  unit: "mm", systemQty: 50000, actualQty: 49500, fabricCode: "M001_NCC", color: "Đen", itNumber: IT1, ...overrides
});
const job = (items, payload = {}) => ({
  id: "job-xv-0120", nonce: "nonce-xv-0120", type: "xa_vai_sheet", templateVersion: 1, copies: 1, requestedBy: "xa-vai",
  payload: { itemCode: "TEST01", productName: null, printedAt: "2026-11-05T03:00:00.000Z", reprint: false, itNumbers: [IT1], items, ...payload }
});

test("validator: giữ trường mới khi mọi dòng có unit; lệnh cũ không có trường mới", () => {
  const ok = normalizeJob(job([rich(1, "900000001"), rich(2, "900000002", { unit: "g", systemQty: 16763, actualQty: null, itNumber: "abc" })],
    { itNumbers: [IT1, "x", IT1, IT2] }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.deepEqual(ok.job.payload.itNumbers, [IT1, IT2], "bỏ mã sai, bỏ trùng");
  const [a, b] = ok.job.payload.items;
  assert.deepEqual([a.unit, a.systemQty, a.actualQty, a.fabricCode, a.color, a.itNumber], ["mm", 50000, 49500, "M001_NCC", "Đen", IT1]);
  assert.deepEqual([b.unit, b.systemQty, b.actualQty, b.itNumber], ["g", 16763, null, null], "actualQty null giữ null; itNumber sai → null");
  const bad = normalizeJob(job([rich(1, "900000001", { actualQty: -5 })]));
  assert.equal(bad.ok, false); assert.match(bad.errors.join("; "), /Số lượng thực tế dòng 1 không hợp lệ/);
  const legacy = normalizeJob(job([{ groupUid: uid(1), sku: "900000001", lot: "L", roll: "R", systemMm: 1, actualMm: 1, measuredAt: "2026-11-05T02:00:00Z" }]));
  assert.equal(legacy.ok, true);
  assert.equal("itNumbers" in legacy.job.payload, false); assert.equal("unit" in legacy.job.payload.items[0], false);
  assert.equal(isRichXaVai(legacy.job.payload), false); assert.equal(isRichXaVai(ok.job.payload), true);
});

test("định dạng theo đơn vị gốc + cộng nhóm", () => {
  assert.equal(formatViQty(60758, "g"), "60.758"); assert.equal(formatViQty(1234.5, "m"), "1.234,50"); assert.equal(formatViQty(0, "m"), "0,00");
  assert.equal(formatViQty(-2734, "mm"), "-2.734"); assert.equal(formatViQty(null, "g"), "—");
  const t = xaVaiQtyTotals([rich(1, "9", { systemQty: 100, actualQty: 90 }), rich(2, "9", { systemQty: 50, actualQty: null }), rich(3, "9", { systemQty: null, actualQty: 10 })]);
  assert.deepEqual(t, { count: 3, comparedCount: 1, system: 150, actual: 100, diff: -10, actualMissing: 1, systemMissing: 1 });
  const mixed = xaVaiRichTotals([rich(1, "900000001"), rich(2, "900000002", { unit: "g" })]);
  assert.equal(mixed.mixedUnits, true); assert.equal(mixed.groups, 2);
  assert.equal(xaVaiRichTotals([rich(1, "900000001"), rich(2, "900000001")]).mixedUnits, false);
  assert.equal(xaVaiRichTotals([rich(1, "900000001", { unit: null })]).mixedUnits, false, "một SKU không rõ đơn vị: vẫn cộng");
  assert.equal(xaVaiRichTotals([rich(1, "900000001", { unit: null }), rich(2, "900000002")]).mixedUnits, true);
  assert.equal(formatViQty(18.75, "kg"), "18,75"); assert.equal(formatViQty(0.4, "yard"), "0,40");
});

test("nhóm theo SKU + chia trang: tiêu đề nhóm không đứng cuối trang, nhóm sang trang mới lặp tiêu đề (tiếp)", () => {
  const items = [...Array.from({ length: 20 }, (_, i) => rich(i + 1, "900000001")), ...Array.from({ length: 3 }, (_, i) => rich(30 + i, "900000002", { unit: "g" }))];
  assert.deepEqual(xaVaiGroups(items).map((g) => [g.sku, g.items.length, g.unit]), [["900000001", 20, "mm"], ["900000002", 3, "g"]]);
  const entries = xaVaiRichEntries(items);
  assert.equal(entries.length, 23 + 2 * 2);
  const per = xaVaiRichRowsPerPage(true);
  assert.equal(per, 16);
  const pages = paginateXaVaiRich(entries, per);
  assert.ok(pages.every((page) => page.length <= per));
  assert.ok(pages.every((page) => page[page.length - 1].type !== "head"), "không kết trang bằng tiêu đề nhóm");
  assert.equal(pages[1][0].type, "head"); assert.equal(pages[1][0].continued, true, "trang 2 lặp tiêu đề nhóm");
  assert.equal(pages.flat().filter((e) => e.type === "row").length, 23, "đủ mọi cuộn, không lặp");
  assert.deepEqual(pages.flat().filter((e) => e.type === "row").map((e) => e.index), Array.from({ length: 23 }, (_, i) => i), "STT liền mạch");
});

test("chia trang: trang giữa dùng hết chiều cao, trang cuối chừa TỔNG + ô ký, ưu tiên cắt ở đầu nhóm SKU", () => {
  const full = xaVaiRichRowsPerFullPage(true), last = xaVaiRichRowsPerPage(true);
  assert.equal(full, 19); assert.equal(last, 16);
  // 9 cuộn SKU A + 4 cuộn SKU B = 17 dòng: không vừa trang cuối (16) → tách ở đầu nhóm B, trang cuối có trọn nhóm B (không chỉ dòng Cộng).
  const items = [...Array.from({ length: 9 }, (_, i) => rich(i + 1, "900000001")), ...Array.from({ length: 4 }, (_, i) => rich(20 + i, "900000002"))];
  const pages = paginateXaVaiRich(xaVaiRichEntries(items), full, last);
  assert.deepEqual(pages.map((p) => p.length), [11, 6]);
  assert.equal(pages[1][0].type, "head"); assert.equal(pages[1][0].group.sku, "900000002"); assert.equal(pages[1][0].continued, undefined);
  // Một nhóm 40 cuộn: trang giữa 19 dòng, trang cuối ≤ 16, lặp tiêu đề (tiếp), đủ cuộn.
  const big = paginateXaVaiRich(xaVaiRichEntries(Array.from({ length: 40 }, (_, i) => rich(i + 1, "900000001"))), full, last);
  assert.ok(big.slice(0, -1).every((p) => p.length <= full) && big.at(-1).length <= last);
  assert.ok(big.slice(1).every((p) => p[0].type === "head" && p[0].continued));
  assert.equal(big.flat().filter((e) => e.type === "row").length, 40);
  assert.ok(big.every((p) => p[p.length - 1].type !== "head"));
  // Ca biên (review vòng 1): nhóm lấp đúng một trang giữa → trang sau không chỉ có "(tiếp)" + Cộng; 17 cuộn → trang 1 không bị bóp còn vài cuộn.
  for (const n of [17, 18, 19, 35, 36, 37, 54]) {
    const ps = paginateXaVaiRich(xaVaiRichEntries(Array.from({ length: n }, (_, i) => rich(i + 1, "900000001"))), full, last);
    assert.ok(ps.slice(0, -1).every((p) => p.length <= full) && ps.at(-1).length <= last, `${n} cuộn: không quá sức chứa`);
    assert.equal(ps.flat().filter((e) => e.type === "row").length, n, `${n} cuộn: đủ cuộn`);
    for (const p of ps) if (p.some((e) => e.type === "sum")) assert.ok(p.some((e) => e.type === "row"), `${n} cuộn: trang có dòng Cộng có ít nhất một cuộn`);
    assert.ok(ps[0].length >= full - 3, `${n} cuộn: trang 1 gần đầy (${ps[0].length})`);
  }
  // Ghi chú thiếu số ở dòng Cộng và TỔNG.
  assert.match(qtyNote(xaVaiQtyTotals([rich(1, "9", { systemQty: null }), rich(2, "9", { actualQty: null }), rich(3, "9")])), /1 cuộn thiếu số hệ thống · 1 cuộn chưa đổi được đơn vị/);
  // Vừa trang cuối thì một trang.
  assert.equal(paginateXaVaiRich(xaVaiRichEntries(items.slice(0, 5)), full, last).length, 1);
});

test("SVG mẫu mới: barcode từng phiếu IT, cột Mã vải / Màu, tiêu đề + cộng nhóm, số theo đơn vị gốc; lệnh cũ giữ mẫu cũ", async () => {
  const items = [rich(1, "900000001"), rich(2, "900000001", { actualQty: 50100 }), rich(3, "900000002", { unit: "g", systemQty: 16763, actualQty: 16500, fabricCode: "TN050", color: "White", itNumber: IT2 })];
  const svgs = renderXaVaiSheetSvgs(normalizeJob(job(items, { itNumbers: [IT1, IT2] })).job.payload);
  assert.equal(svgs.length, 1);
  const svg = svgs[0];
  assert.equal((svg.match(/data-role="it-number"/g) || []).length, 2, "hai barcode phiếu IT");
  assert.ok(svg.includes(`IT ${IT1}`) && svg.includes(`IT ${IT2}`));
  for (const title of XA_VAI_RICH_COLUMNS.map((c) => c.title)) assert.ok(svg.includes(`>${title}<`), `cột ${title}`);
  assert.ok(svg.includes("SKU 900000001 · Mã vải M001_NCC · Màu Đen · Đơn vị mm"));
  assert.ok(svg.includes("SKU 900000002 · Mã vải TN050 · Màu White · Đơn vị g"));
  assert.ok(svg.includes("Cộng SKU 900000001 (2 cuộn)") && svg.includes("Cộng SKU 900000002 (1 cuộn)"));
  assert.ok(svg.includes(">16.763<") && svg.includes(">16.500<") && svg.includes(">-263<"), "số gram theo đơn vị gốc");
  assert.ok(svg.includes(">100.000<") && svg.includes(">99.600<"), "cộng nhóm mm");
  assert.ok(svg.includes("TỔNG (3 UID · 2 SKU) · khác đơn vị, không cộng"), "nhiều đơn vị: TỔNG không cộng số");
  assert.equal(XA_VAI_RICH_COLUMNS.reduce((sum, c) => sum + c.width, 0), XA_VAI_PAGE.width - 2 * XA_VAI_PAGE.marginX);
  // Không có phiếu IT (UID tự do): không vẽ dải barcode, thêm 2 dòng mỗi trang.
  const free = renderXaVaiSheetSvgs(normalizeJob(job([rich(1, "900000001", { itNumber: null })], { itNumbers: [] })).job.payload)[0];
  assert.equal(free.includes('data-role="it-number"'), false);
  assert.equal(xaVaiRichRowsPerPage(false), 18);
  // Lệnh cũ (máy chủ chưa xa_vai_a4_v2): mẫu 0.11.0 với cột "(mm)".
  const legacy = renderXaVaiSheetSvgs(normalizeJob(job([{ groupUid: uid(1), sku: "900000001", lot: "L", roll: "R", systemMm: 1000, actualMm: 990, measuredAt: "2026-11-05T02:00:00Z" }])).job.payload)[0];
  assert.ok(legacy.includes(`>${XA_VAI_COLUMNS.find((c) => c.key === "systemMm").title}<`) && !legacy.includes(">Mã vải<"));
  // Dựng PNG được (sharp) với đúng khổ A4 ngang.
  const pngs = await renderXaVaiSheetPages(normalizeJob(job(items, { itNumbers: [IT1, IT2] })).job);
  const meta = await sharp(pngs[0]).metadata();
  assert.deepEqual([meta.width, meta.height], [XA_VAI_PAGE.width, XA_VAI_PAGE.height]);
});

test("nhiều trang: chữ trong ô không tràn, mỗi trang có biển + barcode", () => {
  const items = Array.from({ length: 40 }, (_, i) => rich(i + 1, i < 25 ? "900000001" : "900000002", { lot: "L".repeat(28), roll: "R".repeat(20), fabricCode: "MÃ VẢI RẤT DÀI ".repeat(4), color: "Màu rất dài ".repeat(4) }));
  const svgs = renderXaVaiSheetSvgs(normalizeJob(job(items)).job.payload);
  assert.ok(svgs.length >= 3);
  svgs.forEach((svg, index) => {
    assert.ok(svg.includes(`Trang ${index + 1}/${svgs.length}`));
    assert.ok(svg.includes('data-role="it-number"'), `trang ${index + 1} có barcode`);
    assert.ok(svg.includes('data-role="item-code"'));
  });
  assert.ok(svgs[svgs.length - 1].includes("Người xả"), "ô ký ở trang cuối");
  assert.ok(svgs.slice(0, -1).every((svg) => !svg.includes("Người xả")));
});
