import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { AGENT_VERSION, runService } from "../src/agent.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");

function configWith(lines) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-env-"));
  const envFile = path.join(directory, ".env");
  fs.writeFileSync(envFile, lines.join("\n"));
  const saved = process.env.LOOP_STALL_MS;
  delete process.env.LOOP_STALL_MS;
  try { return loadConfig({ envFile }); } finally {
    if (saved !== undefined) process.env.LOOP_STALL_MS = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("0.8.9: LOOP_STALL_MS mặc định 10 phút khi .env không có dòng đó; 0 tắt; tối thiểu 5 phút", () => {
  assert.equal(configWith([]).loopStallMs, 600000, "máy trạm cũ không có dòng LOOP_STALL_MS vẫn được bảo vệ");
  assert.equal(configWith(["LOOP_STALL_MS="]).loopStallMs, 600000);
  assert.equal(configWith(["LOOP_STALL_MS=0"]).loopStallMs, 0);
  assert.equal(configWith(["LOOP_STALL_MS=1000"]).loopStallMs, 300000);
  assert.equal(configWith(["LOOP_STALL_MS=900000"]).loopStallMs, 900000);
  assert.equal(configWith(["LOOP_STALL_MS=abc"]).loopStallMs, 600000);
});

test("0.8.9: VERSION, package.json và AGENT_VERSION cùng một số", () => {
  const version = fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(version, "0.8.9");
  assert.equal(pkg.version, version);
  assert.equal(AGENT_VERSION, version);
});

test("0.8.9: install-agent.ps1 đăng ký đủ 3 trigger, không chặn khi chạy pin, tắt task trước khi chép đè; có BOM cho chữ Việt", () => {
  const bytes = fs.readFileSync(path.join(ROOT, "powershell", "install-agent.ps1"));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "PowerShell 5.1 đọc file không BOM theo bảng mã ANSI");
  const script = bytes.toString("utf8");
  assert.match(script, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(script, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(script, /New-ScheduledTaskTrigger -Once -At \(Get-Date\) -RepetitionInterval \(New-TimeSpan -Minutes 5\)/);
  assert.match(script, /-Trigger \$triggers/);
  assert.match(script, /-MultipleInstances IgnoreNew/, "trigger 5 phút không được tạo bản thứ hai");
  assert.match(script, /-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable/);
  const disable = script.indexOf("Disable-ScheduledTask");
  const copy = script.indexOf("robocopy $source");
  assert.ok(disable > 0 && disable < copy, "phải tắt task trước khi robocopy");
  assert.match(script, /robocopy [^\n]*\/R:2 \/W:2/, "file đang bị giữ thì không treo hàng giờ");
});

test("0.8.9: runService — vòng quét đứng khi rảnh thì dọn dẹp rồi tự thoát mã 3; chạy đều thì không", async () => {
  const base = { pollIntervalMs: 1000, idlePollMs: 50, idlePollNoWakeMs: 50, activeWindowMs: 0, printerCacheMs: 0, agentId: "may-test",
    tempDir: os.tmpdir(), printerName: "TEST", queueProvider: "supabase", realtimeWake: false };
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };

  // Đứng: kiểm tra máy in không bao giờ trả lời (giả lập một bước treo không có hạn).
  const exits = [];
  let released = 0;
  const lock = Object.assign(() => { released++; }, { touch() {} });
  const stuck = runService({ ...base, loopStallMs: 150 }, { claim: async () => ({ job: null }) }, logger, new AbortController().signal, lock,
    { queryPrinter: () => new Promise(() => {}), watchdogCheckMs: 20, exit: (code) => exits.push(code) });
  const until = Date.now() + 5000;
  while (exits.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(exits, [3]);
  assert.equal(released, 1, "nhả khóa để bản sau khỏi phải chờ");
  assert.ok(logs.some((m) => /Vòng quét đứng .* tự thoát \(mã 3\)/.test(m)));
  void stuck;   // vòng quét giả lập treo mãi; không chờ nó

  // Chạy đều: hỏi hàng đợi mỗi 50 ms trong 600 ms, giới hạn 150 ms — không được thoát.
  const exitsOk = [];
  const controller = new AbortController();
  let claims = 0;
  const healthy = runService({ ...base, loopStallMs: 150 }, { claim: async () => { claims++; return { job: null }; } }, logger, controller.signal, null,
    { queryPrinter: async () => ({ ok: true, blocked: false, code: "READY" }), watchdogCheckMs: 20, exit: (code) => exitsOk.push(code) });
  await new Promise((r) => setTimeout(r, 600));
  controller.abort();
  await healthy;
  assert.ok(claims >= 5, `vòng quét phải chạy đều (đã hỏi ${claims} lần)`);
  assert.deepEqual(exitsOk, []);
});
