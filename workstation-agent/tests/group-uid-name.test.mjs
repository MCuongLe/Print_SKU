import test from "node:test";
import assert from "node:assert/strict";
import { GROUP_UID_NAME_MAX_WIDTH_PX, groupUidMaxLines, groupUidNameBaseline, renderGroupUidLabel } from "../src/templates/group-uid-label.mjs";
import { planProductNames } from "../src/render.mjs";

// Tên sản phẩm trên tem Group UID (30/09/2026): chia dòng theo bề rộng chữ
// thật như tem SKU, tự thu nhỏ chữ khi dài, không cắt mất đuôi tên. Trước đó
// tem đếm cố định 26 ký tự/dòng và lặng lẽ cắt từ dòng thứ 7 (6 khi có SKU).
// Dữ liệu dưới đây là giả.

const LONG_NAME = "Vải kiểm thử Rib 2x2/TEST-0001_Nhà cung cấp mẫu/93% Cotton 30S, 7% Spandex 40D/260gsm-130cm/Xanh dương thử nghiệm 14-4112 TCX (option C)/g";
const words = (text) => text.split(/[\s/]+/).filter(Boolean);

// measureText giả: 1 ký tự = 10px ở cỡ 22, tỷ lệ theo cỡ chữ. `lineFactor` > 1
// mô phỏng lỗi "Zipper": đo nguyên dòng rộng hơn tổng các token đo riêng.
function fakeMeasureText(lineFactor = 1) {
  const calls = [];
  const fn = async (config, texts, sizes, options = {}) => {
    const round = calls.length;
    calls.push({ texts: [...texts], sizes: [...sizes] });
    const table = (list, sizeList, factor) => new Map(list.map((text) => [text, new Map(sizeList.map((size) => [size, text.length * 10 * (size / 22) * factor]))]));
    return Object.assign(table(texts, sizes, round === 0 ? 1 : lineFactor), {
      extra: (options.extra || []).map((group) => table(group.texts, group.sizes, 1))
    });
  };
  fn.calls = calls;
  return fn;
}

test("khung ten Group UID o co 22 giu dung bo cuc cu: 6 dong khi co SKU, 7 dong khi khong", () => {
  assert.equal(groupUidMaxLines(22, true), 6);
  assert.equal(groupUidMaxLines(22, false), 7);
  assert.equal(groupUidNameBaseline(22, 0), 145, "chân dòng đầu ở y=145 như cũ");
  assert.equal(groupUidNameBaseline(22, 5), 270, "dòng thứ 6 ở y=270, vẫn trên vùng SKU (y=332)");
  for (const size of [20, 18, 16]) {
    assert.ok(groupUidMaxLines(size, true) >= groupUidMaxLines(22, true), `cỡ ${size} không được chứa ít dòng hơn cỡ 22`);
    const last = groupUidNameBaseline(size, groupUidMaxLines(size, true) - 1);
    assert.ok(last <= 270, `cỡ ${size}: dòng cuối y=${last} lấn xuống vùng SKU`);
  }
});

test("tem Group UID ve dung dong va co chu da do that", () => {
  const svg = renderGroupUidLabel({ groupUid: "TEST-UID-0001", sku: "100000001", productName: "bỏ qua", productNameLines: ["Dòng một", "Dòng hai"], productNameFontSize: 18 });
  assert.match(svg, /<text x="12" y="141" font-size="18">Dòng một<\/text>/);
  assert.match(svg, /<text x="12" y="162" font-size="18">Dòng hai<\/text>/);
  assert.doesNotMatch(svg, /bỏ qua/, "đã có dòng đo thật thì không tự chia lại tên");
});

test("khong do duoc chu thi tem Group UID giu nguyen cach cu (26 ky tu/dong, co 22)", () => {
  const svg = renderGroupUidLabel({ groupUid: "TEST-UID-0001", sku: "100000001", productName: LONG_NAME });
  const lines = [...svg.matchAll(/<text x="12" y="(\d+)" font-size="22">/g)].map((match) => Number(match[1]));
  assert.deepEqual(lines, [145, 170, 195, 220, 245, 270]);
});

test("ten Group UID dai (co SKU) duoc thu nho chu de in DU ten thay vi cat", async () => {
  const name = `${LONG_NAME} phu lieu them mo ta chi tiet`; // gần mức tối đa 180 ký tự
  assert.ok(name.length > 160 && name.length <= 180);
  const entries = [{ type: "group_uid", copies: 1, payload: { groupUid: "TEST-UID-0001", sku: "100000001", productName: name } }];
  const [planned] = await planProductNames(entries, {}, fakeMeasureText(), null);
  const { productNameLines: lines, productNameFontSize: size } = planned.payload;
  assert.ok(size < 22, `tên dài phải thu nhỏ, đang cỡ ${size}`);
  assert.ok(lines.length <= groupUidMaxLines(size, true));
  assert.deepEqual(words(lines.join(" ")), words(name), "phải in đủ mọi chữ của tên");
  for (const line of lines) assert.ok(line.length * 10 * (size / 22) <= GROUP_UID_NAME_MAX_WIDTH_PX, `dòng tràn khung: ${line}`);
});

test("vong 2 tach dong lam vuot so dong thi chuyen sang co nho hon, khong cat duoi ten", async () => {
  // Đo nguyên dòng rộng hơn 18% so với tổng token: ở cỡ vòng 1 chọn, bước xác
  // nhận phải tách dòng và vượt số dòng cho phép — bản cũ cắt mất đuôi tên.
  for (const entry of [
    { type: "group_uid", copies: 1, payload: { groupUid: "TEST-UID-0001", sku: "100000001", productName: LONG_NAME } },
    { type: "sku", copies: 1, payload: { sku: "100000001", productName: LONG_NAME + " " + LONG_NAME, quantity: "1", printedDate: "30/09/26" } }
  ]) {
    const measureText = fakeMeasureText(1.18);
    const warnings = [];
    const [planned] = await planProductNames([entry], {}, measureText, { warn: (line) => warnings.push(line) });
    assert.equal(measureText.calls.length, 2, "vẫn đúng hai lần gọi PowerShell");
    assert.deepEqual(words(planned.payload.productNameLines.join(" ")), words(entry.payload.productName), `${entry.type}: phải còn đủ tên`);
    assert.deepEqual(warnings, [], `${entry.type}: không được phải cắt tên`);
  }
});
