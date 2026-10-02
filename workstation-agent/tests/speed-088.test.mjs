import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processClaimedJob } from "../src/agent.mjs";
import { queryPrinter, sendRaw } from "../src/printer.mjs";
import { PowerShellHostError, createPowerShellHost, setPowerShellHost } from "../src/ps-host.mjs";
import { measureTextWidths } from "../src/text-metrics.mjs";
import { cachedMeasure, createTextCache, footerPatterns, seedFooterPatterns, PROBE_TEXTS } from "../src/text-cache.mjs";
import { createSkuCatalog } from "../src/sku-catalog.mjs";
import { DATE_FONT_SIZES, QUANTITY_FONT_SIZES } from "../src/templates/text-layout.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const silent = { info() {}, warn() {}, error() {} };
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// ============ processClaimedJob: song song nhưng chốt chặn "sending" vẫn nối tiếp ============

const job = () => ({ id: "job-088", nonce: "n-088", type: "sku", templateVersion: 1, copies: 1, payload: { sku: "TEST-SKU-01", productName: "Sản phẩm kiểm thử", quantity: "1", printedDate: "02/10/26" } });
const memoryJournal = () => { const entries = {}; return { entries, get: (id) => entries[id] ?? null, record: (id, fields) => { entries[id] = { ...entries[id], ...fields }; }, remove: (id) => { delete entries[id]; } }; };

function scenario({ progressDelay = {}, printerDelay = 0, printerState = { ok: true, blocked: false }, progressFails = {}, spoolDelay = 0 } = {}) {
  const events = [];
  const mark = (name) => events.push(name);
  const queue = {
    progress: async (id, stage) => {
      mark(`progress:${stage}:start`);
      await tick(progressDelay[stage] ?? 0);
      if (progressFails[stage]) { mark(`progress:${stage}:fail`); throw progressFails[stage]; }
      mark(`progress:${stage}:done`);
      return { ok: true };
    },
    complete: async () => { mark("complete"); return { ok: true }; },
    fail: async () => { mark("fail"); return { ok: true }; },
    requeue: async () => { mark("requeue"); return { ok: true }; }
  };
  const printer = {
    queryPrinter: async () => { mark("printer:start"); await tick(printerDelay); mark("printer:done"); return printerState; },
    sendRaw: async () => { mark("sendRaw"); return { ok: true, jobId: 7 }; },
    waitForSpooler: async () => { mark("waitForSpooler"); await tick(spoolDelay); return { ok: true, confirmed: false }; }
  };
  const render = async () => { mark("render"); await tick(5); return Buffer.from("TSPL"); };
  const run = () => processClaimedJob(job(), { config: { tempDir: os.tmpdir() }, queue, logger: silent, printer, render, journal: memoryJournal(), wait: async () => {} });
  return { events, run };
}

test("0.8.8: báo 'rendering' chạy song song với kiểm tra máy in; 'sending' chỉ sau khi 'rendering' báo xong", async () => {
  const { events, run } = scenario({ progressDelay: { rendering: 40 }, printerDelay: 15 });
  const outcome = await run();
  assert.equal(outcome.ok, true);
  assert.ok(events.indexOf("progress:rendering:start") < events.indexOf("printer:done"), "báo rendering đã bắt đầu trước khi kiểm tra máy in xong");
  assert.ok(events.indexOf("printer:start") < events.indexOf("progress:rendering:done"), "hai việc chồng lên nhau");
  assert.ok(events.indexOf("progress:rendering:done") < events.indexOf("progress:sending:start"), "chốt chặn sending phải chờ rendering");
  assert.ok(events.indexOf("progress:sending:done") < events.indexOf("sendRaw"), "không gửi byte nào trước khi báo sending thành công");
});

test("báo 'rendering' lỗi (vd mất lease): dừng TRƯỚC khi báo sending và gửi máy in, không bao giờ in", async () => {
  const lease = Object.assign(new Error("Không thể hoàn tất lệnh"), { code: "LEASE_LOST", transient: false });
  const { events, run } = scenario({ progressFails: { rendering: lease }, progressDelay: { rendering: 20 } });
  const outcome = await run();
  assert.equal(outcome.ok, false);
  assert.ok(!events.includes("sendRaw"), "không được gửi xuống máy in");
  assert.ok(!events.includes("progress:sending:start"), "không được báo sending");
});

test("máy in kẹt: vẫn báo xong 'rendering' rồi mới trả lệnh về hàng đợi (đúng thứ tự sự kiện), không dựng tem", async () => {
  const { events, run } = scenario({ printerState: { ok: true, blocked: true, code: "PAPER_OUT", message: "Hết giấy" }, progressDelay: { rendering: 30 } });
  const outcome = await run();
  assert.equal(outcome.requeued, true);
  assert.ok(events.indexOf("progress:rendering:done") < events.indexOf("requeue"));
  assert.ok(!events.includes("render") && !events.includes("sendRaw"));
});

test("báo 'spooling' không chặn việc dò spooler, nhưng xong trước khi báo hoàn tất", async () => {
  const { events, run } = scenario({ progressDelay: { spooling: 60 }, spoolDelay: 5 });
  const outcome = await run();
  assert.equal(outcome.ok, true);
  assert.ok(events.indexOf("waitForSpooler") < events.indexOf("progress:spooling:done"), "dò spooler bắt đầu khi 'spooling' còn đang báo");
  assert.ok(events.indexOf("progress:spooling:done") < events.indexOf("complete"), "'spooling' không bao giờ đến sau 'completed'");
});

// ============ printer.mjs: đường đi qua PowerShell thường trực ============

const fakeHost = (impl) => ({ runScript: impl, init: async () => "ready", stop() {} });
const config = { rootDir, tempDir: fs.mkdtempSync(path.join(os.tmpdir(), "speed-088-")), printerName: "KHONG-CO-MAY-IN-NAY" };

test("queryPrinter dùng host khi có (truyền đúng tên máy in/JobId); host lỗi thì rơi về cách cũ", async () => {
  const seen = [];
  setPowerShellHost(fakeHost(async (script, args) => { seen.push([script, args]); return '{"ok":true,"blocked":false,"code":"READY","message":"sẵn sàng"}\r\n'; }));
  try {
    const state = await queryPrinter({ ...config, printerName: "TSC PE200 (Copy 1)" }, 42);
    assert.deepEqual(state, { ok: true, blocked: false, code: "READY", message: "sẵn sàng" });
    assert.deepEqual(seen[0], ["printer-status.ps1", { Printer: "TSC PE200 (Copy 1)", JobId: 42 }]);
    await queryPrinter({ ...config, printerName: "X" });
    assert.deepEqual(seen[1][1], { Printer: "X" }, "không có JobId thì không gửi trường JobId");
    setPowerShellHost(fakeHost(async () => { throw new PowerShellHostError("host hỏng", { requestStarted: true }); }));
    if (process.platform === "win32") {
      const fallback = await queryPrinter(config);
      assert.equal(fallback.ok, false);
      assert.equal(fallback.code, "PRINTER_NOT_FOUND", "rơi về powershell.exe thật và hỏi máy in giả");
    }
  } finally { setPowerShellHost(null); }
});

test("sendRaw: yêu cầu ĐÃ tới tiến trình mà tiến trình chết/quá hạn → ném lỗi, KHÔNG gọi lại bằng cách cũ (tránh in trùng)", async () => {
  let hostCalls = 0;
  setPowerShellHost(fakeHost(async () => { hostCalls += 1; throw new PowerShellHostError("PowerShell dừng đột ngột", { requestStarted: true }); }));
  try {
    await assert.rejects(sendRaw(config, Buffer.from("TSPL"), "j1"), /dừng đột ngột/);
    assert.equal(hostCalls, 1, "chỉ đúng một lần gửi");
    assert.deepEqual(fs.readdirSync(config.tempDir).filter((name) => name.endsWith(".tspl")), [], "file tạm đã được dọn");
  } finally { setPowerShellHost(null); }
});

test("sendRaw: gửi qua host đúng tham số; kết quả ok:false của script thành lỗi như cũ", async () => {
  const seen = [];
  setPowerShellHost(fakeHost(async (script, args, options) => { seen.push([script, args, options]); return '{"jobId":0,"ok":false,"message":"OpenPrinter lỗi 1801"}'; }));
  try {
    await assert.rejects(sendRaw({ ...config, printerName: "TSC PE200 (Copy 1)" }, Buffer.from("TSPL"), "j2"), /OpenPrinter lỗi 1801/);
    assert.equal(seen[0][0], "raw-print.ps1");
    assert.equal(seen[0][1].Printer, "TSC PE200 (Copy 1)");
    assert.match(seen[0][1].File, /j2-\d+\.tspl$/);
    assert.equal(seen[0][2].timeoutMs, 45000);
  } finally { setPowerShellHost(null); }
});

test("sendRaw: yêu cầu CHƯA tới tiến trình (host không mở được) → được rơi về cách cũ", { skip: process.platform !== "win32" }, async () => {
  setPowerShellHost(fakeHost(async () => { throw new PowerShellHostError("không mở được", { requestStarted: false }); }));
  try {
    // Rơi về powershell.exe thật nhưng chỉ tới MÁY IN GIẢ → bị từ chối, không in gì.
    await assert.rejects(sendRaw(config, Buffer.from("SIZE 40 mm,60 mm\r\nCLS\r\nPRINT 1\r\n"), "j3"), /OpenPrinter lỗi/);
  } finally { setPowerShellHost(null); }
});

test("đo chữ: dùng host khi có (tên script + file vào/ra), host lỗi thì rơi về cách cũ", { skip: process.platform !== "win32" }, async () => {
  const seen = [];
  setPowerShellHost(fakeHost(async (script, args) => { seen.push([script, Object.keys(args)]); throw new PowerShellHostError("hỏng"); }));
  try {
    const widths = await measureTextWidths(config, ["Chỉ ", "may"], [22]);
    assert.deepEqual(seen[0], ["measure-text.ps1", ["InputFile", "OutputFile"]]);
    assert.ok(widths.get("may").get(22) > 0, "đã rơi về powershell.exe và đo được");
  } finally { setPowerShellHost(null); }
});

// ============ PowerShell thường trực THẬT (chỉ Windows) — chỉ việc an toàn, máy in giả ============

test("host thật: đo chữ, hỏi máy in giả (script exit 1), gửi tới máy in giả bị từ chối; tiến trình sống suốt", { skip: process.platform !== "win32" }, async () => {
  const host = createPowerShellHost({ rootDir, logger: silent });
  setPowerShellHost(host);
  try {
    await host.init();
    const widths = await measureTextWidths(config, ["Chỉ may ", "N0144"], [22, 16]);
    assert.ok(widths.get("Chỉ may ").get(22) > widths.get("Chỉ may ").get(16));
    const missing = await queryPrinter(config);
    assert.deepEqual([missing.ok, missing.blocked, missing.code], [false, true, "PRINTER_NOT_FOUND"]);
    await assert.rejects(sendRaw(config, Buffer.from("SIZE 40 mm,60 mm\r\nCLS\r\nPRINT 1\r\n"), "thuc"), /OpenPrinter lỗi/);
    assert.equal(await host.ping(), "pong");
    assert.equal(host.running, true);
    assert.ok(host.served >= 4);
  } finally { setPowerShellHost(null); host.stop(); }
});

test("raw-print.ps1 chạy trực tiếp (cách cũ) vẫn trả đúng JSON sau khi tách kiểu dữ liệu ra file riêng", { skip: process.platform !== "win32" }, async () => {
  const { execFile } = await import("node:child_process");
  const file = path.join(config.tempDir, "x.tspl");
  fs.writeFileSync(file, "SIZE 40 mm,60 mm\r\nCLS\r\nPRINT 1\r\n");
  const stdout = await new Promise((resolve) => execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(rootDir, "powershell", "raw-print.ps1"), "-File", file, "-Printer", "KHONG-CO-MAY-IN-NAY"], { windowsHide: true, timeout: 30000 }, (error, out) => resolve(out)));
  const result = JSON.parse(stdout.trim());
  assert.equal(result.ok, false);
  assert.match(result.message, /OpenPrinter lỗi 1801/);
});

test("script có chữ tiếng Việt có BOM UTF-8; host.ps1 và kiểu dữ liệu thuần ASCII", () => {
  const read = (name) => fs.readFileSync(path.join(rootDir, "powershell", name));
  for (const name of ["printer-status.ps1", "raw-print.ps1"]) assert.deepEqual([...read(name).subarray(0, 3)], [0xef, 0xbb, 0xbf], `${name} thiếu BOM`);
  for (const name of ["host.ps1", "raw-printer-type.ps1"]) assert.ok(read(name).every((byte) => byte < 0x80), `${name} phải thuần ASCII`);
});

// ============ cache đo chữ theo mẫu chữ số ============

// Font giả: mỗi ký tự rộng `w` × cỡ; chữ số "1" hẹp hơn nếu digitsUniform = false (như font không tabular).
function fakeFont({ uniform = true } = {}) {
  const calls = [];
  const charWidth = (c) => (/[0-9]/.test(c) ? (uniform || c !== "1" ? 0.56 : 0.3) : /[.\/]/.test(c) ? 0.28 : 0.5);
  const table = (texts, sizes) => new Map(texts.map((t) => [t, new Map(sizes.map((s) => [s, Math.round([...t].reduce((n, c) => n + charWidth(c), 0) * s * 100) / 100]))]));
  const fn = async (cfg, texts, sizes, options = {}) => {
    if (texts.join() !== PROBE_TEXTS.join()) calls.push({ texts: [...texts], extra: (options.extra || []).map((g) => [...g.texts]) });
    return Object.assign(table(texts, sizes), { extra: (options.extra || []).map((g) => table(g.texts, g.sizes)) });
  };
  fn.calls = calls;
  return fn;
}
const newCache = (file, version = "t") => createTextCache({ file: file ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dc-")), "c.json"), version, saveDelayMs: 0 });

test("font có chữ số đều nhau: số lượng/ngày lần nào cũng khác vẫn trúng cache, kết quả đúng bề rộng thật", async () => {
  const base = fakeFont();
  const cache = newCache();
  const measure = cachedMeasure(base, cache);
  const opts = (q, d) => ({ extra: [{ texts: [q], sizes: QUANTITY_FONT_SIZES }, { texts: [d], sizes: DATE_FONT_SIZES }] });
  const first = await measure({}, ["Chỉ may "], [22], opts("28.571.429", "02/10/26"));
  assert.equal(cache.digitsUniform, true);
  const callsAfterFirst = base.calls.length;
  const second = await measure({}, ["Chỉ may "], [22], opts("99.123.456", "31/12/99"));
  assert.equal(base.calls.length, callsAfterFirst, "số lượng và ngày khác nhưng cùng mẫu chữ số → không gọi PowerShell");
  const truth = (await base({}, ["99.123.456"], QUANTITY_FONT_SIZES)).get("99.123.456");
  for (const size of QUANTITY_FONT_SIZES) assert.equal(second.extra[0].get("99.123.456").get(size), truth.get(size), `cỡ ${size}`);
  assert.equal(first.extra[0].get("28.571.429").get(40), second.extra[0].get("99.123.456").get(40), "cùng mẫu thì cùng bề rộng");
  const callsBeforeNewPattern = base.calls.length;   // đã tính cả lần tự gọi base lấy đáp án thật ở trên
  await measure({}, ["Chỉ may "], [22], opts("1.234", "02/10/26"));
  assert.equal(base.calls.length, callsBeforeNewPattern + 1, "mẫu khác (ít chữ số hơn) thì đo mới đúng một lần");
});

test("font KHÔNG có chữ số đều nhau: tự tắt cách gộp, mỗi số đo riêng", async () => {
  const base = fakeFont({ uniform: false });
  const cache = newCache();
  const measure = cachedMeasure(base, cache);
  await measure({}, ["a"], [22], { extra: [{ texts: ["1.111"], sizes: [40] }] });
  await measure({}, ["a"], [22], { extra: [{ texts: ["9.999"], sizes: [40] }] });
  assert.equal(cache.digitsUniform, false);
  assert.equal(base.calls.length, 2, "1.111 và 9.999 rộng khác nhau nên phải đo riêng");
});

test("đổi font từ đều sang không đều (hoặc ngược lại) giữa hai lần chạy: xoá cache, không dùng nhầm khoá gộp", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dc-")), "c.json");
  const first = newCache(file);
  await cachedMeasure(fakeFont({ uniform: true }), first)({}, ["x"], [22], { extra: [{ texts: ["5.555"], sizes: [40] }] });
  first.flush();
  const reopened = newCache(file);
  assert.ok(reopened.size > 0);
  await reopened.ensureValid(fakeFont({ uniform: false }), {});
  assert.equal(reopened.size, 0, "cách gộp chữ số đổi → khoá cũ vô nghĩa");
  assert.equal(reopened.digitsUniform, false);
  assert.notEqual(reopened.generation, first.generation);
});

test("nạp sẵn mẫu số lượng/ngày: lần in sau với số lượng/ngày bất kỳ không gọi PowerShell nữa", async () => {
  const base = fakeFont();
  const cache = newCache();
  const measure = cachedMeasure(base, cache);
  await seedFooterPatterns(measure, {}, { quantitySizes: QUANTITY_FONT_SIZES, dateSizes: DATE_FONT_SIZES });
  const seeded = base.calls.length;
  assert.equal(seeded, 1, "một lần gọi cho tất cả mẫu");
  const { quantities, dates } = footerPatterns();
  assert.ok(quantities.includes("00.000.000") && quantities.includes("0") && quantities.includes("0.000.000.000"));
  assert.ok(dates.includes("00/00/00") && dates.includes("00-00-00"));
  for (const [q, d] of [["300", "02/10/26"], ["28.571.429", "30-09-26"], ["300.000.000", "11/11/11"], ["999.999.999.999", "01/01/2026"]]) {
    await measure({}, [], [], { extra: [{ texts: [q], sizes: QUANTITY_FONT_SIZES }, { texts: [d], sizes: DATE_FONT_SIZES }] });
  }
  assert.equal(base.calls.length, seeded, "mọi số lượng/ngày thường gặp đã trúng cache");
  await seedFooterPatterns(measure, {}, { quantitySizes: QUANTITY_FONT_SIZES, dateSizes: DATE_FONT_SIZES });
  assert.equal(base.calls.length, seeded, "nạp lần hai không đo lại");
});

// ============ đo sẵn danh mục: PowerShell hỏng giữa chừng không được đánh dấu "đã đo" ============

test("đo sẵn khi PowerShell hỏng: KHÔNG đánh dấu 'đã đo'; sống lại thì đo tiếp đúng các tên đó", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "warm-"));
  let broken = false;
  const base = fakeFont();
  const flaky = async (cfg, texts, sizes, options) => { if (broken && texts.join() !== PROBE_TEXTS.join()) throw new Error("PowerShell không chạy được"); return base(cfg, texts, sizes, options); };
  const cache = createTextCache({ file: path.join(dir, "c.json"), version: "w", saveDelayMs: 0 });
  const measureText = cachedMeasure(flaky, cache);
  const names = ["Chỉ may/Roman N0144/Be/5000m/mm", "Nút bấm/T09/POM/Dark Blue/9mm/pcs", "Vải Pique/SK9115/Navy/g"];
  const rows = names.map((name, i) => ({ sku: String(900000001 + i), product_name: name, status: "1" }));
  const fetchImpl = async (url, init) => {
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.includes("select=updated_at")) return ok([{ updated_at: "2026-10-02T00:55:00+00:00" }]);
    const [from, to] = init.headers.Range.split("-").map(Number);
    return ok(rows.slice(from, to + 1));
  };
  const warns = [];
  const catalog = createSkuCatalog({ config: { supabaseUrl: "https://x", supabasePublishableKey: "k" }, measureText, textCache: cache, baseMeasure: flaky,
    logger: { info() {}, warn: (m) => warns.push(m) }, file: path.join(dir, "k.json"), fetchImpl, sleep: async () => {}, chunkSize: 2, pageSize: 10 });
  await catalog.refresh();
  await cache.ensureValid(flaky, {});
  broken = true;
  await assert.rejects(catalog.warm(), /Đo chữ thật thất bại/);
  assert.equal(catalog.warmedCount, 0, "không tên nào được đánh dấu 'đã đo'");
  broken = false;
  assert.equal(await catalog.warm(), 3, "PowerShell sống lại → đo đủ cả 3 tên");
  assert.equal(catalog.warmedCount, 3);
});
