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
