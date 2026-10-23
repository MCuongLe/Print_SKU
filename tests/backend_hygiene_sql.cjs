// Migration supabase/backend_hygiene_v1.sql (23/10/2026, đợt B vệ sinh backend, docs/plans/2026-10-23-dot-b-ve-sinh-backend.md).
// Không có Postgres cục bộ: kiểm tĩnh văn bản SQL — từng mục a–j của bản giao việc, không lệnh xoá ở cấp cao nhất,
// mọi hàm SECURITY DEFINER + search_path '', giữ chữ ký bản gốc và chỉ đổi số dòng tối thiểu so với bản gốc.
//   node tests/backend_hygiene_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const stripComments = s => s.replace(/--[^\n]*/g, "");
const raw = read("supabase/backend_hygiene_v1.sql");
const sql = stripComments(raw);
// Như scripts/apply_supabase_sql.py: bỏ thân $$…$$ rồi mới tìm lệnh xoá (delete trong thân hàm là định nghĩa, không chạy).
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");

// Một hàm: từ "create or replace function public.<tên>(" tới hết thân $$ … $$;
const fnOf = (text, name, label) => {
  const start = text.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `${label}: thiếu hàm ${name}`);
  const open = text.indexOf("$$", start);
  const close = text.indexOf("$$", open + 2);
  assert.ok(open > start && close > open, `${label}: không tách được thân ${name}`);
  return { head: text.slice(start, open), body: text.slice(open + 2, close), all: text.slice(start, close + 3) };
};
const squash = s => s.replace(/\s+/g, " ").trim();
const lines = s => s.split("\n").map(l => l.trim()).filter(Boolean);

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "chạy trong một giao dịch begin; … commit;");
assert.ok(/notify pgrst, 'reload schema';/.test(sql), "nạp lại schema PostgREST");
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/backend_hygiene_v1\.sql$/m, "tiêu đề ghi lệnh chạy không kèm --allow-destructive");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|database|view|type|index|function|trigger|policy)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b/i, "ALTER TABLE … DROP"],
]) assert.ok(!re.test(topLevel), `không có lệnh xoá ở cấp cao nhất (${label}) — không cần --allow-destructive`);

const ORIGINALS = {
  print_agent_claim: "supabase/print_sku_v3_v1.sql",
  print_jobs_purge: "supabase/print_jobs_admin_v1.sql",
  print_enqueue_unchecked: "supabase/print_name_from_db_v1.sql",
  _cut_group_uid_mark_queued_body: "supabase/floor_access_v1.sql",
  sync_history_purge: "supabase/sku_missing_archive_v1.sql",
  sku_archive_missing: "supabase/sku_missing_archive_v1.sql",
  sku_inactive_archive: "supabase/sku_inactive_v1.sql",
  group_uid_moves_lookup: "supabase/group_uid_moves_v2_lookup.sql",
  cut_group_uid_reconcile: "supabase/cut_group_uid_po_v1.sql",
  uid_temp_overview: "supabase/uid_temp_snapshot_v1.sql",
  wms_group_uid_cut_import: "supabase/cut_group_uid_v6_wms_reconcile.sql",
};
// Số dòng bản gốc được phép đổi (sửa tối thiểu); dòng thêm mới không tính.
const MAX_CHANGED = {
  print_agent_claim: 2, print_jobs_purge: 3, print_enqueue_unchecked: 2, _cut_group_uid_mark_queued_body: 0,
  sync_history_purge: 1, sku_archive_missing: 1, sku_inactive_archive: 1, group_uid_moves_lookup: 2,
  cut_group_uid_reconcile: 2, uid_temp_overview: 2, wms_group_uid_cut_import: 0,
};
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual([...created].sort(), [...Object.keys(ORIGINALS), "print_job_cancel"].sort(), "đúng các hàm của đợt (không thêm, không sót)");
assert.equal(new Set(created).size, created.length, "mỗi hàm một lần");

const fn = {};
for (const name of created) {
  fn[name] = fnOf(sql, name, "backend_hygiene_v1");
  assert.match(fn[name].head, /security definer set search_path\s*=\s*''/, `${name}: security definer + search_path ''`);
}
for (const [name, file] of Object.entries(ORIGINALS)) {
  const old = fnOf(stripComments(read(file)), name, file);
  assert.equal(squash(fn[name].head), squash(old.head), `${name}: giữ nguyên chữ ký, kiểu trả, security definer như ${file}`);
  const now = lines(fn[name].body);
  const missing = lines(old.body).filter(l => !now.includes(l));
  assert.ok(missing.length <= MAX_CHANGED[name], `${name}: đổi ${missing.length} dòng bản gốc (tối đa ${MAX_CHANGED[name]}):\n  ${missing.join("\n  ")}`);
}

// Quyền: create or replace giữ ACL cũ; chỉ hàm mới print_job_cancel được cấp (authenticated), không cấp gì cho anon.
assert.deepEqual([...sql.matchAll(/^\s*grant\b[^;]*;/gim)].map(m => squash(m[0])),
  ["grant execute on function public.print_job_cancel(uuid) to authenticated;"], "chỉ cấp quyền cho print_job_cancel");
assert.ok(!/\bto\s+(anon|public)\b/i.test(sql), "không cấp quyền cho anon / public");
assert.match(sql, /revoke all on function public\.print_job_cancel\(uuid\) from public, anon, authenticated;/);
assert.ok(sql.indexOf("revoke all on function public.print_job_cancel(uuid)") < sql.indexOf("grant execute on function public.print_job_cancel(uuid)"), "revoke trước rồi mới grant");

// ---------- (a) P2: hết lease ở sending/spooling giữ agent_id; purge đóng SENT_UNCONFIRMED ----------
{
  const b = fn.print_agent_claim.body;
  const expire = [...b.matchAll(/update public\.print_jobs set status='queued'[^;]*;/g)].map(m => m[0]);
  assert.equal(expire.length, 2, "claim: hai nhánh hết lease");
  const early = expire.find(s => /where status in \('claimed','rendering'\) and lease_expires_at<now\(\)/.test(s));
  const sent = expire.find(s => /where status in \('sending','spooling'\) and lease_expires_at<now\(\)/.test(s));
  assert.ok(early && /agent_id=null/.test(early) && /error_code='LEASE_EXPIRED'/.test(early), "claimed/rendering → queued, agent_id = null như cũ");
  assert.ok(sent && !/agent_id\s*=/.test(sent) && /lease_expires_at=null/.test(sent), "sending/spooling → queued, GIỮ agent_id");
  assert.ok(!/'claimed','rendering','sending','spooling'\) and lease_expires_at<now\(\)/.test(b), "không còn nhánh hết lease gộp bốn trạng thái");
  assert.match(b, /select \* into v_job from public\.print_jobs where status='queued' and \(agent_id is null or agent_id=p_agent_id\) and \(/, "chỉ nhận lệnh chưa gắn agent hoặc gắn chính agent này");
  assert.ok(b.indexOf("('sending','spooling')") < b.indexOf("select * into v_job"), "trả lệnh hết lease trước khi chọn lệnh");

  const p = fn.print_jobs_purge.body;
  const close = p.match(/update public\.print_jobs\s+set status = 'failed'[\s\S]*?returning[^)]*\)/);
  assert.ok(close, "purge: đóng lệnh queued còn agent_id");
  assert.match(close[0], /error_code = 'SENT_UNCONFIRMED'/);
  assert.match(close[0], /where status = 'queued' and agent_id is not null and updated_at < now\(\) - interval '30 minutes'/);
  assert.match(p, /insert into public\.print_events\(job_id, agent_id, event_type, details\)[\s\S]*?'failed'[\s\S]*?SENT_UNCONFIRMED/, "ghi print_events cho lệnh bị đóng");
  assert.ok(p.indexOf("SENT_UNCONFIRMED") < p.indexOf("'skipped', true"), "chạy cả khi lượt dọn 3 ngày bị bỏ qua");
  assert.match(p, /'skipped', true, 'lastRunAt', v_last, 'sentUnconfirmed', v_unconfirmed/);
  assert.match(p, /delete from public\.print_jobs\s+where status in \('completed', 'failed', 'cancelled'\) and created_at < v_cutoff/, "vẫn chỉ xoá lệnh đã kết thúc");
}

// ---------- (b) Q2: quyền mặc định schema public + sequence ----------
for (const re of [
  /alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;/,
  /alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;/,
  /alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;/,
  /revoke all on all sequences in schema public from anon, authenticated;/,
]) assert.match(sql, re);
assert.ok(!/service_role/.test(topLevel.replace(/grant[^;]*;/g, "")), "không thu hồi gì của service_role");
assert.ok(!/revoke[^;]*on all (tables|functions)/i.test(sql), "không thu hồi hàng loạt bảng / hàm đang có (chỉ sequence)");

// ---------- (c) print_enqueue_unchecked: phiên bản tem, 1–100 dòng, tổng copies, btrim SKU ngừng ----------
{
  const b = fn.print_enqueue_unchecked.body;
  const guard = b.indexOf("if p_type in ('sku','group_uid') then");
  assert.ok(guard >= 0 && guard < b.indexOf("if p_type = 'sku' then"), "kiểm sku/group_uid ngay sau kiểm chung, trước chặn SKU ngừng");
  assert.match(b, /v_tv := greatest\(coalesce\(p_template_version,1\),1\);/, "phiên bản tem tính như lúc insert");
  assert.match(b, /\(p_type = 'sku' and v_tv not in \(1,2,3\)\) or \(p_type = 'group_uid' and v_tv <> 1\)/);
  assert.match(b, /jsonb_array_elements\(public\.print_job_items\(p_type, p_payload, p_copies\)\)/, "đếm dòng như print_job_items (dạng đơn = 1 dòng)");
  assert.match(b, /jsonb_typeof\(p_payload\) is distinct from 'object' or v_count not between 1 and 100/, "1–100 dòng, payload phải là object");
  assert.match(b, /when jsonb_typeof\(t\.v->'copies'\) is null or jsonb_typeof\(t\.v->'copies'\) = 'null' then 1/, "dòng thiếu copies tính là 1 (như agent)");
  assert.match(b, /x\.copies is null or x\.copies not between 1 and 500/, "copies từng dòng 1–500");
  assert.match(b, /if v_sum <> p_copies then/, "tổng copies từng dòng = p_copies");
  assert.match(b, /select btrim\(it\.v->>'sku'\) as sku from jsonb_array_elements\(public\.print_job_items\('sku', p_payload, p_copies\)\)/, "chặn SKU ngừng so sau btrim");
  assert.ok(b.indexOf("v_sum <> p_copies") < b.indexOf("insert into public.print_jobs"), "kiểm trước khi ghi lệnh");
  assert.ok(b.includes("if p_type = 'location' then") && b.includes("'Mỗi lệnh in từ 1 đến 100 vị trí'"), "nhánh location giữ nguyên");
}

// ---------- (d) mark_queued: p_job_id phải là lệnh group_uid có thật ----------
{
  const b = fn._cut_group_uid_mark_queued_body.body;
  assert.match(b, /if not exists \(select 1 from public\.print_jobs j where j\.id=p_job_id and j\.type='group_uid'\) then/);
  assert.ok(b.indexOf("j.type='group_uid'") < b.indexOf("update public.cut_group_uids"), "kiểm trước khi đặt queued");
}

// ---------- (e) sync_history_purge: lượt SKU kẹt applying > 1 giờ ----------
{
  const b = fn.sync_history_purge.body;
  const stuck = b.match(/update public\.sku_sync_runs\s+set status = 'failed'[^;]*where status = 'applying'[^;]*;/);
  assert.ok(stuck, "đóng lượt SKU kẹt applying");
  assert.match(stuck[0], /coalesce\(applied_at, created_at\) < v_now - interval '1 hour'/);
  assert.match(stuck[0], /staged_skus = '\[\]'::jsonb, staged_combo_links = '\[\]'::jsonb, staged_missing_skus = null, payload_purged_at = v_now/, "dọn payload như nhánh failed");
  assert.match(stuck[0], /error_message = coalesce\(error_message, '[^']+'\)/);
  assert.match(b, /'stuckApplying', n_sku_stuck/, "báo số lượt đã đóng");
}

// ---------- (f) wms_group_uid_cut_import: chặn data_until ở tương lai ----------
{
  const b = fn.wms_group_uid_cut_import.body;
  assert.match(b, /if p_data_until > now\(\) \+ interval '5 minutes' then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','INVALID_FILE'/);
  assert.ok(b.indexOf("interval '5 minutes'") < b.indexOf("insert into public.wms_group_uid_history_imports"), "từ chối trước khi ghi");
}

// ---------- (g) index FK uid_block_scans(device_id) ----------
assert.match(sql, /create index if not exists uid_block_scans_device_idx on public\.uid_block_scans\(device_id\);/);

// ---------- (h) C1: giữ SKU còn UID Blocked hoặc là thành phần UID còn sống ----------
const LIVE = "('Available','New','Processing','Blocked')";
for (const [name, col] of [["sku_archive_missing", "v_sku"], ["sku_inactive_archive", "s.sku"]]) {
  const b = fn[name].body;
  assert.ok(b.includes(`g.sku = ${col} and g.status in ${LIVE}`), `${name}: UID Blocked cũng giữ SKU`);
  assert.ok(b.includes(`exists (select 1 from public.group_uid_products p join public.group_uid_details d on d.group_uid_code = p.group_uid_code where p.sku = ${col} and d.status in ${LIVE})`), `${name}: SKU thành phần của UID còn sống`);
  assert.ok(!b.includes("('Available','New','Processing')"), `${name}: không còn tập trạng thái cũ`);
}

// ---------- (i) C2: che email cho người không phải Admin ----------
for (const [name, field] of [["group_uid_moves_lookup", "q.moved_by"], ["cut_group_uid_reconcile", "w.cut_by"], ["uid_temp_overview", "r.created_by"]]) {
  const b = fn[name].body;
  assert.match(b, /v_admin boolean := public\.group_uid_admin_allowed\(\);/, `${name}: kiểm Admin một lần`);
  assert.ok(b.includes(`case when v_admin then ${field} else split_part(${field},'@',1) end`), `${name}: anon chỉ nhận phần trước @`);
}
assert.ok(!/'by',q\.moved_by,/.test(fn.group_uid_moves_lookup.body) && !/'by',w\.cut_by\)/.test(fn.cut_group_uid_reconcile.body), "không còn trả email thô");
assert.ok(!/'createdBy',coalesce\(r\.created_by,''\)/.test(fn.uid_temp_overview.body), "UID tạm không còn trả email thô");
assert.ok(!/create or replace function public\.uid_temp_snapshot\(/.test(sql), "uid_temp_snapshot gọi uid_temp_overview nên không cần thay");
assert.match(read("supabase/snapshot_cache_v1.sql"), /return jsonb_set\(public\.uid_temp_overview\(\), '\{data,unchanged\}'/, "uid_temp_snapshot vẫn lấy dữ liệu từ uid_temp_overview");

// ---------- (j) C3: print_job_cancel chỉ Admin, chỉ lệnh queued ----------
{
  const f = fn.print_job_cancel;
  assert.match(squash(f.head), /^create or replace function public\.print_job_cancel\(p_job_id uuid\) returns jsonb language plpgsql volatile security definer set search_path = '' as$/);
  const b = f.body;
  assert.match(b, /^\s*declare[\s\S]*?begin\s+if not public\.print_admin_allowed\(\) then\s+return jsonb_build_object\('ok', false, 'error', jsonb_build_object\('code', 'FORBIDDEN'/, "kiểm Admin đầu tiên");
  const upd = b.match(/update public\.print_jobs\s+set status = 'cancelled'[^;]*;/);
  assert.ok(upd, "đặt cancelled");
  assert.match(upd[0], /where id = p_job_id and status = 'queued'/, "chỉ lệnh đang chờ");
  assert.match(upd[0], /completed_at = now\(\)/);
  assert.match(upd[0], /updated_at = now\(\)/);
  assert.match(b, /'code', 'NOT_FOUND'/);
  assert.match(b, /'code', 'NOT_QUEUED'/);
  assert.match(b, /insert into public\.print_events\(job_id, agent_id, event_type, details\)[\s\S]*?'cancelled'/, "ghi print_events");
  assert.match(b, /'userId', \(select auth\.uid\(\)\)/);
  assert.match(b, /return jsonb_build_object\('ok', true, 'data', jsonb_build_object\('id', v_job\.id, 'status', v_job\.status\)\)/);
}

console.log("backend_hygiene_sql: a P2 claim/purge, b quyền mặc định + sequence, c enqueue 1–100 dòng + tổng copies + phiên bản + btrim, d mark_queued, e applying > 1 giờ, f data_until tương lai, g index, h Blocked + thành phần, i che email, j print_job_cancel; không lệnh xoá, definer + search_path '' passed");
