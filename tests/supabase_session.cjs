// Phiên Admin Supabase riêng của Extension (extension/inside-po-connector/supabase-session.js), fetch + storage giả.
//   node tests/supabase_session.cjs
const assert = require("node:assert/strict");
const { createSupabaseSession, SESSION_KEY } = require("../extension/inside-po-connector/supabase-session.js");

const CONFIG = { url: "https://example.invalid", key: "test-publishable-key" };
function memoryStorage() {
  const data = {};
  return { data, get: async key => data[key], set: async (key, value) => { data[key] = JSON.parse(JSON.stringify(value)); }, remove: async key => { delete data[key]; } };
}
function reply(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body }; }

(async () => {
  let clock = 1_000_000;
  const calls = [];
  let next = [];
  const fetch = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); const item = next.shift(); if (item instanceof Error) throw item; return item; };
  const storage = memoryStorage();
  const session = createSupabaseSession({ config: CONFIG, storage, fetch, now: () => clock });

  // Đăng nhập đúng: lưu phiên, expires_at = now + expires_in.
  next = [reply(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, user: { id: "user-1", email: "admin-test@example.com" } })];
  const signed = await session.signIn(" admin-test@example.com ", "mat-khau");
  assert.equal(calls[0].url, "https://example.invalid/auth/v1/token?grant_type=password");
  assert.equal(calls[0].init.headers.apikey, "test-publishable-key");
  assert.deepEqual(calls[0].body, { email: "admin-test@example.com", password: "mat-khau" });
  assert.deepEqual(storage.data[SESSION_KEY], { access_token: "access-1", refresh_token: "refresh-1", expires_at: clock + 3600 * 1000, user: { id: "user-1", email: "admin-test@example.com" } });
  assert.equal(signed.access_token, undefined, "kết quả trả ra không chứa token");
  assert.deepEqual((await session.getSession()).user, { id: "user-1", email: "admin-test@example.com" });

  // Còn hạn > 60 giây: không gọi mạng.
  assert.equal(await session.getAccessToken(), "access-1");
  assert.equal(calls.length, 1);

  // Sắp hết hạn (< 60 giây): gia hạn bằng refresh_token, giữ user cũ khi Supabase không trả user.
  clock += 3600 * 1000 - 30 * 1000;
  next = [reply(200, { access_token: "access-2", refresh_token: "refresh-2", expires_in: 3600 })];
  assert.equal(await session.getAccessToken(), "access-2");
  assert.equal(calls[1].url, "https://example.invalid/auth/v1/token?grant_type=refresh_token");
  assert.deepEqual(calls[1].body, { refresh_token: "refresh-1" });
  assert.equal(storage.data[SESSION_KEY].refresh_token, "refresh-2");
  assert.equal(storage.data[SESSION_KEY].user.email, "admin-test@example.com");

  // Hai lời gọi cùng lúc chỉ gia hạn một lần (refresh_token dùng một lần).
  next = [reply(200, { access_token: "access-3", refresh_token: "refresh-3", expires_in: 3600 })];
  const both = await Promise.all([session.getAccessToken({ force: true }), session.getAccessToken({ force: true })]);
  assert.deepEqual(both, ["access-3", "access-3"]);
  assert.equal(calls.length, 3);

  // Lỗi mạng khi gia hạn: GIỮ phiên, ném lỗi mạng.
  clock += 3600 * 1000;
  next = [new TypeError("Failed to fetch")];
  await assert.rejects(session.getAccessToken(), error => error.code === "NETWORK" && /Không kết nối được Supabase/.test(error.message));
  assert.equal(storage.data[SESSION_KEY].refresh_token, "refresh-3", "lỗi mạng không xoá phiên");

  // Supabase 5xx khi gia hạn: giữ phiên.
  next = [reply(503, {})];
  await assert.rejects(session.getAccessToken(), error => error.code === "AUTH_ERROR");
  assert.ok(storage.data[SESSION_KEY]);

  // Gia hạn bị từ chối 401 → xoá phiên, SIGNED_OUT.
  next = [reply(401, { error: "invalid_grant" })];
  await assert.rejects(session.getAccessToken(), error => error.code === "SIGNED_OUT" && /đăng nhập lại/.test(error.message));
  assert.equal(storage.data[SESSION_KEY], undefined);
  assert.equal(await session.getSession(), null);
  await assert.rejects(session.getAccessToken(), error => error.code === "SIGNED_OUT");

  // Sai mật khẩu 400; lỗi mạng khi đăng nhập; thiếu dữ liệu.
  next = [reply(400, { error: "invalid_grant" })];
  await assert.rejects(session.signIn("admin-test@example.com", "sai"), /Sai email hoặc mật khẩu/);
  next = [new TypeError("Failed to fetch")];
  await assert.rejects(session.signIn("admin-test@example.com", "x"), /Không kết nối được Supabase/);
  await assert.rejects(session.signIn("", "x"), /Nhập email và mật khẩu/);
  next = [reply(200, { access_token: "chi-co-access" })];
  await assert.rejects(session.signIn("admin-test@example.com", "x"), /không trả phiên/);
  assert.equal(storage.data[SESSION_KEY], undefined);

  // Đăng xuất trong lúc đang gia hạn: kết quả gia hạn về sau KHÔNG được ghi lại phiên đã đăng xuất.
  {
    let release;
    next = [new Promise(resolve => { release = resolve; })];
    storage.data[SESSION_KEY] = { access_token: "a-old", refresh_token: "r-old", expires_at: clock + 10 * 1000, user: { id: "u", email: "admin-test@example.com" } };
    const pending = session.getAccessToken();
    await new Promise(resolve => setImmediate(resolve));
    await session.signOut();
    release(reply(200, { access_token: "a-late", refresh_token: "r-late", expires_in: 3600 }));
    await assert.rejects(pending, error => error.code === "SIGNED_OUT");
    assert.equal(storage.data[SESSION_KEY], undefined, "refresh về sau không hoàn tác đăng xuất");
  }

  // Đăng nhập lại (tài khoản khác) trong lúc phiên cũ đang gia hạn: giữ phiên mới, bỏ kết quả gia hạn cũ (kể cả khi bị từ chối).
  for (const late of [reply(200, { access_token: "a-late", refresh_token: "r-late", expires_in: 3600 }), reply(401, { error: "invalid_grant" })]) {
    let release;
    storage.data[SESSION_KEY] = { access_token: "a-old", refresh_token: "r-old", expires_at: clock + 10 * 1000, user: { id: "u", email: "admin-test@example.com" } };
    next = [new Promise(resolve => { release = resolve; })];
    const pending = session.getAccessToken();
    await new Promise(resolve => setImmediate(resolve));
    next = [reply(200, { access_token: "a-new", refresh_token: "r-new", expires_in: 3600, user: { id: "u2", email: "admin-test2@example.com" } })];
    await session.signIn("admin-test2@example.com", "x");
    release(late);
    assert.equal(await pending, "a-new");
    assert.equal(storage.data[SESSION_KEY].refresh_token, "r-new");
    assert.equal(storage.data[SESSION_KEY].user.email, "admin-test2@example.com");
  }

  // Đăng xuất xoá phiên.
  next = [reply(200, { access_token: "a", refresh_token: "r", expires_in: 3600, user: { id: "u", email: "admin-test@example.com" } })];
  await session.signIn("admin-test@example.com", "x");
  assert.deepEqual(await session.signOut(), { ok: true });
  assert.equal(storage.data[SESSION_KEY], undefined);

  console.log("supabase_session: sign-in, refresh, sign-out and network-error handling passed");
})().catch(error => { console.error(error); process.exit(1); });
