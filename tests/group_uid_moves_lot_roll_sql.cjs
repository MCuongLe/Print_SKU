// Migration supabase/group_uid_moves_lot_roll_v1.sql (27/10/2026): LỊCH SỬ GROUP UID trả thêm lot / roll cho file Excel tải xuống.
// Không có Postgres cục bộ: kiểm tĩnh văn bản SQL.
//   * đầu tệp có `-- kiem:` (một câu SELECT chỉ đọc) và khối `-- Rút lui`; begin/commit + notify pgrst; không lệnh xoá ở cấp cao nhất;
//   * group_uid_moves_lookup chép từ bản đang chạy (backend_hygiene_v1.sql), chỉ THÊM hai khoá lot (batch_code) và roll (roll_code);
//   * giữ chữ ký, SECURITY DEFINER + search_path '', che email người ngoài Admin, quyền như đang chạy (anon + authenticated, không public).
//   node tests/group_uid_moves_lot_roll_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const FILE = "supabase/group_uid_moves_lot_roll_v1.sql";
assert.ok(fs.existsSync(path.join(root, FILE)), `chưa có migration thêm lot / roll cho lịch sử Group UID (${FILE})`);
const raw = read(FILE);
const stripComments = s => s.replace(/--[^\n]*/g, "");
const sql = stripComments(raw);
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const lines = s => s.split("\n").map(l => l.trim()).filter(Boolean);
const fnOf = (text, name, label) => {
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${label}: thiếu hàm ${name}`);
  const open = text.indexOf("$$", start), close = text.indexOf("$$", open + 2);
  assert.ok(open > start && close > open, `${label}: không tách được thân ${name}`);
  return { head: text.slice(start, open), body: text.slice(open + 2, close) };
};

// ---------- Đầu tệp: -- kiem: + Rút lui (như scripts/release.py parse_header) ----------
const header = [];
for (const line of raw.split("\n")) { const t = line.trim(); if (t.startsWith("--")) header.push(t); else if (t) break; }
const kiem = header.map(l => l.match(/^--\s*kiem\s*:\s*(\S.*?)\s*$/i)).filter(Boolean).map(m => m[1]);
assert.equal(kiem.length, 1, "đầu tệp có đúng một dòng -- kiem:");
assert.match(kiem[0], /^select\b/i, "-- kiem: là một câu SELECT");
assert.doesNotMatch(kiem[0], /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i, "-- kiem: không có từ khoá ghi (live_status.select_only)");
assert.ok(!kiem[0].replace(/;\s*$/, "").includes(";"), "-- kiem: chỉ một câu");
for (const want of ["group_uid_moves_lookup", "batch_code", "roll_code", "group_uid_admin_allowed"]) assert.ok(kiem[0].includes(want), `-- kiem: kiểm ${want}`);
for (const want of ["has_function_privilege('anon'", "has_function_privilege('authenticated'", "not has_function_privilege('public'"]) assert.ok(kiem[0].includes(want), `-- kiem: kiểm quyền thực thi sau revoke / grant (${want})`);
const back = header.findIndex(l => /^--\s*r[uú]t\s+lui\b/i.test(l));
assert.ok(back >= 0, "đầu tệp có khối -- Rút lui");
assert.match(header[back + 1] || "", /^--(?: {2,}|\t)\s*\S/, "khối Rút lui có dòng lệnh thụt vào");
assert.match(raw, /^-- Lệnh: python scripts\/apply_supabase_sql\.py supabase\/group_uid_moves_lot_roll_v1\.sql$/m, "ghi lệnh chạy, không cần --allow-destructive");

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "chạy trong begin; … commit;");
assert.match(sql, /notify pgrst,\s*'reload schema';/, "nạp lại schema PostgREST");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|view|type|index|function|trigger|policy|column)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\balter\s+table\b[^;]*\bdrop\b/i, "ALTER TABLE … DROP"],
]) assert.ok(!re.test(topLevel), `không có lệnh xoá ở cấp cao nhất (${label})`);
assert.ok(!/create\s+(table|index)|alter\s+table/i.test(topLevel), "không đổi bảng: lot / roll đã nằm ở group_uid_details");

// ---------- Đúng một hàm, chép từ bản đang chạy, chỉ thêm lot / roll ----------
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created, ["group_uid_moves_lookup"], "chỉ thay group_uid_moves_lookup");
const ORIGINAL = "supabase/backend_hygiene_v1.sql";
const now = fnOf(sql, "group_uid_moves_lookup", FILE), old = fnOf(stripComments(read(ORIGINAL)), "group_uid_moves_lookup", ORIGINAL);
assert.equal(squash(now.head), squash(old.head), "giữ chữ ký, kiểu trả, security definer như bản đang chạy");
assert.match(now.head, /security definer set search_path = ''/, "security definer + search_path ''");
const nowLines = lines(now.body), oldLines = lines(old.body);
assert.deepEqual(oldLines.filter(l => !nowLines.includes(l)), [], "không bỏ / đổi dòng nào của bản đang chạy");
const added = nowLines.filter(l => !oldLines.includes(l));
assert.deepEqual(added, ["'lot',d.batch_code,'roll',d.roll_code,"], "chỉ thêm đúng khoá lot (batch_code) và roll (roll_code) từ group_uid_details");

// ---------- Giữ nguyên hành vi bảo mật và dạng trả về ----------
{
  const b = now.body;
  assert.match(b, /v_admin boolean := public\.group_uid_admin_allowed\(\);/, "kiểm Admin một lần");
  assert.ok(b.includes("case when v_admin then q.moved_by else split_part(q.moved_by,'@',1) end"), "người ngoài Admin chỉ nhận phần trước @");
  assert.ok(!/'by',q\.moved_by,/.test(b), "không trả email thô");
  assert.ok(b.includes("from page q left join public.group_uid_details d on d.group_uid_code = q.group_uid_code"), "lot / roll lấy từ phép nối group_uid_details đã có");
  assert.ok(b.indexOf("'skuCount'") < b.indexOf("'lot'") && b.indexOf("'lot'") < b.indexOf("'product'"), "hai khoá mới nằm trong cùng jsonb_build_object, giữa skuCount và product");
  assert.ok(b.includes("'schemaVersion',1"), "schemaVersion giữ 1 (chỉ thêm khoá, tương thích ngược)");
}

// ---------- Quyền: như đang chạy (anon + authenticated thực thi, không public) ----------
{
  const sig = "public.group_uid_moves_lookup(text,text,text,text,timestamptz,timestamptz,integer)";
  assert.ok(topLevel.includes(`revoke all on function ${sig} from public, anon, authenticated;`), "gỡ quyền cũ rồi cấp lại rõ ràng");
  assert.ok(topLevel.includes(`grant execute on function ${sig} to anon, authenticated;`), "cấp lại đúng anon + authenticated (hàm chỉ đọc, như Tra cứu)");
  assert.ok(!/grant\s+execute\s+on\s+function\s+\S+\s+to\s+[^;]*\bpublic\b/i.test(topLevel), "không cấp cho public");
}

console.log("group_uid_moves_lot_roll_sql: chỉ thêm lot / roll cho group_uid_moves_lookup, giữ che email + quyền + begin/commit + Rút lui passed");
