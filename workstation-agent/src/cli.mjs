import fs from "node:fs";
import path from "node:path";
import { loadConfig, assertServiceConfig, ROOT_DIR } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { normalizeJob } from "./job-validator.mjs";
import { QueueClient } from "./queue-client.mjs";
import { SupabaseQueueClient } from "./supabase-queue-client.mjs";
import { queryPrinter } from "./printer.mjs";
import { renderJobTspl, writePreview } from "./render.mjs";
import { renderXaVaiSheetPages } from "./templates/xa-vai-sheet.mjs";
import { runService } from "./agent.mjs";
import { acquireSingleInstance } from "./single-instance.mjs";
import { installCrashLogging } from "./process-guard.mjs";
import { measureTextWidths } from "./text-metrics.mjs";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

// 0.11.0: phiếu xả vải giả — 27 Group UID (2 trang), có dòng thiếu mét hệ thống. Dữ liệu giả chuẩn.
// CONTRACT V3: mặc định Mã hàng CWSH02, ba SKU (900000001…003) trên một phiếu, xả một ngày (không có dòng tên);
// "--sample dai": Mã hàng 14 ký tự (kiểm thu cỡ), một SKU có tên dài, xả hai ngày, IN LẠI.
function sampleXaVai(common) {
  const large = argument("--sample") === "dai";
  const start = Date.parse(large ? "2026-11-03T09:15:00Z" : "2026-11-04T01:15:00Z");
  const items = Array.from({ length: 27 }, (_, index) => {
    // CONTRACT V2: số đo là mm nguyên (systemMm, actualMm); dòng 1 là vectơ 16763 g → 60758 mm; dòng 2 có Lot 40 ký tự.
    const systemMm = index === 0 ? 60758 : index % 9 === 4 ? null : Math.round((40 + ((index * 37) % 25) + 0.25 * (index % 4)) * 1000 + index * 7);
    const actualMm = Math.round((systemMm ?? 50000) * (0.955 + ((index * 13) % 7) / 200));
    return {
      groupUid: `1028260000000${String(index + 1).padStart(3, "0")}`,
      sku: large ? "900000001" : `90000000${1 + Math.floor(index / 10)}`,
      lot: index === 1 ? "LOT-TEST-RAT-DAI-0123456789-ABCDEFGHIJKL" : `LOT-TEST-${String(Math.floor(index / 6) + 1).padStart(2, "0")}`,
      roll: String(index + 1),
      systemMm,
      actualMm,
      measuredAt: new Date(start + index * (large ? 60 : 7) * 60000).toISOString()
    };
  });
  return {
    ...common,
    copies: 1,
    requestedBy: "xa-vai",
    payload: {
      // "--item-code <mã>" thay Mã hàng (ví dụ mã 22–40 ký tự để xem dòng "Mã hàng: <đầy đủ>" dưới biển).
      itemCode: argument("--item-code") || (large ? "CWSH02-TEST-AB" : "CWSH02"),
      productName: large ? "Vải Test Jersey Cotton Spandex Thun Lạnh Co Giãn Bốn Chiều/Cotton 95% Spandex 5%/155gsm, 178cm/Xanh Rêu Đậm Pha Ánh Kim Loại/g" : null,
      printedAt: "2026-11-04T09:45:00.000000+00:00",
      reprint: large,
      items
    }
  };
}

function sample(type) {
  const common = { id: `preview-${type}`, nonce: `preview-${Date.now()}`, type, copies: 1, templateVersion: 1, requestedBy: "test" };
  if (type === "xa_vai_sheet") return sampleXaVai(common);
  if (type === "group_uid") return { ...common, payload: { groupUid: "A40000258795", sku: "204900073", productName: "Vải Rayon Tropical Firal" } };
  if (type === "location") return { ...common, payload: { items: [{ code: "Z99-T01-001-01-01-01", name: "Khu vực kiểm thử", copies: 1 }] } };
  return { ...common, payload: { sku: "204900073", productName: "Sản phẩm kiểm thử tem SKU", quantity: "12", printedDate: "08-09-26" } };
}

function loadJob() {
  const file = argument("--file");
  return file ? JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) : sample(argument("--type", "sku"));
}

const command = process.argv[2] || "help";
let config;
try {
  config = loadConfig({ envFile: argument("--env") || undefined });
} catch (error) {
  // 0.11.0 (review R2-BC1): lỗi cấu hình (ví dụ PRINTER_KIND lạ) phải nằm trong agent.log — Task Scheduler bỏ stderr nên
  // trước đây agent chết im lặng. Chưa có config nên ghi vào thư mục log mặc định ROOT_DIR/logs (createLogger tự tạo).
  const message = `Không khởi động agent — cấu hình sai: ${error?.message ?? error}`;
  try {
    createLogger(path.join(ROOT_DIR, "logs")).error(message);   // createLogger in cả ra stderr
  } catch {
    console.error(message);
  }
  process.exit(1);
}
const logger = createLogger(config.logDir);

const previewing = command === "preview" || command === "dry-run";
const previewJob = previewing ? loadJob() : null;

if (previewing && String(previewJob?.type ?? "").toLowerCase() === "xa_vai_sheet") {
  // 0.11.0: phiếu A4 — ghi PNG từng trang (đúng ảnh sẽ gửi máy in), không có TSPL.
  const checked = normalizeJob(previewJob);
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const base = (argument("--out") || path.join(config.previewDir, `xa-vai-${Date.now()}`)).replace(/\.png$/i, "");
  const pages = await renderXaVaiSheetPages(checked.job);
  pages.forEach((page, index) => {
    const file = `${base}-p${index + 1}.png`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, page);
    console.log(`Preview trang ${index + 1}/${pages.length}: ${file}`);
  });
  if (command === "dry-run") console.log("Phiếu A4 không có TSPL — chưa gửi máy in");
} else if (previewing) {
  const checked = normalizeJob(previewJob);
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const base = argument("--out") || path.join(config.previewDir, `${checked.job.type}-${Date.now()}`);
  const png = base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
  // Dung do chu that (GDI+) khi xem preview de thay dung ket qua se in ra thuc
  // te; loi do chu (vd may khong co PowerShell) thi tu lui ve dem ky tu cu,
  // khong lam hong lenh preview.
  await writePreview(checked.job, png, { config, measureText: measureTextWidths, logger });
  console.log(`Preview: ${png}`);
  if (command === "dry-run") {
    const tspl = await renderJobTspl(checked.job, config, null, { measureText: measureTextWidths, logger });
    const tsplFile = png.replace(/\.png$/i, ".tspl");
    fs.writeFileSync(tsplFile, tspl);
    console.log(`TSPL: ${tsplFile} (${tspl.length} byte) — chưa gửi máy in`);
  }
} else if (command === "validate") {
  const checked = normalizeJob(loadJob());
  console.log(JSON.stringify(checked, null, 2));
  if (!checked.ok) process.exitCode = 2;
} else if (command === "diagnose") {
  const printer = await queryPrinter(config);
  const queueConfigured = config.queueProvider === "supabase"
    ? Boolean(config.supabaseUrl && config.supabasePublishableKey && config.agentToken)
    : Boolean(config.queueUrl && config.agentToken);
  console.log(JSON.stringify({ ok: printer.ok, agentId: config.agentId, printer, queueProvider: config.queueProvider, queueConfigured }, null, 2));
} else if (command === "service") {
  const controller = new AbortController();
  // 0.8.9: lỗi chết người, mã thoát và tín hiệu dừng đều vào agent.log (stderr bị Task Scheduler bỏ).
  installCrashLogging({ logger, onSignal: () => controller.abort() });
  assertServiceConfig(config);
  let releaseLock = null;
  try {
    releaseLock = acquireSingleInstance(config.tempDir, { logger });
  } catch (error) {
    // Task Scheduler thử chạy lại mỗi 5 phút; bản đang chạy giữ khóa thì bản mới chỉ ghi lại rồi thoát.
    logger.warn(`Không khởi động agent: ${error.message}`);
    process.exitCode = 1;
  }
  if (releaseLock) {
    try {
      const queue = config.queueProvider === "supabase" ? new SupabaseQueueClient(config, { logger }) : new QueueClient(config);
      await runService(config, queue, logger, controller.signal, releaseLock);
    } finally {
      releaseLock();
    }
  }
} else {
  console.log("Dùng: preview | dry-run | validate | diagnose | service [--type sku|group_uid|xa_vai_sheet] [--sample dai] [--item-code MA] [--file job.json] [--out path] [--env path]");
}
