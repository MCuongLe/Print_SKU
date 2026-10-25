// Migration supabase/vendor_return_v3.sql (26/10/2026): Admin XOÁ đợt Trả nhà cung cấp đang dùng. Không có Postgres cục bộ: kiểm văn bản.
//   node tests/vendor_return_v3_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = name => fs.readFileSync(path.join(__dirname, "..", "supabase", name), "utf8").replace(/\r\n/g, "\n");
const sql = read("vendor_return_v3.sql");
const body = sql.replace(/^--.*$/gm, "");

// ---- Khung: một giao dịch, thêm đúng một hàm, không đụng bảng / hàm cũ ----
assert.ok(/^begin;$/m.test(body) && /^commit;$/m.test(body), "một giao dịch");
assert.match(body, /commit;\s*\nnotify pgrst, 'reload schema';/);
assert.ok(sql.includes("python scripts/apply_supabase_sql.py supabase/vendor_return_v3.sql"), "tiêu đề ghi lệnh chạy");
assert.match(sql, /^-- [^\n]*\n(--[^\n]*\n)*-- Vì sao:/, "tiêu đề nêu vì sao");
assert.match(sql, /Tác động:/, "tiêu đề nêu tác động");
assert.deepEqual([...body.matchAll(/create or replace function (public\.\w+)\(/g)].map(m => m[1]), ["public.vendor_return_delete"], "chỉ thêm một hàm");
assert.ok(!/\bdrop\s|\btruncate\b|\balter\s+table\b|\bcreate\s+table\b/i.test(body), "không drop / truncate / đổi bảng");
// delete from chỉ nằm trong thân hàm (apply_supabase_sql.py bỏ qua thân hàm → không cần --allow-destructive), đúng một câu, có where theo id đợt
assert.equal([...body.matchAll(/\bdelete\s+from\b/gi)].length, 1);
const m = body.match(/create or replace function public\.vendor_return_delete\(([^)]*)\)\s+returns jsonb language plpgsql volatile security definer set search_path = '' as \$\$([\s\S]*?)end\$\$;/);
assert.ok(m, "hàm SECURITY DEFINER, volatile, search_path = ''");
assert.equal(m[1].trim(), "p_list_id uuid");
const fn = m[2];
assert.match(fn, /delete from public\.vendor_return_lists where id = v_active;/, "xoá đúng đợt đang dùng theo id, có where");
assert.ok(!/delete from public\.vendor_return_(items|scans)/.test(fn), "dòng + lượt quét xoá theo đợt bằng ON DELETE CASCADE, không xoá rời");

// ---- Thứ tự kiểm: Admin trước hết → danh sách null → khoá độc quyền → đợt đang dùng → đúng đợt → đếm → xoá ----
const at = re => { const i = fn.search(re); assert.ok(i >= 0, `thiếu ${re}`); return i; };
const iAdmin = at(/if not public\.group_uid_admin_allowed\(\) then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','FORBIDDEN'/);
const iNull = at(/if p_list_id is null then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','INVALID_LIST'/);
const iLock = at(/perform pg_advisory_xact_lock\(hashtext\('public\.vendor_return_import'\)\);/);   // độc quyền (KHÔNG _shared), chung khoá với nạp / quét / đối chiếu
const iSel = at(/select l\.id into v_active from public\.vendor_return_lists l where l\.active limit 1;/);
const iNo = at(/if v_active is null then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','NO_LIST'/);
const iStale = at(/if p_list_id <> v_active then\s+return jsonb_build_object\('ok',false,'error',jsonb_build_object\('code','STALE_LIST'[\s\S]*?'data',jsonb_build_object\('listId',v_active\)\)\);/);
const iCnt = at(/select count\(\*\)::integer into v_items from public\.vendor_return_items i where i\.list_id = v_active;\s+select count\(\*\)::integer into v_scans from public\.vendor_return_scans s where s\.list_id = v_active;/);
const iDel = at(/delete from public\.vendor_return_lists where id = v_active;/);
assert.equal(iAdmin, fn.indexOf("if not public.group_uid_admin_allowed()"), "kiểm Admin đầu tiên");
assert.ok(iAdmin < iNull && iNull < iLock && iLock < iSel && iSel < iNo && iNo < iStale && iStale < iCnt && iCnt < iDel, "thứ tự: Admin → null → khoá → đọc đợt đang dùng → NO_LIST → STALE_LIST → đếm → xoá");
assert.ok(!/pg_advisory_xact_lock_shared/.test(fn), "khoá độc quyền để chờ lượt quét / đối chiếu (khoá chia sẻ) xong");
assert.ok(!/exception when others/.test(fn), "lỗi thật không bị nuốt thành 'đã xoá'");
assert.match(fn, /'data',jsonb_build_object\('deleted',true,'listId',v_active,'items',v_items,'scans',v_scans\),\s+'meta',jsonb_build_object\('updatedAt',now\(\),'schemaVersion',1\)/, "trả số dòng + số lượt quét đã xoá");
// Mọi nhánh trả về đều là JSON {ok}; không có đường xoá nào đi qua mà thiếu kiểm Admin
for (const r of [...fn.matchAll(/\breturn\b\s+jsonb_build_object\('ok',(true|false)/g)]) assert.ok(r.index > iAdmin, "mọi return sau kiểm Admin");

// ---- Quyền: chỉ authenticated; anon / public không gọi được ----
assert.match(body, /revoke all on function public\.vendor_return_delete\(uuid\) from public, anon, authenticated;\s+grant execute on function public\.vendor_return_delete\(uuid\) to authenticated;/);
assert.deepEqual([...body.matchAll(/grant execute on function public\.(\w+)\([^)]*\) to ([^;]+);/g)].map(g => [g[1], g[2]]), [["vendor_return_delete", "authenticated"]], "chỉ cấp một hàm, chỉ cho authenticated");
assert.ok(!/\banon\b/.test(body.replace(/revoke all on function[^;]*;/, "")), "không cấp gì cho anon");

// ---- Bảng v1: khoá ngoại ON DELETE CASCADE là điều kiện để xoá đợt xoá luôn dòng + lượt quét ----
const v1 = read("vendor_return_v1.sql").replace(/^--.*$/gm, "");
assert.match(v1, /create table if not exists public\.vendor_return_items \([\s\S]*?list_id uuid not null references public\.vendor_return_lists\(id\) on delete cascade/);
assert.match(v1, /create table if not exists public\.vendor_return_scans \([\s\S]*?list_id uuid not null references public\.vendor_return_lists\(id\) on delete cascade/);
assert.match(v1, /foreign key \(list_id, group_uid_code\) references public\.vendor_return_items\(list_id, group_uid_code\) on delete cascade/);

console.log("vendor_return_v3_sql: vendor_return_delete (SECURITY DEFINER, search_path '') Admin trước hết → INVALID_LIST → khoá độc quyền → NO_LIST / STALE_LIST (không xoá) → đếm → xoá đợt đang dùng (cascade dòng + lượt quét), chỉ authenticated — passed");
