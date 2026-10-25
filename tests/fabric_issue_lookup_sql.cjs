// TRỢ LÝ IN → PACKING LIST CẤP VẢI (supabase/fabric_issue_lookup_v1.sql, 24/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL.
//   * chỉ thêm 1 hàm chỉ đọc fabric_issue_lookup_uids(text[]): stable, SECURITY DEFINER + search_path '', kiểm group_uid_admin_allowed() đầu tiên;
//   * 1–1.000 mã, mỗi mã 10–40 chữ số (INVALID_INPUT); trả items / missing / products / inPlans / openPlans;
//   * không ghi bảng nào (không insert/update/delete); thu hồi public/anon/authenticated rồi chỉ cấp authenticated (Admin kiểm trong hàm).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "supabase", "fabric_issue_lookup_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/fabric_issue_lookup_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

// ---- Khung giao dịch, chỉ thêm ----
assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu commit + notify pgrst");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm");
assert.doesNotMatch(code, /\b(insert\s+into|update\s+public\.|delete\s+from)\b/i, "hàm tra cứu không được ghi bảng");
assert.ok(sql.includes("python scripts/apply_supabase_sql.py supabase/fabric_issue_lookup_v1.sql"), "tiêu đề phải ghi lệnh chạy migration");
assert.match(sql, /Vì sao:/, "tiêu đề phải nêu vì sao");
assert.match(sql, /Tác động:/, "tiêu đề phải nêu tác động");

// ---- Hàm ----
const m = code.match(/create or replace function public\.fabric_issue_lookup_uids\(p_codes text\[\]\)\s*returns jsonb([^$]*)\$\$([\s\S]*?)\$\$;/);
assert.ok(m, "thiếu hàm fabric_issue_lookup_uids(p_codes text[]) returns jsonb");
const [, head, body] = m;
assert.match(head, /\bstable\b/, "hàm chỉ đọc phải stable");
assert.match(head, /security definer/, "cần SECURITY DEFINER");
assert.match(head, /set search_path = ''/, "search_path phải rỗng");
const first = body.replace(/^[\s\S]*?\bbegin\b/, "").trim();
assert.match(first, /^if not public\.group_uid_admin_allowed\(\) then/, "kiểm Admin phải là lệnh đầu tiên");
assert.match(body, /'FORBIDDEN'/, "thiếu mã lỗi FORBIDDEN");
assert.match(body, /cardinality\(p_codes\) not between 1 and 1000/, "giới hạn 1–1.000 mã");
assert.match(body, /\^\[0-9\]\{10,40\}\$/, "mỗi mã 10–40 chữ số");
assert.match(body, /'INVALID_INPUT'/, "thiếu mã lỗi INVALID_INPUT");
for (const key of ["items", "missing", "products", "inPlans", "openPlans"]) assert.match(body, new RegExp(`'${key}'`), `thiếu khoá trả về ${key}`);
for (const t of ["group_uid_details", '"SKU_Name"', "fabric_issue_lines", "fabric_issue_plans"]) assert.ok(body.includes(`public.${t}`), `phải đọc public.${t}`);
assert.match(body, /p\.status = 'open'/, "openPlans chỉ lấy đợt đang mở");
assert.match(body, /'scannedAt'/, "inPlans phải cho biết cuộn đã quét cấp chưa");

// ---- Quyền ----
assert.match(code, /revoke all on function public\.fabric_issue_lookup_uids\(text\[\]\) from public, anon, authenticated;/, "chưa thu hồi quyền mặc định");
assert.match(code, /grant execute on function public\.fabric_issue_lookup_uids\(text\[\]\) to authenticated;/, "chưa cấp authenticated");
assert.doesNotMatch(code, /grant [^;]*fabric_issue_lookup_uids[^;]*\b(anon|public)\b/, "không cấp anon/public");

console.log("PASS fabric_issue_lookup_sql: hàm chỉ đọc, Admin đầu tiên, 1–1.000 mã 10–40 chữ số, 5 khoá trả về, chỉ cấp authenticated");
