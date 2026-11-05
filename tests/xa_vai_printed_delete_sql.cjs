// Migration supabase/xa_vai_printed_delete_v1.sql (04/11/2026, Việc 6 của docs/plans/2026-11-04-xoa-lenh-da-in-khi-admin-dang-nhap.md):
// Admin xoá dòng đã chọn ở tab "Đã in" của THEO DÕI XẢ VẢI; lệnh in A4 nào không còn dòng thì xoá luôn. Kiểm tĩnh văn bản SQL.
//   node tests/xa_vai_printed_delete_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const FILE = "supabase/xa_vai_printed_delete_v1.sql";
assert.ok(fs.existsSync(path.join(root, FILE)), `thiếu tệp migration ${FILE}`);
const raw = fs.readFileSync(path.join(root, FILE), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const SIG = "public.xa_vai_printed_delete(text[],boolean)";

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "một giao dịch begin; … commit;");
assert.ok(sql.indexOf("commit;") < sql.indexOf("notify pgrst, 'reload schema';"), "notify pgrst sau commit");
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_printed_delete_v1\.sql$/m, "lệnh chạy không kèm --allow-destructive");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|database|view|type|index|function|trigger|policy)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b/i, "ALTER TABLE … DROP"],
]) assert.ok(!re.test(topLevel), `không có lệnh xoá ở cấp cao nhất (${label})`);
assert.ok(!/\btruncate\b/i.test(sql), "không truncate");

const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem, "có dòng -- kiem:");
assert.match(kiem[1], /^select /i);
assert.ok(!/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(kiem[1]), "-- kiem: chỉ đọc");
for (const part of [`to_regprocedure('${SIG}')`, "public.print_jobs_purge_log", "relrowsecurity", `has_function_privilege('anon', '${SIG}'`, `has_function_privilege('authenticated', '${SIG}'`])
  assert.ok(kiem[1].includes(part), `-- kiem: có ${part}`);
assert.match(raw, /^-- Rút lui[^\n]*--allow-destructive/m, "khối -- Rút lui ghi rõ --allow-destructive");
assert.match(raw, /^--\s+drop function if exists public\.xa_vai_printed_delete\(text\[\], boolean\);$/m);
assert.match(raw, /^--\s+drop table if exists public\.print_jobs_purge_log;$/m);

// ---------- Bảng nhật ký (dùng chung với Việc 1) ----------
const table = sql.match(/create table if not exists public\.print_jobs_purge_log \(([\s\S]*?)\n\);/);
assert.ok(table, "tạo bảng print_jobs_purge_log (if not exists)");
for (const col of ["id bigint generated always as identity primary key", "ran_at timestamptz not null default now()", "actor_id uuid", "actor_name text",
  "trigger text not null check (trigger in ('admin_login', 'xa_vai_manual'))", "keep_hours integer", "eligible integer not null default 0",
  "deleted_jobs integer not null default 0", "deleted_events integer not null default 0", "deleted_xa_vai integer not null default 0",
  "by_type jsonb not null default '{}'::jsonb", "oldest_created_at timestamptz", "newest_created_at timestamptz",
  "outcome text not null check (outcome in ('deleted', 'needs_confirm'))"])
  assert.ok(squash(table[1]).includes(col), `cột: ${col}`);
assert.ok(!/payload|\bsku\b|group_uid_code/i.test(table[1]), "nhật ký không lưu payload / SKU / UID");
assert.match(sql, /alter table public\.print_jobs_purge_log enable row level security;/);
assert.match(sql, /revoke all on table public\.print_jobs_purge_log from public, anon, authenticated;/);
assert.ok(!/create policy/i.test(sql), "không policy");
assert.ok(!/grant [^;]*on table/i.test(sql), "không grant bảng");

// ---------- Hàm ----------
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created, ["xa_vai_printed_delete"], "chỉ một hàm mới, không thay hàm có sẵn");
const start = sql.indexOf("create or replace function public.xa_vai_printed_delete(");
const open = sql.indexOf("$$", start), close = sql.indexOf("$$", open + 2);
const head = squash(sql.slice(start, open)), body = sql.slice(open + 2, close), flat = squash(body);
assert.equal(head, "create or replace function public.xa_vai_printed_delete(p_group_uids text[], p_dry_run boolean default true) returns jsonb language plpgsql volatile security definer set search_path = '' as",
  "chữ ký + definer + search_path '' + mặc định chỉ đếm");
assert.match(sql, /revoke all on function public\.xa_vai_printed_delete\(text\[\], boolean\) from public, anon, authenticated;/);
assert.match(sql, /grant execute on function public\.xa_vai_printed_delete\(text\[\], boolean\) to authenticated;/);
assert.equal((sql.match(/\bgrant\b/gi) || []).length, 1, "chỉ một grant");

// Admin trước mọi việc
assert.match(body, /^\s*declare[\s\S]*?begin\s+if not public\.print_admin_allowed\(\) then\s+return jsonb_build_object\('ok', false, 'error', jsonb_build_object\('code', 'FORBIDDEN'/, "kiểm Admin đầu tiên");
// Đầu vào: btrim, bỏ rỗng + trùng; rỗng → BAD_REQUEST; > 1000 → TOO_MANY
assert.match(flat, /array_agg\(distinct btrim\(x\)\)/, "btrim + bỏ trùng");
assert.match(flat, /where nullif\(btrim\(x\), ''\) is not null/, "bỏ rỗng / NULL");
assert.match(body, /'code', 'BAD_REQUEST'/);
assert.match(flat, /cardinality\(v_codes\) > 1000 then return jsonb_build_object\('ok', false, 'error', jsonb_build_object\('code', 'TOO_MANY'/, "tối đa 1000 dòng / lần");
// Phân loại: chỉ dòng printed; xong < 5 phút giữ lại (tab khác có thể còn theo dõi lệnh); không hạn 24 giờ
assert.match(flat, /when m\.group_uid_code is null then 'NOT_FOUND'/);
assert.match(flat, /when m\.status <> 'printed' then 'NOT_PRINTED'/);
assert.match(flat, /when coalesce\(m\.printed_at, now\(\)\) > now\(\) - interval '5 minutes' then 'TOO_RECENT'/, "sàn 5 phút sau khi in");
assert.ok(!/hours|days|\b24\b/i.test(body), "không hạn giữ theo giờ / ngày");
// p_dry_run NULL = chỉ đếm (review Codex vòng 1: NULL bỏ qua cả khoá lẫn nhánh đếm mà vẫn xoá)
assert.match(flat, /v_dry_run boolean := coalesce\(p_dry_run, true\);/, "chuẩn hoá p_dry_run một lần, NULL = chỉ đếm");
assert.equal((flat.match(/\bp_dry_run\b/g) || []).length, 1, "sau khai báo chỉ dùng v_dry_run");
// Lệnh A4 đang chờ / đang in có UID trong payload (lệnh in lại không gắn dòng): giữ lại (review Codex vòng 1)
assert.match(flat, /when exists \(select 1 from public\.print_jobs j where j\.type = 'xa_vai_sheet' and j\.status not in \('completed', 'failed', 'cancelled'\) and j\.payload->'items' @> jsonb_build_array\(jsonb_build_object\('groupUid', r\.code\)\)\) then 'JOB_ACTIVE'/, "giữ UID còn trong lệnh A4 đang chờ / đang in");
assert.ok(flat.indexOf("'JOB_ACTIVE'") < flat.indexOf("'TOO_RECENT'") && flat.indexOf("'NOT_PRINTED'") < flat.indexOf("'JOB_ACTIVE'"), "thứ tự xét: NOT_PRINTED → JOB_ACTIVE → TOO_RECENT");
// Khoá: lệnh trước (cùng thứ tự trigger xa_vai_measures_sync_job: print_jobs → xa_vai_measures), dòng sau; chỉ khi xoá thật
const lockJobs = flat.indexOf("perform 1 from public.print_jobs where id = any(v_job_ids) order by id for update;");
const lockRows = flat.indexOf("perform 1 from public.xa_vai_measures where group_uid_code = any(v_codes) order by group_uid_code for update;");
assert.ok(lockJobs > 0 && lockRows > lockJobs, "khoá print_jobs trước rồi xa_vai_measures, theo thứ tự khoá");
assert.match(flat, /if not v_dry_run then select coalesce\(array_agg\(distinct m\.print_job_id\), '\{\}'::uuid\[\]\) into v_job_ids from public\.xa_vai_measures m where m\.group_uid_code = any\(v_codes\) and m\.print_job_id is not null; perform 1 from public\.print_jobs where id = any\(v_job_ids\) order by id for update; perform 1 from public\.xa_vai_measures where group_uid_code = any\(v_codes\) order by group_uid_code for update; end if;/, "chỉ khoá khi xoá thật");
assert.ok(lockRows < flat.indexOf("'NOT_PRINTED'"), "khoá trước khi phân loại");
// Lệnh A4 sẽ trống: chỉ xa_vai_sheet đã xong, mọi dòng gắn lệnh đều nằm trong danh sách xoá
assert.match(flat, /j\.type = 'xa_vai_sheet' and j\.status in \('completed', 'failed', 'cancelled'\) and not exists \(select 1 from public\.xa_vai_measures m2 where m2\.print_job_id = j\.id and not \(m2\.group_uid_code = any\(v_ok\)\)\)/, "lệnh trống = mọi dòng của lệnh đều bị xoá");
// Chỉ đếm: trả về trước mọi lệnh xoá
const dry = flat.search(/if v_dry_run then return /);
assert.ok(dry > 0, "nhánh chỉ đếm");
const deletes = [...flat.matchAll(/delete from public\.(\w+)/g)];
assert.deepEqual(deletes.map(m => m[1]), ["xa_vai_measures", "print_jobs"], "xoá dòng Xả vải rồi lệnh, không bảng nào khác");
for (const m of deletes) assert.ok(m.index > dry, "lệnh xoá nằm sau nhánh chỉ đếm");
const stmt = m => flat.slice(m.index, flat.indexOf("returning", m.index));
assert.equal(stmt(deletes[0]).trim(), "delete from public.xa_vai_measures where group_uid_code = any(v_ok) and status = 'printed'", "chỉ dòng printed đã qua phân loại");
assert.equal(stmt(deletes[1]).trim(), "delete from public.print_jobs j where j.id = any(v_empty) and j.type = 'xa_vai_sheet' and j.status in ('completed', 'failed', 'cancelled') and not exists (select 1 from public.xa_vai_measures m2 where m2.print_job_id = j.id)", "chỉ lệnh A4 đã trống");
// print_events đếm trước (CASCADE)
assert.ok(flat.indexOf("select count(*) into v_events from public.print_events where job_id = any(v_empty)") > 0, "đếm print_events của lệnh sẽ xoá");
// Nhật ký sau khi xoá
const log = body.match(/insert into public\.print_jobs_purge_log\(([^)]*)\)\s*values\s*\(([\s\S]*?)\);/);
assert.ok(log && body.indexOf(log[0]) > body.indexOf("delete from public.print_jobs"), "ghi nhật ký sau khi xoá");
assert.equal(squash(log[1]), "actor_id, actor_name, trigger, eligible, deleted_jobs, deleted_events, deleted_xa_vai, by_type, oldest_created_at, newest_created_at, outcome");
assert.match(log[2], /'xa_vai_manual'/);
assert.match(log[2], /'deleted'/);
assert.match(body, /\(select auth\.uid\(\)\)/);
assert.match(body, /select username from public\.user_roles where user_id = v_actor limit 1/);
for (const key of ["dryRun", "requested", "uids", "rows", "jobs", "events", "skipped"]) assert.ok(body.includes(`'${key}'`), `trả khoá ${key}`);
for (const t of ["cut_group_uids", "sku_po_receipts", "print_agents", "print_devices", "print_maintenance", "print_events"])
  assert.ok(!new RegExp(`(update|delete from|insert into) public\\.${t}\\b`).test(body), `không ghi ${t}`);
assert.ok(!/\bupdate public\./.test(body), "không update bảng nào");

console.log("xa_vai_printed_delete_sql: giao dịch + kiem + Rút lui, nhật ký RLS không quyền, definer search_path '' Admin đầu tiên, ≤1000, chỉ dòng printed, sàn 5 phút, khoá lệnh → dòng, chỉ đếm mặc định, xoá dòng rồi lệnh A4 trống, nhật ký xa_vai_manual passed");
