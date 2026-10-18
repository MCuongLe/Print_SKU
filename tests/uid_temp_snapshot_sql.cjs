// Bản lưu UID tạm (supabase/uid_temp_snapshot_v1.sql, 18/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * hai bảng bật RLS, thu hồi khỏi public/anon/authenticated, chỉ service_role;
//   * uid_temp_save: SECURITY DEFINER + search_path '', kiểm group_uid_admin_allowed() trước mọi thứ, chỉ cấp authenticated (không anon);
//   * uid_temp_overview: chỉ đọc (stable), cấp anon + authenticated;
//   * lượt rỗng được lưu (không có nhánh EMPTY_RUN), giữ 10 lượt gần nhất, giới hạn 5.000 dòng;
//   * chỉ thêm (không drop / truncate / alter … drop), có begin/commit + notify pgrst.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "supabase", "uid_temp_snapshot_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/uid_temp_snapshot_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /notify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm, không drop/truncate");

for (const t of ["uid_temp_runs", "uid_temp_rows"]) {
  assert.match(code, new RegExp(`create table if not exists public\\.${t}\\b`), `thiếu bảng ${t}`);
  assert.match(code, new RegExp(`alter table public\\.${t} enable row level security`), `${t} chưa bật RLS`);
  assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`), `${t} chưa thu hồi quyền`);
  assert.match(code, new RegExp(`grant [^;]* on public\\.${t} to service_role`), `${t} chưa cấp service_role`);
  assert.doesNotMatch(code, new RegExp(`grant [^;]* on public\\.${t} to [^;]*\\b(anon|authenticated)\\b`), `${t} không được cấp thẳng cho anon/authenticated`);
}
assert.match(code, /references public\.uid_temp_runs\(id\) on delete cascade/, "dòng phải xoá theo lượt (cascade)");

const fn = name => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: m[1], head: m[2], body: m[3] };
};
const save = fn("uid_temp_save"), view = fn("uid_temp_overview");
for (const [name, f] of [["uid_temp_save", save], ["uid_temp_overview", view]]) {
  assert.match(f.head, /security definer/i, `${name} phải SECURITY DEFINER`);
  assert.match(f.head, /set search_path = ''/, `${name} phải set search_path = ''`);
}
assert.match(view.head, /\bstable\b/, "uid_temp_overview phải stable (chỉ đọc)");
assert.doesNotMatch(view.body, /\b(insert|update|delete)\b/i, "uid_temp_overview không được ghi");
assert.equal(save.params.replace(/\s+/g, " ").trim(), "p_run jsonb, p_rows jsonb");

// Kiểm quyền Admin là việc đầu tiên của hàm ghi
const firstIf = save.body.indexOf("if ");
assert.ok(firstIf >= 0 && save.body.slice(firstIf, firstIf + 60).includes("public.group_uid_admin_allowed()"), "uid_temp_save phải kiểm group_uid_admin_allowed() đầu tiên");
assert.match(save.body, /'FORBIDDEN'/);
assert.doesNotMatch(save.body, /EMPTY_RUN/, "lượt rỗng là kết quả hợp lệ, phải lưu được");
assert.match(save.body, /jsonb_array_length\(p_rows\) > 5000/, "giới hạn 5.000 dòng");
assert.match(save.body, /limit 10\)/, "giữ 10 lượt gần nhất");
assert.match(save.body, /\(select auth\.uid\(\)\)/, "ghi người lưu = auth.uid()");
assert.match(save.body, /wh not in \('mtg','garment'\)/, "chỉ nhận hai kho MTG / GARMENT");
// Codex vòng 1 (18/10/2026): hai máy lưu cùng lúc + dữ liệu sai kiểu
assert.match(save.body, /pg_advisory_xact_lock\(/, "lưu tuần tự bằng advisory lock (hai máy cùng lưu)");
assert.match(save.body, /order by read_at desc, created_at desc, id desc limit 10/, "giữ 10 lượt theo giờ đọc");
assert.match(view.body, /order by read_at desc, created_at desc, id desc limit 1/, "bản mới nhất theo giờ đọc, không theo giờ ghi");
assert.match(save.body, /exception when others then[\s\S]*'INVALID_ROWS'/, "ép kiểu dòng lỗi phải trả INVALID_ROWS, không ném lỗi thô");
assert.match(save.body, /'Infinity'::numeric/, "chặn qty Infinity");
// Codex vòng 2: kiểu từng trường + lượt vừa ghi bị dọn ngay
for (const f of ["wh", "warehouseName", "sku"]) assert.ok(save.body.includes(`jsonb_typeof(e.v->'${f}') is distinct from 'string'`), `trường ${f} phải là chuỗi`);
for (const f of ["productName", "sourceCode", "mappingId", "createdBy", "createdAt"]) assert.ok(save.body.includes(`coalesce(jsonb_typeof(e.v->'${f}'),'null') not in ('string','null')`), `trường ${f} phải là chuỗi hoặc null`);
assert.match(save.body, /'Bộ đếm lần đọc không hợp lệ'/, "scanned/pages/rangeDays sai kiểu phải trả lỗi, không tự đổi 0/90");
assert.doesNotMatch(save.body, /else 0 end|else 90 end/, "không âm thầm thay bộ đếm sai kiểu");
assert.doesNotMatch(save.body, /jsonb_typeof\(p_run->k\.f\) <> 'null'/, "bộ đếm null cũng là sai kiểu (Codex vòng 3)");
assert.match(save.body, /'STALE_RUN'/, "lượt vừa ghi bị giữ-10 loại ngay thì báo STALE_RUN, không báo đã lưu");

// Cấp quyền gọi
assert.match(code, /revoke all on function public\.uid_temp_save\(jsonb,jsonb\) from public, anon;/, "thu hồi uid_temp_save khỏi public/anon");
assert.match(code, /grant execute on function public\.uid_temp_save\(jsonb,jsonb\) to authenticated;/, "uid_temp_save chỉ cấp authenticated");
assert.doesNotMatch(code, /grant execute on function public\.uid_temp_save\([^)]*\) to [^;]*\banon\b/, "uid_temp_save không được cấp anon");
assert.match(code, /revoke all on function public\.uid_temp_overview\(\) from public;/);
assert.match(code, /grant execute on function public\.uid_temp_overview\(\) to anon, authenticated;/, "uid_temp_overview cấp anon + authenticated");

// Trường trả về khớp web (storage-risk-temp-script đọc các khoá này)
for (const k of ["'readAt'", "'warehouses'", "'warn'", "'scanned'", "'pages'", "'rangeDays'", "'rowCount'", "'history'"]) assert.ok(view.body.includes(k), `uid_temp_overview thiếu ${k}`);
for (const k of ["'wh'", "'warehouseName'", "'sku'", "'productName'", "'qty'", "'sourceCode'", "'mappingId'", "'createdBy'", "'createdAt'"]) assert.ok(view.body.includes(k), `dòng trả về thiếu ${k}`);

console.log("uid_temp_snapshot_sql: bảng RLS chỉ service_role, save kiểm Admin + chỉ authenticated, overview chỉ đọc cho anon, lượt rỗng được lưu, giữ 10 lượt — passed");
