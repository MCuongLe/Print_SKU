import fs from "node:fs";
import path from "node:path";

const SECRET_PATTERN = /(token|secret|password|authorization|api[_-]?key)\s*[:=]\s*([^\s,}]+)/gi;

export function redact(value) {
  return String(value ?? "").replace(SECRET_PATTERN, "$1=[REDACTED]");
}

export function createLogger(logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "agent.log");
  const write = (level, values) => {
    const message = values.map((value) => redact(typeof value === "string" ? value : JSON.stringify(value))).join(" ");
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}`;
    console[level === "error" ? "error" : "log"](line);
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
        const old = fs.readFileSync(logFile, "utf8");
        fs.writeFileSync(logFile, old.slice(-300 * 1024), "utf8");
      }
      fs.appendFileSync(logFile, line + "\n", "utf8");
    } catch {
      // Lỗi ghi log không được làm dừng đường in.
    }
  };
  return {
    logFile,
    info: (...values) => write("info", values),
    warn: (...values) => write("warn", values),
    error: (...values) => write("error", values)
  };
}
