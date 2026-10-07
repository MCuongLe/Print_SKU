const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
const SERVICE_KEY = firstKey(Deno.env.get("SUPABASE_SECRET_KEYS")) || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const ALLOWED_ORIGINS = new Set([
  "https://mcuongle.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const CATEGORIES = new Map([
  ["954", "Thời Trang (Phụ Liệu)"], ["957", "Thời Trang (NVL)"], ["960", "Thời Trang"],
  ["961", "Thực phẩm"], ["962", "Mẫu Thời Trang"], ["963", "Nhận hàng gia công"],
  ["964", "Nguyên liệu nhận Gia công"],
]);
const SKU_FIELDS = ["product_name", "category_id", "category_name", "status"];
const COMBO_FIELDS = [
  "quantity", "combo_name", "normal_name", "combo_category_id", "combo_category_name",
  "normal_category_id", "normal_category_name", "combo_product_status", "normal_product_status",
  "combo_status", "source_modified_at", "source_component_count", "combo_scope_complete",
];
const MAX_WRITES = 2000;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const DETAIL_LIMIT = 1000;
const SOURCE_ISSUE_TYPES = new Set(["invalid_combo_relation", "unparsed_combo_description", "partial_combo_description"]);

type Json = Record<string, unknown>;

function keyList(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : typeof parsed === "object" && parsed ? Object.values(parsed) : [parsed];
    return values.map(String).filter(Boolean);
  } catch {
    return raw.split(",").map(value => value.trim()).filter(Boolean);
  }
}
function firstKey(raw: string | undefined): string { return keyList(raw)[0] ?? ""; }
function clean(value: unknown, max = 500): string { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function cors(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://mcuongle.github.io",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function reply(request: Request, status: number, body: Json): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(request), "Content-Type": "application/json; charset=utf-8" } });
}
function fail(request: Request, status: number, code: string, message: string): Response {
  return reply(request, status, { ok: false, error: { code, message } });
}
function dbHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", ...extra };
}
async function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: dbHeaders(init.headers as Record<string, string> ?? {}) });
}
async function jsonResponse(response: Response, label: string): Promise<unknown> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${text.slice(0, 260)}`);
  return text ? JSON.parse(text) : null;
}
async function fetchAll(path: string, pageSize = 1000): Promise<Json[]> {
  const rows: Json[] = [];
  for (let start = 0; start < 50000; start += pageSize) {
    const response = await db(path, { headers: { Range: `${start}-${start + pageSize - 1}` } });
    const page = await jsonResponse(response, "Đọc database") as Json[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}
async function fetchBySkus(skus: string[]): Promise<Json[]> {
  const result: Json[] = [];
  for (let start = 0; start < skus.length; start += 150) {
    const values = skus.slice(start, start + 150).map(value => `"${value.replace(/["\\]/g, "")}"`).join(",");
    result.push(...await fetchAll(`SKU_Name?select=sku,product_name,category_id,category_name,status&sku=in.(${encodeURIComponent(values)})`));
  }
  return result;
}
async function authenticate(request: Request): Promise<{ id: string; username: string }> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new Error("AUTH:Phiên Admin không hợp lệ");
  const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SERVICE_KEY, Authorization: authorization } });
  const user = await jsonResponse(userResponse, "Xác minh người dùng") as Json;
  const roles = await fetchAll(`user_roles?select=username,role&user_id=eq.${encodeURIComponent(String(user.id))}&limit=1`);
  if (!roles[0] || roles[0].role !== "admin") throw new Error("FORBIDDEN:Chỉ Admin được đồng bộ SKU");
  return { id: String(user.id), username: clean(roles[0].username || "Admin", 120) };
}
function normalizeSourceDate(value: unknown): string {
  const raw = clean(value, 40);
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error(`Ngày cập nhật Combo không hợp lệ: ${raw}`);
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}+07:00`);
  if (!Number.isFinite(date.getTime())) throw new Error(`Ngày cập nhật Combo không hợp lệ: ${raw}`);
  return date.toISOString();
}
// Mốc đọc nguồn không được ở tương lai (đồng hồ máy lệch) vì nó quyết định mốc cắt của lượt sau.
function sourceTime(value: unknown): string {
  const parsed = new Date(String(value ?? "")).getTime();
  const now = Date.now();
  return new Date(Number.isFinite(parsed) && parsed <= now ? parsed : now).toISOString();
}
function sameValue(field: string, left: unknown, right: unknown): boolean {
  if (field === "quantity") return Number(left) === Number(right);
  if (field === "source_modified_at") return new Date(String(left)).getTime() === new Date(String(right)).getTime();
  return left === right;
}
function fieldChanges(before: Json, after: Json, fields: string[]): Json {
  const changes: Json = {};
  for (const field of fields) if (!sameValue(field, before[field], after[field])) changes[field] = { before: before[field] ?? null, after: after[field] ?? null };
  return changes;
}
function normalRows(value: unknown): Json[] {
  if (!Array.isArray(value) || value.length > 5000) throw new Error("Danh sách SKU vượt giới hạn 5.000 dòng thay đổi");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const row = raw as Json;
    const sku = clean(row.sku, 64), productName = clean(row.product_name, 800), categoryId = clean(row.category_id, 20);
    if (!sku || !productName || !CATEGORIES.has(categoryId)) throw new Error(`SKU nguồn dòng ${index + 1} thiếu mã, tên hoặc sai category`);
    if (seen.has(sku)) throw new Error(`SKU nguồn bị trùng: ${sku}`);
    seen.add(sku);
    return { sku, product_name: productName, category_id: categoryId, category_name: CATEGORIES.get(categoryId), status: String(row.status) === "1" ? "1" : "0" };
  });
}
// Lỗi nguồn do Extension báo: giữ để Admin xem, không chặn bản xem trước. Phiên bản Extension cũ không gửi trường này.
function sourceIssueRows(value: unknown): { total: number; items: Json[] } {
  if (!Array.isArray(value)) return { total: 0, items: [] };
  const items = value.slice(0, DETAIL_LIMIT).map(raw => {
    const row = (raw ?? {}) as Json;
    const quantity = row.quantity === null || row.quantity === undefined ? NaN : Number(row.quantity);
    return {
      type: SOURCE_ISSUE_TYPES.has(String(row.type)) ? String(row.type) : "unknown",
      combo_sku: clean(row.combo_sku, 64), normal_sku: clean(row.normal_sku, 64), quantity: Number.isFinite(quantity) ? quantity : null,
      combo_name: clean(row.combo_name, 200), description: clean(row.description, 300), reason: clean(row.reason, 200),
    };
  });
  return { total: value.length, items };
}
function comboRows(value: unknown): Json[] {
  if (!Array.isArray(value) || value.length < 1000 || value.length > 12000) throw new Error("Dữ liệu Combo thiếu hoặc vượt giới hạn an toàn 1.000–12.000 dòng");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const row = raw as Json;
    const comboSku = clean(row.combo_sku, 64), normalSku = clean(row.normal_sku, 64), quantity = Number(row.quantity);
    const key = `${comboSku}\u0000${normalSku}`;
    if (!comboSku || !normalSku || comboSku === normalSku || !Number.isFinite(quantity) || quantity <= 0) throw new Error(`Quan hệ Combo dòng ${index + 1} không hợp lệ`);
    if (seen.has(key)) throw new Error(`Quan hệ Combo bị trùng: ${comboSku} → ${normalSku}`);
    seen.add(key);
    return {
      combo_sku: comboSku, normal_sku: normalSku, quantity,
      combo_status: clean(row.combo_status) === "Active" ? "Active" : "In-Active",
      source_modified_at: normalizeSourceDate(row.source_modified_at),
    };
  });
}
async function insertRun(row: Json): Promise<Json> {
  const response = await db("sku_sync_runs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
  return (await jsonResponse(response, "Lưu bản xem trước") as Json[])[0];
}
async function updateRun(id: string, patch: Json, status?: string): Promise<Json | null> {
  const filter = status ? `&status=eq.${encodeURIComponent(status)}` : "";
  const response = await db(`sku_sync_runs?id=eq.${encodeURIComponent(id)}${filter}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(patch) });
  return (await jsonResponse(response, "Cập nhật lượt đồng bộ") as Json[])[0] ?? null;
}
async function preview(request: Request, user: { id: string; username: string }, body: Json): Promise<Response> {
  const source = body.snapshot as Json;
  if (!source || !Array.isArray(source.categories) || source.categories.length !== CATEGORIES.size) return fail(request, 400, "INCOMPLETE_SOURCE", "Extension chưa lấy đủ 7 category SKU");
  const skus = normalRows(source.normalRows);
  const combos = comboRows(source.comboRows);
  const remoteSkus = await fetchBySkus(skus.map(row => String(row.sku)));
  const remoteSkuByCode = new Map(remoteSkus.map(row => [String(row.sku), row]));
  const stagedSkus: Json[] = [], skuAdded: Json[] = [], skuUpdated: Json[] = [];
  let skuUnchanged = 0;
  for (const row of skus) {
    const before = remoteSkuByCode.get(String(row.sku));
    if (!before) { stagedSkus.push(row); skuAdded.push({ sku: row.sku, after: row }); continue; }
    const fields = fieldChanges(before, row, SKU_FIELDS);
    if (Object.keys(fields).length) { stagedSkus.push(row); skuUpdated.push({ sku: row.sku, fields }); }
    else skuUnchanged += 1;
  }

  const allCodes = [...new Set(combos.flatMap(row => [String(row.combo_sku), String(row.normal_sku)]))];
  const products = await fetchBySkus(allCodes);
  const productByCode = new Map(products.map(row => [String(row.sku), row]));
  skus.forEach(row => productByCode.set(String(row.sku), row));
  const remoteLinks = await fetchAll("sku_combo_links?select=*");
  const remoteLinkByPair = new Map(remoteLinks.map(row => [`${row.combo_sku}\u0000${row.normal_sku}`, row]));
  const componentCounts = new Map<string, number>();
  combos.forEach(row => componentCounts.set(String(row.combo_sku), (componentCounts.get(String(row.combo_sku)) ?? 0) + 1));
  // Quan hệ có trong database nhưng không còn trong nguồn (Combo đổi thành phần hoặc bị bỏ): không tự xóa, chỉ báo để Admin xử lý.
  const sourcePairs = new Set(combos.map(row => `${row.combo_sku}\u0000${row.normal_sku}`));
  const orphanedAll = remoteLinks
    .filter(row => !sourcePairs.has(`${row.combo_sku}\u0000${row.normal_sku}`))
    .map(row => ({
      comboSku: row.combo_sku, normalSku: row.normal_sku, quantity: row.quantity, comboName: row.combo_name,
      reason: componentCounts.has(String(row.combo_sku)) ? "component_removed" : "combo_missing",
    }))
    .sort((left, right) => left.reason === right.reason ? 0 : left.reason === "component_removed" ? -1 : 1);
  const candidates: Json[] = [];
  // Bị loại: cả hai SKU thiếu hoặc ngoài category thường là ngoài phạm vi; chỉ thiếu MỘT đầu là dấu hiệu SKU chưa vào database nên liệt kê.
  const excludedCounts = { bothMissing: 0, oneMissing: 0, outOfCategory: 0 };
  const excludedMissing: Json[] = [];
  for (const sourceRow of combos) {
    const key = `${sourceRow.combo_sku}\u0000${sourceRow.normal_sku}`;
    const previous = remoteLinkByPair.get(key);
    const parent = productByCode.get(String(sourceRow.combo_sku));
    const child = productByCode.get(String(sourceRow.normal_sku));
    if ((!parent || !child) && !previous) {
      if (!parent && !child) excludedCounts.bothMissing += 1;
      else {
        excludedCounts.oneMissing += 1;
        if (excludedMissing.length < DETAIL_LIMIT) excludedMissing.push({ comboSku: sourceRow.combo_sku, normalSku: sourceRow.normal_sku, quantity: sourceRow.quantity, missing: parent ? "normal" : "combo" });
      }
      continue;
    }
    const row: Json = { ...(previous ?? {}), ...sourceRow };
    if (parent) Object.assign(row, {
      combo_name: parent.product_name, combo_category_id: parent.category_id, combo_category_name: parent.category_name,
      combo_product_status: parent.status === "1" ? "Active" : "Inactive",
    });
    if (child) Object.assign(row, {
      normal_name: child.product_name, normal_category_id: child.category_id, normal_category_name: child.category_name,
      normal_product_status: child.status === "1" ? "Active" : "Inactive",
    });
    if (!CATEGORIES.has(String(row.combo_category_id)) || !CATEGORIES.has(String(row.normal_category_id))) { excludedCounts.outOfCategory += 1; continue; }
    row.source_component_count = componentCounts.get(String(row.combo_sku));
    candidates.push(row);
  }
  const selectedCounts = new Map<string, number>();
  candidates.forEach(row => selectedCounts.set(String(row.combo_sku), (selectedCounts.get(String(row.combo_sku)) ?? 0) + 1));
  candidates.forEach(row => row.combo_scope_complete = selectedCounts.get(String(row.combo_sku)) === componentCounts.get(String(row.combo_sku)));
  const stagedLinks: Json[] = [], comboAdded: Json[] = [], comboUpdated: Json[] = [];
  let comboUnchanged = 0;
  for (const row of candidates) {
    const key = `${row.combo_sku}\u0000${row.normal_sku}`;
    const before = remoteLinkByPair.get(key);
    const cleanRow = Object.fromEntries(["combo_sku", "normal_sku", ...COMBO_FIELDS].map(field => [field, row[field]]));
    if (!before) { stagedLinks.push(cleanRow); comboAdded.push({ comboSku: row.combo_sku, normalSku: row.normal_sku, after: cleanRow }); continue; }
    const fields = fieldChanges(before, cleanRow, COMBO_FIELDS);
    if (Object.keys(fields).length) { stagedLinks.push(cleanRow); comboUpdated.push({ comboSku: row.combo_sku, normalSku: row.normal_sku, fields }); }
    else comboUnchanged += 1;
  }
  if (stagedSkus.length > MAX_WRITES || stagedLinks.length > MAX_WRITES) return fail(request, 409, "SAFETY_LIMIT", "Số dòng thay đổi vượt ngưỡng 2.000; cần kiểm tra nguồn trước khi cập nhật");
  const issues = sourceIssueRows(source.sourceIssues);
  const excluded = excludedCounts.bothMissing + excludedCounts.oneMissing + excludedCounts.outOfCategory;
  const sourceCounts = { normalRows: skus.length, comboRows: combos.length, selectedComboLinks: candidates.length, excludedComboLinks: excluded, excludedBreakdown: excludedCounts, sourceIssues: issues.total };
  const changeCounts = { skuAdded: skuAdded.length, skuUpdated: skuUpdated.length, skuUnchanged, comboAdded: comboAdded.length, comboUpdated: comboUpdated.length, comboUnchanged, comboOrphaned: orphanedAll.length };
  const changes = {
    skus: { added: skuAdded, updated: skuUpdated },
    combos: { added: comboAdded, updated: comboUpdated, orphaned: orphanedAll.slice(0, DETAIL_LIMIT), excluded: excludedMissing },
    sourceIssues: issues.items,
  };
  const run = await insertRun({
    status: "previewed", source: "inside-extension", cutoff: clean(source.cutoff, 40), source_generated_at: sourceTime(source.generatedAt),
    source_counts: sourceCounts, change_counts: changeCounts, changes, staged_skus: stagedSkus,
    staged_combo_links: stagedLinks, created_by: user.id,
  });
  return reply(request, 200, { ok: true, data: { runId: run.id, status: run.status, sourceCounts, changeCounts, changes }, meta: { updatedAt: run.created_at, schemaVersion: 1 } });
}
async function upsert(table: string, conflict: string, rows: Json[]): Promise<void> {
  for (let start = 0; start < rows.length; start += 400) {
    const response = await db(`${table}?on_conflict=${encodeURIComponent(conflict)}`, {
      method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(rows.slice(start, start + 400)),
    });
    await jsonResponse(response, `Ghi ${table}`);
  }
}
async function countTable(table: string): Promise<number> {
  const response = await db(`${table}?select=*`, { method: "HEAD", headers: { Prefer: "count=exact", Range: "0-0" } });
  if (!response.ok) throw new Error(`Đếm ${table} HTTP ${response.status}`);
  const match = (response.headers.get("content-range") ?? "").match(/\/(\d+)$/);
  return match ? Number(match[1]) : 0;
}
// Bản xem trước chỉ đúng với database tại lúc tạo: quá hạn hoặc đã có lượt khác hoàn tất sau đó thì ghi sẽ đè dữ liệu mới bằng dữ liệu cũ.
async function staleReason(run: Json): Promise<string | null> {
  const createdAt = new Date(String(run.created_at)).getTime();
  if (!Number.isFinite(createdAt)) return "Bản xem trước thiếu thời gian tạo; hãy kiểm tra lại dữ liệu Inside";
  if (Date.now() - createdAt > PREVIEW_TTL_MS) return "Bản xem trước đã quá 30 phút; hãy kiểm tra lại dữ liệu Inside";
  const newer = await fetchAll(`sku_sync_runs?select=id&status=eq.completed&completed_at=gt.${encodeURIComponent(new Date(createdAt).toISOString())}&limit=1`);
  return newer.length ? "Đã có lượt đồng bộ hoàn tất sau bản xem trước này; hãy kiểm tra lại dữ liệu Inside" : null;
}
async function apply(request: Request, body: Json): Promise<Response> {
  const runId = clean(body.runId, 80);
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return fail(request, 400, "INVALID_RUN", "Mã lượt đồng bộ không hợp lệ");
  const rows = await fetchAll(`sku_sync_runs?select=*&id=eq.${encodeURIComponent(runId)}&limit=1`);
  const run = rows[0];
  if (!run) return fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ");
  if (run.status === "completed") return reply(request, 200, { ok: true, data: { runId, status: "completed", changeCounts: run.change_counts, verification: run.verification, alreadyCompleted: true } });
  if (run.status !== "previewed") return fail(request, 409, "NOT_READY", "Lượt đồng bộ không còn ở trạng thái chờ cập nhật");
  const stale = await staleReason(run);
  if (stale) return fail(request, 409, "STALE_PREVIEW", stale);
  const claimed = await updateRun(runId, { status: "applying", applied_at: new Date().toISOString(), error_message: null }, "previewed");
  if (!claimed) return fail(request, 409, "ALREADY_RUNNING", "Lượt đồng bộ đang được xử lý ở nơi khác");
  const stagedSkus = run.staged_skus as Json[], stagedLinks = run.staged_combo_links as Json[];
  try {
    const now = new Date().toISOString();
    await upsert("SKU_Name", "sku", stagedSkus.map(row => ({ ...row, updated_at: now })));
    await upsert("sku_combo_links", "combo_sku,normal_sku", stagedLinks.map(row => ({ ...row, imported_at: now })));
    const actualSkus = await fetchBySkus(stagedSkus.map(row => String(row.sku)));
    const actualSkuByCode = new Map(actualSkus.map(row => [String(row.sku), row]));
    const allLinks = stagedLinks.length ? await fetchAll("sku_combo_links?select=*") : [];
    const actualLinkByPair = new Map(allLinks.map(row => [`${row.combo_sku}\u0000${row.normal_sku}`, row]));
    const errors: string[] = [];
    stagedSkus.forEach(expected => {
      const actual = actualSkuByCode.get(String(expected.sku));
      if (!actual || Object.keys(fieldChanges(actual, expected, SKU_FIELDS)).length) errors.push(`SKU ${expected.sku} chưa khớp`);
    });
    stagedLinks.forEach(expected => {
      const actual = actualLinkByPair.get(`${expected.combo_sku}\u0000${expected.normal_sku}`);
      if (!actual || Object.keys(fieldChanges(actual, expected, COMBO_FIELDS)).length) errors.push(`Combo ${expected.combo_sku} → ${expected.normal_sku} chưa khớp`);
    });
    if (errors.length) throw new Error(errors.slice(0, 20).join("; "));
    const verification = {
      skuVerified: stagedSkus.length, comboVerified: stagedLinks.length,
      skuCount: await countTable("SKU_Name"), comboLinkCount: await countTable("sku_combo_links"), errors: [],
    };
    await updateRun(runId, { status: "completed", verification, completed_at: new Date().toISOString(), error_message: null });
    return reply(request, 200, { ok: true, data: { runId, status: "completed", changeCounts: run.change_counts, verification }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
  } catch (error) {
    await updateRun(runId, { status: "failed", error_message: clean((error as Error).message, 500), completed_at: new Date().toISOString() });
    return fail(request, 500, "APPLY_FAILED", `Cập nhật chưa hoàn tất: ${clean((error as Error).message, 300)}`);
  }
}
async function history(request: Request, body: Json): Promise<Response> {
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const runs = await fetchAll(`sku_sync_runs?select=id,status,cutoff,source_counts,change_counts,verification,error_message,created_at,completed_at,created_by&order=created_at.desc&limit=${limit}`);
  // Mốc đọc tiếp theo tính từ lúc đọc nguồn của lượt hoàn tất gần nhất, không phải lúc bấm cập nhật; truy vấn riêng để không phụ thuộc 20 lượt gần nhất.
  const latest = (await fetchAll("sku_sync_runs?select=source_generated_at,completed_at&status=eq.completed&order=source_generated_at.desc&limit=1"))[0];
  return reply(request, 200, { ok: true, data: { runs, lastSuccessAt: latest?.completed_at ?? null, lastSnapshotAt: latest?.source_generated_at ?? null }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function detail(request: Request, body: Json): Promise<Response> {
  const runId = clean(body.runId, 80);
  const runs = await fetchAll(`sku_sync_runs?select=id,status,cutoff,source_counts,change_counts,changes,verification,error_message,created_at,completed_at&id=eq.${encodeURIComponent(runId)}&limit=1`);
  return runs[0] ? reply(request, 200, { ok: true, data: runs[0], meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } }) : fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ");
}

Deno.serve(async request => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request) });
  if (request.method !== "POST") return fail(request, 405, "METHOD", "Chỉ nhận POST");
  if (!SUPABASE_URL || !SERVICE_KEY) return fail(request, 503, "NO_DB_KEY", "Edge Function chưa có cấu hình database");
  try {
    const user = await authenticate(request);
    const body = await request.json() as Json;
    const action = clean(body.action, 30);
    if (action === "preview") return await preview(request, user, body);
    if (action === "apply") return await apply(request, body);
    if (action === "history") return await history(request, body);
    if (action === "detail") return await detail(request, body);
    if (action === "health") return reply(request, 200, { ok: true, data: { extensionRequired: true, user: user.username }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
    return fail(request, 400, "UNKNOWN_ACTION", "Thao tác không được hỗ trợ");
  } catch (error) {
    const message = clean((error as Error).message, 500);
    if (message.startsWith("AUTH:")) return fail(request, 401, "AUTH", message.slice(5));
    if (message.startsWith("FORBIDDEN:")) return fail(request, 403, "FORBIDDEN", message.slice(10));
    return fail(request, 500, "SYNC_ERROR", message || "Không xử lý được yêu cầu đồng bộ");
  }
});
