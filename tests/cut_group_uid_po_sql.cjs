// CẮT GROUP UID lọc theo PO (supabase/cut_group_uid_po_v1.sql, 21/10/2026, docs/plans/2026-10-21-cat-uid-loc-po.md).
// Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * cột purchase_order text ở group_uid_sync_staging + group_uid_details, staging.purchase_order_known boolean not null
//     default false (Edge: dòng có khoá purchase_order đúng dạng; Extension cũ → false); index một phần (khác null), KHÔNG
//     unique / check; cut_group_uids.po text + index một phần (po, cut_at desc) where po is not null;
//   * preview/apply = bản group_uid_rfid_v1.sql chép NGUYÊN VĂN ngoài phần PO: so/ghi purchase_order chỉ khi
//     s.purchase_order_known (preview changed_fields + nhánh updated, KHÔNG ở stale_source; apply gu_touch + verify + insert
//     case when known … else giá trị đang có, on conflict ghi thẳng excluded, không coalesce);
//   * _cut_group_uid_scan_body / _cut_sample_confirm_body = bản floor_access_v1.sql + ghi po (từ group_uid_details / từ phiên
//     cut_sample_sessions.po); không cấp quyền; hàm công khai bọc floor_access_check không đụng;
//   * cut_group_uid_search (bản cut_group_uid_v5_adj_export.sql) / cut_group_uid_reconcile (bản group_uid_qc_status_v1.sql):
//     drop chữ ký cũ trước khi tạo, thêm p_po text default '' cuối, lọc khớp đúng coalesce(c.po, details.purchase_order) =
//     btrim(p_po), trả 'po' mỗi dòng + 'filterPo'; ngoài phần PO chép nguyên văn; quyền anon + authenticated trên chữ ký mới;
//   * begin/commit + notify pgrst; drop chỉ hai chữ ký cũ, không truncate / delete / alter … drop.
// Thử đột biến: CUT_GROUP_UID_PO_SQL=<tệp đã sửa> node tests/cut_group_uid_po_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "supabase");
const file = process.env.CUT_GROUP_UID_PO_SQL || path.join(root, "cut_group_uid_po_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/cut_group_uid_po_v1.sql");
const read = name => fs.readFileSync(name, "utf8").replace(/\r\n/g, "\n");
const noComments = text => text.replace(/--[^\n]*/g, "");
const code = noComments(read(file));
const rfidBase = noComments(read(path.join(root, "group_uid_rfid_v1.sql")));
const floorBase = noComments(read(path.join(root, "floor_access_v1.sql")));
const searchBase = noComments(read(path.join(root, "cut_group_uid_v5_adj_export.sql")));
const qcBase = noComments(read(path.join(root, "group_uid_qc_status_v1.sql")));

// ---------- Khung migration ----------
assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
const topLevel = code.replace(/\$\$[\s\S]*?\$\$/g, " ");
const drops = [...topLevel.matchAll(/\bdrop\b[^;]*;/gi)].map(m => m[0].replace(/\s+/g, " ").trim()).sort();
assert.deepEqual(drops, [
  "drop function if exists public.cut_group_uid_reconcile(text,text,text,date,date,integer);",
  "drop function if exists public.cut_group_uid_search(text,text,text,date,date,text,integer);",
], "chỉ được drop đúng hai chữ ký cũ (search v5, reconcile qc_status_v1)");
assert.doesNotMatch(topLevel, /\btruncate\b|\bdelete\s+from\b|alter\s+table[^;]*\bdrop\b/i, "không truncate / delete / alter … drop");

// ---------- Cột + index ----------
for (const t of ["group_uid_sync_staging", "group_uid_details"]) {
  assert.match(code, new RegExp(`alter table public\\.${t} add column if not exists purchase_order text;`), `${t} thiếu cột purchase_order text`);
}
assert.match(code, /alter table public\.group_uid_sync_staging add column if not exists purchase_order_known boolean not null default false;/,
  "staging thiếu cột purchase_order_known boolean not null default false");
assert.doesNotMatch(code, /alter table public\.group_uid_details add column[^;]*purchase_order_known/, "purchase_order_known chỉ ở staging");
// Không index PO (review 21/10: lọc coalesce(c.po, d.purchase_order) qua left join không dùng được index; RULES 10/10 dọn index thừa).
assert.doesNotMatch(code, /create index[^;]*\b(purchase_order|po)\b[^;]*;/i, "không tạo index PO");
assert.match(code, /alter table public\.cut_group_uids add column if not exists po text;/, "cut_group_uids thiếu cột po text");
assert.doesNotMatch(topLevel, /create unique index|unique\s*\(\s*(purchase_order|po)\b|add constraint|\bcheck\s*\(/i, "PO không ràng buộc duy nhất / check (dữ liệu WMS lạ không được làm hỏng lượt đồng bộ)");

// ---------- Tách hàm ----------
const squash = text => text.replace(/\s+/g, " ").replace(/\s*([(),=;|])\s*/g, "$1").trim();
const fnText = (text, name) => {
  const re = new RegExp(`create or replace function public\\.${name}\\(([\\s\\S]*?)\\)\\s*returns([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$;`, "g");
  const all = [...text.matchAll(re)];
  assert.equal(all.length, 1, `cần đúng 1 định nghĩa ${name}, thấy ${all.length}`);
  const m = all[0];
  return { params: m[1].replace(/\s+/g, " ").trim(), head: m[2], body: m[3], full: m[0] };
};
// Bỏ (hoặc thay) đúng từng đoạn PO, đếm số lần, rồi so với bản gốc.
const stripPo = (label, text, fragments) => {
  let out = squash(text);
  for (const [re, count, why, replacement = ""] of fragments) {
    const hits = out.match(new RegExp(re.source, "g")) || [];
    assert.equal(hits.length, count, `${label}: ${why} (cần ${count}, có ${hits.length})`);
    out = out.replace(new RegExp(re.source, "g"), replacement);
  }
  return squash(out);
};
const definer = (fn, label) => {
  assert.match(fn.head, /security definer/i, `${label} phải SECURITY DEFINER`);
  assert.match(fn.head, /set search_path\s*=\s*''/, `${label} phải search_path ''`);
};

// ---------- Preview ----------
const preview = fnText(code, "group_uid_sync_preview");
assert.equal(preview.params, "p_run_id uuid");
definer(preview, "preview");
const previewStripped = stripPo("preview", preview.full, [
  [/,case when s\.purchase_order_known and g\.purchase_order is distinct from s\.purchase_order then 'purchase_order' end/, 1, "changed_fields có 'purchase_order' chỉ khi known"],
  [/or\(s\.purchase_order_known and g\.purchase_order is distinct from s\.purchase_order\)(?=\))/, 1, "điều kiện PO (chỉ khi known) chỉ ở nhánh updated — không ở stale_source (giữ held mãi, bài học RFID 20/10)"],
]);
assert.equal(previewStripped, squash(fnText(rfidBase, "group_uid_sync_preview").full), "preview phải chép nguyên văn bản group_uid_rfid_v1.sql ngoài phần PO");
const staleBranch = squash(preview.body).split("'stale_source'")[1].split(";")[0];
assert.doesNotMatch(staleBranch, /purchase_order/, "nhánh stale_source không được so PO");
assert.doesNotMatch(preview.body, /s\.purchase_order is not null/, "preview: nguồn known null cũng là thay đổi (UID không theo PO)");

// ---------- Apply ----------
const apply = fnText(code, "group_uid_sync_apply");
assert.equal(apply.params, "p_run_id uuid");
definer(apply, "apply");
const applySq = squash(apply.body);
assert.match(applySq, /purchase_order=excluded\.purchase_order/, "on conflict ghi thẳng purchase_order");
assert.doesNotMatch(applySq, /coalesce\(excluded\.purchase_order/, "PO không coalesce: nguồn known null phải ghi null");
const applyStripped = stripPo("apply", apply.full, [
  [/\(s\.purchase_order_known and g\.purchase_order is distinct from s\.purchase_order\)or/, 2, "gu_touch và verify so purchase_order chỉ khi known"],
  [/,purchase_order(?=\))/, 1, "insert group_uid_details thêm cột purchase_order"],
  [/,case when s\.purchase_order_known then s\.purchase_order else g\.purchase_order end(?= from)/, 1, "insert: known → nguồn, không thì giá trị đang có"],
  [/,purchase_order=excluded\.purchase_order/, 1, "on conflict cập nhật purchase_order"],
]);
assert.equal(applyStripped, squash(fnText(rfidBase, "group_uid_sync_apply").full), "apply phải chép nguyên văn bản group_uid_rfid_v1.sql ngoài phần PO");
for (const f of ["group_uid_sync_preview", "group_uid_sync_apply"]) {
  assert.match(code, new RegExp(`revoke all on function public\\.${f}\\(uuid\\) from public, anon, authenticated;`), `${f}: thu hồi khỏi public/anon/authenticated`);
  assert.match(code, new RegExp(`grant execute on function public\\.${f}\\(uuid\\) to service_role;`), `${f}: chỉ service_role`);
}

// ---------- Quét cắt: ghi po từ group_uid_details ----------
const scan = fnText(code, "_cut_group_uid_scan_body");
assert.equal(scan.params, "p_access_token text, p_group_uid text", "giữ chữ ký _cut_group_uid_scan_body");
definer(scan, "_cut_group_uid_scan_body");
const scanStripped = stripPo("_cut_group_uid_scan_body", scan.full, [
  [/,g\.purchase_order as po(?= into v_source)/, 1, "đọc purchase_order của UID cùng câu select vào v_source"],
  [/,po(?=\)values\()/, 1, "insert cut_group_uids thêm cột po"],
  [/,v_source\.po(?=\)on conflict)/, 1, "insert giá trị v_source.po (null nếu UID chưa có PO)"],
]);
assert.equal(scanStripped, squash(fnText(floorBase, "_cut_group_uid_scan_body").full), "_cut_group_uid_scan_body phải chép nguyên văn bản floor_access_v1.sql ngoài phần PO");

// ---------- Xác nhận Theo PO: ghi po của phiên ----------
const confirm = fnText(code, "_cut_sample_confirm_body");
assert.equal(confirm.params, "p_session uuid", "giữ chữ ký _cut_sample_confirm_body");
definer(confirm, "_cut_sample_confirm_body");
const confirmStripped = stripPo("_cut_sample_confirm_body", confirm.full, [
  [/,ss\.po(?= from public\.cut_sample_items i)/, 1, "todo lấy ss.po của phiên"],
  [/ join public\.cut_sample_sessions ss on ss\.id=i\.session_id(?= left join)/, 1, "todo join cut_sample_sessions theo session_id"],
  [/,po(?=\)select t\.group_uid_code)/, 1, "insert cut_group_uids thêm cột po"],
  [/,t\.po(?= from todo t)/, 1, "insert giá trị t.po"],
]);
assert.equal(confirmStripped, squash(fnText(floorBase, "_cut_sample_confirm_body").full), "_cut_sample_confirm_body phải chép nguyên văn bản floor_access_v1.sql ngoài phần PO");
for (const [f, sig] of [["_cut_group_uid_scan_body", "text, text"], ["_cut_sample_confirm_body", "uuid"]]) {
  assert.match(code, new RegExp(`revoke all on function public\\.${f}\\(${sig}\\) from public, anon, authenticated;`), `${f}: hàm nội bộ thu hồi khỏi public/anon/authenticated`);
  assert.doesNotMatch(code, new RegExp(`grant [^;]*public\\.${f}\\(`), `${f}: không cấp quyền`);
}

// ---------- Tra cứu: p_po + trả po ----------
const searchSig = "text,text,text,date,date,text,integer";
const search = fnText(code, "cut_group_uid_search");
assert.equal(search.params, "p_access_token text,p_sku text default '',p_lot text default '',p_date_from date default null,p_date_to date default null,p_adj text default '',p_limit integer default 5000,p_po text default ''",
  "cut_group_uid_search: giữ thứ tự tham số cũ, p_po text default '' đặt cuối");
definer(search, "cut_group_uid_search");
assert.match(search.head, /\bstable\b/, "cut_group_uid_search vẫn stable");
assert.ok(code.indexOf(`drop function if exists public.cut_group_uid_search(${searchSig});`) < code.indexOf("create or replace function public.cut_group_uid_search("), "drop chữ ký cũ trước khi tạo");
const searchStripped = stripPo("cut_group_uid_search", search.full, [
  [/,p_po text default ''(?=\)returns)/, 1, "tham số p_po text default '' cuối"],
  [/v_po text :=btrim\(coalesce\(p_po,''\)\);/, 1, "v_po = btrim(p_po)"],
  [/,'po',q\.eff_po(?=\))/, 1, "mỗi dòng trả 'po'"],
  [/select c\.\*,coalesce\(c\.po,d\.purchase_order\)as eff_po from public\.cut_group_uids c left join public\.group_uid_details d on d\.group_uid_code=c\.group_uid_code/, 1,
    "eff_po = coalesce(c.po, d.purchase_order) qua left join group_uid_details", "select * from public.cut_group_uids c"],
  [/and\(v_po='' or coalesce\(c\.po,d\.purchase_order\)=v_po\)/, 1, "lọc khớp đúng coalesce(c.po, d.purchase_order) = v_po"],
  [/,'filterPo',v_po/, 1, "trả filterPo"],
]);
assert.equal(searchStripped, squash(fnText(searchBase, "cut_group_uid_search").full), "cut_group_uid_search phải chép nguyên văn bản v5 ngoài phần PO (giữ mọi khoá cũ)");
assert.match(code, new RegExp(`revoke all on function public\\.cut_group_uid_search\\(${searchSig},text\\) from public;`), "search: revoke public trên chữ ký mới");
assert.match(code, new RegExp(`grant execute on function public\\.cut_group_uid_search\\(${searchSig},text\\) to anon, ?authenticated;`), "search: cấp anon + authenticated trên chữ ký mới");
assert.doesNotMatch(code, new RegExp(`(grant|revoke)[^;]*cut_group_uid_search\\(${searchSig}\\)`), "search: không cấp/thu quyền chữ ký cũ (đã drop)");

// ---------- Đối chiếu ADJ: p_po + trả po ----------
const recSig = "text,text,text,date,date,integer";
const rec = fnText(code, "cut_group_uid_reconcile");
assert.equal(rec.params, "p_access_token text, p_sku text default '', p_lot text default '', p_date_from date default null, p_date_to date default null, p_limit integer default 5000, p_po text default ''",
  "cut_group_uid_reconcile: giữ thứ tự tham số cũ, p_po text default '' đặt cuối");
definer(rec, "cut_group_uid_reconcile");
assert.match(rec.head, /\bstable\b/, "cut_group_uid_reconcile vẫn stable");
assert.ok(code.indexOf(`drop function if exists public.cut_group_uid_reconcile(${recSig});`) < code.indexOf("create or replace function public.cut_group_uid_reconcile("), "drop chữ ký cũ trước khi tạo");
const recStripped = stripPo("cut_group_uid_reconcile", rec.full, [
  [/,p_po text default ''(?=\)returns)/, 1, "tham số p_po text default '' cuối"],
  [/v_po text :=btrim\(coalesce\(p_po,''\)\);/, 1, "v_po = btrim(p_po)"],
  [/,'po',q\.eff_po(?=,'wmsCuts')/, 1, "mỗi dòng trả 'po'"],
  [/,coalesce\(c\.po,g\.purchase_order\)as eff_po(?= from public\.cut_group_uids c left join public\.group_uid_details g)/, 1, "eff_po = coalesce(c.po, g.purchase_order)"],
  [/and\(v_po='' or coalesce\(c\.po,g\.purchase_order\)=v_po\)/, 1, "lọc khớp đúng coalesce(c.po, g.purchase_order) = v_po"],
  [/,'filterPo',v_po/, 1, "trả filterPo"],
]);
assert.equal(recStripped, squash(fnText(qcBase, "cut_group_uid_reconcile").full), "cut_group_uid_reconcile phải chép nguyên văn bản group_uid_qc_status_v1.sql ngoài phần PO (giữ mọi khoá cũ)");
assert.match(code, new RegExp(`revoke all on function public\\.cut_group_uid_reconcile\\(${recSig},text\\) from public;`), "reconcile: revoke public trên chữ ký mới");
assert.match(code, new RegExp(`grant execute on function public\\.cut_group_uid_reconcile\\(${recSig},text\\) to anon, ?authenticated;`), "reconcile: cấp anon + authenticated trên chữ ký mới");
assert.doesNotMatch(code, new RegExp(`(grant|revoke)[^;]*cut_group_uid_reconcile\\(${recSig}\\)`), "reconcile: không cấp/thu quyền chữ ký cũ (đã drop)");
for (const fn of [search, rec]) {
  assert.doesNotMatch(fn.body, /\b(insert|update|delete|truncate)\b/i, "hàm tra cứu không được ghi");
  assert.doesNotMatch(fn.body, /\bilike\b[^,;()]*\b(v_po|p_po)\b|\b(v_po|p_po|eff_po|purchase_order)\b[^,;()]*\bilike\b/i, "PO khớp đúng, không ilike");
}

// ---------- Chỉ đụng 6 hàm, anon chỉ hai hàm đọc ----------
const created = [...code.matchAll(/create or replace function public\.(\w+)\(/g)].map(m => m[1]).sort();
assert.deepEqual(created, ["_cut_group_uid_scan_body", "_cut_sample_confirm_body", "cut_group_uid_reconcile", "cut_group_uid_search", "group_uid_sync_apply", "group_uid_sync_preview"],
  "chỉ tạo/thay 6 hàm (không đụng hàm công khai bọc floor_access_check)");
const anonFns = [...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map(m => m[1]).sort();
assert.deepEqual(anonFns, ["cut_group_uid_reconcile", "cut_group_uid_search"], "anon chỉ được hai hàm tra cứu");

console.log("cut_group_uid_po_sql: cột (staging/details/cut_group_uids, không index PO), preview/apply chép nguyên văn + PO chỉ khi known (không stale_source, không coalesce), quét cắt + xác nhận Theo PO ghi po, search/reconcile p_po khớp đúng coalesce + trả po, drop đúng chữ ký cũ, quyền chữ ký mới — passed");
