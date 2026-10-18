// Cache trên máy + kiểm phiên bản (supabase/snapshot_cache_v1.sql, 18/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * ba hàm đọc mới sku_count_snapshot(uuid), uid_temp_snapshot(uuid), sku_catalog_changes(timestamptz):
//     SECURITY DEFINER + search_path '' + stable, không ghi, cấp anon + authenticated, thu hồi khỏi public;
//   * KHÔNG thay sku_count_overview() / uid_temp_overview() (trang cũ còn gọi; thêm tham số mặc định sẽ sinh PGRST203);
//   * hai hàm bản chụp tái dùng hàm overview cũ, lượt đã biết → {unchanged:true, runId};
//   * sku_catalog_changes: version {activeCount, maxUpdatedAt}, upserts {sku, product_name, status}, removed chỉ mã, ngưỡng 2.000 → tooMany;
//   * chỉ thêm (không drop / truncate / alter … drop), có begin/commit + notify pgrst.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "supabase", "snapshot_cache_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/snapshot_cache_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /notify pgrst,\s*'reload schema'/, "thiếu notify pgrst");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b|\bdelete\s+from\b/i, "migration chỉ được thêm, không drop/truncate/delete");
assert.doesNotMatch(code, /create\s+(or\s+replace\s+)?function\s+public\.(sku_count_overview|uid_temp_overview)\b/i, "không được thay sku_count_overview / uid_temp_overview (trang cũ còn gọi)");
assert.doesNotMatch(code, /create\s+table/i, "đợt này chỉ thêm hàm đọc");

const fn = name => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: m[1].replace(/\s+/g, " ").trim(), head: m[2], body: m[3] };
};
const skuSnap = fn("sku_count_snapshot"), uidSnap = fn("uid_temp_snapshot"), catalog = fn("sku_catalog_changes");
const all = [["sku_count_snapshot", skuSnap, "uuid"], ["uid_temp_snapshot", uidSnap, "uuid"], ["sku_catalog_changes", catalog, "timestamptz"]];

for (const [name, f, type] of all) {
  assert.match(f.params, new RegExp(`^p_(known_run_id|since) ${type}( default null)?$`), `${name}: một tham số ${type}`);
  assert.match(f.head, /returns jsonb/i, `${name} trả jsonb`);
  assert.match(f.head, /security definer/i, `${name} phải SECURITY DEFINER`);
  assert.match(f.head, /set search_path = ''/, `${name} phải set search_path = ''`);
  assert.match(f.head, /\bstable\b/i, `${name} phải stable (chỉ đọc)`);
  assert.doesNotMatch(f.body, /\b(insert|update|delete|truncate|perform\s+pg_advisory)\b/i, `${name} không được ghi`);
  assert.match(f.body, /'ok',\s*true/, `${name} trả ok:true`);
  assert.match(f.body, /'meta',\s*jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, `${name} trả meta {updatedAt, schemaVersion:1}`);
  assert.match(code, new RegExp(`revoke all on function public\\.${name}\\(${type}\\) from public;`), `${name} chưa thu hồi khỏi public`);
  assert.match(code, new RegExp(`grant execute on function public\\.${name}\\(${type}\\) to anon, authenticated;`), `${name} phải cấp anon + authenticated`);
}
assert.equal(skuSnap.params.split(" ")[0], "p_known_run_id");
assert.equal(uidSnap.params.split(" ")[0], "p_known_run_id");
assert.equal(catalog.params.split(" ")[0], "p_since");

// Bản chụp: chọn lượt giống hệt hàm overview cũ, lượt đã biết → unchanged, còn lại → nguyên kết quả overview + unchanged:false
for (const [name, f, overview, order] of [
  ["sku_count_snapshot", skuSnap, "sku_count_overview", /from public\.sku_count_runs\s+where status = 'completed'\s+order by completed_at desc, id desc\s+limit 1/],
  ["uid_temp_snapshot", uidSnap, "uid_temp_overview", /from public\.uid_temp_runs\s+order by read_at desc, created_at desc, id desc\s+limit 1/],
]) {
  assert.match(f.body, order, `${name} phải chọn lượt mới nhất như ${overview}`);
  assert.match(f.body, new RegExp(`public\\.${overview}\\(\\)`), `${name} phải tái dùng ${overview}() (không chép hai lần)`);
  assert.match(f.body, /p_known_run_id is not null/, `${name}: p_known_run_id null → trả đủ dữ liệu`);
  assert.match(f.body, /'unchanged',\s*true,\s*'runId'/, `${name}: lượt đã biết → {unchanged:true, runId}`);
  assert.match(f.body, /jsonb_set\([^;]*'\{data,unchanged\}',\s*'false'::jsonb/, `${name}: lượt mới → thêm unchanged:false vào data của overview`);
  assert.doesNotMatch(f.body, /jsonb_agg/, `${name} không tự dựng lại rows (dùng overview)`);
}

// Danh mục SKU thay đổi
const b = catalog.body;
assert.match(b, /"SKU_Name"/, "đọc bảng SKU_Name");
assert.match(b, /count\(\*\) filter \(where s\.status = '1'\)|count\(\*\)[^;]*where s\.status = '1'/, "activeCount = số dòng status '1'");
assert.match(b, /greatest\(\s*max\(s\.updated_at\),\s*max\(s\.inactive_since\)/, "maxUpdatedAt = greatest(max(updated_at), max(inactive_since)) trên mọi dòng");
assert.match(b, /'activeCount'/); assert.match(b, /'maxUpdatedAt'/);
for (const k of ["'version'", "'upserts'", "'removed'", "'tooMany'"]) assert.ok(b.includes(k), `sku_catalog_changes thiếu khoá ${k}`);
assert.match(b, /s\.status = '1' and s\.updated_at > p_since/, "upserts = dòng đang hoạt động có updated_at > p_since");
assert.match(b, /jsonb_build_object\('sku',\s*u\.sku,\s*'product_name',\s*u\.product_name,\s*'status',\s*u\.status\)\s+order by u\.sku/, "upserts {sku, product_name, status} sắp theo sku");
assert.match(b, /s\.status is distinct from '1' and s\.inactive_since > p_since/, "removed = SKU ngừng có inactive_since > p_since");
const removedCte = b.match(/\bremoved\s+as\s*\(([\s\S]*?)\)\s*(,|select)/);
assert.ok(removedCte, "removed phải là một CTE riêng");
assert.doesNotMatch(removedCte[1], /product_name|\*/, "removed chỉ trả mã SKU, không trả tên");
assert.match(removedCte[1], /select s\.sku from public\."SKU_Name" s/, "removed chọn đúng cột sku");
assert.match(b, /jsonb_agg\(r\.sku order by r\.sku\)/, "removed là mảng mã SKU");
// SKU rời nhóm đồng bộ bị XOÁ khỏi SKU_Name (sku_missing_archive_v1, có thể đang status '1') → phải vào removed qua sku_archive,
// trừ SKU đã quay lại hoạt động; mốc lưu trữ cũng làm đổi maxUpdatedAt.
assert.match(removedCte[1], /select a\.sku from public\.sku_archive a\s+where a\.archived_at > p_since and not exists \(select 1 from public\."SKU_Name" x where x\.sku = a\.sku and x\.status = '1'\)/, "removed gồm SKU đã chuyển sang sku_archive sau p_since (trừ SKU đã quay lại)");
assert.match(b, /greatest\([^;]*\(select max\(a\.archived_at\) from public\.sku_archive a\)\)/, "maxUpdatedAt tính cả mốc lưu trữ");
assert.match(b, /2000/, "ngưỡng 2.000 dòng");
assert.match(b, /p_since is null or [^;]*> 2000/, "p_since null hoặc quá 2.000 → tooMany");
assert.match(b, /'tooMany',\s*true,\s*'upserts',\s*'\[\]'::jsonb,\s*'removed',\s*'\[\]'::jsonb/, "tooMany → upserts/removed rỗng");
assert.match(b, /'tooMany',\s*false/, "trong ngưỡng → tooMany:false");

console.log("snapshot_cache_sql: 3 hàm đọc SECURITY DEFINER stable cho anon, không thay overview cũ, bản chụp unchanged theo runId, danh mục SKU thay đổi có ngưỡng 2.000 và removed chỉ mã — passed");
