import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.mjs";
import { waitForSpooler } from "../src/printer.mjs";

const emptyEnv = () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cfg-086-")), ".env");
  fs.writeFileSync(file, "PRINT_QUEUE_PROVIDER=supabase\n");
  return file;
};

test("0.8.6/0.8.8: mặc định chờ spooler 1,5s dò mỗi 0,5s, PowerShell thường trực, cache đo chữ và danh mục SKU; tắt được bằng .env", () => {
  const config = loadConfig({ envFile: emptyEnv() });
  assert.equal(config.spoolAppearMs, 1500);
  assert.equal(config.spoolPollMs, 500);
  assert.equal(config.psHost, true);
  assert.equal(config.textCache, true);
  assert.equal(config.skuCache, true);
  assert.equal(config.skuCacheCheckMs, 900000);
  const file = emptyEnv();
  fs.appendFileSync(file, "TEXT_CACHE=off\nSKU_CACHE=off\nSPOOL_APPEAR_MS=8000\nSPOOL_POLL_MS=1000\nPS_HOST=off\n");
  const off = loadConfig({ envFile: file });
  assert.equal(off.textCache, false);
  assert.equal(off.psHost, false);
  assert.equal(off.spoolPollMs, 1000);
  assert.equal(off.skuCache, false);
  assert.equal(off.spoolAppearMs, 8000, "quay lại mức cũ chỉ bằng một dòng trong config\\.env");
});

test("Job không bao giờ hiện trong hàng đợi (TSC PE200 khoẻ): báo xong sau ~2 nhịp quét, chưa xác nhận", async () => {
  let calls = 0;
  const started = Date.now();
  const state = await waitForSpooler({}, 7, {
    __query: async () => { calls += 1; return { ok: true, blocked: false, targetPresent: false }; },
    appearMs: 60, pollMs: 25
  });
  assert.equal(state.confirmed, false);
  assert.ok(calls >= 2 && calls <= 4, `quét ${calls} lần`);
  assert.ok(Date.now() - started < 1000);
});

test("Job kẹt nằm lại hàng đợi (hết giấy): KHÔNG báo xong, chờ tới khi in xong", async () => {
  const states = [
    { ok: true, blocked: false, targetPresent: true, targetPagesPrinted: 0 },
    { ok: true, blocked: false, targetPresent: true, targetPagesPrinted: 0 },
    { ok: true, blocked: false, targetPresent: true, targetPagesPrinted: 1 },
    { ok: true, blocked: false, targetPresent: false }
  ];
  let index = 0;
  const state = await waitForSpooler({}, 7, { __query: async () => states[Math.min(index++, states.length - 1)], appearMs: 30, pollMs: 25 });
  assert.equal(state.confirmed, true, "thấy job rồi job biến mất = in xong thật");
  assert.ok(index >= 4, "phải đợi qua cả lúc kẹt, không dừng ở 2,5s");
});
