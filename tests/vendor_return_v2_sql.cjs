// Migration supabase/vendor_return_v2.sql (24/10/2026): vị trí HIỆN TẠI + nút Đối chiếu (Admin đọc WMS qua Extension).
//   node tests/vendor_return_v2_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const sql = fs.readFileSync("supabase/vendor_return_v2.sql", "utf8").replace(/\r\n/g, "\n");
const body = sql.replace(/^--.*$/gm, "");
assert.ok(/^begin;$/m.test(body) && /^commit;$/m.test(body), "một giao dịch");
assert.match(body, /notify pgrst, 'reload schema';/);
assert.ok(!/\bdrop\s|\btruncate\b|\bdelete\s+from\b/i.test(body), "không lệnh xoá (không cần --allow-destructive)");
assert.deepEqual([...body.matchAll(/create or replace function (public\.\w+)\(/g)].map(m => m[1]), ["public.vendor_return_snapshot", "public.vendor_return_reconcile"]);
for (const m of body.matchAll(/create or replace function public\.\w+\([^)]*\)\s+returns jsonb language plpgsql (stable|volatile) security definer set search_path = '' as \$\$/g)) assert.ok(m);
assert.equal([...body.matchAll(/security definer set search_path = ''/g)].length, 2, "hai hàm definer + search_path ''");
// Cột mới chỉ thêm
assert.match(body, /alter table public\.vendor_return_items\s+add column if not exists wms_location text check \(wms_location is null or length\(wms_location\) <= 300\),\s+add column if not exists wms_status text check \(wms_status is null or length\(wms_status\) <= 100\),\s+add column if not exists wms_updated_at timestamptz;/);
assert.match(body, /alter table public\.vendor_return_lists\s+add column if not exists reconciled_at timestamptz,\s+add column if not exists reconciled_by uuid;/);
// Snapshot: nguồn = bản mới hơn giữa đối chiếu và đồng bộ tự động, thiếu thì Excel; vị trí + trạng thái lấy ĐÚNG nguồn đó (rỗng giữ rỗng —
// review vòng 1: không lùi về vị trí cũ khi WMS báo UID đã rời kho); giữ trường cũ
const snap = body.slice(body.indexOf("function public.vendor_return_snapshot"), body.indexOf("function public.vendor_return_reconcile"));
assert.match(snap, /left join public\.group_uid_details d on d\.group_uid_code = i\.group_uid_code/);
assert.match(snap, /case when i\.wms_updated_at is not null and \(d\.updated_date is null or i\.wms_updated_at >= d\.updated_date\) then 'wms'\s+when d\.group_uid_code is not null then 'sync' else 'file' end as src/);
assert.match(snap, /case y\.src when 'wms' then y\.wms_location when 'sync' then nullif\(btrim\(y\.d_location\),''\) else y\.location end as cur/);
assert.match(snap, /case y\.src when 'wms' then y\.wms_status when 'sync' then y\.d_status end as cur_status/);
assert.ok(!/coalesce\([^)]*wms_location/.test(snap), "không lùi từ vị trí WMS rỗng về vị trí cũ");
assert.match(snap, /'currentLocation',x\.cur,'status',x\.cur_status,'locationSource',x\.src,'warehouse',x\.warehouse/);
assert.match(snap, /'reconciledAt',v_list\.reconciled_at/);
assert.match(snap, /order by x\.color, x\.cur, x\.group_uid_code/);
for (const f of ["groupUid", "color", "sku", "productName", "lot", "roll", "location", "qty", "scannedAt", "device"]) assert.ok(snap.includes(`'${f}',`), `giữ trường ${f}`);
// Đối chiếu: chỉ Admin, chỉ danh sách đang dùng, ≤ 5.000 dòng, kiểm dạng, giữ bản mới hơn
const rec = body.slice(body.indexOf("function public.vendor_return_reconcile"));
assert.match(rec, /begin\s+if not public\.group_uid_admin_allowed\(\) then/, "kiểm Admin đầu tiên");
assert.match(rec, /'STALE_LIST'/);
assert.match(rec, /jsonb_array_length\(p_rows\) > 5000/);
assert.match(rec, /btrim\(e\.v->>'groupUid'\) !~ '\^\[0-9\]\{10,40\}\$'/);
assert.match(rec, /where i\.list_id = v_active and i\.group_uid_code = r\.code\s+and \(i\.wms_updated_at is null or r\.at > i\.wms_updated_at\s+or \(r\.at = i\.wms_updated_at and \(i\.wms_location, i\.wms_status\) is distinct from \(r\.loc, r\.st\)\)\)/, "chỉ mã thuộc danh sách, giữ bản mới hơn, không đếm dòng y hệt");
// Vị trí / trạng thái rỗng hợp lệ (→ null); updatedAt phải đọc được và không quá 1 ngày tương lai (review vòng 1: không nổ lỗi cast thô)
assert.match(rec, /jsonb_typeof\(e\.v->'location'\) not in \('string','null'\)/);
assert.match(rec, /jsonb_typeof\(e\.v->'status'\) not in \('string','null'\)/);
assert.match(rec, /case when pg_input_is_valid\(e\.v->>'updatedAt', 'timestamptz'\) then \(e\.v->>'updatedAt'\)::timestamptz > v_at \+ interval '1 day' else true end/);
assert.match(rec, /nullif\(btrim\(e\.v->>'location'\),''\) as loc,\s+nullif\(btrim\(e\.v->>'status'\),''\) as st/);
assert.match(rec, /set wms_location = r\.loc, wms_status = r\.st, wms_updated_at = r\.at/);
assert.match(rec, /update public\.vendor_return_lists set reconciled_at = greatest\(reconciled_at, v_at\)/, "mốc không lùi khi hai lượt chạy chồng");
assert.match(rec, /end if;\s+-- Khoá chia sẻ[^\n]*\n\s+perform pg_advisory_xact_lock_shared\(hashtext\('public\.vendor_return_import'\)\);\s+select l\.id into v_active/, "khoá chia sẻ với nạp danh sách TRƯỚC khi đọc danh sách đang dùng");
assert.match(rec, /or not \(e\.v \? 'location'\) or not \(e\.v \? 'status'\)/, "thiếu khoá vị trí / trạng thái = sai dạng (không coi là rỗng)");
assert.match(body, /revoke all on function public\.vendor_return_reconcile\(uuid, jsonb\) from public, anon, authenticated;\s+grant execute on function public\.vendor_return_reconcile\(uuid, jsonb\) to authenticated;/);
assert.ok(!/grant execute on function public\.vendor_return_snapshot/.test(body), "snapshot giữ quyền cũ");
console.log("vendor_return_v2_sql: cột wms_location/wms_status/reconciled_at (chỉ thêm), snapshot nguồn mới hơn thắng (rỗng giữ rỗng, status, locationSource), vendor_return_reconcile Admin + STALE_LIST + ≤ 5.000 + kiểm updatedAt + giữ bản mới hơn — passed");
