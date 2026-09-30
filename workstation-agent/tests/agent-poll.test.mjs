import test from "node:test";
import assert from "node:assert/strict";
import { createWaiter, nextPollDelay, runService, shouldSkipPrinterCheck } from "../src/agent.mjs";

const config = { pollIntervalMs: 1000, idlePollMs: 20000, idlePollNoWakeMs: 10000, activeWindowMs: 120000, printerCacheMs: 60000 };

test("shouldSkipPrinterCheck: chi bo qua khi duoc danh thuc, lan kiem tra gan nhat con moi va may san sang", () => {
  const ready = { state: { ok: true, blocked: false }, at: 100_000 };
  assert.equal(shouldSkipPrinterCheck({ cache: ready, now: 130_000, woken: true, config }), true);
  assert.equal(shouldSkipPrinterCheck({ cache: ready, now: 130_000, woken: false, config }), false, "nhip dinh ky van kiem tra that");
  assert.equal(shouldSkipPrinterCheck({ cache: ready, now: 170_000, woken: true, config }), false, "qua 60s thi kiem tra lai");
  assert.equal(shouldSkipPrinterCheck({ cache: { state: { ok: true, blocked: true }, at: 100_000 }, now: 130_000, woken: true, config }), false, "may ket thi luon kiem tra that");
  assert.equal(shouldSkipPrinterCheck({ cache: { state: { ok: false, blocked: true }, at: 100_000 }, now: 130_000, woken: true, config }), false);
  assert.equal(shouldSkipPrinterCheck({ cache: null, now: 130_000, woken: true, config }), false);
  assert.equal(shouldSkipPrinterCheck({ cache: ready, now: 130_000, woken: true, config: { ...config, printerCacheMs: 0 } }), false, "PRINTER_STATE_CACHE_MS=0 tat tinh nang");
});

test("nextPollDelay: vua in xong hoi nhanh; ranh lau hoi thua, khong co Realtime thi day hon", () => {
  assert.equal(nextPollDelay({ now: 100_000, lastJobAt: 50_000, wakeConnected: true, config }), 1000);
  assert.equal(nextPollDelay({ now: 300_000, lastJobAt: 50_000, wakeConnected: true, config }), 20000);
  assert.equal(nextPollDelay({ now: 300_000, lastJobAt: 50_000, wakeConnected: false, config }), 10000);
  assert.equal(nextPollDelay({ now: 300_000, lastJobAt: 0, wakeConnected: true, config }), 20000, "chua tung co lenh: hoi thua ngay tu dau");
});

test("createWaiter: tin hieu toi luc dang cho thi thuc ngay; toi luc dang ban thi vong sau khong cho", async () => {
  const waiter = createWaiter();
  const started = Date.now();
  const pending = waiter.wait(5000);
  setTimeout(() => waiter.wake(), 10);
  assert.equal(await pending, "wake");
  assert.ok(Date.now() - started < 1000);
  waiter.wake();                       // dang "in", chua ai cho
  assert.equal(await waiter.wait(5000), "wake", "vong sau phai thuc ngay");
  assert.equal(await waiter.wait(5), "timeout", "tin hieu chi dung mot lan");
});

test("runService: co Realtime thi ranh cho 20s va thuc ngay khi co tin hieu; dung an toan khi abort", async () => {
  const claims = [];
  let wakeHandler = null;
  const queue = { claim: async () => { claims.push(Date.now()); return { job: null }; } };
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const controller = new AbortController();
  const fakeWake = { start: (h) => { wakeHandler = h; }, stop: () => { fakeWake.stopped = true; }, connected: () => true };
  const fastConfig = { ...config, agentId: "may-test", tempDir: process.env.TEMP || ".", printerName: "TEST", queueProvider: "supabase",
    supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_test", realtimeWake: true, idlePollMs: 60_000, idlePollNoWakeMs: 60_000 };
  // queryPrinter that goi PowerShell; test thay bang may in gia, dem so lan kiem tra.
  let printerChecks = 0;
  const service = runService(fastConfig, queue, logger, controller.signal, null, { createWake: () => fakeWake, queryPrinter: async () => { printerChecks++; return { ok: true, blocked: false, code: "READY" }; } });
  const until = Date.now() + 25_000;
  while (claims.length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(claims.length, 1, "vong dau hoi mot lan roi cho 60s");
  assert.equal(printerChecks, 1, "vong dau phai kiem tra may in that");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(claims.length, 1, "chua co tin hieu thi khong hoi them");
  wakeHandler();
  while (claims.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(claims.length, 2, "tin hieu Realtime phai danh thuc ngay");
  assert.equal(printerChecks, 1, "duoc danh thuc + may vua san sang thi KHONG chay lai kiem tra may in");
  controller.abort();
  await service;
  assert.equal(fakeWake.stopped, true);
  assert.ok(logs.some((m) => /dừng an toàn/.test(m)));
});

test("runService: may in ket thi moi lan danh thuc deu kiem tra that (khong nhan lenh de roi tra ve mai)", async () => {
  const claims = [];
  let wakeHandler = null, printerChecks = 0;
  const queue = { claim: async () => { claims.push(Date.now()); return { job: null }; } };
  const logger = { info() {}, warn() {}, error() {} };
  const controller = new AbortController();
  const fakeWake = { start: (h) => { wakeHandler = h; }, stop() {}, connected: () => true };
  const cfg = { ...config, agentId: "may-test", tempDir: process.env.TEMP || ".", printerName: "TEST", queueProvider: "supabase",
    supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_test", realtimeWake: true, idlePollMs: 60_000, idlePollNoWakeMs: 60_000 };
  const service = runService(cfg, queue, logger, controller.signal, null, { createWake: () => fakeWake, queryPrinter: async () => { printerChecks++; return { ok: true, blocked: true, code: "PAPER_OUT", message: "Hết giấy" }; } });
  const until = Date.now() + 25_000;
  while (claims.length < 1 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  wakeHandler();
  while (claims.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert.equal(printerChecks, 2, "may ket: lan danh thuc van phai kiem tra that");
  controller.abort();
  await service;
});
