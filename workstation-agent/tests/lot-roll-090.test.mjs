// 0.9.0: LOT/ROLL ở đáy tem Group UID chọn bố cục theo bề rộng chữ thật — một hàng cỡ 24→18, không vừa thì
// hai hàng cỡ 22 (ROLL vẫn canh phải x=308), chuỗi quá rộng thu tới 14. Đo trong cùng lần gọi PowerShell vòng 1.
import test from "node:test";
import assert from "node:assert/strict";
import { fitLotRoll, LOT_ROLL_SPAN_PX, LOT_ROLL_GAP_PX, estimateTextWidth } from "../src/templates/text-layout.mjs";
import { renderGroupUidLabel, GROUP_UID_LOT_ROLL_LAYOUT } from "../src/templates/group-uid-label.mjs";
import { planProductNames } from "../src/render.mjs";

const widthPerChar = (px) => (text, size) => text.length * px * (size / 22);

test("fitLotRoll: ngắn → một hàng cỡ 24; dài vừa → một hàng cỡ nhỏ hơn; quá dài → hai hàng; chỉ có một chuỗi → một hàng", () => {
  const measureAt = widthPerChar(11); // ~Arial thật ở cỡ 22
  assert.deepEqual(fitLotRoll("B", "56", { measureAt }), { rows: 1, fontSize: 24 });
  // 2 chuỗi tổng 24 ký tự: cỡ 24 = 24*11*24/22 = 288 + gap 10 > 296 → thử 22: 264+10 ≤ 296
  assert.deepEqual(fitLotRoll("197/9-00", "ROLL-0004567", { measureAt }).rows, 1);
  assert.ok(fitLotRoll("197/9-00", "ROLL-0004567", { measureAt }).fontSize < 24);
  const two = fitLotRoll("LOT-2026-ABCDEFGH-01", "ROLL-0000123456", { measureAt });
  assert.equal(two.rows, 2);
  assert.equal(two.fontSize, 22);
  assert.deepEqual(fitLotRoll("B", "", { measureAt }), { rows: 1, fontSize: 24 });
  assert.deepEqual(fitLotRoll("", "", { measureAt }), { rows: 1, fontSize: 24 });
});

test("fitLotRoll: một chuỗi rộng hơn khung ở mọi cỡ thì thu theo tỷ lệ, không dưới 14", () => {
  const measureAt = widthPerChar(11);
  const long = "X".repeat(40); // LOT: + 40 ký tự ≈ 484px ở cỡ 22
  const fit = fitLotRoll(long, "1", { measureAt });
  assert.equal(fit.rows, 2);
  assert.ok(fit.fontSize >= 14 && fit.fontSize < 22, `cỡ thu nhỏ: ${fit.fontSize}`);
  const only = fitLotRoll(long, "", { measureAt });
  assert.equal(only.rows, 1);
  assert.ok(only.fontSize >= 14 && only.fontSize < 18);
});

test("fitLotRoll với estimateTextWidth (không đo được): hai chuỗi ngắn vẫn một hàng 24, hai chuỗi dài xuống hai hàng", () => {
  assert.deepEqual(fitLotRoll("A1", "7", { measureAt: estimateTextWidth }), { rows: 1, fontSize: 24 });
  assert.equal(fitLotRoll("KHO-2026-10-11-LOT-0001", "ROLL-000123", { measureAt: estimateTextWidth }).rows, 2);
});

test("template Group UID: một hàng y=452; hai hàng LOT y=440 trái, ROLL y=470 vẫn canh phải x=308; dùng lotRollFit khi có", () => {
  const base = { groupUid: "1028260000000001", sku: "900000001", productName: "Vải thử", lot: "B", roll: "56" };
  const one = renderGroupUidLabel(base);
  assert.match(one, /<text x="12" y="452" font-size="24">LOT: B<\/text>/);
  assert.match(one, /<text x="308" y="452" font-size="24" text-anchor="end">ROLL: 56<\/text>/);
  const two = renderGroupUidLabel({ ...base, lot: "LOT-2026-ABCDEFGH-01", roll: "ROLL-0000123456", lotRollFit: { rows: 2, fontSize: 22 } });
  assert.match(two, new RegExp(`<text x="12" y="${GROUP_UID_LOT_ROLL_LAYOUT.twoRows[0]}" font-size="22">LOT: LOT-2026-ABCDEFGH-01</text>`));
  assert.match(two, new RegExp(`<text x="308" y="${GROUP_UID_LOT_ROLL_LAYOUT.twoRows[1]}" font-size="22" text-anchor="end">ROLL: ROLL-0000123456</text>`));
  assert.ok(GROUP_UID_LOT_ROLL_LAYOUT.twoRows[0] > 418 && GROUP_UID_LOT_ROLL_LAYOUT.twoRows[1] + 6 <= 480, "hai hàng nằm giữa đáy barcode SKU và mép tem");
  // Không có lotRollFit (preview đơn lẻ): tự ước lượng, chuỗi dài vẫn xuống hai hàng
  const guessed = renderGroupUidLabel({ ...base, lot: "KHO-2026-10-11-LOT-0001", roll: "ROLL-000123" });
  assert.match(guessed, /y="440"[^>]*>LOT:/);
  assert.match(guessed, /y="470"[^>]*text-anchor="end">ROLL:/);
  // lotRollFit hai hàng nhưng thiếu roll → vẫn một hàng
  const lotOnly = renderGroupUidLabel({ ...base, roll: "", lotRollFit: { rows: 2, fontSize: 22 } });
  assert.match(lotOnly, /y="452" font-size="22">LOT: B/);
  assert.ok(!lotOnly.includes("ROLL:"));
});

test("planProductNames: LOT/ROLL của tem Group UID đo trong vòng 1 (nhóm extra thứ ba), gắn lotRollFit, vẫn HAI lần gọi", async () => {
  const calls = [];
  const table = (texts, sizes, px) => new Map(texts.map((t) => [t, new Map(sizes.map((s) => [s, t.length * px * (s / 22)]))]));
  const measureText = async (_config, texts, sizes, options = {}) => {
    const extra = options.extra || [];
    calls.push({ texts, sizes, extra });
    // LOT/ROLL đo "rộng" để buộc xuống hai hàng; các nhóm khác đo như Arial
    return Object.assign(table(texts, sizes, 11), { extra: extra.map((group, index) => table(group.texts, group.sizes, index === 2 ? 20 : 11)) });
  };
  const entries = [
    { type: "group_uid", copies: 1, payload: { groupUid: "1028260000000001", sku: "900000001", productName: "Vải thử", lot: "197/9", roll: "004" } },
    { type: "group_uid", copies: 1, payload: { groupUid: "1028260000000002", sku: "900000001", productName: "Vải thử", lot: "", roll: "" } },
    { type: "sku", copies: 1, payload: { sku: "900000001", productName: "SP", quantity: "1", printedDate: "11/10/26" } }
  ];
  const result = await planProductNames(entries, {}, measureText, null);
  assert.equal(calls.length, 2, "vẫn hai lần gọi PowerShell");
  assert.deepEqual(calls[0].extra[2].texts, ["LOT: 197/9", "ROLL: 004"], "LOT/ROLL vào nhóm đo thứ ba, bỏ chuỗi trống");
  assert.deepEqual(calls[0].extra[2].sizes, [24, 22, 20, 18, 14]);
  const fit = result[0].payload.lotRollFit;
  assert.ok(fit && (fit.rows === 1 || fit.rows === 2) && fit.fontSize >= 14, `lotRollFit: ${JSON.stringify(fit)}`);
  // đo rộng 20px/ký tự: "LOT: 197/9" (10) + gap + "ROLL: 004" (9) ở cỡ 24 ≈ 415 > 296 → không thể một hàng cỡ 24
  assert.ok(!(fit.rows === 1 && fit.fontSize === 24), "phải dùng số đo thật, không giữ cỡ 24 một hàng");
  assert.equal(result[1].payload.lotRollFit, undefined, "tem không có LOT/ROLL thì không gắn");
  assert.equal(result[2].payload.lotRollFit, undefined, "tem SKU không gắn");
  const svg = renderGroupUidLabel(result[0].payload);
  assert.ok(/LOT: 197\/9/.test(svg) && /ROLL: 004/.test(svg));
  assert.ok(LOT_ROLL_SPAN_PX === 296 && LOT_ROLL_GAP_PX === 10);
});
