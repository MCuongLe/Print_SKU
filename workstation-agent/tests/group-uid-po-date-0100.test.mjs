// 0.10.0 (21/10/2026): tem Group UID có khối Số lô / Số cuộn / RFID chữ đậm, ô SỐ PO | NGÀY NHẬN, bỏ LOT/ROLL ở đáy tem.
// Dữ liệu dưới đây là giả.
import test from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_UID_BOX_LAYOUT, GROUP_UID_INFO_LAYOUT, GROUP_UID_NAME_LAYOUT, GROUP_UID_SKU_LAYOUT, groupUidNameBaseline, renderGroupUidLabel
} from "../src/templates/group-uid-label.mjs";
import { estimateTextWidth, fitTextBlock, GROUP_UID_INFO_FONT_SIZES, GROUP_UID_INFO_MIN_SIZE } from "../src/templates/text-layout.mjs";
import { normalizeJob } from "../src/job-validator.mjs";
import { planProductNames, renderJobTspl } from "../src/render.mjs";

const base = { groupUid: "1028260000000001", sku: "900000001", productName: "Vải thử nghiệm/Black/g" };
const full = { ...base, lot: "8600000001", roll: "R029", rfid: "A30000000001", po: "10000000000001", receivedDate: "15/06/2026" };

test("fitTextBlock: vừa thì giữ cỡ lớn nhất, dài thì xuống cỡ nhỏ hơn, quá dài thì thu theo tỷ lệ không dưới 8, rỗng thì cỡ lớn nhất", () => {
  assert.equal(fitTextBlock(["Số lô: B"], 296), GROUP_UID_INFO_FONT_SIZES[0]);
  const tight = fitTextBlock(["8".repeat(30)], 296);
  assert.ok(tight < GROUP_UID_INFO_FONT_SIZES[0] && tight >= 12, `cỡ ${tight}`);
  const scaled = fitTextBlock(["W".repeat(60)], 100);
  assert.ok(scaled >= GROUP_UID_INFO_MIN_SIZE && scaled < 12, `cỡ ${scaled}`);
  assert.equal(GROUP_UID_INFO_MIN_SIZE, 6);
  assert.equal(fitTextBlock(["", null], 296), GROUP_UID_INFO_FONT_SIZES[0]);
  // chuỗi dài nhất quyết định cỡ chung của cả khối
  const block = fitTextBlock(["Số lô: B", "Số cuộn: " + "9".repeat(24)], 296);
  assert.ok(block < GROUP_UID_INFO_FONT_SIZES[0]);
  assert.ok(estimateTextWidth("Số cuộn: " + "9".repeat(24), block) <= 296);
});

test("tem Group UID đủ dữ liệu: khối Số lô/Số cuộn/RFID chữ đậm, ô SỐ PO | NGÀY NHẬN, SKU dưới ô, không còn LOT:/ROLL:", () => {
  const svg = renderGroupUidLabel(full);
  const [y1, y2, y3] = GROUP_UID_INFO_LAYOUT.baselines;
  assert.match(svg, new RegExp(`<text x="12" y="${y1}" font-size="20" font-weight="700">Số lô: 8600000001</text>`));
  assert.match(svg, new RegExp(`<text x="12" y="${y2}" font-size="20" font-weight="700">Số cuộn: R029</text>`));
  assert.match(svg, new RegExp(`<text x="12" y="${y3}" font-size="20" font-weight="700">RFID: A30000000001</text>`));
  const b = GROUP_UID_BOX_LAYOUT;
  assert.match(svg, new RegExp(`<text x="${b.left + b.padding}" y="${b.labelY}" font-size="${b.labelSize}">SỐ PO</text>`));
  assert.match(svg, new RegExp(`<text x="${b.divider + b.padding}" y="${b.labelY}" font-size="${b.labelSize}">NGÀY NHẬN</text>`));
  assert.match(svg, new RegExp(`<text x="${b.left + b.padding}" y="${b.valueY}" font-size="18" font-weight="700">10000000000001</text>`));
  assert.match(svg, new RegExp(`<text x="${b.divider + b.padding}" y="${b.valueY}" font-size="18" font-weight="700">15/06/2026</text>`));
  assert.match(svg, /<rect x="13" y="333" width="294" height="42" rx="5" fill="none" stroke="#000" stroke-width="2"\/>/);
  assert.match(svg, new RegExp(`<text x="160" y="${GROUP_UID_SKU_LAYOUT.textY}" font-size="22" text-anchor="middle">SKU: 900000001</text>`));
  assert.ok(!/LOT:|ROLL:/.test(svg));
});

test("các khối không chồng nhau và nằm trong tem 480: tên ≤ 247 < khối thông tin < ô PO < barcode SKU < chữ SKU", () => {
  const nameLast = GROUP_UID_NAME_LAYOUT.lastBaseline;
  assert.equal(groupUidNameBaseline(22, 5), nameLast, "6 dòng cỡ 22 vừa khít khung tên");
  const [first, , last] = GROUP_UID_INFO_LAYOUT.baselines;
  assert.ok(first - 20 > nameLast, "dòng Số lô đầu (cao ~20 chấm) không lấn xuống dòng tên cuối");
  assert.ok(last + 6 < GROUP_UID_BOX_LAYOUT.top, "RFID (kể cả đuôi chữ) nằm trên ô PO");
  assert.ok(GROUP_UID_BOX_LAYOUT.bottom < GROUP_UID_SKU_LAYOUT.barcodeY, "ô PO nằm trên barcode SKU");
  assert.ok(GROUP_UID_SKU_LAYOUT.barcodeY + GROUP_UID_SKU_LAYOUT.barcodeHeight + 8 < GROUP_UID_SKU_LAYOUT.textY - GROUP_UID_SKU_LAYOUT.textSize * 0.7, "chữ SKU dưới barcode");
  assert.ok(GROUP_UID_SKU_LAYOUT.textY <= 470, "chữ SKU trong tem 480");
  assert.ok(GROUP_UID_BOX_LAYOUT.valueY + 2 < GROUP_UID_BOX_LAYOUT.bottom && GROUP_UID_BOX_LAYOUT.labelY < GROUP_UID_BOX_LAYOUT.valueY - 12, "nhãn và giá trị nằm trong ô, không đè nhau");
});

test("khối thông tin dồn lên: thiếu Số lô thì Số cuộn lên dòng đầu; chỉ RFID cũng ở dòng đầu", () => {
  const rollOnly = renderGroupUidLabel({ ...base, roll: "R029" });
  assert.match(rollOnly, new RegExp(`y="${GROUP_UID_INFO_LAYOUT.baselines[0]}"[^>]*>Số cuộn: R029<`));
  assert.ok(!rollOnly.includes("Số lô"));
  const rfidOnly = renderGroupUidLabel({ ...base, rfid: "A30000000001" });
  assert.match(rfidOnly, new RegExp(`y="${GROUP_UID_INFO_LAYOUT.baselines[0]}"[^>]*>RFID: A30000000001<`));
});

test("ô PO | NGÀY NHẬN chỉ vẽ khi có ít nhất một giá trị; cột trống giữ nhãn để ghi bút", () => {
  assert.ok(!renderGroupUidLabel({ ...base, lot: "B" }).includes("SỐ PO"));
  const poOnly = renderGroupUidLabel({ ...base, po: "10000000000001" });
  assert.ok(poOnly.includes(">SỐ PO<") && poOnly.includes(">NGÀY NHẬN<") && poOnly.includes(">10000000000001<"));
  assert.equal((poOnly.match(/font-weight="700"/g) || []).length, 1, "chỉ cột PO có giá trị đậm");
  const dateOnly = renderGroupUidLabel({ ...base, receivedDate: "15/06/2026" });
  assert.ok(dateOnly.includes(">SỐ PO<") && dateOnly.includes(">15/06/2026<"));
  assert.equal((dateOnly.match(/font-weight="700"/g) || []).length, 1, "chỉ cột ngày có giá trị đậm");
  // PO toàn khoảng trắng coi như trống
  assert.ok(!renderGroupUidLabel({ ...base, po: "   ", receivedDate: "" }).includes("SỐ PO"));
});

test("PO dài thu nhỏ từng cột riêng; PO 14 số và ngày cùng cỡ 18; chữ luôn nằm trong cột", () => {
  const long = renderGroupUidLabel({ ...base, po: "12345678901234567890", receivedDate: "31/12/2026" });
  const sizeOf = (svg, text) => Number(svg.match(new RegExp(`font-size="(\\d+)" font-weight="700">${text}<`))?.[1]);
  const b = GROUP_UID_BOX_LAYOUT;
  assert.ok(sizeOf(long, "12345678901234567890") < 18, "PO 20 số phải thu nhỏ");
  assert.equal(sizeOf(long, "31/12/2026"), 18, "ngày không bị kéo nhỏ theo PO");
  assert.ok(estimateTextWidth("12345678901234567890", sizeOf(long, "12345678901234567890")) <= b.divider - b.padding - (b.left + b.padding));
  const normal = renderGroupUidLabel(full);
  assert.equal(sizeOf(normal, "10000000000001"), sizeOf(normal, "15/06/2026"));
});

test("PO và ngày được escape XML, không phá SVG", () => {
  const svg = renderGroupUidLabel({ ...base, po: `A&B<"1">`, receivedDate: "01/01/2026", lot: "<x>" });
  assert.ok(svg.includes("A&amp;B&lt;&quot;1&quot;&gt;"));
  assert.ok(svg.includes("Số lô: &lt;x&gt;"));
  assert.ok(!svg.includes("<x>"));
});

test("không có SKU: bỏ barcode và chữ SKU, ô PO vẫn ở chỗ cũ", () => {
  const svg = renderGroupUidLabel({ ...full, sku: "" });
  assert.ok(!svg.includes("SKU:"));
  assert.ok(svg.includes(">SỐ PO<"));
});

test("job-validator: po / rfid / receivedDate tuỳ chọn, trống hợp lệ, có thì phải đúng dạng, quá dài từ chối cả lệnh", () => {
  const job = (item, copies = 1) => normalizeJob({ id: "j", nonce: "n", type: "group_uid", templateVersion: 1, copies, payload: { items: [{ ...base, copies, ...item }] } });
  const ok = job({ po: "10000000000001", receivedDate: "15/06/2026", rfid: "A30000000001" });
  assert.equal(ok.ok, true);
  assert.equal(ok.job.payload.items[0].po, "10000000000001");
  assert.equal(ok.job.payload.items[0].receivedDate, "15/06/2026");
  assert.equal(ok.job.payload.items[0].rfid, "A30000000001");
  const empty = job({});
  assert.equal(empty.ok, true);
  assert.deepEqual([empty.job.payload.items[0].po, empty.job.payload.items[0].receivedDate, empty.job.payload.items[0].rfid], ["", "", ""]);
  assert.equal(job({ po: "  10000000000001  " }).job.payload.items[0].po, "10000000000001");
  assert.equal(job({ po: "9".repeat(20) }).ok, true, "đúng 20 ký tự vẫn nhận");
  const tooLong = job({ po: "9".repeat(21) });
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.errors.join("|"), /Số PO dòng 1 chỉ gồm chữ, số, \. _ \/ - và khoảng trắng, tối đa 20 ký tự/);
  assert.match(job({ rfid: "R".repeat(21) }).errors.join("|"), /RFID dòng 1 chỉ gồm chữ và số, tối đa 20 ký tự/);
  // PO / RFID là mã định danh: chỉ cắt hai đầu, không gộp khoảng trắng bên trong, không cắt bớt, ký tự lạ thì từ chối
  assert.equal(job({ po: "AB  12" }).job.payload.items[0].po, "AB  12", "khoảng trắng bên trong giữ nguyên");
  assert.equal(job({ po: ` ${"9".repeat(20)} ` }).ok, true, "20 ký tự có khoảng trắng bao quanh vẫn nhận (cắt hai đầu trước khi đếm)");
  for (const bad of ["PO@123", "PO#1", "Đơn 1", "PO	1"]) assert.equal(job({ po: bad }).ok, false, bad);
  assert.equal(job({ rfid: "A3  001" }).ok, false, "RFID có khoảng trắng bên trong bị từ chối, không bị gộp thành mã khác");
  assert.equal(job({ rfid: "A30000000001" }).ok, true);
  for (const good of ["01/01/2000", "29/02/2028", "31/12/2099"]) assert.equal(job({ receivedDate: good }).ok, true, good);
  for (const bad of ["2026-06-15", "15/6/2026", "32/01/2026", "15/13/2026", "00/01/2026", "15/06/26", "abc", "31/02/2026", "29/02/2026", "15/06/0026", "15/06/1999", "15/06/2100"]) {
    assert.match(job({ receivedDate: bad }).errors.join("|"), /Ngày nhận dòng 1 phải dạng dd\/mm\/yyyy/, bad);
  }
  // dạng đơn (không items)
  const single = normalizeJob({ id: "j", nonce: "n", type: "group_uid", copies: 1, payload: { ...base, po: "9".repeat(21) } });
  assert.equal(single.ok, false);
  assert.match(single.errors.join("|"), /Số PO chỉ gồm chữ, số/);
});

test("planProductNames không còn gắn lotRollFit (LOT/ROLL không đo GDI+ nữa) và vẫn HAI lần gọi đo", async () => {
  const calls = [];
  const table = (texts, sizes) => new Map(texts.map((t) => [t, new Map(sizes.map((s) => [s, t.length * 10 * (s / 22)]))]));
  const measureText = async (_config, texts, sizes, options = {}) => {
    calls.push({ texts, sizes, extra: options.extra || [] });
    return Object.assign(table(texts, sizes), { extra: (options.extra || []).map((group) => table(group.texts, group.sizes)) });
  };
  const entries = [{ type: "group_uid", copies: 1, payload: { ...full } }];
  const [planned] = await planProductNames(entries, {}, measureText, null);
  assert.equal(calls.length, 2);
  assert.equal(planned.payload.lotRollFit, undefined);
  assert.equal(planned.payload.po, "10000000000001", "PO/ngày/RFID giữ nguyên qua bước dựng");
  assert.ok(Array.isArray(planned.payload.productNameLines) && planned.payload.productNameLines.length >= 1);
});

test("renderJobTspl dựng được lệnh Group UID có PO và ngày nhận (batch nhiều dòng, một dòng thiếu PO)", async () => {
  const job = {
    id: "po-date", nonce: "po-date-1", type: "group_uid", copies: 3, templateVersion: 1,
    payload: { items: [{ ...full, copies: 1 }, { ...base, copies: 1 }, { ...base, po: "10000000000001", copies: 1 }] }
  };
  const checked = normalizeJob(job);
  assert.equal(checked.ok, true, checked.errors?.join("|"));
  const tspl = await renderJobTspl(checked.job, { density: 8, speed: 4 });
  assert.ok(tspl.length > 1000);
  assert.ok(tspl.includes(Buffer.from("PRINT 1")));
});
