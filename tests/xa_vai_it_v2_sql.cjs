// Migration supabase/xa_vai_it_v2.sql (05/11/2026): xả vải theo phiếu IT — UID ngoài phiếu (cùng SKU tự gắn, khác SKU chặn + báo vận hành kho),
// Admin đóng đợt. Kiểm tĩnh văn bản SQL (máy không có Postgres).
//   node tests/xa_vai_it_v2_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const FILE = "supabase/xa_vai_it_v2.sql";
const raw = fs.readFileSync(path.join(root, FILE), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const fnBody = name => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `có hàm ${name}`);
  const open = sql.indexOf("$$", start), close = sql.indexOf("$$", open + 2);
  return { head: squash(sql.slice(start, open)), body: squash(sql.slice(open + 2, close)) };
};

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "một giao dịch");
assert.ok(sql.indexOf("commit;") < sql.indexOf("notify pgrst, 'reload schema';"));
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/xa_vai_it_v2\.sql$/m, "không kèm --allow-destructive");
for (const [re, label] of [[/\bdrop\s+(table|schema|view|type|index|function|trigger|policy)\b/i, "DROP"], [/\btruncate\b/i, "TRUNCATE"], [/\bdelete\s+from\b/i, "DELETE"],
  [/\balter\s+table\b[^;]*\bdrop\b/i, "ALTER … DROP"]]) assert.ok(!re.test(topLevel), `không ${label} ở cấp cao nhất`);
// Chỉ một lệnh xoá trong thân hàm: nạp lại phiếu gỡ dòng 'scan' ở đợt khác của UID mà WMS trả cho phiếu này (một UID một đợt).
const deletes = [...sql.matchAll(/\bdelete\s+from\s+public\.(\w+)([^;]*);/gi)];
assert.equal(deletes.length, 1, "chỉ một lệnh xoá");
assert.equal(deletes[0][1], "xa_vai_it_uids");
assert.match(squash(deletes[0][2]), /^x where x\.source = 'scan' and x\.it_number <> v_it and x\.group_uid_code in \(select btrim\(u->>'groupUid'\) from jsonb_array_elements\(v_uids\) as t\(u\)\)$/);
const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem && /^select /i.test(kiem[1]) && !/\b(insert|update|delete|drop|alter|create|grant|revoke)\b/i.test(kiem[1]), "-- kiem: chỉ đọc");
for (const part of ["public.xa_vai_it_reports", "relrowsecurity", "column_name = 'status'", "column_name = 'source'", "not has_function_privilege('anon', 'public.xa_vai_it_set_status(text,text)'",
  "not has_function_privilege('anon', 'public._xa_vai_it_state(text,text)'"]) assert.ok(kiem[1].includes(part), `-- kiem có ${part}`);
assert.match(raw, /^-- Rút lui[^\n]*--allow-destructive/m);

// ---------- Cột, bảng ----------
for (const line of ["alter table public.xa_vai_it_batches add column if not exists status text not null default 'open';",
  "alter table public.xa_vai_it_uids add column if not exists source text not null default 'it';",
  "alter table public.xa_vai_it_uids add column if not exists added_device uuid references public.print_devices(id) on delete set null;"])
  assert.ok(sql.includes(line), line);
assert.ok(sql.includes("check (status in ('open', 'done'))") && sql.includes("check (source in ('it', 'scan'))"));
assert.ok(/if not exists \(select 1 from pg_constraint where conname = 'xa_vai_it_batches_status_check'\)/.test(sql), "constraint chạy lại được");
assert.match(sql, /create table if not exists public\.xa_vai_it_reports \(/);
assert.match(sql, /alter table public\.xa_vai_it_reports enable row level security;/);
assert.match(sql, /revoke all on table public\.xa_vai_it_reports from public, anon, authenticated;/);
assert.ok(!/create policy/i.test(sql) && !/grant [^;]*on table[^;]*to (anon|authenticated)/i.test(sql), "không policy, không grant bảng");

// ---------- Hàm: danh sách + quyền ----------
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created, ["_xa_vai_it_state", "xa_vai_it_check", "_xa_vai_it_attach_core", "_xa_vai_it_attach_body", "xa_vai_it_attach", "_xa_vai_it_report_body", "xa_vai_it_report",
  "xa_vai_it_set_status", "xa_vai_it_outside", "xa_vai_it_save", "_xa_vai_it_json", "xa_vai_it_list", "xa_vai_it_get", "_xa_vai_measure_save_body"]);
const grants = [...sql.matchAll(/^grant execute on function public\.(\w+)\(([^)]*)\) to ([^;]+);$/gm)].map(m => `${m[1]}(${m[2]}) → ${m[3]}`);
assert.deepEqual(grants, ["xa_vai_it_check(text) → anon, authenticated", "xa_vai_it_attach(text, text, text) → anon, authenticated", "xa_vai_it_report(text, text) → anon, authenticated",
  "xa_vai_it_set_status(text, text) → authenticated", "xa_vai_it_outside(integer) → anon, authenticated", "xa_vai_it_save(jsonb) → authenticated",
  "xa_vai_it_list(integer) → anon, authenticated", "xa_vai_it_get(text) → anon, authenticated"]);
for (const sig of ["_xa_vai_it_state(text, text)", "_xa_vai_it_attach_core(text, text, uuid)", "_xa_vai_it_attach_body(text, text, text)", "_xa_vai_it_report_body(text, text)", "_xa_vai_it_json(public.xa_vai_it_batches)",
  "_xa_vai_measure_save_body(text, text, numeric, boolean)"])
  assert.ok(sql.includes(`revoke all on function public.${sig} from public, anon, authenticated;`), `hàm nội bộ không cấp quyền: ${sig}`);
for (const name of created.filter(n => n !== "_xa_vai_it_state" && n !== "_xa_vai_it_json"))
  assert.match(fnBody(name).head, /security definer set search_path = '' as$/, `${name}: security definer + search_path rỗng`);

// ---------- Trạng thái ----------
const state = fnBody("_xa_vai_it_state").body;
for (const part of ["'state', 'in_batch'", "b.status = 'open' and exists (select 1 from jsonb_array_elements(b.lines) as l where l->>'sku' = p_sku)", "'state', 'same_sku'",
  "'state', 'other_sku'", "'state', 'free'"]) assert.ok(state.includes(part), `_xa_vai_it_state có ${part}`);
assert.ok(state.indexOf("in_batch") < state.indexOf("same_sku") && state.indexOf("same_sku") < state.indexOf("other_sku") && state.indexOf("other_sku") < state.indexOf("'free'"), "thứ tự xét");

// ---------- Ghi qua khoá máy xưởng ----------
for (const [pub, body, key] of [["xa_vai_it_attach", "_xa_vai_it_attach_body", "xa_vai_it_attach"], ["xa_vai_it_report", "_xa_vai_it_report_body", "xa_vai_it_report"]]) {
  const b = fnBody(pub).body;
  assert.ok(b.includes(`public.floor_access_check(p_access_token, '${key}')`) && b.includes("public.floor_access_denied()") && b.includes(`public.${body}(`), `${pub} qua floor_access_check`);
}
const core = fnBody("_xa_vai_it_attach_core").body;
for (const part of ["for update", "'BATCH_DONE'", "'SKU_NOT_IN_BATCH'", "'NOT_FOUND'", "'ALREADY_IN_BATCH'", "'scan'", "on conflict (it_number, group_uid_code) do nothing"])
  assert.ok(core.includes(part), `lõi gắn có ${part}`);
// Một UID một đợt: khoá theo Group UID TRƯỚC khi xét đợt hiện có và trước khoá dòng đợt.
const lockAt = core.indexOf("pg_advisory_xact_lock(hashtextextended('xa_vai_it_uid:' || p_code, 0))");
assert.ok(lockAt >= 0 && lockAt < core.indexOf("from public.xa_vai_it_uids x") && lockAt < core.indexOf("for update"), "khoá UID trước");
assert.ok(fnBody("_xa_vai_it_attach_body").body.includes("public._xa_vai_it_attach_core(v_code, v_it, public.print_device_by_token(p_access_token))"));
const report = fnBody("_xa_vai_it_report_body").body;
assert.ok(report.includes("v_state->>'state' <> 'other_sku'") && report.indexOf("<> 'other_sku'") < report.indexOf("insert into public.xa_vai_it_reports"), "chỉ ghi báo cáo khi máy chủ xét lại là other_sku");
assert.ok(report.includes("scan_count = least(r.scan_count, 1000000) + 1"));
const status = fnBody("xa_vai_it_set_status").body;
assert.ok(status.indexOf("public.print_admin_allowed()") < status.indexOf("update public.xa_vai_it_batches"), "đóng đợt: kiểm Admin trước");

// ---------- Hàm thay thế ----------
assert.ok(fnBody("xa_vai_it_save").body.includes("rfid = coalesce(excluded.rfid, x.rfid), source = 'it'"), "nạp lại thấy UID trong WMS → source it");
assert.ok(fnBody("xa_vai_it_save").body.includes("if not public.print_admin_allowed() then"), "save vẫn kiểm Admin");
const json = fnBody("_xa_vai_it_json").body;
for (const part of ["'batchStatus', p_batch.status", "count(*) filter (where x.source = 'scan') as scan_count", "'outsideCount', per.scan_count", "group by x.sku"]) assert.ok(json.includes(part), `json có ${part}`);
assert.ok(fnBody("xa_vai_it_list").body.includes("order by b.status = 'open' desc, b.loaded_at desc"), "đợt mở trước");
assert.ok(fnBody("xa_vai_it_get").body.includes("'source', x.source"));
// Lưu mét: bản xa_vai_a4_v1 + chặn OUTSIDE_BATCH đặt TRƯỚC khi chèn, chỉ UID chưa có dòng.
const a4 = fs.readFileSync(path.join(root, "supabase/xa_vai_a4_v1.sql"), "utf8").replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "");
const a4Start = a4.indexOf("create or replace function public._xa_vai_measure_save_body("), a4Body = squash(a4.slice(a4.indexOf("$$", a4Start) + 2, a4.indexOf("$$", a4.indexOf("$$", a4Start) + 2)));
const saveBody = fnBody("_xa_vai_measure_save_body").body;
const guardStart = saveBody.indexOf("if not exists (select 1 from public.xa_vai_measures m where m.group_uid_code = v_code) then");
const guardEnd = saveBody.indexOf("end if; end if; end if; ", guardStart) + "end if; end if; end if; ".length;
assert.ok(guardStart > 0 && guardEnd > guardStart, "có khối kiểm đợt");
const guard = saveBody.slice(guardStart, guardEnd);
for (const part of ["v_it_state->>'state' = 'other_sku'", "'OUTSIDE_BATCH'", "v_it_state->>'state' = 'same_sku'", "jsonb_array_length(v_it_state->'batches') > 1", "'NEED_BATCH'",
  "public._xa_vai_it_attach_core(v_code, v_it_state->'batches'->0->>'itNumber', public.print_device_by_token(p_access_token))", "<> 'ALREADY_IN_BATCH'"])
  assert.ok(guard.includes(part), `khối kiểm đợt có ${part}`);
const plain = (saveBody.slice(0, guardStart) + saveBody.slice(guardEnd)).replace(" v_it_state jsonb; v_attach jsonb;", "");
assert.equal(plain, a4Body, "phần còn lại giống hệt bản đang chạy (xa_vai_a4_v1)");
assert.ok(saveBody.indexOf("OUTSIDE_BATCH") < saveBody.indexOf("insert into public.xa_vai_measures") && saveBody.indexOf("NEED_BATCH") < saveBody.indexOf("insert into public.xa_vai_measures"), "kiểm đợt trước khi chèn");

console.log("xa_vai_it_v2_sql: cột + bảng báo cáo + RLS, 14 hàm đúng quyền, lõi gắn khoá theo UID (một UID một đợt), trạng thái UID, gắn / báo qua khoá máy, đóng đợt Admin, lưu mét = bản đang chạy + chặn OUTSIDE_BATCH đều đạt");
