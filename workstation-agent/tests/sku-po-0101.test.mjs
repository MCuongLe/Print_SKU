// 0.10.1 (22/10/2026): tem SKU phiên bản 2 cho Phụ liệu (in ở KIỂM TRA ĐẦU VÀO) — tên → QR SKU → SKU đậm → khung hai hàng
// "PO:" / "Ngày nhận:" → vạch → ngày in góc phải; không in số lượng. Tem v1 giữ nguyên. Dữ liệu dưới đây là giả.
import test from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES } from "../src/templates/index.mjs";
import { renderLabelSvg } from "../src/templates/index.mjs";
import { renderSkuLabel, SKU_LABEL_LAYOUT, SKU_V2_BOX_LAYOUT, SKU_V2_NAME_LAYOUT } from "../src/templates/sku-label.mjs";
import { estimateTextWidth, maxLinesForSize } from "../src/templates/text-layout.mjs";
import { normalizeJob } from "../src/job-validator.mjs";
import { planProductNames, renderJobTspl } from "../src/render.mjs";

const item = { sku: "900000003", productName: "Chỉ thử nghiệm/F3-0000_NCC giả/100% Polyester/none/ Hồng Cam/Tex 24-100D-2/mm", printedDate: "20/10/26", copies: 1, po: "10000000000001", receivedDate: "15/06/2026" };
const job = (payload, extra = {}) => ({ id: "job-1", nonce: "n-1", type: "sku", templateVersion: 2, copies: 1, payload, ...extra });

test("agent khai sku:v2 (hàng đợi chỉ giao lệnh tem Phụ liệu cho agent 0.10.1+)", () => {
  assert.ok(CAPABILITIES.includes("sku:v2"));
  assert.ok(CAPABILITIES.includes("sku:v1"));
});

test("validator: v2 giữ PO + ngày nhận; PO/ngày sai mẫu thì từ chối cả lệnh; v1 vẫn bỏ trường lạ như cũ; phiên bản khác bị từ chối", () => {
  const ok = normalizeJob(job({ items: [item] }));
  assert.equal(ok.ok, true, ok.errors.join("; "));
  assert.equal(ok.job.payload.items[0].po, "10000000000001");
  assert.equal(ok.job.payload.items[0].receivedDate, "15/06/2026");
  assert.equal(normalizeJob(job({ items: [{ ...item, po: "PO#<script>" }] })).ok, false);
  assert.equal(normalizeJob(job({ items: [{ ...item, po: "1".repeat(21) }] })).ok, false);
  assert.equal(normalizeJob(job({ items: [{ ...item, receivedDate: "31/02/2026" }] })).ok, false);
  assert.equal(normalizeJob(job({ items: [{ ...item, receivedDate: "15/06/26" }] })).ok, false);
  const blank = normalizeJob(job({ items: [{ ...item, po: "", receivedDate: "" }] }));
  assert.equal(blank.ok, true, "trống thì hợp lệ (khung để ghi bút)");
  const v1 = normalizeJob(job({ items: [item] }, { templateVersion: 1 }));
  assert.equal(v1.ok, true);
  assert.ok(!("po" in v1.job.payload.items[0]) && !("receivedDate" in v1.job.payload.items[0]), "v1 không đổi");
  assert.equal(normalizeJob(job({ items: [item] }, { templateVersion: 4 })).ok, false, "phiên bản lạ bị từ chối (v3 có từ 0.10.2)");
});

test("tem v2: khung hai hàng PO / Ngày nhận, không số lượng, ngày in phải, SKU đậm", () => {
  const svg = renderSkuLabel({ ...item, quantity: "300000" }, { version: 2 });
  const b = SKU_V2_BOX_LAYOUT;
  assert.match(svg, new RegExp(`<rect x="${b.left + 1}" y="${b.top + 1}" width="${b.right - b.left - 2}" height="${b.bottom - b.top - 2}" rx="5" fill="none" stroke="#000" stroke-width="2"/>`));
  assert.match(svg, new RegExp(`<line x1="${b.left + 1}" y1="${b.divider}" x2="${b.right - 1}" y2="${b.divider}" stroke="#000" stroke-width="2"/>`));
  assert.match(svg, />PO:<\/text>/);
  assert.match(svg, />Ngày nhận:<\/text>/);
  assert.match(svg, /font-weight="700">10000000000001<\/text>/);
  assert.match(svg, /font-weight="700">15\/06\/2026<\/text>/);
  assert.match(svg, /font-size="32" font-weight="700" text-anchor="middle">900000003<\/text>/);
  assert.match(svg, /text-anchor="end">20\/10\/26<\/text>/);
  assert.ok(!svg.includes("300.000"), "v2 không in số lượng");
  // PO/ngày trống: vẫn vẽ khung + nhãn để ghi bút
  const empty = renderSkuLabel({ ...item, po: "", receivedDate: "" }, { version: 2 });
  assert.match(empty, />PO:<\/text>/);
  assert.ok(!/font-weight="700">10000000000001/.test(empty));
});

test("tem v2: các khối không chồng nhau — SKU trên khung, khung trên vạch, giá trị vừa khung kể cả PO 20 ký tự", () => {
  const b = SKU_V2_BOX_LAYOUT, { lineY, footerY } = SKU_LABEL_LAYOUT;
  assert.ok(b.bottom < lineY - 4, "khung trên vạch");
  assert.ok(footerY <= 470);
  // Tên 5 dòng cỡ 22 (tối đa) → SKU vẫn trên khung
  const lines = ["Dòng một", "Dòng hai", "Dòng ba", "Dòng bốn", "Dòng năm"];
  const svg = renderSkuLabel({ ...item, productNameLines: lines, productNameFontSize: 22 }, { version: 2 });
  const skuY = Number(/y="(\d+)" font-size="32"/.exec(svg)[1]);
  assert.ok(skuY + 8 <= b.top, `SKU chân y=${skuY} phải trên khung y=${b.top}`);
  // PO dài nhất hợp lệ: thu cỡ, vẫn trong khung
  const longPo = "W".repeat(20);
  const svgLong = renderSkuLabel({ ...item, po: longPo }, { version: 2 });
  const m = new RegExp(`x="(\\d+)" y="\\d+" font-size="(\\d+)" font-weight="700">${longPo}<`).exec(svgLong);
  assert.ok(m, "có giá trị PO");
  assert.ok(Number(m[1]) + estimateTextWidth(longPo, Number(m[2])) <= b.right - 4, "PO dài vẫn nằm trong khung");
});

test("tên v2: tối đa 5 dòng cỡ 22/20, 6 dòng cỡ 18/16 (v1 vẫn 8 dòng cỡ 22)", () => {
  assert.equal(maxLinesForSize(22, SKU_V2_NAME_LAYOUT), 5);
  assert.equal(maxLinesForSize(20, SKU_V2_NAME_LAYOUT), 5);
  assert.equal(maxLinesForSize(18, SKU_V2_NAME_LAYOUT), 6);
  assert.equal(maxLinesForSize(16, SKU_V2_NAME_LAYOUT), 6);
  assert.equal(maxLinesForSize(22, SKU_LABEL_LAYOUT), 8);
});

test("đo chữ: lệnh v2 dùng giới hạn dòng v2, lệnh v1 giữ 8 dòng", async () => {
  const longName = Array.from({ length: 30 }, (_, i) => `Từ${i}`).join(" ");
  const measure = async (config, texts, sizes, options = {}) => {
    const one = (list, sz) => new Map(list.map((t) => [t, new Map(sz.map((s) => [s, estimateTextWidth(t, s)]))]));
    const result = one(texts, sizes);
    result.extra = (options.extra ?? []).map((group) => one(group.texts, group.sizes));
    return result;
  };
  const [v2] = await planProductNames([{ ...job({ ...item, productName: longName }), payload: { ...item, productName: longName } }], {}, measure);
  assert.ok(v2.payload.productNameLines.length <= maxLinesForSize(v2.payload.productNameFontSize, SKU_V2_NAME_LAYOUT));
  const [v1] = await planProductNames([{ ...job({ ...item, productName: longName }, { templateVersion: 1 }), payload: { ...item, productName: longName } }], {}, measure);
  assert.ok(v1.payload.productNameLines.length > v2.payload.productNameLines.length, "v1 được nhiều dòng hơn");
});

test("tem v1 không đổi byte nào khi payload có thêm PO/ngày (renderLabelSvg theo templateVersion)", () => {
  const v1 = { sku: item.sku, productName: item.productName, quantity: "300000", printedDate: "20/10/26" };
  const plain = renderLabelSvg({ type: "sku", templateVersion: 1, payload: v1 });
  assert.equal(renderLabelSvg({ type: "sku", templateVersion: 1, payload: { ...v1, po: "1", receivedDate: "15/06/2026" } }), plain);
  assert.equal(renderSkuLabel(v1), plain, "mặc định là v1");
  assert.match(plain, /300\.000/);
  assert.notEqual(renderLabelSvg({ type: "sku", templateVersion: 2, payload: { ...v1, po: "1" } }), plain);
});

test("renderJobTspl dựng được lệnh v2 nhiều SKU", async () => {
  const checked = normalizeJob(job({ items: [item, { ...item, sku: "900000004", copies: 2 }] }, { copies: 3 }));
  assert.equal(checked.ok, true, checked.errors.join("; "));
  const tspl = await renderJobTspl(checked.job, { density: 10, speed: 3 });
  assert.ok(tspl.length > 1000);
  assert.equal((tspl.toString("latin1").match(/PRINT 1/g) || []).length, 2, "3 tem = 2 hàng giấy");
});

test("đo chữ lỗi (không đo được): tem v2 vẫn chỉ tối đa 5 dòng cỡ 22, SKU nằm trên khung PO (review Codex 22/10)", async () => {
  const longName = Array.from({ length: 40 }, (_, i) => `Tu${i}`).join(" ");
  const fail = async () => { throw new Error("PowerShell lỗi"); };
  const [entry] = await planProductNames([{ ...job({ ...item, productName: longName }), payload: { ...item, productName: longName } }], {}, fail);
  const svg = renderLabelSvg(entry);
  const nameLines = (svg.match(/<text x="12" y="\d+" font-size="22">/g) || []).length;
  assert.ok(nameLines <= 5, `v2 dự phòng ${nameLines} dòng`);
  const skuY = Number(/y="(\d+)" font-size="32"/.exec(svg)[1]);
  assert.ok(skuY + 8 <= SKU_V2_BOX_LAYOUT.top, `SKU chân y=${skuY} phải trên khung`);
  const v1 = renderLabelSvg({ type: "sku", templateVersion: 1, payload: { ...item, productName: longName } });
  assert.equal((v1.match(/<text x="12" y="\d+" font-size="22">/g) || []).length, 8, "v1 dự phòng giữ 8 dòng");
});
