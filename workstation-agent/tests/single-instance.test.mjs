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
