import test from "node:test";
import assert from "node:assert/strict";
import { waitForSpooler } from "../src/printer.mjs";

// queryPrinter gọi PowerShell nên test bơm sẵn chuỗi trạng thái qua fakeConfig.
// printer.mjs không cho tiêm hàm nên ta chặn ở tầng execFile bằng cách thay
// thế module là quá nặng; thay vào đó dùng một bản sao logic qua tham số poll.
function fakeQuery(states) {
  let index = 0;
  return async () => states[Math.min(index++, states.length - 1)];
}

// waitForSpooler dùng queryPrinter nội bộ, nên test đi qua cửa options.__query
// (thêm ở printer.mjs để test được mà không phải dựng cả Windows Spooler).
const ready = (extra = {}) => ({ ok: true, blocked: false, targetPresent: false, ...extra });
const present = (pages, extra = {}) => ({
  ok: true, blocked: false, targetPresent: true, targetPagesPrinted: pages, ...extra
});

test("job chua kip hien ra thi khong duoc coi la da in xong", async () => {
  // Đây chính là lỗi cũ: lần quét đầu không thấy job nên báo hoàn tất ngay.
  await assert.rejects(
    waitForSpooler({}, 7, { __query: fakeQuery([ready()]), appearMs: 50, pollMs: 5 }),
    (error) => error.code === "SPOOLER_JOB_MISSING"
  );
});

test("thay job roi moi bien mat thi la in xong", async () => {
  const state = await waitForSpooler({}, 7, {
    __query: fakeQuery([present(0), present(4), ready()]),
    appearMs: 5000, pollMs: 5
  });
  assert.equal(state.targetPresent, false);
});

test("job Retained tinh la da in xong", async () => {
  const state = await waitForSpooler({}, 7, {
    __query: fakeQuery([present(2, { targetRetained: true })]),
    pollMs: 5
  });
  assert.equal(state.targetRetained, true);
});

test("het giay: so trang dung yen thi bao loi kem so trang da in", async () => {
  await assert.rejects(
    waitForSpooler({}, 7, {
      __query: fakeQuery([present(12), present(12), present(12)]),
      stallMs: 40, pollMs: 5
    }),
    (error) => error.code === "PRINTER_STALLED" && error.pagesPrinted === 12
  );
});

test("may in bao loi thi dung ngay", async () => {
  await assert.rejects(
    waitForSpooler({}, 7, {
      __query: fakeQuery([{ ok: true, blocked: true, code: "PRINTER_BLOCKED", message: "hết giấy" }]),
      pollMs: 5
    }),
    (error) => error.code === "PRINTER_BLOCKED"
  );
});
