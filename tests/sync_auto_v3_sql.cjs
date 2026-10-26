// Migration supabase/sync_auto_v3.sql (26/10/2026, Extension 0.10.10 khai báo bản): bảng mới sync_auto_devices (ghi nhận máy đồng bộ,
// chỉ service_role qua Edge), cột ext_version ở hai bảng lượt, sync_auto_settings.min_extension (mức tối thiểu theo loại, rỗng = không chặn).
// Không destructive, không thay hàm nào, chạy lại được.
//   node tests/sync_auto_v3_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");

const FILE = "supabase/sync_auto_v3.sql";
const raw = fs.readFileSync(FILE, "utf8");
const migration = raw.replace(/\r\n/g, "\n");
const KINDS = "('sku','group_uid','cut_adj','storage_risk')";
const EXT_VERSION = "add column if not exists ext_version text check (ext_version is null or char_length(ext_version) <= 20);";
// Review vòng 1 (S): mức sai dạng bị CHECK từ chối ngay khi update (không còn "bỏ qua lặng" ở Edge). `strict` bắt buộc: thiếu thì mảng lọt.
// Biểu thức này lead đã chạy bằng SELECT chỉ đọc trên Postgres thật; test ở đây chỉ kiểm văn bản + so regex với VERSION_RE của Edge.
const VALUE_CLAUSE = String.raw`jsonb_path_exists(min_extension, 'strict $.* ? (@.type() != "null" && (@.type() != "string" || !(@ like_regex "^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$")))')`;
// Vòng 1b: tên khoá lạ (gõ sai loại, vd. "skus") cũng bị CHECK từ chối; danh sách khoá phải đúng VERSION_KINDS của hai Edge.
const KEY_CLAUSE = String.raw`jsonb_path_exists(min_extension, 'strict $.keyvalue() ? (@.key != "sku" && @.key != "group_uid" && @.key != "cut_adj" && @.key != "storage_risk")')`;
const MIN_CHECK = `check (jsonb_typeof(min_extension) = 'object'\n      and not ${VALUE_CLAUSE}\n      and not ${KEY_CLAUSE})`;
function edgeKinds(file) {
  const match = fs.readFileSync(file, "utf8").match(/const VERSION_KINDS = \[([^\]]*)\];/);
  assert.ok(match, `${file} có VERSION_KINDS`);
  return [...match[1].matchAll(/"([a-z_]+)"/g)].map(item => item[1]);
}
const EDGE_KINDS = edgeKinds("supabase/functions/sku-sync/index.ts");
assert.deepEqual(edgeKinds("supabase/functions/group-uid-sync/index.ts"), EDGE_KINDS, "VERSION_KINDS hai Edge giống nhau");
const EDGE_VERSION_RE = (() => {
  const match = fs.readFileSync("supabase/functions/sku-sync/index.ts", "utf8").match(/const VERSION_RE = \/(.+)\/;/);
  assert.ok(match, "Edge sku-sync có VERSION_RE");
  return new RegExp(match[1]);
})();
// Chuỗi mẫu đặt ở hằng riêng, tên hằng không chứa chữ khoá của commit_gate mục 5 (dòng có chữ khoá + số bản cũ bị coi là khẳng định bản).
const OLD_EXT = "0.10.9", NEW_EXT = "0.10.10";
const EXT_SAMPLES = [NEW_EXT, OLD_EXT, "1.0.0", "999.999.999", "1000.0.0", "0.10", `${OLD_EXT}.1`, `v${NEW_EXT}`, `${NEW_EXT} `, ` ${NEW_EXT}`, "", "a.b.c", `${NEW_EXT}\n`];

function tableOf(body) {
  const start = body.indexOf("create table if not exists public.sync_auto_devices (\n");
  assert.ok(start >= 0, "có bảng sync_auto_devices (create table if not exists)");
  return body.slice(start, body.indexOf("\n);", start) + 3);
}

function check(sql) {
  const body = sql.replace(/^--.*$/gm, "");
  const table = tableOf(body);
  assert.match(table, /\n  holder text primary key check \(char_length\(holder\) between 1 and 80\),\n/, "holder khoá chính 1–80 ký tự");
  assert.match(table, /\n  device text not null check \(char_length\(device\) <= 60\),\n/, "device ≤ 60, not null");
  assert.match(table, /\n  ext_version text check \(ext_version is null or char_length\(ext_version\) <= 20\),\n/, "ext_version null hoặc ≤ 20");
  assert.match(table, /\n  first_seen_at timestamptz not null default now\(\),\n/, "first_seen_at mặc định now()");
  assert.match(table, /\n  last_seen_at timestamptz not null default now\(\),\n/, "last_seen_at mặc định now()");
  assert.ok(table.includes(`\n  last_kind text check (last_kind is null or last_kind in ${KINDS})\n);`), "last_kind thuộc 4 loại tự động");
  assert.equal((body.match(/create index/gi) || []).length, 0, "bảng nhỏ, không index thêm");
  assert.match(body, /\nalter table public\.sync_auto_devices enable row level security;\n/, "RLS bật");
  assert.match(body, /\nrevoke all on public\.sync_auto_devices from public, anon, authenticated;\n/, "thu mọi quyền public/anon/authenticated");
  assert.match(body, /\ngrant select, insert, update, delete on public\.sync_auto_devices to service_role;\n/, "chỉ service_role (Edge) đọc/ghi");
  assert.doesNotMatch(body, /\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i, "không cấp quyền cho anon/authenticated/public");
  assert.doesNotMatch(body, /create policy/i, "không policy");
  assert.match(body, /comment on table public\.sync_auto_devices is\n/, "có comment bảng");
  for (const name of ["sku_sync_runs", "group_uid_sync_runs"]) {
    assert.ok(body.includes(`\nalter table public.${name}\n  ${EXT_VERSION}\n`), `${name}: thêm cột ext_version (if not exists, ≤ 20)`);
  }
  assert.ok(body.includes(`\nalter table public.sync_auto_settings\n  add column if not exists min_extension jsonb not null default '{}'::jsonb\n    ${MIN_CHECK};\n`),
    "min_extension jsonb object, mặc định {} (không chặn), giá trị sai dạng hoặc khoá lạ bị CHECK từ chối");
  const minCheck = body.slice(body.indexOf("add column if not exists min_extension"), body.indexOf(";", body.indexOf("add column if not exists min_extension")));
  assert.match(minCheck, /check \(jsonb_typeof\(min_extension\) = 'object'\s+and not jsonb_path_exists\(min_extension, 'strict \$\.\* \? /, "jsonb_typeof object + jsonb_path_exists với strict (thiếu strict thì mảng lọt)");
  const keyClause = minCheck.match(/\s+and not jsonb_path_exists\(min_extension, 'strict \$\.keyvalue\(\) \? \(([^)]*)\)'\)\)$/);
  assert.ok(keyClause, "có vế khoá lạ: and not jsonb_path_exists(min_extension, 'strict $.keyvalue() ? (…)') ở cuối CHECK");
  const keys = [...keyClause[1].matchAll(/@\.key != "([a-z_]+)"/g)].map(item => item[1]);
  assert.equal(keyClause[1], keys.map(key => `@.key != "${key}"`).join(" && "), "vế khoá chỉ gồm @.key != \"…\" nối bằng &&");
  assert.equal(new Set(keys).size, keys.length, "không lặp tên khoá");
  assert.deepEqual([...keys].sort(), [...EDGE_KINDS].sort(), "tên khoá được phép = VERSION_KINDS của hai Edge");
  assert.deepEqual([...keys].sort(), KINDS.match(/'[a-z_]+'/g).map(item => item.slice(1, -1)).sort(), "cùng 4 loại với check last_kind");
  const regex = minCheck.match(/like_regex "([^"]+)"/);
  assert.ok(regex, "có like_regex");
  // Chuỗi jsonpath: "\\." là một gạch ngược thoát dấu chấm → regex POSIX ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$, cùng nghĩa VERSION_RE của Edge.
  const sqlRe = new RegExp(regex[1].replace(/\\\\/g, "\\"));
  for (const sample of EXT_SAMPLES) assert.equal(sqlRe.test(sample), EDGE_VERSION_RE.test(sample), `regex CHECK và VERSION_RE Edge cùng kết luận cho ${JSON.stringify(sample)}`);
  assert.equal((body.match(/\bcreate table\b/g) || []).length, (body.match(/\bcreate table if not exists\b/g) || []).length, "mọi create table có if not exists");
  assert.equal((body.match(/\badd column\b/g) || []).length, (body.match(/\badd column if not exists\b/g) || []).length, "mọi add column có if not exists");
  assert.doesNotMatch(body, /\bdrop\b|\btruncate\b|\bdelete\s+from\b/i, "không drop / truncate / delete from");
  assert.doesNotMatch(body, /create (or replace )?function/i, "không tạo / thay hàm nào");
  assert.match(body, /^begin;$/m, "mở giao dịch");
  assert.match(body, /^commit;$/m, "đóng giao dịch");
  const notify = body.indexOf("notify pgrst, 'reload schema';");
  assert.ok(notify > 0 && notify < body.lastIndexOf("commit;"), "notify pgrst trước commit");
}

check(migration);
// Đầu tệp: vì sao, tác động, lệnh chạy không cần cờ, thứ tự lên, đặt / rút mức tối thiểu bằng SQL tay.
const header = migration.slice(0, migration.indexOf("\nbegin;"));
assert.ok(header.split("\n").every(line => line.startsWith("--")), "đầu tệp toàn chú thích");
assert.match(header, /Vì sao:/);
assert.match(header, /Tác động:/);
assert.match(header, /python scripts\/apply_supabase_sql\.py supabase\/sync_auto_v3\.sql\n/, "lệnh chạy migration");
assert.doesNotMatch(header, /--allow-destructive/, "không cần cờ phá huỷ");
assert.match(header, /python scripts\/deploy_sku_sync\.py/);
assert.match(header, /python scripts\/deploy_group_uid_sync\.py/);
assert.match(header, /0\.10\.10/);
assert.ok(header.includes(`update public.sync_auto_settings set min_extension = '{"sku":"0.10.10","group_uid":"0.10.10","cut_adj":"0.10.10","storage_risk":"0.10.10"}';`), "lệnh nâng mức tối thiểu");
assert.ok(header.includes("update public.sync_auto_settings set min_extension = '{}';"), "lệnh rút lui");
assert.match(header, /sai dạng[^\n]*CHECK từ chối/, "đầu tệp nói mức sai dạng bị CHECK từ chối (không còn bỏ qua lặng)");
assert.match(header, /khoá lạ[^\n]*CHECK từ chối/, "đầu tệp nói khoá lạ (gõ sai tên loại) bị CHECK từ chối");
assert.match(migration, /comment on column public\.sync_auto_settings\.min_extension is\n  '[^']*khoá lạ[^']*';\n/, "comment cột nói khoá lạ bị từ chối");
assert.ok(raw.includes("\r\n") && !/[^\r]\n/.test(raw), "tệp SQL giữ CRLF như các migration khác");

// Đột biến: mỗi bản sửa sai phải bị bắt
const mutants = [
  migration.replace("alter table public.sync_auto_devices enable row level security;\n", ""),                                   // quên RLS
  migration.replace("grant select, insert, update, delete on public.sync_auto_devices to service_role;", "grant select, insert, update, delete on public.sync_auto_devices to service_role, authenticated;"),
  migration.replace("revoke all on public.sync_auto_devices from public, anon, authenticated;", "revoke all on public.sync_auto_devices from public;\ngrant select on public.sync_auto_devices to anon;"),
  migration.replace(`alter table public.sku_sync_runs\n  ${EXT_VERSION}\n`, ""),                                                  // quên cột ở sku_sync_runs
  migration.replace(`alter table public.group_uid_sync_runs\n  ${EXT_VERSION}\n`, ""),                                            // quên cột ở group_uid_sync_runs
  migration.replace("min_extension jsonb not null default '{}'::jsonb", `min_extension jsonb not null default '{"sku":"0.10.10"}'::jsonb`),
  migration.replace("\ncommit;", "\ndrop table if exists public.sync_auto_leases_old;\ncommit;"),                                // thêm drop
  migration.replace("create table if not exists public.sync_auto_devices (", "create table public.sync_auto_devices ("),          // bỏ if not exists
  migration.replace(`alter table public.group_uid_sync_runs\n  add column if not exists ext_version`, "alter table public.group_uid_sync_runs\n  add column ext_version"),
  migration.replace(`last_kind in ${KINDS}`, "last_kind in ('sku','group_uid')"),
  migration.replace("notify pgrst, 'reload schema';\n", ""),
  migration.replace("jsonb_path_exists(min_extension, 'strict $.* ?", "jsonb_path_exists(min_extension, '$.* ?"),                // bỏ strict (mảng lọt)
  migration.replace(/\n      and not jsonb_path_exists\(min_extension, 'strict \$\.\* [^\n]*/, ""),                                    // bỏ vế giá trị sai dạng
  migration.replace(String.raw`[0-9]{1,3}$")))')`, String.raw`[0-9]{1,3}")))')`),                                               // nới regex: bỏ neo cuối
  migration.replace(String.raw`"^[0-9]{1,3}\\.`, String.raw`"^[0-9]{1,4}\\.`),                                                    // nới regex: 4 chữ số
  migration.replace("check (jsonb_typeof(min_extension) = 'object'\n      and not", "check (not"),                                // bỏ jsonb_typeof
  migration.replace(/\n      and not jsonb_path_exists\(min_extension, 'strict \$\.keyvalue\(\)[^\n]*?'\)/, ""),                       // bỏ vế khoá lạ
  migration.replace(' && @.key != "storage_risk"', ""),                                                                          // thiếu một tên loại
  migration.replace("'strict $.keyvalue()", "'$.keyvalue()"),                                                                     // vế khoá bỏ strict
  migration.replace('@.key != "sku" && @.key != "group_uid"', '@.key != "sku" || @.key != "group_uid"'),                       // && thành || (mọi khoá bị bắt / lọt)
  migration.replace('@.key != "cut_adj"', '@.key != "cut-adj"'),                                                                // gõ sai tên loại trong CHECK
];
for (const [index, mutant] of mutants.entries()) {
  assert.notEqual(mutant, migration, `đột biến ${index + 1} phải đổi được tệp`);
  assert.throws(() => check(mutant), undefined, `đột biến ${index + 1} phải bị bắt`);
}
console.log(`sync_auto_v3_sql: sync_auto_devices (RLS, chỉ service_role), ext_version ở 2 bảng lượt, min_extension mặc định {}, không destructive, ${mutants.length}/${mutants.length} đột biến bị bắt`);
