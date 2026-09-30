import { normalizeJob } from "./job-validator.mjs";
import { CAPABILITIES } from "./templates/index.mjs";
import { queryPrinter, sendRaw, waitForSpooler } from "./printer.mjs";
import { renderJobTspl } from "./render.mjs";
import { measureTextWidths } from "./text-metrics.mjs";
import { isTransientNetworkError } from "./network-retry.mjs";
import { createSentJournal } from "./sent-journal.mjs";

export const AGENT_VERSION = "0.8.3";

// Báo "hoàn tất" SAU khi tem đã ra giấy thì không được bỏ cuộc vì mạng: thử
// lại giãn dần tới 30 giây/lần, khoảng 10 phút. Quá nữa thì để sổ tay lo — hết
// lease lệnh quay về hàng đợi, lần nhận lại chỉ báo hoàn tất chứ không in lại.
const REPORT_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000];
const REPORT_MAX_ATTEMPTS = 25;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function publicState(config, printer) {
  return {
    version: AGENT_VERSION,
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

async function reportCompleted(job, result, { queue, journal, logger, signal, sleep }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await queue.complete(job.id, result);
      journal.remove(job.id);
      return true;
    } catch (error) {
      if (!isTransientNetworkError(error)) {
        // LEASE_LOST ngay sau một lần mạng chập chờn thường là lần gọi trước đã
        // hoàn tất nhưng mất phản hồi. Giữ sổ tay: nếu thật ra lệnh bị trả về
        // hàng đợi thì lần nhận lại sẽ chỉ báo hoàn tất, không in lần hai.
        logger.warn(`Lệnh ${job.id}: tem đã in nhưng hàng đợi từ chối báo hoàn tất (${error.message}); giữ sổ tay để không in lại`);
        return false;
      }
      if (signal?.aborted || attempt >= REPORT_MAX_ATTEMPTS) {
        logger.error(`Lệnh ${job.id}: tem đã in, chưa báo hoàn tất được sau ${attempt} lần (${error.message}); giữ sổ tay để không in lại`);
        return false;
      }
      const delayMs = REPORT_RETRY_DELAYS_MS[Math.min(attempt - 1, REPORT_RETRY_DELAYS_MS.length - 1)];
      logger.warn(`Lệnh ${job.id}: tem đã in, chưa báo hoàn tất được (${error.message}); thử lại sau ${delayMs / 1000}s`);
      await sleep(delayMs);
    }
  }
}

async function reportFailed(job, details, { queue, logger }) {
  return queue.fail(job.id, details).then(
    () => true,
    (reportError) => {
      logger.error("Không báo lỗi được về queue", reportError.message);
      return false;
    }
  );
}

// Lệnh đã từng được gửi xuống máy in (sổ tay còn ghi) mà nay lại được nhận:
// tuyệt đối không in lại, chỉ báo nốt kết quả còn dang dở.
async function settleFromJournal(job, entry, context) {
  const { journal, logger } = context;
  if (entry.stage === "printed" && entry.result) {
    logger.warn(`Lệnh ${job.id} đã in xong lúc ${entry.updatedAt} nhưng chưa báo được; chỉ báo hoàn tất, không in lại`);
    const result = { ...entry.result, recoveredFromJournal: true };
    const reported = await reportCompleted(job, result, context);
    return { ok: true, recovered: true, result, reported };
  }
  const details = entry.stage === "failed" && entry.error
    ? entry.error
    : {
        code: "SENT_UNCONFIRMED",
        message: "Lệnh đã được gửi xuống máy in nhưng agent mất kết nối trước khi xác nhận. Kiểm tra tem ở máy in trước khi in lại."
      };
  logger.warn(`Lệnh ${job.id} đã gửi xuống máy in trước đó (${entry.stage}); không in lại, báo lỗi để người vận hành kiểm tra`);
  if (await reportFailed(job, details, context)) journal.remove(job.id);
  return { ok: false, recovered: true, error: details };
}

export async function processClaimedJob(input, dependencies) {
  const { config, queue, logger, signal } = dependencies;
  // printer/render/wait chỉ thay trong test, để không phải dựng Windows Spooler thật.
  const printer = { queryPrinter, sendRaw, waitForSpooler, ...dependencies.printer };
  const render = dependencies.render ?? renderJobTspl;
  const journal = dependencies.journal ?? createSentJournal(config.tempDir, { logger });
  const context = { queue, journal, logger, signal, sleep: dependencies.wait ?? wait };
  const validation = normalizeJob(input);
  if (!validation.ok) {
    await queue.fail(String(input?.id || "unknown"), { code: "INVALID_JOB", message: validation.errors.join("; ") });
    return { ok: false, errors: validation.errors };
  }
  const job = validation.job;
  logger.info(`Nhận lệnh ${job.id}: ${job.type}, ${job.copies} tem`);
  const recorded = journal.get(job.id);
  if (recorded) return settleFromJournal(job, recorded, context);

  // Từ lúc bắt đầu gửi byte xuống spooler, tem có thể đã ra giấy: lỗi mạng sau
  // mốc này không bao giờ được biến thành "in lại". Bản 0.8.0 báo failed ở đây
  // nên người dùng bấm in lại và ra tem trùng.
  let sent = false;
  let result;
  try {
    const before = await printer.queryPrinter(config);
    if (!before.ok || before.blocked) {
      await queue.requeue(job.id, { code: before.code || "PRINTER_BLOCKED", message: before.message || "Máy in chưa sẵn sàng" });
      logger.warn(`Hoãn ${job.id}: ${before.message || before.code}`);
      return { ok: false, requeued: true };
    }
    await queue.progress(job.id, "rendering");
    const tspl = await render(
      job,
      config,
      // Tiến độ dựng tem chỉ để hiển thị; mốc "sending" bên dưới mới là chốt chặn.
      (rendered, total) => queue
        .progress(job.id, "rendering", { rendered, total }, { retry: false })
        .catch((error) => logger.warn(`Lệnh ${job.id}: không báo được tiến độ dựng tem (${error.message})`)),
      { measureText: measureTextWidths, logger }
    );
    // Chốt chặn cuối trước khi gửi: phải báo được "sending" để chắc agent còn
    // giữ lệnh. Lỗi mạng ở đây trả lệnh về hàng đợi — chưa có tem nào ra giấy.
    await queue.progress(job.id, "sending", { bytes: tspl.length });
    journal.record(job.id, { stage: "sending", copies: job.copies, bytes: tspl.length });
    sent = true;
    const spool = await printer.sendRaw(config, tspl, job.id);
    journal.record(job.id, { stage: "sent", spoolJobId: spool.jobId ?? null });
    await queue
      .progress(job.id, "spooling", { spoolJobId: spool.jobId ?? null }, { retry: false })
      .catch((error) => logger.warn(`Lệnh ${job.id}: không báo được trạng thái đang in (${error.message})`));
    let pagesPrinted = null;
    let spoolConfirmed = false;
    if (spool.jobId) {
      const final = await printer.waitForSpooler(config, spool.jobId, {
        timeoutMs: config.spoolTimeoutMs,
        stallMs: config.spoolStallMs,
        appearMs: config.spoolAppearMs,
        requireConfirm: config.spoolRequireConfirm,
        onHeartbeat: (pages) => {
          queue
            .progress(job.id, "spooling", { spoolJobId: spool.jobId, pagesPrinted: pages, waiting: true }, { retry: false })
            .catch(() => { /* mất một nhịp giữ lease không được phép làm hỏng lệnh in */ });
        },
        onProblem: (error) => {
          logger.warn(`Lệnh ${job.id}: ${error.message} — vẫn giữ job, chờ máy in sống lại`);
        },
        onProgress: (pages) => {
          pagesPrinted = pages;
          logger.info(`Lệnh ${job.id}: máy in đã in ${pages} trang`);
          queue
            .progress(job.id, "spooling", { spoolJobId: spool.jobId, pagesPrinted: pages }, { retry: false })
            .catch(() => { /* mất một nhịp tiến độ không được phép làm hỏng lệnh in */ });
        }
      });
      if (final?.targetPagesPrinted != null) pagesPrinted = Number(final.targetPagesPrinted);
      spoolConfirmed = Boolean(final?.confirmed);
      if (!spoolConfirmed) {
        logger.warn(`Lệnh ${job.id}: spooler không để lộ job nên chưa xác nhận được tem đã ra giấy`);
      }
    }
    const after = await printer.queryPrinter(config);
    if (!after.ok || after.blocked) {
      throw Object.assign(new Error(after.message || "Máy in báo lỗi sau khi nhận dữ liệu"), { code: after.code || "PRINTER_POSTCHECK_FAILED" });
    }
    result = { copies: job.copies, bytes: tspl.length, spoolJobId: spool.jobId ?? null, pagesPrinted, spoolConfirmed, templateVersion: job.templateVersion };
  } catch (error) {
    const details = { code: error.code || "PRINT_FAILED", message: String(error.message || error).slice(0, 200) };
    // Số trang đã in được là manh mối duy nhất để biết in lại từ tem nào.
    if (error.pagesPrinted != null) details.pagesPrinted = error.pagesPrinted;
    if (!sent && isTransientNetworkError(error)) {
      // Chưa gửi byte nào xuống máy in: trả về hàng đợi để agent tự in khi mạng
      // ổn lại, người dùng không phải bấm in lại. Không trả được thì hết lease
      // backend cũng tự trả lệnh về hàng đợi.
      const reason = { code: "NETWORK_UNSTABLE", message: `Mạng chập chờn trước khi gửi xuống máy in, agent sẽ tự in lại: ${details.message}`.slice(0, 200) };
      await queue.requeue(job.id, reason).catch((requeueError) => logger.warn(`Lệnh ${job.id}: chưa trả được về hàng đợi (${requeueError.message}); hết lease hàng đợi sẽ tự trả`));
      logger.warn(`Hoãn ${job.id} vì lỗi mạng trước khi in: ${details.message}`);
      return { ok: false, requeued: true, error: details };
    }
    if (sent) journal.record(job.id, { stage: "failed", error: details });
    if (await reportFailed(job, details, context) && sent) journal.remove(job.id);
    logger.error(`Lệnh ${job.id} thất bại: ${details.message}`);
    return { ok: false, error: details };
  }
  journal.record(job.id, { stage: "printed", result });
  const reported = await reportCompleted(job, result, context);
  logger.info(`Hoàn tất ${job.id}: ${job.copies} tem, ${result.bytes} byte${reported ? "" : " (chưa báo được về hàng đợi)"}`);
  return { ok: true, result, reported };
}

export async function runService(config, queue, logger, signal, lock) {
  logger.info(`Agent ${config.agentId} v${AGENT_VERSION} khởi động; hỗ trợ ${CAPABILITIES.join(", ")}`);
  const journal = createSentJournal(config.tempDir, { logger });
  while (!signal?.aborted) {
    try {
      lock?.touch?.();
      const printer = await queryPrinter(config);
      const state = publicState(config, printer);
      const claim = await queue.claim(state);
      if (claim?.job) await processClaimedJob(claim.job, { config, queue, logger, signal, journal });
      else await wait(config.pollIntervalMs);
    } catch (error) {
      logger.error("Lỗi vòng quét", String(error.message || error).slice(0, 200));
      await wait(Math.max(config.pollIntervalMs, 3000));
    }
  }
  logger.info("Agent đã dừng an toàn");
}
