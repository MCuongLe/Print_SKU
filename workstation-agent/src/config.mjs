import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseEnv(text) {
  const result = {};
  for (const sourceLine of String(text || "").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}

function positiveInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return fallback;
  return number;
}

export function loadConfig(options = {}) {
  const envFile = path.resolve(options.envFile || process.env.PRINT_AGENT_ENV || path.join(ROOT_DIR, "config", ".env"));
  let fileValues = {};
  if (fs.existsSync(envFile)) fileValues = parseEnv(fs.readFileSync(envFile, "utf8"));
  const get = (key, fallback = "") => process.env[key] ?? fileValues[key] ?? fallback;
  const config = {
    rootDir: ROOT_DIR,
    envFile,
    queueUrl: get("PRINT_QUEUE_URL"),
    queueProvider: get("PRINT_QUEUE_PROVIDER", "supabase").toLowerCase(),
    supabaseUrl: get("SUPABASE_URL"),
    supabasePublishableKey: get("SUPABASE_PUBLISHABLE_KEY"),
    agentToken: get("PRINT_AGENT_TOKEN"),
    printerName: get("PRINTER_NAME", "TSC PE200 (Copy 1)"),
    agentId: get("AGENT_ID", "may-kho-01"),
    pollIntervalMs: positiveInt(get("AGENT_POLL_INTERVAL_MS"), 1000, 250, 60000),
    leaseMs: positiveInt(get("AGENT_LEASE_MS"), 120000, 30000, 900000),
    dpi: positiveInt(get("LABEL_DPI"), 203, 150, 600),
    density: positiveInt(get("LABEL_DENSITY"), 10, 0, 15),
    speed: positiveInt(get("LABEL_SPEED"), 3, 1, 10),
    logLevel: get("LOG_LEVEL", "info"),
    logDir: path.join(ROOT_DIR, "logs"),
    previewDir: path.join(ROOT_DIR, "preview"),
    tempDir: path.join(ROOT_DIR, "temp")
  };
  for (const directory of [config.logDir, config.previewDir, config.tempDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return config;
}

export function assertServiceConfig(config) {
  const missing = [];
  if (config.queueProvider === "supabase") {
    if (!config.supabaseUrl) missing.push("SUPABASE_URL");
    if (!config.supabasePublishableKey) missing.push("SUPABASE_PUBLISHABLE_KEY");
  } else if (!config.queueUrl) missing.push("PRINT_QUEUE_URL");
  if (!config.agentToken) missing.push("PRINT_AGENT_TOKEN");
  if (!config.printerName) missing.push("PRINTER_NAME");
  if (missing.length) throw new Error(`Thiếu cấu hình: ${missing.join(", ")}`);
}
