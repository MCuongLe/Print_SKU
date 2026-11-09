// Migration supabase/cut_group_uid_recut_v1.sql (09/11/2026, cắt lại Group UID đã cắt để retest).
// Không có Postgres cục bộ: kiểm tĩnh văn bản SQL.
//   * chỉ THÊM bảng cut_group_uid_recuts + hai hàm mới; không đổi hàm cũ, không xoá cấp cao nhất;
//   * hàm công khai kiểm khoá máy (floor_access_check nhãn 'cut_group_uid_recut') rồi gọi thân; thân khoá dòng, so p_cut_at
//     (RECUT_STALE), chặn queued, chép dòng cũ vào lịch sử TRƯỚC khi đặt lại cut_at / print_status / trạng thái ADJ;
//   * quyền: thân + bảng không mở cho anon / authenticated; hàm công khai revoke rồi grant anon, authenticated.
//   node tests/cut_group_uid_recut_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const raw = fs.readFileSync(path.join(root, "supabase/cut_group_uid_recut_v1.sql"), "utf8").replace(/\r\n/g, "\n");
const sql = raw.replace(/--[^\n]*/g, "");
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const squash = s => s.replace(/\s+/g, " ").trim();
const fnOf = name => {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `thiếu hàm ${name}`);
  const open = sql.indexOf("$$", start), close = sql.indexOf("$$", open + 2);
  return { head: squash(sql.slice(start, open)), body: squash(sql.slice(open + 2, close)) };
};

// ---------- Đầu tệp ----------
const header = [];
for (const line of raw.split("\n")) { const t = line.trim(); if (t.startsWith("--")) header.push(t); else if (t) break; }
assert.ok(header.some(l => /Vì sao/.test(l)) && header.some(l => /Tác động/.test(l)), "đầu tệp ghi Vì sao + Tác động");
const kiem = header.map(l => l.match(/^--\s*kiem\s*:\s*(\S.*?)\s*$/i)).filter(Boolean).map(m => m[1]);
assert.equal(kiem.length, 1, "một dòng -- kiem:");
assert.match(kiem[0], /^select\b/i);
assert.ok(!/;/.test(kiem[0]) && !/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(kiem[0]), "-- kiem: chỉ đọc");
assert.ok(/cut_group_uid_recuts/.test(kiem[0]) && /cut_group_uid_recut\(text,text,timestamptz\)/.test(kiem[0]) && /_cut_group_uid_recut_body/.test(kiem[0]), "-- kiem: bảng + hai hàm + quyền");
assert.ok(header.some(l => /^--\s*Rút lui/.test(l)), "có khối Rút lui");
assert.match(raw, /^-- Chạy: python scripts\/apply_supabase_sql\.py supabase\/cut_group_uid_recut_v1\.sql$/m, "lệnh chạy không kèm --allow-destructive");

// ---------- Khung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "begin; … commit;");
assert.ok(sql.indexOf("commit;") < sql.indexOf("notify pgrst, 'reload schema';"), "notify pgrst sau commit");
for (const [re, label] of [
  [/\bdrop\b/i, "DROP"], [/\btruncate\b/i, "TRUNCATE"], [/\bdelete\s+from\b/i, "DELETE FROM"], [/\bdo\s+\$/i, "khối DO"],
  [/\bexecute\s+(format|'|\$)/i, "EXECUTE động"], [/\balter\s+table\s+public\.cut_group_uids\b/i, "đổi bảng cut_group_uids"],
]) assert.ok(!re.test(topLevel), `không có ${label} ở cấp cao nhất`);
const created = [...sql.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]).sort();
assert.deepEqual(created, ["_cut_group_uid_recut_body", "cut_group_uid_recut"], "chỉ tạo hai hàm mới");

// ---------- Bảng lịch sử ----------
assert.match(squash(topLevel), /create table if not exists public\.cut_group_uid_recuts \( id bigint generated always as identity primary key, group_uid_code text not null, row_data jsonb not null, print_device_id uuid, recut_at timestamptz not null default now\(\) \);/);
assert.match(topLevel, /alter table public\.cut_group_uid_recuts enable row level security;/);
assert.match(topLevel, /revoke all on public\.cut_group_uid_recuts from public, anon, authenticated;/);
assert.ok(!/grant[^;]*on public\.cut_group_uid_recuts to (anon|authenticated|public)/i.test(topLevel), "bảng không grant cho client");

// ---------- Hàm công khai ----------
const pub = fnOf("cut_group_uid_recut");
assert.equal(pub.head, "create or replace function public.cut_group_uid_recut(p_access_token text, p_group_uid text, p_cut_at timestamptz) returns jsonb language plpgsql security definer set search_path = '' as");
assert.match(pub.body, /v_access := public\.floor_access_check\(p_access_token, 'cut_group_uid_recut'\); if v_access = 'deny' then return public\.floor_access_denied\(\); end if; return public\.floor_access_result\(v_access, public\._cut_group_uid_recut_body\(p_access_token, p_group_uid, p_cut_at\)\);/);

// ---------- Thân ----------
const body = fnOf("_cut_group_uid_recut_body");
assert.match(body.head, /security definer set search_path = ''/);
const b = body.body;
const at = (re, label) => { const m = b.match(re); assert.ok(m, `thân: ${label}`); return m.index; };
const iLock = at(/from public\.cut_group_uids c where c\.group_uid_code = v_code for update;/, "khoá dòng for update");
const iNotCut = at(/'code', 'NOT_CUT'/, "NOT_CUT khi chưa có dòng");
const iStale = at(/if p_cut_at is null or v_existing\.cut_at is distinct from p_cut_at then/, "so p_cut_at");
at(/'code', 'RECUT_STALE'/, "RECUT_STALE");
const iQueued = at(/if v_existing\.print_status = 'queued' then/, "chặn queued");
const iReady = at(/'code', 'GROUP_UID_NOT_READY'/, "thiếu dữ liệu nguồn");
const iHist = at(/insert into public\.cut_group_uid_recuts \(group_uid_code, row_data, print_device_id\) values \(v_existing\.group_uid_code, to_jsonb\(v_existing\), public\.print_device_by_token\(p_access_token\)\);/, "chép dòng cũ");
const iUpd = at(/update public\.cut_group_uids c set /, "đặt lại dòng");
assert.ok(iLock < iNotCut && iNotCut < iStale && iStale < iQueued && iQueued < iReady && iReady < iHist && iHist < iUpd, "thứ tự: khoá → chưa cắt → lệch giờ → queued → nguồn → lịch sử → cập nhật");
const upd = b.slice(iUpd, b.indexOf("returning c.* into v_row;", iUpd));
for (const part of ["print_status = 'pending'", "print_job_id = null", "cut_at = now()", "queued_at = null", "printed_at = null",
  "adj_exported_at = null", "adj_resolved_at = null", "adj_resolved_state = null", "updated_at = now()",
  "lot = left(v_source.lot, 20)", "roll = left(v_source.roll, 20)", "po = v_source.po"])
  assert.ok(upd.includes(part), `cập nhật có ${part}`);
assert.match(upd, /where c\.group_uid_code = v_code $/, "chỉ cập nhật đúng một UID");
assert.ok(/'previousCutAt', v_existing\.cut_at/.test(b) && /'recutCount'/.test(b) && /'skuInactive', v_source\.sku_inactive/.test(b), "trả previousCutAt, recutCount, skuInactive");

// ---------- Quyền ----------
assert.match(topLevel, /revoke all on function public\._cut_group_uid_recut_body\(text, text, timestamptz\) from public, anon, authenticated;/);
assert.match(topLevel, /revoke all on function public\.cut_group_uid_recut\(text, text, timestamptz\) from public, anon, authenticated;/);
assert.match(topLevel, /grant execute on function public\.cut_group_uid_recut\(text, text, timestamptz\) to anon, authenticated;/);
assert.ok(!/grant[^;]*_cut_group_uid_recut_body/i.test(topLevel), "không grant thân");

console.log("PASS cut_group_uid_recut_sql: bảng lịch sử + hàm công khai qua khoá máy + thân khoá dòng / RECUT_STALE / queued / lịch sử trước cập nhật + quyền");
