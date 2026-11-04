// 0.11.0 (04/11/2026): agent chế độ A4 (PRINTER_KIND=a4) in "PHIẾU THEO DÕI XẢ VẢI" từ lệnh xa_vai_sheet
// qua driver Windows (PNG 300 dpi → PrintDocument), không qua TSPL RAW. Chế độ tem (mặc định) giữ nguyên.
// Dữ liệu giả: SKU 9000000xx, Group UID 1028260000000xxx.
// CONTRACT V2 (04/11/2026): payload dùng systemMm/actualMm (mm nguyên); sau đó (04/11) phiếu in thẳng mm nhóm nghìn
// ("60.758"), không đổi mét, bỏ cột Co (%);
// PRINTER_KIND lạ thì loadConfig ném lỗi; Lot/Roll của phiếu giữ 40 ký tự (fitText thu cỡ / cắt "…" trong ô).
// CONTRACT V3 (04/11/2026): payload có itemCode (mã kiểu hàng, nhập lúc in, bắt buộc) + sku TỪNG dòng (một phiếu nhiều SKU),
// productName tuỳ chọn; biển lớn đầu MỖI trang (Mã hàng + "Xả dd/mm/yyyy" theo giờ VN của measuredAt); cột SKU;
// lỗi cấu hình (PRINTER_KIND lạ) ghi vào logs/agent.log. Mã hàng thử: CWSH02 / TEST01.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { CAPABILITIES, capabilitiesFor } from "../src/templates/index.mjs";
import { loadConfig } from "../src/config.mjs";
import { normalizeJob } from "../src/job-validator.mjs";
import { processClaimedJob, runService } from "../src/agent.mjs";
import { sendBitmapPages } from "../src/printer.mjs";
import { setPowerShellHost, PowerShellHostError } from "../src/ps-host.mjs";
import {
  XA_VAI_COLUMNS, XA_VAI_PAGE, XA_VAI_ROWS_PER_PAGE, formatViDateTime, formatViMm, paginateXaVai, renderXaVaiSheetPages,
  renderXaVaiSheetSvgs, xaVaiReleaseLabel, xaVaiRowCells, xaVaiTotals
} from "../src/templates/xa-vai-sheet.mjs";
import { estimateTextWidth } from "../src/templates/text-layout.mjs";

const LABEL_CAPS = ["sku:v1", "sku:v2", "sku:v3", "group_uid:v1", "location:v1", "location:name-optional"];
const uid = (n) => `1028260000000${String(n).padStart(3, "0")}`;
const item = (n, overrides = {}) => ({
  groupUid: uid(n), sku: "900000001", lot: `LOT-${n}`, roll: String(n), systemMm: 50000, actualMm: 49500, measuredAt: "2026-11-04T07:00:00Z", ...overrides
});
const items = (count) => Array.from({ length: count }, (_, index) => item(index + 1));
const sheetJob = (overrides = {}, payloadOverrides = {}) => ({
  id: "job-xv-0001",
  nonce: "nonce-xv-0001",
  type: "xa_vai_sheet",
  templateVersion: 1,
  copies: 2,
  requestedBy: "xa-vai",
  payload: { itemCode: "CWSH02", productName: "Vải thử nghiệm Jersey/Cotton/155gsm, 178cm/Đen/g", printedAt: "2026-11-04T08:30:00.123456+00:00", reprint: false, items: items(3), ...payloadOverrides },
  ...overrides
});
const skuJob = () => ({ id: "job-sku-0001", nonce: "nonce-sku-0001", type: "sku", templateVersion: 1, copies: 1, payload: { sku: "900000002", productName: "Sản phẩm thử", quantity: "1", printedDate: "04/11/26" } });

// ---------- Khả năng theo chế độ ----------

test("0.11.0: capability theo chế độ — label giữ 6 khả năng tem, a4 CHỈ xa_vai_sheet:v1", () => {
  assert.deepEqual(CAPABILITIES, LABEL_CAPS, "danh sách tem không đổi");
  assert.deepEqual(capabilitiesFor("label"), LABEL_CAPS);
  assert.deepEqual(capabilitiesFor("a4"), ["xa_vai_sheet:v1"]);
  assert.deepEqual(capabilitiesFor(undefined), LABEL_CAPS, "thiếu chế độ = tem");
  assert.ok(!capabilitiesFor("label").includes("xa_vai_sheet:v1"), "agent tem không khai phiếu A4");
});

const kindFromEnv = (line) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-0110-")), ".env");
  fs.writeFileSync(file, `PRINT_QUEUE_PROVIDER=supabase\n${line}\n`);
  const saved = process.env.PRINTER_KIND;
  delete process.env.PRINTER_KIND;
  try { return loadConfig({ envFile: file }).printerKind; } finally { if (saved !== undefined) process.env.PRINTER_KIND = saved; }
};

test("0.11.0: PRINTER_KIND hợp lệ — a4 / label (không phân biệt hoa thường, bỏ khoảng trắng); thiếu hoặc rỗng = label", () => {
  assert.equal(kindFromEnv(""), "label", "thiếu dòng");
  assert.equal(kindFromEnv("PRINTER_KIND="), "label", "dòng rỗng");
  assert.equal(kindFromEnv("PRINTER_KIND=   "), "label", "chỉ khoảng trắng");
  assert.equal(kindFromEnv("# PRINTER_KIND=a4"), "label", "dòng mẫu dạng bình luận");
  assert.equal(kindFromEnv("PRINTER_KIND=a4"), "a4");
  assert.equal(kindFromEnv("PRINTER_KIND= A4 "), "a4");
  assert.equal(kindFromEnv("PRINTER_KIND=label"), "label");
  assert.equal(kindFromEnv("PRINTER_KIND=LABEL"), "label");
});

test("0.11.0 (v2): PRINTER_KIND lạ → loadConfig ném lỗi rõ ràng, không lặng lẽ chạy thành agent tem", () => {
  for (const line of ["PRINTER_KIND=laser", "PRINTER_KIND=a-4", "PRINTER_KIND=a4 # ghi chú", "PRINTER_KIND=A4,label"]) {
    assert.throws(() => kindFromEnv(line), /PRINTER_KIND không hợp lệ.*chỉ nhận label hoặc a4/, line);
  }
});

test("0.11.0 (v3): PRINTER_KIND lạ khi chạy service → có dòng lỗi trong logs/agent.log (Task Scheduler bỏ stderr) và thoát mã khác 0", async () => {
  const { spawnSync } = await import("node:child_process");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-log-0110-")), ".env");
  fs.writeFileSync(envFile, "PRINT_QUEUE_PROVIDER=supabase\nPRINTER_KIND=a-4\n");
  const started = Date.now() - 1000;
  const env = { ...process.env };
  delete env.PRINTER_KIND;
  delete env.PRINT_AGENT_ENV;
  const child = spawnSync(process.execPath, [path.join(root, "src", "cli.mjs"), "service", "--env", envFile], { cwd: root, env, encoding: "utf8", timeout: 30000, windowsHide: true });
  assert.notEqual(child.status, 0, "phải thoát mã khác 0");
  assert.equal(child.status, 1);
  const logFile = path.join(root, "logs", "agent.log");
  assert.ok(fs.existsSync(logFile), "có logs/agent.log");
  const lines = fs.readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => {
    const match = /^\[([^\]]+)\] ERROR (.*)$/.exec(line);
    return match && Date.parse(match[1]) >= started && /PRINTER_KIND không hợp lệ: "a-4"/.test(match[2]);
  });
  assert.equal(lines.length, 1, "đúng một dòng lỗi cấu hình mới trong agent.log");
  assert.match(child.stderr, /PRINTER_KIND không hợp lệ/, "stderr vẫn có lỗi khi chạy tay");
});

test("0.11.0: runService chế độ a4 báo hàng đợi đúng một khả năng xa_vai_sheet:v1", async () => {
  const states = [];
  const controller = new AbortController();
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const queue = { claim: async (state) => { states.push(state); controller.abort(); return { job: null }; } };
  const config = { agentId: "may-a4-test", printerName: "PDF ảo", printerKind: "a4", queueProvider: "memory", tempDir: os.tmpdir(),
    pollIntervalMs: 1000, idlePollMs: 1000, idlePollNoWakeMs: 1000, activeWindowMs: 0, printerCacheMs: 0, loopStallMs: 0 };
  await runService(config, queue, logger, controller.signal, null, { queryPrinter: async () => ({ ok: true, blocked: false, code: "READY" }) });
  assert.equal(states.length, 1);
  assert.deepEqual(states[0].capabilities, ["xa_vai_sheet:v1"]);
  assert.ok(logs.some((m) => /hỗ trợ xa_vai_sheet:v1$/.test(m)), "log khởi động ghi khả năng A4");
});

// ---------- Kiểm lệnh ----------

test("0.11.0: normalizeJob nhận lệnh xa_vai_sheet hợp lệ, chuẩn hoá payload", () => {
  const lot40 = "L".repeat(39) + "Z";
  const checked = normalizeJob(sheetJob({}, { productName: "", items: [
    item(1, { lot: "  L  1  ", systemMm: null }),
    item(2, { lot: lot40, roll: "R".repeat(45), actualMm: "12500", systemMm: 12750.4 }),
    item(3, { actualMm: 1.4, systemMm: 0 })
  ] }));
  assert.equal(checked.ok, true, checked.errors.join("; "));
  const { job } = checked;
  assert.equal(job.type, "xa_vai_sheet");
  assert.equal(job.copies, 2);
  assert.equal(job.payload.itemCode, "CWSH02");
  assert.ok(!("sku" in job.payload), "V3: không còn sku mức payload");
  assert.equal(job.payload.productName, null, "V3: tên trống → null (không lấy SKU thay tên)");
  assert.deepEqual(job.payload.items.map((entry) => entry.sku), ["900000001", "900000001", "900000001"], "sku từng dòng");
  assert.equal(job.payload.reprint, false);
  assert.equal(job.payload.items[0].lot, "L 1");
  assert.equal(job.payload.items[0].systemMm, null);
  assert.equal(job.payload.items[1].lot, lot40, "Lot 40 ký tự giữ nguyên (phiếu là bản ghi theo dõi)");
  assert.equal(job.payload.items[1].roll.length, 40, "Roll cắt ở 40 ký tự");
  assert.equal(job.payload.items[1].actualMm, 12500, "chuỗi số mm → số nguyên");
  assert.equal(job.payload.items[1].systemMm, 12750, "mm làm tròn về số nguyên");
  assert.equal(job.payload.items[2].actualMm, 1, "1,4 mm làm tròn còn 1 (≥ 1) vẫn hợp lệ");
  assert.equal(job.payload.items[2].systemMm, 0);
  for (const entry of job.payload.items) {
    assert.ok(!("actualM" in entry) && !("systemM" in entry), "không còn trường mét của v1");
  }
  assert.equal(normalizeJob(sheetJob({ copies: 5 }, { reprint: true })).job.payload.reprint, true);
  assert.equal(normalizeJob(sheetJob({}, { items: items(100) })).ok, true, "100 dòng là trần");
});

test("0.11.0 (v3): itemCode bắt buộc, đúng mẫu ^[0-9A-Z._-]{1,40}$, KHÔNG chuẩn hoá giúp; sku từng dòng; productName tuỳ chọn", () => {
  for (const code of ["CWSH02", "TEST01", "A", "9", "CW.SH_02-B", "Z".repeat(40)]) {
    const checked = normalizeJob(sheetJob({}, { itemCode: code }));
    assert.equal(checked.ok, true, `${code}: ${checked.errors.join("; ")}`);
    assert.equal(checked.job.payload.itemCode, code);
  }
  for (const [label, code] of [["chữ thường", "cwsh02"], ["thường lẫn hoa", "CWsh02"], ["khoảng trắng hai đầu", " CWSH02 "], ["khoảng trắng giữa", "CW SH02"],
    ["41 ký tự", "Z".repeat(41)], ["rỗng", ""], ["dấu /", "CW/SH02"], ["có dấu", "CWSHĐ2"], ["số JSON", 102], ["null", null]]) {
    const checked = normalizeJob(sheetJob({}, { itemCode: code }));
    assert.equal(checked.ok, false, `${label} phải bị từ chối`);
    assert.ok(checked.errors.some((error) => /Mã hàng/.test(error)), `${label}: thông điệp nói Mã hàng`);
  }
  const missing = sheetJob();
  delete missing.payload.itemCode;
  assert.equal(normalizeJob(missing).ok, false, "thiếu itemCode → từ chối");
  // Payload v2 (sku mức payload, item không có sku) → từ chối (thiếu itemCode + thiếu sku dòng).
  const v2 = normalizeJob(sheetJob({}, { itemCode: undefined, sku: "900000001", items: [{ ...item(1), sku: undefined }] }));
  assert.equal(v2.ok, false);
  // Một phiếu nhiều SKU là bình thường.
  const mixed = normalizeJob(sheetJob({}, { items: [item(1), item(2, { sku: "900000002" }), item(3, { sku: "ABC-01.x_9" })] }));
  assert.equal(mixed.ok, true, mixed.errors.join("; "));
  assert.deepEqual(mixed.job.payload.items.map((entry) => entry.sku), ["900000001", "900000002", "ABC-01.x_9"]);
  for (const [label, sku] of [["SKU sai mẫu", "SKU 9000!"], ["SKU trống", ""], ["SKU 41 ký tự", "9".repeat(41)], ["SKU null", null]]) {
    const checked = normalizeJob(sheetJob({}, { items: [item(1), item(2, { sku })] }));
    assert.equal(checked.ok, false, `${label} phải bị từ chối`);
    assert.ok(checked.errors.some((error) => /SKU dòng 2/.test(error)), `${label}: báo đúng dòng 2`);
  }
  assert.equal(normalizeJob(sheetJob({}, { productName: null })).job.payload.productName, null);
  assert.equal(normalizeJob(sheetJob({}, { productName: undefined })).job.payload.productName, null);
  assert.equal(normalizeJob(sheetJob({}, { productName: "   " })).job.payload.productName, null);
  assert.equal(normalizeJob(sheetJob({}, { productName: "Vải thử" })).job.payload.productName, "Vải thử");
  const long = normalizeJob(sheetJob({}, { productName: "V".repeat(200) }));
  assert.equal(long.ok, true);
  assert.equal(long.job.payload.productName.length, 180, "tên > 180 ký tự cắt (đã chốt)");
  assert.equal(normalizeJob(sheetJob({}, { reprint: "true" })).job.payload.reprint, false, "reprint chỉ nhận boolean true");
});

test("0.11.0: normalizeJob từ chối cả lệnh xa_vai_sheet khi sai bất kỳ trường nào", () => {
  const bad = (label, job) => {
    const checked = normalizeJob(job);
    assert.equal(checked.ok, false, `${label} phải bị từ chối`);
    assert.ok(checked.errors.length > 0);
  };
  bad("templateVersion 2", sheetJob({ templateVersion: 2 }));
  bad("copies 6", sheetJob({ copies: 6 }));
  bad("copies 0", sheetJob({ copies: 0 }));
  bad("Mã hàng sai mẫu", sheetJob({}, { itemCode: "CW SH02!" }));
  bad("Mã hàng trống", sheetJob({}, { itemCode: "" }));
  bad("SKU dòng sai mẫu", sheetJob({}, { items: [item(1, { sku: "SKU 9000!" })] }));
  bad("SKU dòng trống", sheetJob({}, { items: [item(1, { sku: "" })] }));
  bad("printedAt không phải ngày", sheetJob({}, { printedAt: "hôm nay" }));
  bad("printedAt trống", sheetJob({}, { printedAt: "" }));
  bad("0 dòng", sheetJob({}, { items: [] }));
  bad("items không phải mảng", sheetJob({}, { items: null }));
  bad("101 dòng", sheetJob({}, { items: items(101) }));
  bad("Group UID trống", sheetJob({}, { items: [item(1, { groupUid: "" })] }));
  bad("Group UID 41 ký tự", sheetJob({}, { items: [item(1, { groupUid: "1".repeat(41) })] }));
  bad("Group UID có dấu", sheetJob({}, { items: [item(1, { groupUid: "1028260000000ạ" })] }));
  bad("actualMm = 0", sheetJob({}, { items: [item(1, { actualMm: 0 })] }));
  bad("actualMm 0,4 làm tròn ra 0", sheetJob({}, { items: [item(1, { actualMm: 0.4 })] }));
  bad("actualMm âm", sheetJob({}, { items: [item(1, { actualMm: -1 })] }));
  bad("actualMm chữ", sheetJob({}, { items: [item(1, { actualMm: "abc" })] }));
  bad("actualMm null", sheetJob({}, { items: [item(1, { actualMm: null })] }));
  bad("actualMm vô hạn", sheetJob({}, { items: [item(1, { actualMm: Infinity })] }));
  bad("actualMm > 100.000 m", sheetJob({}, { items: [item(1, { actualMm: 100000001 })] }));
  bad("payload v1 chỉ có actualM/systemM", sheetJob({}, { items: [{ groupUid: uid(1), lot: "L", roll: "1", systemM: 50, actualM: 49.5, measuredAt: "2026-11-04T07:00:00Z" }] }));
  bad("systemMm âm", sheetJob({}, { items: [item(1, { systemMm: -1 })] }));
  bad("systemMm chữ", sheetJob({}, { items: [item(1, { systemMm: "x" })] }));
  bad("systemMm vô hạn", sheetJob({}, { items: [item(1, { systemMm: Infinity })] }));
  bad("measuredAt sai", sheetJob({}, { items: [item(1, { measuredAt: "04/11/2026" })] }));
});

test("0.11.0: chế độ máy in quyết định loại lệnh được nhận", () => {
  assert.equal(normalizeJob(sheetJob(), { printerKind: "a4" }).ok, true);
  assert.equal(normalizeJob(sheetJob(), { printerKind: "label" }).ok, false, "agent tem không in phiếu A4");
  assert.equal(normalizeJob(skuJob(), { printerKind: "a4" }).ok, false, "agent A4 không in tem");
  assert.equal(normalizeJob(skuJob(), { printerKind: "label" }).ok, true);
  assert.equal(normalizeJob(skuJob()).ok, true, "không nêu chế độ = như cũ");
});

// ---------- Mẫu phiếu ----------

test("0.11.0: giờ Việt Nam", () => {
  assert.equal(formatViDateTime("2026-11-04T17:30:00Z"), "05/11/2026 00:30");
  assert.equal(formatViDateTime("2026-11-04T08:30:00.123456+00:00"), "04/11/2026 15:30");
});

test("0.11.0 (v3): ngày xả = ngày giờ VN của measuredAt — một ngày, nhiều ngày, khác năm, múi giờ", () => {
  const at = (...isos) => isos.map((measuredAt, index) => item(index + 1, { measuredAt }));
  assert.equal(xaVaiReleaseLabel(at("2026-11-04T07:00:00Z")), "Xả 04/11/2026");
  assert.equal(xaVaiReleaseLabel(at("2026-11-04T01:00:00Z", "2026-11-04T16:59:59Z")), "Xả 04/11/2026", "cùng một ngày VN");
  assert.equal(xaVaiReleaseLabel(at("2026-11-03T18:30:00Z")), "Xả 04/11/2026", "18:30 UTC ngày 03 = 01:30 ngày 04 giờ VN");
  assert.equal(xaVaiReleaseLabel(at("2026-11-03T16:59:00Z")), "Xả 03/11/2026", "16:59 UTC = 23:59 giờ VN cùng ngày");
  assert.equal(xaVaiReleaseLabel(at("2026-11-04T08:30:00.123456+00:00", "2026-11-05T09:00:00+07:00")), "Xả 04/11 – 05/11/2026");
  assert.equal(xaVaiReleaseLabel(at("2026-11-06T02:00:00Z", "2026-10-30T02:00:00Z", "2026-11-02T02:00:00Z")), "Xả 30/10 – 06/11/2026", "nhỏ nhất → lớn nhất, không theo thứ tự dòng");
  assert.equal(xaVaiReleaseLabel(at("2026-12-31T10:00:00Z", "2027-01-01T03:00:00Z")), "Xả 31/12/2026 – 01/01/2027", "khác năm (31/12 17:00 VN → 01/01 10:00 VN)");
  assert.equal(xaVaiReleaseLabel(at("2026-12-31T17:30:00Z")), "Xả 01/01/2027", "qua năm mới theo giờ VN");
});

test("0.11.0 (v3): biển lớn đầu MỌI trang — Mã hàng cỡ rất lớn đậm + 'Xả dd/mm/yyyy' lớn đậm, cùng chuỗi ngày trên mọi trang", () => {
  const rows = items(XA_VAI_ROWS_PER_PAGE * 2 + 1).map((entry, index) => ({ ...entry, measuredAt: index < 5 ? "2026-11-03T18:30:00Z" : "2026-11-05T02:00:00Z" }));
  const svgs = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: rows })).job.payload);
  assert.equal(svgs.length, 3);
  for (const [index, svg] of svgs.entries()) {
    const code = /<text [^>]*font-size="(\d+)" font-weight="bold"[^>]*data-role="item-code"[^>]*>([^<]*)<\/text>/.exec(svg);
    assert.ok(code, `trang ${index + 1} có Mã hàng`);
    assert.equal(code[2], "CWSH02");
    assert.ok(Number(code[1]) >= 240, `Mã hàng ngắn cỡ ≥ 240 (đang ${code[1]})`);
    const date = /<text [^>]*font-size="(\d+)" font-weight="bold"[^>]*data-role="release-date"[^>]*>([^<]*)<\/text>/.exec(svg);
    assert.ok(date, `trang ${index + 1} có ngày xả`);
    assert.equal(date[2], "Xả 04/11 – 05/11/2026");
    assert.ok(Number(date[1]) >= 130, `ngày xả cỡ ≥ 130 (đang ${date[1]})`);
    assert.match(svg, /PHIẾU THEO DÕI XẢ VẢI/);
    assert.match(svg, new RegExp(`Trang ${index + 1}/3`));
    assert.match(svg, /Ngày in 04\/11\/2026 15:30/);
  }
  const single = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { itemCode: "TEST01" })).job.payload)[0];
  assert.match(single, /data-role="item-code"[^>]*>TEST01</);
  assert.match(single, /data-role="release-date"[^>]*>Xả 04\/11\/2026</);
});

test("0.11.0 (v3): Mã hàng dài thu cỡ (≥ 140) rồi mới cắt '…'; không đè ngày xả, không tràn lề", () => {
  const codeOf = (itemCode, extra = {}) => {
    const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { itemCode, ...extra })).job.payload);
    const code = /<text x="(\d+)" y="\d+" font-size="(\d+)" font-weight="bold"[^>]*data-role="item-code"[^>]*>([^<]*)<\/text>/.exec(svg);
    const date = /<text x="(\d+)" y="\d+" font-size="(\d+)" font-weight="bold" text-anchor="end"[^>]*data-role="release-date"[^>]*>([^<]*)<\/text>/.exec(svg);
    return { x: Number(code[1]), size: Number(code[2]), text: code[3], dateRight: Number(date[1]), dateSize: Number(date[2]), date: date[3] };
  };
  const short = codeOf("CWSH02");
  const long14 = codeOf("CWSH02-TEST-AB");
  assert.equal(long14.text, "CWSH02-TEST-AB", "14 ký tự in đủ");
  assert.ok(long14.size < short.size && long14.size >= 140, `14 ký tự thu cỡ ${short.size} → ${long14.size}`);
  const huge = codeOf("W".repeat(40));
  assert.equal(huge.size, 140, "quá dài: dừng ở 140");
  assert.ok(huge.text.endsWith("…"), "quá dài thì cắt kèm …");
  // Khoảng ngày dài nhất (khác năm) + mã dài nhất: ngày xả KHÔNG bị cắt, cỡ ≥ 130; mã vẫn ≥ 140.
  const yearSpan = { items: [item(1, { measuredAt: "2026-12-31T10:00:00Z" }), item(2, { measuredAt: "2027-01-01T03:00:00Z" })] };
  const worst = codeOf("W".repeat(40), yearSpan);
  assert.equal(worst.date, "Xả 31/12/2026 – 01/01/2027");
  assert.ok(worst.dateSize >= 130 && worst.size >= 140, `cỡ ngày ${worst.dateSize}, cỡ mã ${worst.size}`);
  const shortSpan = codeOf("CWSH02", yearSpan);
  assert.equal(shortSpan.text, "CWSH02");
  assert.ok(shortSpan.size >= 200, `mã ngắn vẫn lớn khi ngày dài (đang ${shortSpan.size})`);
  for (const entry of [short, long14, huge, worst, shortSpan]) {
    assert.equal(entry.x, XA_VAI_PAGE.marginX, "Mã hàng căn trái tại lề");
    assert.equal(entry.dateRight, XA_VAI_PAGE.width - XA_VAI_PAGE.marginX, "ngày xả căn phải tại lề");
    const codeRight = entry.x + estimateTextWidth(entry.text, entry.size) * 1.1;
    const dateLeft = entry.dateRight - estimateTextWidth(entry.date, entry.dateSize) * 1.1;
    assert.ok(codeRight + 60 <= dateLeft, `Mã hàng (${entry.text}) không đè ngày xả: ${Math.round(codeRight)} < ${Math.round(dateLeft)}`);
  }
});

test("0.11.0 (review vòng 3): biển phải cắt Mã hàng → dòng nhỏ 'Mã hàng: <đầy đủ>' trên MỌI trang, cỡ ≥ 34, không cắt", () => {
  const fullLine = (svg) => {
    const match = /<text x="(\d+)" y="\d+" font-size="(\d+)"[^>]*data-role="item-code-full"[^>]*>([^<]*)<\/text>/.exec(svg);
    return match ? { x: Number(match[1]), size: Number(match[2]), text: match[3] } : null;
  };
  const banner = (svg) => /data-role="item-code"[^>]*>([^<]*)</.exec(svg)[1];
  for (const code of ["CWSH02-FT-SHORT-NAVY-L", "CWSH02-FT-SHORT-NAVY-XL", "W".repeat(40), "M".repeat(40)]) {
    const svgs = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { itemCode: code, items: items(XA_VAI_ROWS_PER_PAGE + 1) })).job.payload);
    assert.equal(svgs.length, 2);
    for (const [index, svg] of svgs.entries()) {
      assert.ok(banner(svg).endsWith("…"), `${code}: biển cắt "…" (trang ${index + 1})`);
      const line = fullLine(svg);
      assert.ok(line, `${code}: trang ${index + 1} có dòng Mã hàng đầy đủ`);
      assert.equal(line.text, `Mã hàng: ${code}`, "mã đầy đủ, không cắt");
      assert.ok(line.size >= 34, `cỡ ${line.size} ≥ 34`);
      assert.equal(line.x, XA_VAI_PAGE.marginX);
      assert.ok(XA_VAI_PAGE.marginX + estimateTextWidth(line.text, line.size) * 1.1 <= XA_VAI_PAGE.width - XA_VAI_PAGE.marginX, "không tràn lề phải");
    }
  }
  // Hai mã chỉ khác đuôi: biển giống nhau được, nhưng dòng nhỏ phải khác nhau.
  const lineOf = (code) => fullLine(renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { itemCode: code })).job.payload)[0]).text;
  assert.notEqual(lineOf("CWSH02-FT-SHORT-NAVY-L"), lineOf("CWSH02-FT-SHORT-NAVY-XL"));
  // Mã vừa biển (ngắn, hoặc 14 ký tự chỉ thu cỡ) → không thêm dòng.
  for (const code of ["CWSH02", "TEST01", "CWSH02-TEST-AB"]) {
    const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { itemCode: code })).job.payload);
    assert.equal(banner(svg), code, `${code} in đủ trên biển`);
    assert.equal(fullLine(svg), null, `${code}: không có dòng Mã hàng`);
    assert.doesNotMatch(svg, /Mã hàng:/);
  }
});

test("0.11.0 (review vòng 3): mã dài + productName → 'Mã hàng: …' đứng trước, tên sản phẩm bị cắt trước, không cắt mã", () => {
  const code = "W".repeat(40);
  const longName = `${"WWW MMM Vải Thun Lạnh Đặc Biệt Siêu Dày Nhập Khẩu ".repeat(4)}`.trim().slice(0, 180);
  const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { itemCode: code, productName: longName })).job.payload);
  const full = /<text x="(\d+)" y="(\d+)" font-size="(\d+)"[^>]*data-role="item-code-full"[^>]*>([^<]*)</.exec(svg);
  const product = /<text x="(\d+)" y="(\d+)" font-size="(\d+)"[^>]*data-role="product-line"[^>]*>([^<]*)</.exec(svg);
  assert.ok(full && product, "có cả hai phần");
  assert.equal(full[4], `Mã hàng: ${code}`);
  assert.equal(full[2], product[2], "cùng một dòng (cùng chân chữ)");
  assert.ok(Number(product[1]) > Number(full[1]) + estimateTextWidth(full[4], Number(full[3])) * 1.1, "tên đứng sau mã, không đè");
  assert.ok(product[4].startsWith("SKU 900000001 · "), product[4]);
  assert.ok(product[4].endsWith("…"), "tên sản phẩm bị cắt");
  assert.ok(Number(product[1]) + estimateTextWidth(product[4], Number(product[3])) <= XA_VAI_PAGE.width - XA_VAI_PAGE.marginX, "tên không tràn lề");
  // Mã ngắn + tên: chỉ dòng SKU như cũ.
  const [short] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { productName: "Vải thử" })).job.payload);
  assert.doesNotMatch(short, /item-code-full/);
  assert.match(short, /data-role="product-line" ?[^>]*>SKU 900000001 · Vải thử</);
  assert.match(short, new RegExp(`<text x="${XA_VAI_PAGE.marginX}" [^>]*data-role="product-line"`), "không có mã thì dòng SKU bắt đầu ở lề");
});

test("0.11.0 (v3): bảng có cột SKU sau Group UID; tổng bề rộng đúng 3224", () => {
  assert.deepEqual(XA_VAI_COLUMNS.map((column) => column.title),
    ["STT", "Group UID", "SKU", "Lot", "Roll", "Hệ thống (mm)", "Thực tế (mm)", "Chênh lệch (mm)", "Giờ nhập"]);
  assert.equal(XA_VAI_COLUMNS.reduce((sum, column) => sum + column.width, 0), 3224);
  assert.equal(XA_VAI_PAGE.width - 2 * XA_VAI_PAGE.marginX, 3224);
  const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1), item(2, { sku: "900000002" })] })).job.payload);
  assert.match(svg, />SKU</);
  assert.match(svg, />900000002</, "ô SKU của dòng 2");
  // Mọi tiêu đề cột in đủ (không "…").
  for (const column of XA_VAI_COLUMNS) assert.ok(svg.includes(`>${column.title}<`), `tiêu đề ${column.title} in đủ`);
  // 04/11/2026: bỏ hẳn độ co — không cột "Co (%)", không ký tự % nào trên phiếu (kể cả dòng TỔNG).
  const [last] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1), item(2, { systemMm: null })] })).job.payload);
  for (const page of [svg, last]) {
    assert.doesNotMatch(page, /Co \(%\)/);
    assert.doesNotMatch(page, /%/, "không còn % trên phiếu");
    assert.doesNotMatch(page, /Mét /, "cột số là mm, không còn tiêu đề mét");
  }
  assert.ok(!XA_VAI_COLUMNS.some((column) => column.key === "shrinkPct"));
});

test("0.11.0 (04/11): số mm tối đa (100.000.000, 11 ký tự) và chênh lệch âm lớn in đủ trong cột, không thu dưới cỡ thường", () => {
  const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1, { systemMm: 100000000, actualMm: 1 }), item(2, { systemMm: 1, actualMm: 100000000 })] })).job.payload);
  assert.ok(svg.includes(">100.000.000<"), "100.000.000 in đủ");
  assert.ok(svg.includes(">-99.999.999<"), "chênh lệch âm 9 chữ số in đủ");
  assert.ok(svg.includes(">99.999.999<"));
  for (const key of ["systemMm", "actualMm", "diffMm"]) {
    const column = XA_VAI_COLUMNS.find((entry) => entry.key === key);
    assert.ok(estimateTextWidth("-100.000.000", 34) <= column.width - 36, `cột ${column.title} chứa được -100.000.000 ở cỡ 34`);
  }
});

test("0.11.0 (v3): dòng 'SKU <sku> · <tên>' CHỈ khi có productName và mọi dòng một SKU", () => {
  const line = (payload) => {
    const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, payload)).job.payload);
    return [...svg.matchAll(/data-role="product-line"[^>]*>([^<]*)</g)].map((match) => match[1]);
  };
  assert.deepEqual(line({ productName: null }), [], "productName null → không có dòng SKU");
  assert.deepEqual(line({ productName: "" }), []);
  assert.deepEqual(line({ productName: "Vải thử" }), ["SKU 900000001 · Vải thử"]);
  assert.deepEqual(line({ productName: "Vải thử", items: [item(1), item(2, { sku: "900000002" })] }), [], "nhiều SKU → không ghi thêm");
  const long = line({ productName: `${"WWW MMM Vải Thun Lạnh Đặc Biệt Siêu Dày Nhập Khẩu ".repeat(4)}`.trim().slice(0, 180) });
  assert.equal(long.length, 1, "tên dài vẫn MỘT dòng");
  assert.ok(estimateTextWidth(long[0], 28) <= XA_VAI_PAGE.width - 2 * XA_VAI_PAGE.marginX, "không tràn lề");
});

test("0.11.0 (04/11): số mm nguyên kiểu Việt — nhóm nghìn dấu chấm, không đổi sang mét", () => {
  assert.equal(formatViMm(60758), "60.758");
  assert.equal(formatViMm(-2734), "-2.734");
  assert.equal(formatViMm(1347120), "1.347.120");
  assert.equal(formatViMm(100000000), "100.000.000");
  assert.equal(formatViMm(999), "999");
  assert.equal(formatViMm(-5), "-5");
  assert.equal(formatViMm(0), "0");
  assert.equal(formatViMm(12750.4), "12.750", "phòng hờ: làm tròn về mm nguyên");
  assert.equal(formatViMm(-0.4), "0", "không in -0");
  assert.equal(formatViMm(null), "—");
  assert.equal(formatViMm(undefined), "—");
});

test("0.11.0 (04/11): ô của một dòng — mm nguyên; chênh lệch = thực tế − hệ thống; thiếu mét hệ thống thì —", () => {
  assert.deepEqual(xaVaiRowCells(item(1)), { systemMm: "50.000", actualMm: "49.500", diffMm: "-500", measuredAt: "14:00 04/11" });
  const noSystem = xaVaiRowCells(item(2, { systemMm: null }));
  assert.equal(noSystem.systemMm, "—");
  assert.equal(noSystem.diffMm, "—");
  assert.equal(noSystem.actualMm, "49.500");
  assert.equal(xaVaiRowCells(item(3, { systemMm: 0, actualMm: 1200 })).diffMm, "1.200", "hệ thống 0 mm vẫn có chênh lệch");
  // Vectơ hợp đồng: 16763 g vải 155gsm 178cm = 60758 mm.
  const vector = xaVaiRowCells(item(4, { systemMm: 60758, actualMm: 58024 }));
  assert.equal(vector.systemMm, "60.758");
  assert.equal(vector.actualMm, "58.024");
  assert.equal(vector.diffMm, "-2.734", "chênh = 58024 − 60758 = −2734 mm");
  assert.ok(!("shrinkPct" in vector), "không còn độ co");
});

test("0.11.0 (04/11): dòng tổng (mm) — hệ thống chỉ cộng dòng có số; chênh lệch tính trên các dòng có mét hệ thống", () => {
  const rows = [item(1, { systemMm: 50000, actualMm: 49500 }), item(2, { systemMm: null, actualMm: 10000 }), item(3, { systemMm: 100000, actualMm: 97000 })];
  const totals = xaVaiTotals(rows);
  assert.deepEqual(totals, { count: 3, comparedCount: 2, systemMm: 150000, actualMm: 156500, diffMm: -3500 }, "không còn shrinkPct");
  assert.ok(Number.isInteger(totals.actualMm) && Number.isInteger(totals.systemMm) && Number.isInteger(totals.diffMm), "tổng là mm nguyên");
  const none = xaVaiTotals([item(1, { systemMm: null })]);
  assert.equal(none.systemMm, null);
  assert.equal(none.diffMm, null);
  // Trên phiếu: dòng TỔNG in mm nhóm nghìn.
  const svg = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: rows })).job.payload)[0];
  const total = svg.slice(svg.indexOf("TỔNG ("));
  assert.match(total, />150\.000</);
  assert.match(total, />156\.500</);
  assert.match(total, />-3\.500</);
});

test("0.11.0 (v2): Lot 40 ký tự nằm gọn trong cột Lot — thu cỡ chữ hoặc cắt kèm …", () => {
  const lot = "W".repeat(40);
  const job = normalizeJob(sheetJob({}, { items: [item(1, { lot, roll: "M".repeat(40) })] })).job;
  assert.equal(job.payload.items[0].lot, lot);
  const [svg] = renderXaVaiSheetSvgs(job.payload);
  // Cột Lot / Roll: trái = lề 142 + bề rộng các cột đứng trước (V3 thêm cột SKU), đệm 18 mỗi bên.
  const leftOf = (key) => 142 + XA_VAI_COLUMNS.slice(0, XA_VAI_COLUMNS.findIndex((column) => column.key === key)).reduce((sum, column) => sum + column.width, 0);
  const widthOf = (key) => XA_VAI_COLUMNS.find((column) => column.key === key).width;
  for (const [name, left, width] of [["Lot", leftOf("lot"), widthOf("lot")], ["Roll", leftOf("roll"), widthOf("roll")]]) {
    const cells = [...svg.matchAll(new RegExp(`<text x="${left + 18}" y="\\d+" font-size="(\\d+)"[^>]*>([^<]*)</text>`, "g"))]
      .filter((match) => match[2] !== name);
    assert.equal(cells.length, 1, `một ô ${name} dữ liệu`);
    const [, size, text] = cells[0];
    assert.ok(text.endsWith("…") || Number(size) < 34, `${name} phải thu cỡ hoặc có …`);
    assert.ok(estimateTextWidth(text, Number(size)) <= width - 36, `${name} "${text}" cỡ ${size} không tràn ô`);
  }
});

test("0.11.0 (v2): Lot / Roll tới 28 ký tự chữ hoa in đủ trên phiếu, không bị cắt (Lot thật từng dài 24 ký tự)", () => {
  const lot = "LOT-2026-10-ABCDEFGHIJKLMNOP";
  const roll = `${lot}-0001`.slice(0, 28);
  const [svg] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1, { lot, roll })] })).job.payload);
  assert.ok(svg.includes(`>${lot}<`), "Lot 28 ký tự in đủ");
  assert.ok(svg.includes(`>${roll}<`), "Roll 28 ký tự in đủ");
  // V3 (đã chốt): Lot 24 ký tự chữ hoa (chữ thường gặp, không phải toàn W/M) in đủ ở cột SKU mới thu hẹp, không cắt.
  const lot24 = "LOTABCDEFGHIJKLMNOPQRSTU";
  assert.equal(lot24.length, 24);
  const [svg24] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1, { lot: lot24, roll: lot24 })] })).job.payload);
  assert.equal(svg24.split(`>${lot24}<`).length - 1, 2, "Lot và Roll 24 ký tự chữ hoa in đủ");
  // 04/11: bỏ cột Co → dồn bề rộng cho Lot/Roll: 28 chữ hoa liền (không gạch, không số) vẫn in đủ.
  const lot28 = "LOTABCDEFGHIJKLMNOPQRSTUVXYZ";
  assert.equal(lot28.length, 28);
  const [svg28] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1, { lot: lot28, roll: lot28 })] })).job.payload);
  assert.equal(svg28.split(`>${lot28}<`).length - 1, 2, "Lot và Roll 28 ký tự chữ hoa in đủ");
  for (const key of ["groupUid", "sku"]) {
    const column = XA_VAI_COLUMNS.find((entry) => entry.key === key);
    const sample = key === "groupUid" ? uid(1) : "900000001";
    assert.ok(estimateTextWidth(sample, 34) <= column.width - 36, `${column.title} không hẹp quá: ${sample} vừa cỡ 34`);
  }
});

test("0.11.0: dòng tổng ghi rõ chênh lệch tính trên bao nhiêu UID có mét hệ thống khi có UID thiếu", () => {
  const some = [item(1, { systemMm: 50000, actualMm: 49500 }), item(2, { systemMm: null, actualMm: 10000 }), item(3, { systemMm: 100000, actualMm: 97000 })];
  assert.equal(xaVaiTotals(some).comparedCount, 2);
  const [partial] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: some })).job.payload);
  assert.match(partial, /TỔNG \(3 UID\)/);
  assert.match(partial, /chênh lệch: 2\/3 UID có mét hệ thống/);
  assert.doesNotMatch(partial, /\bco\b/i, "không còn nhắc độ co");
  const [full] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: items(3) })).job.payload);
  assert.match(full, /TỔNG \(3 UID\)/);
  assert.doesNotMatch(full, /chênh lệch:/, "đủ mét hệ thống thì không cần chú thích");
  const [none] = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: [item(1, { systemMm: null })] })).job.payload);
  assert.match(none, /không có mét hệ thống để so/);
});

test("0.11.0 (v3): số trang theo số dòng — 18 dòng/trang (biển lớn chiếm chỗ); 19 = 2; 100 = 6; tổng và ô ký chỉ ở trang cuối", () => {
  assert.equal(XA_VAI_ROWS_PER_PAGE, 18);
  assert.ok(XA_VAI_ROWS_PER_PAGE >= 14, "mục tiêu ≥ 14 dòng/trang");
  for (const [count, pages] of [[1, 1], [18, 1], [19, 2], [36, 2], [37, 3], [100, 6]]) {
    assert.equal(paginateXaVai(items(count)).length, pages, `${count} dòng`);
  }
  const svgs = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { items: items(19) })).job.payload);
  assert.equal(svgs.length, 2);
  assert.match(svgs[0], /PHIẾU THEO DÕI XẢ VẢI/);
  assert.match(svgs[0], /Trang 1\/2/);
  assert.match(svgs[1], /Trang 2\/2/);
  assert.match(svgs[0], /Ngày in 04\/11\/2026 15:30/);
  assert.doesNotMatch(svgs[0], /TỔNG/);
  assert.doesNotMatch(svgs[0], /Người xả/);
  assert.match(svgs[1], /TỔNG/);
  assert.match(svgs[1], /Người xả/);
  assert.match(svgs[1], /Người kiểm/);
  assert.match(svgs[1], /1028260000000019/);
  assert.doesNotMatch(svgs[1], /1028260000000018/, "dòng 18 ở trang 1");
  assert.doesNotMatch(svgs[0], /IN LẠI/);
  const reprint = renderXaVaiSheetSvgs(normalizeJob(sheetJob({}, { reprint: true })).job.payload);
  assert.match(reprint[0], /IN LẠI/);
});

test("0.11.0: tên sản phẩm + Mã hàng + ô dài không tràn lề — ảnh trắng ngoài lề an toàn", async () => {
  const longName = `${"WWW MMM Vải Thun Lạnh Đặc Biệt Siêu Dày Nhập Khẩu ".repeat(4)}`.trim().slice(0, 180);
  const job = normalizeJob(sheetJob({}, { itemCode: "W".repeat(40), productName: longName, reprint: true,
    items: [item(1, { groupUid: "W".repeat(40), sku: "W".repeat(40), lot: "M".repeat(40), roll: "W".repeat(40), measuredAt: "2026-12-31T10:00:00Z" }), item(2, { sku: "W".repeat(40), measuredAt: "2027-01-01T03:00:00Z" })] })).job;
  const [svg] = renderXaVaiSheetSvgs(job.payload);
  assert.equal((svg.match(/data-role="product-line"/g) || []).length, 1, "một SKU (40 ký tự) + tên → có dòng tên");
  assert.equal((svg.match(/data-role="item-code-full"/g) || []).length, 1, "mã 40 ký tự bị cắt trên biển → có dòng Mã hàng đầy đủ");
  assert.match(svg, /…/, "mã / ô quá dài phải có dấu cắt");
  const pages = await renderXaVaiSheetPages(job);
  assert.equal(pages.length, 1);
  const meta = await sharp(pages[0]).metadata();
  assert.equal(meta.width, XA_VAI_PAGE.width);
  assert.equal(meta.height, XA_VAI_PAGE.height);
  assert.equal(meta.width, 3508);
  assert.equal(meta.height, 2480);
  assert.equal(Math.round(meta.density), 300);
  const { data, info } = await sharp(pages[0]).greyscale().raw().toBuffer({ resolveWithObject: true });
  const margin = XA_VAI_PAGE.margin;
  assert.ok(margin >= 118, "lề an toàn ≥ 10 mm ở 300 dpi");
  let dark = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const outside = x < margin - 2 || x >= info.width - margin + 2 || y < margin - 2 || y >= info.height - margin + 2;
      if (outside && data[y * info.width + x] < 200) dark += 1;
    }
  }
  assert.equal(dark, 0, "không có điểm mực nào ngoài lề an toàn");
});

test("0.11.0: trang cuối đủ số dòng tối đa + dòng tổng + ô ký vẫn nằm trong lề dưới", async () => {
  const job = normalizeJob(sheetJob({}, { productName: "Vải thử dòng tên", items: items(XA_VAI_ROWS_PER_PAGE) })).job;
  const [page] = await renderXaVaiSheetPages(job);
  const { data, info } = await sharp(page).greyscale().raw().toBuffer({ resolveWithObject: true });
  let lastDark = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) if (data[y * info.width + x] < 200) { lastDark = y; break; }
  }
  assert.ok(lastDark > info.height / 2, "có nội dung tới nửa dưới trang");
  assert.ok(lastDark < info.height - XA_VAI_PAGE.margin + 2, `điểm mực thấp nhất y=${lastDark} phải trên lề dưới`);
});

// ---------- Đường in ----------

const noSleep = async () => {};
const silentLogger = { info() {}, warn() {}, error() {} };
const fetchFailed = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
const leaseLost = () => Object.assign(new Error("Không thể hoàn tất lệnh"), { code: "LEASE_LOST", transient: false });

function fakeQueue(script = {}) {
  const calls = [];
  const queue = {};
  for (const method of ["progress", "complete", "fail", "requeue"]) {
    const outcomes = [...(script[method] || [])];
    queue[method] = async (...args) => {
      calls.push({ method, args });
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return { ok: true };
    };
  }
  queue.calls = calls;
  queue.count = (method, stage) => calls.filter((call) => call.method === method && (!stage || call.args[1] === stage)).length;
  return queue;
}

function memoryJournal() {
  const entries = {};
  return {
    entries,
    get: (jobId) => entries[jobId] ?? null,
    record: (jobId, fields) => { entries[jobId] = { ...entries[jobId], ...fields, updatedAt: new Date().toISOString() }; },
    remove: (jobId) => { delete entries[jobId]; }
  };
}

function fakePrinter() {
  const printer = {
    raw: 0,
    bitmap: [],
    queryPrinter: async () => ({ ok: true, blocked: false }),
    sendRaw: async () => { printer.raw += 1; return { ok: true, jobId: 21 }; },
    sendBitmapPages: async (config, pages, copies, jobId) => { printer.bitmap.push({ pages, copies, jobId }); return { ok: true, jobId: 33 }; },
    waitForSpooler: async () => ({ ok: true, confirmed: true, targetPagesPrinted: 4 })
  };
  return printer;
}

const fakeSheetRender = async (job) => {
  assert.equal(job.type, "xa_vai_sheet");
  return [Buffer.from("PNG-1"), Buffer.from("PNG-2")];
};

function run(queue, { printer = fakePrinter(), journal = memoryJournal(), input = sheetJob(), printerKind = "a4" } = {}) {
  return processClaimedJob(input, {
    config: { tempDir: os.tmpdir(), printerKind }, queue, logger: silentLogger, printer, render: fakeSheetRender, journal, wait: noSleep
  }).then((outcome) => ({ outcome, printer, journal }));
}

test("0.11.0: lệnh phiếu đi đường bitmap (PNG từng trang), không gửi TSPL; báo sending có số trang", async () => {
  const queue = fakeQueue();
  const { outcome, printer, journal } = await run(queue);
  assert.equal(outcome.ok, true);
  assert.equal(printer.raw, 0, "không đẩy byte TSPL ra máy laser");
  assert.equal(printer.bitmap.length, 1);
  assert.equal(printer.bitmap[0].pages.length, 2);
  assert.equal(printer.bitmap[0].copies, 2, "copies = số bản của cả phiếu");
  assert.equal(printer.bitmap[0].jobId, "job-xv-0001");
  const sending = queue.calls.find((call) => call.method === "progress" && call.args[1] === "sending");
  assert.deepEqual(sending.args[2], { pages: 2, bytes: 10 });
  const result = queue.calls.find((call) => call.method === "complete").args[1];
  assert.equal(result.pages, 2);
  assert.equal(result.copies, 2);
  assert.equal(result.spoolJobId, 33);
  assert.equal(result.spoolConfirmed, true);
  assert.equal(result.templateVersion, 1);
  assert.deepEqual(journal.entries, {}, "báo xong thì xoá sổ tay");
});

test("0.11.0: agent A4 nhận nhầm lệnh tem hoặc agent tem nhận phiếu → từ chối, không gửi gì", async () => {
  const queueA4 = fakeQueue();
  const a4 = await run(queueA4, { input: skuJob() });
  assert.equal(a4.outcome.ok, false);
  assert.equal(a4.printer.raw + a4.printer.bitmap.length, 0);
  assert.equal(queueA4.calls.find((call) => call.method === "fail").args[1].code, "INVALID_JOB");
  const queueLabel = fakeQueue();
  const label = await run(queueLabel, { printerKind: "label" });
  assert.equal(label.outcome.ok, false);
  assert.equal(label.printer.raw + label.printer.bitmap.length, 0);
  assert.equal(queueLabel.count("fail"), 1);
});

test("0.11.0: mất mạng TRƯỚC khi gửi xuống máy in → trả về hàng đợi, không báo lỗi, chưa in", async () => {
  const queue = fakeQueue({ progress: [{ ok: true }, fetchFailed()] });
  const { outcome, printer, journal } = await run(queue);
  assert.equal(outcome.requeued, true);
  assert.equal(printer.bitmap.length, 0);
  assert.equal(queue.count("requeue"), 1);
  assert.equal(queue.count("fail"), 0);
  assert.deepEqual(journal.entries, {});
});

test("0.11.0: đã gửi xuống máy in rồi mất kết nối → lần nhận lại KHÔNG in lại phiếu", async () => {
  // Gửi xong nhưng hàng đợi từ chối báo hoàn tất → sổ tay giữ "printed"; nhận lại chỉ báo hoàn tất.
  const journal = memoryJournal();
  const first = await run(fakeQueue({ complete: [leaseLost()] }), { journal });
  assert.equal(first.printer.bitmap.length, 1);
  assert.equal(journal.get("job-xv-0001").stage, "printed");
  const queue = fakeQueue();
  const again = await run(queue, { journal });
  assert.equal(again.printer.bitmap.length, 0, "không gửi lại");
  assert.equal(again.outcome.recovered, true);
  assert.equal(queue.count("complete"), 1);

  // Chết giữa lúc gửi (sổ tay dừng ở "sending") → báo SENT_UNCONFIRMED, không in lại.
  const midJournal = memoryJournal();
  midJournal.record("job-xv-0001", { stage: "sending", copies: 2 });
  const midQueue = fakeQueue();
  const mid = await run(midQueue, { journal: midJournal });
  assert.equal(mid.printer.bitmap.length, 0);
  assert.equal(midQueue.calls.find((call) => call.method === "fail").args[1].code, "SENT_UNCONFIRMED");
});

test("0.11.0: gửi trang lỗi sau khi đã tới spooler → báo lỗi, không trả về hàng đợi", async () => {
  const printer = fakePrinter();
  printer.sendBitmapPages = async () => { throw fetchFailed(); };
  const queue = fakeQueue();
  const { outcome } = await run(queue, { printer });
  assert.equal(outcome.ok, false);
  assert.equal(queue.count("requeue"), 0, "đã gửi thì không tự in lại");
  assert.equal(queue.count("fail"), 1);
});

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");

test("0.11.0: print-bitmap.ps1 thuần ASCII và nằm trong danh sách trắng của host.ps1", () => {
  const script = fs.readFileSync(path.join(ROOT, "powershell", "print-bitmap.ps1"));
  assert.ok(script.every((byte) => byte < 0x80), "print-bitmap.ps1 phải thuần ASCII");
  const host = fs.readFileSync(path.join(ROOT, "powershell", "host.ps1"), "utf8");
  const allowed = host.match(/^\$allowed = @\((.*)\)\r?$/m);
  assert.ok(allowed, "có dòng $allowed");
  assert.deepEqual(allowed[1].split(",").map((name) => name.trim().replace(/'/g, "")), ["printer-status.ps1", "raw-print.ps1", "measure-text.ps1", "print-bitmap.ps1"]);
});

test("0.11.0: print-bitmap.ps1 chạy thật — máy in không tồn tại thì trả JSON lỗi PRINTER_INVALID, không in gì", { skip: process.platform !== "win32" }, async () => {
  const { execFile } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xv-ps-"));
  const png = path.join(dir, "p1.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } }).png().toFile(png);
  const stdout = await new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "powershell", "print-bitmap.ps1"),
    "-Printer", "KHONG-CO-MAY-IN-NAY", "-Files", png, "-Copies", "1", "-DocName", "PrintSKU test"], { windowsHide: true, timeout: 60000 }, (error, out) => resolve(out)));
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, false);
  assert.equal(result.code, "PRINTER_INVALID");
  const missing = await new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(ROOT, "powershell", "print-bitmap.ps1"),
    "-Printer", "KHONG-CO-MAY-IN-NAY", "-Files", path.join(dir, "khong-co.png")], { windowsHide: true, timeout: 60000 }, (error, out) => resolve(out)));
  assert.equal(JSON.parse(missing.trim()).code, "FILE_MISSING");
});

test("0.11.0: sendBitmapPages qua PowerShell thường trực — đúng tham số, xoá tệp tạm, KHÔNG gọi lại khi host chết giữa chừng", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "xv-send-"));
  const config = { tempDir, rootDir: tempDir, printerName: "Microsoft Print to PDF" };
  const requests = [];
  setPowerShellHost({
    runScript: async (script, args, options) => {
      requests.push({ script, args, options });
      for (const file of args.Files.split("|")) assert.ok(fs.existsSync(file), "tệp PNG có mặt lúc in");
      return '{"ok":true,"jobId":12,"pages":2,"copies":3}\r\n';
    }
  });
  try {
    const result = await sendBitmapPages(config, [Buffer.from("A"), Buffer.from("B")], 3, "job/xv:1");
    assert.equal(result.jobId, 12);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].script, "print-bitmap.ps1");
    assert.equal(requests[0].args.Printer, "Microsoft Print to PDF");
    assert.equal(requests[0].args.Copies, 3);
    assert.match(requests[0].args.DocName, /^[\x20-\x7E]+$/, "tên tài liệu chỉ ASCII");
    assert.match(requests[0].args.DocName, /job_xv_1/);
    assert.equal(requests[0].args.Files.split("|").length, 2);
    assert.equal(fs.readdirSync(tempDir).length, 0, "tệp tạm đã xoá");

    let calls = 0;
    const died = new PowerShellHostError("PowerShell dừng đột ngột", { requestStarted: true });
    setPowerShellHost({ runScript: async () => { calls += 1; throw died; } });
    await assert.rejects(sendBitmapPages(config, [Buffer.from("A")], 1, "job-xv-2"), (error) => error === died);
    assert.equal(calls, 1);
    assert.equal(fs.readdirSync(tempDir).length, 0);

    setPowerShellHost({ runScript: async () => '{"ok":false,"message":"Máy in không có khổ A4"}' });
    await assert.rejects(sendBitmapPages(config, [Buffer.from("A")], 1, "job-xv-3"), /khổ A4/);
  } finally {
    setPowerShellHost(null);
  }
});
