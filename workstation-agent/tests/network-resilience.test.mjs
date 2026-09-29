import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processClaimedJob } from "../src/agent.mjs";
import { isTransientNetworkError, withRetry } from "../src/network-retry.mjs";
import { createSentJournal } from "../src/sent-journal.mjs";
import { SupabaseQueueClient } from "../src/supabase-queue-client.mjs";

// Tái hiện đúng các lần lỗi thật ở máy kho 25–29/09/2026: mạng tới Supabase
// chập chờn làm lệnh báo "failed" dù máy in bình thường — có lần tem đã ra
// giấy, người dùng bấm in lại nên ra tem trùng.

const noSleep = async () => {};
const silentLogger = { info() {}, warn() {}, error() {} };

// undici ném đúng dạng này khi mất kết nối giữa chừng.
const fetchFailed = (code = "ECONNRESET") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("read " + code), { code }) });
const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
const leaseLost = () => Object.assign(new Error("Không thể hoàn tất lệnh"), { code: "LEASE_LOST", transient: false });

const syntheticJob = (overrides = {}) => ({
  id: "job-test-0001",
  nonce: "nonce-test-0001",
  type: "sku",
  templateVersion: 1,
  copies: 2,
  payload: { sku: "TEST-SKU-01", productName: "Sản phẩm kiểm thử", quantity: "1", printedDate: "29/09/26" },
  ...overrides
});

// Queue giả: mỗi phương thức lần lượt nhả kết quả trong kịch bản (lỗi thì ném),
// hết kịch bản thì trả thành công.
function fakeQueue(script = {}) {
  const calls = [];
  const queue = {};
  for (const method of ["progress", "complete", "fail", "requeue"]) {
    const outcomes = [...(script[method] || [])];
    queue[method] = async (...args) => {
      calls.push({ method, args });
      const outcome = outcomes.shift();
      if (typeof outcome === "function") return outcome(...args);
      if (outcome instanceof Error) throw outcome;
      return { ok: true };
    };
  }
  queue.calls = calls;
  queue.count = (method, stage) => calls.filter((call) => call.method === method && (!stage || call.args[1] === stage)).length;
  return queue;
}

function memoryJournal(initial = {}) {
  const entries = { ...initial };
  return {
    entries,
    get: (jobId) => entries[jobId] ?? null,
    record: (jobId, fields) => { entries[jobId] = { ...entries[jobId], ...fields, updatedAt: new Date().toISOString() }; },
    remove: (jobId) => { delete entries[jobId]; }
  };
}

function fakePrinter(overrides = {}) {
  const printer = {
    sent: 0,
    queryPrinter: async () => ({ ok: true, blocked: false }),
    sendRaw: async () => { printer.sent += 1; return { ok: true, jobId: 21 }; },
    waitForSpooler: async () => ({ ok: true, confirmed: false }),
    ...overrides
  };
  return printer;
}

const fakeRender = async (job, config, onProgress) => {
  await onProgress?.(job.copies, job.copies);
  return Buffer.from("TSPL-TEST");
};

function run(queue, { printer = fakePrinter(), journal = memoryJournal(), input = syntheticJob() } = {}) {
  return processClaimedJob(input, {
    config: { tempDir: os.tmpdir() }, queue, logger: silentLogger, printer, render: fakeRender, journal, wait: noSleep
  }).then((outcome) => ({ outcome, printer, journal }));
}

test("lenh 22f65c10: bao tien do dung tem bi timeout van in va hoan tat, khong bao failed", async () => {
  const queue = fakeQueue({ progress: [{ ok: true }, timeoutError()] });
  const { outcome, printer } = await run(queue);
  assert.equal(outcome.ok, true);
  assert.equal(printer.sent, 1);
  assert.equal(queue.count("fail"), 0);
  assert.equal(queue.count("complete"), 1);
});

test("lenh 706c10a6: tem da ra giay, bao hoan tat bi fetch failed thi thu lai, khong bao failed", async () => {
  const queue = fakeQueue({ complete: [fetchFailed(), fetchFailed("UND_ERR_SOCKET")] });
  const { outcome, printer, journal } = await run(queue);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reported, true);
  assert.equal(printer.sent, 1);
  assert.equal(queue.count("complete"), 3);
  assert.equal(queue.count("fail"), 0);
  assert.deepEqual(journal.entries, {}, "báo được hoàn tất thì xoá khỏi sổ tay");
});

test("mat mang o moc sending: tra ve hang doi, khong gui may in, khong bao failed", async () => {
  const queue = fakeQueue({ progress: [{ ok: true }, { ok: true }, fetchFailed("ENOTFOUND")] });
  const { outcome, printer, journal } = await run(queue);
  assert.equal(outcome.requeued, true);
  assert.equal(printer.sent, 0);
  assert.equal(queue.count("fail"), 0);
  assert.equal(queue.count("requeue"), 1);
  assert.equal(queue.calls.find((call) => call.method === "requeue").args[1].code, "NETWORK_UNSTABLE");
  assert.deepEqual(journal.entries, {});
});

test("tem da in, mat mang qua lau: giu so tay; nhan lai lenh chi bao hoan tat, khong in lan hai", async () => {
  const journal = memoryJournal();
  const down = fakeQueue({ complete: Array.from({ length: 30 }, () => fetchFailed()) });
  const first = await run(down, { journal });
  assert.equal(first.outcome.ok, true);
  assert.equal(first.outcome.reported, false);
  assert.equal(down.count("fail"), 0);
  assert.equal(journal.entries["job-test-0001"].stage, "printed");

  // Hết lease, backend trả lệnh về hàng đợi và agent nhận lại chính lệnh đó.
  const up = fakeQueue();
  const printer = fakePrinter();
  const second = await run(up, { journal, printer });
  assert.equal(second.outcome.recovered, true);
  assert.equal(printer.sent, 0, "không được in lần hai");
  assert.equal(up.count("complete"), 1);
  assert.equal(up.calls[0].args[1].recoveredFromJournal, true);
  assert.deepEqual(journal.entries, {});
});

test("LEASE_LOST khi bao hoan tat: khong bao failed, giu so tay de chong in lai", async () => {
  const queue = fakeQueue({ complete: [leaseLost()] });
  const { outcome, journal } = await run(queue);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.reported, false);
  assert.equal(queue.count("complete"), 1, "lỗi nghiệp vụ không thử lại");
  assert.equal(queue.count("fail"), 0);
  assert.equal(journal.entries["job-test-0001"].stage, "printed");
});

test("so tay ghi da gui nhung chua co ket qua: bao SENT_UNCONFIRMED, khong in lai", async () => {
  const journal = memoryJournal({ "job-test-0001": { stage: "sent", updatedAt: new Date().toISOString() } });
  const queue = fakeQueue();
  const { outcome, printer } = await run(queue, { journal });
  assert.equal(printer.sent, 0);
  assert.equal(outcome.error.code, "SENT_UNCONFIRMED");
  assert.equal(queue.count("fail"), 1);
  assert.deepEqual(journal.entries, {});
});

test("loi may in sau khi gui van bao failed kem pagesPrinted nhu cu", async () => {
  const printer = fakePrinter({
    waitForSpooler: async () => { throw Object.assign(new Error("Máy in đứng yên 10 phút ở trang 3"), { code: "PRINTER_STALLED", pagesPrinted: 3 }); }
  });
  const queue = fakeQueue();
  const { outcome, journal } = await run(queue, { printer });
  assert.equal(outcome.error.code, "PRINTER_STALLED");
  assert.equal(queue.calls.find((call) => call.method === "fail").args[1].pagesPrinted, 3);
  assert.deepEqual(journal.entries, {}, "đã báo được lỗi thì xoá khỏi sổ tay");
});

test("loi khong phai do mang truoc khi gui van bao failed nhu cu", async () => {
  const queue = fakeQueue();
  const printer = fakePrinter();
  const outcome = await processClaimedJob(syntheticJob(), {
    config: { tempDir: os.tmpdir() }, queue, logger: silentLogger, printer, journal: memoryJournal(), wait: noSleep,
    render: async () => { throw new Error("Template hỏng"); }
  });
  assert.equal(outcome.ok, false);
  assert.equal(printer.sent, 0);
  assert.equal(queue.count("fail"), 1);
  assert.equal(queue.count("requeue"), 0);
});

test("nhan dien loi mang tam thoi", () => {
  assert.equal(isTransientNetworkError(fetchFailed()), true);
  assert.equal(isTransientNetworkError(timeoutError()), true);
  assert.equal(isTransientNetworkError(leaseLost()), false);
  assert.equal(isTransientNetworkError(new Error("Template hỏng")), false);
  assert.equal(isTransientNetworkError(new TypeError("Failed to parse URL")), false);
});

test("withRetry chi thu lai loi mang va dung dung so lan", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw fetchFailed(); }, { delaysMs: [1, 1, 1], sleep: noSleep }));
  assert.equal(calls, 4);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls += 1; throw leaseLost(); }, { delaysMs: [1, 1, 1], sleep: noSleep }));
  assert.equal(calls, 1);
});

const clientConfig = { supabaseUrl: "https://example.invalid", supabasePublishableKey: "test-key", agentToken: "test-token", agentId: "may-test", leaseMs: 120000 };
const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function scriptedFetch(outcomes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  fetch.calls = calls;
  return fetch;
}

test("SupabaseQueueClient thu lai khi fetch failed va ghi ro nguyen nhan", async () => {
  const fetch = scriptedFetch([fetchFailed("ECONNRESET"), jsonResponse(503, { message: "busy" }), jsonResponse(200, { ok: true, data: { status: "completed" } })]);
  const warnings = [];
  const client = new SupabaseQueueClient(clientConfig, { fetch, sleep: noSleep, logger: { warn: (line) => warnings.push(line) } });
  assert.deepEqual(await client.complete("job-test-0001", {}), { status: "completed" });
  assert.equal(fetch.calls.length, 3);
  assert.match(warnings[0], /fetch failed \(ECONNRESET: read ECONNRESET\)/);
});

test("SupabaseQueueClient khong thu lai loi nghiep vu va giu ma loi", async () => {
  const fetch = scriptedFetch([jsonResponse(200, { ok: false, error: { code: "LEASE_LOST", message: "Không thể hoàn tất lệnh" } })]);
  const client = new SupabaseQueueClient(clientConfig, { fetch, sleep: noSleep });
  await assert.rejects(client.complete("job-test-0001", {}), (error) => error.code === "LEASE_LOST" && error.transient === false);
  assert.equal(fetch.calls.length, 1);
});

test("SupabaseQueueClient: claim khong thu lai vi vong quet tu goi lai", async () => {
  const fetch = scriptedFetch([fetchFailed()]);
  const client = new SupabaseQueueClient(clientConfig, { fetch, sleep: noSleep });
  await assert.rejects(client.claim({}), (error) => error.code === "NETWORK_ERROR");
  assert.equal(fetch.calls.length, 1);
});

test("SupabaseQueueClient: qua thoi gian cho bao NETWORK_TIMEOUT bang tieng Viet", async () => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const client = new SupabaseQueueClient(clientConfig, { fetch: hang, sleep: noSleep, timeoutMs: 20, retryDelaysMs: [] });
  await assert.rejects(
    client.progress("job-test-0001", "rendering"),
    (error) => error.code === "NETWORK_TIMEOUT" && /không phản hồi/.test(error.message) && error.transient === true
  );
});

test("so tay luu qua lan khoi dong lai, tu don muc qua 7 ngay, file hong thi coi nhu trong", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sent-journal-"));
  try {
    let clock = Date.parse("2026-09-29T04:00:00Z");
    const journal = createSentJournal(dir, { now: () => clock });
    journal.record("job-a", { stage: "sending", copies: 2 });
    journal.record("job-a", { stage: "printed", result: { copies: 2 } });
    assert.equal(createSentJournal(dir).get("job-a").stage, "printed", "đọc lại được sau khi khởi động lại");
    assert.equal(createSentJournal(dir).get("job-a").copies, 2, "ghi nối, không mất trường cũ");

    clock += 8 * 24 * 3600 * 1000;
    journal.record("job-b", { stage: "sent" });
    assert.equal(journal.get("job-a"), null, "mục quá 7 ngày bị dọn");
    journal.remove("job-b");
    assert.equal(journal.get("job-b"), null);

    fs.writeFileSync(journal.file, "{hỏng");
    assert.equal(createSentJournal(dir, { logger: silentLogger }).get("job-b"), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
