// Migration supabase/sku_po_receipts_v1.sql (23/10/2026, in lại tem SKU có PO): kiểm tĩnh cấu trúc, quyền và các chốt an toàn.
//   node tests/sku_po_receipts_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");

const sql = fs.readFileSync("supabase/sku_po_receipts_v1.sql", "utf8").replace(/\r\n/g, "\n");
const body = sql.replace(/^--.*$/gm, "");

assert.ok(/^begin;$/m.test(body) && /^commit;$/m.test(body), "chạy trong một giao dịch");
assert.ok(/notify pgrst, 'reload schema';/.test(body), "nạp lại schema PostgREST");
assert.ok(!/\bdrop\s+(table|schema|function|trigger|index|policy|view|type)\b|\btruncate\b|\bdelete\s+from\b|alter\s+table[^;]*\bdrop\b/i.test(body), "không có lệnh xoá (không cần --allow-destructive)");
assert.ok(!/print_enqueue|print_agent_claim|print_jobs_purge/.test(body), "không đụng hàm in cũ");

// Bảng: khoá sku + po, RLS bật, không ai ngoài service_role đọc/ghi trực tiếp
assert.match(body, /create table if not exists public\.sku_po_receipts \([\s\S]*primary key \(sku, po\)/);
assert.match(body, /alter table public\.sku_po_receipts enable row level security;/);
assert.match(body, /revoke all on table public\.sku_po_receipts from public, anon, authenticated;/);
assert.ok(!/create policy/i.test(body), "không policy: chỉ service_role");

// Mọi hàm: security definer + search_path rỗng
const fns = [...body.matchAll(/create or replace function (public\.\w+)\(([^)]*)\)\s*returns[^$]*?\$\$/g)];
assert.deepEqual(fns.map(m => m[1]), ["public._sku_po_receipts_capture", "public.sku_po_receipts_on_print_job", "public.sku_po_lookup"]);
for (const m of fns) assert.match(m[0], /security definer set search_path = ''/, `${m[1]} security definer + search_path ''`);

// Trigger: sau insert print_jobs, chỉ lệnh sku template 2; lỗi ghi nhật ký không chặn lệnh in
assert.match(body, /create or replace trigger sku_po_receipts_capture\s+after insert on public\.print_jobs\s+for each row when \(new\.type = 'sku' and new\.template_version in \(2, 3\)\)\s+execute function public\.sku_po_receipts_on_print_job\(\);/);
assert.match(body, /perform public\._sku_po_receipts_capture\(new\.payload[\s\S]*?exception when others then\s+(?:--[^\n]*\s+)?raise warning 'sku_po_receipts: %', sqlerrm;/, "trigger bọc exception, ghi warning (không nuốt im lặng)");
// PO đúng mẫu agent (job-validator PO_PATTERN ≤ 20) — sai thì bỏ item; ngày năm 2000–2099 (review vòng 1)
assert.ok(body.includes("v_po !~ '^[0-9A-Za-z._/ -]{1,20}$' then continue;"), "kiểm mẫu PO như agent");
assert.match(body, /po text not null check \(length\(po\) between 1 and 20\)/);
assert.match(body, /extract\(year from v_received\) not between 2000 and 2099/);
// Ngày nhận dd/mm/yyyy kiểm chặt (31/02 → bỏ trống, không ném)
assert.match(body, /v_date ~ '\^\\d\{2\}\/\\d\{2\}\/\\d\{4\}\$'/);
assert.match(body, /to_char\(v_received, 'DD\/MM\/YYYY'\) <> v_date or extract\(year from v_received\) not between 2000 and 2099\) then v_received := null/);
// Nạp bù chỉ khi bảng trống (chạy lại không đếm trùng)
assert.match(body, /if not exists \(select 1 from public\.sku_po_receipts\) then[\s\S]*?where j\.type = 'sku' and j\.template_version in \(2, 3\) and j\.status = 'completed'/, "nạp bù chỉ lệnh đã in xong");

// Tra cứu: anon được gọi, tối đa 100 SKU, PO mới nhất trước, trả ngày dd/mm/yyyy
assert.match(body, /grant execute on function public\.sku_po_lookup\(text\[\]\) to anon, authenticated;/);
assert.equal((body.match(/grant execute/g) || []).length, 1, "chỉ cấp quyền cho hàm tra cứu");
for (const fn of ["_sku_po_receipts_capture(jsonb, timestamptz)", "sku_po_receipts_on_print_job()"]) assert.ok(body.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), fn);
assert.match(body, /cardinality\(v_skus\) > 100/);
assert.ok(body.indexOf("coalesce(cardinality(p_skus), 0) > 100") >= 0 && body.indexOf("coalesce(cardinality(p_skus), 0) > 100") < body.indexOf("unnest(coalesce(p_skus"), "chặn mảng lớn trước unnest");
assert.match(body, /order by r\.received_date desc nulls last, r\.last_printed_at desc, r\.po desc limit 20\)/, "tối đa 20 PO mới nhất mỗi SKU");
assert.match(body, /order by q\.received_date desc nulls last, q\.last_printed_at desc, q\.po desc/);
assert.match(body, /to_char\(q\.received_date, 'DD\/MM\/YYYY'\)/);
assert.match(body, /jsonb_build_array\(p_payload\)/, "nhận cả lệnh một tem {sku, …}");
console.log("sku_po_receipts_sql: bảng chỉ service_role, trigger sku v2 không chặn in, nạp bù một lần, tra cứu anon ≤ 100 SKU mới nhất trước passed");
