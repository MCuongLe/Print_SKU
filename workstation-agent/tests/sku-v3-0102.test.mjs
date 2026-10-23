// 0.10.2 (23/10/2026): tem SKU phiên bản 3 = gộp v1 + v2 thành một mẫu, quyết định theo TỪNG tem trong lệnh:
// - không PO và không ngày nhận → giống từng byte tem v1 (tên 8 dòng, không khung, số lượng trái + ngày in phải);
// - có PO hoặc ngày nhận → khung PO / Ngày nhận như v2 (tên theo SKU_V2_NAME_LAYOUT), chân tem vẫn in số lượng nếu có.
// v1, v2 giữ nguyên để lệnh cũ còn trong hàng đợi in được. Dữ liệu dưới đây là giả.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CAPABILITIES, renderLabelSvg } from "../src/templates/index.mjs";
import { renderSkuLabel, SKU_LABEL_LAYOUT, SKU_V2_BOX_LAYOUT, SKU_V2_NAME_LAYOUT } from "../src/templates/sku-label.mjs";
import { estimateTextWidth, maxLinesForSize } from "../src/templates/text-layout.mjs";
import { normalizeJob } from "../src/job-validator.mjs";
import { planProductNames, renderJobTspl } from "../src/render.mjs";
import { AGENT_VERSION } from "../src/agent.mjs";

const LONG_NAME = Array.from({ length: 40 }, (_, i) => `Từ${i}`).join(" ");
const base = { sku: "900000011", productName: "Chỉ thử nghiệm/F3-0000_NCC giả/100% Polyester/none/ Hồng Cam/Tex 24-100D-2/mm", quantity: "300000", printedDate: "23/10/26", copies: 1 };
const withPo = { ...base, sku: "900000012", po: "10012600000001", receivedDate: "15/06/2026" };
const job = (payload, extra = {}) => ({ id: "job-3", nonce: "n-3", type: "sku", templateVersion: 3, copies: 1, payload, ...extra });
const measured = { productNameLines: ["Chỉ thử nghiệm", "F3-0000 NCC giả"], productNameFontSize: 20 };

// Đo chữ giả: bề rộng ước lượng (không gọi PowerShell), cùng hình dạng kết quả với measureTextWidths.
const fakeMeasure = async (config, texts, sizes, options = {}) => {
  const one = (list, sz) => new Map(list.map((t) => [t, new Map(sz.map((s) => [s, estimateTextWidth(t, s)]))]));
  const result = one(texts, sizes);
  result.extra = (options.extra ?? []).map((group) => one(group.texts, group.sizes));
  return result;
};
const nameLineCount = (svg) => (svg.match(/<text x="12" y="\d+" font-size="\d+">/g) || []).length;

test("0.10.2: agent khai sku:v3 (vẫn giữ sku:v1, sku:v2); VERSION, package.json, AGENT_VERSION = 0.10.2", () => {
  for (const cap of ["sku:v1", "sku:v2", "sku:v3"]) assert.ok(CAPABILITIES.includes(cap), cap);
  const version = fs.readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, "0.10.2");
  assert.equal(pkg.version, "0.10.2");
  assert.equal(AGENT_VERSION, "0.10.2");
});

test("v3 không PO, không ngày nhận: giống từng byte v1 (kể cả khi PO/ngày chỉ là khoảng trắng, có/không tên đo sẵn)", () => {
  const blanks = [{}, { po: "", receivedDate: "" }, { po: "  ", receivedDate: " " }];
  for (const extra of blanks) {
    assert.equal(renderSkuLabel({ ...base, ...extra }, { version: 3 }), renderSkuLabel(base), JSON.stringify(extra));
    assert.equal(renderSkuLabel({ ...base, ...measured, ...extra }, { version: 3 }), renderSkuLabel({ ...base, ...measured }), `đo sẵn ${JSON.stringify(extra)}`);
    assert.equal(renderSkuLabel({ ...base, productName: LONG_NAME, ...extra }, { version: 3 }), renderSkuLabel({ ...base, productName: LONG_NAME }));
  }
  const svg = renderLabelSvg({ type: "sku", templateVersion: 3, payload: base });
  assert.equal(svg, renderLabelSvg({ type: "sku", templateVersion: 1, payload: base }));
  assert.match(svg, /300\.000/);
  assert.ok(!svg.includes(">PO:<"), "không khung");
  assert.equal(nameLineCount(renderSkuLabel({ ...base, productName: LONG_NAME }, { version: 3 })), 8, "dự phòng đếm ký tự: 8 dòng như v1");
});

test("v3 có PO hoặc ngày nhận: khung PO / Ngày nhận như v2 + số lượng ở chân trái", () => {
  const svg = renderSkuLabel(withPo, { version: 3 });
  const b = SKU_V2_BOX_LAYOUT;
  assert.ok(svg.includes(`<rect x="${b.left + 1}" y="${b.top + 1}" width="${b.right - b.left - 2}" height="${b.bottom - b.top - 2}" rx="5"`), "có khung");
  assert.match(svg, />PO:<\/text>/);
  assert.match(svg, /font-weight="700">10012600000001<\/text>/);
  assert.match(svg, /font-weight="700">15\/06\/2026<\/text>/);
  assert.match(svg, new RegExp(`<text x="20" y="${SKU_LABEL_LAYOUT.footerY}" font-size="\\d+">300\\.000</text>`), "số lượng ở chân trái");
  assert.match(svg, /text-anchor="end">23\/10\/26<\/text>/);
  // Chỉ có ngày nhận (không PO) cũng vẽ khung
  const onlyDate = renderSkuLabel({ ...withPo, po: "" }, { version: 3 });
  assert.match(onlyDate, />Ngày nhận:<\/text>/);
  assert.match(onlyDate, /300\.000/);
  // Dự phòng đếm ký tự: tên tối đa như v2 (5 dòng cỡ 22), SKU vẫn trên khung
  const long = renderSkuLabel({ ...withPo, productName: LONG_NAME }, { version: 3 });
  assert.equal(nameLineCount(long), maxLinesForSize(22, SKU_V2_NAME_LAYOUT));
  const skuY = Number(/y="(\d+)" font-size="32"/.exec(long)[1]);
  assert.ok(skuY + 8 <= b.top, `SKU chân y=${skuY} phải trên khung y=${b.top}`);
});

test("v3 có PO, số lượng trống: giống từng byte v2", () => {
  for (const quantity of ["", undefined, "  "]) {
    const payload = { ...withPo, quantity };
    assert.equal(renderSkuLabel(payload, { version: 3 }), renderSkuLabel(payload, { version: 2 }), String(quantity));
    assert.equal(renderSkuLabel({ ...payload, ...measured }, { version: 3 }), renderSkuLabel({ ...payload, ...measured }, { version: 2 }));
  }
});

test("đo chữ (render.mjs): lệnh v3 lẫn tem có / không PO — số dòng tên và chân tem theo TỪNG tem", async () => {
  const items = [
    { ...base, productName: LONG_NAME },
    { ...withPo, productName: LONG_NAME },
    { ...withPo, productName: LONG_NAME, quantity: "" }
  ];
  const planned = await planProductNames(items.map((payload) => ({ ...job({ items }), payload })), {}, fakeMeasure);
  const [plain, po, poNoQty] = planned;
  assert.ok(plain.payload.productNameLines.length <= maxLinesForSize(plain.payload.productNameFontSize, SKU_LABEL_LAYOUT));
  assert.ok(po.payload.productNameLines.length <= maxLinesForSize(po.payload.productNameFontSize, SKU_V2_NAME_LAYOUT));
  assert.ok(plain.payload.productNameLines.length > po.payload.productNameLines.length, "tem không PO được nhiều dòng hơn");
  // Tem không PO: kế hoạch đo + tem vẽ ra giống hệt lệnh v1
  const [planV1] = await planProductNames([{ ...job({}, { templateVersion: 1 }), payload: items[0] }], {}, fakeMeasure);
  assert.deepEqual(plain.payload, planV1.payload);
  assert.equal(renderLabelSvg(plain), renderLabelSvg(planV1));
  // Tem có PO + số lượng: chân tem đo cả số lượng
  assert.ok(po.payload.footerFit?.quantityFontSize, "có cỡ chữ số lượng đã đo");
  assert.match(renderLabelSvg(po), /300\.000/);
  // Tem có PO, số lượng trống: giống lệnh v2
  const [planV2] = await planProductNames([{ ...job({}, { templateVersion: 2 }), payload: items[2] }], {}, fakeMeasure);
  assert.deepEqual(poNoQty.payload, planV2.payload);
  assert.equal(renderLabelSvg(poNoQty), renderLabelSvg(planV2));
});

test("renderJobTspl: lệnh v3 không PO ra đúng byte TSPL của lệnh v1; lệnh v3 lẫn có/không PO dựng được", async () => {
  const items = [base, { ...base, sku: "900000013", copies: 2 }];
  const v3 = normalizeJob(job({ items }, { copies: 3 }));
  const v1 = normalizeJob(job({ items }, { copies: 3, templateVersion: 1 }));
  assert.equal(v3.ok, true, v3.errors.join("; "));
  const config = { density: 10, speed: 3 };
  const tsplV3 = await renderJobTspl(v3.job, config, null, { measureText: fakeMeasure });
  const tsplV1 = await renderJobTspl(v1.job, config, null, { measureText: fakeMeasure });
  assert.ok(tsplV3.equals(tsplV1), "TSPL v3 không PO === v1");
  const mixed = normalizeJob(job({ items: [base, withPo] }, { copies: 2 }));
  assert.equal(mixed.ok, true, mixed.errors.join("; "));
  const tsplMixed = await renderJobTspl(mixed.job, config, null, { measureText: fakeMeasure });
  assert.equal((tsplMixed.toString("latin1").match(/PRINT 1/g) || []).length, 1, "2 tem = 1 hàng giấy");
  assert.ok(!tsplMixed.equals(tsplV1));
});

test("validator: v3 giữ PO + ngày nhận + số lượng; PO sai mẫu / năm 1999 bị từ chối; v1, v2 không đổi; v4 bị từ chối", () => {
  const ok = normalizeJob(job({ items: [withPo, base] }, { copies: 2 }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
  const [first, second] = ok.job.payload.items;
  assert.equal(ok.job.templateVersion, 3);
  assert.equal(first.po, "10012600000001");
  assert.equal(first.receivedDate, "15/06/2026");
  assert.equal(first.quantity, "300000");
  assert.equal(second.po ?? "", "");
  assert.equal(second.receivedDate ?? "", "");
  assert.equal(second.quantity, "300000");
  const single = normalizeJob(job({ ...withPo, po: "  10012600000002 " }));
  assert.equal(single.ok, true, single.errors.join("; "));
  assert.equal(single.job.payload.po, "10012600000002");
  assert.equal(normalizeJob(job({ items: [{ ...withPo, po: "PO#<script>" }] })).ok, false);
  assert.equal(normalizeJob(job({ items: [{ ...withPo, po: "1".repeat(21) }] })).ok, false);
  assert.equal(normalizeJob(job({ items: [{ ...withPo, receivedDate: "15/06/1999" }] })).ok, false);
  assert.equal(normalizeJob(job({ items: [{ ...withPo, receivedDate: "31/02/2026" }] })).ok, false);
  assert.equal(normalizeJob(job({ ...withPo, po: "PO#1" })).ok, false, "lệnh đơn cũng kiểm");
  // v1 bỏ PO/ngày như cũ, v2 giữ như cũ
  const v1 = normalizeJob(job({ items: [withPo] }, { templateVersion: 1 }));
  assert.equal(v1.ok, true);
  assert.ok(!("po" in v1.job.payload.items[0]) && !("receivedDate" in v1.job.payload.items[0]));
  const v2 = normalizeJob(job({ items: [withPo] }, { templateVersion: 2 }));
  assert.equal(v2.ok, true);
  assert.equal(v2.job.payload.items[0].po, "10012600000001");
  assert.equal(normalizeJob(job({ items: [withPo] }, { templateVersion: 4 })).ok, false, "phiên bản lạ bị từ chối");
});
