import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createLoopWatchdog, describeError, installCrashLogging, LOOP_STALL_EXIT_CODE } from "../src/process-guard.mjs";

const SRC = path.resolve(import.meta.dirname, "..", "src");
const memoryLogger = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`), error: (m) => lines.push(`ERROR ${m}`) };
};

// Chạy một tiến trình Node thật dùng logger + installCrashLogging như cli.mjs, trả về nội dung agent.log.
function runChild(body) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "print-agent-crash-"));
  const code = `
    import { createLogger } from ${JSON.stringify(pathToFileURL(path.join(SRC, "logger.mjs")).href)};
    import { installCrashLogging } from ${JSON.stringify(pathToFileURL(path.join(SRC, "process-guard.mjs")).href)};
    const logger = createLogger(${JSON.stringify(logDir)});
    installCrashLogging({ logger, onSignal: () => {} });
    ${body}
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", timeout: 20000 });
  const log = fs.readFileSync(path.join(logDir, "agent.log"), "utf8");
  fs.rmSync(logDir, { recursive: true, force: true });
  return { status: result.status, log };
}

test("0.8.9: lỗi không bắt được trong tiến trình thật được ghi vào agent.log kèm mã thoát (trước đây chỉ ra stderr)", () => {
  const { status, log } = runChild(`setTimeout(() => { throw new Error("loi-thu-nghiem-089"); }, 10);`);
  assert.equal(status, 1, "vẫn thoát mã 1 như Node mặc định — chỉ ghi lại, không nuốt lỗi");
  assert.match(log, /ERROR Agent sắp dừng vì lỗi không bắt được: Error: loi-thu-nghiem-089 \| at /);
  assert.match(log, /WARN Agent thoát, mã 1/);
});

test("0.8.9: promise bị từ chối không ai bắt cũng được ghi lại", () => {
  const { status, log } = runChild(`Promise.reject(new Error("tu-choi-089", { cause: Object.assign(new Error("ket noi"), { code: "ECONNRESET" }) }));`);
  assert.equal(status, 1);
  assert.match(log, /promise bị từ chối không ai bắt: Error: tu-choi-089/);
  assert.match(log, /nguyên nhân: Error: ket noi/);
  assert.match(log, /Agent thoát, mã 1/);
});

test("0.8.9: thoát chủ động (vòng quét đứng) ghi mã 3; thoát bình thường ghi mã 0 ở mức INFO", () => {
  const stalled = runChild(`process.exit(${LOOP_STALL_EXIT_CODE});`);
  assert.equal(stalled.status, 3);
  assert.match(stalled.log, /WARN Agent thoát, mã 3/);
  const normal = runChild(`logger.info("xong");`);
  assert.equal(normal.status, 0);
  assert.match(normal.log, /INFO Agent thoát, mã 0/);
});

test("0.8.9: tín hiệu dừng được ghi lại và chuyển cho agent dừng an toàn", () => {
  const proc = new EventEmitter();
  const logger = memoryLogger();
  const received = [];
  installCrashLogging({ logger, proc, onSignal: (name) => received.push(name) });
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) proc.emit(name);
  assert.deepEqual(received, ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]);
  assert.equal(logger.lines.filter((line) => /WARN Nhận tín hiệu SIG/.test(line)).length, 4);
});

test("describeError: gộp stack một dòng, kèm nguyên nhân, cắt độ dài", () => {
  const error = new Error("ngoai", { cause: new Error("trong") });
  const text = describeError(error);
  assert.ok(!/\n/.test(text));
  assert.match(text, /^Error: ngoai \| at /);
  assert.match(text, /nguyên nhân: Error: trong/);
  assert.ok(describeError(new Error("x".repeat(5000))).length <= 1200);
  assert.equal(describeError("chuoi"), "chuoi");
});

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("watchdog: vòng quét đứng quá hạn khi rảnh thì gọi onStall đúng một lần", () => {
  const clock = fakeClock();
  const logger = memoryLogger();
  let lastLoopAt = clock.now();
  const stalls = [];
  const dog = createLoopWatchdog({ stallMs: 600_000, checkMs: 30_000, statusEveryMs: 0, now: clock.now, getLastProgressAt: () => lastLoopAt, onStall: (ms) => stalls.push(ms), logger });
  for (let i = 0; i < 20; i++) { clock.advance(30_000); assert.equal(dog.check(), false); }   // 10 phút: chưa quá
  clock.advance(30_000);
  assert.equal(dog.check(), true);
  assert.equal(stalls.length, 1);
  assert.match(logger.lines.at(-1), /ERROR Vòng quét đứng 630s .* tự thoát \(mã 3\)/);
  clock.advance(30_000);
  assert.equal(dog.check(), false, "chỉ thoát một lần");
  assert.equal(stalls.length, 1);
});

test("watchdog: vòng quét chạy đều hoặc đang in thì không bao giờ thoát", () => {
  const clock = fakeClock();
  let lastLoopAt = clock.now();
  let busy = false;
  const stalls = [];
  const dog = createLoopWatchdog({ stallMs: 600_000, checkMs: 30_000, statusEveryMs: 0, now: clock.now, getLastProgressAt: () => lastLoopAt, isBusy: () => busy, onStall: () => stalls.push(1) });
  for (let i = 0; i < 100; i++) { clock.advance(30_000); lastLoopAt = clock.now() - 20_000; dog.check(); }
  assert.equal(stalls.length, 0, "vòng quét chạy đều");
  busy = true;   // ví dụ đang chờ thay giấy: vòng quét đứng hàng giờ là hợp lệ
  for (let i = 0; i < 200; i++) { clock.advance(30_000); dog.check(); }
  assert.equal(stalls.length, 0, "đang in thì bỏ qua");
  busy = false;  // in xong mà vòng quét vẫn không chạy lại thì mới là đứng
  clock.advance(30_000);
  dog.check();
  assert.equal(stalls.length, 1);
});

test("watchdog: máy ngủ dậy (đồng hồ nhảy) không bị tính là đứng; LOOP_STALL_MS=0 thì tắt", () => {
  const clock = fakeClock();
  const logger = memoryLogger();
  const lastLoopAt = clock.now();
  const stalls = [];
  const dog = createLoopWatchdog({ stallMs: 600_000, checkMs: 30_000, statusEveryMs: 0, now: clock.now, getLastProgressAt: () => lastLoopAt, onStall: () => stalls.push(1), logger });
  clock.advance(8 * 3600_000);   // ngủ cả đêm
  assert.equal(dog.check(), false);
  assert.ok(logger.lines.some((line) => /Đồng hồ nhảy 480 phút/.test(line)));
  for (let i = 0; i < 20; i++) { clock.advance(30_000); dog.check(); }   // 10 phút sau khi thức dậy
  assert.equal(stalls.length, 0, "còn trong hạn tính từ lúc thức dậy");
  clock.advance(30_000);
  dog.check();
  assert.equal(stalls.length, 1, "thức dậy rồi mà vòng quét vẫn đứng quá hạn thì thoát");

  const off = createLoopWatchdog({ stallMs: 0, checkMs: 30_000, statusEveryMs: 0, now: clock.now, getLastProgressAt: () => 0, onStall: () => stalls.push(1) });
  clock.advance(30_000);
  assert.equal(off.check(), false);
  assert.equal(stalls.length, 1);
});

test("watchdog: mỗi giờ ghi một dòng 'còn chạy' kèm RAM để biết agent sống tới lúc nào", () => {
  const clock = fakeClock();
  const logger = memoryLogger();
  const dog = createLoopWatchdog({ stallMs: 0, checkMs: 30_000, statusEveryMs: 3600_000, now: clock.now, startedAt: clock.now(), getLastProgressAt: () => clock.now() - 12_000, logger, memory: () => ({ rss: 120 * 1048576, heapUsed: 40 * 1048576 }) });
  for (let i = 0; i < 119; i++) { clock.advance(30_000); dog.check(); }
  assert.equal(logger.lines.length, 0);
  clock.advance(30_000);
  dog.check();
  assert.deepEqual(logger.lines, ["INFO Agent còn chạy: 1.0 giờ, RAM 120 MB (heap 40 MB), vòng quét gần nhất 12s trước"]);
});

test("watchdog: start/stop dùng bộ hẹn giờ không giữ tiến trình sống", () => {
  const dog = createLoopWatchdog({ stallMs: 600_000, checkMs: 10, getLastProgressAt: () => Date.now() }).start();
  dog.stop();
  dog.stop();
});
