// Phiên Admin Supabase riêng của Extension (đồng bộ tự động, 17/10/2026).
// Lưu ở chrome.storage.local khoá "auto.session" = {access_token, refresh_token, expires_at (epoch ms), user:{id,email}}.
// Tự gia hạn bằng refresh_token khi còn dưới 60 giây. Gia hạn bị từ chối (400/401/403) → xoá phiên, lỗi SIGNED_OUT;
// lỗi mạng → GIỮ phiên (giống PrintSkuAdminAuth 16/10/2026).
// Dùng được trong service worker (importScripts) và trong Node (require) với storage/fetch giả.
(function (root) {
  const SESSION_KEY = "auto.session";
  const REFRESH_MARGIN_MS = 60 * 1000;

  function sessionError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function chromeStorage() {
    return {
      get: async key => (await chrome.storage.local.get(key))[key],
      set: (key, value) => chrome.storage.local.set({ [key]: value }),
      remove: key => chrome.storage.local.remove(key),
    };
  }

  function createSupabaseSession(options = {}) {
    const config = () => options.config || (typeof SUPABASE_CONFIG !== "undefined" ? SUPABASE_CONFIG : null);
    const storage = () => options.storage || chromeStorage();
    // Gọi root.fetch dạng phương thức: fetch tách khỏi self ném "Illegal invocation" trong service worker.
    const fetchImpl = (...args) => (options.fetch ? options.fetch(...args) : root.fetch(...args));
    const now = () => (options.now ? options.now() : Date.now());
    let refreshing = null;

    function endpoint(path) {
      const current = config();
      if (!current?.url || !current?.key) throw sessionError("NO_CONFIG", "Extension thiếu cấu hình Supabase");
      return { url: `${current.url.replace(/\/$/, "")}${path}`, key: current.key };
    }

    function toSession(data, fallbackUser) {
      if (!data || typeof data.access_token !== "string" || typeof data.refresh_token !== "string" || !data.access_token || !data.refresh_token) {
        throw sessionError("BAD_RESPONSE", "Supabase không trả phiên đăng nhập hợp lệ");
      }
      const expiresIn = Number(data.expires_in);
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000
        : Number.isFinite(Number(data.expires_at)) ? Number(data.expires_at) * 1000 : now() + 3600 * 1000;
      const user = data.user && typeof data.user === "object"
        ? { id: String(data.user.id || fallbackUser?.id || ""), email: String(data.user.email || fallbackUser?.email || "") }
        : { id: String(fallbackUser?.id || ""), email: String(fallbackUser?.email || "") };
      return { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt, user };
    }

    async function postToken(grantType, body) {
      const target = endpoint(`/auth/v1/token?grant_type=${grantType}`);
      let response;
      try {
        response = await fetchImpl(target.url, { method: "POST", headers: { apikey: target.key, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } catch {
        throw sessionError("NETWORK", "Không kết nối được Supabase");
      }
      const data = await response.json().catch(() => ({}));
      return { status: response.status, ok: response.ok, data };
    }

    async function signIn(email, password) {
      const cleanEmail = String(email ?? "").trim().slice(0, 200);
      const secret = String(password ?? "");
      if (!cleanEmail || !secret) throw sessionError("INVALID_INPUT", "Nhập email và mật khẩu");
      const result = await postToken("password", { email: cleanEmail, password: secret });
      if (result.status === 400 || result.status === 401 || result.status === 422) throw sessionError("INVALID_CREDENTIALS", "Sai email hoặc mật khẩu");
      if (result.status === 429) throw sessionError("RATE_LIMITED", "Đăng nhập quá nhiều lần; thử lại sau ít phút");
      if (!result.ok) throw sessionError("AUTH_ERROR", `Supabase trả HTTP ${result.status}`);
      const session = toSession(result.data, { email: cleanEmail });
      await storage().set(SESSION_KEY, session);
      return publicView(session);
    }

    async function refresh(session) {
      const result = await postToken("refresh_token", { refresh_token: session.refresh_token });
      // Trong lúc chờ Supabase, Admin có thể đã Đăng xuất hoặc đăng nhập lại: đọc lại storage, phiên gốc không còn thì bỏ kết quả
      // (không ghi lại phiên đã đăng xuất, không xoá/ghi đè phiên mới).
      const current = await storage().get(SESSION_KEY);
      if (!current || typeof current.access_token !== "string") throw sessionError("SIGNED_OUT", "Extension chưa đăng nhập Admin");
      if (current.refresh_token !== session.refresh_token) return current;
      if (result.status === 400 || result.status === 401 || result.status === 403) {
        await storage().remove(SESSION_KEY);
        throw sessionError("SIGNED_OUT", "Phiên Admin của Extension đã hết; hãy đăng nhập lại");
      }
      if (!result.ok) throw sessionError("AUTH_ERROR", `Supabase trả HTTP ${result.status} khi gia hạn phiên`);
      const next = toSession(result.data, session.user);
      await storage().set(SESSION_KEY, next);
      return next;
    }

    // force = true: gia hạn ngay (Edge vừa trả 401 dù đồng hồ máy còn hạn).
    async function getAccessToken({ force = false } = {}) {
      const session = await storage().get(SESSION_KEY);
      if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") {
        throw sessionError("SIGNED_OUT", "Extension chưa đăng nhập Admin");
      }
      if (!force && Number(session.expires_at) - now() > REFRESH_MARGIN_MS) return session.access_token;
      // Một lần gia hạn tại một thời điểm: refresh_token chỉ dùng được một lần.
      if (!refreshing) refreshing = refresh(session).finally(() => { refreshing = null; });
      return (await refreshing).access_token;
    }

    function publicView(session) {
      if (!session || typeof session.access_token !== "string") return null;
      return { user: { id: String(session.user?.id || ""), email: String(session.user?.email || "") }, expires_at: Number(session.expires_at) || 0 };
    }

    async function getSession() {
      return publicView(await storage().get(SESSION_KEY));
    }

    async function signOut() {
      await storage().remove(SESSION_KEY);
      return { ok: true };
    }

    return { signIn, getAccessToken, getSession, signOut, SESSION_KEY };
  }

  const api = { createSupabaseSession, SESSION_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else {
    root.SupabaseSessionModule = api;
    root.SupabaseSession = createSupabaseSession();
  }
})(typeof self !== "undefined" ? self : globalThis);
