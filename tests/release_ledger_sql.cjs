// Migration supabase/release_ledger_v1.sql (26/10/2026, scripts/release.py mô hình A): sổ phát hành public.release_ledger
// (migration / Edge / Extension đã lên + khoá phát hành), chỉ service_role, RLS bật, không policy. Không destructive, không hàm, chạy lại được.
// Kế hoạch: docs/plans/2026-10-26-release-script.md (Việc 1).
//   node tests/release_ledger_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");

const FILE = "supabase/release_ledger_v1.sql";
const raw = fs.readFileSync(FILE, "utf8");
const migration = raw.replace(/\r\n/g, "\n");
const KINDS = "('migration', 'edge', 'extension', 'lock')";
const COLUMNS = [
  "  kind text not null check (kind in " + KINDS + "),",
  "  name text not null check (char_length(name) between 1 and 200),",
  "  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),",
  "  commit_sha text check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,40}$'),",
  "  applied_at timestamptz not null default now(),",
  "  applied_by text check (applied_by is null or char_length(applied_by) <= 120),",
  "  note text check (note is null or char_length(note) <= 500),",
  "  primary key (kind, name)",
];
// Dòng xác minh release.py chạy sau migration: một câu SELECT một dòng, trả true khi bảng có và RLS bật.
const KIEM = "-- kiem: select coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.release_ledger')), false) as ok";

function tableOf(body) {
  const start = body.indexOf("create table if not exists public.release_ledger (\n");
  assert.ok(start >= 0, "có bảng release_ledger (create table if not exists)");
  return body.slice(start, body.indexOf("\n);", start) + 3);
}

function check(sql) {
  const body = sql.replace(/^--.*$/gm, "");
  const table = tableOf(body);
  assert.equal(table, "create table if not exists public.release_ledger (\n" + COLUMNS.join("\n") + "\n);",
    "đúng 7 cột của hợp đồng + khoá chính (kind, name); kind 4 loại; sha256 hex 64 hoặc null");
  assert.equal((body.match(/create index/gi) || []).length, 0, "bảng nhỏ, không index thêm");
  assert.match(body, /\nalter table public\.release_ledger enable row level security;\n/, "RLS bật");
  assert.match(body, /\nrevoke all on public\.release_ledger from public, anon, authenticated;\n/, "thu mọi quyền public/anon/authenticated");
  assert.match(body, /\ngrant select, insert, update, delete on public\.release_ledger to service_role;\n/, "chỉ service_role");
  assert.doesNotMatch(body, /\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i, "không cấp quyền cho anon/authenticated/public");
  assert.doesNotMatch(body, /create policy/i, "không policy");
  assert.doesNotMatch(body, /security definer|create (or replace )?function/i, "không tạo hàm");
  assert.match(body, /comment on table public\.release_ledger is\n  '[^']+';\n/, "có comment bảng");
  assert.equal((body.match(/\bcreate table\b/g) || []).length, (body.match(/\bcreate table if not exists\b/g) || []).length, "mọi create table có if not exists");
  assert.doesNotMatch(body, /\bdrop\b|\btruncate\b|\bdelete\s+from\b/i, "không drop / truncate / delete from ngoài chú thích");
  assert.match(body, /^begin;$/m, "mở giao dịch");
  assert.match(body, /^commit;$/m, "đóng giao dịch");
  const notify = body.indexOf("notify pgrst, 'reload schema';");
  assert.ok(notify > 0 && notify < body.lastIndexOf("commit;"), "notify pgrst trước commit");
  assert.ok(body.indexOf("begin;") < body.indexOf("create table"), "bảng tạo trong giao dịch");
  // Đầu tệp (chú thích trước begin;): vì sao, tác động, lệnh, -- kiem: và -- Rút lui (drop chỉ nằm trong chú thích).
  const header = sql.slice(0, sql.indexOf("\nbegin;"));
  assert.ok(header.split("\n").every(line => line.startsWith("--")), "đầu tệp toàn chú thích");
  assert.match(header, /Vì sao:/);
  assert.match(header, /Tác động:/);
  assert.match(header, /python scripts\/release\.py --init/, "lệnh chạy: release.py --init");
  assert.doesNotMatch(header, /--allow-destructive/, "không cần cờ phá huỷ");
  const kiem = header.split("\n").filter(line => /^--\s*kiem\s*:/i.test(line));
  assert.deepEqual(kiem, [KIEM], "đúng một dòng -- kiem: (bảng có + RLS bật)");
  assert.doesNotMatch(kiem[0].replace(/^--\s*kiem\s*:/i, ""), /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b|;/i, "-- kiem là một câu SELECT chỉ đọc");
  const lines = header.split("\n");
  const back = lines.findIndex(line => /^--\s*r[uú]t\s+lui\b/i.test(line));
  assert.ok(back >= 0, "có dòng -- Rút lui");
  assert.equal(lines[back + 1], "--   drop table if exists public.release_ledger;", "khối Rút lui: drop table ghi trong chú thích thụt vào, không chạy");
  assert.ok(header.indexOf(KIEM) < header.indexOf(lines[back]), "-- kiem đứng trước khối Rút lui");
}

check(migration);
assert.ok(raw.includes("\r\n") && !/[^\r]\n/.test(raw), "tệp SQL giữ CRLF như các migration khác");

// Đột biến: mỗi bản sửa sai phải bị bắt
const mutants = [
  migration.replace("alter table public.release_ledger enable row level security;\n", ""),                                   // quên RLS
  migration.replace("to service_role;", "to service_role, authenticated;"),                                                       // lộ cho authenticated
  migration.replace("revoke all on public.release_ledger from public, anon, authenticated;", "revoke all on public.release_ledger from public;\ngrant select on public.release_ledger to anon;"),
  migration.replace("check (kind in " + KINDS + ")", "check (kind in ('migration', 'edge', 'extension'))"),                      // thiếu loại lock
  migration.replace("sha256 ~ '^[0-9a-f]{64}$'", "sha256 ~ '^[0-9a-f]+$'"),                                                    // nới sha
  migration.replace("  primary key (kind, name)", "  primary key (name)"),                                                        // sai khoá chính
  migration.replace("create table if not exists public.release_ledger (", "create table public.release_ledger ("),              // bỏ if not exists
  migration.replace("\ncommit;", "\ndrop table if exists public.release_ledger_old;\ncommit;"),                                  // thêm drop chạy thật
  migration.replace("--   drop table if exists public.release_ledger;", "drop table if exists public.release_ledger;"),        // rút lui thành lệnh chạy
  migration.replace(KIEM + "\n", ""),                                                                                              // mất dòng kiem
  migration.replace(KIEM, KIEM.replace("relrowsecurity", "relhasindex")),                                                         // kiem sai cột
  migration.replace("notify pgrst, 'reload schema';\n", ""),
  migration.replace("  applied_at timestamptz not null default now(),\n", ""),                                                   // thiếu cột hợp đồng
  migration.replace("\nbegin;\n", "\n"),                                                                                           // bỏ giao dịch
  migration.replace("comment on table public.release_ledger is", "create policy release_ledger_read on public.release_ledger for select using (true);\ncomment on table public.release_ledger is"),
];
for (const [index, mutant] of mutants.entries()) {
  assert.notEqual(mutant, migration, `đột biến ${index + 1} phải đổi được tệp`);
  assert.throws(() => check(mutant), undefined, `đột biến ${index + 1} phải bị bắt`);
}
console.log(`release_ledger_sql: bảng release_ledger (khoá kind + name, RLS, chỉ service_role), -- kiem + -- Rút lui ở đầu tệp, không destructive, CRLF, ${mutants.length}/${mutants.length} đột biến bị bắt`);
