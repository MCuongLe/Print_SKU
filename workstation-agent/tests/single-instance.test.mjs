import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSingleInstance } from "../src/single-instance.mjs";

test("khóa không cho hai agent cùng chạy", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-lock-"));
  const release = acquireSingleInstance(directory);
  assert.throws(() => acquireSingleInstance(directory), /Agent đã chạy/);
  release();
  const releaseAgain = acquireSingleInstance(directory);
  releaseAgain();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("tự chiếm lại khóa cũ (PID còn nhưng khóa quá lâu không được chạm)", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-lock-"));
  const lockFile = path.join(directory, "agent.lock");
  // Khóa mang PID của tiến trình hiện tại (chắc chắn tồn tại) nhưng mtime rất cũ → phải bị coi là cũ và chiếm lại.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: "2020-01-01T00:00:00.000Z" }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lockFile, old, old);
  const release = acquireSingleInstance(directory);
  assert.equal(Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid), process.pid);
  release();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("khóa còn tươi (vừa được chạm) thì không bị chiếm", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-lock-"));
  const release = acquireSingleInstance(directory);
  release.touch();
  assert.throws(() => acquireSingleInstance(directory), /Agent đã chạy/);
  release();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("0.8.9: khóa chạm lần cuối TRƯỚC khi máy khởi động thì tiếp quản ngay, kể cả khi PID cũ đã bị cấp cho tiến trình khác", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-lock-"));
  const lockFile = path.join(directory, "agent.lock");
  // Tối 07/10/2026: chạm lần cuối 20:22:18, tắt máy 20:22:22, khởi động 20:22:35 — khóa mới 17 giây
  // tuổi nên luật 3 phút chưa coi là cũ, PID cũ thì đang thuộc tiến trình khác (isAlive = true).
  const lastTouch = Date.parse("2026-10-07T13:22:18Z");
  const boot = Date.parse("2026-10-07T13:22:35Z");
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 4321, startedAt: "2026-10-07T01:41:31.105Z" }));
  fs.utimesSync(lockFile, new Date(lastTouch), new Date(lastTouch));
  const warnings = [];
  const release = acquireSingleInstance(directory, { now: () => boot + 5000, bootTimeMs: boot, isAlive: () => true, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(Number(JSON.parse(fs.readFileSync(lockFile, "utf8")).pid), process.pid);
  assert.match(warnings.join("\n"), /Tiếp quản khóa agent cũ: chạm lần cuối 2026-10-07T13:22:18.000Z, trước khi máy khởi động lúc 2026-10-07T13:22:35.000Z/);
  release();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("0.8.9: khóa tươi của bản đang chạy trong lần khởi động này thì không bị chiếm; lỗi nói rõ PID và giờ chạm", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-lock-"));
  const release = acquireSingleInstance(directory);
  release.touch();
  assert.throws(
    () => acquireSingleInstance(directory, { bootTimeMs: Date.now() - 3600_000, isAlive: () => true }),
    (error) => error.message.startsWith(`Agent đã chạy với PID ${process.pid} (khóa chạm lúc `) && /lúc \d{4}-\d\d-\d\dT/.test(error.message)
  );
  release();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("0.8.9: tiến trình chủ không còn thì tiếp quản và ghi lý do", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-lock-"));
  fs.writeFileSync(path.join(directory, "agent.lock"), JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
  const warnings = [];
  const release = acquireSingleInstance(directory, { bootTimeMs: Date.now() - 3600_000, isAlive: () => false, logger: { warn: (m) => warnings.push(m) } });
  assert.match(warnings[0], /tiến trình PID 999999 không còn/);
  release();
  fs.rmSync(directory, { recursive: true, force: true });
});
