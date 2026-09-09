import { normalizeJob } from "./job-validator.mjs";
import { CAPABILITIES } from "./templates/index.mjs";
import { queryPrinter, sendRaw, waitForSpooler } from "./printer.mjs";
import { renderJobTspl } from "./render.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicState(config, printer) {
  return {
    version: "0.3.1",
    capabilities: CAPABILITIES,
    printer: {
      name: config.printerName,
      ok: Boolean(printer.ok),
      blocked: Boolean(printer.blocked),
      code: printer.code || "UNKNOWN",
      message: printer.message || ""
    }
  };
}

export async function processClaimedJob(input, dependencies) {
  const { config, queue, logger } = dependencies;
  const validation = normalizeJob(input);
  if (!validation.ok) {
    await queue.fail(String(input?.id || "unknown"), { code: "INVALID_JOB", message: validation.errors.join("; ") });
    return { ok: false, errors: validation.errors };
  }
  const job = validation.job;
  logger.info(`Nhận lệnh ${job.id}: ${job.type}, ${job.copies} tem`);
  try {
    const before = await queryPrinter(config);
    if (!before.ok || before.blocked) {
      await queue.requeue(job.id, { code: before.code || "PRINTER_BLOCKED", message: before.message || "Máy in chưa sẵn sàng" });
      logger.warn(`Hoãn ${job.id}: ${before.message || before.code}`);
      return { ok: false, requeued: true };
    }
    await queue.progress(job.id, "rendering");
    const tspl = await renderJobTspl(job, config, (rendered, total) =>
      queue.progress(job.id, "rendering", { rendered, total })
    );
    await queue.progress(job.id, "sending", { bytes: tspl.length });
    const spool = await sendRaw(config, tspl, job.id);
    await queue.progress(job.id, "spooling", { spoolJobId: spool.jobId ?? null });
    if (spool.jobId) await waitForSpooler(config, spool.jobId);
    const after = await queryPrinter(config);
    if (!after.ok || after.blocked) {
      throw Object.assign(new Error(after.message || "Máy in báo lỗi sau khi nhận dữ liệu"), { code: after.code || "PRINTER_POSTCHECK_FAILED" });
    }
    const result = { copies: job.copies, bytes: tspl.length, spoolJobId: spool.jobId ?? null, templateVersion: job.templateVersion };
    await queue.complete(job.id, result);
    logger.info(`Hoàn tất ${job.id}: ${job.copies} tem, ${tspl.length} byte`);
    return { ok: true, result };
  } catch (error) {
    const details = { code: error.code || "PRINT_FAILED", message: String(error.message || error).slice(0, 200) };
    await queue.fail(job.id, details).catch((reportError) => logger.error("Không báo lỗi được về queue", reportError.message));
    logger.error(`Lệnh ${job.id} thất bại: ${details.message}`);
    return { ok: false, error: details };
  }
}

export async function runService(config, queue, logger, signal) {
  logger.info(`Agent ${config.agentId} v0.3.1 khởi động; hỗ trợ ${CAPABILITIES.join(", ")}`);
  while (!signal?.aborted) {
    try {
      const printer = await queryPrinter(config);
      const state = publicState(config, printer);
      const claim = await queue.claim(state);
      if (claim?.job) await processClaimedJob(claim.job, { config, queue, logger });
      else await wait(config.pollIntervalMs);
    } catch (error) {
      logger.error("Lỗi vòng quét", String(error.message || error).slice(0, 200));
      await wait(Math.max(config.pollIntervalMs, 3000));
    }
  }
  logger.info("Agent đã dừng an toàn");
}
