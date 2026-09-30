// Nhận tín hiệu "có lệnh mới" từ Supabase Realtime để agent khỏi hỏi hàng đợi mỗi giây.
//
// Giao thức Phoenix của Realtime đủ đơn giản để dùng WebSocket có sẵn của Node 22+ (không
// thêm thư viện): nối tới /realtime/v1/websocket, gửi phx_join vào topic công khai
// `realtime:print-queue`, đập nhịp heartbeat mỗi 25 giây, nhận sự kiện `broadcast` do trigger
// print_jobs_wake_agent (supabase/print_queue_v5_realtime_wake.sql) phát ra.
//
// Mất kết nối thì tự nối lại (giãn 1s → 30s). Tín hiệu này chỉ là "đánh thức": agent vẫn
// tự hỏi hàng đợi định kỳ (agent.mjs) nên sự kiện bị lỡ chỉ làm chậm, không mất lệnh.

const HEARTBEAT_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function realtimeUrl(supabaseUrl, publishableKey) {
  const base = String(supabaseUrl).replace(/\/$/, "").replace(/^http/, "ws");
  return `${base}/realtime/v1/websocket?apikey=${encodeURIComponent(publishableKey)}&vsn=1.0.0`;
}

export function createRealtimeWake({ supabaseUrl, publishableKey, topic = "print-queue", logger, WebSocketImpl = globalThis.WebSocket,
  heartbeatMs = HEARTBEAT_MS, heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS, reconnectMinMs = RECONNECT_MIN_MS, reconnectMaxMs = RECONNECT_MAX_MS,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let socket = null;
  let joined = false;
  let stopped = false;
  let ref = 0;
  let retryMs = reconnectMinMs;
  let heartbeatTimer = null;
  let heartbeatDeadline = null;
  let reconnectTimer = null;
  let onWake = () => {};
  const events = { wakes: 0, connects: 0, drops: 0 };

  const send = (target, event, payload) => {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify({ topic: target, event, payload, ref: String(++ref) }));
    return true;
  };

  const clearTimers = () => {
    if (heartbeatTimer) clearTimer(heartbeatTimer);
    if (heartbeatDeadline) clearTimer(heartbeatDeadline);
    heartbeatTimer = heartbeatDeadline = null;
  };

  const heartbeat = () => {
    if (!send("phoenix", "heartbeat", {})) return;
    // Không có phản hồi nhịp = đường truyền chết lặng (Wi-Fi rớt) mà TCP chưa biết: đóng để nối lại.
    heartbeatDeadline = setTimer(() => {
      logger?.warn?.("Realtime: không nhận được phản hồi heartbeat, nối lại");
      socket?.close(4000, "heartbeat timeout");
    }, heartbeatTimeoutMs);
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    const delay = retryMs;
    retryMs = Math.min(reconnectMaxMs, retryMs * 2);
    reconnectTimer = setTimer(() => { reconnectTimer = null; connect(); }, delay);
  };

  const handleMessage = (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.topic === "phoenix" && message.event === "phx_reply") {
      if (heartbeatDeadline) clearTimer(heartbeatDeadline);
      heartbeatDeadline = null;
      heartbeatTimer = setTimer(heartbeat, heartbeatMs);
      return;
    }
    if (message.topic !== `realtime:${topic}`) return;
    if (message.event === "phx_reply") {
      if (message.payload?.status === "ok") {
        joined = true;
        retryMs = reconnectMinMs;
        events.connects += 1;
        logger?.info?.(`Realtime: đã nghe topic ${topic}`);
        heartbeatTimer = setTimer(heartbeat, heartbeatMs);
      } else {
        logger?.warn?.(`Realtime: không vào được topic ${topic}: ${JSON.stringify(message.payload).slice(0, 200)}`);
        socket?.close(4001, "join rejected");
      }
      return;
    }
    if (message.event === "broadcast") {
      events.wakes += 1;
      onWake(message.payload?.payload ?? {});
      return;
    }
    if (message.event === "phx_error" || message.event === "phx_close") {
      logger?.warn?.(`Realtime: topic ${topic} báo ${message.event}, nối lại`);
      socket?.close(4002, message.event);
    }
  };

  const connect = () => {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocketImpl(realtimeUrl(supabaseUrl, publishableKey));
    } catch (error) {
      logger?.warn?.(`Realtime: không mở được kết nối: ${error?.message || error}`);
      scheduleReconnect();
      return;
    }
    socket = ws;
    ws.addEventListener("open", () => {
      if (ws !== socket) return;
      send(`realtime:${topic}`, "phx_join", {
        config: { broadcast: { ack: false, self: false }, presence: { key: "", enabled: false }, postgres_changes: [], private: false },
        access_token: publishableKey
      });
    });
    ws.addEventListener("message", (event) => { if (ws === socket) handleMessage(event.data); });
    ws.addEventListener("error", () => { /* sự kiện close theo sau sẽ lo việc nối lại */ });
    ws.addEventListener("close", (event) => {
      if (ws !== socket) return;
      const wasJoined = joined;
      joined = false;
      socket = null;
      clearTimers();
      if (stopped) return;
      if (wasJoined) events.drops += 1;
      logger?.warn?.(`Realtime: mất kết nối (mã ${event?.code ?? "?"}), thử lại sau ${Math.round(retryMs / 1000)}s`);
      scheduleReconnect();
    });
  };

  return {
    start(handler) {
      onWake = typeof handler === "function" ? handler : onWake;
      stopped = false;
      if (!socket) connect();
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimer(reconnectTimer);
      reconnectTimer = null;
      clearTimers();
      const ws = socket;
      socket = null;
      joined = false;
      try { ws?.close(1000, "stop"); } catch { /* đã đóng */ }
    },
    connected: () => joined,
    stats: () => ({ ...events })
  };
}
