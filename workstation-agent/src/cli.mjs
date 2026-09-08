import fs from "node:fs";
import path from "node:path";
import { loadConfig, assertServiceConfig } from "./config.mjs";
import { createLogger } from "./logger.mjs";
import { normalizeJob } from "./job-validator.mjs";
import { QueueClient } from "./queue-client.mjs";
import { SupabaseQueueClient } from "./supabase-queue-client.mjs";
import { queryPrinter } from "./printer.mjs";
import { renderJobTspl, writePreview } from "./render.mjs";
import { runService } from "./agent.mjs";
import { acquireSingleInstance } from "./single-instance.mjs";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sample(type) {
  const common = { id: `preview-${type}`, nonce: `preview-${Date.now()}`, type, copies: 1, templateVersion: 1, requestedBy: "test" };
  if (type === "group_uid") return { ...common, payload: { groupUid: "A40000258795", sku: "204900073", productName: "Vải Rayon Tropical Firal" } };
  return { ...common, payload: { sku: "204900073", productName: "Sản phẩm kiểm thử tem SKU", quantity: "12", printedDate: "08-09-26" } };
}

function loadJob() {
  const file = argument("--file");
  return file ? JSON.parse(fs.readFileSync(path.resolve(file), "utf8")) : sample(argument("--type", "sku"));
}

const command = process.argv[2] || "help";
const config = loadConfig({ envFile: argument("--env") || undefined });
const logger = createLogger(config.logDir);

if (command === "preview" || command === "dry-run") {
  const checked = normalizeJob(loadJob());
  if (!checked.ok) throw new Error(checked.errors.join("; "));
  const base = argument("--out") || path.join(config.previewDir, `${checked.job.type}-${Date.now()}`);
  const png = base.toLowerCase().endsWith(".png") ? base : `${base}.png`;
  await writePreview(checked.job, png);
  console.log(`Preview: ${png}`);
  if (command === "dry-run") {
    const tspl = await renderJobTspl(checked.job, config);
    const tsplFile = png.replace(/\.png$/i, ".tspl");
    fs.writeFileSync(tsplFile, tspl);
    console.log(`TSPL: ${tsplFile} (${tspl.length} byte) — chưa gửi máy in`);
  }
} else if (command === "validate") {
  const checked = normalizeJob(loadJob());
  console.log(JSON.stringify(checked, null, 2));
  if (!checked.ok) process.exitCode = 2;
} else if (command === "diagnose") {
  const printer = await queryPrinter(config);
  const queueConfigured = config.queueProvider === "supabase"
    ? Boolean(config.supabaseUrl && config.supabasePublishableKey && config.agentToken)
    : Boolean(config.queueUrl && config.agentToken);
  console.log(JSON.stringify({ ok: printer.ok, agentId: config.agentId, printer, queueProvider: config.queueProvider, queueConfigured }, null, 2));
} else if (command === "service") {
  assertServiceConfig(config);
  const releaseLock = acquireSingleInstance(config.tempDir);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  try {
    const queue = config.queueProvider === "supabase" ? new SupabaseQueueClient(config) : new QueueClient(config);
    await runService(config, queue, logger, controller.signal);
  } finally {
    releaseLock();
  }
} else {
  console.log("Dùng: preview | dry-run | validate | diagnose | service [--type sku|group_uid] [--file job.json] [--out path] [--env path]");
}
