// TÌM SKU bằng camera — đọc chữ trên tem nhà cung cấp bằng Gemini (30/09/2026).
//
// Trang TÌM SKU (index.html, #find-sku) gửi ảnh tem đã nén; hàm này:
//   1. chặn request không mang publishable key của project;
//   2. trừ một lượt trong public.sku_vision_take (supabase/sku_vision_v1.sql) —
//      ứng dụng mở công khai nên bộ đếm là thứ giữ hạn mức Gemini miễn phí;
//   3. gọi Gemini generateContent với ảnh + khuôn JSON, trả chữ thô và từ khoá
//      theo vai (mã / thông số / màu / thương hiệu).
// Đối chiếu với danh mục SKU_Name chạy trong trình duyệt (NDS_ENGINE), không ở đây.
//
// Secrets (Supabase Dashboard → Edge Functions → Secrets):
//   GEMINI_API_KEY           bắt buộc — khoá Google AI Studio, không bao giờ nằm trong index.html
//   GEMINI_MODELS            tuỳ chọn, thứ tự thử, mặc định "gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.5-flash-lite"
//                            (đo 30/09/2026 trên 2 tem thật: cả ba đọc đúng 5/5 mã và thông số; 3.1-flash-lite
//                            nhanh nhất ~3 giây và luôn trả được, còn 3.8-flash liên tục 503 quá tải ở gói miễn phí;
//                            gemini-3.5-flash cũng 503, gemini-2.5-flash-lite đã bị Google ngừng — 404)
//   SKU_VISION_DEVICE_DAILY  tuỳ chọn, số lượt mỗi máy mỗi ngày, mặc định 60
//   SKU_VISION_GLOBAL_DAILY  tuỳ chọn, tổng lượt mỗi ngày (giờ Pacific), mặc định 450
//   SKU_VISION_HEDGE_MS      tuỳ chọn, model đang chạy quá chừng này mili giây chưa trả thì gọi thêm model
//                            kế tiếp chạy song song, mặc định 6000
// Triển khai với verify_jwt = false: publishable key dạng sb_publishable_ không
// phải JWT, hàm tự kiểm tra header apikey.

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODELS = (Deno.env.get("GEMINI_MODELS") ?? "gemini-3.1-flash-lite,gemini-3.8-flash,gemini-3.5-flash-lite")
  .split(",").map((model) => model.trim()).filter(Boolean);
const DEVICE_DAILY = positiveInt(Deno.env.get("SKU_VISION_DEVICE_DAILY"), 60);
const GLOBAL_DAILY = positiveInt(Deno.env.get("SKU_VISION_GLOBAL_DAILY"), 450);
const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
// Khoá mới (SUPABASE_SECRET_KEYS, JSON dictionary) trước; khoá JWT cũ đã bị Supabase đánh dấu
// Deprecated nên chỉ còn là dự phòng.
const SERVICE_KEY = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PUBLIC_KEYS = [...keyList(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")), ...keyList(Deno.env.get("SUPABASE_ANON_KEY"))];
const MAX_IMAGE_BASE64 = 6_000_000; // ~4,5 MB ảnh; trang web nén còn ~0,5 MB
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
// Model chính thường trả trong 2–3 giây, nhưng lúc Gemini quá tải nó treo: đo 10/10/2026, gemini-3.1-flash-lite
// quá 20 giây không trả rồi gemini-3.8-flash mất 14 giây; trước đó có lượt cả ba model lần lượt hết 20 giây nên
// trang báo "AI chưa đọc được tem". Vì vậy không thử tuần tự nữa: model chạy quá HEDGE_MS thì gọi thêm model kế
// tiếp song song (lỗi tạm thời thì gọi ngay), model nào trả trước thì dùng và huỷ các lượt còn lại. Mỗi model
// được chờ tới 40 giây: 3 model × 6 giây so le + 40 giây + 10 giây bộ đếm vẫn dưới 90 giây chờ của trang web.
const MODEL_TIMEOUT_MS = 40_000;
const HEDGE_MS = positiveInt(Deno.env.get("SKU_VISION_HEDGE_MS"), 6_000);
// 429 hết hạn mức model này, 404 model không còn, 5xx lỗi tạm: model khác vẫn có thể đọc được.
const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);
// Đọc chữ không cần suy nghĩ: thinkingBudget 0 bỏ ~590 token nghĩ của gemini-3.8-flash. Có model từ chối
// tham số này (gemini-3.5-flash-lite trả 400) — gửi lại không kèm và nhớ để các lượt sau khỏi thử.
const NO_THINKING_CONFIG = new Set<string>();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Max-Age": "86400",
};

const PROMPT = `You read supplier labels photographed in a garment factory warehouse: thread cones, fabric roll tags, zipper, button and label packs.
First transcribe ALL printed text exactly as it appears, line by line, into raw_text. Keep the original spelling, leading zeros, hyphens and slashes. Do not translate. Never invent characters you cannot see; write ? for a character you cannot read.
Then sort the meaningful pieces of that text:
- item_codes: supplier article, colour or shade codes and catalogue numbers that identify the exact product or colour (for example N0144, C3966, FS0709, F9-5374, 8754, VPGQ14035).
- specs: technical specifications such as thread ticket or size (Tkt 120, Tex 27, 30/3, 40/2, 100D/2), length or weight (5000m, 3000M, 500g), width, gsm, size.
- colors: colour names exactly as printed.
- brands: brand, product line or supplier names (for example ROMAN, COATS, astra, Gramax).
- others: remaining meaningful words such as fibre content. Skip generic phrases like "Made in Vietnam" or "High Quality".
quality: "ro" if all label text is clearly readable, "mo" if part of it is blurry or uncertain, "khong_doc_duoc" if no label text can be read.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    raw_text: { type: "STRING" },
    item_codes: { type: "ARRAY", items: { type: "STRING" } },
    specs: { type: "ARRAY", items: { type: "STRING" } },
    colors: { type: "ARRAY", items: { type: "STRING" } },
    brands: { type: "ARRAY", items: { type: "STRING" } },
    others: { type: "ARRAY", items: { type: "STRING" } },
    quality: { type: "STRING", enum: ["ro", "mo", "khong_doc_duoc"] },
  },
  required: ["raw_text", "item_codes", "specs", "colors", "brands", "others", "quality"],
};

function positiveInt(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

// SUPABASE_PUBLISHABLE_KEYS / SUPABASE_SECRET_KEYS có thể là JSON (object hoặc
// mảng) hoặc chuỗi phân tách bằng dấu phẩy — đọc cả hai dạng.
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

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
}

function fail(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return reply(status, { ok: false, code, message, ...extra });
}

async function takeQuota(device: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sku_vision_take`, {
    method: "POST",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_device: device, p_device_limit: DEVICE_DAILY, p_global_limit: GLOBAL_DAILY }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Bộ đếm lượt HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return await response.json();
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 40) : [];

function askGemini(model: string, mime: string, image: string, thinkingOff: boolean, signal: AbortSignal): Promise<Response> {
  const generationConfig: Record<string, unknown> = { temperature: 0, responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA };
  if (thinkingOff) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  return fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: image } }, { text: PROMPT }] }],
      generationConfig,
    }),
    signal,
  });
}

async function readLabel(model: string, mime: string, image: string, stop: AbortSignal) {
  const signal = AbortSignal.any([stop, AbortSignal.timeout(MODEL_TIMEOUT_MS)]);
  let response = await askGemini(model, mime, image, !NO_THINKING_CONFIG.has(model), signal);
  if (response.status === 400 && !NO_THINKING_CONFIG.has(model)) {
    NO_THINKING_CONFIG.add(model);
    await response.body?.cancel();
    response = await askGemini(model, mime, image, false, signal);
  }
  const text = await response.text();
  if (!response.ok) {
    return { ok: false as const, status: response.status, detail: text.slice(0, 300) };
  }
  const data = JSON.parse(text);
  const candidate = data?.candidates?.[0];
  const output = (candidate?.content?.parts ?? []).map((part: { text?: string }) => part.text ?? "").join("");
  if (!output) {
    return { ok: false as const, status: 502, detail: `Gemini không trả nội dung (finishReason ${candidate?.finishReason ?? "?"})` };
  }
  const parsed = JSON.parse(output);
  return {
    ok: true as const,
    result: {
      text: String(parsed.raw_text ?? ""),
      tokens: {
        item_codes: strings(parsed.item_codes),
        specs: strings(parsed.specs),
        colors: strings(parsed.colors),
        brands: strings(parsed.brands),
        others: strings(parsed.others),
      },
      quality: ["ro", "mo", "khong_doc_duoc"].includes(parsed.quality) ? parsed.quality : "mo",
      usage: data?.usageMetadata ?? null,
    },
  };
}

type Attempt = { model: string; status: number | string; ms: number };
type LabelRead = Extract<Awaited<ReturnType<typeof readLabel>>, { ok: true }>["result"];
type ModelsRead = { model?: string; result?: LabelRead; attempts: Attempt[]; errors: string[]; busy: boolean };

// Thử các model theo thứ tự GEMINI_MODELS, so le HEDGE_MS chứ không chờ model trước treo hết giờ.
// Ghi lại từng lượt thử (model · kết quả · ms) để thấy model nào hay quá tải mà đổi thứ tự GEMINI_MODELS.
function readFromModels(mime: string, image: string): Promise<ModelsRead> {
  const attempts: Attempt[] = [];
  const errors: string[] = [];
  const stop = new AbortController();
  const running = new Map<string, number>(); // model đang chờ → lúc bắt đầu gọi
  let next = 0, halted = false, done = false;
  let hedge: ReturnType<typeof setTimeout> | undefined;
  return new Promise((resolve) => {
    const finish = (model?: string, result?: LabelRead) => {
      done = true;
      clearTimeout(hedge);
      running.forEach((tried, slow) => attempts.push({ model: slow, status: "cancelled", ms: Date.now() - tried }));
      stop.abort();
      resolve({ model, result, attempts, errors, busy: !halted });
    };
    const launch = () => {
      clearTimeout(hedge);
      if (done) return;
      if (halted || next >= MODELS.length) {
        if (!running.size) finish();
        return;
      }
      const model = MODELS[next++];
      const tried = Date.now();
      running.set(model, tried);
      readLabel(model, mime, image, stop.signal).then((read) => {
        if (done) return;
        running.delete(model);
        attempts.push({ model, status: read.ok ? 200 : read.status, ms: Date.now() - tried });
        if (read.ok) return finish(model, read.result);
        errors.push(`${model}: HTTP ${read.status} ${read.detail}`);
        // Lỗi không phải tạm thời (khoá sai, yêu cầu hỏng…) thì model khác cũng lỗi: không gọi thêm.
        if (!RETRYABLE.has(read.status)) halted = true;
      }, (error) => {
        if (done) return; // bị huỷ vì model khác đã đọc xong
        running.delete(model);
        const timedOut = (error as Error).name === "TimeoutError";
        attempts.push({ model, status: timedOut ? "timeout" : "error", ms: Date.now() - tried });
        errors.push(`${model}: ${timedOut ? `quá ${MODEL_TIMEOUT_MS / 1000} giây không phản hồi` : (error as Error).message}`);
      }).finally(launch);
      hedge = setTimeout(launch, HEDGE_MS);
    };
    launch();
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return fail(405, "METHOD", "Chỉ nhận POST.");
  if (PUBLIC_KEYS.length && !PUBLIC_KEYS.includes(request.headers.get("apikey") ?? "")) {
    return fail(401, "BAD_KEY", "Thiếu hoặc sai khoá ứng dụng.");
  }
  if (!GEMINI_API_KEY) return fail(503, "NO_AI_KEY", "Máy chủ chưa được cấu hình khoá Gemini (GEMINI_API_KEY).");
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(503, "NO_DB_KEY", "Máy chủ thiếu cấu hình Supabase.");

  let body: { image?: unknown; mime?: unknown; device?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, "BAD_JSON", "Dữ liệu gửi lên không phải JSON.");
  }
  const image = typeof body.image === "string" ? body.image.replace(/^data:[^,]+,/, "") : "";
  const mime = typeof body.mime === "string" && MIME_TYPES.has(body.mime) ? body.mime : "image/jpeg";
  const device = typeof body.device === "string" ? body.device.slice(0, 64) : "";
  if (!image || !/^[A-Za-z0-9+/=]+$/.test(image)) return fail(400, "NO_IMAGE", "Chưa có ảnh tem hợp lệ.");
  if (image.length > MAX_IMAGE_BASE64) return fail(413, "IMAGE_TOO_LARGE", "Ảnh quá nặng — chụp lại hoặc chọn ảnh nhỏ hơn.");

  let quota: Record<string, unknown>;
  try {
    quota = await takeQuota(device);
  } catch (error) {
    return fail(503, "QUOTA_CHECK_FAILED", `Không kiểm tra được hạn mức: ${(error as Error).message}`);
  }
  if (!quota.ok) {
    const message = quota.code === "DEVICE_LIMIT"
      ? `Máy này đã dùng hết ${DEVICE_DAILY} lượt đọc tem hôm nay — gõ mã in trên tem để tìm.`
      : `Hôm nay đã dùng hết ${GLOBAL_DAILY} lượt đọc tem của cả kho — gõ mã in trên tem để tìm.`;
    return fail(429, String(quota.code), message, { usage: quota });
  }

  const started = Date.now();
  const { model, result, attempts, errors, busy } = await readFromModels(mime, image);
  if (result) return reply(200, { ok: true, model, ms: Date.now() - started, attempts, ...result, quota });
  console.error("sku-vision thất bại", errors.join(" | "));
  // Ảnh mờ không rơi vào đây (Gemini vẫn trả quality "khong_doc_duoc"); tới đây là Gemini lỗi hoặc quá tải,
  // nên đừng bảo người dùng chụp lại.
  return fail(502, "AI_FAILED", busy ? "AI đang quá tải, chưa đọc được tem." : "AI chưa đọc được tem.",
    { attempts, detail: errors.join(" | ").slice(0, 600) });
});
