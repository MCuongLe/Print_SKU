import test from "node:test";
import assert from "node:assert/strict";
import { normalizeJob } from "../src/job-validator.mjs";
import { CAPABILITIES, renderLabelSvg } from "../src/templates/index.mjs";
import { fitLocationCode, fitLocationName, LOCATION_LABEL_LAYOUT, measureLocationCode, renderLocationLabel } from "../src/templates/location-label.mjs";
import { planLocationLabels } from "../src/location-plan.mjs";
import { qrMatrix } from "../src/templates/qr.mjs";
import { estimateTextWidth } from "../src/templates/text-layout.mjs";
import { renderJobTspl } from "../src/render.mjs";

const item = (code, name = "Khu vực kiểm thử", copies = 1) => ({ code, name, copies });
const job = { id: "test-location", nonce: "test-location-1", type: "location", templateVersion: 1, copies: 3, payload: { items: [item("Z99-T01-001-01-01-01", "Khu vực kiểm thử", 2), item("Z99.T02/01_A")] } };

test("agent báo hỗ trợ tem vị trí location:v1", () => {
  assert.ok(CAPABILITIES.includes("location:v1"));
});

test("lệnh tem vị trí: nhận nhiều vị trí, tổng số tem phải khớp", () => {
  const result = normalizeJob(job);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.deepEqual(result.job.payload.items, [item("Z99-T01-001-01-01-01", "Khu vực kiểm thử", 2), item("Z99.T02/01_A")]);
  assert.equal(normalizeJob({ ...job, copies: 2 }).ok, false);
  assert.equal(normalizeJob({ ...job, templateVersion: 2 }).ok, false);
  assert.equal(normalizeJob({ ...job, payload: { items: [] } }).ok, false);
  assert.equal(normalizeJob({ ...job, payload: { code: "Z99", name: "Thiếu items" } }).ok, false);
});

test("lệnh tem vị trí: chặn mã sai mẫu và tên trống", () => {
  const one = (entry) => normalizeJob({ ...job, copies: 1, payload: { items: [entry] } });
  for (const code of ["", "z99-t01", "-Z99", "Z99 T01", "Z99#1", "A".repeat(41), "Ô01"]) {
    assert.equal(one(item(code)).ok, false, `mã ${JSON.stringify(code)} phải bị chặn`);
  }
  for (const code of ["A", "9", "Z99-T01-001-01-01-01", "A.B_C/D-E", "A".repeat(40)]) {
    assert.equal(one(item(code)).ok, true, `mã ${JSON.stringify(code)} phải hợp lệ`);
  }
  assert.equal(one(item("Z99", "   ")).ok, false);
  assert.equal(one(item("Z99", "Đ".repeat(61))).ok, false);
  assert.equal(one(item("Z99", "Đ".repeat(60))).ok, true);
  assert.equal(one(item("Z99", "Tên", 0)).ok, false);
});

// Các thẻ <text> canh giữa của tem: phần tử đầu là mã vị trí (đậm), sau đó là các dòng tên.
const texts = (svg) => [...svg.matchAll(/<text (?:x="160" y="(\d+)"|transform="translate\(160 (\d+)\) scale\(([\d.]+) 1\)" x="0" y="0") font-size="(\d+)"( font-weight="700")? text-anchor="middle">([^<]*)<\/text>/g)]
  .map(([, y, ty, scale, size, bold, text]) => ({ y: Number(y ?? ty), scale: scale ? Number(scale) : 1, size: Number(size), bold: Boolean(bold), text }));

test("template vị trí: QR chứa đúng mã, mã Arial đậm dưới QR, tên Arial thường canh giữa", () => {
  const svg = renderLocationLabel({ code: "Z99-T01-001-01-01-01", name: "Khu vực kiểm thử" });
  assert.match(svg, /width="320" height="480"/);
  assert.match(svg, /font-family="Arial,Helvetica,sans-serif"/);
  // Mã chỉ gồm ký tự Alphanumeric → QR version 1 (21 module) thay vì version 2 ở chế độ Byte.
  assert.equal(qrMatrix("Z99-T01-001-01-01-01", { mode: "Alphanumeric" }).count, 21);
  assert.equal(qrMatrix("Z99-T01-001-01-01-01").count, 25, "mặc định vẫn là Byte để không đổi QR tem SKU");
  const [code, name, extra] = texts(svg);
  assert.deepEqual([code.text, code.bold, name.text, name.bold, extra], ["Z99-T01-001-01-01-01", true, "Khu vực kiểm thử", false, undefined]);
  assert.equal(renderLabelSvg({ type: "location", payload: { code: "A1", name: "Kệ A" } }), renderLocationLabel({ code: "A1", name: "Kệ A" }));
});

test("bề rộng mã đo theo Arial Bold thật; mã dài được ép ngang, không mất ký tự", () => {
  // Số đo GDI+ Arial Bold 1000 px của chuỗi mẫu là 10116,7 (02/10/2026).
  assert.ok(Math.abs(measureLocationCode("Z99-T01-001-01-01-01", 1000) - 10116.7) / 10116.7 < 0.015);
  for (const code of ["A1", "Z99-T01-001-01-01-01", "W".repeat(40), "9".repeat(40), "M.W_Q/0-".repeat(5)]) {
    const { fontSize, scale } = fitLocationCode(code);
    assert.ok(measureLocationCode(code, fontSize) * scale <= LOCATION_LABEL_LAYOUT.maxWidth + 0.01, code);
    const [printed] = texts(renderLocationLabel({ code, name: "Kệ" }));
    assert.equal(printed.text, code, "in đủ mọi ký tự của mã");
    assert.ok(Math.abs(printed.scale - scale) < 0.001);
  }
  assert.deepEqual(fitLocationCode("A1"), { fontSize: 44, scale: 1 });
});

test("tên: một dòng nếu vừa, dài thì xuống dòng/giảm cỡ, không bao giờ mất ký tự hay tràn tem", () => {
  const names = (svg) => texts(svg).slice(1);
  assert.equal(names(renderLocationLabel({ code: "A1", name: "Khu vực kiểm thử" })).length, 1);
  for (const name of ["Khu vực kiểm thử nguyên phụ liệu tầng hai dãy B", "W".repeat(60), "Đ".repeat(60), "Kệ-hàng-mẫu-số-01/02/03/04/05/06/07/08/09/10-dãy-ABCDEFG"]) {
    const lines = names(renderLocationLabel({ code: "Z99-T01-001-01-01-01", name }));
    assert.equal(lines.map((line) => line.text).join("").replace(/\s/g, ""), name.replace(/\s/g, ""), `đủ ký tự: ${name}`);
    for (const line of lines) assert.ok(line.y + line.size * 0.22 <= LOCATION_LABEL_LAYOUT.nameBottom, JSON.stringify(line));
  }
  // Chỗ quá chật: vẫn giữ đủ chữ ở cỡ nhỏ nhất, dòng nào rộng quá thì ép ngang (scale < 1).
  const cramped = fitLocationName("W".repeat(60), 455);
  assert.equal(cramped.lines.join(""), "W".repeat(60));
  const svg = renderLocationLabel({ code: "A1", name: "WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW", nameFit: { ...cramped, lines: ["W".repeat(60)], widths: [900] } });
  assert.equal(texts(svg)[1].text, "W".repeat(60));
  assert.ok(Math.abs(texts(svg)[1].scale - 296 / 900) < 0.001);
});

test("agent đo tên bằng hàm đo thật (GDI+) trước khi dựng tem vị trí", async () => {
  const calls = [];
  // Giả lập font rộng hơn ước lượng 40%: tên phải xuống dòng/giảm cỡ theo số đo, không theo ước lượng.
  const measureText = async (config, list, sizes) => {
    calls.push({ list, sizes });
    return new Map(list.map((text) => [text, new Map(sizes.map((size) => [size, estimateTextWidth(text, size) * 1.4]))]));
  };
  const entry = { type: "location", copies: 1, payload: { code: "Z99-T01-001-01-01-01", name: "Khu vực kiểm thử nguyên phụ liệu" } };
  const [planned] = await planLocationLabels([entry], {}, measureText);
  assert.equal(calls.length, 1, "cả lệnh chỉ đo một lần");
  assert.ok(calls[0].list.includes("Khu vực kiểm thử nguyên phụ liệu") && calls[0].list.includes("phụ "));
  assert.deepEqual(calls[0].sizes, LOCATION_LABEL_LAYOUT.nameFontSizes);
  const fit = planned.payload.nameFit;
  assert.equal(fit.lines.join(" "), "Khu vực kiểm thử nguyên phụ liệu");
  for (const width of fit.widths) assert.ok(width <= LOCATION_LABEL_LAYOUT.maxWidth * 0.98 + 0.01, String(width));
  const estimated = fitLocationName(entry.payload.name, 0);
  assert.ok(fit.lines.length > estimated.lines.length || fit.fontSize < estimated.fontSize, "dùng số đo thật, không dùng ước lượng");
  // Đo lỗi → vẫn in được bằng ước lượng.
  const [fallback] = await planLocationLabels([entry], {}, async () => { throw new Error("PowerShell lỗi"); }, { warn: () => {} });
  assert.equal(fallback.payload.nameFit, undefined);
  // Pipeline in thật gọi bước đo cho lệnh vị trí.
  calls.length = 0;
  await renderJobTspl(normalizeJob(job).job, { density: 8, speed: 4 }, null, { measureText });
  assert.equal(calls.length, 1);
});

test("lệnh tem vị trí dựng đủ TSPL: 3 tem → 2 hàng giấy", async () => {
  const tspl = (await renderJobTspl(normalizeJob(job).job, { density: 8, speed: 4 })).toString("latin1");
  assert.equal((tspl.match(/PRINT 1/g) || []).length, 2);
  assert.match(tspl, /^SIZE 82 mm,60 mm/);
});
