// Tên in theo database (supabase/print_name_from_db_v1.sql, 18/10/2026). Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * chỉ thay print_enqueue_unchecked (đúng chữ ký, SECURITY DEFINER, search_path '', revoke khỏi public/anon/authenticated);
//   * chép NGUYÊN thân bản đang chạy (supabase/sku_inactive_v1.sql) — mọi dòng cũ còn, đúng thứ tự, trừ dòng declare và return cuối;
//   * 'sku' và 'group_uid': productName := SKU_Name.product_name khi SKU có trong bảng, status '1', tên khác rỗng sau btrim;
//     cả dạng {items:[…]} (giữ thứ tự, giữ trường khác) lẫn dạng đơn {sku, productName, …}; Group UID so tên web = productName ?? materialName;
//   * trả data.renamed [{sku, productName}] chỉ cho SKU thật sự đổi, không lặp; trùng nonce → renamed rỗng;
//   * chặn SKU ngừng (SKU_INACTIVE) vẫn chạy trước bước thay tên; không drop, không đổi print_enqueue.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const file = process.env.PRINT_NAME_SQL || path.join(__dirname, "..", "supabase", "print_name_from_db_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/print_name_from_db_v1.sql");
const sql = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const code = sql.replace(/--[^\n]*/g, "");

assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /notify pgrst,\s*'reload schema'/, "thiếu notify pgrst");
assert.doesNotMatch(code, /\bdrop\b|\btruncate\b|\bdelete\s+from\b/i, "migration không được drop/truncate/delete");
assert.doesNotMatch(code, /create\s+table|alter\s+table/i, "migration chỉ thay hàm");
const created = [...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)/gi)].map(m => m[1]);
assert.deepEqual(created, ["print_enqueue_unchecked"], "chỉ thay đúng print_enqueue_unchecked (không đổi print_enqueue / print_admin_reprint)");

const signature = "create or replace function public.print_enqueue_unchecked(p_access_token text, p_nonce text, p_type text, p_template_version integer, p_payload jsonb, p_copies integer, p_requested_by text default '')";
const extract = (text, label) => {
  const start = text.indexOf(signature);
  assert.ok(start >= 0, `${label}: thiếu create or replace đúng chữ ký`);
  const m = text.slice(start + signature.length).match(/^([\s\S]*?)\$\$([\s\S]*?)\$\$;/);
  assert.ok(m, `${label}: không tách được thân hàm`);
  return { head: m[1], body: m[2] };
};
const fn = extract(code, "print_name_from_db_v1");
assert.match(fn.head, /returns jsonb/i, "phải trả jsonb");
assert.match(fn.head, /security definer/i, "phải SECURITY DEFINER");
assert.match(fn.head, /set search_path\s*=\s*''/, "phải set search_path=''");
assert.match(code, /revoke all on function public\.print_enqueue_unchecked\(text,text,text,integer,jsonb,integer,text\) from public, anon, authenticated;/, "chưa revoke khỏi public, anon, authenticated");
assert.doesNotMatch(code, /grant\s+execute\s+on\s+function\s+public\.print_enqueue_unchecked/i, "không được cấp quyền gọi thẳng print_enqueue_unchecked");

// Chép nguyên thân bản đang chạy: mọi dòng cũ (trừ declare + return cuối) phải còn, đúng thứ tự.
const template = fs.readFileSync(path.join(__dirname, "..", "supabase", "sku_inactive_v1.sql"), "utf8").replace(/\r\n/g, "\n").replace(/--[^\n]*/g, "");
const old = extract(template, "sku_inactive_v1");
const lines = s => s.split("\n").map(l => l.trim()).filter(Boolean);
const oldLines = lines(old.body), newLines = lines(fn.body);
const finalReturn = "return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));";
assert.equal(oldLines[oldLines.length - 2], finalReturn, "khuôn sku_inactive_v1 đổi dòng return cuối — xem lại test");
let at = 0;
for (const line of oldLines) {
  if (line.startsWith("declare ") || line === finalReturn) continue;
  const found = newLines.indexOf(line, at);
  assert.ok(found >= 0, `thân cũ bị đổi hoặc mất dòng: ${line.slice(0, 120)}`);
  at = found + 1;
}
const oldDeclare = oldLines.find(l => l.startsWith("declare "));
const newDeclare = newLines.find(l => l.startsWith("declare "));
assert.ok(newDeclare && newDeclare.startsWith(oldDeclare.replace(/;$/, "")), "giữ mọi biến cũ trong declare (chỉ thêm biến mới)");
assert.match(newDeclare, /v_renamed jsonb := '\[\]'::jsonb/, "thêm biến v_renamed mặc định mảng rỗng");

// Thứ tự: chặn SKU ngừng → thay tên → insert print_jobs.
const b = fn.body;
const iInactive = b.indexOf("'SKU_INACTIVE'");
const iRename = b.search(/if p_type in \('sku',\s*'group_uid'\)/);
const iInsert = b.indexOf("insert into public.print_jobs");
assert.ok(iInactive > 0, "mất bước chặn SKU ngừng (SKU_INACTIVE)");
assert.ok(iRename > iInactive, "bước thay tên phải nằm sau bước chặn SKU ngừng và áp cho cả 'sku' lẫn 'group_uid'");
assert.ok(iInsert > iRename, "bước thay tên phải nằm trước insert print_jobs");
const rename = b.slice(iRename, iInsert);

assert.match(rename, /jsonb_typeof\(p_payload\) = 'object'/, "chỉ xử lý payload là object");
// Hai dạng payload: items[] (giữ thứ tự) và dạng đơn (bọc thành mảng một phần tử rồi lấy lại phần tử 0).
assert.match(rename, /when jsonb_typeof\(p_payload->'items'\) = 'array' then p_payload->'items'\s+else jsonb_build_array\(p_payload\)/, "xử lý cả {items:[…]} lẫn dạng đơn {sku, productName}");
assert.match(rename, /jsonb_array_elements\(case [\s\S]*? end\) with ordinality as t\(v, ord\)/, "đọc từng dòng kèm thứ tự");
assert.match(rename, /coalesce\(\(select jsonb_agg\(case when n\.db_name is null then n\.v else n\.v \|\| jsonb_build_object\('productName', n\.db_name\) end order by n\.ord\) from named n\), '\[\]'::jsonb\)/, "giữ thứ tự + mọi trường khác, chỉ thay productName khi có tên database; items rỗng → [] (jsonb_set với NULL sẽ làm mất payload)");
assert.match(rename, /p_payload := jsonb_set\(p_payload, '\{items\}', v_items\)/, "dạng items: ghi lại mảng items đã thay tên");
assert.match(rename, /p_payload := v_items->0/, "dạng đơn: lấy lại phần tử đã thay tên");
// SKU có trong bảng, đang hoạt động, tên khác rỗng sau btrim.
assert.match(rename, /left join public\."SKU_Name" s on s\.sku = src\.sku and s\.status = '1' and btrim\(coalesce\(s\.product_name, ''\)\) <> ''/, "left join SKU_Name với status '1' và tên database khác rỗng (sau btrim)");
assert.match(rename, /btrim\(coalesce\(t\.v->>'sku', ''\)\)/, "so mã SKU sau btrim");
assert.match(rename, /jsonb_typeof\(t\.v\) = 'object'/, "dòng không phải object thì bỏ qua");
// Group UID: tên web = productName ?? materialName.
assert.match(rename, /coalesce\(t\.v->>'productName', case when p_type = 'group_uid' then t\.v->>'materialName' end\)/, "Group UID so tên web theo productName ?? materialName");
// renamed: chỉ dòng thật sự đổi, mỗi SKU một lần, theo thứ tự xuất hiện.
assert.match(rename, /is distinct from normalize\(n\.db_name, NFC\)/, "renamed chỉ gồm SKU có tên web khác tên database");
assert.match(rename, /select n\.sku, n\.db_name, min\(n\.ord\) as first_ord[\s\S]*?group by n\.sku, n\.db_name\) r\)/, "renamed không lặp SKU (gom theo sku, giữ lần xuất hiện đầu)");
assert.match(rename, /jsonb_agg\(jsonb_build_object\('sku', r\.sku, 'productName', r\.db_name\) order by r\.first_ord\)/, "renamed = [{sku, productName}] theo thứ tự xuất hiện");
assert.match(rename, /coalesce\([\s\S]*'\[\]'::jsonb\)\s+into v_items, v_renamed/, "renamed mặc định mảng rỗng");
// Review vòng 1 (18/10/2026, G7): web không gửi tên (productName / materialName rỗng) thì không có gì để "đổi" → không đưa vào renamed.
assert.match(rename, /where n\.db_name is not null\s+and btrim\(coalesce\(n\.web_name, ''\)\) <> ''/, "renamed chỉ khi web có gửi tên");

// Kết quả: thêm renamed; lệnh trùng nonce (payload đã lưu không đổi) → renamed rỗng.
const ret = newLines.filter(l => l.startsWith("return jsonb_build_object('ok',true"));
assert.equal(ret.length, 1, "đúng một dòng return ok:true");
assert.match(ret[0], /'duplicate',v_duplicate,'renamed',case when v_duplicate then '\[\]'::jsonb else v_renamed end\)/, "data.renamed, trùng nonce → []");
assert.equal(ret[0].replace(/,'renamed',case when v_duplicate then '\[\]'::jsonb else v_renamed end/, ""), finalReturn, "giữ nguyên các khoá cũ của kết quả");

console.log("print_name_from_db_sql: print_enqueue_unchecked chép nguyên bản đang chạy, thay productName theo SKU_Name (status '1', tên khác rỗng) cho 'sku' + 'group_uid' ở cả items[] lẫn dạng đơn, renamed không lặp, trùng nonce → [], vẫn chặn SKU ngừng, revoke đúng, không drop — passed");
