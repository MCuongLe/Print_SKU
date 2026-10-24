// TRẢ NHÀ CUNG CẤP (supabase/vendor_return_v1.sql, 24/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * ba bảng vendor_return_lists / vendor_return_items / vendor_return_scans bật RLS, không policy, thu hồi khỏi
//     public/anon/authenticated, chỉ service_role; một danh sách đang dùng (index unique một phần where active);
//   * vendor_return_import: SECURITY DEFINER + search_path '', kiểm group_uid_admin_allowed() đầu tiên, chỉ cấp authenticated,
//     kiểm kiểu từng trường (INVALID_INPUT), 1–2.000 dòng, Group UID 10–40 chữ số, màu navy|black, trùng mã → DUPLICATE_UID
//     (không tự bỏ trùng), danh sách mới active + danh sách cũ active=false (KHÔNG xoá), chép lượt quét (carriedScans);
//   * vendor_return_snapshot: chỉ đọc (stable), cấp anon + authenticated, danh sách active + items kèm lượt quét;
//   * vendor_return_scan: khoá máy qua floor_access_check như uid_block_scan (deny → floor_access_denied, mọi nhánh khác bọc
//     floor_access_result), STALE_LIST, not_in_list, on conflict do nothing → new / dup;
//   * anon chỉ được gọi snapshot + scan; chỉ thêm (không drop / truncate / delete / alter … drop), có begin/commit + notify pgrst.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.VENDOR_RETURN_SQL || path.join(__dirname, "..", "supabase", "vendor_return_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/vendor_return_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

// ---- Khung giao dịch, chỉ thêm ----
assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /commit;\s*\nnotify pgrst,\s*'reload schema'/, "thiếu notify pgrst sau commit");
assert.doesNotMatch(code, /\bdrop\s+(table|function|index|policy|view|trigger|schema|type)|\btruncate\b|alter\s+table[^;]*\bdrop\b/i, "migration chỉ được thêm, không drop/truncate");
assert.doesNotMatch(code, /\bdelete\s+from\b/i, "không xoá danh sách / dòng nào (người dùng sẽ báo dọn)");
assert.ok(sql.includes("python scripts/apply_supabase_sql.py supabase/vendor_return_v1.sql"), "tiêu đề phải ghi lệnh chạy migration");
assert.match(sql, /^-- [^\n]*\n(--[^\n]*\n)*-- Vì sao:/, "tiêu đề phải nêu vì sao");
assert.match(sql, /Tác động:/, "tiêu đề phải nêu tác động");

// ---- Bảng: chỉ service_role ----
for (const t of ["vendor_return_lists", "vendor_return_items", "vendor_return_scans"]) {
  assert.match(code, new RegExp(`create table if not exists public\\.${t} \\(`), `thiếu bảng ${t}`);
  assert.match(code, new RegExp(`alter table public\\.${t} enable row level security`), `${t} chưa bật RLS`);
  assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated`), `${t} chưa thu hồi quyền`);
  assert.match(code, new RegExp(`grant [^;]* on public\\.${t} to service_role;`), `${t} chưa cấp service_role`);
  assert.doesNotMatch(code, new RegExp(`grant [^;]* on public\\.${t} to [^;]*\\b(anon|authenticated|public)\\b`), `${t} không được cấp cho anon/authenticated`);
  assert.doesNotMatch(code, new RegExp(`create policy [^;]* on public\\.${t}\\b`), `${t} không có policy (chỉ đi qua hàm)`);
}
const table = name => {
  const m = code.match(new RegExp(`create table if not exists public\\.${name} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(m, `không đọc được định nghĩa ${name}`);
  return m[1];
};
const lists = table("vendor_return_lists");
for (const col of ["id uuid primary key default gen_random_uuid\\(\\)", "file_name text not null", "item_count integer not null",
                   "created_at timestamptz not null default now\\(\\)", "created_by uuid", "active boolean not null default false"]) {
  assert.match(lists, new RegExp(col), `vendor_return_lists thiếu cột ${col}`);
}
assert.match(code, /create unique index if not exists \w+ on public\.vendor_return_lists \(\(true\)\) where active;/, "chỉ một danh sách active (unique một phần)");

const items = table("vendor_return_items");
assert.match(items, /list_id uuid not null references public\.vendor_return_lists\(id\) on delete cascade/, "dòng xoá theo danh sách (cascade)");
assert.match(items, /group_uid_code text not null check \(group_uid_code ~ '\^\[0-9\]\{10,40\}\$'\)/, "bảng chặn Group UID ngoài 10–40 chữ số");
assert.match(items, /color text not null check \(color in \('navy', 'black'\)\)/, "màu chỉ navy | black");
for (const col of ["sku", "product_name", "lot", "roll", "location"]) {
  assert.match(items, new RegExp(`\\b${col} text check \\(${col} is null or length\\(${col}\\) <= 300\\)`), `vendor_return_items thiếu cột ${col} (≤ 300)`);
}
assert.match(items, /\bqty numeric check \(qty is null or qty >= 0\)/, "qty numeric, không âm");
assert.match(items, /primary key \(list_id, group_uid_code\)/, "khoá chính (list_id, group_uid_code)");

const scansT = table("vendor_return_scans");
assert.match(scansT, /list_id uuid not null references public\.vendor_return_lists\(id\) on delete cascade/, "lượt quét xoá theo danh sách (cascade)");
assert.match(scansT, /group_uid_code text not null,/, "lượt quét có mã");
assert.match(scansT, /device_id uuid references public\.print_devices\(id\) on delete set null/, "device_id theo print_devices, xoá máy → null");
assert.match(scansT, /device_name text not null default '' check \(char_length\(device_name\) <= 60\)/, "device_name ≤ 60 ký tự, mặc định ''");
assert.match(scansT, /scanned_at timestamptz not null default clock_timestamp\(\)/, "scanned_at = giờ máy chủ");
assert.match(scansT, /primary key \(list_id, group_uid_code\)/, "mỗi mã chỉ một lượt quét trong một danh sách");
assert.match(scansT, /foreign key \(list_id, group_uid_code\) references public\.vendor_return_items\(list_id, group_uid_code\) on delete cascade/, "lượt quét chỉ cho mã có trong danh sách");
assert.match(code, /create index if not exists \w+ on public\.vendor_return_scans \(device_id\)/, "index FK device_id (xoá máy set null)");

// ---- Hàm ----
const fn = name => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\(([^)]*)\\)([\\s\\S]*?)\\$\\$([\\s\\S]*?)\\$\\$`));
  assert.ok(m, `thiếu hàm ${name}`);
  return { params: m[1].replace(/\s+/g, " ").trim(), head: m[2], body: m[3] };
};
const imp = fn("vendor_return_import"), snap = fn("vendor_return_snapshot"), scan = fn("vendor_return_scan");
assert.equal(imp.params, "p_file_name text, p_items jsonb");
assert.equal(snap.params, "");
assert.equal(scan.params, "p_access_token text, p_list_id uuid, p_group_uid text");
for (const [name, f] of [["vendor_return_import", imp], ["vendor_return_snapshot", snap], ["vendor_return_scan", scan]]) {
  assert.match(f.head, /returns jsonb/i, `${name} trả jsonb`);
  assert.match(f.head, /security definer/i, `${name} phải SECURITY DEFINER`);
  assert.match(f.head, /set search_path = ''/, `${name} phải set search_path = ''`);
  assert.match(f.body, /'meta',\s*jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, `${name} trả meta {updatedAt, schemaVersion:1}`);
}
assert.match(snap.head, /\bstable\b/i, "vendor_return_snapshot phải stable (chỉ đọc)");
assert.doesNotMatch(snap.body, /\b(insert|update|delete|truncate)\b|pg_advisory|floor_access_check/i, "vendor_return_snapshot không được ghi");
assert.doesNotMatch(imp.head, /\bstable\b/i, "vendor_return_import ghi dữ liệu, không được stable");
assert.doesNotMatch(scan.head, /\bstable\b/i, "vendor_return_scan ghi dữ liệu, không được stable");

// ---- vendor_return_import ----
const firstIf = imp.body.indexOf("if ");
assert.ok(firstIf >= 0 && imp.body.slice(firstIf, firstIf + 60).includes("not public.group_uid_admin_allowed()"), "vendor_return_import phải kiểm group_uid_admin_allowed() đầu tiên");
assert.match(imp.body, /not public\.group_uid_admin_allowed\(\) then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','FORBIDDEN'/, "không phải Admin → FORBIDDEN");
assert.match(imp.body, /pg_advisory_xact_lock\(hashtext\('public\.vendor_return_import'\)\)/, "nạp tuần tự bằng advisory lock");
assert.ok(imp.body.indexOf("pg_advisory_xact_lock") > imp.body.indexOf("group_uid_admin_allowed"), "khoá sau khi kiểm Admin");
assert.match(imp.body, /p_file_name is null or length\(btrim\(p_file_name\)\) not between 1 and 200/, "tên tệp 1–200 ký tự");
assert.match(imp.body, /jsonb_typeof\(p_items\) <> 'array'/, "p_items phải là mảng");
assert.match(imp.body, /jsonb_array_length\(case when jsonb_typeof\(p_items\) = 'array' then p_items else '\[\]'::jsonb end\) not between 1 and 2000\b/, "p_items 1–2.000 phần tử (không gọi jsonb_array_length trên giá trị không phải mảng)");
assert.match(imp.body, /jsonb_typeof\(e\.v\) <> 'object'/, "mỗi dòng phải là object");
assert.match(imp.body, /jsonb_typeof\(e\.v->'groupUid'\) is distinct from 'string'/, "groupUid phải là chuỗi");
assert.match(imp.body, /btrim\(e\.v->>'groupUid'\) !~ '\^\[0-9\]\{10,40\}\$'/, "groupUid 10–40 chữ số sau btrim");
assert.match(imp.body, /jsonb_typeof\(e\.v->'color'\) is distinct from 'string'/, "color phải là chuỗi");
assert.match(imp.body, /e\.v->>'color' not in \('navy','black'\)/, "color chỉ navy | black");
// Review vòng 2: SKU bắt buộc (dòng hàng thật luôn có SKU; nhãn bảng pivot thì không) — các trường chữ khác chuỗi hoặc null
assert.ok(imp.body.includes("jsonb_typeof(e.v->'sku') is distinct from 'string' or btrim(e.v->>'sku') = ''"), "sku bắt buộc, không rỗng");
for (const f of ["sku", "productName", "lot", "roll", "location"]) {
  if (f !== "sku") assert.ok(imp.body.includes(`coalesce(jsonb_typeof(e.v->'${f}'),'null') not in ('string','null')`), `trường ${f} phải là chuỗi hoặc null`);
  assert.ok(imp.body.includes(`length(coalesce(e.v->>'${f}','')) > 300`), `trường ${f} tối đa 300 ký tự`);
}
assert.ok(imp.body.includes("coalesce(jsonb_typeof(e.v->'qty'),'null') not in ('number','null')"), "qty phải là số hoặc null");
assert.match(imp.body, /\(e\.v->>'qty'\)::numeric < 0/, "qty không âm");
assert.match(imp.body, /'INVALID_INPUT'/, "sai kiểu trả INVALID_INPUT");
// Trùng mã → lỗi rõ, không tự bỏ trùng
assert.match(imp.body, /group by btrim\(e\.v->>'groupUid'\)\s+having count\(\*\) > 1\s*\n\s*\)/, "tìm Group UID trùng trong tệp (xuất hiện từ 2 lần)");
assert.match(imp.body, /if v_dup_count > 0 then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','DUPLICATE_UID'/, "có mã trùng → dừng, trả DUPLICATE_UID");
assert.match(imp.body, /'code','DUPLICATE_UID'/, "trùng mã → DUPLICATE_UID");
assert.match(imp.body, /'data',jsonb_build_object\('duplicates',/, "DUPLICATE_UID kèm danh sách mã trùng");
assert.doesNotMatch(imp.body, /distinct on/i, "không tự bỏ trùng (người dùng cần biết tệp trùng)");
assert.ok(imp.body.indexOf("'DUPLICATE_UID'") < imp.body.indexOf("insert into public.vendor_return_lists"), "kiểm trùng trước khi ghi");
// Danh sách mới thay danh sách đang dùng; chép lượt quét
const impLock = imp.body.indexOf("pg_advisory_xact_lock(");
const prevSel = imp.body.search(/select l\.id into v_prev\s+from public\.vendor_return_lists l\s+where l\.active/);
const deact = imp.body.search(/update public\.vendor_return_lists set active = false where active;/);
const insList = imp.body.indexOf("insert into public.vendor_return_lists");
const insItems = imp.body.indexOf("insert into public.vendor_return_items");
const carry = imp.body.search(/insert into public\.vendor_return_scans\s*\(list_id, group_uid_code, device_id, device_name, scanned_at\)\s*select v_id, s\.group_uid_code, s\.device_id, s\.device_name, s\.scanned_at\s+from public\.vendor_return_scans s\s+join public\.vendor_return_items i on i\.list_id = v_id and i\.group_uid_code = s\.group_uid_code\s+where s\.list_id = v_prev;/);
const exc = imp.body.indexOf("exception when others then");
assert.ok(prevSel > impLock, "v_prev (danh sách đang dùng) phải lấy SAU advisory lock");
assert.ok(deact > prevSel, "tắt danh sách cũ sau khi đã nhớ v_prev");
assert.ok(insList > deact, "tắt danh sách cũ TRƯỚC khi chèn danh sách mới (unique where active)");
assert.ok(insItems > insList && carry > insItems, "chép lượt quét sau khi chèn mã của danh sách mới, chỉ mã còn có");
assert.ok(exc > carry, "tắt cũ + chèn + chép nằm trong khối exception (lỗi → không đổi gì)");
assert.match(imp.body.slice(insList, insList + 260), /values \(btrim\(p_file_name\), 0, true, \(select auth\.uid\(\)\), clock_timestamp\(\)\)/, "danh sách mới active, người nạp = auth.uid(), giờ sau khoá");
assert.match(imp.body, /exception when others then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','INVALID_INPUT'/, "lỗi ghi trả INVALID_INPUT, không ném lỗi thô");
assert.match(imp.body, /get diagnostics v_carried = row_count;/, "đếm số lượt quét đã chép");
assert.match(imp.body, /'listId',v_id,'itemCount',v_count,'navy',v_navy,'black',v_black,'carriedScans',v_carried/, "trả {listId, itemCount, navy, black, carriedScans}");

// ---- vendor_return_snapshot ----
assert.match(snap.body, /from public\.vendor_return_lists l where l\.active/, "đọc danh sách active");
assert.match(snap.body, /if not found then\s+return jsonb_build_object\('ok',true,'data',jsonb_build_object\('list',null,'items','\[\]'::jsonb\)/, "chưa có danh sách → {list:null, items:[]}");
assert.match(snap.body, /'list',\s*jsonb_build_object\('id',v_list\.id,'fileName',v_list\.file_name,'createdAt',v_list\.created_at,'itemCount',v_list\.item_count\)/, "list {id, fileName, createdAt, itemCount}");
assert.match(snap.body, /jsonb_build_object\('groupUid',i\.group_uid_code,'color',i\.color,'sku',i\.sku,'productName',i\.product_name,'lot',i\.lot,\s*'roll',i\.roll,'location',i\.location,'qty',i\.qty,'scannedAt',s\.scanned_at,'device',s\.device_name\)\s+order by i\.color, i\.location, i\.group_uid_code/, "items đủ trường, sắp theo màu, vị trí, mã");
assert.match(snap.body, /left join public\.vendor_return_scans s on s\.list_id = i\.list_id and s\.group_uid_code = i\.group_uid_code/, "items kèm lượt quét (chưa quét → null)");

// ---- vendor_return_scan ----
const firstStmt = scan.body.replace(/^[\s\S]*?\bbegin\b/, "").trim();
assert.match(firstStmt, /^v_access := public\.floor_access_check\(p_access_token, 'vendor_return_scan'\);\s*if v_access = 'deny' then return public\.floor_access_denied\(\); end if;/, "kiểm khoá máy đầu tiên; deny → floor_access_denied()");
const scanReturns = [...scan.body.matchAll(/\breturn\b\s*([^\n]*)/g)].map(m => m[1]);
assert.ok(scanReturns.length >= 7, "vendor_return_scan thiếu nhánh trả về");
for (const r of scanReturns) {
  assert.ok(r.startsWith("public.floor_access_denied();") || r.startsWith("public.floor_access_result(v_access, "), `mọi nhánh khác deny phải bọc floor_access_result: return ${r}`);
}
assert.match(scan.body, /v_code := btrim\(p_group_uid\);/, "mã = btrim(p_group_uid)");
assert.match(scan.body, /v_code is null or v_code !~ '\^\[0-9\]\{10,40\}\$'[\s\S]{0,200}?'INVALID_GROUP_UID'/, "mã sai dạng → INVALID_GROUP_UID");
assert.match(scan.body, /p_list_id is null[\s\S]{0,200}?'INVALID_LIST'/, "thiếu danh sách → INVALID_LIST");
const scanLock = scan.body.indexOf("pg_advisory_xact_lock_shared(hashtext('public.vendor_return_import'))");
const scanCur = scan.body.search(/select l\.id into v_list\s+from public\.vendor_return_lists l\s+where l\.active/);
assert.ok(scanLock >= 0 && scanCur > scanLock, "khoá chia sẻ với vendor_return_import trước khi đọc danh sách active");
assert.match(scan.body, /if v_list is null then[\s\S]{0,200}?'NO_LIST'/, "chưa có danh sách → NO_LIST");
assert.match(scan.body, /if v_list <> p_list_id then[\s\S]{0,200}?'STALE_LIST'[\s\S]{0,200}?'data',jsonb_build_object\('listId',v_list\)/, "danh sách không còn active → STALE_LIST + listId hiện hành");
assert.match(scan.body, /select i\.color into v_color\s+from public\.vendor_return_items i where i\.list_id = v_list and i\.group_uid_code = v_code;\s+if not found then[\s\S]{0,200}?'result','not_in_list','groupUid',v_code/, "mã ngoài danh sách → not_in_list (không ghi)");
assert.match(scan.body, /v_dev := public\.print_device_by_token\(p_access_token\);/, "máy quét theo khoá máy");
assert.match(scan.body, /from public\.print_devices d where d\.id = v_dev/, "tên máy lấy từ print_devices");
assert.match(scan.body, /insert into public\.vendor_return_scans\s*\(list_id, group_uid_code, device_id, device_name, scanned_at\)[\s\S]{0,120}?on conflict \(list_id, group_uid_code\) do nothing\s+returning/, "quét trùng (kể cả hai máy cùng lúc) không ghi đè");
assert.match(scan.body, /if found then\s+v_result := 'new';\s+else\s+v_result := 'dup';/, "có dòng mới → new, trùng → dup");
assert.match(scan.body, /'result',v_result,'groupUid',v_code,'color',v_color,'scannedAt',v_row\.scanned_at,'device',coalesce\(v_row\.device_name,''\)/, "new/dup trả {result, groupUid, color, scannedAt, device} của lượt đầu");

// ---- Cấp quyền gọi ----
for (const [name, sig, roles] of [["vendor_return_import", "text,jsonb", "authenticated"],
                                  ["vendor_return_snapshot", "", "anon, authenticated"],
                                  ["vendor_return_scan", "text,uuid,text", "anon, authenticated"]]) {
  const rv = code.search(new RegExp(`revoke all on function public\\.${name}\\(${sig}\\) from public, anon, authenticated;`));
  const gr = code.search(new RegExp(`grant execute on function public\\.${name}\\(${sig}\\) to ${roles};`));
  assert.ok(rv >= 0, `${name} chưa thu hồi khỏi public, anon, authenticated`);
  assert.ok(gr >= 0, `${name} phải cấp ${roles}`);
  assert.ok(rv < gr, `${name}: thu hồi trước khi cấp`);
}
const anonFns = new Set([...code.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to [^;]*\banon\b/g)].map(m => m[1]));
assert.deepEqual([...anonFns].sort(), ["vendor_return_scan", "vendor_return_snapshot"], "anon chỉ được gọi snapshot + scan");
const grants = [...code.matchAll(/grant execute on function public\.(\w+)\(/g)].map(m => m[1]);
assert.deepEqual([...new Set(grants)].sort(), ["vendor_return_import", "vendor_return_scan", "vendor_return_snapshot"], "chỉ cấp quyền ba hàm của module");

console.log("vendor_return_sql: bảng RLS chỉ service_role + một danh sách active, import kiểm Admin + kiểu + 10–40 số + màu + 2.000 dòng + trùng → DUPLICATE_UID + chép lượt quét + không xoá, snapshot active, scan khoá máy + new/dup/not_in_list/STALE_LIST — passed");
