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

export async function waitForSpooler(config, jobId, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await queryPrinter(config, jobId);
    if (!state.ok || state.blocked) {
      throw Object.assign(new Error(state.message || "Spooler báo lỗi"), { code: state.code || "SPOOLER_FAILED" });
    }
    if (!state.targetPresent) return state;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Object.assign(new Error("Print job không rời Windows Spooler trong 45 giây"), { code: "SPOOLER_TIMEOUT" });
}
