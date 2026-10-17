// Kiểm tra Edge Function supabase/functions/print-assistant/index.ts (TRỢ LÝ IN) mà không cần Deno, Supabase hay
// Anthropic/Gemini thật: Node 24 tự bỏ khai báo kiểu khi import .ts; Deno.serve / Deno.env / fetch được giả lập.
//   node tests/print_assistant_function.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const SOURCE = fs.readFileSync(new URL("../supabase/functions/print-assistant/index.ts", import.meta.url), "utf8");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "print-assistant-test-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
const BASE_ENV = {
  ANTHROPIC_API_KEY: "test-anthropic-key",
  SUPABASE_URL: "https://example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_test" })
};
const ADMIN = { "/auth/v1/user": { body: { id: "00000000-0000-4000-8000-0000000000aa", email: "admin-test@example.com" } }, "/rest/v1/user_roles": { body: [{ role: "admin" }] } };
const LOG_OK = { "/rest/v1/print_assistant_log": { status: 201 } };
const HEADERS = { apikey: "sb_publishable_test", Authorization: "Bearer jwt-admin-test" };

let loads = 0;
async function load(env = {}, routes = {}) {
  const calls = [];
  let handler;
  globalThis.Deno = { env: { get: key => ({ ...BASE_ENV, ...env })[key] }, serve: h => { handler = h; } };
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const route = Object.keys(routes).find(key => call.url.includes(key));
    if (!route) throw new Error(`fetch không được giả lập: ${call.url}`);
    const answer = typeof routes[route] === "function" ? await routes[route](call, calls) : routes[route];
    const status = answer.status ?? 200;
    return new Response(status === 204 || answer.body === undefined ? null : JSON.stringify(answer.body), { status });
  };
  // Node không nạp lại .ts chỉ vì đổi ?query, nên mỗi ca chép ra một file riêng để env được đọc lại.
  const file = path.join(TEMP, `print-assistant-${++loads}.ts`);
  fs.writeFileSync(file, SOURCE);
  const module = await import(pathToFileURL(file).href);
  const call = (body, headers = HEADERS, method = "POST") =>
    handler(new Request("https://example.invalid/functions/v1/print-assistant", {
      method, headers: { "Content-Type": "application/json", ...headers },
      body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined
    }));
  return { call, calls, module };
}

const ai = (output, extra = {}) => ({
  body: {
    id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(output) }],
    stop_reason: "end_turn", usage: { input_tokens: 812, output_tokens: 41 }, ...extra
  }
});
const PRINT_OK = { intent: "print_it", itNumber: "100000001", copies: 2, reply: "Đọc phiếu IT 100000001, 2 bản mỗi SKU.", needs: [] };
const anthropicCall = calls => calls.find(c => c.url === "https://api.anthropic.com/v1/messages");
const geminiCalls = calls => calls.filter(c => c.url.startsWith("https://generativelanguage.googleapis.com/"));
const GEMINI_ONLY = { ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "test-gemini-key" };
const GEMINI_URL = model => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const gem = (output, extra = {}) => ({
  body: {
    candidates: [{ content: { role: "model", parts: [{ text: typeof output === "string" ? output : JSON.stringify(output) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 30 }, modelVersion: "gemini-test-version", ...extra
  }
});
const logCall = calls => calls.find(c => c.url.includes("/rest/v1/print_assistant_log"));

test("preflight CORS trả 204 kèm header cho phép apikey và authorization", async () => {
  const { call, calls } = await load();
  const response = await call(null, {}, "OPTIONS");
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /apikey/);
  assert.match(response.headers.get("access-control-allow-headers"), /authorization/);
  assert.equal(calls.length, 0);
});

test("sai publishable key → 401 BAD_KEY, không gọi Supabase hay Anthropic", async () => {
  const { call, calls } = await load({}, { ...ADMIN });
  const response = await call({ message: "in tem phiếu IT 100000001" }, { ...HEADERS, apikey: "sai" });
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.code, "BAD_KEY");
  assert.equal(body.error.code, "BAD_KEY");
  assert.equal(calls.length, 0);
});

test("không có Bearer → 401 AUTH, không gọi Anthropic", async () => {
  const { call, calls } = await load({}, { ...ADMIN });
  const response = await call({ message: "in tem phiếu IT 100000001" }, { apikey: "sb_publishable_test" });
  const body = await response.json();
  assert.equal(response.status, 401);
  assert.equal(body.code, "AUTH");
  assert.match(body.message, /Phiên Admin không hợp lệ/);
  assert.equal(calls.length, 0);
});

test("JWT hết hạn (/auth/v1/user 403) → 401 AUTH", async () => {
  const { call, calls } = await load({}, { "/auth/v1/user": { status: 403, body: { code: "bad_jwt" } } });
  const response = await call({ message: "in tem phiếu IT 100000001" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "AUTH");
  assert.ok(!anthropicCall(calls));
});

test("người dùng không phải Admin → 403 FORBIDDEN, không gọi Anthropic", async () => {
  const { call, calls } = await load({}, { ...ADMIN, "/rest/v1/user_roles": { body: [{ role: "viewer" }] } });
  const response = await call({ message: "in tem phiếu IT 100000001" });
  const body = await response.json();
  assert.equal(response.status, 403);
  assert.equal(body.code, "FORBIDDEN");
  assert.match(body.message, /Chỉ Admin/);
  assert.ok(!anthropicCall(calls));
  const roles = calls.find(c => c.url.includes("/rest/v1/user_roles"));
  assert.match(roles.url, /user_id=eq\.00000000-0000-4000-8000-0000000000aa/);
  assert.equal(roles.init.headers.apikey, "test-service-key");
});

test("không có cả ANTHROPIC_API_KEY lẫn GEMINI_API_KEY → 503 NO_AI_KEY bằng tiếng Việt", async () => {
  const { call, calls } = await load({ ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "" }, { ...ADMIN });
  const response = await call({ message: "in tem phiếu IT 100000001" });
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.code, "NO_AI_KEY");
  assert.equal(body.message, "Máy chủ chưa có khoá trợ lý AI (GEMINI_API_KEY hoặc ANTHROPIC_API_KEY).");
  assert.ok(!anthropicCall(calls));
  assert.equal(geminiCalls(calls).length, 0);
});

test("body không phải JSON → 400 BAD_JSON; câu nói rỗng/quá 300 ký tự/lịch sử quá 6 lượt → 400 INVALID_INPUT", async () => {
  const { call, calls } = await load({}, { ...ADMIN });
  let response = await call("{không phải json");
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "BAD_JSON");
  for (const body of [{ message: "   " }, { message: "x".repeat(301) }, { message: "in IT", history: "sai" },
    { message: "in IT", history: Array.from({ length: 7 }, () => ({ role: "user", text: "a" })) }]) {
    response = await call(body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal((await response.json()).code, "INVALID_INPUT");
  }
  response = await call(JSON.stringify({ message: "a", pad: "x".repeat(9000) }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_INPUT");
  assert.ok(!anthropicCall(calls), "dữ liệu sai không tốn lượt gọi AI");
});

test("câu 'in tem phiếu IT 100000001 2 bản' → 200 data đúng, gửi đúng tham số Anthropic, ghi nhật ký", async () => {
  const { call, calls } = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai(PRINT_OK) });
  const response = await call({
    message: "in tem phiếu IT 100000001 2 bản",
    history: [{ role: "assistant", text: "Chào bạn" }, { role: "user", text: "tôi cần in tem" }, { role: "assistant", text: "Số phiếu IT là gì?" }],
    context: { hasWms: true, deviceActive: false }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, data: PRINT_OK, meta: { provider: "anthropic", model: "claude-opus-5-5", inputTokens: 812, outputTokens: 41 } });

  const request = anthropicCall(calls);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-api-key"], "test-anthropic-key");
  assert.equal(request.init.headers["anthropic-version"], "2023-06-01");
  assert.equal(request.init.headers["content-type"], "application/json");
  assert.equal(request.body.model, "claude-opus-5-5");
  assert.equal(request.body.max_tokens, 512);
  assert.equal(request.body.output_config.effort, "low");
  assert.equal(request.body.output_config.format.type, "json_schema");
  const schema = request.body.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["intent", "itNumber", "copies", "reply", "needs"]);
  assert.deepEqual(schema.properties.intent.enum, ["print_it", "other"]);
  assert.deepEqual(schema.properties.needs.items.enum, ["it_number", "copies"]);
  for (const key of ["thinking", "tool_choice", "tools", "temperature"]) assert.equal(key in request.body, false, `không truyền ${key}`);
  assert.match(request.body.system, /phiếu IT/);
  assert.ok((request.body.system.match(/Người dùng:/g) || []).length >= 3, "có ví dụ few-shot");
  // Lượt trợ lý đứng đầu bị bỏ, lượt cuối là user kèm ngữ cảnh; không có prefill trợ lý ở cuối
  assert.deepEqual(request.body.messages.map(m => m.role), ["user", "assistant", "user"]);
  assert.match(request.body.messages.at(-1).content, /WMS đã kết nối; máy in chưa kích hoạt/);
  assert.match(request.body.messages.at(-1).content, /in tem phiếu IT 100000001 2 bản$/);

  const log = logCall(calls);
  assert.ok(log, "ghi nhật ký print_assistant_log");
  assert.equal(log.init.method, "POST");
  assert.equal(log.init.headers.apikey, "test-service-key");
  assert.deepEqual(log.body, {
    user_id: "00000000-0000-4000-8000-0000000000aa", user_email: "admin-test@example.com", message: "in tem phiếu IT 100000001 2 bản",
    intent: "print_it", it_number: "100000001", copies: 2, reply: "Đọc phiếu IT 100000001, 2 bản mỗi SKU.",
    model: "claude-opus-5-5", input_tokens: 812, output_tokens: 41
  });
  assert.ok(!JSON.stringify(log.body).includes("jwt-admin-test"), "không ghi token vào nhật ký");
});

test("ANTHROPIC_MODEL đổi mô hình không cần deploy", async () => {
  const { call, calls } = await load({ ANTHROPIC_MODEL: "claude-test-model" }, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai(PRINT_OK) });
  assert.equal((await call({ message: "IT 100000001" })).status, 200);
  assert.equal(anthropicCall(calls).body.model, "claude-test-model");
});

test("số phiếu có dấu chấm '100.000.001' → chuẩn hoá chỉ chữ số; copies 999 → kẹp 200", async () => {
  const { call } = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai({ ...PRINT_OK, itNumber: "IT 100.000.001", copies: 999, needs: ["it_number"] }) });
  const body = await (await call({ message: "in phiếu 100.000.001 999 bản" })).json();
  assert.equal(body.data.itNumber, "100000001");
  assert.equal(body.data.copies, 200);
  assert.deepEqual(body.data.needs, [], "đã có số phiếu thì bỏ it_number khỏi needs");
});

test("thiếu số phiếu → needs it_number; số phiếu không hợp lệ bị bỏ; câu ngoài phạm vi → other", async () => {
  let loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai({ intent: "print_it", itNumber: null, copies: null, reply: "Số phiếu IT là gì?", needs: [] }) });
  let body = await (await loaded.call({ message: "in tem phiếu chuyển kho" })).json();
  assert.deepEqual(body.data, { intent: "print_it", itNumber: null, copies: null, reply: "Số phiếu IT là gì?", needs: ["it_number"] });

  loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai({ intent: "print_it", itNumber: "12345", copies: 0, reply: "", needs: ["copies"] }) });
  body = await (await loaded.call({ message: "in IT 12345" })).json();
  assert.equal(body.data.itNumber, null, "5 chữ số không phải số phiếu");
  assert.equal(body.data.copies, 1, "copies 0 → kẹp 1");
  assert.deepEqual(body.data.needs, ["it_number"]);
  assert.equal(body.data.reply, "Số phiếu IT là gì?");

  loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai({ intent: "other", itNumber: "100000001", copies: 3, reply: "Hiện tôi chỉ in tem theo phiếu IT.", needs: ["copies"] }) });
  body = await (await loaded.call({ message: "in lại lệnh hôm qua" })).json();
  assert.deepEqual(body.data, { intent: "other", itNumber: null, copies: null, reply: "Hiện tôi chỉ in tem theo phiếu IT.", needs: [] });
});

test("hàm chuẩn hoá: nhiều số phiếu tách rời thì không đoán; reply dài cắt 160", async () => {
  const { module } = await load();
  assert.equal(module.normalizeItNumber("100000001 100000002"), null);
  assert.equal(module.normalizeItNumber("100 000 001"), "100000001");
  assert.equal(module.normalizeItNumber("Phiếu IT: 100-000-001"), "100000001");
  assert.equal(module.normalizeItNumber("ABC100000001"), null);
  assert.equal(module.normalizeItNumber("1".repeat(41)), null);
  assert.equal(module.normalizeCopies("7"), 7);
  assert.equal(module.normalizeCopies(2.6), 3);
  assert.equal(module.normalizeCopies("nhiều"), null);
  assert.equal(module.guard({ ...PRINT_OK, reply: "a".repeat(400) }).reply.length, 160);
  assert.equal(module.guard({ intent: "in", itNumber: null, copies: null, reply: "", needs: [] }), null);
  assert.equal(module.guard({ ...PRINT_OK, reply: 5 }), null);
  for (const key of ["intent", "itNumber", "copies", "reply", "needs"]) {
    const { [key]: _dropped, ...partial } = PRINT_OK;
    assert.equal(module.guard(partial), null, `thiếu khoá ${key} → null`);
  }
  assert.equal(module.guard({ ...PRINT_OK, copies: "2" }), null, "copies chuỗi không chấp nhận");
  assert.equal(module.guard({ ...PRINT_OK, copies: 2.5 }), null, "copies không nguyên");
  assert.equal(module.guard({ ...PRINT_OK, itNumber: 100000001 }), null, "itNumber số");
  assert.equal(module.guard({ ...PRINT_OK, needs: "it_number" }), null);
  assert.equal(module.guard({ ...PRINT_OK, needs: ["lạ"] }), null, "needs ngoài enum");
  assert.equal(module.guard({ ...PRINT_OK, itNumber: null, copies: null, needs: [] }).itNumber, null);
});

test("mô hình trả sai khuôn (copies chuỗi, thiếu khoá) → 502 AI_UPSTREAM 'Mô hình trả dữ liệu sai khuôn'; đủ khoá → 200", async () => {
  for (const bad of [{ ...PRINT_OK, copies: "2" }, { intent: "print_it", itNumber: "100000001", reply: "Đọc phiếu", needs: [] }]) {
    const loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai(bad) });
    const response = await loaded.call({ message: "IT 100000001 2 bản" });
    const body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, "AI_UPSTREAM");
    assert.equal(body.message, "Mô hình trả dữ liệu sai khuôn");
    assert.ok(!logCall(loaded.calls), "không ghi nhật ký khi sai khuôn");
  }
  const ok = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai(PRINT_OK) });
  const response = await ok.call({ message: "IT 100000001 2 bản" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.copies, 2);
});

test("Anthropic từ chối (stop_reason refusal) → intent other với câu cố định", async () => {
  const { call, calls } = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai({}, { content: [], stop_reason: "refusal" }) });
  const response = await call({ message: "câu bị từ chối" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body.data, { intent: "other", itNumber: null, copies: null, reply: "Tôi không xử lý được câu này.", needs: [] });
  assert.equal(logCall(calls).body.intent, "other");
});

test("Anthropic 429 → 429 AI_BUSY; 500 hoặc JSON hỏng → 502 AI_UPSTREAM; không ghi nhật ký", async () => {
  let loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": { status: 429, body: { type: "error", error: { type: "rate_limit_error" } } } });
  let response = await loaded.call({ message: "IT 100000001" });
  let body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.code, "AI_BUSY");
  assert.match(body.message, /đang bận/);
  assert.ok(!logCall(loaded.calls));

  loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": { status: 500, body: { type: "error" } } });
  response = await loaded.call({ message: "IT 100000001" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "AI_UPSTREAM");

  loaded = await load({}, { ...ADMIN, ...LOG_OK, "api.anthropic.com": { body: { content: [{ type: "text", text: "{\"intent\":\"print_it\"," }], stop_reason: "max_tokens" } } });
  response = await loaded.call({ message: "IT 100000001" });
  body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "AI_UPSTREAM");
  assert.match(body.message, /không hợp lệ/);
});

test("Anthropic treo quá hạn chờ → 502 AI_UPSTREAM 'phản hồi quá lâu' (huỷ bằng AbortController)", async () => {
  let aborted = false;
  const hang = ({ init }) => new Promise((_, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }));
  const { call } = await load({ PRINT_ASSISTANT_TIMEOUT_MS: "40" }, { ...ADMIN, ...LOG_OK, "api.anthropic.com": hang });
  const started = Date.now();
  const response = await call({ message: "IT 100000001" });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "AI_UPSTREAM");
  assert.match(body.message, /quá lâu/);
  assert.ok(aborted, "lượt gọi bị huỷ");
  assert.ok(Date.now() - started < 2000);
});

test("ghi nhật ký lỗi không làm hỏng phản hồi", async () => {
  const { call } = await load({}, { ...ADMIN, "/rest/v1/print_assistant_log": { status: 500, body: { message: "lỗi" } }, "api.anthropic.com": ai(PRINT_OK) });
  const response = await call({ message: "in tem phiếu IT 100000001 2 bản" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.itNumber, "100000001");
});

// ---- Gemini (quyết định 17/10/2026: không có khoá Anthropic, dùng GEMINI_API_KEY sẵn có của Tìm SKU) ----

test("có cả hai khoá → dùng Anthropic, không gọi Gemini", async () => {
  const { call, calls } = await load({ GEMINI_API_KEY: "test-gemini-key" }, { ...ADMIN, ...LOG_OK, "api.anthropic.com": ai(PRINT_OK), "generativelanguage.googleapis.com": gem(PRINT_OK) });
  const body = await (await call({ message: "IT 100000001 2 bản" })).json();
  assert.equal(body.meta.provider, "anthropic");
  assert.ok(anthropicCall(calls));
  assert.equal(geminiCalls(calls).length, 0);
});

test("chỉ GEMINI_API_KEY → 200 đúng data, đúng URL/header x-goog-api-key, body có responseSchema, ghi nhật ký model Gemini", async () => {
  const { call, calls } = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": gem(PRINT_OK) });
  const response = await call({
    message: "in tem phiếu IT 100000001 2 bản",
    history: [{ role: "assistant", text: "Chào bạn" }, { role: "user", text: "tôi cần in tem" }, { role: "assistant", text: "Số phiếu IT là gì?" }],
    context: { hasWms: true, deviceActive: true }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, { ok: true, data: PRINT_OK, meta: { provider: "gemini", model: "gemini-3.1-flash-lite", inputTokens: 700, outputTokens: 30 } });
  assert.ok(!anthropicCall(calls));

  const requests = geminiCalls(calls);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.url, GEMINI_URL("gemini-3.1-flash-lite"));
  assert.ok(!request.url.includes("test-gemini-key"), "khoá không nằm trong URL");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers["x-goog-api-key"], "test-gemini-key");
  assert.match(request.body.systemInstruction.parts[0].text, /phiếu IT/);
  assert.deepEqual(request.body.contents.map(c => c.role), ["user", "model", "user"]);
  assert.match(request.body.contents.at(-1).parts[0].text, /WMS đã kết nối; máy in đã kích hoạt/);
  assert.match(request.body.contents.at(-1).parts[0].text, /in tem phiếu IT 100000001 2 bản$/);
  const config = request.body.generationConfig;
  assert.equal(config.temperature, 0);
  assert.equal(config.responseMimeType, "application/json");
  assert.equal(config.maxOutputTokens, 512);
  assert.deepEqual(config.thinkingConfig, { thinkingBudget: 0 });
  const schema = config.responseSchema;
  assert.equal(schema.type, "OBJECT");
  assert.deepEqual(schema.required, ["intent", "itNumber", "copies", "reply", "needs"]);
  assert.deepEqual(schema.properties.intent.enum, ["print_it", "other"]);
  assert.deepEqual(schema.properties.itNumber, { ...schema.properties.itNumber, type: "STRING", nullable: true });
  assert.deepEqual(schema.properties.copies, { ...schema.properties.copies, type: "INTEGER", nullable: true });
  assert.deepEqual(schema.properties.needs.items, { type: "STRING", enum: ["it_number", "copies"] });
  assert.ok(!JSON.stringify(schema).includes("additionalProperties"), "Gemini không nhận additionalProperties");
  assert.ok(!JSON.stringify(schema).includes("anyOf"));

  const log = logCall(calls);
  assert.equal(log.body.model, "gemini-3.1-flash-lite");
  assert.equal(log.body.input_tokens, 700);
  assert.equal(log.body.output_tokens, 30);
  assert.equal(log.body.it_number, "100000001");
});

test("Gemini: GEMINI_ASSISTANT_MODEL đổi model; khoá nullable bị bỏ hẳn → coi là null", async () => {
  const { call, calls } = await load({ ...GEMINI_ONLY, GEMINI_ASSISTANT_MODEL: "gemini-test-model" },
    { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": gem({ intent: "print_it", itNumber: "100000001", reply: "Đọc phiếu IT 100000001." }) });
  const body = await (await call({ message: "đọc phiếu 100000001" })).json();
  assert.equal(geminiCalls(calls)[0].url, GEMINI_URL("gemini-test-model"));
  assert.equal(body.meta.model, "gemini-test-model");
  assert.deepEqual(body.data, { intent: "print_it", itNumber: "100000001", copies: null, reply: "Đọc phiếu IT 100000001.", needs: [] });
});

test("Gemini: model đầu 404 hoặc 503 → thử gemini-3.8-flash đúng một lần → 200; cả hai lỗi → 502", async () => {
  for (const status of [404, 503]) {
    const route = ({ url }) => url.includes("gemini-3.1-flash-lite") ? { status, body: { error: { code: status } } } : gem(PRINT_OK);
    const { call, calls } = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": route });
    const response = await call({ message: "IT 100000001 2 bản" });
    const body = await response.json();
    assert.equal(response.status, 200, `model đầu ${status}`);
    assert.deepEqual(geminiCalls(calls).map(c => c.url), [GEMINI_URL("gemini-3.1-flash-lite"), GEMINI_URL("gemini-3.8-flash")]);
    assert.equal(body.meta.model, "gemini-3.8-flash");
    assert.equal(logCall(calls).body.model, "gemini-3.8-flash");
  }
  const { call, calls } = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": { status: 503, body: { error: { status: "UNAVAILABLE" } } } });
  const response = await call({ message: "IT 100000001" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "AI_UPSTREAM");
  assert.equal(geminiCalls(calls).length, 2, "không thử model thứ ba");
  assert.ok(!logCall(calls));
  // Model đặt trong GEMINI_ASSISTANT_MODEL trùng model dự phòng → chỉ gọi một lần
  const same = await load({ ...GEMINI_ONLY, GEMINI_ASSISTANT_MODEL: "gemini-3.8-flash" }, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": { status: 404, body: {} } });
  assert.equal((await same.call({ message: "IT 100000001" })).status, 502);
  assert.equal(geminiCalls(same.calls).length, 1);
});

test("Gemini: model từ chối thinkingConfig (400) → gửi lại không kèm, cùng model", async () => {
  const route = ({ body }) => body.generationConfig.thinkingConfig ? { status: 400, body: { error: { status: "INVALID_ARGUMENT" } } } : gem(PRINT_OK);
  const { call, calls } = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": route });
  const response = await call({ message: "IT 100000001 2 bản" });
  assert.equal(response.status, 200);
  const requests = geminiCalls(calls);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(c => c.url === GEMINI_URL("gemini-3.1-flash-lite")));
  assert.equal("thinkingConfig" in requests[1].body.generationConfig, false);
});

test("Gemini 429 / RESOURCE_EXHAUSTED → 429 AI_BUSY, không thử model khác, không ghi nhật ký", async () => {
  for (const answer of [{ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED" } } }, { status: 403, body: { error: { status: "RESOURCE_EXHAUSTED" } } }]) {
    const { call, calls } = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": answer });
    const response = await call({ message: "IT 100000001" });
    const body = await response.json();
    assert.equal(response.status, 429);
    assert.equal(body.code, "AI_BUSY");
    assert.match(body.message, /đang bận/);
    assert.equal(geminiCalls(calls).length, 1);
    assert.ok(!logCall(calls));
  }
  const loaded = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": { status: 500, body: { error: {} } } });
  const response = await loaded.call({ message: "IT 100000001" });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "AI_UPSTREAM");
  assert.equal(geminiCalls(loaded.calls).length, 1, "500 không thử model thứ hai");
});

test("Gemini chặn (promptFeedback.blockReason hoặc finishReason SAFETY) → intent other câu cố định", async () => {
  const refusal = { intent: "other", itNumber: null, copies: null, reply: "Tôi không xử lý được câu này.", needs: [] };
  for (const answer of [
    { body: { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 50 } } },
    { body: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }], usageMetadata: { promptTokenCount: 50 } } }
  ]) {
    const { call, calls } = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": answer });
    const response = await call({ message: "câu bị chặn" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.data, refusal);
    assert.equal(body.meta.provider, "gemini");
    assert.equal(logCall(calls).body.intent, "other");
  }
});

test("Gemini trả sai khuôn → 502 'Mô hình trả dữ liệu sai khuôn'; chữ không phải JSON/không có nội dung → 502 không hợp lệ", async () => {
  let loaded = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": gem({ ...PRINT_OK, copies: "2" }) });
  let response = await loaded.call({ message: "IT 100000001 2 bản" });
  let body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "AI_UPSTREAM");
  assert.equal(body.message, "Mô hình trả dữ liệu sai khuôn");
  assert.ok(!logCall(loaded.calls));

  for (const answer of [gem("{\"intent\":\"print_it\","), { body: { candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] } }]) {
    loaded = await load(GEMINI_ONLY, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": answer });
    response = await loaded.call({ message: "IT 100000001" });
    body = await response.json();
    assert.equal(response.status, 502);
    assert.equal(body.code, "AI_UPSTREAM");
    assert.match(body.message, /không hợp lệ/);
  }
});

test("Gemini treo quá hạn chờ → 502 AI_UPSTREAM 'phản hồi quá lâu'", async () => {
  const hang = ({ init }) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
  const { call, calls } = await load({ ...GEMINI_ONLY, PRINT_ASSISTANT_TIMEOUT_MS: "40" }, { ...ADMIN, ...LOG_OK, "generativelanguage.googleapis.com": hang });
  const response = await call({ message: "IT 100000001" });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(body.message, /quá lâu/);
  assert.equal(geminiCalls(calls).length, 1);
});
