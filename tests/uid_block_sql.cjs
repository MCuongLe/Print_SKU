// LỰA UID BLOCKED (supabase/uid_block_v1.sql, 20/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * hai bảng uid_block_lists / uid_block_items bật RLS, thu hồi khỏi public/anon/authenticated, chỉ service_role;
//   * uid_block_import: SECURITY DEFINER + search_path '', kiểm group_uid_admin_allowed() đầu tiên, chỉ cấp authenticated,
//     kiểm kiểu từng trường (INVALID_INPUT), 1–20.000 dòng, Group UID đúng 16 chữ số, bỏ trùng, giữ 5 danh sách (DELETE dòng);
//   * uid_block_snapshot / uid_block_compare: chỉ đọc (stable), cấp anon + authenticated; snapshot trùng id → {unchanged:true, listId};
//     compare tối đa 20.000 mã, trả rows/missing/blockedOutside (≤ 500)/blockedOutsideTotal;
//   * lượt quét chung (20/10/2026, 3 người quét trực tiếp): bảng uid_block_scans (chỉ service_role, cascade theo danh sách);
//     uid_block_scan khoá máy qua floor_access_check như Cấp vải (deny → floor_access_denied, mọi nhánh khác bọc
//     floor_access_result), 16 chữ số, STALE_LIST, not_blocked, on conflict do nothing → new / dup + mine;
//     uid_block_scans chỉ đọc, đếm trùng → unchanged; import chép lượt quét của danh sách trước (carriedScans);
//     compare tính "Blocked ngoài danh sách" một lần;
//   * anon chỉ được gọi hai hàm đọc + hai hàm quét; chỉ thêm (không drop / truncate / alter … drop), có begin/commit + notify pgrst.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.UID_BLOCK_SQL || path.join(__dirname, "..", "supabase", "uid_block_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/uid_block_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm, không drop/truncate");

// Bảng: chỉ service_role
for (const t of ["uid_block_lists", "uid_block_items", "uid_block_scans"]) {
  assert.match(code, new RegExp(`create table if not exists public\\.${t}\\b`), `thiếu bảng ${t}`);
  assert.match(code, new RegExp(`alter table public\\.${t} enable row level security`), `${t} chưa bật RLS`);
  assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`), `${t} chưa thu hồi quyền`);
  assert.match(code, new RegExp(`grant [^;]* on public\\.${t} to service_role;`), `${t} chưa cấp service_role`);
  assert.doesNotMatch(code, new RegExp(`grant [^;]* on public\\.${t} to [^;]*\\b(anon|authenticated|public)\\b`), `${t} không được cấp cho anon/authenticated`);
  assert.doesNotMatch(code, new RegExp(`create policy [^;]* on public\\.${t}\\b`), `${t} không có policy (chỉ đi qua hàm)`);
}
const lists = code.match(/create table if not exists public\.uid_block_lists \(([\s\S]*?)\n\);/);
assert.ok(lists, "không đọc được định nghĩa uid_block_lists");
for (const col of ["id uuid primary key default gen_random_uuid\\(\\)", "file_name text", "sheets jsonb", "item_count integer", "by_warehouse jsonb", "imported_by uuid", "imported_at timestamptz not null default now\\(\\)"]) {
  assert.match(lists[1], new RegExp(col), `uid_block_lists thiếu cột ${col}`);
}
const items = code.match(/create table if not exists public\.uid_block_items \(([\s\S]*?)\n\);/);
assert.ok(items, "không đọc được định nghĩa uid_block_items");
assert.match(items[1], /list_id uuid not null references public\.uid_block_lists\(id\) on delete cascade/, "dòng phải xoá theo danh sách (cascade)");
for (const col of ["group_uid_code", "sku", "product_name", "lot", "roll", "warehouse", "location", "file_status"]) {
  assert.match(items[1], new RegExp(`\\b${col} text\\b`), `uid_block_items thiếu cột ${col}`);
}
assert.match(items[1], /primary key \(list_id, group_uid_code\)/, "khoá chính (list_id, group_uid_code)");
assert.match(items[1], /group_uid_code text not null check \(group_uid_code ~ '\^\[0-9\]\{16\}\$'\)/, "bảng phải chặn Group UID khác 16 chữ số");
const scanTable = code.match(/create table if not exists public\.uid_block_scans \(([\s\S]*?)\n\);/);
assert.ok(scanTable, "không đọc được định nghĩa uid_block_scans");
assert.match(scanTable[1], /list_id uuid not null references public\.uid_block_lists\(id\) on delete cascade/, "lượt quét xoá theo danh sách (cascade)");
assert.match(scanTable[1], /group_uid_code text not null check \(group_uid_code ~ '\^\[0-9\]\{16\}\$'\)/, "lượt quét chặn Group UID khác 16 chữ số");
assert.match(scanTable[1], /scanned_at timestamptz not null[,\n]/, "scanned_at bắt buộc");
assert.match(scanTable[1], /recorded_at timestamptz not null default clock_timestamp\(\)/, "recorded_at = giờ máy chủ ghi");
assert.match(scanTable[1], /device_id uuid references public\.print_devices\(id\) on delete set null/, "device_id theo print_devices, xoá máy → null");
assert.match(scanTable[1], /device_name text not null default '' check \(char_length\(device_name\) <= 60\)/, "device_name ≤ 60 ký tự, mặc định ''");
assert.match(scanTable[1], /primary key \(list_id, group_uid_code\)/, "mỗi mã chỉ một lượt quét trong một danh sách");

const fn = name => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: m[1].replace(/\s+/g, " ").trim(), head: m[2], body: m[3] };
};
const imp = fn("uid_block_import"), snap = fn("uid_block_snapshot"), cmp = fn("uid_block_compare");
const scan = fn("uid_block_scan"), scans = fn("uid_block_scans");
assert.equal(imp.params, "p_list jsonb, p_items jsonb");
assert.equal(snap.params, "p_known_list_id uuid default null");
assert.equal(cmp.params, "p_codes text[]");
assert.equal(scan.params, "p_access_token text, p_list_id uuid, p_group_uid text, p_scanned_at timestamptz default null");
assert.equal(scans.params, "p_list_id uuid, p_known_count integer default null");
for (const [name, f] of [["uid_block_import", imp], ["uid_block_snapshot", snap], ["uid_block_compare", cmp], ["uid_block_scan", scan], ["uid_block_scans", scans]]) {
  assert.match(f.head, /returns jsonb/i, `${name} trả jsonb`);
  assert.match(f.head, /security definer/i, `${name} phải SECURITY DEFINER`);
  assert.match(f.head, /set search_path = ''/, `${name} phải set search_path = ''`);
  assert.match(f.body, /'meta',\s*jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, `${name} trả meta {updatedAt, schemaVersion:1}`);
}
for (const [name, f] of [["uid_block_snapshot", snap], ["uid_block_compare", cmp], ["uid_block_scans", scans]]) {
  assert.match(f.head, /\bstable\b/i, `${name} phải stable (chỉ đọc)`);
  assert.doesNotMatch(f.body, /\b(insert|update|delete|truncate)\b|pg_advisory|floor_access_check/i, `${name} không được ghi`);
}
assert.doesNotMatch(imp.head, /\bstable\b/i, "uid_block_import ghi dữ liệu, không được stable");
assert.doesNotMatch(scan.head, /\bstable\b/i, "uid_block_scan ghi dữ liệu, không được stable");

// ---- uid_block_import ----
const firstIf = imp.body.indexOf("if ");
assert.ok(firstIf >= 0 && imp.body.slice(firstIf, firstIf + 60).includes("not public.group_uid_admin_allowed()"), "uid_block_import phải kiểm group_uid_admin_allowed() đầu tiên");
assert.match(imp.body, /'FORBIDDEN'/);
assert.match(imp.body, /pg_advisory_xact_lock\(hashtext\('public\.uid_block_import'\)\)/, "nạp tuần tự bằng advisory lock (hai Admin cùng nạp)");
assert.ok(imp.body.indexOf("pg_advisory_xact_lock") > imp.body.indexOf("group_uid_admin_allowed"), "khoá sau khi kiểm Admin");
assert.match(imp.body, /jsonb_typeof\(p_list\) <> 'object'/, "p_list phải là object");
assert.match(imp.body, /jsonb_typeof\(p_list->'fileName'\) is distinct from 'string'/, "fileName phải là chuỗi");
assert.match(imp.body, /length\(btrim\(p_list->>'fileName'\)\) not between 1 and 200/, "fileName 1–200 ký tự");
assert.match(imp.body, /jsonb_typeof\(p_list->'sheets'\) is distinct from 'array'/, "sheets phải là mảng");
assert.match(imp.body, /jsonb_typeof\(s\.v\) <> 'string'/, "mỗi sheet phải là chuỗi");
assert.match(imp.body, /jsonb_typeof\(p_items\) <> 'array'/, "p_items phải là mảng");
assert.match(imp.body, /jsonb_array_length\(case when jsonb_typeof\(p_items\) = 'array' then p_items else '\[\]'::jsonb end\) not between 1 and 20000\b/, "p_items 1–20.000 phần tử (không gọi jsonb_array_length trên giá trị không phải mảng)");
assert.match(imp.body, /jsonb_typeof\(e\.v\) <> 'object'/, "mỗi dòng phải là object");
assert.match(imp.body, /jsonb_typeof\(e\.v->'groupUid'\) is distinct from 'string'/, "groupUid phải là chuỗi");
assert.match(imp.body, /btrim\(e\.v->>'groupUid'\) !~ '\^\[0-9\]\{16\}\$'/, "groupUid đúng 16 chữ số sau btrim");
for (const f of ["sku", "productName", "lot", "roll", "warehouse", "location", "fileStatus"]) {
  assert.ok(imp.body.includes(`coalesce(jsonb_typeof(e.v->'${f}'),'null') not in ('string','null')`), `trường ${f} phải là chuỗi hoặc null`);
  assert.ok(imp.body.includes(`length(coalesce(e.v->>'${f}','')) > 300`), `trường ${f} tối đa 300 ký tự`);
}
assert.match(imp.body, /'INVALID_INPUT'/, "sai kiểu trả INVALID_INPUT");
assert.doesNotMatch(imp.body, /'INVALID_ROWS'/, "mã lỗi thống nhất INVALID_INPUT");
assert.match(imp.body, /exception when others then[\s\S]*'INVALID_INPUT'/, "lỗi ghi dòng phải trả INVALID_INPUT, không ném lỗi thô");
assert.match(imp.body, /distinct on \(btrim\(e\.v->>'groupUid'\)\)/, "bỏ trùng theo groupUid");
assert.match(imp.body, /\(select auth\.uid\(\)\)/, "ghi người nạp = auth.uid()");
assert.match(imp.body, /clock_timestamp\(\)/, "giờ nạp lấy sau khi khoá (clock_timestamp), không lấy giờ đầu giao dịch");
assert.match(imp.body, /jsonb_object_agg\(/, "by_warehouse đếm theo kho");
assert.match(imp.body, /delete from public\.uid_block_lists\s+where id not in \(select id from public\.uid_block_lists order by imported_at desc, id desc limit 5\)/, "giữ 5 danh sách mới nhất (DELETE dòng)");
for (const k of ["'listId'", "'itemCount'", "'byWarehouse'", "'carriedScans'"]) assert.ok(imp.body.includes(k), `uid_block_import thiếu khoá trả về ${k}`);
// Chép lượt quét của danh sách đang dùng (trước lần nạp) sang danh sách mới cho mã còn có; lấy v_prev sau khoá, trước khi chèn.
const impLock = imp.body.indexOf("pg_advisory_xact_lock(");
const prevSel = imp.body.search(/select l\.id into v_prev\s+from public\.uid_block_lists l\s+order by l\.imported_at desc, l\.id desc\s+limit 1/);
const insList = imp.body.indexOf("insert into public.uid_block_lists");
const insItems = imp.body.indexOf("insert into public.uid_block_items");
const carry = imp.body.search(/insert into public\.uid_block_scans\s*\(list_id, group_uid_code, scanned_at, recorded_at, device_id, device_name\)\s*select v_id, s\.group_uid_code, s\.scanned_at, s\.recorded_at, s\.device_id, s\.device_name\s+from public\.uid_block_scans s\s+join public\.uid_block_items i on i\.list_id = v_id and i\.group_uid_code = s\.group_uid_code\s+where s\.list_id = v_prev;/);
const keep5 = imp.body.indexOf("delete from public.uid_block_lists");
assert.ok(prevSel > impLock, "v_prev (danh sách đang dùng) phải lấy SAU advisory lock");
assert.ok(prevSel >= 0 && prevSel < insList, "v_prev phải lấy TRƯỚC khi chèn danh sách mới");
assert.ok(carry > insItems, "chép lượt quét (giữ scanned_at/recorded_at/máy) sau khi chèn mã của danh sách mới, chỉ mã còn có");
assert.ok(carry >= 0 && carry < keep5, "chép lượt quét TRƯỚC khi xoá danh sách cũ quá 5 (cascade mất lượt quét)");
assert.match(imp.body, /get diagnostics v_carried = row_count;/, "đếm số lượt quét đã chép");
assert.match(imp.body, /'carriedScans',v_carried/, "trả carriedScans = số lượt đã chép");

// ---- uid_block_snapshot ----
assert.match(snap.body, /from public\.uid_block_lists[\s\S]*?order by imported_at desc, id desc\s+limit 1/, "danh sách mới nhất theo imported_at desc, id desc");
assert.match(snap.body, /p_known_list_id is not null and v_list\.id = p_known_list_id/, "trùng id web đang giữ → unchanged");
assert.match(snap.body, /'unchanged',true,'listId',v_list\.id/, "trả {unchanged:true, listId}");
assert.match(snap.body, /'unchanged',false,'list',null,'items','\[\]'::jsonb/, "chưa có danh sách → {list:null, items:[]}");
assert.match(snap.body, /'unchanged',false,\s*'list',\s*jsonb_build_object\(/, "khác → unchanged:false + list");
for (const k of ["'id'", "'fileName'", "'sheets'", "'itemCount'", "'byWarehouse'", "'importedAt'"]) assert.ok(snap.body.includes(k), `list thiếu ${k}`);
for (const k of ["'groupUid'", "'sku'", "'productName'", "'lot'", "'roll'", "'warehouse'", "'location'", "'fileStatus'"]) assert.ok(snap.body.includes(k), `items thiếu ${k}`);
assert.doesNotMatch(snap.body, /group_uid_details/, "snapshot chỉ đọc danh sách đã nạp");

// ---- uid_block_compare ----
assert.match(cmp.body, /cardinality\(p_codes\) > 20000\b/, "compare tối đa 20.000 mã");
assert.match(cmp.body, /'INVALID_INPUT'/, "quá giới hạn trả INVALID_INPUT");
assert.match(cmp.body, /from public\.group_uid_details/, "đối chiếu với group_uid_details");
assert.match(cmp.body, /g\.status = 'Blocked'/, "blockedOutside = status Blocked");
assert.match(cmp.body, /limit 500\b/, "blockedOutside tối đa 500");
for (const k of ["'rows'", "'missing'", "'blockedOutside'", "'blockedOutsideTotal'", "'groupUid'", "'status'", "'qcStatus'", "'warehouse'", "'location'", "'sku'"]) assert.ok(cmp.body.includes(k), `compare thiếu ${k}`);
assert.match(cmp.body, /g\.qc_status/, "rows kèm qc_status");
assert.match(cmp.body, /not exists \(select 1 from (pg_temp\.)?\w+ c where c\.code = g\.group_uid_code\)|not exists \(select 1 from unnest\(/, "blockedOutside loại mã có trong p_codes");
assert.equal((cmp.body.match(/status = 'Blocked'/g) || []).length, 1, "\"Blocked ngoài danh sách\" chỉ truy vấn một lần (đếm + 500 dòng dùng chung)");
assert.equal((cmp.body.match(/from public\.group_uid_details/g) || []).length, 3, "group_uid_details đọc đúng 3 lần: rows, missing, Blocked ngoài");
assert.match(cmp.body, /count\(\*\)/, "vẫn trả tổng blockedOutsideTotal");

// ---- uid_block_scan: ghi lượt quét chung, khoá máy như fabric_issue_scan ----
const firstStmt = scan.body.replace(/^[\s\S]*?\bbegin\b/, "").trim();
assert.match(firstStmt, /^v_access := public\.floor_access_check\(p_access_token, 'uid_block_scan'\);\s*if v_access = 'deny' then return public\.floor_access_denied\(\); end if;/, "uid_block_scan kiểm khoá máy đầu tiên; deny → floor_access_denied()");
const scanReturns = [...scan.body.matchAll(/\breturn\b\s*([^\n]*)/g)].map(m => m[1]);
assert.ok(scanReturns.length >= 7, "uid_block_scan thiếu nhánh trả về");
for (const r of scanReturns) {
  assert.ok(r.startsWith("public.floor_access_denied();") || r.startsWith("public.floor_access_result(v_access, "), `mọi nhánh khác deny phải bọc floor_access_result: return ${r}`);
}
assert.match(scan.body, /v_code := btrim\(p_group_uid\);/, "mã = btrim(p_group_uid)");
assert.match(scan.body, /v_code is null or v_code !~ '\^\[0-9\]\{16\}\$'[\s\S]{0,200}?'INVALID_GROUP_UID'/, "Group UID khác 16 chữ số → INVALID_GROUP_UID");
assert.match(scan.body, /p_list_id is null[\s\S]{0,200}?'INVALID_LIST'/, "thiếu danh sách → INVALID_LIST");
const scanLock = scan.body.indexOf("pg_advisory_xact_lock_shared(hashtext('public.uid_block_import'))");
const scanCur = scan.body.search(/select l\.id into v_list\s+from public\.uid_block_lists l\s+order by l\.imported_at desc, l\.id desc\s+limit 1/);
assert.ok(scanLock >= 0 && scanCur > scanLock, "khoá chia sẻ với uid_block_import trước khi đọc danh sách hiện hành (không mất lượt quét khi Admin nạp chồng)");
assert.match(scan.body, /if v_list is null then[\s\S]{0,200}?'NO_LIST'/, "chưa có danh sách → NO_LIST");
assert.match(scan.body, /if v_list <> p_list_id then[\s\S]{0,200}?'STALE_LIST'[\s\S]{0,200}?'data',jsonb_build_object\('listId',v_list\)/, "web giữ danh sách cũ → STALE_LIST + listId hiện hành");
assert.match(scan.body, /if not exists \(select 1 from public\.uid_block_items i where i\.list_id = v_list and i\.group_uid_code = v_code\) then[\s\S]{0,200}?'result','not_blocked','groupUid',v_code/, "mã ngoài danh sách → not_blocked");
assert.match(scan.body, /v_dev := public\.print_device_by_token\(p_access_token\);/, "máy quét theo khoá máy");
assert.match(scan.body, /from public\.print_devices d where d\.id = v_dev/, "tên máy lấy từ print_devices");
assert.match(scan.body, /p_scanned_at between v_now - interval '2 days' and v_now \+ interval '5 minutes'[\s\S]{0,40}?least\(p_scanned_at, v_now\)[\s\S]{0,20}?else v_now/, "giờ quét web gửi chỉ nhận trong [−2 ngày, +5 phút], không quá giờ máy chủ");
assert.match(scan.body, /v_now := clock_timestamp\(\);/, "giờ máy chủ lấy sau khoá (clock_timestamp)");
assert.match(scan.body, /insert into public\.uid_block_scans\s*\(list_id, group_uid_code, scanned_at, device_id, device_name\)[\s\S]{0,120}?on conflict \(list_id, group_uid_code\) do nothing\s+returning/, "quét trùng (kể cả máy khác) không ghi đè: on conflict do nothing");
assert.match(scan.body, /if found then\s+v_result := 'new';\s+else\s+v_result := 'dup';/, "có dòng mới → new, trùng → dup");
assert.match(scan.body, /'mine',\s*\(v_row\.device_id is not null and v_dev is not null and v_row\.device_id = v_dev\)/, "mine = lượt có sẵn do chính máy này quét");
for (const k of ["'result'", "'groupUid'", "'scannedAt'", "'deviceName'", "'mine'"]) assert.ok(scan.body.includes(k), `uid_block_scan thiếu khoá ${k}`);

// ---- uid_block_scans: mọi máy đọc lượt quét chung ----
assert.match(scans.body, /p_list_id is null[\s\S]{0,200}?'INVALID_LIST'/, "uid_block_scans thiếu danh sách → INVALID_LIST");
assert.match(scans.body, /select count\(\*\)::integer into v_count from public\.uid_block_scans s where s\.list_id = p_list_id;/, "đếm lượt quét của danh sách");
assert.match(scans.body, /if p_known_count is not null and p_known_count = v_count then[\s\S]{0,120}?'unchanged',true,'count',v_count/, "đếm trùng → {unchanged:true}");
assert.match(scans.body, /'unchanged',false,'count',v_count,\s*'rows'/, "khác → unchanged:false + rows");
assert.match(scans.body, /jsonb_build_object\('groupUid',s\.group_uid_code,'scannedAt',s\.scanned_at,'deviceName',s\.device_name\) order by s\.scanned_at, s\.group_uid_code/, "rows {groupUid, scannedAt, deviceName} theo giờ quét");

// ---- Chú thích đầu tệp ----
assert.ok(!sql.includes("không ghi lượt quét lên Supabase"), "chú thích còn câu cũ: lượt quét giữ trên máy");
assert.ok(sql.includes("Chạy migration TRƯỚC khi push index.html (web gọi 5 hàm)"), "chú thích phải nhắc chạy migration trước khi push (5 hàm)");

// ---- Cấp quyền gọi ----
assert.match(code, /revoke all on function public\.uid_block_import\(jsonb,jsonb\) from public, anon;/, "thu hồi uid_block_import khỏi public/anon");
assert.match(code, /grant execute on function public\.uid_block_import\(jsonb,jsonb\) to authenticated;/, "uid_block_import chỉ cấp authenticated");
for (const [name, sig] of [["uid_block_snapshot", "uuid"], ["uid_block_compare", "text\\[\\]"], ["uid_block_scan", "text,uuid,text,timestamptz"], ["uid_block_scans", "uuid,integer"]]) {
  const rv = code.search(new RegExp(`revoke all on function public\\.${name}\\(${sig}\\) from public;`));
  const gr = code.search(new RegExp(`grant execute on function public\\.${name}\\(${sig}\\) to anon, authenticated;`));
  assert.ok(rv >= 0, `${name} chưa thu hồi khỏi public`);
  assert.ok(gr >= 0, `${name} phải cấp anon + authenticated`);
  assert.ok(rv < gr, `${name}: thu hồi public trước khi cấp`);
}
const anonFns = new Set([...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map(m => m[1]));
assert.deepEqual([...anonFns].sort(), ["uid_block_compare", "uid_block_scan", "uid_block_scans", "uid_block_snapshot"], "anon chỉ được gọi hai hàm đọc + hai hàm quét");
const grants = [...code.matchAll(/grant execute on function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual([...new Set(grants)].sort(), ["uid_block_compare", "uid_block_import", "uid_block_scan", "uid_block_scans", "uid_block_snapshot"], "chỉ cấp quyền năm hàm của module");

console.log("uid_block_sql: bảng RLS chỉ service_role, import kiểm Admin + kiểu + 16 số + 20.000 dòng + giữ 5 + chép lượt quét, snapshot unchanged, compare Blocked ngoài tệp một lần, scan khoá máy + new/dup/not_blocked/STALE_LIST, scans unchanged theo đếm — passed");
