// Migration supabase/sync_auto_v2.sql (22/10/2026, Extension 0.10.7 tự động Cắt ADJ + Rủi ro lưu trữ): khoá thuê nhận thêm 2 loại
// cut_adj, storage_risk (thân sync_auto_lease / sync_auto_release giống từng ký tự sync_auto_v1.sql, chỉ đổi danh sách loại) và hàm
// mới wms_cut_coverage() (Admin) trả đúng biểu thức "coverage" mà cut_group_uid_reconcile (bản mới nhất cut_group_uid_po_v1.sql) trả.
//   node tests/sync_auto_v2_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");

const FILE = "supabase/sync_auto_v2.sql";
const read = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const OLD_KINDS = "('sku','group_uid')", NEW_KINDS = "('sku','group_uid','cut_adj','storage_risk')";
const fnOf = (sql, name) => {
  const a = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(a >= 0, `có ${name}`);
  return sql.slice(a, sql.indexOf("end $$;", a) + 7);
};
const coverageOf = sql => {
  const a = sql.indexOf("(select case when count(*)=0 then null else jsonb_build_object(");
  assert.ok(a >= 0, "có biểu thức coverage");
  const end = "from public.wms_group_uid_history_imports)";
  return sql.slice(a, sql.indexOf(end, a) + end.length).replace(/\s+/g, " ");
};
const raw = fs.readFileSync(FILE, "utf8");
const migration = read(FILE), code = migration.replace(/^--.*$/gm, "");
const v1 = read("supabase/sync_auto_v1.sql");
const reconcile = fnOf(read("supabase/cut_group_uid_po_v1.sql").replace(/end\$\$;/g, "end $$;"), "cut_group_uid_reconcile");

function check(sql) {
  const body = sql.replace(/^--.*$/gm, "");
  for (const name of ["sync_auto_lease", "sync_auto_release"]) {
    const next = fnOf(body, name), prev = fnOf(v1, name);
    assert.equal((next.match(/'cut_adj','storage_risk'/g) || []).length, 1, `${name}: nhận 4 loại`);
    assert.equal(next.replace(NEW_KINDS, OLD_KINDS), prev, `${name}: ngoài danh sách loại, giống hệt sync_auto_v1.sql`);
  }
  assert.match(body, /alter table public\.sync_auto_leases drop constraint if exists sync_auto_leases_kind_check;/, "bỏ check cũ của kind");
  assert.ok(body.includes(`alter table public.sync_auto_leases add constraint sync_auto_leases_kind_check\n  check (kind in ${NEW_KINDS});`), "check kind mới đủ 4 loại");
  const cov = fnOf(body, "wms_cut_coverage");
  assert.match(cov, /^create or replace function public\.wms_cut_coverage\(\)\nreturns jsonb\n/, "không tham số, trả jsonb");
  assert.match(cov, /security definer set search_path = ''/, "security definer + search_path rỗng");
  assert.match(cov, /if not public\.group_uid_admin_allowed\(\) then\n\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','FORBIDDEN'/, "chỉ Admin");
  assert.equal(coverageOf(cov), coverageOf(reconcile), "cùng biểu thức coverage với cut_group_uid_reconcile");
  assert.match(cov, /return jsonb_build_object\('ok',true,'data',\(select case/, "trả {ok:true,data:coverage}");
  assert.match(body, /revoke all on function public\.wms_cut_coverage\(\) from public, anon;/, "thu quyền public/anon");
  assert.match(body, /grant execute on function public\.wms_cut_coverage\(\) to authenticated;/, "cấp cho authenticated (JWT Admin)");
  assert.doesNotMatch(body, /grant [^;]*wms_cut_coverage[^;]*\banon\b/, "anon không gọi được");
  assert.match(body, /revoke all on function public\.sync_auto_lease\(text,text,integer,integer\) from public, anon, authenticated;/);
  assert.match(body, /revoke all on function public\.sync_auto_release\(text,text,boolean\) from public, anon, authenticated;/);
  assert.match(body, /grant execute on function public\.sync_auto_lease\(text,text,integer,integer\) to service_role;/);
  assert.match(body, /grant execute on function public\.sync_auto_release\(text,text,boolean\) to service_role;/);
  assert.doesNotMatch(body, /grant [^;]*sync_auto_(lease|release)[^;]* to [^;]*(anon|authenticated)/, "khoá thuê vẫn chỉ service_role");
}

check(migration);
assert.ok(/^begin;$/m.test(migration) && /^commit;$/m.test(migration), "chạy trong một giao dịch");
assert.ok(migration.indexOf("notify pgrst, 'reload schema';") < migration.lastIndexOf("commit;"), "notify pgrst trước commit");
assert.equal((code.match(/create or replace function/g) || []).length, 3, "đúng 3 hàm: lease, release, wms_cut_coverage");
assert.doesNotMatch(code, /drop (function|table)|truncate|delete from/i, "không drop hàm/bảng, không xoá dữ liệu");
assert.ok(raw.includes("\r\n") && !/[^\r]\n/.test(raw), "tệp SQL giữ CRLF như các migration khác");

// Đột biến: mỗi bản sửa sai phải bị bắt
const mutants = [
  migration.replace(NEW_KINDS, OLD_KINDS),                                            // lease quên loại mới
  migration.replace(/(create or replace function public\.sync_auto_release[\s\S]*?)\('sku','group_uid','cut_adj','storage_risk'\)/, "$1('sku','group_uid','cut_adj')"),
  migration.replace("check (kind in ('sku','group_uid','cut_adj','storage_risk'));", "check (kind in ('sku','group_uid'));"),
  migration.replace("v_ttl integer := least(greatest(coalesce(p_ttl_seconds,900),60),3600);", "v_ttl integer := 3600;"),
  migration.replace("'until',max(data_until)", "'until',min(data_until)"),
  migration.replace(/(wms_cut_coverage\(\)[\s\S]*?)security definer set search_path = ''/, "$1security definer"),
  migration.replace(/(wms_cut_coverage\(\)[\s\S]*?)if not public\.group_uid_admin_allowed\(\) then/, "$1if false then"),
  migration.replace("grant execute on function public.wms_cut_coverage() to authenticated;", "grant execute on function public.wms_cut_coverage() to anon, authenticated;"),
];
for (const [index, mutant] of mutants.entries()) {
  assert.notEqual(mutant, migration, `đột biến ${index + 1} phải đổi được tệp`);
  assert.throws(() => check(mutant), undefined, `đột biến ${index + 1} phải bị bắt`);
}
console.log(`sync_auto_v2_sql: lease/release nhận 4 loại (thân giữ nguyên v1), wms_cut_coverage Admin cùng biểu thức coverage, ${mutants.length}/${mutants.length} đột biến bị bắt`);
