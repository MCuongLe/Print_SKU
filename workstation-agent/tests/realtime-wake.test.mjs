import test from "node:test";
import assert from "node:assert/strict";
import { createRealtimeWake, realtimeUrl } from "../src/realtime-wake.mjs";

// WebSocket giả theo đúng giao diện tối thiểu mà realtime-wake.mjs dùng: readyState, send,
// close, addEventListener(open/message/close). Test tự bơm phản hồi của Realtime.
class FakeSocket extends EventTarget {
  static instances = [];
  constructor(url) {
    super();
    this.url = url; this.readyState = 0; this.sent = []; this.closed = null;
    FakeSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3; this.closed = { code, reason };
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(message) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) })); }
  joinOk() { this.receive({ topic: "realtime:print-queue", event: "phx_reply", payload: { status: "ok", response: { postgres_changes: [] } }, ref: "1" }); }
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const make = (extra = {}) => {
  FakeSocket.instances = [];
  const logs = [];
  const wake = createRealtimeWake({
    supabaseUrl: "https://example.supabase.co", publishableKey: "sb_publishable_test", WebSocketImpl: FakeSocket,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    heartbeatMs: 30, heartbeatTimeoutMs: 40, reconnectMinMs: 5, reconnectMaxMs: 40, ...extra
  });
  return { wake, logs };
};

test("realtimeUrl doi https -> wss, gan apikey va vsn", () => {
  assert.equal(realtimeUrl("https://abc.supabase.co/", "sb_publishable_x"), "wss://abc.supabase.co/realtime/v1/websocket?apikey=sb_publishable_x&vsn=1.0.0");
});

test("mo ket noi la gui phx_join topic cong khai; nhan broadcast thi goi handler voi payload", async () => {
  const { wake } = make();
  const wakes = [];
  wake.start((payload) => wakes.push(payload));
  const socket = FakeSocket.instances[0];
  assert.match(socket.url, /apikey=sb_publishable_test&vsn=1\.0\.0$/);
  socket.open();
  const join = socket.sent[0];
  assert.equal(join.topic, "realtime:print-queue");
  assert.equal(join.event, "phx_join");
  assert.deepEqual(join.payload.config, { broadcast: { ack: false, self: false }, presence: { key: "", enabled: false }, postgres_changes: [], private: false });
  assert.equal(wake.connected(), false, "chua co phx_reply ok thi chua tinh la da noi");
  socket.joinOk();
  assert.equal(wake.connected(), true);
  socket.receive({ topic: "realtime:print-queue", event: "broadcast", payload: { type: "broadcast", event: "queued", payload: { jobId: "j1", type: "sku" } }, ref: null });
  assert.deepEqual(wakes, [{ jobId: "j1", type: "sku" }]);
  socket.receive({ topic: "realtime:khac", event: "broadcast", payload: { type: "broadcast", event: "queued", payload: { jobId: "j2" } } });
  assert.equal(wakes.length, 1, "topic khac thi bo qua");
  wake.stop();
  assert.equal(socket.closed.code, 1000);
});

test("dap nhip heartbeat sau khi vao topic; khong co phan hoi thi dong de noi lai", async () => {
  const { wake, logs } = make();
  wake.start(() => {});
  const socket = FakeSocket.instances[0];
  socket.open(); socket.joinOk();
  await tick(45);
  const heartbeat = socket.sent.find((m) => m.topic === "phoenix" && m.event === "heartbeat");
  assert.ok(heartbeat, "phai gui heartbeat");
  socket.receive({ topic: "phoenix", event: "phx_reply", payload: { status: "ok", response: {} }, ref: heartbeat.ref });
  await tick(45);
  assert.equal(socket.readyState, 1, "co phan hoi thi giu ket noi");
  assert.ok(socket.sent.filter((m) => m.event === "heartbeat").length >= 2, "nhip tiep theo phai duoc len lich");
  await tick(60);
  assert.equal(socket.readyState, 3, "khong phan hoi nhip thi dong ket noi");
  assert.ok(logs.some((m) => /heartbeat/.test(m)));
  wake.stop();
});

test("mat ket noi thi noi lai gian dan, vao lai topic xong thi connected() = true", async () => {
  const { wake } = make();
  wake.start(() => {});
  const first = FakeSocket.instances[0];
  first.open(); first.joinOk();
  first.close(1006, "mang rot");
  assert.equal(wake.connected(), false);
  await tick(12);
  assert.equal(FakeSocket.instances.length, 2, "phai mo ket noi moi sau reconnectMinMs");
  const second = FakeSocket.instances[1];
  second.close(1006, "van rot");
  await tick(6);
  assert.equal(FakeSocket.instances.length, 2, "lan hai phai cho lau hon (5ms -> 10ms)");
  await tick(10);
  assert.equal(FakeSocket.instances.length, 3);
  const third = FakeSocket.instances[2];
  third.open(); third.joinOk();
  assert.equal(wake.connected(), true);
  assert.deepEqual(wake.stats(), { wakes: 0, connects: 2, drops: 1 });
  wake.stop();
});

test("bi tu choi vao topic thi dong va noi lai, khong treo", async () => {
  const { wake, logs } = make();
  wake.start(() => {});
  const socket = FakeSocket.instances[0];
  socket.open();
  socket.receive({ topic: "realtime:print-queue", event: "phx_reply", payload: { status: "error", response: { reason: "Unauthorized" } }, ref: "1" });
  assert.equal(socket.readyState, 3);
  assert.ok(logs.some((m) => /Unauthorized/.test(m)));
  await tick(12);
  assert.equal(FakeSocket.instances.length, 2);
  wake.stop();
});

test("stop() thi khong noi lai nua; WebSocket nem loi luc khoi tao cung khong lam sap", async () => {
  const { wake } = make();
  wake.start(() => {});
  wake.stop();
  await tick(15);
  assert.equal(FakeSocket.instances.length, 1);
  class Broken { constructor() { throw new Error("khong co mang"); } }
  const { wake: broken, logs } = make({ WebSocketImpl: Broken });
  broken.start(() => {});
  await tick(2);
  assert.ok(logs.some((m) => /khong co mang/.test(m)));
  broken.stop();
});
