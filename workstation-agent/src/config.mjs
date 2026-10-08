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

function loopStall(value) {
  // Không có dòng trong .env thì get() trả "" và Number("") là 0 — phải ra mặc định, không phải "tắt".
  if (String(value ?? "").trim() === "") return 600000;
  const ms = positiveInt(value, 600000, 0, 86400000);
  return ms === 0 ? 0 : Math.max(ms, 300000);
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
    // 0.8.4: hỏi thưa khi rảnh, Realtime đánh thức khi có lệnh (xem nextPollDelay ở agent.mjs).
    idlePollMs: positiveInt(get("AGENT_IDLE_POLL_MS"), 20000, 1000, 300000),
    idlePollNoWakeMs: positiveInt(get("AGENT_IDLE_POLL_NO_WAKE_MS"), 10000, 1000, 300000),
    activeWindowMs: positiveInt(get("AGENT_ACTIVE_WINDOW_MS"), 120000, 0, 3600000),
    realtimeWake: !/^(0|false|off|no)$/i.test(get("REALTIME_WAKE", "on")),
    // 0.8.5: bỏ bước kiểm tra máy in trước khi nhận lệnh nếu lần kiểm tra gần nhất còn mới hơn số ms này (0 = luôn kiểm tra).
    printerCacheMs: positiveInt(get("PRINTER_STATE_CACHE_MS"), 60000, 0, 600000),
    // 0.8.6: cache đo chữ (temp/text-metrics-cache.json) và danh mục SKU đo sẵn (temp/sku-catalog.json).
    textCache: !/^(0|false|off|no)$/i.test(get("TEXT_CACHE", "on")),
    skuCache: !/^(0|false|off|no)$/i.test(get("SKU_CACHE", "on")),
    skuCacheCheckMs: positiveInt(get("SKU_CACHE_CHECK_MS"), 900000, 60000, 86400000),
    leaseMs: positiveInt(get("AGENT_LEASE_MS"), 120000, 30000, 900000),
    spoolTimeoutMs: positiveInt(get("SPOOL_TIMEOUT_MS"), 3600000, 60000, 7200000),
    spoolStallMs: positiveInt(get("SPOOL_STALL_MS"), 600000, 15000, 1800000),
    // 0.8.6: 8s -> 2,5s. TSC PE200 đẩy byte thẳng ra USB, job khoẻ biến mất trước nhịp quét đầu; job kẹt
    // (hết giấy, bung nắp) nằm lại hàng đợi hàng phút nên nhìn thấy ở MỌI lần dò. 0.8.8: 2,5s -> 1,5s kèm
    // dò mỗi 0,5s (trước 1s): mỗi lần dò chỉ còn ~60ms nhờ PowerShell thường trực nên ~4 lần dò trong 1,7s
    // thay vì 2 lần trong 2,8s — nhiều lần quan sát hơn trong thời gian ngắn hơn (RULES.md).
    spoolAppearMs: positiveInt(get("SPOOL_APPEAR_MS"), 1500, 500, 120000),
    spoolPollMs: positiveInt(get("SPOOL_POLL_MS"), 500, 100, 5000),
    // 0.8.8: giữ MỘT tiến trình PowerShell thay vì mở mới 4–5 lần mỗi lệnh (src/ps-host.mjs). off để quay về cách cũ.
    psHost: !/^(0|false|off|no)$/i.test(get("PS_HOST", "on")),
    spoolRequireConfirm: /^(1|true|yes)$/i.test(get("SPOOL_REQUIRE_CONFIRM", "")),
    // 0.8.9: vòng quét đứng quá số ms này khi không in thì agent tự thoát (mã 3) để Task Scheduler chạy lại.
    // 0 = tắt; giá trị khác 0 tối thiểu 5 phút (> nhịp hỏi thưa dài nhất AGENT_IDLE_POLL_MS + thời hạn các bước).
    loopStallMs: loopStall(get("LOOP_STALL_MS")),
    dpi: positiveInt(get("LABEL_DPI"), 203, 150, 600),
    density: positiveInt(get("LABEL_DENSITY"), 12, 0, 15),
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
