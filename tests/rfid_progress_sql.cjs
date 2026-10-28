// Migration supabase/rfid_progress_v1.sql (28/10/2026): LỊCH SỬ GROUP UID · tiến độ dán mã RFID A5000 theo bin (MTG, GARMENT).
// Không có Postgres cục bộ: kiểm tĩnh văn bản SQL (kết quả thật đã đối chiếu bằng SELECT chỉ đọc trên Supabase ngày 28/10/2026).
//   * đầu tệp có `-- kiem:` (một câu SELECT chỉ đọc) và khối `-- Rút lui`; begin/commit + notify pgrst; không lệnh xoá ở cấp cao nhất;
//   * đúng một hàm group_uid_rfid_progress(), SECURITY DEFINER + search_path '', chỉ đọc (stable, không insert/update/delete);
//   * chỉ đọc group_uid_details + group_uid_sync_state; không trả mã UID / SKU / người cập nhật;
//   * luật tính: UID tồn Available/Blocked/Editing, bin = vị trí <tầng>-KHO-<dãy kệ>-…, done = A5000 + 7 số, other = RFID khác;
//   * quyền: anon + authenticated thực thi, không public.
//   node tests/rfid_progress_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const FILE = "supabase/rfid_progress_v1.sql";
assert.ok(fs.existsSync(path.join(root, FILE)), `chưa có migration tiến độ RFID (${FILE})`);
const raw = fs.readFileSync(path.join(root, FILE), "utf8").replace(/\r\n/g, "\n");
const stripComments = s => s.replace(/--[^\n]*/g, "");
const sql = stripComments(raw);
const topLevel = sql.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const SIG = "public.group_uid_rfid_progress()";

// ---------- Đầu tệp: -- kiem: + Rút lui (như scripts/release.py parse_header) ----------
const header = [];
for (const line of raw.split("\n")) { const t = line.trim(); if (t.startsWith("--")) header.push(t); else if (t) break; }
const kiem = header.map(l => l.match(/^--\s*kiem\s*:\s*(\S.*?)\s*$/i)).filter(Boolean).map(m => m[1]);
assert.equal(kiem.length, 1, "đầu tệp có đúng một dòng -- kiem:");
assert.match(kiem[0], /^select\b/i, "-- kiem: là một câu SELECT");
assert.doesNotMatch(kiem[0], /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i, "-- kiem: không có từ khoá ghi (live_status.select_only)");
assert.ok(!kiem[0].replace(/;\s*$/, "").includes(";"), "-- kiem: chỉ một câu");
for (const want of ["to_regprocedure('public.group_uid_rfid_progress()')", "has_function_privilege('anon'", "has_function_privilege('authenticated'", "not has_function_privilege('public'", "group_uid_details", "to_regprocedure('public.group_uid_rfid_bin_uids(text,text[])')"]) assert.ok(kiem[0].includes(want), `-- kiem: kiểm ${want}`);
const back = header.findIndex(l => /^--\s*r[uú]t\s+lui\b/i.test(l));
assert.ok(back >= 0, "đầu tệp có khối -- Rút lui");
assert.match(header[back + 1] || "", /^--(?: {2,}|\t)\s*\S/, "khối Rút lui có dòng lệnh thụt vào");
assert.match(raw, /^-- Lệnh: python scripts\/apply_supabase_sql\.py supabase\/rfid_progress_v1\.sql$/m, "ghi lệnh chạy, không cần --allow-destructive");

// ---------- Chung ----------
assert.ok(/^begin;$/m.test(sql) && /^commit;$/m.test(sql), "chạy trong begin; … commit;");
assert.match(sql, /notify pgrst,\s*'reload schema';/, "nạp lại schema PostgREST");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|view|type|index|function|trigger|policy|column)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
  [/\balter\s+table\b/i, "ALTER TABLE"],
  [/\bcreate\s+(table|index)\b/i, "CREATE TABLE / INDEX"],
]) assert.ok(!re.test(topLevel), `không đổi bảng, không lệnh xoá ở cấp cao nhất (${label})`);

// ---------- Hai hàm, đều chỉ đọc ----------
const created = [...sql.matchAll(/create or replace function (public\.\w+)\(/g)].map(m => m[1]);
assert.deepEqual(created, ["public.group_uid_rfid_progress", "public.group_uid_rfid_bin_uids"], "chỉ tạo group_uid_rfid_progress và group_uid_rfid_bin_uids");
const fn = name => {
  const start = sql.indexOf(`create or replace function public.${name}(`), open = sql.indexOf("$$", start), close = sql.indexOf("$$", open + 2);
  assert.ok(start >= 0 && open > start && close > open, `tách được thân hàm ${name}`);
  return { head: sql.slice(start, open), body: sql.slice(open + 2, close) };
};
const { head, body } = fn("group_uid_rfid_progress"), bin = fn("group_uid_rfid_bin_uids");
for (const [name, f] of [["group_uid_rfid_progress", { head, body }], ["group_uid_rfid_bin_uids", bin]]) {
  assert.match(f.head.replace(/\s+/g, " "), /returns jsonb language plpgsql stable security definer set search_path = ''/, `${name}: stable + security definer + search_path ''`);
  assert.ok(!/\b(insert|update|delete|truncate)\b/i.test(f.body), `${name}: thân hàm chỉ đọc (không insert / update / delete)`);
  const tables = [...f.body.matchAll(/\bpublic\.(\w+)/g)].map(m => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), name === "group_uid_rfid_progress" ? ["group_uid_details", "group_uid_sync_state"] : ["group_uid_details"], `${name}: chỉ đọc đúng bảng cần`);
}

// ---------- Luật tính ----------
assert.ok(body.includes("'WH - MATERIAL - MTG'") && body.includes("'WH - MATERIAL - GARMENT'"), "hai kho MTG và GARMENT (kho Material)");
assert.ok(/'MTG'/.test(body) && /'GARMENT'/.test(body), "nhãn kho MTG / GARMENT");
assert.ok(body.includes("d.status in ('Available', 'Blocked', 'Editing') and d.qty > 0"), "UID tồn = Available / Blocked / Editing và qty > 0 (cuộn hết vải không tính)");
assert.ok(body.includes("split_part(d.location, '-', 2) = 'KHO'") && body.includes("split_part(d.location, '-', 3) <> ''"), "chỉ bin trên kệ: <tầng>-KHO-<dãy kệ>-…");
assert.ok(body.includes("split_part(d.location, '-', 3) as rack"), "dãy kệ = đoạn thứ 3 của mã vị trí");
assert.ok(body.includes("group_rfid_mapping ~ '^A5000[0-9]{7}$'"), "done = đúng dạng A5000 + 7 số (12 ký tự)");
assert.ok(body.includes("btrim(coalesce(d.group_rfid_mapping, '')) <> ''") && body.includes("d.group_rfid_mapping !~ '^A5000[0-9]{7}$'"), "other = có RFID nhưng không phải A5000");
assert.ok(/group by b\.warehouse, b\.rack, b\.location/.test(body), "đếm theo từng bin (cả mã vị trí)");
assert.ok(body.includes("order by r.rack_no nulls last, r.rack"), "dãy kệ xếp số tăng dần rồi dãy chữ");
assert.ok(body.includes("order by s.location"), "bin xếp theo mã vị trí");
assert.ok(body.includes("left join per_wh p on p.warehouse = w.name"), "luôn trả đủ hai kho, kho rỗng racks = []");
assert.ok(body.includes("coalesce(p.racks, '[]'::jsonb)"), "kho chưa có UID trả racks rỗng");

// ---------- Dạng trả về: không lộ mã UID / SKU / người ----------
for (const key of ["'prefix', 'A5000'", "'otherPrefixes'", "'syncedAt'", "'fullAt'", "'warehouses'", "'racks'", "'bins'", "'location'", "'total'", "'done'", "'other'", "'schemaVersion', 1"]) assert.ok(body.includes(key), `trả khoá ${key}`);
for (const bad of ["group_uid_code", "d.sku", "updated_by", "batch_code", "roll_code", "d.product", "purchase_order", "qc_status"]) assert.ok(!body.includes(bad), `không đụng cột ${bad} (chỉ số đếm theo bin)`);
assert.ok(body.includes("greatest(s.last_successful_incremental_at, s.last_successful_full_at)"), "syncedAt = lần đồng bộ thành công gần nhất");

// ---------- Quyền: anon + authenticated thực thi, không public ----------
assert.ok(topLevel.includes(`revoke all on function ${SIG} from public, anon, authenticated;`), "gỡ quyền mặc định rồi cấp lại rõ ràng");
assert.ok(topLevel.includes(`grant execute on function ${SIG} to anon, authenticated;`), "cấp đúng anon + authenticated (hàm chỉ đọc, số đếm)");
assert.ok(!/grant\s+execute\s+on\s+function\s+\S+\s+to\s+[^;]*\bpublic\b/i.test(topLevel), "không cấp cho public");

// ---------- group_uid_rfid_bin_uids: pop-up UID chưa dán A5000 của một bin ----------
{
  const b = bin.body, sig2 = "public.group_uid_rfid_bin_uids(text, text[])";
  assert.match(bin.head.replace(/\s+/g, " "), /group_uid_rfid_bin_uids\(p_warehouse text, p_locations text\[\]\)/, "chữ ký (kho, danh sách bin)");
  assert.ok(b.includes("when 'MTG' then 'WH - MATERIAL - MTG' when 'GARMENT' then 'WH - MATERIAL - GARMENT' else null"), "kho chỉ MTG / GARMENT");
  assert.ok(b.includes("cardinality(v_locs) < 1 or cardinality(v_locs) > 20") && b.includes("'INVALID_INPUT'"), "1–20 bin, sai thì INVALID_INPUT");
  assert.ok(b.includes("d.status in ('Available', 'Blocked', 'Editing') and d.qty > 0") && b.includes("split_part(d.location, '-', 2) = 'KHO'") && b.includes("split_part(d.location, '-', 3) <> ''"), "cùng phạm vi với tiến độ");
  assert.ok(b.includes("d.location = any(v_locs)"), "chỉ các bin được hỏi");
  assert.ok(b.includes("coalesce(d.group_rfid_mapping ~ '^A5000[0-9]{7}$', false) as is_done") && b.includes("where not s.is_done"), "chỉ UID chưa có A5000 (RFID rỗng không tính xong)");
  assert.ok(b.includes("order by (o.rfid is not null), o.location, o.group_uid_code limit v_limit"), "chưa dán trước, mã cũ sau; giới hạn dòng");
  assert.ok(b.includes("v_limit constant integer := 500") && b.includes("'truncated', v_open > v_limit"), "tối đa 500 dòng, báo còn nữa");
  assert.ok(b.includes("case when p.rfid is null then 'none' else 'old' end"), "state none (chưa dán) / old (mã cũ)");
  for (const key of ["'groupUid'", "'location'", "'sku'", "'lot'", "'roll'", "'qty'", "'status'", "'rfid'", "'state'", "'updatedAt'", "'total'", "'done'", "'open'", "'items'", "'truncated'", "'schemaVersion', 1"]) assert.ok(b.includes(key), `trả khoá ${key}`);
  for (const bad of ["updated_by", "purchase_order", "qc_status"]) assert.ok(!b.includes(bad), `không trả ${bad} (email / PO không lộ cho người ngoài Admin)`);
  assert.ok(topLevel.includes(`revoke all on function ${sig2} from public, anon, authenticated;`), "gỡ quyền mặc định rồi cấp lại rõ ràng");
  assert.ok(topLevel.includes(`grant execute on function ${sig2} to anon, authenticated;`), "cấp đúng anon + authenticated");
}

console.log("rfid_progress_sql: hai hàm chỉ đọc (tiến độ theo bin MTG/GARMENT không lộ UID; UID chưa dán của bin không trả email), quyền anon + authenticated, begin/commit + Rút lui passed");
