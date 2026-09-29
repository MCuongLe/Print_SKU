// Lỗi mạng TẠM THỜI giữa agent và hàng đợi: mất kết nối, DNS, quá thời gian
// chờ, gateway 5xx. Lỗi nghiệp vụ của hàng đợi (LEASE_LOST, AGENT_DENIED…)
// không thuộc nhóm này và không bao giờ được thử lại.
//
// Ngày 25–29/09/2026 máy kho có 5 lệnh báo "failed" chỉ vì mạng chập chờn:
// 2 lệnh "The operation was aborted due to timeout" (DOMException mã 23) khi
// chưa gửi xuống máy in, 3 lệnh "fetch failed" khi tem ĐÃ ra giấy.
const TRANSIENT_CAUSE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT",
  "ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET", "UND_ERR_CLOSED"
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isTransientNetworkError(error) {
  if (!error) return false;
  if (typeof error.transient === "boolean") return error.transient;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  if (TRANSIENT_CAUSE_CODES.has(error.cause?.code) || TRANSIENT_CAUSE_CODES.has(error.code)) return true;
  // undici chỉ ném "TypeError: fetch failed"; nguyên nhân thật nằm trong error.cause.
  return error instanceof TypeError && /fetch failed/i.test(String(error.message));
}

// "fetch failed" trần trụi không nói được lỗi do Wi-Fi, DNS hay tường lửa;
// kéo mã và thông điệp của error.cause ra cho log và print_events.
export function describeNetworkError(error) {
  const base = String(error?.message || error);
  const cause = error?.cause;
  const detail = [cause?.code, cause?.message].filter(Boolean).join(": ");
  return detail && !base.includes(detail) ? `${base} (${detail})` : base;
}

export function toNetworkError(label, error, timeoutMs) {
  const timedOut = error?.name === "TimeoutError";
  const message = timedOut
    ? `${label}: quá ${Math.round(timeoutMs / 1000)} giây không phản hồi`
    : `${label}: ${describeNetworkError(error)}`;
  return Object.assign(new Error(message, { cause: error }), {
    code: timedOut ? "NETWORK_TIMEOUT" : "NETWORK_ERROR",
    transient: isTransientNetworkError(error)
  });
}

// Chạy lại operation sau mỗi khoảng trong delaysMs, chỉ khi lỗi là lỗi mạng tạm thời.
export async function withRetry(operation, { delaysMs = [], shouldRetry = isTransientNetworkError, onRetry, sleep = defaultSleep } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= delaysMs.length || !shouldRetry(error)) throw error;
      onRetry?.(error, attempt + 1, delaysMs[attempt]);
      await sleep(delaysMs[attempt]);
    }
  }
}
