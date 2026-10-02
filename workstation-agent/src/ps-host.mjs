import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Tiến trình PowerShell chạy thường trực — agent 0.8.8 (tăng tốc in).
 *
 * Mỗi lần mở powershell.exe mới để kiểm tra máy in / đo chữ / gửi dữ liệu mất 0,4–1,9 giây chỉ để
 * khởi động (đo 02/10/2026: printer-status.ps1 ~1,7s, raw-print.ps1 ~0,45s khi mở mới; ~35ms và ~8ms
 * trong một tiến trình đã mở sẵn) và mỗi lệnh in mở 4–5 lần. Module này giữ MỘT tiến trình chạy
 * powershell/host.ps1, gửi yêu cầu JSON từng dòng qua stdin, nhận kết quả JSON từng dòng qua stdout.
 *
 * AN TOÀN (đường in là đường quan trọng nhất của agent):
 *  - Tuần tự: tại một thời điểm chỉ một yêu cầu chạy trong tiến trình (hàng đợi trong Node).
 *  - Mọi yêu cầu có hạn chót; quá hạn thì GIẾT tiến trình (không để treo vĩnh viễn) và lần sau mở lại.
 *  - Lỗi của host được phân loại bằng `error.requestStarted`: false = yêu cầu CHƯA tới tiến trình
 *    (không mở được, đang tạm tắt) nên gọi lại bằng cách cũ (mở PowerShell mới) là an toàn; true =
 *    đã gửi đi, có thể đã chạy một phần. Yêu cầu GỬI DỮ LIỆU XUỐNG MÁY IN không bao giờ được gọi lại
 *    khi requestStarted = true: tiến trình chết lúc đang WritePrinter thì không biết tem đã ra chưa,
 *    in lại là ra tem trùng (cùng nguyên tắc với sổ tay sent-jobs). Việc đó do printer.mjs bảo đảm.
 *  - Chết bất thường hoặc không khởi động được nhiều lần liền thì tạm tắt `cooldownMs`; trong lúc
 *    đó mọi nơi dùng đường cũ. Tiến trình được làm mới sau `maxRequests` yêu cầu (chống rò rỉ).
 */
const READY = "@@READY@@";
const REPLY = "@@R@@";

export class PowerShellHostError extends Error {
  constructor(message, { requestStarted = false, timeout = false } = {}) {
    super(message);
    this.name = "PowerShellHostError";
    this.requestStarted = requestStarted;
    this.timeout = timeout;
  }
}

// Mọi ký tự ngoài ASCII được escape \uXXXX: hai chiều chỉ chứa ASCII nên không phụ thuộc mã hoá console.
const asciiJson = (value) => JSON.stringify(value).replace(/[\u0080-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);

// Một yêu cầu bị kết thúc vì tiến trình chết/giết: đã gửi đi nên không biết chạy tới đâu.
const diedError = (detail) => new PowerShellHostError(`PowerShell dừng đột ngột${detail ? `: ${detail}` : ""}`, { requestStarted: true });

export function createPowerShellHost({
  rootDir, logger, spawnImpl = spawn, startTimeoutMs = 20000, maxRequests = 1500,
  maxCrashes = 3, crashWindowMs = 120000, cooldownMs = 300000, now = Date.now
} = {}) {
  const hostScript = path.join(rootDir ?? ".", "powershell", "host.ps1");
  let child = null;
  let starting = null;
  let stopped = false;
  let seq = 0;
  let served = 0;
  let disabledUntil = 0;
  let lastStderr = "";
  let chain = Promise.resolve();
  const pending = new Map();   // id -> { resolve, reject }
  const crashes = [];

  const noteCrash = () => {
    const at = now();
    crashes.push(at);
    while (crashes.length && at - crashes[0] > crashWindowMs) crashes.shift();
    if (crashes.length >= maxCrashes) {
      disabledUntil = at + cooldownMs;
      crashes.length = 0;
      logger?.warn?.(`PowerShell thường trực lỗi ${maxCrashes} lần liền — tạm tắt ${Math.round(cooldownMs / 60000)} phút, dùng cách mở PowerShell mới cho từng việc`);
    }
  };

  const rejectAll = (error) => {
    for (const [id, entry] of pending) { pending.delete(id); entry.reject(error); }
  };

  const onLine = (line, proc, markReady) => {
    if (line === READY) { markReady(); return; }
    if (!line.startsWith(REPLY)) return;           // dòng lạ (cảnh báo của PowerShell...) — bỏ qua
    let reply;
    try { reply = JSON.parse(line.slice(REPLY.length)); } catch { return; }
    const entry = pending.get(String(reply?.id));
    if (!entry) return;                            // trả lời muộn của yêu cầu đã quá hạn
    pending.delete(String(reply.id));
    if (reply.ok) entry.resolve(String(reply.out ?? ""));
    else entry.reject(Object.assign(new PowerShellHostError(String(reply.error || "PowerShell báo lỗi"), { requestStarted: true }), { scriptError: true }));
  };

  const launch = () => new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hostScript], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new PowerShellHostError(`Không mở được PowerShell thường trực: ${String(error?.message || error).slice(0, 160)}`));
      return;
    }
    let ready = false;
    let buffer = "";
    const startTimer = setTimeout(() => {
      if (ready) return;
      reject(new PowerShellHostError(`PowerShell thường trực chưa sẵn sàng sau ${Math.round(startTimeoutMs / 1000)}s`));
      try { proc.kill(); } catch { /* đã chết */ }
    }, startTimeoutMs);
    const markReady = () => {
      ready = true;
      clearTimeout(startTimer);
      if (stopped) { try { proc.kill(); } catch { /* đã chết */ } reject(new PowerShellHostError("PowerShell thường trực đã dừng")); return; }
      child = proc;
      resolve(proc);
    };

    proc.stdout.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        onLine(line, proc, markReady);
      }
    });
    proc.stderr?.setEncoding?.("utf8");
    proc.stderr?.on("data", (chunk) => { lastStderr = String(chunk).slice(-300); });
    proc.stdin?.on?.("error", () => { /* EPIPE khi tiến trình chết: đã xử lý ở sự kiện exit */ });
    const onEnd = (code) => {
      clearTimeout(startTimer);
      const wasCurrent = child === proc;
      if (wasCurrent) child = null;
      if (!ready) {
        reject(new PowerShellHostError(`PowerShell thường trực thoát trước khi sẵn sàng (mã ${code ?? "?"})${lastStderr ? `: ${lastStderr.trim().slice(0, 120)}` : ""}`));
        return;
      }
      if (!stopped && wasCurrent && !proc.__recycled && !proc.__killedByUs) noteCrash();
      if (wasCurrent) rejectAll(diedError(`mã ${code ?? "?"}`));
    };
    proc.on("exit", onEnd);
    proc.on("error", (error) => {
      if (!ready) { clearTimeout(startTimer); reject(new PowerShellHostError(`Không mở được PowerShell thường trực: ${String(error?.message || error).slice(0, 160)}`)); }
    });
  });

  const killChild = (reason) => {
    const proc = child;
    if (!proc) return;
    proc.__killedByUs = true;
    child = null;
    try { proc.kill(); } catch { /* đã chết */ }
    logger?.info?.(`Đóng PowerShell thường trực (${reason})`);
  };

  const ensureChild = async () => {
    if (child) return child;
    if (!starting) {
      starting = launch().catch((error) => { noteCrash(); throw error; }).finally(() => { starting = null; });
    }
    return starting;
  };

  const execute = async (request, timeoutMs) => {
    if (stopped) throw new PowerShellHostError("PowerShell thường trực đã dừng");
    if (now() < disabledUntil) throw new PowerShellHostError("PowerShell thường trực đang tạm tắt");
    if (child && served >= maxRequests) { child.__recycled = true; killChild(`làm mới sau ${served} yêu cầu`); served = 0; }
    const proc = await ensureChild();
    const id = String(++seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        killChild(`quá ${Math.round(timeoutMs / 1000)}s`);
        reject(new PowerShellHostError(`PowerShell quá ${Math.round(timeoutMs / 1000)}s`, { requestStarted: true, timeout: true }));
      }, timeoutMs);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); served += 1; resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      });
      try {
        proc.stdin.write(`${asciiJson({ id, ...request })}\n`);
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(new PowerShellHostError(`Không ghi được vào PowerShell thường trực: ${String(error?.message || error).slice(0, 120)}`, { requestStarted: true }));
      }
    });
  };

  const enqueue = (request, timeoutMs) => {
    const job = chain.then(() => execute(request, timeoutMs));
    chain = job.catch(() => {});
    return job;
  };

  return {
    /** Chạy một script trong danh sách trắng của host.ps1; trả về stdout của script. */
    runScript: (script, args = {}, { timeoutMs = 20000 } = {}) => enqueue({ script, args }, timeoutMs),
    /** Nạp sẵn module in, System.Drawing và kiểu HasakiRawPrinter (không in gì). */
    init: ({ timeoutMs = 60000 } = {}) => enqueue({ op: "init" }, timeoutMs),
    ping: ({ timeoutMs = 10000 } = {}) => enqueue({ op: "ping" }, timeoutMs),
    stop() {
      stopped = true;
      rejectAll(new PowerShellHostError("PowerShell thường trực đã dừng", { requestStarted: true }));
      killChild("agent dừng");
    },
    get running() { return Boolean(child); },
    get served() { return served; },
    get disabled() { return now() < disabledUntil; }
  };
}

// Tiến trình dùng chung của agent: runService đặt vào, printer.mjs / text-metrics.mjs lấy ra. Không đặt
// (preview, dry-run, test) thì mọi nơi giữ nguyên cách cũ — mở PowerShell mới cho từng việc.
let shared = null;
export const setPowerShellHost = (host) => { shared = host; };
export const getPowerShellHost = () => shared;
