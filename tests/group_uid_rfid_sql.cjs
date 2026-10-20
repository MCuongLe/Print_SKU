// RFID ↔ Group UID (supabase/group_uid_rfid_v1.sql, 20/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * cột group_rfid_mapping text ở group_uid_sync_staging + group_uid_details; index một phần (khác null), KHÔNG unique;
//   * staging.group_rfid_known boolean not null default false (Edge: dòng có khoá group_rfid_mapping; Extension cũ → false);
//   * preview (bản v6 trong group_uid_qc_status_v1.sql) + apply (bản v8) chép NGUYÊN VĂN: bỏ đúng các đoạn RFID thì phải trùng
//     bản gốc (so sau khi bỏ chú thích + gom khoảng trắng). Mọi so sánh RFID chỉ khi s.group_rfid_known: preview changed_fields
//     'group_rfid_mapping' + điều kiện ở nhánh updated (không ở stale_source); apply gu_touch + verify. Apply ghi
//     case when known then nguồn else giá trị đang có (left join details; dòng mới → null), on conflict ghi thẳng excluded
//     (KHÔNG coalesce: nguồn known null = WMS gỡ RFID → xoá theo), qc_status vẫn coalesce;
//   * group_uid_by_rfid(p_codes text[]): SECURITY DEFINER, search_path '', stable, upper(btrim), bỏ rỗng/trùng, tối đa 100 mã
//     (TOO_MANY), trả {rfid, groupUid, status}; revoke public rồi cấp anon + authenticated;
//   * uid_block_snapshot: chép nguyên bản uid_block_v1.sql, mỗi item thêm 'rfid' qua left join group_uid_details; giữ unchanged;
//   * chỉ thêm (không drop / truncate / alter … drop), begin/commit + notify pgrst.
// Thử đột biến: GROUP_UID_RFID_SQL=<tệp đã sửa> node tests/group_uid_rfid_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "supabase");
const file = process.env.GROUP_UID_RFID_SQL || path.join(root, "group_uid_rfid_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/group_uid_rfid_v1.sql");
const read = name => fs.readFileSync(name, "utf8").replace(/\r\n/g, "\n");
const noComments = text => text.replace(/--[^\n]*/g, "");
const code = noComments(read(file));
const qcBase = noComments(read(path.join(root, "group_uid_qc_status_v1.sql")));
const blockBase = noComments(read(path.join(root, "uid_block_v1.sql")));

assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm, không drop/truncate");

// Cột + index
for (const t of ["group_uid_sync_staging", "group_uid_details"]) {
  assert.match(code, new RegExp(`alter table public\\.${t} add column if not exists group_rfid_mapping text;`), `${t} thiếu cột group_rfid_mapping text`);
}
assert.match(code, /alter table public\.group_uid_sync_staging add column if not exists group_rfid_known boolean not null default false;/,
  "staging thiếu cột group_rfid_known boolean not null default false");
assert.doesNotMatch(code, /alter table public\.group_uid_details add column[^;]*group_rfid_known/, "group_rfid_known chỉ ở staging");
assert.match(code, /create index if not exists group_uid_details_rfid_idx on public\.group_uid_details \(group_rfid_mapping\) where group_rfid_mapping is not null;/,
  "thiếu index một phần group_uid_details_rfid_idx (khác null)");
assert.doesNotMatch(code, /create unique index|unique\s*\(\s*group_rfid_mapping|add constraint[^;]*group_rfid_mapping/i, "RFID không được ràng buộc duy nhất");

const squash = text => text.replace(/\s+/g, " ").replace(/\s*([(),=;|])\s*/g, "$1").trim();
const fnText = (text, name) => {
  const m = text.match(new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\)\\s*returns([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: m[1].replace(/\s+/g, " ").trim(), head: m[2], body: m[3], full: m[0] };
};
// Bỏ đúng từng đoạn RFID (đếm số lần) rồi so với bản gốc.
const stripRfid = (label, text, fragments) => {
  let out = squash(text);
  for (const [re, count, why] of fragments) {
    const hits = out.match(new RegExp(re.source, "g")) || [];
    assert.equal(hits.length, count, `${label}: ${why} (cần ${count}, có ${hits.length})`);
    out = out.replace(new RegExp(re.source, "g"), "");
  }
  return squash(out);
};

// Preview
const preview = fnText(code, "group_uid_sync_preview");
assert.equal(preview.params, "p_run_id uuid");
assert.match(preview.head, /security definer set search_path = ''/, "preview phải SECURITY DEFINER + search_path ''");
const previewStripped = stripRfid("preview", preview.full, [
  [/,case when s\.group_rfid_known and g\.group_rfid_mapping is distinct from s\.group_rfid_mapping then 'group_rfid_mapping' end/, 1, "changed_fields có 'group_rfid_mapping' chỉ khi known"],
  [/or\(s\.group_rfid_known and g\.group_rfid_mapping is distinct from s\.group_rfid_mapping\)(?=\))/, 1, "điều kiện RFID (chỉ khi known) chỉ ở nhánh updated — review A 20/10: KHÔNG ở stale_source (giữ held mãi)"],
]);
assert.equal(previewStripped, squash(fnText(qcBase, "group_uid_sync_preview").full), "preview phải chép nguyên văn bản v6 (group_uid_qc_status_v1.sql) ngoài phần RFID");
assert.doesNotMatch(preview.body, /s\.group_rfid_mapping is not null/, "preview: nguồn known null cũng là thay đổi (WMS gỡ RFID)");

// Apply
const apply = fnText(code, "group_uid_sync_apply");
assert.equal(apply.params, "p_run_id uuid");
assert.match(apply.head, /security definer set search_path = ''/, "apply phải SECURITY DEFINER + search_path ''");
const applySq = squash(apply.body);
assert.match(applySq, /qc_status=coalesce\(excluded\.qc_status,public\.group_uid_details\.qc_status\)/, "qc_status vẫn coalesce");
assert.match(applySq, /group_rfid_mapping=excluded\.group_rfid_mapping/, "on conflict ghi thẳng group_rfid_mapping");
assert.doesNotMatch(applySq, /coalesce\(excluded\.group_rfid_mapping/, "RFID không coalesce: nguồn null phải xoá theo");
const applyStripped = stripRfid("apply", apply.full, [
  [/\(s\.group_rfid_known and g\.group_rfid_mapping is distinct from s\.group_rfid_mapping\)or/, 2, "gu_touch và verify so group_rfid_mapping chỉ khi known"],
  [/,group_rfid_mapping(?=\))/, 1, "insert group_uid_details thêm cột group_rfid_mapping"],
  [/,case when s\.group_rfid_known then s\.group_rfid_mapping else g\.group_rfid_mapping end(?= from)/, 1, "insert: known → nguồn, không thì giá trị đang có"],
  [/left join public\.group_uid_details g using\(group_uid_code\)(?=where s\.run_id=p_run_id on conflict)/, 1, "insert left join details để lấy RFID đang có (dòng mới → null)"],
  [/,group_rfid_mapping=excluded\.group_rfid_mapping/, 1, "on conflict cập nhật group_rfid_mapping"],
]);
assert.equal(applyStripped, squash(fnText(qcBase, "group_uid_sync_apply").full), "apply phải chép nguyên văn bản v8 (group_uid_qc_status_v1.sql) ngoài phần RFID");

// Quyền preview/apply như bản gốc
for (const f of ["group_uid_sync_preview", "group_uid_sync_apply"]) {
  assert.match(code, new RegExp(`revoke all on function public\\.${f}\\(uuid\\) from public, anon, authenticated;`), `${f}: thu hồi khỏi public/anon/authenticated`);
  assert.match(code, new RegExp(`grant execute on function public\\.${f}\\(uuid\\) to service_role;`), `${f}: chỉ service_role`);
}

// group_uid_by_rfid
const byRfid = fnText(code, "group_uid_by_rfid");
assert.equal(byRfid.params, "p_codes text[]");
assert.match(byRfid.head, /jsonb/i, "group_uid_by_rfid trả jsonb");
assert.match(byRfid.head, /\bstable\b/i, "group_uid_by_rfid phải stable");
assert.match(byRfid.head, /security definer/i, "group_uid_by_rfid phải SECURITY DEFINER");
assert.match(byRfid.head, /set search_path = ''/, "group_uid_by_rfid phải search_path ''");
assert.doesNotMatch(byRfid.body, /\b(insert|update|delete|truncate)\b/i, "group_uid_by_rfid không được ghi");
assert.match(byRfid.body, /cardinality\(p_codes\) > 100\b/, "giới hạn 100 mã");
assert.match(byRfid.body, /'code','TOO_MANY'/, "quá 100 mã → TOO_MANY");
assert.match(byRfid.body, /upper\(btrim\(/, "chuẩn hoá upper(btrim())");
assert.match(byRfid.body, /distinct/, "bỏ mã trùng");
assert.match(byRfid.body, /from public\.group_uid_details g/, "tra trong group_uid_details");
assert.match(byRfid.body, /g\.group_rfid_mapping = any\(v_codes\)/, "so group_rfid_mapping với danh sách mã");
assert.match(squash(byRfid.body), /jsonb_build_object\('rfid',g\.group_rfid_mapping,'groupUid',g\.group_uid_code,'status',g\.status\)/, "mỗi dòng {rfid, groupUid, status}");
assert.match(squash(byRfid.body), /'ok',true,'data',jsonb_build_object\('rows',/, "trả {ok:true, data:{rows}}");
assert.match(squash(byRfid.body), /'meta',jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, "trả meta");
assert.match(code, /revoke all on function public\.group_uid_by_rfid\(text\[\]\) from public;/, "group_uid_by_rfid: revoke public");
assert.match(code, /grant execute on function public\.group_uid_by_rfid\(text\[\]\) to anon, authenticated;/, "group_uid_by_rfid: cấp anon + authenticated");
assert.ok(code.indexOf("revoke all on function public.group_uid_by_rfid") < code.indexOf("grant execute on function public.group_uid_by_rfid"), "revoke trước grant");

// uid_block_snapshot
const snap = fnText(code, "uid_block_snapshot");
assert.equal(snap.params, "p_known_list_id uuid default null", "giữ chữ ký uid_block_snapshot");
assert.match(snap.body, /'unchanged',true,'listId',v_list\.id/, "giữ nhánh unchanged");
const snapStripped = stripRfid("uid_block_snapshot", snap.full, [
  [/,'rfid',g\.group_rfid_mapping/, 1, "mỗi item phải có 'rfid'"],
  [/ left join public\.group_uid_details g on g\.group_uid_code=i\.group_uid_code/, 1, "left join group_uid_details theo group_uid_code"],
]);
assert.equal(snapStripped, squash(fnText(blockBase, "uid_block_snapshot").full), "uid_block_snapshot phải chép nguyên bản uid_block_v1.sql ngoài phần RFID");
assert.match(code, /revoke all on function public\.uid_block_snapshot\(uuid\) from public;/, "uid_block_snapshot: revoke public như cũ");
assert.match(code, /grant execute on function public\.uid_block_snapshot\(uuid\) to anon, authenticated;/, "uid_block_snapshot: anon + authenticated như cũ");

// Chỉ đụng 4 hàm, không cấp anon cho hàm ghi
const created = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]).sort();
assert.deepEqual(created, ["group_uid_by_rfid", "group_uid_sync_apply", "group_uid_sync_preview", "uid_block_snapshot"], "chỉ tạo/thay 4 hàm");
const anonFns = [...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map(m => m[1]).sort();
assert.deepEqual(anonFns, ["group_uid_by_rfid", "uid_block_snapshot"], "anon chỉ được hai hàm đọc");

console.log("group_uid_rfid_sql: cột 2 bảng + index một phần không unique, staging.group_rfid_known, preview/apply chép nguyên văn + RFID chỉ khi known (không coalesce, không known giữ cũ), group_uid_by_rfid ≤ 100 anon, uid_block_snapshot thêm rfid — passed");
