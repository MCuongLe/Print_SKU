const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_KEY = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ALLOWED_ORIGINS = new Set(["https://mcuongle.github.io", "http://localhost:8000", "http://127.0.0.1:8000"]);
const MAX_PAGE_SIZE = 500;
type Json = Record<string, unknown>;
// Đồng bộ tự động (sync_auto_v1.sql): ngưỡng mặc định khi bảng cấu hình thiếu hoặc thiếu khoá; bản chép giống sku-sync/index.ts (deploy gửi 1 tệp).
const DEFAULT_THRESHOLDS: Record<string, Record<string, number>> = {
  group_uid: { maxChanges: 3000, maxMissing: 0, maxIssues: 0 },
  sku: { maxUpdated: 500, maxAdded: 500, maxMissing: 20, maxOrphaned: 0 },
};
const AUTO_KINDS = new Set(["sku", "group_uid"]);
const LEASE_TTL_SECONDS = 900;
// holder = tên máy (≤ 60) + "#" + mã máy (Extension 0.10.0) → tối đa 80 ký tự, khớp sync_auto_lease.
const HOLDER_MAX = 80;

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
function count(value: number): string { return value.toLocaleString("vi-VN"); }
function limitOf(raw: unknown, fallback: number): number { const value = Number(raw); return Number.isFinite(value) && value >= 0 ? value : fallback; }
function thresholdsFor(kind: string, all: unknown): Record<string, number> {
  const base = DEFAULT_THRESHOLDS[kind], given = ((all ?? {}) as Json)[kind] as Json | undefined;
  return Object.fromEntries(Object.entries(base).map(([key, fallback]) => [key, limitOf(given?.[key], fallback)]));
}
// Ngưỡng "Vừa" Group UID: thiếu = 0, cảnh báo (WMS cũ hơn) = 0, mới + cập nhật ≤ 3.000. Vượt → giữ bản xem trước cho Admin.
export function evaluateGroupUidHold(counts: unknown, thresholds: unknown): { reason: string; counts: Json } | null {
  const c = (counts ?? {}) as Json, t = thresholdsFor("group_uid", { group_uid: thresholds });
  const added = Number(c.added) || 0, updated = Number(c.updated) || 0, missing = Number(c.missing) || 0, issues = Number(c.issues) || 0;
  const reasons: string[] = [];
  if (added + updated > t.maxChanges) reasons.push(`${count(added + updated)} thay đổi vượt ngưỡng ${count(t.maxChanges)}`);
  if (missing > t.maxMissing) reasons.push(`${count(missing)} UID không còn trên WMS`);
  if (issues > t.maxIssues) reasons.push(`${count(issues)} UID WMS cũ hơn Supabase`);
  return reasons.length ? { reason: `Giữ lại: ${reasons.join("; ")}`, counts: { added, updated, missing, issues, totalChanges: added + updated } } : null;
}
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
    if (response.status === 416) break;
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
  if (userResponse.status === 401 || userResponse.status === 403) throw new Error("AUTH:Phiên Admin không hợp lệ");
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
// Mã RFID dán trên cuộn (WMS group_rfid_mapping): chuỗi 1–40 chữ/số → viết hoa; null / rỗng → null; có giá trị nhưng sai dạng
// (ký tự lạ, dài quá 40 — không cắt bớt, không phải chuỗi) → undefined = "không biết" (known = false, giữ RFID đang lưu).
function rfidCode(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  if (!code) return null;
  return /^[A-Za-z0-9]{1,40}$/.test(code) ? code.toUpperCase() : undefined;
}
// Số PO nguồn của UID (WMS processing_source_code khi processing_source_type = PURCHASE_ORDER; Extension tự lọc): chuỗi 6–40
// chữ số như cut_sample_sessions.po; null / rỗng → null (UID không nhận theo PO); có giá trị nhưng sai dạng (ký tự lạ, ngắn/dài,
// không phải chuỗi — không cắt bớt) → undefined = "không biết" (known = false, giữ PO đang lưu).
function purchaseOrderCode(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  if (!code) return null;
  return /^[0-9]{6,40}$/.test(code) ? code : undefined;
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
    const rfid = rfidCode(row.group_rfid_mapping);
    const po = purchaseOrderCode(row.purchase_order);
    const poKnown = Object.prototype.hasOwnProperty.call(row, "purchase_order") && po !== undefined && row.purchase_order_known !== false;
    if (!Number.isFinite(qty) || qty < 0 || !status) throw new Error(`INVALID_ROW:Group UID ${code} thiếu số lượng hoặc trạng thái`);
    seen.add(code);
    return {
      group_uid_code: code, batch_code: clean(row.batch_code, 120) || null, roll_code: clean(row.roll_code, 120) || null,
      warehouse: clean(row.warehouse, 240) || null, location: clean(row.location, 240) || null, sku: clean(row.sku, 80) || null,
      qty, updated_by: clean(row.updated_by, 240) || null, updated_date: dateValue(row.updated_date, `Ngày cập nhật UID ${code}`), status, products,
      // Trạng thái QC WMS (quality_control_status_name). Extension cũ không gửi → null → apply không ghi đè giá trị đã lưu.
      // Cột staging.qc_status có từ migration group_uid_qc_status_v1.sql: phải chạy migration trước khi deploy bản này.
      qc_status: clean(row.qc_status, 60) || null,
      // RFID (group_uid_rfid_v1.sql, phải chạy migration trước khi deploy bản này). Extension 0.10.2+ luôn gửi khoá (kể cả null)
      // → known = true, apply ghi đúng nguồn (null = WMS gỡ RFID → xoá theo). Extension cũ / web cũ không có khoá → known = false,
      // preview/apply bỏ qua RFID và giữ giá trị đang lưu.
      group_rfid_mapping: rfid ?? null,
      group_rfid_known: Object.prototype.hasOwnProperty.call(row, "group_rfid_mapping") && rfid !== undefined,
      // Số PO nguồn (cut_group_uid_po_v1.sql, phải chạy migration trước khi deploy bản này). Như RFID: có khoá purchase_order
      // (Extension mới luôn gửi, null khi nguồn không phải PO) → known = true, apply ghi đúng nguồn; Extension cũ không có khoá,
      // giá trị sai dạng, hoặc Extension gửi rõ purchase_order_known = false → known = false, preview/apply giữ PO đang lưu.
      purchase_order: poKnown ? po ?? null : null,
      purchase_order_known: poKnown,
    };
  });
}
// Lượt tự động từ Extension gửi source "auto" + tên máy; thiếu trường (web, Extension cũ) → "manual" như trước.
function runSource(value: unknown): "auto" | "manual" { return value === "auto" ? "auto" : "manual"; }
function deviceName(value: unknown): string | null { return clean(value, 60) || null; }
async function prepare(request: Request, user: { id: string }, body: Json): Promise<Response> {
  const mode = clean(body.mode, 20);
  if (!['incremental','full'].includes(mode)) return fail(request, 400, "INVALID_MODE", "Chế độ đồng bộ không hợp lệ");
  // Cổng bản Extension (sync_auto_v3.sql), lượt tự động lẫn lượt tay, trước khi mở lượt.
  await recordDevice("group_uid", body);
  const outdated = extensionGate(request, "group_uid", body, await autoSettings());
  if (outdated) return outdated;
  const data = await rpc("group_uid_sync_prepare", { p_mode: mode, p_range_to: new Date().toISOString(), p_created_by: user.id, p_source: runSource(body.source), p_device: deviceName(body.device) });
  // Bản Extension của lượt: PATCH sau khi có runId (giữ chữ ký RPC); cột chưa có (Edge lên trước migration) hay lỗi mạng → bỏ qua.
  const extVersion = extVersionOf(body.extVersion), runId = clean(data?.runId, 80);
  if (extVersion && /^[0-9a-f-]{36}$/i.test(runId)) {
    try {
      const patch = await db(`group_uid_sync_runs?id=eq.${encodeURIComponent(runId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ ext_version: extVersion }) });
      await jsonResponse(patch, "Ghi bản Extension của lượt");
    } catch {
      // Bỏ qua: lượt vẫn chạy, chỉ thiếu bản trên dòng lượt.
    }
  }
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
  const runId = uuid(body.runId);
  // Lượt tự động (source lưu trên lượt, không tin cờ caller): máy gửi phải còn giữ khoá thuê. Mất khoá → đóng lượt (failed) để
  // không chặn máy đang giữ khoá bằng ACTIVE_RUN, không ghi bản xem trước. Lượt tay (web) không kiểm như cũ.
  const run = (await fetchAll(`group_uid_sync_runs?select=id,status,source&id=eq.${encodeURIComponent(runId)}&limit=1`))[0];
  if (run?.source === "auto" && !(await holdsLease("group_uid", body.holder))) {
    await closeRun(runId, "Mất khoá thuê");
    return fail(request, 409, "LEASE_LOST", "Mất khoá thuê; lượt tự động đã dừng");
  }
  const data = await rpc("group_uid_sync_preview", { p_run_id: runId });
  data.changes = await changes(runId);
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
// >>> cổng bản Extension (sync_auto_v3.sql): khối chép GIỐNG HỆT ở sku-sync/index.ts và group-uid-sync/index.ts (deploy gửi 1 tệp mỗi hàm); test *_sync_function.mjs so từng ký tự
// extVersion = chrome.runtime.getManifest().version (Extension ≥ 0.10.10; web gửi bản đã PING). Mức tối thiểu theo loại ở
// sync_auto_settings.min_extension, chỉ đặt bằng SQL tay; rỗng / thiếu khoá / sai dạng / thiếu cột (Edge lên trước migration) = không chặn.
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const VERSION_KINDS = ["sku", "group_uid", "cut_adj", "storage_risk"];
const DEVICE_LIST_LIMIT = 20;
const DEVICE_LIST_DAYS = 14;
// Chuỗi "x.y.z" (mỗi đoạn 1–3 chữ số, không khoảng trắng) hoặc null = chưa khai báo.
function extVersionOf(value: unknown): string | null { return typeof value === "string" && VERSION_RE.test(value) ? value : null; }
// So theo từng đoạn số (0.10.10 > 0.10.9, không so chuỗi); chưa khai báo (null) thấp hơn mọi mức.
function versionLess(version: string | null, min: string): boolean {
  if (version === null) return true;
  const have = version.split(".").map(Number), need = min.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) if (have[index] !== need[index]) return have[index] < need[index];
  return false;
}
function minExtensionFor(kind: string, settings: Json | null): string | null {
  const all = settings?.min_extension;
  return all && typeof all === "object" && !Array.isArray(all) ? extVersionOf((all as Json)[kind]) : null;
}
function minExtensionView(settings: Json | null): Json {
  return Object.fromEntries(VERSION_KINDS.map(kind => [kind, minExtensionFor(kind, settings)]));
}
// 409 EXTENSION_OUTDATED khi có mức cho loại này mà bản thấp hơn hoặc chưa khai báo. Lượt tự động (lease, source "auto") → câu cho
// Extension; lượt tay (web) → tải lại trang trước (tab web cũ chưa gửi extVersion), rồi mới Reload Extension.
function extensionGate(request: Request, kind: string, body: Json, settings: Json | null): Response | null {
  const min = minExtensionFor(kind, settings), version = extVersionOf(body.extVersion);
  if (!min || !versionLess(version, min)) return null;
  const head = version ? `Extension v${version} quá cũ` : "Extension chưa khai báo bản";
  const tab = kind === "sku" ? "Inside" : "WMS";
  const auto = clean(body.action, 30) === "lease" || body.source === "auto";
  const next = auto ? `hãy Reload Extension rồi tải lại tab ${tab}` : `hãy tải lại trang (Ctrl+F5); nếu vẫn báo, Reload Extension rồi tải lại tab ${tab}`;
  return fail(request, 409, "EXTENSION_OUTDATED", `${head}, cần ≥ ${min}; ${next}`);
}
// holder = tên máy + "#" + mã máy (auto-sync.js holderOf); không có hậu tố mã thì cả holder là tên máy.
function holderParts(holder: string): { device: string; id: string } {
  const match = holder.match(/^(.*)#([A-Za-z0-9]+)$/);
  return match ? { device: clean(match[1], 60), id: match[2] } : { device: clean(holder, 60), id: "" };
}
// Ghi nhận máy TRƯỚC cổng (máy bị chặn vẫn hiện ở bảng Máy đồng bộ). Upsert theo holder và KHÔNG gửi first_seen_at: PostgREST chỉ
// cập nhật cột có trong payload nên lần đầu thấy giữ nguyên. ext_version ghi đè cả khi null (máy hạ bản, bản cũ không khai báo).
// Lỗi (bảng chưa có khi Edge lên trước migration, mạng) chỉ bỏ qua.
async function recordDevice(kind: string, body: Json): Promise<void> {
  const holder = clean(body.holder, 80);
  if (!holder) return;
  try {
    const row = { holder, device: holderParts(holder).device, ext_version: extVersionOf(body.extVersion), last_seen_at: new Date().toISOString(), last_kind: kind };
    const response = await db("sync_auto_devices?on_conflict=holder", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(row) });
    await jsonResponse(response, "Ghi nhận máy đồng bộ");
  } catch {
    // Bỏ qua: lượt vẫn chạy như trước khi có bảng máy.
  }
}
// Bảng Máy đồng bộ (auto-config): tối đa 20 máy thấy trong 14 ngày, mới nhất trước; chỉ 4 ký tự đầu của mã máy, không trả holder.
// Đọc lỗi → null: auto-config bỏ khoá devices (không trả [] giả như "chưa có máy nào"); bảng rỗng thật vẫn là [].
async function deviceList(): Promise<Json[] | null> {
  try {
    const since = new Date(Date.now() - DEVICE_LIST_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const rows = await fetchAll(`sync_auto_devices?select=holder,device,ext_version,last_seen_at,last_kind&last_seen_at=gte.${encodeURIComponent(since)}&order=last_seen_at.desc&limit=${DEVICE_LIST_LIMIT}`);
    return rows.slice(0, DEVICE_LIST_LIMIT).map(row => ({
      device: clean(row.device, 60), id4: holderParts(clean(row.holder, 80)).id.slice(0, 4), version: extVersionOf(row.ext_version),
      lastSeenAt: row.last_seen_at ?? null, lastKind: VERSION_KINDS.includes(String(row.last_kind)) ? String(row.last_kind) : null,
    }));
  } catch {
    return null;
  }
}
// <<< cổng bản Extension
async function autoSettings(): Promise<Json | null> {
  return (await fetchAll("sync_auto_settings?select=*&singleton=eq.true&limit=1"))[0] ?? null;
}
// Hàng rào khoá thuê: lượt tự động chỉ được ghi khi máy gửi vẫn đang giữ khoá còn hạn (máy khác đã giành khoá thì dừng).
async function holdsLease(kind: string, holder: unknown): Promise<boolean> {
  const name = clean(holder, HOLDER_MAX);
  if (!name) return false;
  const row = (await fetchAll(`sync_auto_leases?select=holder,leased_until&kind=eq.${encodeURIComponent(kind)}&limit=1`))[0];
  return Boolean(row && row.holder === name && Date.parse(String(row.leased_until)) >= Date.now());
}
async function apply(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId);
  const run = (await fetchAll(`group_uid_sync_runs?select=id,status,change_counts&id=eq.${encodeURIComponent(runId)}&limit=1`))[0];
  // held = lượt tự động đã giữ lại (sync_auto_v1.sql): dữ liệu WMS đã cũ, không áp dụng nữa.
  if (run?.status === "held") return fail(request, 409, "RUN_HELD", "Lượt đã giữ lại, chạy lại tay để xem bản mới");
  // auto:true (Extension tự chạy): phải còn giữ khoá thuê; vượt ngưỡng hoặc Admin tạm dừng → không ghi, chuyển "held" cho Admin xem.
  // Không có auto → như cũ.
  if (body.auto === true) {
    if (!(await holdsLease("group_uid", body.holder))) return fail(request, 409, "LEASE_LOST", "Mất khoá thuê; lượt tự động đã dừng");
    if (run?.status === "previewed") {
      const settings = await autoSettings();
      const held = settings?.enabled === false
        ? { reason: "Giữ lại: Admin tạm dừng đồng bộ tự động", counts: (run.change_counts ?? {}) as Json }
        : evaluateGroupUidHold(run.change_counts, (settings?.thresholds as Json | undefined)?.group_uid);
      if (held) {
        const patch = await db(`group_uid_sync_runs?id=eq.${encodeURIComponent(runId)}&status=eq.previewed`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "held", auto_hold: clean(held.reason, 300), completed_at: new Date().toISOString() }) });
        const rows = await jsonResponse(patch, "Ghi lý do giữ lại") as Json[];
        if (!rows?.length) return fail(request, 409, "NOT_READY", "Lượt đồng bộ không còn ở trạng thái chờ cập nhật");
        return reply(request, 200, { ok: true, data: { runId, status: "held", held }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
      }
    }
  }
  const data = await rpc("group_uid_sync_apply", { p_run_id: runId });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
function runView(run: Json): Json { return { ...run, source: run.source ?? "manual", device: run.device ?? null, autoHold: run.auto_hold ?? null }; }
async function history(request: Request, body: Json): Promise<Response> {
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const runs = await fetchAll(`group_uid_sync_runs?select=id,mode,status,range_from,range_to,page_count,source_count,change_counts,verification,error_message,created_at,completed_at,created_by,source,device,auto_hold&order=created_at.desc&limit=${limit}`);
  const state = (await fetchAll("group_uid_sync_state?select=*&singleton=eq.true&limit=1"))[0] || {};
  // Mốc lượt toàn bộ tự động gần nhất (hoàn tất hoặc giữ lại) trên server: mọi máy cùng thấy, không đọc lại toàn bộ trong 20 giờ.
  const lastAutoFull = (await fetchAll("group_uid_sync_runs?select=created_at&source=eq.auto&mode=eq.full&status=in.(completed,held)&order=created_at.desc&limit=1"))[0];
  return reply(request, 200, { ok: true, data: { runs: runs.map(runView), state, lastAutoFullAt: lastAutoFull?.created_at ?? null }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function detail(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId), type = clean(body.changeType, 30);
  const runs = await fetchAll(`group_uid_sync_runs?select=*&id=eq.${encodeURIComponent(runId)}&limit=1`);
  if (!runs[0]) return fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ Group UID");
  return reply(request, 200, { ok: true, data: { ...runView(runs[0]), changes: await changes(runId, type) }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
function configView(row: Json | null): Json {
  const time = (value: unknown, fallback: string) => clean(value, 8).slice(0, 5) || fallback;
  const thresholds = Object.fromEntries(Object.keys(DEFAULT_THRESHOLDS).map(kind => [kind, thresholdsFor(kind, row?.thresholds)]));
  return {
    enabled: row ? row.enabled !== false : true, intervalMinutes: Number(row?.interval_minutes) || 30,
    fullWindow: { start: time(row?.full_window_start, "00:00"), end: time(row?.full_window_end, "05:00") },
    thresholds, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
    // sync_auto_v3.sql: mức tối thiểu theo loại (chuỗi "x.y.z" hoặc null = không chặn) để Extension / web biết trước khi chạy.
    minExtension: minExtensionView(row),
  };
}
// Cấu hình chung đồng bộ tự động. set chỉ nhận enabled (boolean) và intervalMinutes (15–180).
async function autoConfig(request: Request, user: { id: string }, body: Json): Promise<Response> {
  if (body.set !== undefined) {
    const set = (body.set && typeof body.set === "object" && !Array.isArray(body.set) ? body.set : null) as Json | null;
    if (!set) return fail(request, 400, "INVALID_CONFIG", "Thiết lập không hợp lệ");
    const unknown = Object.keys(set).filter(key => !["enabled", "intervalMinutes"].includes(key));
    if (unknown.length) return fail(request, 400, "INVALID_CONFIG", "Chỉ đổi được bật/tắt và nhịp gia tăng");
    const patch: Json = {};
    if ("enabled" in set) {
      if (typeof set.enabled !== "boolean") return fail(request, 400, "INVALID_CONFIG", "Giá trị bật/tắt không hợp lệ");
      patch.enabled = set.enabled;
    }
    if ("intervalMinutes" in set) {
      const minutes = Number(set.intervalMinutes);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 180) return fail(request, 400, "INVALID_CONFIG", "Nhịp gia tăng phải từ 15 đến 180 phút");
      patch.interval_minutes = minutes;
    }
    if (!Object.keys(patch).length) return fail(request, 400, "INVALID_CONFIG", "Không có thiết lập nào để lưu");
    Object.assign(patch, { updated_by: user.id, updated_at: new Date().toISOString() });
    const response = await db("sync_auto_settings?on_conflict=singleton", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ singleton: true, ...patch }) });
    await jsonResponse(response, "Lưu cấu hình tự động");
  }
  // devices chỉ có khi đọc được bảng máy (đọc lỗi → vắng khoá, web ẩn bảng thay vì báo "chưa có máy").
  const devices = await deviceList();
  return reply(request, 200, { ok: true, data: { ...configView(await autoSettings()), ...(devices ? { devices } : {}) }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
// Giãn cách giữa các máy: lượt theo lịch gửi cooldownSeconds (nhịp − 2 phút); thiếu / sai → 0 (như cũ). Tối đa 180 phút.
function cooldownOf(value: unknown): number { const seconds = Math.floor(Number(value)); return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), 10800) : 0; }
function leaseInput(body: Json): { kind: string; holder: string } {
  const kind = clean(body.kind, 20), holder = clean(body.holder, HOLDER_MAX);
  if (!AUTO_KINDS.has(kind)) throw new Error("INVALID_KIND:Loại đồng bộ không hợp lệ");
  if (!holder) throw new Error("INVALID_HOLDER:Thiếu tên máy");
  return { kind, holder };
}
// Khoá thuê theo loại: data = {ok:true, holder, leasedUntil} khi giành được, {ok:false, holder, leasedUntil} khi máy khác đang giữ.
async function lease(request: Request, body: Json): Promise<Response> {
  const { kind, holder } = leaseInput(body), cooldown = cooldownOf(body.cooldownSeconds);
  // sync_auto_v3.sql: ghi nhận máy rồi mới xét bản tối thiểu (máy bị chặn vẫn hiện trong danh sách); bị chặn thì không thuê khoá.
  await recordDevice(kind, body);
  const outdated = extensionGate(request, kind, body, await autoSettings());
  if (outdated) return outdated;
  // data = {ok:false, reason:"COOLDOWN", lastFinishedAt, retryAfter} khi lượt cùng loại vừa kết thúc chưa quá cooldown.
  const data = await rpc("sync_auto_lease", { p_kind: kind, p_holder: holder, p_ttl_seconds: LEASE_TTL_SECONDS, ...(cooldown > 0 ? { p_cooldown_seconds: cooldown } : {}) });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function release(request: Request, body: Json): Promise<Response> {
  const { kind, holder } = leaseInput(body);
  // finished:true = lượt tự động kết thúc (hoàn tất hoặc giữ lại) → ghi mốc giãn cách; lỗi / bỏ qua không gửi.
  const data = await rpc("sync_auto_release", { p_kind: kind, p_holder: holder, ...(body.finished === true ? { p_finished: true } : {}) });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
// Đóng lượt chưa áp dụng (failed + lý do) và dọn pages/staging; dùng cho cancel và lượt tự động mất khoá lúc xem trước.
async function closeRun(runId: string, message: string): Promise<Json[]> {
  const response = await db(`group_uid_sync_runs?id=eq.${encodeURIComponent(runId)}&status=in.(running,previewed)`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ status: "failed", error_message: message, completed_at: new Date().toISOString() }) });
  const rows = await jsonResponse(response, "Dừng phiên Group UID") as Json[];
  await jsonResponse(await db(`group_uid_sync_pages?run_id=eq.${encodeURIComponent(runId)}`, { method: "DELETE" }), "Dọn tiến độ Group UID");
  await jsonResponse(await db(`group_uid_sync_staging?run_id=eq.${encodeURIComponent(runId)}`, { method: "DELETE" }), "Dọn staging Group UID");
  return rows;
}
async function cancel(request: Request, body: Json): Promise<Response> {
  const runId = uuid(body.runId), message = clean(body.message || "Phiên bị dừng trước khi hoàn tất", 500);
  const rows = await closeRun(runId, message);
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
    if (action === "auto-config") return await autoConfig(request, user, body);
    if (action === "lease") return await lease(request, body);
    if (action === "release") return await release(request, body);
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
    if (message.includes("RUN_HELD")) return fail(request, 409, "RUN_HELD", "Lượt đã giữ lại, chạy lại tay để xem bản mới");
    const tagged = message.match(/^(INVALID_[A-Z_]+):(.*)$/);
    if (tagged) return fail(request, 400, tagged[1], tagged[2]);
    return fail(request, 500, "SYNC_ERROR", message || "Không xử lý được yêu cầu đồng bộ Group UID");
  }
});
