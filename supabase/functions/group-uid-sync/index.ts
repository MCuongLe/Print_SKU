const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_KEY = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ALLOWED_ORIGINS = new Set(["https://mcuongle.github.io", "http://localhost:8000", "http://127.0.0.1:8000"]);
const MAX_PAGE_SIZE = 500;
type Json = Record<string, unknown>;

function keyList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed ? Object.values(parsed) : [parsed];
    return values.map(String).filter(Boolean);
  } catch { return raw.split(",").map(value => value.trim()).filter(Boolean); }
}
function firstKey(raw: string | undefined): string { return keyList(raw)[0] ?? ""; }
function clean(value: unknown, max = 500): string { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return { "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://mcuongle.github.io", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Max-Age": "86400", Vary: "Origin" };
}
function reply(request: Request, status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(request), "Content-Type": "application/json; charset=utf-8" } });
}
function fail(request: Request, status: number, code: string, message: string): Response { return reply(request, status, { ok: false, error: { code, message } }); }
function dbHeaders(extra: Record<string, string> = {}): Record<string, string> { return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra }; }
async function db(path: string, init: RequestInit = {}): Promise<Response> { return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: dbHeaders(init.headers as Record<string, string> ?? {}) }); }
async function jsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
async function fetchAll(path: string, pageSize = 1000): Promise<Json[]> {
  const rows: Json[] = [];
  for (let start = 0; start < 100000; start += pageSize) {
    const response = await db(path, { headers: { Range: `${start}-${start + pageSize - 1}` } });
    const page = await jsonResponse(response, "Đọc database") as Json[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
async function rpc(name: string, body: Json): Promise<Json> {
  const response = await db(`rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  return await jsonResponse(response, name) as Json;
}
async function authenticate(request: Request): Promise<{ id: string; username: string }> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new Error("AUTH:Phiên Admin không hợp lệ");
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authorization } });
  const user = await jsonResponse(userResponse, "Xác minh người dùng") as Json;
  const roles = await fetchAll(`user_roles?select=username,role&user_id=eq.${encodeURIComponent(String(user.id))}&limit=1`);
  if (!roles[0] || roles[0].role !== "admin") throw new Error("FORBIDDEN:Chỉ Admin được đồng bộ Group UID");
  return { id: String(user.id), username: clean(roles[0].username || "Admin", 120) };
}
function uuid(value: unknown): string {
  const id = clean(value, 80);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("INVALID_RUN:Mã lượt đồng bộ không hợp lệ");
  return id;
}
function dateValue(value: unknown, label: string): string {
  const date = new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw new Error(`INVALID_DATE:${label} không hợp lệ`);
  return date.toISOString();
}
function normalizedRows(value: unknown): Json[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE_SIZE) throw new Error("INVALID_PAGE:Mỗi trang tối đa 500 Group UID");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const row = (raw ?? {}) as Json;
    const code = clean(row.group_uid_code, 40), qty = Number(row.qty), status = clean(row.status, 100);
    const products = Array.isArray(row.products) ? row.products.map((value, productIndex) => {
      const product = (value ?? {}) as Json, sku = clean(product.sku, 80), quantity = Number(product.quantity);
      if (!sku || !Number.isFinite(quantity) || quantity < 0) throw new Error(`INVALID_ROW:Group UID ${code || index + 1} có SKU thành phần ${productIndex + 1} không hợp lệ`);
      return { sku, quantity, product_name: clean(product.product_name, 500) || null };
    }) : [];
    if (!/^\d{6,40}$/.test(code) || seen.has(code)) throw new Error(`INVALID_ROW:Dòng ${index + 1} có Group UID rỗng, sai hoặc trùng`);
    if (!Number.isFinite(qty) || qty < 0 || !status) throw new Error(`INVALID_ROW:Group UID ${code} thiếu số lượng hoặc trạng thái`);
    seen.add(code);
    return {
      group_uid_code: code, batch_code: clean(row.batch_code, 120) || null, roll_code: clean(row.roll_code, 120) || null,
      warehouse: clean(row.warehouse, 240) || null, location: clean(row.location, 240) || null, sku: clean(row.sku, 80) || null,
      qty, updated_by: clean(row.updated_by, 240) || null, updated_date: dateValue(row.updated_date, `Ngày cập nhật UID ${code}`), status, products,
    };
  });
}
async function prepare(request: Request, user: { id: string }, body: Json): Promise<Response> {
  const mode = clean(body.mode, 20);
  if (!['incremental','full'].includes(mode)) return fail(request, 400, "INVALID_MODE", "Chế độ đồng bộ không hợp lệ");
  const data = await rpc("group_uid_sync_prepare", { p_mode: mode, p_range_to: new Date().toISOString(), p_created_by: user.id });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function ingest(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId), page = Math.floor(Number(body.page)), totalPages = Math.floor(Number(body.totalPages));
  const total = Math.max(0, Math.floor(Number(body.total) || 0)), rows = normalizedRows(body.rows);
  if (page < 1 || totalPages < 1 || page > totalPages) return fail(request, 400, "INVALID_PAGE", "Số trang Group UID không hợp lệ");
  const runs = await fetchAll(`group_uid_sync_runs?select=id,status,expected_pages&id=eq.${encodeURIComponent(runId)}&limit=1`);
  const run = runs[0];
  if (!run) return fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ Group UID");
  if (run.status !== "running") return fail(request, 409, "NOT_RUNNING", "Lượt đồng bộ không còn nhận dữ liệu");
  if (run.expected_pages && Number(run.expected_pages) !== totalPages) return fail(request, 409, "PAGE_COUNT_CHANGED", "Tổng số trang WMS thay đổi trong lúc đồng bộ");
  if (rows.length) {
    const staged = rows.map(row => ({ run_id: runId, ...row }));
    const response = await db("group_uid_sync_staging?on_conflict=run_id,group_uid_code", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(staged) });
    await jsonResponse(response, "Lưu trang Group UID");
  }
  const pageResponse = await db("group_uid_sync_pages?on_conflict=run_id,page_no", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ run_id: runId, page_no: page, row_count: rows.length }) });
  await jsonResponse(pageResponse, "Lưu tiến độ Group UID");
  const pages = await fetchAll(`group_uid_sync_pages?select=page_no&run_id=eq.${encodeURIComponent(runId)}`);
  const patch = await db(`group_uid_sync_runs?id=eq.${encodeURIComponent(runId)}&status=eq.running`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ expected_pages: totalPages, page_count: pages.length, source_count: total }) });
  await jsonResponse(patch, "Cập nhật tiến độ Group UID");
  return reply(request, 200, { ok: true, data: { runId, page, pageCount: pages.length, totalPages, rowCount: rows.length }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
function changeView(row: Json): Json {
  return { id: row.id, groupUidCode: row.group_uid_code, changeType: row.change_type, before: row.before_data, after: row.after_data, changedFields: row.changed_fields, sourceUpdatedAt: row.source_updated_at };
}
async function changes(runId: string, type = "", limit = 1000): Promise<Json[]> {
  const filter = type ? `&change_type=eq.${encodeURIComponent(type)}` : "";
  const rows = await fetchAll(`group_uid_sync_changes?select=*&run_id=eq.${encodeURIComponent(runId)}${filter}&order=id.asc&limit=${Math.min(limit, 1000)}`);
  return rows.map(changeView);
}
async function preview(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId), data = await rpc("group_uid_sync_preview", { p_run_id: runId });
  data.changes = await changes(runId);
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function apply(request: Request, body: Json): Promise<Response> {
  const data = await rpc("group_uid_sync_apply", { p_run_id: uuid(body.runId) });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function history(request: Request, body: Json): Promise<Response> {
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const runs = await fetchAll(`group_uid_sync_runs?select=id,mode,status,range_from,range_to,page_count,source_count,change_counts,verification,error_message,created_at,completed_at,created_by&order=created_at.desc&limit=${limit}`);
  const state = (await fetchAll("group_uid_sync_state?select=*&singleton=eq.true&limit=1"))[0] || {};
  return reply(request, 200, { ok: true, data: { runs, state }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function detail(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId), type = clean(body.changeType, 30);
  const runs = await fetchAll(`group_uid_sync_runs?select=*&id=eq.${encodeURIComponent(runId)}&limit=1`);
  if (!runs[0]) return fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ Group UID");
  return reply(request, 200, { ok: true, data: { ...runs[0], changes: await changes(runId, type) }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function cancel(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId), message = clean(body.message || "Phiên bị dừng trước khi hoàn tất", 500);
  const response = await db(`group_uid_sync_runs?id=eq.${encodeURIComponent(runId)}&status=in.(running,previewed)`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "failed", error_message: message, completed_at: new Date().toISOString() }) });
  const rows = await jsonResponse(response, "Dừng phiên Group UID") as Json[];
  await jsonResponse(await db(`group_uid_sync_pages?run_id=eq.${encodeURIComponent(runId)}`, { method: "DELETE" }), "Dọn tiến độ Group UID");
  await jsonResponse(await db(`group_uid_sync_staging?run_id=eq.${encodeURIComponent(runId)}`, { method: "DELETE" }), "Dọn staging Group UID");
  return reply(request, 200, { ok: true, data: rows[0] || { id: runId, status: "failed" }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return fail(request, 405, "METHOD", "Chỉ nhận POST");
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(request, 503, "NO_DB_KEY", "Edge Function chưa có cấu hình database");
  try {
    const user = await authenticate(request), body = await request.json() as Json, action = clean(body.action, 30);
    if (action === "prepare") return await prepare(request, user, body);
    if (action === "ingest") return await ingest(request, body);
    if (action === "preview") return await preview(request, body);
    if (action === "apply") return await apply(request, body);
    if (action === "history") return await history(request, body);
    if (action === "detail") return await detail(request, body);
    if (action === "cancel") return await cancel(request, body);
    if (action === "health") return reply(request, 200, { ok: true, data: { extensionRequired: true, user: user.username, overlapMinutes: 30 }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
    return fail(request, 400, "UNKNOWN_ACTION", "Thao tác không được hỗ trợ");
  } catch (error) {
    const message = clean((error as Error).message, 500);
    if (message.startsWith("AUTH:")) return fail(request, 401, "AUTH", message.slice(5));
    if (message.startsWith("FORBIDDEN:")) return fail(request, 403, "FORBIDDEN", message.slice(10));
    if (message.includes("FULL_REQUIRED")) return fail(request, 409, "FULL_REQUIRED", "Cần chạy đối chiếu toàn bộ lần đầu trước khi đồng bộ thay đổi");
    if (message.includes("ACTIVE_RUN") || message.includes("duplicate key")) return fail(request, 409, "ACTIVE_RUN", "Đang có một lượt đồng bộ Group UID chưa kết thúc");
    if (message.includes("PAGES_INCOMPLETE")) return fail(request, 409, "PAGES_INCOMPLETE", "Chưa nhận đủ các trang Group UID từ WMS");
    if (message.includes("SOURCE_COUNT_MISMATCH")) return fail(request, 409, "SOURCE_COUNT_MISMATCH", "Số UID duy nhất không khớp tổng WMS; phiên đã dừng để tránh thiếu dữ liệu");
    if (message.includes("FULL_SOURCE_TOO_SMALL")) return fail(request, 409, "FULL_SOURCE_TOO_SMALL", "Dữ liệu đối chiếu toàn bộ dưới 1.000 UID; đã dừng để tránh cập nhật từ nguồn thiếu");
    if (message.includes("PREVIEW_EXPIRED")) return fail(request, 409, "STALE_PREVIEW", "Bản xem trước đã quá 30 phút; hãy kiểm tra lại dữ liệu WMS");
    const tagged = message.match(/^(INVALID_[A-Z_]+):(.*)$/);
    if (tagged) return fail(request, 400, tagged[1], tagged[2]);
    return fail(request, 500, "SYNC_ERROR", message || "Không xử lý được yêu cầu đồng bộ Group UID");
  }
});
