// Kiểm tra Edge Function supabase/functions/sku-vision/index.ts mà không cần Deno, Supabase hay
// Gemini thật: Node 24 tự bỏ khai báo kiểu khi import .ts; Deno.serve / Deno.env / fetch được giả lập.
//   node tests/sku_vision_function.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const SOURCE = fs.readFileSync(new URL("../supabase/functions/sku-vision/index.ts", import.meta.url), "utf8");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "sku-vision-test-"));
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));
const IMAGE = Buffer.from("anh-tem-gia").toString("base64");
const BASE_ENV = {
  GEMINI_API_KEY: "test-gemini-key",
  GEMINI_MODELS: "model-a,model-b",
  SUPABASE_URL: "https://example.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: "sb_publishable_test" })
};

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
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  };
  // Node không nạp lại .ts chỉ vì đổi ?query, nên mỗi ca chép ra một file riêng để env được đọc lại.
  const file = path.join(TEMP, `sku-vision-${++loads}.ts`);
  fs.writeFileSync(file, SOURCE);
  await import(pathToFileURL(file).href);
  const call = (body, headers = { apikey: "sb_publishable_test" }, method = "POST") =>
    handler(new Request("https://example.invalid/functions/v1/sku-vision", {
      method, headers: { "Content-Type": "application/json", ...headers },
      body: method === "POST" ? JSON.stringify(body) : undefined
    }));
  return { call, calls };
}

const quotaOk = { body: { ok: true, deviceUsed: 1, deviceLimit: 60, globalUsed: 1, globalLimit: 450 } };
const geminiOk = {
  body: {
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      raw_text: "COATS astra\nTkt 120\n5000m Tex 27\nCol QZ3966",
      item_codes: ["QZ3966"], specs: ["Tkt 120", "Tex 27", "5000m"], colors: [], brands: ["COATS", "astra"], others: [],
      quality: "ro"
    }) }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1600, candidatesTokenCount: 120 }
  }
};
// Gemini quá tải: không trả gì, chỉ kết thúc khi hàm huỷ lượt gọi (model khác đã đọc xong).
const hang = ({ init }) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
// Hết thời gian chờ một model, như AbortSignal.timeout báo.
const timeout = () => new Promise((_, reject) => setTimeout(() => reject(new DOMException("hết giờ", "TimeoutError")), 15));

test("preflight CORS trả 204 kèm header cho phép apikey", async () => {
  const { call } = await load();
  const response = await call(null, {}, "OPTIONS");
  assert.equal(response.status, 204);
  assert.match(response.headers.get("access-control-allow-headers"), /apikey/);
});

test("thiếu hoặc sai publishable key thì từ chối, không đụng tới bộ đếm hay Gemini", async () => {
  const { call, calls } = await load();
  const response = await call({ image: IMAGE }, { apikey: "sai" });
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("chưa cấu hình GEMINI_API_KEY thì báo rõ bằng tiếng Việt", async () => {
  const { call } = await load({ GEMINI_API_KEY: "" });
  const body = await (await call({ image: IMAGE })).json();
  assert.equal(body.code, "NO_AI_KEY");
  assert.match(body.message, /khoá Gemini/);
});

test("ảnh không hợp lệ bị chặn trước khi trừ lượt", async () => {
  const { call, calls } = await load({}, { sku_vision_take: quotaOk });
  const response = await call({ image: "không phải base64!" });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test("hết lượt trong ngày thì trả 429 và nhắc gõ mã, không gọi Gemini", async () => {
  const { call, calls } = await load({}, { sku_vision_take: { body: { ok: false, code: "DEVICE_LIMIT", deviceUsed: 60, deviceLimit: 60 } } });
  const response = await call({ image: IMAGE, device: "may-test" });
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.match(body.message, /60 lượt/);
  assert.ok(!calls.some(c => c.url.includes("generativelanguage")));
});

test("đọc tem thành công: gửi ảnh + khuôn JSON cho Gemini, trả chữ thô và từ khoá theo vai", async () => {
  const { call, calls } = await load({}, { sku_vision_take: quotaOk, generativelanguage: geminiOk });
  const response = await call({ image: `data:image/jpeg;base64,${IMAGE}`, mime: "image/jpeg", device: "may-test" });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.model, "model-a");
  assert.deepEqual(body.tokens.item_codes, ["QZ3966"]);
  assert.match(body.text, /Tex 27/);
  const quota = calls.find(c => c.url.includes("sku_vision_take"));
  assert.deepEqual(quota.body, { p_device: "may-test", p_device_limit: 60, p_global_limit: 450 });
  const gemini = calls.find(c => c.url.includes("generativelanguage"));
  assert.match(gemini.url, /models\/model-a:generateContent$/);
  assert.equal(gemini.init.headers["x-goog-api-key"], "test-gemini-key");
  assert.equal(gemini.body.contents[0].parts[0].inline_data.data, IMAGE, "phải bỏ tiền tố data: trước khi gửi");
  assert.equal(gemini.body.generationConfig.responseMimeType, "application/json");
});

test("ưu tiên khoá mới SUPABASE_SECRET_KEYS (JSON dictionary) khi gọi bộ đếm lượt", async () => {
  const { call, calls } = await load({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: "sb_secret_moi" }) },
    { sku_vision_take: quotaOk, generativelanguage: geminiOk });
  await call({ image: IMAGE });
  const quota = calls.find(c => c.url.includes("sku_vision_take"));
  assert.equal(quota.init.headers.apikey, "sb_secret_moi");
});

test("model đầu hết hạn mức (429) thì thử ngay model kế tiếp, không chờ hết thời gian so le", async () => {
  const { call } = await load({}, {
    sku_vision_take: quotaOk,
    "model-a:generateContent": { status: 429, body: { error: { message: "quota" } } },
    "model-b:generateContent": geminiOk
  });
  const started = Date.now();
  const body = await (await call({ image: IMAGE })).json();
  assert.equal(body.ok, true);
  assert.equal(body.model, "model-b");
  assert.ok(Date.now() - started < 3000, "SKU_VISION_HEDGE_MS mặc định 6 giây — không được chờ tới lúc đó");
});

test("model đầu treo thì sau SKU_VISION_HEDGE_MS gọi thêm model kế tiếp, dùng kết quả trả trước", async () => {
  const { call, calls } = await load({ SKU_VISION_HEDGE_MS: "30" }, {
    sku_vision_take: quotaOk,
    "model-a:generateContent": hang,
    "model-b:generateContent": geminiOk
  });
  const response = await call({ image: IMAGE });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.model, "model-b");
  assert.deepEqual(body.attempts.map(a => [a.model, a.status]), [["model-b", 200], ["model-a", "cancelled"]]);
  assert.ok(body.attempts[1].ms >= 25, "model-a phải được chờ hết thời gian so le rồi mới gọi model-b");
  const slow = calls.find(c => c.url.includes("model-a"));
  assert.equal(slow.init.signal.aborted, true, "lượt treo của model-a phải bị huỷ");
});

test("mọi model đều hết thời gian chờ thì trả 502 báo AI quá tải, không bảo chụp lại", async () => {
  const { call } = await load({ SKU_VISION_HEDGE_MS: "5" }, { sku_vision_take: quotaOk, generativelanguage: timeout });
  const response = await call({ image: IMAGE });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "AI_FAILED");
  assert.match(body.message, /quá tải/);
  assert.doesNotMatch(body.message, /chụp lại/);
  assert.deepEqual(body.attempts.map(a => [a.model, a.status]).sort(), [["model-a", "timeout"], ["model-b", "timeout"]]);
});

test("model từ chối thinkingConfig (400) thì gửi lại không kèm, lượt sau khỏi thử", async () => {
  const { call, calls } = await load({}, {
    sku_vision_take: quotaOk,
    generativelanguage: ({ body }) => (body.generationConfig.thinkingConfig ? { status: 400, body: { error: { message: "invalid argument" } } } : geminiOk)
  });
  const first = await (await call({ image: IMAGE })).json();
  assert.equal(first.ok, true);
  const gemini = calls.filter(c => c.url.includes("generativelanguage"));
  assert.deepEqual(gemini.map(c => Boolean(c.body.generationConfig.thinkingConfig)), [true, false]);
  assert.deepEqual(first.attempts, [{ model: "model-a", status: 200, ms: first.attempts[0].ms }]);
  await call({ image: IMAGE });
  const again = calls.filter(c => c.url.includes("generativelanguage")).slice(2);
  assert.deepEqual(again.map(c => Boolean(c.body.generationConfig.thinkingConfig)), [false], "đã nhớ model này không nhận thinkingConfig");
});

test("lỗi không phải tạm thời (400) thì dừng ngay, không báo quá tải", async () => {
  const { call, calls } = await load({}, {
    sku_vision_take: quotaOk,
    "model-a:generateContent": { status: 400, body: { error: { message: "bad request" } } },
    "model-b:generateContent": geminiOk
  });
  const response = await call({ image: IMAGE });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "AI_FAILED");
  assert.doesNotMatch(body.message, /quá tải/);
  assert.ok(!calls.some(c => c.url.includes("model-b")), "không được thử model-b sau lỗi 400");
  assert.equal(body.attempts.length, 1);
});
