import test from "node:test";
import assert from "node:assert/strict";
import { planProductNames } from "../src/render.mjs";

// measureText gia: 1 ky tu = 10px tai size 22, ty le tuyen tinh theo size — du
// don gian de kiem tra logic wiring, khong can PowerShell that.
function fakeMeasureText(sizes = [22, 20, 18, 16]) {
  const calls = [];
  const fn = async (config, texts, requestedSizes) => {
    calls.push({ texts: [...texts], sizes: [...requestedSizes] });
    const map = new Map();
    for (const text of texts) {
      const bySize = new Map();
      for (const size of requestedSizes) bySize.set(size, text.length * 10 * (size / 22));
      map.set(text, bySize);
    }
    return map;
  };
  fn.calls = calls;
  return fn;
}

test("planProductNames: goi measureText DUNG HAI LAN cho ca lo (do token + xac nhan dong), khong tang theo so SKU", async () => {
  // Vong 1 do tung token de wrap so bo, vong 2 do nguyen dong de xac nhan
  // (xem canh bao WRAP_SAFETY_FACTOR trong text-layout.mjs — sum-token khong
  // dang tin tuyet doi). Ca hai vong deu gop chung cho TOAN BO lo trong mot
  // lan goi, nen tong luon la 2 du lo co 1 hay 100 SKU khac ten.
  const measureFew = fakeMeasureText();
  await planProductNames(
    [{ type: "sku", copies: 1, payload: { sku: "A", productName: "Ten mot" } }],
    {}, measureFew, null
  );
  assert.equal(measureFew.calls.length, 2, "phai goi dung 2 lan voi 1 SKU");

  const measureMany = fakeMeasureText();
  const manyEntries = Array.from({ length: 50 }, (_, i) => ({
    type: "sku", copies: 1, payload: { sku: `SKU${i}`, productName: `Ten so ${i} khac nhau hoan toan` }
  }));
  await planProductNames(manyEntries, {}, measureMany, null);
  assert.equal(measureMany.calls.length, 2, "phai VAN goi dung 2 lan voi 50 SKU khac ten, khong tang theo so luong");
});

test("planProductNames: khong sua doi mang/entry goc, tra ve entries moi", async () => {
  const measureText = fakeMeasureText();
  const original = { type: "sku", copies: 1, payload: { sku: "A", productName: "Ten mot" } };
  const entries = [original];
  const result = await planProductNames(entries, {}, measureText, null);
  assert.equal(original.payload.productNameLines, undefined, "khong duoc sua doi entry goc (tranh anh huong nguoi goi)");
  assert.ok(Array.isArray(result[0].payload.productNameLines), "entries tra ve phai co productNameLines");
});

test("planProductNames: khong co measureText thi tra nguyen entries, khong doi gi", async () => {
  const entries = [{ type: "sku", copies: 1, payload: { sku: "A", productName: "Ten mot" } }];
  const result = await planProductNames(entries, {}, undefined, null);
  assert.equal(result, entries, "phai tra ve chinh mang dau vao khi khong bat do chu that");
});

test("planProductNames: do ca ten tem Group UID (cung logic tem SKU), bo qua fabric_relaxation", async () => {
  // Tu 30/09/2026 tem Group UID cung chia dong theo be rong chu that de khong
  // mat duoi ten; tem Fabric khong in ten san pham nen khong duoc do.
  const measureText = fakeMeasureText();
  const entries = [
    { type: "group_uid", copies: 1, payload: { groupUid: "X", productName: "Ten UID" } },
    { type: "sku", copies: 1, payload: { sku: "A", productName: "Ten SKU" } },
    { type: "fabric_relaxation", copies: 1, payload: { handwritten: true } },
  ];
  const result = await planProductNames(entries, {}, measureText, null);
  assert.ok(Array.isArray(result[0].payload.productNameLines), "group_uid phai co productNameLines");
  assert.equal(result[0].payload.footerFit, undefined, "tem Group UID khong co hang so luong/ngay");
  assert.ok(Array.isArray(result[1].payload.productNameLines));
  assert.equal(result[2], entries[2], "fabric_relaxation giu nguyen");
  assert.equal(measureText.calls.length, 2, "van dung hai lan goi cho ca lo");
  assert.ok(measureText.calls[0].texts.some((t) => t.includes("UID")), "ten Group UID phai duoc do");
});

test("planProductNames: do that PowerShell loi thi lui ve an toan, khong lam sap ca lenh in", async () => {
  const failing = async () => { throw new Error("PowerShell timeout"); };
  const warnings = [];
  const logger = { warn: (msg) => warnings.push(msg) };
  const entries = [{ type: "sku", copies: 1, payload: { sku: "A", productName: "Ten mot" } }];
  const result = await planProductNames(entries, {}, failing, logger);
  assert.equal(result[0].payload.productNameLines, undefined, "loi thi khong gan productNameLines, de sku-label.mjs tu lui ve wrapText");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /PowerShell timeout/);
});

test("planProductNames: vong 2 phat hien dong con vuot thi tach bot, khong de tran tem (dung y het loi that 'Zipper' ngay 24/09/2026)", async () => {
  // So lieu THAT do duoc: tong 5 token rieng cua "Opened end/No.3 Plastic
  // Zipper " = 294,7px (duoi maxWidthPx=296 nen wrap so bo o vong 1 cho qua
  // chung mot dong), nhung do NGUYEN ca cum that su la 313,07px (vuot) — day
  // chinh la loi da lam mat chu "r" cuoi "Zipper" tren tem in that.
  const REAL_TOKEN_WIDTHS_AT_22 = {
    "Opened ": 78.29, "end/": 42.82, "No.3 ": 46.47, "Plastic ": 64.8, "Zipper ": 62.36,
  };
  const REAL_LINE_WIDTH_AT_22 = { "Opened end/No.3 Plastic Zipper": 313.07 };

  const calls = [];
  const measureText = async (config, texts) => {
    calls.push([...texts]);
    const map = new Map();
    for (const text of texts) {
      const bySize = new Map();
      const base = REAL_LINE_WIDTH_AT_22[text] ?? REAL_TOKEN_WIDTHS_AT_22[text] ?? text.length * 8;
      for (const size of [22, 20, 18, 16]) bySize.set(size, base * (size / 22));
      map.set(text, bySize);
    }
    return map;
  };

  const productName = "Opened end/No.3 Plastic Zipper";
  const entries = [{ type: "sku", copies: 1, payload: { sku: "[SKU_DA_XOA]", productName } }];
  const result = await planProductNames(entries, {}, measureText, null);
  const { productNameLines, productNameFontSize } = result[0].payload;

  assert.equal(calls.length, 2, "phai co du 2 vong do (token roi xac nhan dong)");
  assert.ok(productNameLines.length >= 2,
    `phai tach thanh nhieu dong sau khi xac nhan, dang la ${productNameLines.length}: ${JSON.stringify(productNameLines)}`);
  // Dong nao cung phai thuc su vua khung — kiem tra bang chinh so lieu that.
  for (const line of productNameLines) {
    const width = (REAL_LINE_WIDTH_AT_22[line] ?? line.length * 8) * (productNameFontSize / 22);
    assert.ok(width <= 296, `dong "${line}" van vuot 296px sau khi xac nhan: ${width}`);
  }
  assert.equal(productNameLines.join(" ").replace(/\s+/g, " ").trim(), productName,
    "khong duoc mat chu nao — day chinh la loi 'Zipper' bi mat chu r");
});

test("planProductNames: ten dai duoc chia dong theo be rong that, khac ket qua dem ky tu", async () => {
  // "O-E L-S " (8 ky tu, 80px o size22) + "SAB-255LK3557-2/100% " (22 ky tu, 220px)
  // = 300px, vua lot vao maxWidthPx=296? Kiem tra dung tinh nang, khong hardcode gia tri.
  const measureText = fakeMeasureText();
  const entries = [{ type: "sku", copies: 1, payload: {
    sku: "[SKU_DA_XOA]",
    productName: "O-E L-S SAB-255LK3557-2/100% Polyester/none/DARK NAVY 14-4122"
  } }];
  const result = await planProductNames(entries, {}, measureText, null);
  const { productNameLines, productNameFontSize } = result[0].payload;
  assert.ok(productNameLines.length > 0);
  assert.equal(productNameFontSize, 22, "ten nay khong qua dai, phai giu co chu mac dinh");
  // Ghep lai phai giu nguyen toan bo noi dung, khong mat chu.
  const rebuilt = productNameLines.join(" ").replace(/\s+/g, " ").trim();
  const original = entries[0].payload.productName.replace(/\s+/g, " ").trim();
  assert.equal(rebuilt.replace(/\s/g, ""), original.replace(/\s/g, ""), "khong duoc mat ky tu nao khi chia dong");
});
