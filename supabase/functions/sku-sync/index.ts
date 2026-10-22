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
// Lượt toàn bộ đọc hết Inside (~22.000 SKU) và lần đầu nạp bù SKU ngừng hoạt động: trần riêng, DB check 30.000 (sku_sync_full_v1.sql).
const MAX_ROWS_FULL = 60000;
const MAX_WRITES_FULL = 30000;
// Nguồn toàn bộ nhỏ hơn mốc (lần toàn bộ trước, hoặc bảng hiện có ở lần đầu) quá ngưỡng này là đọc thiếu trang, không phải Inside thật sự bớt SKU.
const FULL_DROP_BLOCK_PERCENT = 20;
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const DETAIL_LIMIT = 1000;
const SOURCE_ISSUE_TYPES = new Set(["invalid_combo_relation", "unparsed_combo_description", "partial_combo_description"]);
// Đồng bộ tự động (sync_auto_v1.sql): ngưỡng mặc định khi bảng cấu hình thiếu hoặc thiếu khoá; bản chép giống group-uid-sync/index.ts (deploy gửi 1 tệp).
const DEFAULT_THRESHOLDS: Record<string, Record<string, number>> = {
  group_uid: { maxChanges: 3000, maxMissing: 0, maxIssues: 0 },
  sku: { maxUpdated: 500, maxAdded: 500, maxMissing: 20, maxOrphaned: 0 },
};
// cut_adj (lịch sử Cut WMS cho Đối chiếu ADJ) và storage_risk (Kiểm kê 2 kho + UID tạm) từ sync_auto_v2.sql / Extension 0.10.7:
// chỉ dùng lease/release ở đây (dữ liệu ghi thẳng qua RPC Admin), không có xem trước / ngưỡng.
const AUTO_KINDS = new Set(["sku", "group_uid", "cut_adj", "storage_risk"]);
const LEASE_TTL_SECONDS = 900;
// holder = tên máy (≤ 60) + "#" + mã máy (Extension 0.10.0) → tối đa 80 ký tự, khớp sync_auto_lease.
const HOLDER_MAX = 80;

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
function count(value: number): string { return value.toLocaleString("vi-VN"); }
function limitOf(raw: unknown, fallback: number): number { const value = Number(raw); return Number.isFinite(value) && value >= 0 ? value : fallback; }
function thresholdsFor(kind: string, all: unknown): Record<string, number> {
  const base = DEFAULT_THRESHOLDS[kind], given = ((all ?? {}) as Json)[kind] as Json | undefined;
  return Object.fromEntries(Object.entries(base).map(([key, fallback]) => [key, limitOf(given?.[key], fallback)]));
}
// Ngưỡng "Vừa" SKU: SKU mới rời nhóm đồng bộ ≤ 20 (sku_missing_archive_v1.sql, lượt toàn bộ tự lưu trữ; skuMissingNew, lượt cũ chưa
// có trường thì dùng skuMissing), Combo thừa = 0, SKU cập nhật ≤ 500, SKU mới ≤ 500. Vượt → giữ bản xem trước cho Admin.
export function evaluateSkuHold(counts: unknown, thresholds: unknown): { reason: string; counts: Json } | null {
  const c = (counts ?? {}) as Json, t = thresholdsFor("sku", { sku: thresholds });
  const skuAdded = Number(c.skuAdded) || 0, skuUpdated = Number(c.skuUpdated) || 0, skuMissing = Number(c.skuMissing) || 0, comboOrphaned = Number(c.comboOrphaned) || 0;
  const reasons: string[] = [];
  if (skuUpdated > t.maxUpdated) reasons.push(`${count(skuUpdated)} SKU cập nhật vượt ngưỡng ${count(t.maxUpdated)}`);
  if (skuAdded > t.maxAdded) reasons.push(`${count(skuAdded)} SKU mới vượt ngưỡng ${count(t.maxAdded)}`);
  const hasNew = c.skuMissingNew !== undefined && c.skuMissingNew !== null, skuMissingNew = hasNew ? Number(c.skuMissingNew) || 0 : skuMissing;
  if (skuMissingNew > t.maxMissing) reasons.push(`${count(skuMissingNew)} SKU ${hasNew ? "mới " : ""}rời nhóm đồng bộ (ngưỡng ${count(t.maxMissing)})`);
  if (comboOrphaned > t.maxOrphaned) reasons.push(`${count(comboOrphaned)} quan hệ Combo thừa`);
  return reasons.length ? { reason: `Giữ lại: ${reasons.join("; ")}`, counts: { skuAdded, skuUpdated, skuMissing, ...(hasNew ? { skuMissingNew } : {}), comboOrphaned } } : null;
}
// Lượt tự động từ Extension gửi source "auto" + tên máy; thiếu trường (web, Extension cũ) → "manual" như trước.
function runSource(value: unknown): "auto" | "manual" { return value === "auto" ? "auto" : "manual"; }
function deviceName(value: unknown): string | null { return clean(value, 60) || null; }
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
  if (userResponse.status === 401 || userResponse.status === 403) throw new Error("AUTH:Phiên Admin không hợp lệ");
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
function normalRows(value: unknown, max = 5000): Json[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`Danh sách SKU vượt giới hạn ${max.toLocaleString("vi-VN")} dòng`);
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
function comboRows(value: unknown, min = 1000): Json[] {
  if (!Array.isArray(value) || value.length < min || value.length > 12000) throw new Error(`Dữ liệu Combo thiếu hoặc vượt giới hạn an toàn ${min.toLocaleString("vi-VN")}–12.000 dòng`);
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
  const full = body.mode === "full" || source.mode === "full";
  if (full && source.full !== true) return fail(request, 400, "INCOMPLETE_SOURCE", "Extension chưa đọc toàn bộ Inside (cần Extension 0.8.2 trở lên)");
  const skus = normalRows(source.normalRows, full ? MAX_ROWS_FULL : 5000);
  // Extension 0.9.3: lượt gia tăng chỉ gửi Combo có Modified mới hơn mốc (comboScope "changed"); toàn bộ vẫn phải gửi hết.
  const comboScope = source.comboScope === "changed" ? "changed" : "full";
  if (full && comboScope === "changed") return fail(request, 400, "INCOMPLETE_SOURCE", "Lượt toàn bộ phải đọc hết Combo");
  const combos = comboRows(source.comboRows, comboScope === "changed" ? 0 : 1000);
  // Toàn bộ: so với cả bảng (kể cả SKU ngừng hoạt động) để thấy SKU không còn trên Inside; gia tăng chỉ đọc các SKU nguồn gửi lên.
  const remoteSkus = full
    ? await fetchAll("SKU_Name?select=sku,product_name,category_id,category_name,status&order=sku.asc")
    : await fetchBySkus(skus.map(row => String(row.sku)));
  const remoteSkuByCode = new Map(remoteSkus.map(row => [String(row.sku), row]));
  const stagedSkus: Json[] = [], skuAdded: Json[] = [], skuUpdated: Json[] = [];
  // SKU ngừng hoạt động mà database chưa có thì không nạp (quyết định 14/10/2026), chỉ đếm; SKU đã có mà Inside chuyển sang ngừng vẫn cập nhật trạng thái.
  const skippedInactive = new Set<string>();
  let skuUnchanged = 0;
  for (const row of skus) {
    const before = remoteSkuByCode.get(String(row.sku));
    if (!before) {
      if (row.status !== "1") { skippedInactive.add(String(row.sku)); continue; }
      stagedSkus.push(row); skuAdded.push({ sku: row.sku, after: row }); continue;
    }
    const fields = fieldChanges(before, row, SKU_FIELDS);
    if (Object.keys(fields).length) { stagedSkus.push(row); skuUpdated.push({ sku: row.sku, fields }); }
    else skuUnchanged += 1;
  }
  // SKU có trong database nhưng Inside không còn trả về trong 7 nhóm (chuyển nhóm khác hoặc bị xoá): lượt toàn bộ lưu danh sách đầy đủ
  // (staged_missing_skus) để khi áp dụng thì lưu trữ sang sku_archive (quyết định 17/10/2026, sku_missing_archive_v1.sql).
  const sourceSkus = new Set(skus.map(row => String(row.sku)));
  const skuMissingAll = full ? remoteSkus.filter(row => !sourceSkus.has(String(row.sku))).map(row => ({ sku: row.sku, product_name: row.product_name, category_name: row.category_name, status: row.status })) : [];
  let verification: Json = {};
  let skuMissingNew: number | null = null;
  if (full) {
    const previousFull = (await fetchAll("sku_sync_runs?select=source_counts,changes,missing_sku_codes,archive_kept_codes&mode=eq.full&status=eq.completed&order=completed_at.desc&limit=1"))[0];
    // Ngưỡng tự động tính trên SKU thiếu MỚI: bỏ các SKU lượt toàn bộ hoàn tất trước đã báo thiếu hoặc đã giữ lại (còn Group UID / combo…),
    // để SKU bị giữ lại không dồn lên làm mọi lượt sau bị held. Nguồn: missing_sku_codes ∪ archive_kept_codes (đầy đủ); lượt trước khi có
    // hai cột này thì dùng changes.skus.missing / archiveKept (cắt 1.000).
    const previousSkus = ((previousFull?.changes as Json | undefined)?.skus ?? {}) as Json;
    const known = new Set(Array.isArray(previousFull?.missing_sku_codes)
      ? [...(previousFull.missing_sku_codes as unknown[]), ...(Array.isArray(previousFull.archive_kept_codes) ? previousFull.archive_kept_codes as unknown[] : [])].map(String)
      : [...(Array.isArray(previousSkus.missing) ? previousSkus.missing : []), ...(Array.isArray(previousSkus.archiveKept) ? previousSkus.archiveKept : [])].map(row => String((row as Json)?.sku ?? "")));
    skuMissingNew = skuMissingAll.filter(row => !known.has(String(row.sku))).length;
    const previousFullCount = Number((previousFull?.source_counts as Json | undefined)?.normalRows) || null;
    const baseline = previousFullCount ?? remoteSkus.length;
    const drop = baseline > 0 && skus.length < baseline ? Math.round((baseline - skus.length) * 10000 / baseline) / 100 : 0;
    verification = { previousFullCount, baselineCount: baseline, fullDropPercent: drop, skuMissing: skuMissingAll.length };
    if (drop >= FULL_DROP_BLOCK_PERCENT) return fail(request, 409, "SAFETY_LIMIT", `Inside chỉ trả ${skus.length.toLocaleString("vi-VN")} SKU, ít hơn ${drop.toLocaleString("vi-VN")}% so với mốc ${baseline.toLocaleString("vi-VN")}; có thể đọc thiếu trang, hãy kiểm tra tab Inside rồi thử lại`);
  }

  const allCodes = [...new Set(combos.flatMap(row => [String(row.combo_sku), String(row.normal_sku)]))];
  const products = full ? remoteSkus : await fetchBySkus(allCodes);
  const productByCode = new Map(products.map(row => [String(row.sku), row]));
  skus.forEach(row => { if (!skippedInactive.has(String(row.sku))) productByCode.set(String(row.sku), row); });
  const remoteLinks = await fetchAll("sku_combo_links?select=*");
  const remoteLinkByPair = new Map(remoteLinks.map(row => [`${row.combo_sku}\u0000${row.normal_sku}`, row]));
  const componentCounts = new Map<string, number>();
  combos.forEach(row => componentCounts.set(String(row.combo_sku), (componentCounts.get(String(row.combo_sku)) ?? 0) + 1));
  // Quan hệ có trong database nhưng không còn trong nguồn (Combo đổi thành phần hoặc bị bỏ): không tự xóa, chỉ báo để Admin xử lý.
  const sourcePairs = new Set(combos.map(row => `${row.combo_sku}\u0000${row.normal_sku}`));
  // Chỉ biết "Combo thừa" khi đã đọc hết Combo; gia tăng không kết luận được nên để null.
  const orphanedAll = comboScope === "full" ? remoteLinks
    .filter(row => !sourcePairs.has(`${row.combo_sku}\u0000${row.normal_sku}`))
    .map(row => ({
      comboSku: row.combo_sku, normalSku: row.normal_sku, quantity: row.quantity, comboName: row.combo_name,
      reason: componentCounts.has(String(row.combo_sku)) ? "component_removed" : "combo_missing",
    }))
    .sort((left, right) => left.reason === right.reason ? 0 : left.reason === "component_removed" ? -1 : 1) : [];
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
  const maxWrites = full ? MAX_WRITES_FULL : MAX_WRITES;
  if (stagedSkus.length > maxWrites || stagedLinks.length > maxWrites) return fail(request, 409, "SAFETY_LIMIT", `Số dòng thay đổi vượt ngưỡng ${maxWrites.toLocaleString("vi-VN")}; cần kiểm tra nguồn trước khi cập nhật`);
  const issues = sourceIssueRows(source.sourceIssues);
  const excluded = excludedCounts.bothMissing + excludedCounts.oneMissing + excludedCounts.outOfCategory;
  const sourceCounts = { normalRows: skus.length, comboRows: combos.length, comboScope, selectedComboLinks: candidates.length, excludedComboLinks: excluded, excludedBreakdown: excludedCounts, sourceIssues: issues.total };
  const changeCounts = { skuAdded: skuAdded.length, skuUpdated: skuUpdated.length, skuUnchanged, skuSkippedInactive: skippedInactive.size, skuMissing: skuMissingAll.length, ...(skuMissingNew === null ? {} : { skuMissingNew }), comboAdded: comboAdded.length, comboUpdated: comboUpdated.length, comboUnchanged, comboOrphaned: comboScope === "full" ? orphanedAll.length : null };
  // Danh sách chi tiết tối đa 1.000 dòng mỗi nhóm (lượt toàn bộ có thể hàng nghìn); số đếm vẫn đủ.
  const changes = {
    skus: { added: skuAdded.slice(0, DETAIL_LIMIT), updated: skuUpdated.slice(0, DETAIL_LIMIT), missing: skuMissingAll.slice(0, DETAIL_LIMIT) },
    combos: { added: comboAdded, updated: comboUpdated, orphaned: orphanedAll.slice(0, DETAIL_LIMIT), excluded: excludedMissing },
    sourceIssues: issues.items,
  };
  // Lượt tự động chỉ tạo bản xem trước khi máy gửi vẫn giữ khoá thuê còn hạn (đọc Inside có thể lâu hơn hạn khoá).
  if (runSource(body.source) === "auto" && !(await holdsLease("sku", body.holder))) return fail(request, 409, "LEASE_LOST", "Mất khoá thuê; lượt tự động đã dừng");
  const run = await insertRun({
    status: "previewed", source: "inside-extension", mode: full ? "full" : "incremental", cutoff: clean(source.cutoff, 40), source_generated_at: sourceTime(source.generatedAt),
    source_counts: sourceCounts, change_counts: changeCounts, changes, staged_skus: stagedSkus,
    staged_combo_links: stagedLinks, verification, created_by: user.id, staged_missing_skus: full ? skuMissingAll : null,
    missing_sku_codes: full ? skuMissingAll.map(row => String(row.sku)) : null,
    // Cột source cũ luôn "inside-extension" (check cứng); nguồn kích hoạt nằm ở run_source (sync_auto_v1.sql).
    run_source: runSource(body.source), device: deviceName(body.device),
  });
  return reply(request, 200, { ok: true, data: { runId: run.id, status: run.status, mode: full ? "full" : "incremental", sourceCounts, changeCounts, changes, verification }, meta: { updatedAt: run.created_at, schemaVersion: 1 } });
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
// Lượt toàn bộ: SKU rời 7 nhóm đồng bộ → lưu trữ qua RPC sku_archive_missing (sku_missing_archive_v1.sql; cùng 4 điều kiện bảo vệ như
// lưu trữ SKU ngừng: còn Group UID sống / Combo Active / xả vải đang mở / cắt trong 90 ngày thì giữ). Lượt cũ / gia tăng không có danh
// sách → null (hành vi cũ). Lỗi RPC không làm hỏng lượt đã ghi: trả error, SKU thiếu vẫn còn trong bảng và lượt toàn bộ sau thử lại.
async function archiveMissing(run: Json): Promise<{ archived: Json[]; kept: Json[]; error: string | null } | null> {
  if (run.mode !== "full" || !Array.isArray(run.staged_missing_skus)) return null;
  const byCode = new Map<string, Json>();
  (run.staged_missing_skus as Json[]).forEach(row => { const sku = String(row?.sku ?? "").trim(); if (sku && sku.length <= 80) byCode.set(sku, row); });
  if (!byCode.size) return null;
  const codes = [...byCode.keys()], archived: Json[] = [], kept: Json[] = [];
  try {
    for (let start = 0; start < codes.length; start += 2000) {
      const data = await rpc("sku_archive_missing", { p_skus: codes.slice(start, start + 2000), p_reason: "left_sync_scope" });
      (Array.isArray(data?.archivedSkus) ? data.archivedSkus as unknown[] : []).forEach(sku => {
        const row = byCode.get(String(sku));
        archived.push({ sku: String(sku), product_name: row?.product_name ?? null, category_name: row?.category_name ?? null });
      });
      (Array.isArray(data?.keptSkus) ? data.keptSkus as Json[] : []).forEach((item: Json) => {
        const row = byCode.get(String(item?.sku));
        kept.push({ sku: String(item?.sku ?? ""), reason: clean(item?.reason, 60), product_name: row?.product_name ?? null });
      });
    }
    return { archived, kept, error: null };
  } catch (error) {
    return { archived, kept, error: clean((error as Error).message, 300) };
  }
}
async function apply(request: Request, body: Json): Promise<Response> {
  const runId = clean(body.runId, 80);
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return fail(request, 400, "INVALID_RUN", "Mã lượt đồng bộ không hợp lệ");
  const rows = await fetchAll(`sku_sync_runs?select=*&id=eq.${encodeURIComponent(runId)}&limit=1`);
  const run = rows[0];
  if (!run) return fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ");
  // held = lượt tự động đã giữ lại (sync_auto_v1.sql): dữ liệu Inside đã cũ, không áp dụng nữa.
  if (run.status === "held") return fail(request, 409, "RUN_HELD", "Lượt đã giữ lại, chạy lại tay để xem bản mới");
  if (run.status === "completed") return reply(request, 200, { ok: true, data: { runId, status: "completed", changeCounts: run.change_counts, verification: run.verification, alreadyCompleted: true } });
  if (run.status !== "previewed") return fail(request, 409, "NOT_READY", "Lượt đồng bộ không còn ở trạng thái chờ cập nhật");
  // auto:true (Extension tự chạy): phải còn giữ khoá thuê; vượt ngưỡng hoặc Admin tạm dừng → không ghi, chuyển "held" cho Admin xem
  // (bỏ dữ liệu chờ ghi vì lượt held không áp dụng được nữa; chi tiết thay đổi giữ nguyên để xem). Không có auto → như cũ.
  if (body.auto === true) {
    if (!(await holdsLease("sku", body.holder))) return fail(request, 409, "LEASE_LOST", "Mất khoá thuê; lượt tự động đã dừng");
    const settings = await autoSettings();
    const held = settings?.enabled === false
      ? { reason: "Giữ lại: Admin tạm dừng đồng bộ tự động", counts: (run.change_counts ?? {}) as Json }
      : evaluateSkuHold(run.change_counts, (settings?.thresholds as Json | undefined)?.sku);
    if (held) {
      const marked = await updateRun(runId, { status: "held", auto_hold: clean(held.reason, 300), completed_at: new Date().toISOString(), staged_skus: [], staged_combo_links: [], staged_missing_skus: null }, "previewed");
      if (!marked) return fail(request, 409, "NOT_READY", "Lượt đồng bộ không còn ở trạng thái chờ cập nhật");
      return reply(request, 200, { ok: true, data: { runId, status: "held", changeCounts: run.change_counts, held }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
    }
  }
  const stale = await staleReason(run);
  if (stale) return fail(request, 409, "STALE_PREVIEW", stale);
  const claimed = await updateRun(runId, { status: "applying", applied_at: new Date().toISOString(), error_message: null }, "previewed");
  if (!claimed) return fail(request, 409, "ALREADY_RUNNING", "Lượt đồng bộ đang được xử lý ở nơi khác");
  const stagedSkus = run.staged_skus as Json[], stagedLinks = run.staged_combo_links as Json[];
  let verification: Json = {};
  try {
    const now = new Date().toISOString();
    await upsert("SKU_Name", "sku", stagedSkus.map(row => ({ ...row, updated_at: now })));
    await upsert("sku_combo_links", "combo_sku,normal_sku", stagedLinks.map(row => ({ ...row, imported_at: now })));
    const actualSkus = stagedSkus.length > 3000
      ? await fetchAll("SKU_Name?select=sku,product_name,category_id,category_name,status&order=sku.asc")
      : await fetchBySkus(stagedSkus.map(row => String(row.sku)));
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
    verification = {
      ...((run.verification as Json | null) ?? {}),
      skuVerified: stagedSkus.length, comboVerified: stagedLinks.length,
      skuCount: await countTable("SKU_Name"), comboLinkCount: await countTable("sku_combo_links"), errors: [],
    };
    await updateRun(runId, { status: "completed", verification, completed_at: new Date().toISOString(), error_message: null });
  } catch (error) {
    await updateRun(runId, { status: "failed", error_message: clean((error as Error).message, 500), completed_at: new Date().toISOString() });
    return fail(request, 500, "APPLY_FAILED", `Cập nhật chưa hoàn tất: ${clean((error as Error).message, 300)}`);
  }
  // Lưu trữ SKU rời nhóm chỉ chạy SAU khi lượt đã ghi completed (ghi, xác minh, đếm xong): lỗi ở bước trên không thể xảy ra sau khi đã xoá SKU.
  // Kết quả PATCH bổ sung vào dòng lượt đã completed; verification.skuCount là số đếm trước khi lưu trữ.
  const archive = await archiveMissing(run);
  if (!archive) return reply(request, 200, { ok: true, data: { runId, status: "completed", changeCounts: run.change_counts, verification }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
  const changeCounts = { ...((run.change_counts as Json | null) ?? {}), skuArchived: archive.archived.length, skuArchiveKept: archive.kept.length };
  const runChanges = (run.changes as Json | null) ?? {};
  const changes = { ...runChanges, skus: { ...((runChanges.skus as Json | undefined) ?? {}), archived: archive.archived.slice(0, DETAIL_LIMIT), archiveKept: archive.kept.slice(0, DETAIL_LIMIT) } };
  if (archive.error) verification = { ...verification, archiveError: archive.error };
  try {
    await updateRun(runId, { change_counts: changeCounts, changes, archive_kept_codes: archive.kept.map(item => String(item.sku)), ...(archive.error ? { verification } : {}) }, "completed");
  } catch (error) {
    // SKU đã chuyển sang sku_archive; chỉ phần ghi kết quả vào lượt lỗi → báo kèm, không đổi trạng thái lượt.
    verification = { ...verification, archiveRecordError: clean((error as Error).message, 300) };
  }
  return reply(request, 200, { ok: true, data: { runId, status: "completed", changeCounts, verification }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
// API trả "source" = manual|auto (cột run_source); cột source cũ của bảng (inside-extension) không đưa ra.
function runView(run: Json): Json {
  const { run_source, ...rest } = run;
  return { ...rest, source: run_source ?? "manual", device: run.device ?? null, autoHold: run.auto_hold ?? null };
}
async function history(request: Request, body: Json): Promise<Response> {
  const limit = Math.min(Math.max(Number(body.limit) || 20, 1), 50);
  const runs = (await fetchAll(`sku_sync_runs?select=id,status,mode,cutoff,source_counts,change_counts,verification,error_message,created_at,completed_at,created_by,run_source,device,auto_hold&order=created_at.desc&limit=${limit}`)).map(runView);
  // Mốc đọc tiếp theo tính từ lúc đọc nguồn của lượt hoàn tất gần nhất, không phải lúc bấm cập nhật; truy vấn riêng để không phụ thuộc 20 lượt gần nhất.
  const latest = (await fetchAll("sku_sync_runs?select=source_generated_at,completed_at&status=eq.completed&order=source_generated_at.desc&limit=1"))[0];
  const latestFull = (await fetchAll("sku_sync_runs?select=source_generated_at,completed_at&mode=eq.full&status=eq.completed&order=completed_at.desc&limit=1"))[0];
  // Mốc lượt toàn bộ tự động gần nhất (hoàn tất hoặc giữ lại) trên server: mọi máy cùng thấy, không đọc lại toàn bộ trong 20 giờ.
  const lastAutoFull = (await fetchAll("sku_sync_runs?select=created_at&run_source=eq.auto&mode=eq.full&status=in.(completed,held)&order=created_at.desc&limit=1"))[0];
  return reply(request, 200, { ok: true, data: { runs, lastSuccessAt: latest?.completed_at ?? null, lastSnapshotAt: latest?.source_generated_at ?? null, lastFullAt: latestFull?.completed_at ?? null, lastFullSnapshotAt: latestFull?.source_generated_at ?? null, lastAutoFullAt: lastAutoFull?.created_at ?? null }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function detail(request: Request, body: Json): Promise<Response> {
  const runId = clean(body.runId, 80);
  const runs = await fetchAll(`sku_sync_runs?select=id,status,mode,cutoff,source_counts,change_counts,changes,verification,error_message,created_at,completed_at,run_source,device,auto_hold&id=eq.${encodeURIComponent(runId)}&limit=1`);
  return runs[0] ? reply(request, 200, { ok: true, data: runView(runs[0]), meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } }) : fail(request, 404, "NOT_FOUND", "Không thấy lượt đồng bộ");
}
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
function configView(row: Json | null): Json {
  const time = (value: unknown, fallback: string) => clean(value, 8).slice(0, 5) || fallback;
  const thresholds = Object.fromEntries(Object.keys(DEFAULT_THRESHOLDS).map(kind => [kind, thresholdsFor(kind, row?.thresholds)]));
  return {
    enabled: row ? row.enabled !== false : true, intervalMinutes: Number(row?.interval_minutes) || 30,
    fullWindow: { start: time(row?.full_window_start, "00:00"), end: time(row?.full_window_end, "05:00") },
    thresholds, updatedAt: row?.updated_at ?? null, updatedBy: row?.updated_by ?? null,
  };
}
// Mốc lượt tự động gần nhất kết thúc (hoàn tất / giữ lại) của từng loại, mọi máy: Extension 0.10.7 dùng làm "còn sống" cho cảnh báo
// ngừng (máy thiếu tab vẫn biết máy khác đang đồng bộ). Đọc lỗi thì trả {} để cấu hình vẫn dùng được.
async function lastFinishedByKind(): Promise<Json> {
  try {
    const rows = await fetchAll("sync_auto_leases?select=kind,last_finished_at");
    return Object.fromEntries(rows.filter(row => row.last_finished_at).map(row => [String(row.kind), row.last_finished_at]));
  } catch {
    return {};
  }
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
  return reply(request, 200, { ok: true, data: { ...configView(await autoSettings()), lastFinishedAt: await lastFinishedByKind() }, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
// Giãn cách giữa các máy: lượt theo lịch gửi cooldownSeconds (nhịp − 2 phút); thiếu / sai → 0 (như cũ). Tối đa 180 phút.
function cooldownOf(value: unknown): number { const seconds = Math.floor(Number(value)); return Number.isFinite(seconds) ? Math.min(Math.max(seconds, 0), 10800) : 0; }
function leaseInput(request: Request, body: Json): { kind: string; holder: string } | Response {
  const kind = clean(body.kind, 20), holder = clean(body.holder, HOLDER_MAX);
  if (!AUTO_KINDS.has(kind)) return fail(request, 400, "INVALID_KIND", "Loại đồng bộ không hợp lệ");
  if (!holder) return fail(request, 400, "INVALID_HOLDER", "Thiếu tên máy");
  return { kind, holder };
}
// Khoá thuê theo loại: data = {ok:true, holder, leasedUntil} khi giành được, {ok:false, holder, leasedUntil} khi máy khác đang giữ.
async function lease(request: Request, body: Json): Promise<Response> {
  const input = leaseInput(request, body);
  if (input instanceof Response) return input;
  const cooldown = cooldownOf(body.cooldownSeconds);
  // data = {ok:false, reason:"COOLDOWN", lastFinishedAt, retryAfter} khi lượt cùng loại vừa kết thúc chưa quá cooldown.
  const data = await rpc("sync_auto_lease", { p_kind: input.kind, p_holder: input.holder, p_ttl_seconds: LEASE_TTL_SECONDS, ...(cooldown > 0 ? { p_cooldown_seconds: cooldown } : {}) });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
}
async function release(request: Request, body: Json): Promise<Response> {
  const input = leaseInput(request, body);
  if (input instanceof Response) return input;
  // finished:true = lượt tự động kết thúc (hoàn tất hoặc giữ lại) → ghi mốc giãn cách; lỗi / bỏ qua không gửi.
  const data = await rpc("sync_auto_release", { p_kind: input.kind, p_holder: input.holder, ...(body.finished === true ? { p_finished: true } : {}) });
  return reply(request, 200, { ok: true, data, meta: { updatedAt: new Date().toISOString(), schemaVersion: 1 } });
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
    if (action === "auto-config") return await autoConfig(request, user, body);
    if (action === "lease") return await lease(request, body);
    if (action === "release") return await release(request, body);
    return fail(request, 400, "UNKNOWN_ACTION", "Thao tác không được hỗ trợ");
  } catch (error) {
    const message = clean((error as Error).message, 500);
    if (message.startsWith("AUTH:")) return fail(request, 401, "AUTH", message.slice(5));
    if (message.startsWith("FORBIDDEN:")) return fail(request, 403, "FORBIDDEN", message.slice(10));
    return fail(request, 500, "SYNC_ERROR", message || "Không xử lý được yêu cầu đồng bộ");
  }
});
