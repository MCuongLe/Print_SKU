import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPowerShellHost } from "./ps-host.mjs";

const execFileAsync = promisify(execFile);

/**
 * Chạy một script qua PowerShell thường trực (ps-host.mjs) nếu agent đang giữ một tiến trình; không có
 * hoặc host lỗi thì báo `used: false` để gọi cách cũ (mở PowerShell mới).
 *  - idempotent (kiểm tra máy in): host lỗi kiểu nào cũng rơi về cách cũ.
 *  - KHÔNG idempotent (gửi dữ liệu xuống máy in): chỉ rơi về cách cũ khi yêu cầu CHƯA tới tiến trình
 *    (requestStarted = false). Đã gửi đi mà tiến trình chết/quá hạn thì ném lỗi — gọi lại là in trùng tem.
 */
async function runViaHost(script, args, { timeoutMs, idempotent }) {
  const host = getPowerShellHost();
  if (!host) return { used: false };
  try {
    return { used: true, stdout: await host.runScript(script, args, { timeoutMs }) };
  } catch (error) {
    if (!idempotent && error?.requestStarted) throw error;
    return { used: false, hostError: error };
  }
}

export async function queryPrinter(config, jobId = null) {
  const hosted = await runViaHost("printer-status.ps1", { Printer: config.printerName, ...(jobId ? { JobId: Number(jobId) } : {}) }, { timeoutMs: 20000, idempotent: true });
  if (hosted.used) {
    try { return JSON.parse(hosted.stdout.trim()); } catch {
      return { ok: false, blocked: true, code: "STATUS_UNAVAILABLE", message: "PowerShell thường trực trả kết quả không đọc được" };
    }
  }
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

const BITMAP_ERRORS = {
  FILE_MISSING: "Không tìm thấy ảnh trang phiếu để in",
  NO_A4: "Máy in không có khổ giấy A4",
  PRINTER_INVALID: "Không tìm thấy máy in A4 trong Windows",
  PRINT_FAILED: "Windows báo lỗi khi in phiếu"
};

/**
 * 0.11.0: in các trang PNG (phiếu xả vải A4) qua DRIVER Windows — máy laser host-based (HP P1102w) không nhận
 * TSPL/RAW. Cùng quy tắc với sendRaw: KHÔNG idempotent — PowerShell thường trực chết sau khi yêu cầu đã tới thì
 * ném lỗi, không gọi lại (gọi lại là in trùng phiếu); tệp tạm luôn xoá trong finally.
 * `pages`: Buffer PNG (ghi ra tệp tạm) hoặc đường dẫn có sẵn (không xoá). `copies`: số bản của CẢ phiếu.
 * Thời hạn rộng theo số trang × số bản: driver GDI dựng mỗi trang 300 dpi mất vài giây.
 */
export async function sendBitmapPages(config, pages, copies, jobId) {
  const safeId = String(jobId).replace(/[^0-9A-Za-z._-]/g, "_");
  const stamp = Date.now();
  const created = [];
  try {
    const files = pages.map((page, index) => {
      if (typeof page === "string") return page;
      const file = path.join(config.tempDir, `${safeId}-${stamp}-p${index + 1}.png`);
      fs.writeFileSync(file, page);
      created.push(file);
      return file;
    });
    const args = { Printer: config.printerName, Files: files.join("|"), Copies: Number(copies) || 1, DocName: `PrintSKU xa-vai ${safeId}`.slice(0, 120) };
    const timeoutMs = Math.min(600000, 60000 + 15000 * files.length * args.Copies);
    let stdout = "";
    const hosted = await runViaHost("print-bitmap.ps1", args, { timeoutMs, idempotent: false });
    if (hosted.used) stdout = hosted.stdout;
    else try {
      const script = path.join(config.rootDir, "powershell", "print-bitmap.ps1");
      ({ stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
        "-Printer", args.Printer, "-Files", args.Files, "-Copies", String(args.Copies), "-DocName", args.DocName
      ], { windowsHide: true, timeout: timeoutMs }));
    } catch (error) {
      stdout = String(error?.stdout || "");
      if (!stdout.trim()) throw error;
    }
    const result = JSON.parse(stdout.trim());
    if (!result.ok) {
      // print-bitmap.ps1 chỉ chứa ASCII nên trả mã lỗi; câu tiếng Việt có dấu dựng ở đây.
      const known = BITMAP_ERRORS[result.code];
      const message = known ? `${known}${result.message ? ` (${result.message})` : ""}` : result.message || "Windows từ chối lệnh in phiếu";
      throw Object.assign(new Error(message.slice(0, 200)), { code: result.code || "PRINT_FAILED" });
    }
    return result;
  } finally {
    for (const file of created) {
      try { fs.unlinkSync(file); } catch { /* tệp tạm sẽ được diagnose dọn sau */ }
    }
  }
}

export async function sendRaw(config, buffer, jobId) {
  const safeId = String(jobId).replace(/[^0-9A-Za-z._-]/g, "_");
  const file = path.join(config.tempDir, `${safeId}-${Date.now()}.tspl`);
  fs.writeFileSync(file, buffer);
  const script = path.join(config.rootDir, "powershell", "raw-print.ps1");
  try {
    let stdout = "";
    const hosted = await runViaHost("raw-print.ps1", { File: file, Printer: config.printerName }, { timeoutMs: 45000, idempotent: false });
    if (hosted.used) stdout = hosted.stdout;
    else try {
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
    timeoutMs = 3600000,     // trần tuyệt đối; phải rộng hơn stallMs nhiều lần
    appearMs = 2500,         // chờ job hiện ra; mọi lệnh đều phải trả phí này (0.8.6: 8000 -> 2500)
    stallMs = 600000,        // kiên nhẫn chờ người vận hành thay giấy
    pollMs = 1000,
    requireConfirm = false,  // máy in không để lộ job thì đừng coi là lỗi
    heartbeatMs = 30000,     // nhịp giữ lease khi chờ lâu
    onProgress,
    onProblem,
    onHeartbeat,
    __query = queryPrinter   // chỉ dùng cho test, tránh phải dựng cả Windows Spooler
  } = options;

  const started = Date.now();
  let seen = false;
  let lastPages = -1;
  let lastChange = Date.now();
  let lastBeat = Date.now();
  let problem = null;

  while (Date.now() - started < timeoutMs) {
    const state = await __query(config, jobId);
    // Lease chỉ được gia hạn khi agent báo tiến độ. Chờ thay giấy có thể kéo dài
    // hơn lease rất nhiều mà số trang không nhúc nhích, nên phải đập nhịp đều
    // đặn — nếu không backend sẽ trả lệnh về hàng đợi và in lại lần hai.
    if (Date.now() - lastBeat >= heartbeatMs) {
      lastBeat = Date.now();
      onHeartbeat?.(lastPages >= 0 ? lastPages : null, state);
    }

    if (!state.ok || state.blocked) {
      // Máy kẹt hoặc không đọc được trạng thái KHÔNG phải lý do bỏ cuộc ngay:
      // Windows giữ nguyên job trong hàng đợi, người vận hành thay giấy xong là
      // in tiếp. Chỉ đầu hàng khi tình trạng này kéo dài quá stallMs.
      problem = Object.assign(new Error(state.message || "Máy in chưa sẵn sàng"), {
        code: state.code || "SPOOLER_FAILED",
        pagesPrinted: lastPages >= 0 ? lastPages : undefined
      });
      onProblem?.(problem, state);
      if (Date.now() - lastChange > stallMs) throw problem;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    problem = null;

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
          new Error(`Máy in đứng yên ${Math.round(stallMs / 60000)} phút ở trang ${pages}`),
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
