import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createPowerShellHost, PowerShellHostError } from "../src/ps-host.mjs";

// PowerShell giả: đọc từng dòng JSON từ stdin, trả lời theo giao thức của host.ps1 (@@READY@@, @@R@@{...}).
function fakeSpawn(behavior = {}) {
  const children = [];
  const impl = (command, args) => {
    if (behavior.throwOnSpawn) throw new Error("spawn EPERM");
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.requests = [];
    child.rawLines = [];
    child.args = args;
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("exit", null)); };
    child.die = (code = 1) => child.emit("exit", code);
    let buffer = "";
    child.stdin.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        child.rawLines.push(line);
        const request = JSON.parse(line);
        child.requests.push(request);
        if (behavior.onRequest) behavior.onRequest(child, request);
        else child.reply(request.id, { ok: true, out: `echo:${request.script ?? request.op}` });
      }
    });
    child.reply = (id, body) => child.stdout.write(`@@R@@${JSON.stringify({ id, ...body })}\r\n`);
    children.push(child);
    if (!behavior.neverReady) setImmediate(() => child.stdout.write("@@READY@@\r\n"));
    return child;
  };
  impl.children = children;
  return impl;
}
const make = (behavior, options = {}) => {
  const spawnImpl = fakeSpawn(behavior);
  const logs = [];
  const host = createPowerShellHost({ rootDir: "C:/agent", spawnImpl, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) }, ...options });
  return { host, spawnImpl, logs };
};
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

test("mở host.ps1 đúng cờ, chạy script, nhận stdout; tiến trình dùng lại cho các yêu cầu sau", async () => {
  const { host, spawnImpl } = make();
  assert.equal(await host.runScript("printer-status.ps1", { Printer: "TSC" }), "echo:printer-status.ps1");
  assert.equal(await host.runScript("measure-text.ps1", { InputFile: "a", OutputFile: "b" }), "echo:measure-text.ps1");
  assert.equal(spawnImpl.children.length, 1, "chỉ mở MỘT tiến trình cho nhiều yêu cầu");
  const [child] = spawnImpl.children;
  assert.deepEqual(child.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]);
  assert.match(child.args[5].replace(/\\/g, "/"), /C:\/agent\/powershell\/host\.ps1$/);
  assert.deepEqual(child.requests.map((r) => [r.script, r.args]), [["printer-status.ps1", { Printer: "TSC" }], ["measure-text.ps1", { InputFile: "a", OutputFile: "b" }]]);
  host.stop();
});

test("hai chiều chỉ chứa ASCII: tiếng Việt trong yêu cầu được escape \\uXXXX, trả lời \\uXXXX được giải mã lại", async () => {
  const { host, spawnImpl } = make({
    onRequest: (child, request) => child.stdout.write(`@@R@@{"id":"${request.id}","ok":true,"out":"s\\u1eb5n s\\u00e0ng"}\r\n`)
  });
  assert.equal(await host.runScript("printer-status.ps1", { Printer: "Máy in Chỉ" }), "sẵn sàng");
  const line = spawnImpl.children[0].rawLines[0];
  assert.ok(/^[\x00-\x7f]*$/.test(line), "dòng gửi đi phải thuần ASCII");
  assert.match(line, /M\\u00e1y in Ch\\u1ec9/);
  host.stop();
});

test("tuần tự: yêu cầu thứ hai chỉ được gửi khi yêu cầu thứ nhất đã có trả lời", async () => {
  let release;
  const { host, spawnImpl } = make({
    onRequest: (child, request) => {
      if (request.script === "raw-print.ps1") release = () => child.reply(request.id, { ok: true, out: "in xong" });
      else child.reply(request.id, { ok: true, out: "ok" });
    }
  });
  const first = host.runScript("raw-print.ps1", { File: "x", Printer: "p" });
  const second = host.runScript("printer-status.ps1", { Printer: "p" });
  await tick(30);
  assert.equal(spawnImpl.children[0].requests.length, 1, "yêu cầu 2 chưa được gửi");
  release();
  assert.equal(await first, "in xong");
  assert.equal(await second, "ok");
  assert.deepEqual(spawnImpl.children[0].requests.map((r) => r.script), ["raw-print.ps1", "printer-status.ps1"]);
  host.stop();
});

test("script báo lỗi chưa bắt: ném lỗi scriptError nhưng tiến trình vẫn sống cho yêu cầu sau", async () => {
  const { host, spawnImpl } = make({
    onRequest: (child, request) => child.reply(request.id, request.script === "raw-print.ps1" ? { ok: false, error: "Không tìm thấy file TSPL" } : { ok: true, out: "ok" })
  });
  await assert.rejects(host.runScript("raw-print.ps1", { File: "khong-co", Printer: "p" }), (error) => {
    assert.ok(error instanceof PowerShellHostError);
    assert.equal(error.scriptError, true);
    assert.equal(error.requestStarted, true, "đã chạy trong tiến trình: không được coi là chưa bắt đầu");
    assert.match(error.message, /Không tìm thấy file TSPL/);
    return true;
  });
  assert.equal(await host.runScript("printer-status.ps1", { Printer: "p" }), "ok");
  assert.equal(spawnImpl.children.length, 1);
  host.stop();
});

test("tiến trình chết GIỮA yêu cầu: yêu cầu bị từ chối với requestStarted=true; yêu cầu sau mở lại tiến trình mới", async () => {
  const { host, spawnImpl } = make({ onRequest: (child, request) => { if (request.script === "raw-print.ps1") child.die(3); else child.reply(request.id, { ok: true, out: "ok" }); } });
  await assert.rejects(host.runScript("raw-print.ps1", { File: "x", Printer: "p" }), (error) => {
    assert.equal(error.requestStarted, true, "không biết tem đã ra giấy chưa → TUYỆT ĐỐI không được gọi lại");
    assert.equal(error.timeout, false);
    return true;
  });
  assert.equal(await host.runScript("printer-status.ps1", { Printer: "p" }), "ok");
  assert.equal(spawnImpl.children.length, 2);
  host.stop();
});

test("không mở được / không báo sẵn sàng: requestStarted=false (an toàn để gọi lại bằng cách cũ)", async () => {
  const thrown = make({ throwOnSpawn: true });
  await assert.rejects(thrown.host.runScript("raw-print.ps1", {}), (error) => error.requestStarted === false && /spawn EPERM/.test(error.message));
  const silent = make({ neverReady: true }, { startTimeoutMs: 40 });
  await assert.rejects(silent.host.runScript("raw-print.ps1", {}), (error) => error.requestStarted === false && /chưa sẵn sàng/.test(error.message));
  assert.ok(silent.spawnImpl.children[0].killed, "tiến trình không sẵn sàng phải bị giết");
});

test("quá hạn: giết tiến trình, báo timeout (requestStarted=true), lần sau mở lại; trả lời muộn bị bỏ qua", async () => {
  let swallow = true;
  const { host, spawnImpl } = make({ onRequest: (child, request) => { if (!swallow) child.reply(request.id, { ok: true, out: "ok" }); } });
  await assert.rejects(host.runScript("printer-status.ps1", { Printer: "p" }, { timeoutMs: 30 }), (error) => error.timeout === true && error.requestStarted === true);
  assert.ok(spawnImpl.children[0].killed);
  assert.equal(host.running, false);
  swallow = false;
  assert.equal(await host.runScript("printer-status.ps1", { Printer: "p" }), "ok");
  assert.equal(spawnImpl.children.length, 2);
  host.stop();
});

test("dòng lạ trên stdout (cảnh báo của PowerShell) và trả lời không rõ id bị bỏ qua", async () => {
  const { host } = make({
    onRequest: (child, request) => {
      child.stdout.write("WARNING: gì đó\r\n@@R@@{không phải json\r\n");
      child.reply("999", { ok: true, out: "của yêu cầu khác" });
      child.reply(request.id, { ok: true, out: "đúng" });
    }
  });
  assert.equal(await host.runScript("printer-status.ps1", {}), "đúng");
  host.stop();
});

test("chết bất thường liên tiếp → tạm tắt (requestStarted=false) tới hết thời gian nghỉ rồi tự thử lại", async () => {
  let clock = 1_000_000;
  const { host, spawnImpl, logs } = make({ onRequest: (child) => child.die(1) }, { now: () => clock, maxCrashes: 3, crashWindowMs: 60_000, cooldownMs: 300_000 });
  for (let i = 0; i < 3; i += 1) await assert.rejects(host.runScript("printer-status.ps1", {}), (error) => error.requestStarted === true);
  assert.equal(host.disabled, true);
  assert.ok(logs.some((line) => /tạm tắt/.test(line)));
  const before = spawnImpl.children.length;
  await assert.rejects(host.runScript("printer-status.ps1", {}), (error) => error.requestStarted === false && /tạm tắt/.test(error.message));
  assert.equal(spawnImpl.children.length, before, "đang tạm tắt thì không mở tiến trình");
  clock += 300_001;
  assert.equal(host.disabled, false);
  await assert.rejects(host.runScript("printer-status.ps1", {}), (error) => error.requestStarted === true, "hết nghỉ: thử lại (lần này vẫn chết)");
  assert.equal(spawnImpl.children.length, before + 1);
});

test("làm mới tiến trình sau maxRequests yêu cầu (chống rò rỉ bộ nhớ)", async () => {
  const { host, spawnImpl } = make({}, { maxRequests: 3 });
  for (let i = 0; i < 4; i += 1) await host.runScript("printer-status.ps1", {});
  assert.equal(spawnImpl.children.length, 2);
  assert.ok(spawnImpl.children[0].killed);
  assert.equal(host.disabled, false, "làm mới có chủ ý không bị tính là chết bất thường");
  host.stop();
});

test("stop(): yêu cầu đang chờ bị từ chối, tiến trình bị giết, yêu cầu sau báo requestStarted=false", async () => {
  const { host, spawnImpl } = make({ onRequest: () => {} });
  const waiting = host.runScript("printer-status.ps1", {}).catch((error) => error);
  await tick(20);
  host.stop();
  const error = await waiting;
  assert.ok(error instanceof PowerShellHostError && error.requestStarted === true);
  assert.ok(spawnImpl.children[0].killed);
  await assert.rejects(host.runScript("printer-status.ps1", {}), (e) => e.requestStarted === false);
});

test("stop() lúc tiến trình đang khởi động: không để tiến trình mồ côi", async () => {
  const { host, spawnImpl } = make();
  const started = host.runScript("printer-status.ps1", {}).catch((error) => error);
  host.stop();
  await started;
  await tick(20);
  assert.ok(spawnImpl.children.every((child) => child.killed), "mọi tiến trình đã mở phải bị giết");
});
