/**
 * Agent 0.8.9 — không còn chết "im lặng", không còn đứng mà không ai biết.
 *
 * Sự cố 06–07/10/2026 trên may-kho-01 (RULES.md): tối 06/10 agent ngừng báo về lúc 20:21 trong khi
 * máy vẫn bật và vẫn đăng nhập; `agent.log` không có dòng nào sau 20:02. Node in lỗi chết người ra
 * stderr, mà Task Scheduler vứt stderr đi, nên không còn dấu vết nào để biết vì sao.
 *
 * - `installCrashLogging`: ghi lỗi không bắt được (kể cả promise bị từ chối không ai bắt), mã thoát
 *   và tín hiệu dừng vào agent.log. Dùng `uncaughtExceptionMonitor` nên KHÔNG đổi cách Node xử lý
 *   lỗi (vẫn thoát mã 1 như trước) — chỉ ghi lại. Logger ghi đồng bộ (appendFileSync) nên dòng log
 *   kịp xuống đĩa trước khi tiến trình chết. Bị diệt từ bên ngoài (Task Manager, Stop-ScheduledTask,
 *   tắt máy) thì không có sự kiện nào chạy: log dừng mà KHÔNG có dòng "Agent thoát" chính là dấu hiệu đó.
 * - `createLoopWatchdog`: vòng quét đứng quá `stallMs` khi KHÔNG in thì agent tự thoát (mã 3) để
 *   Task Scheduler (trigger mỗi 5 phút, install-agent.ps1) chạy lại. Đang in thì bỏ qua: chờ thay
 *   giấy là chờ hợp lệ và đường in đã có giới hạn riêng (SPOOL_STALL_MS, SPOOL_TIMEOUT_MS). Mỗi giờ
 *   ghi một dòng "còn chạy" kèm RAM để lần sau biết agent còn sống tới lúc nào và có rò bộ nhớ không.
 */

export const LOOP_STALL_EXIT_CODE = 3;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

export function describeError(error) {
  if (error instanceof Error) {
    const text = error.stack || `${error.name}: ${error.message}`;
    const cause = error.cause ? ` | nguyên nhân: ${describeError(error.cause)}` : "";
    return `${text.replace(/\s*\r?\n\s*/g, " | ")}${cause}`.slice(0, 1200);
  }
  return String(error).slice(0, 1200);
}

export function installCrashLogging({ logger, proc = process, onSignal } = {}) {
  proc.on("uncaughtExceptionMonitor", (error, origin) => {
    const kind = origin === "unhandledRejection" ? "promise bị từ chối không ai bắt" : "lỗi không bắt được";
    logger.error(`Agent sắp dừng vì ${kind}: ${describeError(error)}`);
  });
  proc.on("exit", (code) => {
    const message = `Agent thoát, mã ${code}`;
    if (code === 0) logger.info(message);
    else logger.warn(message);
  });
  for (const name of SIGNALS) {
    proc.on(name, () => {
      logger.warn(`Nhận tín hiệu ${name} — dừng agent`);
      onSignal?.(name);
    });
  }
}

const megabytes = (bytes) => Math.round(bytes / 1048576);

export function createLoopWatchdog({
  stallMs = 0, checkMs = 30000, statusEveryMs = 3600000,
  getLastProgressAt, isBusy = () => false, onStall, logger,
  now = Date.now, memory = () => process.memoryUsage(), startedAt = now()
} = {}) {
  let lastCheckAt = now();
  let lastStatusAt = startedAt;
  let resumedAt = 0;      // mốc sau khi đồng hồ nhảy (máy ngủ dậy): tính "đứng" từ đây
  let fired = false;
  let timer = null;

  const check = () => {
    const at = now();
    const gap = at - lastCheckAt;
    lastCheckAt = at;
    // Máy ngủ/ngủ đông hay đổi giờ: Date.now() nhảy trong khi vòng quét không có lỗi gì. Không tính
    // khoảng đó là "đứng", cho vòng quét trọn một khoảng stallMs kể từ lúc thức dậy.
    if (checkMs > 0 && gap > Math.max(checkMs * 4, 120000)) {
      resumedAt = at;
      logger?.info?.(`Đồng hồ nhảy ${Math.round(gap / 60000)} phút (máy ngủ hoặc đổi giờ) — tính lại mốc vòng quét`);
    }
    if (statusEveryMs > 0 && at - lastStatusAt >= statusEveryMs) {
      lastStatusAt = at;
      const usage = memory();
      const since = Math.round((at - getLastProgressAt()) / 1000);
      logger?.info?.(`Agent còn chạy: ${((at - startedAt) / 3600000).toFixed(1)} giờ, RAM ${megabytes(usage.rss)} MB (heap ${megabytes(usage.heapUsed)} MB), vòng quét gần nhất ${since}s trước`);
    }
    if (fired || !(stallMs > 0) || isBusy()) return false;
    const idleFor = at - Math.max(getLastProgressAt(), resumedAt);
    if (idleFor <= stallMs) return false;
    fired = true;
    logger?.error?.(`Vòng quét đứng ${Math.round(idleFor / 1000)}s (giới hạn ${Math.round(stallMs / 1000)}s) khi không in — agent tự thoát (mã ${LOOP_STALL_EXIT_CODE}) để Task Scheduler chạy lại`);
    onStall?.(idleFor);
    return true;
  };

  return {
    check,
    start() {
      if (timer || !(checkMs > 0)) return this;
      timer = setInterval(check, checkMs);
      timer.unref?.();
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}
