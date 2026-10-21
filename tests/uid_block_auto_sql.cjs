// LỰA UID BLOCKED tự nhận UID Blocked mới (supabase/uid_block_auto_v1.sql, 21/10/2026). Không có Postgres cục bộ: kiểm cấu trúc
// tệp SQL bằng cách đọc văn bản.
//   * cột mới: uid_block_lists.source ('excel' | 'wms', mặc định 'excel', ràng buộc đặt tên thêm một lần), uid_block_items.added_at /
//     released_at / wms_status (≤ 100 ký tự); danh sách "WMS Blocked ·" đã có → source = 'wms' (update idempotent);
//   * _uid_block_import_body(p_list, p_items, p_by): thân nạp cũ KHÔNG kiểm Admin, chỉ chủ sở hữu gọi (revoke public/anon/
//     authenticated, không grant); giữ khoá advisory, kiểm kiểu, 1–20.000 dòng, giữ 5 danh sách, chép lượt quét; nhận thêm source,
//     addedAt / releasedAt (chuỗi giờ ISO có múi giờ hoặc null), wmsStatus (chuỗi ≤ 100 hoặc null); item_count / by_warehouse
//     KHÔNG tính dòng released; imported_by = p_by;
//   * uid_block_import: chữ ký + quyền cũ, kiểm Admin đầu tiên rồi gọi thân với auth.uid();
//   * _uid_block_build_wms(p_warehouses, p_prev): chỉ đọc; Blocked (ilike) ở kho chọn, 16 số; addedAt giữ cũ / now (danh sách
//     trước là wms) / null; UID rời danh sách → releasedAt (giữ cũ hoặc now), wmsStatus hiện tại, bỏ dòng released quá 7 ngày;
//     thứ tự kho, vị trí, mã;
//   * uid_block_import_wms: Admin, khoá trước khi đọc danh sách đang dùng, dựng qua hàm chung, source 'wms', nạp qua uid_block_import;
//   * uid_block_refresh_wms(): chỉ chủ sở hữu/cron; khoá trước; danh sách đang dùng không phải wms → not_wms; so tập
//     (mã, released?, wms_status của dòng released) hai chiều; giống → changed:false; khác → thân nạp (p_by null), trả
//     changed/listId/itemCount/added/released;
//   * cron 'uid-block-refresh-wms' '*/30 * * * *';
//   * uid_block_snapshot: giữ unchanged + rfid, item thêm addedAt/releasedAt/wmsStatus, list thêm source;
//   * Codex vòng 1 (21/10): uid_block_scan thay lại — UID hết Blocked quét sau released_at → không ghi, not_blocked + released;
//     backfill source 'wms' cần tên + sheets là 1–10 kho có trong group_uid_details; danh sách WMS được rỗng (không còn 'empty');
//     so tập dòng còn Blocked đủ (mã, kho, vị trí, sku, lot, roll, trạng thái), không so giờ;
//   * chỉ thêm (không drop / truncate / delete ngoài thân hàm), begin/commit + notify pgrst.
// Thử đột biến: UID_BLOCK_AUTO_SQL=<tệp đã sửa> node tests/uid_block_auto_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.UID_BLOCK_AUTO_SQL || path.join(__dirname, "..", "supabase", "uid_block_auto_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/uid_block_auto_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");
const flat = s => s.replace(/\s+/g, " ").trim();

// ---- Khung migration ----
assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm, không drop/truncate");
// apply_supabase_sql.py bỏ thân $$…$$ rồi chặn DELETE FROM: ngoài thân hàm không được xoá dữ liệu
const outside = code.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
assert.doesNotMatch(outside, /\bdelete\s+from\b/i, "DELETE FROM ngoài thân hàm (script sẽ chặn)");

// ---- Cột mới ----
assert.match(code, /alter table public\.uid_block_lists add column if not exists source text not null default 'excel';/, "uid_block_lists thiếu cột source text not null default 'excel'");
assert.match(code, /if not exists \(select 1 from pg_constraint where conname = 'uid_block_lists_source_check'[\s\S]{0,200}?alter table public\.uid_block_lists add constraint uid_block_lists_source_check check \(source in \('excel', 'wms'\)\)/,
  "ràng buộc source in ('excel','wms') thêm một lần (idempotent, có tên)");
for (const col of ["added_at timestamptz", "released_at timestamptz", "wms_status text"]) {
  assert.match(code, new RegExp(`alter table public\\.uid_block_items add column if not exists ${col};`), `uid_block_items thiếu cột ${col}`);
}
assert.match(code, /if not exists \(select 1 from pg_constraint where conname = 'uid_block_items_wms_status_check'[\s\S]{0,200}?alter table public\.uid_block_items add constraint uid_block_items_wms_status_check check \(wms_status is null or char_length\(wms_status\) <= 100\)/,
  "ràng buộc wms_status ≤ 100 ký tự (idempotent, có tên)");
// Codex vòng 2 #3: không suy nguồn — chỉ đánh 'wms' đúng danh sách do uid_block_import_wms tạo trước migration (21/10/2026 07:56,
// id ghi đích danh, tra chỉ đọc). Danh sách khác (kể cả Excel đặt tên "WMS Blocked …") giữ 'excel'.
const backfill = code.match(/update public\.uid_block_lists l set source = 'wms'([\s\S]*?);/);
assert.ok(backfill, "danh sách WMS đã có phải đánh source = 'wms' (idempotent)");
const bf = flat(backfill[1]);
assert.match(bf, /^\s*where l\.id = 'fbeef2e5-902c-4cf8-b9bc-948ec6fd8792' and l\.source <> 'wms'\s*$/, "chỉ đúng id danh sách WMS đã biết (chạy lại không đổi)");
assert.doesNotMatch(bf, /file_name|group_uid_details/, "không suy nguồn theo tên tệp / dữ liệu kho");

// ---- Tách hàm ----
const fn = name => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: flat(m[1]), head: m[2], body: m[3] };
};
const body = fn("_uid_block_import_body"), imp = fn("uid_block_import"), build = fn("_uid_block_build_wms");
const wms = fn("uid_block_import_wms"), refresh = fn("uid_block_refresh_wms"), snap = fn("uid_block_snapshot");
assert.equal(body.params, "p_list jsonb, p_items jsonb, p_by uuid");
assert.equal(imp.params, "p_list jsonb, p_items jsonb", "uid_block_import giữ chữ ký cũ");
assert.equal(build.params, "p_warehouses text[], p_prev uuid");
assert.equal(wms.params, "p_warehouses text[]", "uid_block_import_wms giữ chữ ký cũ");
assert.equal(refresh.params, "");
assert.equal(snap.params, "p_known_list_id uuid default null", "uid_block_snapshot giữ chữ ký cũ");
for (const [name, f] of [["_uid_block_import_body", body], ["uid_block_import", imp], ["_uid_block_build_wms", build],
                         ["uid_block_import_wms", wms], ["uid_block_refresh_wms", refresh], ["uid_block_snapshot", snap]]) {
  assert.match(f.head, /returns jsonb/i, `${name} trả jsonb`);
  assert.match(f.head, /security definer/i, `${name} phải SECURITY DEFINER`);
  assert.match(f.head, /set search_path = ''/, `${name} phải set search_path = ''`);
}
for (const [name, f] of [["_uid_block_build_wms", build], ["uid_block_snapshot", snap]]) {
  assert.match(f.head, /\bstable\b/i, `${name} chỉ đọc (stable)`);
  assert.doesNotMatch(f.body, /\b(insert|update|delete|truncate)\b|pg_advisory/i, `${name} không được ghi`);
}
for (const [name, f] of [["_uid_block_import_body", body], ["uid_block_import", imp], ["uid_block_import_wms", wms], ["uid_block_refresh_wms", refresh]]) {
  assert.doesNotMatch(f.head, /\bstable\b/i, `${name} ghi dữ liệu, không được stable`);
}

// ---- _uid_block_import_body: thân nạp, không kiểm Admin ----
assert.doesNotMatch(body.body, /group_uid_admin_allowed|auth\.uid\(\)/, "thân nạp không kiểm Admin và không tự lấy auth.uid() (cron gọi không có phiên)");
assert.match(body.body, /pg_advisory_xact_lock\(hashtext\('public\.uid_block_import'\)\)/, "thân nạp giữ khoá advisory cũ (cùng khoá với uid_block_scan)");
assert.match(body.body, /jsonb_typeof\(p_list\) <> 'object'/, "p_list phải là object");
assert.match(body.body, /jsonb_typeof\(p_list->'fileName'\) is distinct from 'string'/, "fileName phải là chuỗi");
assert.match(body.body, /length\(btrim\(p_list->>'fileName'\)\) not between 1 and 200/, "fileName 1–200 ký tự");
assert.match(body.body, /jsonb_typeof\(p_list->'sheets'\) is distinct from 'array'/, "sheets phải là mảng");
assert.match(body.body, /coalesce\(jsonb_typeof\(p_list->'source'\),'null'\) not in \('string','null'\)/, "source là chuỗi hoặc thiếu");
assert.match(body.body, /coalesce\(p_list->>'source','excel'\) not in \('excel','wms'\)/, "source chỉ 'excel' | 'wms', thiếu = 'excel'");
// Codex #3: danh sách WMS được rỗng (dòng hết Blocked cuối cùng hết hạn 7 ngày); Excel vẫn 1–20.000.
assert.match(body.body, /jsonb_array_length\(case when jsonb_typeof\(p_items\) = 'array' then p_items else '\[\]'::jsonb end\)\s+not between \(case when coalesce\(p_list->>'source','excel'\) = 'wms' then 0 else 1 end\) and 20000\b/,
  "p_items: wms 0–20.000, excel 1–20.000");
assert.match(body.body, /jsonb_typeof\(e\.v\) <> 'object'/, "mỗi dòng phải là object");
assert.match(body.body, /btrim\(e\.v->>'groupUid'\) !~ '\^\[0-9\]\{16\}\$'/, "groupUid đúng 16 chữ số sau btrim");
for (const f of ["sku", "productName", "lot", "roll", "warehouse", "location", "fileStatus"]) {
  assert.ok(body.body.includes(`coalesce(jsonb_typeof(e.v->'${f}'),'null') not in ('string','null')`), `trường ${f} phải là chuỗi hoặc null`);
  assert.ok(body.body.includes(`length(coalesce(e.v->>'${f}','')) > 300`), `trường ${f} tối đa 300 ký tự`);
}
for (const f of ["addedAt", "releasedAt", "wmsStatus"]) {
  assert.ok(body.body.includes(`coalesce(jsonb_typeof(e.v->'${f}'),'null') not in ('string','null')`), `trường ${f} phải là chuỗi hoặc null`);
}
assert.ok(body.body.includes("length(coalesce(e.v->>'wmsStatus','')) > 100"), "wmsStatus tối đa 100 ký tự");
const tsRe = /\(e\.v->>'(addedAt|releasedAt)'\) !~ '\^\[0-9\]\{4\}-\[0-9\]\{2\}-\[0-9\]\{2\}\[T \]\[0-9\]\{2\}:\[0-9\]\{2\}[^']*\(Z\|\[\+-\]\[0-9\]\{2\}[^']*\$'/g;
assert.deepEqual([...body.body.matchAll(tsRe)].map(m => m[1]).sort(), ["addedAt", "releasedAt"], "addedAt/releasedAt phải là giờ ISO có múi giờ (kiểm trước khi ép kiểu)");
assert.match(body.body, /'INVALID_INPUT'/, "sai kiểu trả INVALID_INPUT");
assert.match(body.body, /exception when others then[\s\S]*'INVALID_INPUT'/, "lỗi ghi dòng phải trả INVALID_INPUT, không ném lỗi thô");
assert.match(body.body, /distinct on \(btrim\(e\.v->>'groupUid'\)\)/, "bỏ trùng theo groupUid");
const insList = body.body.indexOf("insert into public.uid_block_lists");
assert.match(body.body, /insert into public\.uid_block_lists\(file_name, sheets, source, item_count, imported_by, imported_at\)\s+values \(btrim\(p_list->>'fileName'\), p_list->'sheets', coalesce\(p_list->>'source','excel'\), 0, p_by, clock_timestamp\(\)\)/,
  "danh sách mới ghi source + imported_by = p_by + giờ sau khoá");
assert.match(body.body, /insert into public\.uid_block_items\(list_id, group_uid_code, sku, product_name, lot, roll, warehouse, location, file_status, added_at, released_at, wms_status\)/, "dòng mới ghi added_at/released_at/wms_status");
assert.match(body.body, /\(e\.v->>'addedAt'\)::timestamptz/, "addedAt ép timestamptz");
assert.match(body.body, /\(e\.v->>'releasedAt'\)::timestamptz/, "releasedAt ép timestamptz");
assert.match(body.body, /nullif\(btrim\(e\.v->>'wmsStatus'\),''\)/, "wmsStatus btrim, rỗng → null");
assert.match(body.body, /from public\.uid_block_items i where i\.list_id = v_id and i\.released_at is null group by 1/, "by_warehouse không tính dòng released");
assert.match(body.body, /select count\(\*\)::integer into v_count from public\.uid_block_items i where i\.list_id = v_id and i\.released_at is null;/, "item_count không tính dòng released");
const impLock = body.body.indexOf("pg_advisory_xact_lock(");
const prevSel = body.body.search(/select l\.id into v_prev\s+from public\.uid_block_lists l\s+order by l\.imported_at desc, l\.id desc\s+limit 1/);
const insItems = body.body.indexOf("insert into public.uid_block_items");
const carry = body.body.search(/insert into public\.uid_block_scans\s*\(list_id, group_uid_code, scanned_at, recorded_at, device_id, device_name\)\s*select v_id, s\.group_uid_code, s\.scanned_at, s\.recorded_at, s\.device_id, s\.device_name\s+from public\.uid_block_scans s\s+join public\.uid_block_items i on i\.list_id = v_id and i\.group_uid_code = s\.group_uid_code\s+where s\.list_id = v_prev;/);
const keep5 = body.body.search(/delete from public\.uid_block_lists\s+where id not in \(select id from public\.uid_block_lists order by imported_at desc, id desc limit 5\)/);
assert.ok(impLock >= 0 && prevSel > impLock, "v_prev lấy SAU khoá");
assert.ok(prevSel >= 0 && prevSel < insList, "v_prev lấy TRƯỚC khi chèn danh sách mới");
assert.ok(carry > insItems, "chép lượt quét (kể cả UID đã hết Blocked) sau khi chèn dòng");
assert.ok(keep5 > carry, "giữ 5 danh sách, xoá SAU khi chép lượt quét");
for (const k of ["'listId'", "'itemCount'", "'byWarehouse'", "'carriedScans'", "'releasedCount'"]) assert.ok(body.body.includes(k), `thân nạp thiếu khoá trả về ${k}`);
assert.match(body.body, /'meta',\s*jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, "trả meta như cũ");

// ---- uid_block_import: Admin rồi gọi thân ----
const impFirstIf = imp.body.indexOf("if ");
assert.ok(impFirstIf >= 0 && imp.body.slice(impFirstIf, impFirstIf + 60).includes("not public.group_uid_admin_allowed()"), "uid_block_import kiểm group_uid_admin_allowed() đầu tiên");
assert.match(imp.body, /'FORBIDDEN'/);
assert.match(imp.body, /return public\._uid_block_import_body\(p_list, p_items, \(select auth\.uid\(\)\)\);/, "uid_block_import gọi thân với auth.uid()");
assert.ok(imp.body.indexOf("_uid_block_import_body") > imp.body.indexOf("group_uid_admin_allowed"), "kiểm Admin TRƯỚC khi gọi thân");
assert.doesNotMatch(imp.body, /insert into|delete from/i, "uid_block_import không tự ghi bảng");

// ---- _uid_block_build_wms ----
assert.match(build.body, /g\.status ilike 'blocked'/i, "chỉ UID đang Blocked (không phân biệt hoa thường)");
assert.match(build.body, /g\.warehouse = any\(p_warehouses\)/, "lọc đúng kho");
assert.match(build.body, /g\.group_uid_code ~ '\^\[0-9\]\{16\}\$'/, "chỉ Group UID 16 số");
assert.match(build.body, /"SKU_Name" s where s\.sku = c\.sku limit 1/, "tên hàng theo SKU_Name, một dòng");
assert.match(build.body, /'lot', left\(c\.batch_code, 300\)/, "Lot = batch_code");
assert.match(build.body, /'roll', left\(c\.roll_code, 300\)/, "Roll = roll_code");
assert.match(build.body, /'fileStatus', left\(c\.status, 300\)/, "fileStatus = trạng thái WMS");
assert.match(build.body, /'wmsStatus', left\(c\.status, 100\)/, "wmsStatus = trạng thái WMS (≤ 100)");
assert.match(build.body, /select l\.source into v_src from public\.uid_block_lists l where l\.id = p_prev;/, "đọc nguồn của danh sách trước");
assert.match(flat(build.body), /'addedAt', case when p\.group_uid_code is not null and p\.released_at is null then p\.added_at when v_src = 'wms' then v_now else null end/,
  "addedAt: còn trong danh sách trước → giữ cũ; mới so với danh sách wms → now; danh sách trước excel/không có → null");
assert.match(build.body, /left join public\.uid_block_items p on p\.list_id = p_prev and p\.group_uid_code = c\.group_uid_code/, "ghép với danh sách trước theo mã");
assert.match(build.body, /where v_src = 'wms'\s+and p\.list_id = p_prev/, "UID hết Blocked chỉ tính khi danh sách trước là wms");
assert.match(build.body, /'releasedAt', coalesce\(p\.released_at, v_now\)/, "releasedAt giữ giờ cũ, mới phát hiện → now");
assert.match(build.body, /'wmsStatus', left\(g\.status, 100\)/, "UID hết Blocked: wmsStatus = trạng thái hiện tại (null nếu không còn)");
assert.match(build.body, /left join public\.group_uid_details g on g\.group_uid_code = p\.group_uid_code/, "trạng thái hiện tại từ group_uid_details (không còn → null)");
assert.match(build.body, /not exists \(select 1 from cur c where c\.group_uid_code = p\.group_uid_code\)/, "UID rời danh sách = không còn trong tập Blocked hiện tại");
assert.match(flat(build.body), /and \(p\.released_at is null or p\.released_at >= v_now - interval '7 days' or exists \(select 1 from public\.uid_block_scans s where s\.list_id = p_prev and s\.group_uid_code = p\.group_uid_code\)\)/,
  "bỏ dòng hết Blocked quá 7 ngày CHỈ khi chưa quét (đã có lượt quét trong danh sách trước → giữ để còn trong Đã lựa)");
for (const k of ["'sku', p.sku", "'productName', p.product_name", "'lot', p.lot", "'roll', p.roll", "'warehouse', p.warehouse", "'location', p.location", "'fileStatus', p.file_status", "'addedAt', p.added_at"]) {
  assert.ok(build.body.includes(k), `UID hết Blocked giữ dòng chi tiết cũ: thiếu ${k}`);
}
assert.match(build.body, /order by r\.warehouse, r\.location, r\.group_uid_code/, "thứ tự ổn định: kho, vị trí, mã");
assert.match(build.body, /v_now timestamptz := now\(\)/, "một mốc giờ cho cả lượt");

// ---- uid_block_import_wms ----
const wFirstIf = wms.body.indexOf("if ");
assert.ok(wFirstIf >= 0 && wms.body.slice(wFirstIf, wFirstIf + 60).includes("not public.group_uid_admin_allowed()"), "uid_block_import_wms kiểm Admin đầu tiên");
assert.match(wms.body, /cardinality\(v_wh\) > 10/, "giới hạn số kho");
const wLock = wms.body.indexOf("pg_advisory_xact_lock(hashtext('public.uid_block_import'))");
const wPrev = wms.body.search(/select l\.id into v_prev\s+from public\.uid_block_lists l\s+order by l\.imported_at desc, l\.id desc\s+limit 1/);
const wBuild = wms.body.indexOf("v_items := public._uid_block_build_wms(v_wh, v_prev);");
assert.ok(wLock > wms.body.indexOf("group_uid_admin_allowed") && wPrev > wLock && wBuild > wPrev, "Admin → khoá → danh sách đang dùng → dựng (không đua với lượt nạp khác)");
assert.doesNotMatch(wms.body, /'NO_ROWS'/, "Codex vòng 2 #2: WMS không còn UID Blocked → vẫn nạp danh sách WMS rỗng (thay danh sách Excel cũ)");
assert.match(wms.body, /return public\.uid_block_import\(jsonb_build_object\('fileName', v_name, 'sheets', to_jsonb\(v_wh\), 'source', 'wms'\), v_items\);/, "nạp qua uid_block_import với source 'wms'");
assert.doesNotMatch(wms.body, /group_uid_details/, "dựng danh sách qua hàm chung, không truy vấn riêng");

// ---- uid_block_refresh_wms ----
const rLock = refresh.body.indexOf("pg_advisory_xact_lock(hashtext('public.uid_block_import'))");
const rCur = refresh.body.search(/select \* into v_list from public\.uid_block_lists order by imported_at desc, id desc limit 1;/);
assert.ok(rLock >= 0 && rCur > rLock, "refresh khoá TRƯỚC khi đọc danh sách đang dùng");
assert.match(refresh.body, /if not found or v_list\.source <> 'wms' then[\s\S]{0,200}?'changed',false,'reason','not_wms'/, "danh sách Excel (hoặc chưa có) → không tự đổi");
assert.match(refresh.body, /jsonb_array_elements_text\(v_list\.sheets\)/, "kho = sheets của danh sách wms");
assert.match(refresh.body, /v_items := public\._uid_block_build_wms\(v_wh, v_list\.id\);/, "dựng bằng hàm chung với danh sách đang dùng");
const rCmp = flat(refresh.body);
// Codex #4: dòng còn Blocked so (mã, kho, vị trí, sku, lot, roll, trạng thái); dòng hết Blocked so (mã, released, wms_status);
// KHÔNG so addedAt / releasedAt (giờ phát sinh → tạo danh sách liên tục).
const colsX = "x.code, x.rel, x.wh, x.loc, x.sku, x.lot, x.roll, x.st", colsY = colsX.replace(/x\./g, "y.");
assert.ok(rCmp.includes(`(select ${colsX} from new_set x except select ${colsY} from old_set y)`), "so tập: mới trừ cũ (đủ 8 cột)");
assert.ok(rCmp.includes(`(select ${colsY} from old_set y except select ${colsX} from new_set x)`), "so tập: cũ trừ mới (đủ 8 cột)");
for (const [k, f] of [["wh", "warehouse"], ["loc", "location"], ["sku", "sku"], ["lot", "lot"], ["roll", "roll"]]) {
  assert.ok(rCmp.includes(`case when e.v->>'releasedAt' is null then nullif(btrim(e.v->>'${f}'),'') end as ${k}`), `tập mới: ${f} của dòng còn Blocked, chuẩn hoá như lúc ghi`);
  assert.ok(rCmp.includes(`case when i.released_at is null then i.${f} end as ${k}`), `tập cũ: ${f} của dòng còn Blocked`);
}
assert.ok(rCmp.includes("(e.v->>'releasedAt') is not null as rel, "), "tập mới: released?");
assert.ok(rCmp.includes("case when e.v->>'releasedAt' is not null then nullif(btrim(e.v->>'wmsStatus'),'') else nullif(btrim(e.v->>'fileStatus'),'') end as st"), "tập mới: trạng thái (released → wms_status, còn Blocked → file_status)");
assert.ok(rCmp.includes("i.released_at is not null as rel, "), "tập cũ: released?");
assert.ok(rCmp.includes("case when i.released_at is not null then i.wms_status else i.file_status end as st"), "tập cũ: trạng thái");
const setsSql = rCmp.slice(rCmp.indexOf("with new_set"), rCmp.indexOf("into v_same"));
assert.doesNotMatch(setsSql, /added_?at|addedAt|i\.released_at as|'releasedAt'\)::|imported_at/i, "không so giờ addedAt/releasedAt");
assert.doesNotMatch(refresh.body, /'empty'/, "Codex #3: không giữ nguyên danh sách khi dựng ra rỗng");
assert.doesNotMatch(refresh.body, /jsonb_array_length\(v_items\) = 0/, "danh sách rỗng đi qua so tập (đang rỗng → giống → changed:false)");
assert.match(refresh.body, /'changed',false,'listId',v_list\.id/, "giống → changed:false");
assert.match(refresh.body, /v_res := public\._uid_block_import_body\(jsonb_build_object\('fileName', v_name, 'sheets', to_jsonb\(v_wh\), 'source', 'wms'\), v_items, null\);/, "khác → thân nạp, source 'wms', p_by null");
assert.match(refresh.body, /'WMS Blocked · ' \|\| array_to_string\(v_wh, ' \+ '\) \|\| ' · '\s*\|\| to_char\(now\(\) at time zone 'Asia\/Ho_Chi_Minh', 'DD\/MM HH24:MI'\)/, "tên danh sách 'WMS Blocked · <kho> · dd/mm HH:MI' giờ VN");
for (const k of ["'changed',true", "'listId'", "'itemCount'", "'added'", "'released'"]) assert.ok(refresh.body.includes(k), `refresh thiếu khoá trả về ${k}`);
assert.match(refresh.body, /if coalesce\(\(v_res->>'ok'\)::boolean, false\) is not true then\s+return v_res;/, "thân nạp lỗi → trả nguyên lỗi");
assert.doesNotMatch(refresh.body, /insert into|delete from|group_uid_admin_allowed/i, "refresh chỉ ghi qua thân nạp");

// ---- Quyền ----
for (const [name, sig] of [["_uid_block_import_body", "jsonb,jsonb,uuid"], ["_uid_block_build_wms", "text\\[\\],uuid"], ["uid_block_refresh_wms", ""]]) {
  assert.match(code, new RegExp(`revoke all on function public\\.${name}\\(${sig}\\) from public, anon, authenticated;`), `${name} phải thu hồi khỏi public, anon, authenticated`);
  assert.doesNotMatch(code, new RegExp(`grant [^;]* on function public\\.${name}\\(`), `${name} không cấp cho ai (chỉ chủ sở hữu / cron)`);
}
assert.match(code, /revoke all on function public\.uid_block_import\(jsonb,jsonb\) from public, anon;/);
assert.match(code, /grant execute on function public\.uid_block_import\(jsonb,jsonb\) to authenticated;/);
assert.match(code, /revoke all on function public\.uid_block_import_wms\(text\[\]\) from public, anon;/);
assert.match(code, /grant execute on function public\.uid_block_import_wms\(text\[\]\) to authenticated;/);
assert.match(code, /revoke all on function public\.uid_block_snapshot\(uuid\) from public;/);
assert.match(code, /grant execute on function public\.uid_block_snapshot\(uuid\) to anon, authenticated;/);
assert.match(code, /revoke all on function public\.uid_block_scan\(text,uuid,text,timestamptz\) from public;/);
assert.match(code, /grant execute on function public\.uid_block_scan\(text,uuid,text,timestamptz\) to anon, authenticated;/, "uid_block_scan giữ quyền anon + authenticated (khoá máy trong hàm)");
const anonFns = new Set([...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map(m => m[1]));
assert.deepEqual([...anonFns].sort(), ["uid_block_scan", "uid_block_snapshot"], "anon chỉ được gọi uid_block_snapshot + uid_block_scan");
const granted = new Set([...code.matchAll(/grant execute on function public\.(\w+)\(/g)].map(m => m[1]));
assert.deepEqual([...granted].sort(), ["uid_block_import", "uid_block_import_wms", "uid_block_scan", "uid_block_snapshot"], "chỉ cấp lại quyền 4 hàm công khai cũ");

// ---- uid_block_scan (Codex #1): DB là cổng cuối — UID hết Blocked không ghi lượt quét sau lúc hết Blocked ----
const scan = fn("uid_block_scan");
assert.equal(scan.params, "p_access_token text, p_list_id uuid, p_group_uid text, p_scanned_at timestamptz default null", "uid_block_scan giữ chữ ký cũ");
assert.match(scan.head, /returns jsonb/i);
assert.match(scan.head, /security definer/i);
assert.match(scan.head, /set search_path = ''/);
assert.doesNotMatch(scan.head, /\bstable\b/i);
const sFirst = scan.body.replace(/^[\s\S]*?\bbegin\b/, "").trim();
assert.match(sFirst, /^v_access := public\.floor_access_check\(p_access_token, 'uid_block_scan'\);\s*if v_access = 'deny' then return public\.floor_access_denied\(\); end if;/, "khoá máy đầu tiên");
for (const r of [...scan.body.matchAll(/\breturn\b\s*([^\n]*)/g)].map(m => m[1])) {
  assert.ok(r.startsWith("public.floor_access_denied();") || r.startsWith("public.floor_access_result(v_access, "), `mọi nhánh khác deny bọc floor_access_result: return ${r}`);
}
assert.match(scan.body, /v_code is null or v_code !~ '\^\[0-9\]\{16\}\$'[\s\S]{0,200}?'INVALID_GROUP_UID'/);
assert.match(scan.body, /p_list_id is null[\s\S]{0,200}?'INVALID_LIST'/);
const sLock = scan.body.indexOf("pg_advisory_xact_lock_shared(hashtext('public.uid_block_import'))");
const sCur = scan.body.search(/select l\.id into v_list\s+from public\.uid_block_lists l\s+order by l\.imported_at desc, l\.id desc\s+limit 1/);
assert.ok(sLock >= 0 && sCur > sLock, "khoá chia sẻ trước khi đọc danh sách hiện hành");
assert.match(scan.body, /if v_list is null then[\s\S]{0,200}?'NO_LIST'/);
assert.match(scan.body, /if v_list <> p_list_id then[\s\S]{0,200}?'STALE_LIST'[\s\S]{0,200}?'data',jsonb_build_object\('listId',v_list\)/);
const sItem = scan.body.search(/select i\.released_at, i\.wms_status into v_released_at, v_wms_status\s+from public\.uid_block_items i where i\.list_id = v_list and i\.group_uid_code = v_code;/);
assert.ok(sItem > sCur, "đọc released_at + wms_status của dòng trong danh sách hiện hành");
assert.match(scan.body, /if not found then[\s\S]{0,200}?'result','not_blocked','groupUid',v_code\)/, "mã ngoài danh sách → not_blocked như cũ");
assert.match(scan.body, /p_scanned_at between v_now - interval '2 days' and v_now \+ interval '5 minutes'[\s\S]{0,40}?least\(p_scanned_at, v_now\)[\s\S]{0,20}?else v_now/, "giờ quét chuẩn hoá như cũ");
const sAt = scan.body.indexOf("v_at := case");
const sRel = scan.body.search(/if v_released_at is not null and v_at > v_released_at then/);
const sIns = scan.body.indexOf("insert into public.uid_block_scans");
assert.ok(sAt > sItem && sRel > sAt && sIns > sRel, "chuẩn hoá giờ → kiểm hết Blocked → mới ghi");
assert.match(flat(scan.body.slice(sRel, sIns)), /'result','not_blocked','groupUid',v_code,'released',true,'wmsStatus',v_wms_status,'releasedAt',v_released_at/,
  "quét sau lúc hết Blocked → không ghi, not_blocked + released/wmsStatus/releasedAt (web cũ bỏ hàng chờ an toàn)");
assert.doesNotMatch(scan.body.slice(sRel, sIns), /insert/i, "nhánh hết Blocked không ghi");
assert.match(scan.body, /insert into public\.uid_block_scans\s*\(list_id, group_uid_code, scanned_at, device_id, device_name\)[\s\S]{0,120}?on conflict \(list_id, group_uid_code\) do nothing\s+returning/, "ghi như cũ");
assert.match(scan.body, /if found then\s+v_result := 'new';\s+else\s+v_result := 'dup';/);
assert.match(scan.body, /'mine',\s*\(v_row\.device_id is not null and v_dev is not null and v_row\.device_id = v_dev\)/);

// ---- Cron ----
assert.match(code, /create extension if not exists pg_cron with schema pg_catalog;/, "bật pg_cron (idempotent)");
assert.match(code, /select cron\.schedule\('uid-block-refresh-wms', '\*\/30 \* \* \* \*', \$\$select public\.uid_block_refresh_wms\(\)\$\$\);/, "cron 30 phút đúng tên (cùng tên thì thay lịch cũ)");
assert.ok(code.indexOf("cron.schedule") < code.search(/^\s*commit;/m), "lên lịch trong giao dịch");

// ---- uid_block_snapshot ----
assert.match(snap.body, /p_known_list_id is not null and v_list\.id = p_known_list_id/, "trùng id → unchanged");
assert.match(snap.body, /'unchanged',true,'listId',v_list\.id/, "trả {unchanged:true, listId}");
assert.match(snap.body, /'unchanged',false,'list',null,'items','\[\]'::jsonb/, "chưa có danh sách → {list:null, items:[]}");
assert.match(snap.body, /'rfid',g\.group_rfid_mapping/, "giữ rfid (group_uid_rfid_v1)");
assert.match(snap.body, /left join public\.group_uid_details g on g\.group_uid_code = i\.group_uid_code/, "rfid qua left join group_uid_details");
assert.match(snap.body, /'addedAt',i\.added_at,'releasedAt',i\.released_at,'wmsStatus',i\.wms_status/, "item thêm addedAt/releasedAt/wmsStatus");
assert.match(snap.body, /'source',v_list\.source/, "list thêm source");
for (const k of ["'id'", "'fileName'", "'sheets'", "'itemCount'", "'byWarehouse'", "'importedAt'", "'groupUid'", "'sku'", "'productName'", "'lot'", "'roll'", "'warehouse'", "'location'", "'fileStatus'"]) {
  assert.ok(snap.body.includes(k), `snapshot thiếu khoá cũ ${k}`);
}

console.log("uid_block_auto_sql: cột source/added_at/released_at/wms_status, thân nạp không kiểm Admin (chỉ chủ sở hữu) + bỏ released khỏi đếm, import Admin → thân, dựng Blocked/giữ added_at/released 7 ngày, import_wms khoá trước, refresh chỉ wms + so tập 8 cột hai chiều + danh sách rỗng, backfill theo kho thật, scan không ghi UID hết Blocked sau released_at, cron */30, snapshot addedAt/releasedAt/wmsStatus/source + rfid — passed");
