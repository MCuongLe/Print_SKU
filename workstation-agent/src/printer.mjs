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
 * Theo dõi job trong Windows Spooler cho tới khi xong hoặc kẹt.
 *
 * Trên TSC PE200, spooler đẩy thẳng byte ra cổng USB: job khoẻ biến mất trước
 * nhịp quét đầu, chỉ khi máy kẹt (hết giấy, bung nắp) job mới nằm lại hàng đợi.
 * Vì vậy:
 *   - thấy job rồi nó biến mất  -> in xong, confirmed = true
 *   - thấy job nhưng số trang đứng yên -> PRINTER_STALLED (bắt được hết giấy)
 *   - không bao giờ thấy job    -> bình thường, nhưng KHÔNG chứng minh được
 *                                  tem đã ra giấy: confirmed = false
 *
 * Bản ≤ 0.3.5 coi "không thấy job" là "đã in xong" nên lệnh 136 tem cũng báo
 * hoàn tất sau 9 giây. Nay sự thiếu bằng chứng đó được nói ra thay vì giấu đi.
 */
export async function waitForSpooler(config, jobId, options = {}) {
  const {
    timeoutMs = 900000,      // trần tuyệt đối cho một lệnh
    appearMs = 8000,         // chờ job hiện ra; mọi lệnh đều phải trả phí này
    stallMs = 120000,        // không in thêm trang nào trong ngần này là kẹt
    pollMs = 1000,
    requireConfirm = false,  // máy in không để lộ job thì đừng coi là lỗi
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
      if (state.targetRetained) return { ...state, confirmed: true };
      if (Date.now() - lastChange > stallMs) {
        throw Object.assign(
          new Error(`Máy in đứng yên ${Math.round(stallMs / 1000)} giây ở trang ${pages}`),
          { code: "PRINTER_STALLED", pagesPrinted: pages }
        );
      }
    } else if (seen) {
      return { ...state, confirmed: true };           // đã thấy rồi, giờ hết => in xong
    } else if (Date.now() - started > appearMs) {
      // Trên TSC PE200, spooler đẩy thẳng byte ra cổng USB nên job khoẻ thường
      // biến mất trước nhịp quét đầu; job chỉ nằm lại hàng đợi khi máy kẹt.
      // Vậy "không thấy job" là bình thường, KHÔNG phải lỗi — nhưng cũng không
      // chứng minh được tem đã ra giấy, nên đánh dấu chưa xác nhận.
      if (requireConfirm) {
        throw Object.assign(
          new Error(`Không thấy job ${jobId} trong hàng đợi máy in sau ${Math.round(appearMs / 1000)} giây`),
          { code: "SPOOLER_JOB_MISSING" }
        );
      }
      return { ...state, confirmed: false };
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw Object.assign(
    new Error(`Print job chưa in xong sau ${Math.round(timeoutMs / 60000)} phút (trang đã in: ${lastPages})`),
    { code: "SPOOLER_TIMEOUT", pagesPrinted: lastPages }
  );
}
