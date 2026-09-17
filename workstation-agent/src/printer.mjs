import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function queryPrinter(config, jobId = null) {
  const script = path.join(config.rootDir, "powershell", "printer-status.ps1");
  try {
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Printer", config.printerName];
    if (jobId) args.push("-JobId", String(jobId));
    const { stdout } = await execFileAsync("powershell.exe", args, { windowsHide: true, timeout: 20000 });
    return JSON.parse(stdout.trim());
  } catch (error) {
    const output = String(error?.stdout || "").trim();
    if (output) {
      try { return JSON.parse(output); } catch { /* dùng lỗi rút gọn bên dưới */ }
    }
    return { ok: false, blocked: true, code: "STATUS_UNAVAILABLE", message: String(error.message || error).slice(0, 200) };
  }
}

export async function sendRaw(config, buffer, jobId) {
  const safeId = String(jobId).replace(/[^0-9A-Za-z._-]/g, "_");
  const file = path.join(config.tempDir, `${safeId}-${Date.now()}.tspl`);
  fs.writeFileSync(file, buffer);
  const script = path.join(config.rootDir, "powershell", "raw-print.ps1");
  try {
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-File", file, "-Printer", config.printerName], { windowsHide: true, timeout: 45000 }));
    } catch (error) {
      stdout = String(error?.stdout || "");
      if (!stdout.trim()) throw error;
    }
    const result = JSON.parse(stdout.trim());
    if (!result.ok) throw new Error(result.message || "Windows Spooler từ chối lệnh");
    return result;
  } finally {
    try { fs.unlinkSync(file); } catch { /* tệp tạm sẽ được diagnose dọn sau */ }
  }
}

/**
 * Chờ tới khi Windows Spooler thực sự in xong job.
 *
 * Bản cũ coi "không tìm thấy job" là "đã in xong", nên lần quét đầu — chạy ngay
 * sau khi gửi, lúc spooler chưa kịp liệt kê job — đã thoát và báo hoàn tất.
 * Cả lệnh 100 tem cũng "xong" sau 2 giây trong khi giấy chưa chạy.
 *
 * Nay job phải được nhìn thấy ít nhất một lần thì mới được coi là biến mất vì
 * đã in xong; và tiến độ trang phải nhúc nhích, đứng yên quá lâu là lỗi.
 */
export async function waitForSpooler(config, jobId, options = {}) {
  const {
    timeoutMs = 900000,      // trần tuyệt đối cho một lệnh
    appearMs = 20000,        // chờ job hiện ra trong hàng đợi
    stallMs = 120000,        // không in thêm trang nào trong ngần này là kẹt
    pollMs = 1000,
    onProgress,
    __query = queryPrinter   // chỉ dùng cho test, tránh phải dựng cả Windows Spooler
  } = options;

  const started = Date.now();
  let seen = false;
  let lastPages = -1;
  let lastChange = Date.now();

  while (Date.now() - started < timeoutMs) {
    const state = await __query(config, jobId);
    if (!state.ok || state.blocked) {
      throw Object.assign(new Error(state.message || "Spooler báo lỗi"), { code: state.code || "SPOOLER_FAILED" });
    }

    if (state.targetPresent) {
      seen = true;
      const pages = Number(state.targetPagesPrinted || 0);
      if (pages !== lastPages) {
        lastPages = pages;
        lastChange = Date.now();
        onProgress?.(pages, state);
      }
      // Hàng đợi giữ lại bản ghi sau khi in xong thì job không bao giờ tự biến mất.
      if (state.targetRetained) return state;
      if (Date.now() - lastChange > stallMs) {
        throw Object.assign(
          new Error(`Máy in đứng yên ${Math.round(stallMs / 1000)} giây ở trang ${pages}`),
          { code: "PRINTER_STALLED", pagesPrinted: pages }
        );
      }
    } else if (seen) {
      return state;                                   // đã thấy rồi, giờ hết => in xong
    } else if (Date.now() - started > appearMs) {
      // Không bao giờ thấy job: không kết luận được là đã in. Báo lỗi để người
      // vận hành kiểm tra giấy thay vì im lặng coi như thành công.
      throw Object.assign(
        new Error(`Không thấy job ${jobId} trong hàng đợi máy in sau ${Math.round(appearMs / 1000)} giây`),
        { code: "SPOOLER_JOB_MISSING" }
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw Object.assign(
    new Error(`Print job chưa in xong sau ${Math.round(timeoutMs / 60000)} phút (trang đã in: ${lastPages})`),
    { code: "SPOOLER_TIMEOUT", pagesPrinted: lastPages }
  );
}
