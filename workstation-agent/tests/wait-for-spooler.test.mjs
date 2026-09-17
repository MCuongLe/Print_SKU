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

test("khong thay job: xong nhung danh dau chua xac nhan", async () => {
  // TSC PE200 day thang byte ra cong USB nen job khoe khong kip hien trong
  // hang doi. Day la binh thuong, khong phai loi — nhung cung khong chung minh
  // duoc tem da ra giay.
  const state = await waitForSpooler({}, 7, { __query: fakeQuery([ready()]), appearMs: 30, pollMs: 5 });
  assert.equal(state.confirmed, false);
});

test("requireConfirm=true thi khong thay job la loi", async () => {
  await assert.rejects(
    waitForSpooler({}, 7, { __query: fakeQuery([ready()]), appearMs: 30, pollMs: 5, requireConfirm: true }),
    (error) => error.code === "SPOOLER_JOB_MISSING"
  );
});

test("thay job roi moi bien mat thi la in xong", async () => {
  const state = await waitForSpooler({}, 7, {
    __query: fakeQuery([present(0), present(4), ready()]),
    appearMs: 5000, pollMs: 5
  });
  assert.equal(state.targetPresent, false);
  assert.equal(state.confirmed, true);
});

test("job Retained tinh la da in xong", async () => {
  const state = await waitForSpooler({}, 7, {
    __query: fakeQuery([present(2, { targetRetained: true })]),
    pollMs: 5
  });
  assert.equal(state.targetRetained, true);
  assert.equal(state.confirmed, true);
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

const blocked = () => ({ ok: true, blocked: true, code: "PRINTER_BLOCKED", message: "het giay" });

test("het giay roi thay giay xong thi in tiep, khong bo cuoc", async () => {
  // Chinh sach van hanh: uu tien in tiep. Windows giu nguyen job trong hang doi
  // nen nguoi van hanh thay giay xong la chay tiep.
  const state = await waitForSpooler({}, 7, {
    __query: fakeQuery([present(4), blocked(), blocked(), blocked(), present(9), ready()]),
    appearMs: 5000, stallMs: 60000, pollMs: 5
  });
  assert.equal(state.confirmed, true);
});

test("khong ai thay giay qua stallMs thi moi bo cuoc", async () => {
  await assert.rejects(
    waitForSpooler({}, 7, {
      __query: fakeQuery([present(4), blocked()]),
      appearMs: 5000, stallMs: 40, pollMs: 5
    }),
    (error) => error.code === "PRINTER_BLOCKED" && error.pagesPrinted === 4
  );
});

test("cho lau van dap nhip giu lease", async () => {
  // Khong co nhip nay thi lease 2 phut het han trong luc cho thay giay,
  // backend tra lenh ve hang doi va agent in lai lan hai -> trung tem.
  let beats = 0;
  await waitForSpooler({}, 7, {
    __query: fakeQuery([present(4), blocked(), blocked(), blocked(), present(9), ready()]),
    appearMs: 5000, stallMs: 60000, pollMs: 5,
    heartbeatMs: 1,
    onHeartbeat: () => { beats += 1; }
  });
  assert.ok(beats >= 3, `phai co nhip giu lease, dem duoc ${beats}`);
});
