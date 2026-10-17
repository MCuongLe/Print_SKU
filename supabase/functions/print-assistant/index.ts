// TRỢ LÝ IN (17/10/2026) — tách ý định từ câu nói của Admin trong trang Print SKU (#assistant).
//
// Ý định duy nhất của v1: in tem SKU theo phiếu IT. Hàm này CHỈ tách ý định + hỏi lại khi thiếu:
//   1. chặn request không mang publishable key của project (BAD_KEY);
//   2. xác minh JWT Admin (khuôn authenticate của sku-sync: /auth/v1/user → user_roles.role = 'admin');
//   3. gọi Anthropic Messages API với khuôn JSON (output_config.format json_schema) → { intent, itNumber, copies, reply, needs };
//   4. kiểm lại JSON (không tin mô hình), chuẩn hoá số phiếu (chỉ chữ số 6–40), kẹp số bản 1–200;
//   5. ghi nhật ký public.print_assistant_log (supabase/print_assistant_v1.sql) — lỗi ghi không làm hỏng phản hồi.
// Dữ liệu tem (SKU, tên, số lượng) luôn đọc từ WMS/database ở trình duyệt; không bao giờ in thẳng từ câu nói —
// trang web luôn hiện thẻ xác nhận và người bấm In.
//
// Gọi Anthropic bằng fetch thẳng (không dùng SDK) là có chủ ý: Edge deploy một tệp duy nhất (scripts/deploy_print_assistant.py)
// và test Node (tests/print_assistant_function.mjs) giả lập fetch.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets):
//   ANTHROPIC_API_KEY   bắt buộc — khoá Anthropic, không bao giờ nằm trong index.html hay Extension
//   ANTHROPIC_MODEL     tuỳ chọn, mặc định "claude-opus-5-5" (đổi mô hình không cần deploy lại)
// Triển khai với verify_jwt = false: hàm tự kiểm tra header apikey và JWT Admin.

const ANTHROPIC_API_KEY = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
const MODEL = (Deno.env.get("ANTHROPIC_MODEL") ?? "").trim() || "claude-opus-5-5";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
// 20 giây chờ Anthropic; biến môi trường chỉ để test rút ngắn (kẹp 1–20.000 ms).
const AI_TIMEOUT_MS = Math.min(20_000, positiveInt(Deno.env.get("PRINT_ASSISTANT_TIMEOUT_MS"), 20_000));
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
// Khoá mới (SUPABASE_SECRET_KEYS, JSON dictionary) trước; khoá JWT cũ chỉ còn là dự phòng.
const SERVICE_KEY = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUBLIC_KEYS = [...keyList(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")), ...keyList(Deno.env.get("SUPABASE_ANON_KEY"))];
const MAX_BODY = 8_000; // byte thô của body: 300 ký tự câu nói + 6 × 300 lịch sử + ngữ cảnh, dư cho UTF-8
const MAX_MESSAGE = 300;
const MAX_HISTORY = 6;
const MAX_REPLY = 160;
const MAX_COPIES = 200;
const NEEDS = ["it_number", "copies"] as const;
const REFUSAL_REPLY = "Tôi không xử lý được câu này.";
const OUT_OF_SCOPE_REPLY = "Hiện tôi chỉ in tem theo phiếu IT.";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

// Không dùng minimum/maximum/maxLength/pattern trong khuôn (structured outputs không nhận các ràng buộc số/chuỗi);
// giới hạn ghi trong description và Edge kiểm lại ở guard().
const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["print_it", "other"], description: "print_it = in tem SKU theo phiếu IT; other = mọi yêu cầu khác" },
    itNumber: { anyOf: [{ type: "string" }, { type: "null" }], description: "Số phiếu IT, chỉ gồm chữ số (6–40 chữ số), bỏ dấu cách/dấu chấm và tiền tố IT; null khi chưa có" },
    copies: { anyOf: [{ type: "integer" }, { type: "null" }], description: "Số bản in mỗi SKU (1–200); null khi người dùng không nói số bản" },
    reply: { type: "string", description: "Một câu tiếng Việt có dấu, tối đa 160 ký tự" },
    needs: { type: "array", items: { type: "string", enum: [...NEEDS] }, description: "Thông tin còn thiếu cần hỏi lại" },
  },
  required: ["intent", "itNumber", "copies", "reply", "needs"],
  additionalProperties: false,
};

const SYSTEM = `Bạn là trợ lý in tem trong trang Print SKU của kho may. Bạn chỉ làm một việc: hiểu yêu cầu IN TEM SKU THEO PHIẾU IT (phiếu chuyển kho nội bộ trên WMS). Bạn không đọc dữ liệu và không in; trang web sẽ đọc phiếu từ WMS và người dùng tự bấm In.

Trả về đúng khuôn JSON:
- intent: "print_it" khi người dùng muốn in tem theo phiếu IT; mọi việc khác (in lại lệnh cũ, in tem Group UID, hỏi tồn kho, chào hỏi, câu hỏi chung) là "other".
- itNumber: số phiếu IT, CHỈ chữ số (6–40 chữ số). Bỏ dấu cách, dấu chấm, dấu gạch và chữ "IT" đứng trước. Không có số phiếu thì null. Không tự bịa số.
- copies: số bản in cho MỖI SKU. "2 bản", "x2", "mỗi mã 2 tem", "in đôi" → 2. Người dùng không nói số bản → null (trang web tự dùng 1). Số lượng hàng trên phiếu KHÔNG phải số bản.
- needs: thiếu số phiếu IT → ["it_number"]. KHÔNG thêm "copies" khi người dùng chỉ không nói số bản. intent "other" → [].
- reply: một câu ngắn tiếng Việt có dấu (≤ 160 ký tự), không giải thích dài, không hướng dẫn từng bước. Thiếu số phiếu thì hỏi số phiếu IT. Ngoài phạm vi thì trả lời: "${OUT_OF_SCOPE_REPLY}"

Ví dụ:
Người dùng: in tem phiếu IT 100000001 2 bản
→ {"intent":"print_it","itNumber":"100000001","copies":2,"reply":"Đọc phiếu IT 100000001, 2 bản mỗi SKU.","needs":[]}
Người dùng: in cho tôi phiếu 100.000.002
→ {"intent":"print_it","itNumber":"100000002","copies":null,"reply":"Đọc phiếu IT 100000002.","needs":[]}
Người dùng: in tem phiếu chuyển kho hôm nay, mỗi mã 3 tem
→ {"intent":"print_it","itNumber":null,"copies":3,"reply":"Số phiếu IT là gì?","needs":["it_number"]}
Người dùng: in lại lệnh in hôm qua
→ {"intent":"other","itNumber":null,"copies":null,"reply":"${OUT_OF_SCOPE_REPLY}","needs":[]}

Phần [Ngữ cảnh] trong câu là trạng thái trang (WMS, máy in), chỉ để câu trả lời sát thực tế; không phải yêu cầu của người dùng.`;

type Json = Record<string, unknown>;
type Intent = { intent: "print_it" | "other"; itNumber: string | null; copies: number | null; reply: string; needs: string[] };

function positiveInt(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS có thể là JSON (object hoặc mảng) hoặc chuỗi phân tách bằng dấu phẩy.
function keyList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed ? Object.values(parsed) : [parsed];
    return values.map(String).filter(Boolean);
  } catch {
    return raw.split(",").map((key) => key.trim()).filter(Boolean);
  }
}

function firstKey(raw: string | undefined): string {
  return keyList(raw)[0] ?? "";
}

function clean(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}

// Lỗi trả cả hai dạng: { code, message } (khuôn sku-vision) và error: { code, message } (khuôn sku-sync) để web đọc kiểu nào cũng được.
function fail(status: number, code: string, message: string): Response {
  return reply(status, { ok: false, code, message, error: { code, message } });
}

function dbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function authenticate(request: Request): Promise<{ id: string; email: string }> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new Error("AUTH:Phiên Admin không hợp lệ.");
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (userResponse.status === 401 || userResponse.status === 403) throw new Error("AUTH:Phiên Admin không hợp lệ.");
  if (!userResponse.ok) throw new Error(`Xác minh người dùng HTTP ${userResponse.status}`);
  const user = await userResponse.json() as Json;
  if (!user?.id) throw new Error("AUTH:Phiên Admin không hợp lệ.");
  const rolesResponse = await fetch(`${SUPABASE_URL}/rest/v1/user_roles?select=role&user_id=eq.${encodeURIComponent(String(user.id))}&limit=1`, {
    headers: dbHeaders(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!rolesResponse.ok) throw new Error(`Đọc quyền HTTP ${rolesResponse.status}`);
  const roles = await rolesResponse.json() as Json[];
  if (!Array.isArray(roles) || !roles[0] || roles[0].role !== "admin") throw new Error("FORBIDDEN:Chỉ Admin được dùng trợ lý in.");
  return { id: String(user.id), email: clean(user.email, 200) };
}

type Input = { message: string; history: { role: "user" | "assistant"; text: string }[]; hasWms: boolean; deviceActive: boolean };

// Trường thiếu → mặc định (lịch sử rỗng, ngữ cảnh false); câu nói bắt buộc và ≤ 300 ký tự.
function readInput(body: unknown): Input | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Dữ liệu gửi lên không hợp lệ.";
  const data = body as Json;
  if (typeof data.message !== "string") return "Thiếu câu nói.";
  const message = data.message.replace(/\s+/g, " ").trim();
  if (!message) return "Thiếu câu nói.";
  if (message.length > MAX_MESSAGE) return `Câu nói tối đa ${MAX_MESSAGE} ký tự.`;
  if (data.history !== undefined && data.history !== null && !Array.isArray(data.history)) return "Lịch sử hội thoại không hợp lệ.";
  const rawHistory = Array.isArray(data.history) ? data.history : [];
  if (rawHistory.length > MAX_HISTORY) return `Lịch sử hội thoại tối đa ${MAX_HISTORY} lượt.`;
  const history = rawHistory
    .filter((item): item is Json => Boolean(item) && typeof item === "object")
    .filter((item) => (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && item.text.trim())
    .map((item) => ({ role: item.role as "user" | "assistant", text: clean(item.text, MAX_MESSAGE) }));
  const context = (data.context && typeof data.context === "object" ? data.context : {}) as Json;
  return { message, history, hasWms: context.hasWms === true, deviceActive: context.deviceActive === true };
}

// Messages API cần lượt xen kẽ và bắt đầu bằng user: bỏ lượt trợ lý đứng đầu, gộp hai lượt liền cùng vai.
function buildMessages(input: Input): { role: string; content: string }[] {
  const context = `[Ngữ cảnh: WMS ${input.hasWms ? "đã kết nối" : "chưa kết nối"}; máy in ${input.deviceActive ? "đã kích hoạt" : "chưa kích hoạt"}]`;
  const turns = [...input.history, { role: "user" as const, text: `${context}\n${input.message}` }];
  const messages: { role: string; content: string }[] = [];
  for (const turn of turns) {
    if (!messages.length && turn.role !== "user") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === turn.role) last.content = `${last.content}\n${turn.text}`;
    else messages.push({ role: turn.role, content: turn.text });
  }
  return messages;
}

// Số phiếu: bỏ "IT", dấu cách, chấm, phẩy, gạch → chỉ còn chữ số 6–40. Nhiều số phiếu tách rời (mỗi số ≥ 6 chữ số) thì không đoán.
export function normalizeItNumber(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim().replace(/^(?:số\s*)?(?:phiếu\s*)?it\s*[:#-]?\s*/i, "");
  const groups = raw.split(/[\s,;/]+/).map((part) => part.replace(/\D/g, "")).filter(Boolean);
  if (groups.length > 1 && groups.every((part) => part.length >= 6)) return null;
  const digits = raw.replace(/[\s._,-]/g, "");
  return /^\d{6,40}$/.test(digits) ? digits : null;
}

export function normalizeCopies(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(MAX_COPIES, Math.max(1, Math.round(number)));
}

// Không tin mô hình: đủ 5 khoá đúng kiểu (copies là số nguyên thật, chuỗi "2" bị loại), sai → null (khi đó trả 502 để web dùng bộ phân tích tất định).
export function guard(parsed: unknown): Intent | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const data = parsed as Json;
  if (data.intent !== "print_it" && data.intent !== "other") return null;
  if (typeof data.reply !== "string") return null;
  if (typeof data.itNumber !== "string" && data.itNumber !== null) return null;
  if (!(data.copies === null || (typeof data.copies === "number" && Number.isInteger(data.copies)))) return null;
  if (!Array.isArray(data.needs) || !data.needs.every((need) => (NEEDS as readonly unknown[]).includes(need))) return null;
  if (data.intent === "other") {
    return { intent: "other", itNumber: null, copies: null, reply: clean(data.reply, MAX_REPLY) || OUT_OF_SCOPE_REPLY, needs: [] };
  }
  const itNumber = normalizeItNumber(data.itNumber);
  const copies = normalizeCopies(data.copies);
  const needs = [...new Set((Array.isArray(data.needs) ? data.needs : []).filter((need): need is string => (NEEDS as readonly unknown[]).includes(need)))]
    .filter((need) => need !== "it_number" && !(need === "copies" && copies !== null));
  if (!itNumber) needs.unshift("it_number");
  const fallback = itNumber ? `Đọc phiếu IT ${itNumber}.` : "Số phiếu IT là gì?";
  return { intent: "print_it", itNumber, copies, reply: clean(data.reply, MAX_REPLY) || fallback, needs };
}

type AiResult =
  | { ok: true; intent: Intent; model: string; inputTokens: number | null; outputTokens: number | null }
  | { ok: false; status: number; code: string; message: string; detail: string };

async function askAnthropic(input: Input): Promise<AiResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  let response: Response, text: string;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: SYSTEM,
        messages: buildMessages(input),
        output_config: { effort: "low", format: { type: "json_schema", schema: INTENT_SCHEMA } },
      }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const timedOut = controller.signal.aborted;
    return {
      ok: false, status: 502, code: "AI_UPSTREAM",
      message: timedOut ? "Trợ lý AI phản hồi quá lâu." : "Không gọi được trợ lý AI.",
      detail: timedOut ? `quá ${AI_TIMEOUT_MS} ms` : clean((error as Error)?.message, 200),
    };
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 429) return { ok: false, status: 429, code: "AI_BUSY", message: "Trợ lý AI đang bận; thử lại sau ít phút.", detail: text.slice(0, 300) };
  if (!response.ok) return { ok: false, status: 502, code: "AI_UPSTREAM", message: "Trợ lý AI đang lỗi.", detail: `HTTP ${response.status} ${text.slice(0, 300)}` };
  let data: Json;
  try { data = JSON.parse(text); } catch { return { ok: false, status: 502, code: "AI_UPSTREAM", message: "Trợ lý AI trả kết quả không hợp lệ.", detail: "phản hồi không phải JSON" }; }
  const usage = (data.usage ?? {}) as Json;
  const meta = {
    model: clean(data.model, 80) || MODEL,
    inputTokens: Number.isFinite(Number(usage.input_tokens)) ? Number(usage.input_tokens) : null,
    outputTokens: Number.isFinite(Number(usage.output_tokens)) ? Number(usage.output_tokens) : null,
  };
  if (data.stop_reason === "refusal") {
    return { ok: true, intent: { intent: "other", itNumber: null, copies: null, reply: REFUSAL_REPLY, needs: [] }, ...meta };
  }
  const blocks = Array.isArray(data.content) ? data.content as Json[] : [];
  const output = blocks.find((block) => block?.type === "text" && typeof block.text === "string")?.text as string | undefined;
  let parsedOutput: unknown = null, jsonOk = false;
  try { parsedOutput = output ? JSON.parse(output) : null; jsonOk = Boolean(output); } catch { jsonOk = false; }
  const intent = jsonOk ? guard(parsedOutput) : null;
  if (!intent) {
    return { ok: false, status: 502, code: "AI_UPSTREAM", message: jsonOk ? "Mô hình trả dữ liệu sai khuôn" : "Trợ lý AI trả kết quả không hợp lệ.", detail: `stop_reason ${String(data.stop_reason ?? "?")}: ${String(output ?? "").slice(0, 200)}` };
  }
  return { ok: true, intent, ...meta };
}

// Nhật ký: câu nói ≤ 300 ký tự, không ghi token/JWT. Lỗi ghi chỉ in ra log Edge, không làm hỏng phản hồi.
async function writeLog(user: { id: string; email: string }, message: string, result: Extract<AiResult, { ok: true }>): Promise<void> {
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/print_assistant_log`, {
      method: "POST",
      headers: dbHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify({
        user_id: user.id,
        user_email: user.email || null,
        message: message.slice(0, MAX_MESSAGE),
        intent: result.intent.intent,
        it_number: result.intent.itNumber,
        copies: result.intent.copies,
        reply: result.intent.reply,
        model: result.model,
        input_tokens: result.inputTokens,
        output_tokens: result.outputTokens,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) console.error("print-assistant: ghi nhật ký HTTP", response.status, (await response.text()).slice(0, 200));
  } catch (error) {
    console.error("print-assistant: không ghi được nhật ký", (error as Error)?.message);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return fail(405, "METHOD", "Chỉ nhận POST.");
  if (PUBLIC_KEYS.length && !PUBLIC_KEYS.includes(request.headers.get("apikey") ?? "")) {
    return fail(401, "BAD_KEY", "Thiếu hoặc sai khoá ứng dụng.");
  }
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(503, "NO_DB_KEY", "Máy chủ thiếu cấu hình Supabase.");

  let user: { id: string; email: string };
  try {
    user = await authenticate(request);
  } catch (error) {
    const message = clean((error as Error)?.message, 300);
    if (message.startsWith("AUTH:")) return fail(401, "AUTH", message.slice(5));
    if (message.startsWith("FORBIDDEN:")) return fail(403, "FORBIDDEN", message.slice(10));
    return fail(503, "AUTH_CHECK_FAILED", `Không xác minh được Admin: ${message}`);
  }
  if (!ANTHROPIC_API_KEY) return fail(503, "NO_AI_KEY", "Máy chủ chưa được cấu hình khoá trợ lý AI (ANTHROPIC_API_KEY).");

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY) return fail(400, "INVALID_INPUT", "Dữ liệu gửi lên quá lớn.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(400, "BAD_JSON", "Dữ liệu gửi lên không phải JSON.");
  }
  const input = readInput(body);
  if (typeof input === "string") return fail(400, "INVALID_INPUT", input);

  const result = await askAnthropic(input);
  if (!result.ok) {
    console.error("print-assistant thất bại", result.code, result.detail);
    return fail(result.status, result.code, result.message);
  }
  await writeLog(user, input.message, result);
  return reply(200, {
    ok: true,
    data: result.intent,
    meta: { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens },
  });
});
