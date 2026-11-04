// Migration supabase/xa_vai_a4_v1.sql (04/11/2026, theo dõi xả vải: mét thực tế → hàng đợi → phiếu A4; kế hoạch
// docs/plans/2026-11-04-xa-vai-met-thuc-te-a4.md, hợp đồng mục 2).
// Không có Postgres cục bộ: kiểm tĩnh văn bản SQL —
//   * khung migration (CRLF, -- kiem: chỉ đọc, khối Rút lui, begin/commit, notify);
//   * bảng xa_vai_measures (cột, ràng buộc, chỉ mục, RLS không policy, chỉ service_role);
//   * xa_vai_system_mm (hợp đồng v2 mục 1: mm là đơn vị lưu và so sánh): immutable, security invoker; ba mẫu regex rút ra
//     chạy đúng các vectơ mm (\y của Postgres đổi thành \b của JS; luồng plpgsql còn lại CHƯA chạy thật — lead kiểm bằng
//     select trên Supabase); không còn system_m / actual_m / systemM / actualM / p_actual_m trong tệp;
//   * print_agents.allowed_capabilities + UPDATE đầu print_agent_claim chỉ giao capability được phép (hợp đồng v2 mục 2);
//   * trigger khoá dòng theo group_uid_code trước khi UPDATE (chống deadlock với enqueue, hợp đồng v2 mục 3);
//   * 3 RPC đọc + 3 RPC ghi (khoá máy theo mẫu floor_access_v1.sql, thân _xa_vai_*_body không cấp quyền);
//   * hàng đợi: CHECK thêm xa_vai_sheet giữ 4 loại cũ, print_agent_claim = bản backend_hygiene_v1.sql + đúng MỘT nhánh,
//     print_queue_status = bản print_devices_v1.sql chỉ đổi queued/queuedCopies/active + thêm queuedA4, trigger đồng bộ trạng thái;
//   * không đụng hàm/bảng xả vải cũ (xa_vai_start/end/list_open/search, xa_vai_log);
//   * hợp đồng V3 mục 1 (04/11/2026): mã hàng (kiểu hàng như CWSH02, không phải SKU) nhập lúc in — cột item_code, hàm chung
//     _xa_vai_item_code (mô phỏng mẫu bằng JS), save bỏ p_sku / SKU_MISMATCH, list/search lọc mã hàng, enqueue p_item_code
//     (thường: bắt buộc + ghi item_code; in lại: MIXED_ITEM_CODE), payload itemCode + sku từng dòng, trigger xoá item_code.
//   node tests/xa_vai_a4_sql.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const FILE = "supabase/xa_vai_a4_v1.sql";
assert.ok(fs.existsSync(path.join(root, FILE)), `Chưa có ${FILE}`);
const bytes = fs.readFileSync(path.join(root, FILE), "utf8");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
const raw = bytes.replace(/\r\n/g, "\n");
const code = raw.replace(/--[^\n]*/g, "");
// Như scripts/apply_supabase_sql.py: bỏ thân $$…$$ để xét lệnh cấp cao nhất.
const topLevel = code.replace(/\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, " ");
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- Khung migration ----------
assert.equal((bytes.match(/\r\n/g) || []).length, (bytes.match(/\n/g) || []).length, "mọi dòng phải là CRLF");
assert.ok(bytes.endsWith("\r\n"), "kết thúc bằng CRLF");
assert.match(raw.slice(0, 4000), /Vì sao/, "đầu tệp ghi vì sao");
assert.match(raw.slice(0, 6000), /Tác động/, "đầu tệp ghi tác động");
const kiem = raw.match(/^-- kiem: (.+)$/m);
assert.ok(kiem, "thiếu dòng -- kiem:");
assert.match(kiem[1], /^select\b/i, "-- kiem: là một câu select");
assert.ok(!kiem[1].includes(";"), "-- kiem: một câu, không ;");
// Review vòng 3 (A): hai chỗ `andexists` dính liền làm câu kiểm báo lỗi cú pháp, release.py coi là "xác minh KHÔNG ĐẠT" dù DB đúng.
assert.doesNotMatch(kiem[1], /\b(and|or)(exists|not|select)\b/i, "-- kiem: từ khoá SQL không được dính liền (andexists, ornot…)");
assert.doesNotMatch(kiem[1], /\)(and|or|exists|not)\b/i, "-- kiem: thiếu dấu cách sau dấu đóng ngoặc");
{
  // Ngoặc cân bằng ngoài chuỗi ký tự trong dấu nháy đơn.
  const bare = kiem[1].replace(/'[^']*'/g, "''");
  assert.equal((bare.match(/\(/g) || []).length, (bare.match(/\)/g) || []).length, "-- kiem: ngoặc cân bằng");
}
assert.doesNotMatch(kiem[1], /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i, "-- kiem: không có từ khoá ghi (select_only của live_status.py)");
for (const name of ["xa_vai_system_mm(", "xa_vai_measures", "xa_vai_measure_save", "xa_vai_print_enqueue", "xa_vai_sheet", "allowed_capabilities"])
  assert.ok(kiem[1].includes(name), `-- kiem: nên kiểm ${name}`);
assert.match(kiem[1], /public\.xa_vai_system_mm\('[^']*\/g', 16763\) = 60758\b/, "-- kiem: vectơ mm 16763 g → 60758");
// Hợp đồng V3 mục 1: -- kiem: kiểm cột item_code và chữ ký mới (save bỏ p_sku, enqueue thêm p_item_code).
assert.match(kiem[1], /c\.table_name = 'xa_vai_measures' and c\.column_name = 'item_code'/, "-- kiem: kiểm cột xa_vai_measures.item_code");
assert.ok(kiem[1].includes("'public.xa_vai_print_enqueue(text,text[],integer,text,boolean,text)'"), "-- kiem: chữ ký xa_vai_print_enqueue(text,text[],integer,text,boolean,text)");
assert.ok(kiem[1].includes("'public.xa_vai_measure_save(text,text,numeric,boolean)'"), "-- kiem: chữ ký xa_vai_measure_save(text,text,numeric,boolean)");
// Chữ ký V2 không còn ở đâu trong tệp (chú thích, -- kiem:, Rút lui, mã).
assert.doesNotMatch(raw, /xa_vai_measure_save(_body)?\(text, ?text, ?text, ?numeric/, "còn chữ ký save V2 (có p_sku)");
assert.doesNotMatch(raw, /xa_vai_print_enqueue(_body)?\(text, ?text\[\], ?integer, ?text, ?boolean\)/, "còn chữ ký enqueue V2 (thiếu p_item_code)");
assert.doesNotMatch(raw, /xa_vai_measure_search\(text, ?date/, "còn chữ ký search V2 (thiếu p_item_code)");
assert.match(raw, /^-- Rút lui/m, "thiếu khối -- Rút lui");
const rutLui = raw.slice(raw.search(/^-- Rút lui/m), raw.search(/^begin;$/m));
assert.match(rutLui, /drop function if exists public\.xa_vai_system_mm\(text, numeric\);/, "Rút lui: drop xa_vai_system_mm");
assert.match(rutLui, /alter table public\.print_agents drop column if exists allowed_capabilities;/, "Rút lui: drop cột allowed_capabilities");
for (const sig of [
  "xa_vai_print_enqueue(text, text[], integer, text, boolean, text)",
  "_xa_vai_print_enqueue_body(text, text[], integer, text, boolean, text)",
  "xa_vai_measure_save(text, text, numeric, boolean)",
  "_xa_vai_measure_save_body(text, text, numeric, boolean)",
  "xa_vai_measure_list(text, text)",
  "xa_vai_measure_search(text, text, date, date, integer)",
  "_xa_vai_item_code(text)",
]) assert.ok(rutLui.includes(`drop function if exists public.${sig};`), `Rút lui: drop ${sig}`);
assert.ok(rutLui.indexOf("print_agent_claim trong backend_hygiene_v1.sql") >= 0 &&
  rutLui.indexOf("print_agent_claim trong backend_hygiene_v1.sql") < rutLui.indexOf("drop column if exists allowed_capabilities"),
  "Rút lui: chạy lại print_agent_claim cũ TRƯỚC khi drop cột (claim mới đọc cột này)");
// Hợp đồng v2 mục 1: bỏ hết tên theo mét của v1 (kể cả chú thích, -- kiem:, Rút lui).
for (const re of [/\bsystem_m\b/, /\bactual_m\b/, /\bsystemM\b/, /\bactualM\b/, /\bp_actual_m\b/, /\bxa_vai_system_m\b/])
  assert.doesNotMatch(raw, re, `còn tên đơn vị mét của v1: ${re}`);
assert.match(raw, /--allow-destructive/, "đầu tệp phải ghi rõ cần --allow-destructive (alter table … drop constraint)");
assert.match(code, /^begin;$/m, "thiếu begin;");
assert.match(code, /^commit;$/m, "thiếu commit;");
assert.match(code, /notify pgrst, 'reload schema';/, "thiếu notify pgrst");
assert.ok(code.indexOf("commit;") < code.indexOf("notify pgrst"), "notify sau commit như các migration gần đây");
for (const [re, label] of [
  [/\bdrop\s+(table|schema|database|view|type|index|function|trigger|policy)\b/i, "DROP"],
  [/\btruncate\b/i, "TRUNCATE"],
  [/\bdelete\s+from\b/i, "DELETE FROM"],
]) assert.ok(!re.test(topLevel), `không có ${label} ở cấp cao nhất`);
const dropConstraints = topLevel.match(/\balter\s+table\b[^;]*\bdrop\s+(column|constraint)\b[^;]*;/gi) || [];
assert.deepEqual(dropConstraints.map(s => s.replace(/\s+/g, " ")), ["alter table public.print_jobs drop constraint if exists print_jobs_type_check;"], "chỉ một lệnh drop constraint print_jobs_type_check");
assert.doesNotMatch(raw, /\b(9\d{8}|1\d{15})\b/, "không có mã SKU / UID dạng thật trong tệp");

// ---------- Định nghĩa hàm ----------
const defs = [];
{
  const re = /create or replace function public\.(\w+)\(([^)]*)\)([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
  let m;
  while ((m = re.exec(code))) defs.push({ name: m[1], params: m[2].replace(/\s+/g, " ").trim(), head: m[3], body: m[4] });
}
const one = name => {
  const list = defs.filter(d => d.name === name);
  assert.equal(list.length, 1, `cần đúng 1 định nghĩa ${name}, thấy ${list.length}`);
  return list[0];
};
const grantedTo = (name, role) => new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [^;]*\\b(${role})\\b`, "i").test(code);
const revokedAll = name => new RegExp(`revoke (all|execute) on function public\\.${name}\\([^)]*\\) from public,\\s*anon,\\s*authenticated;`, "i").test(code);

const NEW_FNS = [
  "xa_vai_system_mm", "_xa_vai_item_json", "_xa_vai_iso", "_xa_vai_item_code",
  "xa_vai_measure_lookup", "xa_vai_measure_list", "xa_vai_measure_search",
  "_xa_vai_measure_save_body", "_xa_vai_measure_delete_body", "_xa_vai_print_enqueue_body",
  "xa_vai_measure_save", "xa_vai_measure_delete", "xa_vai_print_enqueue",
  "print_agent_claim", "print_queue_status", "xa_vai_measures_sync_job",
];
assert.deepEqual(defs.map(d => d.name).sort(), [...NEW_FNS].sort(), "đúng các hàm của migration (không thêm, không sót)");
for (const d of defs) if (/security definer/i.test(d.head)) assert.match(d.head, /set search_path\s*=\s*''/, `${d.name} thiếu set search_path = ''`);
for (const name of NEW_FNS.filter(n => !["print_agent_claim", "print_queue_status"].includes(n)))
  assert.ok(revokedAll(name), `${name} phải revoke khỏi public, anon, authenticated`);

// Không đụng xả vải cũ.
assert.doesNotMatch(code, /\bxa_vai_log\b/, "không đụng bảng xa_vai_log");
for (const old of ["xa_vai_start", "xa_vai_end", "xa_vai_list_open", "xa_vai_search", "_xa_vai_start_body", "_xa_vai_end_body"])
  assert.doesNotMatch(code, new RegExp(`function public\\.${old}\\(`), `không đụng ${old}`);

// ---------- Bảng xa_vai_measures ----------
const table = code.match(/create table if not exists public\.xa_vai_measures \(([\s\S]*?)\n\);/);
assert.ok(table, "thiếu create table if not exists public.xa_vai_measures");
const cols = table[1].replace(/\s+/g, " ");
for (const re of [
  /group_uid_code text primary key check \(length\(btrim\(group_uid_code\)\) between 1 and 40\)/,
  /sku text not null check \(length\(sku\) between 1 and 40\)/,
  /batch_code text not null default ''/,
  /roll_code text not null default ''/,
  /system_qty numeric not null/,
  /system_mm numeric\(14,0\)(,| check)/,
  /actual_mm numeric\(14,0\) not null check \(actual_mm > 0 and actual_mm <= 100000000\)/,
  /measured_at timestamptz not null default now\(\)/,
  /device_id uuid references public\.print_devices\(id\) on delete set null/,
  /status text not null default 'pending' check \(status in \('pending', ?'printing', ?'printed'\)\)/,
  /print_job_id uuid references public\.print_jobs\(id\) on delete set null/,
  /printed_at timestamptz/,
  // Hợp đồng V3 mục 1: mã hàng (kiểu hàng như CWSH02, không phải SKU) null tới khi in, luôn viết hoa.
  /item_code text check \(item_code ~ '\^\[0-9A-Z\._-\]\{1,40\}\$'\)/,
]) assert.match(cols, re, `xa_vai_measures thiếu/sai cột: ${re}`);
assert.doesNotMatch(cols, /system_mm numeric\(14,0\) not null/, "system_mm cho phép null");
assert.doesNotMatch(cols, /item_code text not null/, "item_code null cho tới khi in");
assert.match(code, /create index if not exists \w+ on public\.xa_vai_measures \(item_code, printed_at desc\);/, "thiếu chỉ mục (item_code, printed_at desc)");
// Hàng chờ không còn lọc theo SKU (V3): chỉ mục hàng chờ theo (status, measured_at).
assert.match(code, /create index if not exists \w+ on public\.xa_vai_measures \(status, measured_at\);/, "thiếu chỉ mục hàng chờ (status, measured_at)");
assert.doesNotMatch(code, /on public\.xa_vai_measures \(sku, status, measured_at\)/, "bỏ chỉ mục (sku, status, measured_at) của hàng chờ một SKU");
assert.match(code, /create index if not exists \w+ on public\.xa_vai_measures \(printed_at desc\) where status = 'printed';/, "thiếu chỉ mục printed_at desc where printed");
assert.match(code, /create index if not exists \w+ on public\.xa_vai_measures \(print_job_id\)/, "thiếu chỉ mục FK print_job_id (trigger + on delete set null)");
assert.match(code, /create index if not exists \w+ on public\.xa_vai_measures \(device_id\)/, "thiếu chỉ mục FK device_id");
assert.match(code, /alter table public\.xa_vai_measures enable row level security;/, "chưa bật RLS");
assert.match(code, /revoke all on (table )?public\.xa_vai_measures from public, anon, authenticated;/, "chưa revoke bảng");
assert.match(code, /grant select, insert, update, delete on (table )?public\.xa_vai_measures to service_role;/, "chưa grant service_role");
assert.doesNotMatch(code, /create policy/i, "bảng mới không policy");

// ---------- xa_vai_system_mm (hợp đồng v2 mục 1) ----------
const sys = one("xa_vai_system_mm");
assert.equal(sys.params, "p_product_name text, p_qty numeric");
assert.match(sys.head, /returns numeric/i);
assert.match(sys.head, /\bimmutable\b/i);
assert.doesNotMatch(sys.head, /security definer/i, "xa_vai_system_mm là security invoker");
assert.match(sys.head, /set search_path\s*=\s*''/);
assert.ok(!grantedTo("xa_vai_system_mm", "anon|authenticated|public"), "xa_vai_system_mm không cấp quyền cho ai");
assert.doesNotMatch(sys.body, /\bpublic\./, "xa_vai_system_mm không đụng bảng");
assert.doesNotMatch(sys.body, /\\b/, "Postgres: \\b là backspace, ranh giới từ phải là \\y");
// Ba mẫu: gsm, cm, in (theo thứ tự trong thân hàm), cờ 'i'.
const pats = [...sys.body.matchAll(/regexp_match\(\s*\w+\s*,\s*'([^']+)'\s*,\s*'i'\s*\)/g)].map(m => m[1]);
assert.equal(pats.length, 3, `cần 3 regexp_match(…, '…', 'i') (gsm, cm, in), thấy ${pats.length}`);
const [reGsm, reCm, reIn] = pats.map(p => new RegExp(p.replace(/\\y/g, "\\b"), "i"));
assert.match(sys.body, /'mm' then/, "đơn vị mm");
assert.match(sys.body, /'m' then/, "đơn vị m");
assert.match(sys.body, /\* 1000\b/, "m và g nhân 1000 ra mm");
assert.doesNotMatch(sys.body, /\/ 1000\b/, "mm giữ nguyên, không chia 1000 (v1)");
assert.match(sys.body, /0\.0254/, "inch × 0,0254");
assert.match(sys.body, /\/ 100\b/, "cm chia 100");
assert.match(sys.body, /round\([^;]*, 0\)/, "làm tròn mm nguyên: round(…, 0)");
assert.doesNotMatch(sys.body, /, 2\)/, "không còn làm tròn 2 chữ số của v1");
assert.match(sys.body, />= 100000000000\b/, "kết quả ≥ 1e11 → NULL");
// Ba công thức mô phỏng bên dưới phải đúng là công thức trong thân hàm (mô phỏng chỉ rút regex, không rút phép tính).
assert.match(sys.body, /if v_unit = 'm' then\s+v_mm := round\(p_qty \* 1000, 0\);/, "m → qty × 1000");
assert.match(sys.body, /if v_unit = 'mm' then\s+v_mm := round\(p_qty, 0\);/, "mm → qty");
assert.match(sys.body, /v_mm := round\(p_qty \* 1000 \/ \(v_gsm \* v_width\), 0\);/, "g → qty × 1000 / (gsm × khổ m)");
assert.equal((sys.body.match(/return case when v_mm >= 100000000000 then null else v_mm end;/g) || []).length, 3, "cả ba nhánh chặn ≥ 1e11");
assert.match(sys.body, /'NaN'/, "qty NaN → NULL");
// Mô phỏng hợp đồng v2 mục 1 bằng chính các mẫu regex của tệp SQL (kết quả mm nguyên, ≥ 1e11 → null).
const num = s => Number(String(s).replace(",", "."));
const cap = v => (v >= 1e11 ? null : v);
const systemM = (name, qty) => {
  if (qty == null || !(qty >= 0) || !Number.isFinite(qty)) return null;
  const s = String(name || "");
  const unit = s.replace(/^[\s\S]*\//, "").trim().toLowerCase();
  if (unit === "m") return cap(Math.round(qty * 1000));
  if (unit === "mm") return cap(Math.round(qty));
  if (unit !== "g") return null;
  const g = reGsm.exec(s);
  if (!g) return null;
  const gsm = num(g[1]);
  let width = null;
  const c = reCm.exec(s);
  if (c) width = num(c[1]) / 100;
  else {
    const i = reIn.exec(s);
    if (i) width = (num(i[1]) + (i[2] != null ? num(i[2]) : num(i[1]))) / 2 * 0.0254;
  }
  if (width == null || !(gsm > 0) || !(width > 0)) return null;
  return cap(Math.round(qty * 1000 / (gsm * width)));
};
assert.equal(systemM("Vải Test Jersey/Cotton/155gsm, 178cm/Đen/g", 16763), 60758);
assert.equal(systemM("Vải Test/Poly/150gsm, 60in/Trắng/g", 10000), 43745);
assert.equal(systemM("Vải Test/Poly/150GSM, 58_62in/Trắng/g", 10000), 43745, "khoảng inch lấy trung bình");
assert.equal(systemM("Vải Test/Poly/150gsm, 58-62 in/Trắng/g", 10000), 43745);
assert.equal(systemM("Vải Test/Poly/150,5gsm/W180cm/g", 1000), 3691, "gsm có dấu phẩy thập phân");
assert.equal(systemM("Chỉ Test/Đen/mm", 2500), 2500);
assert.equal(systemM("Vải Test/Trắng/m", 49.5), 49500);
assert.equal(systemM("Vải Test/Đen/ M ", 49.5), 49500, "đơn vị trim + chữ thường");
assert.equal(systemM("Vải Test/Trắng/m", 99999999.999), 99999999999, "dưới 1e11 giữ nguyên");
assert.equal(systemM("Vải Test/Trắng/m", 100000000), null, "≥ 1e11 mm → NULL");
assert.equal(systemM("Cúc Test/Đen/pcs", 10), null);
assert.equal(systemM("Vải Test/178cm/Đen/g", 1000), null, "g không có gsm → NULL");
assert.equal(systemM("Vải Test/155gsm/Đen/g", 1000), null, "g không có khổ → NULL");
assert.equal(systemM("Vải Test/155gsm, 60inch/Đen/g", 1000), null, "'inch' không phải 'in' + ranh giới từ (như computeCutQty)");
assert.equal(systemM("", 10), null);
assert.equal(systemM("Vải Test/Đen/m", -1), null);

// ---------- Chuẩn hoá mã hàng (hợp đồng V3 mục 1: một chỗ dùng chung) ----------
const ic = one("_xa_vai_item_code");
assert.equal(ic.params, "p_item_code text");
assert.match(ic.head, /returns text/i);
assert.match(ic.head, /\bimmutable\b/i);
assert.doesNotMatch(ic.head, /security definer/i, "_xa_vai_item_code là security invoker");
assert.match(ic.head, /set search_path\s*=\s*''/);
assert.ok(!grantedTo("_xa_vai_item_code", "anon|authenticated|public"), "_xa_vai_item_code không cấp quyền cho ai");
assert.doesNotMatch(ic.body, /\bpublic\./, "_xa_vai_item_code không đụng bảng");
const IC_EXPR = "upper(btrim(p_item_code))";
assert.ok(ic.body.includes(IC_EXPR), "chuẩn hoá = upper(btrim(p_item_code))");
const icPat = ic.body.match(/~ '([^']+)'/);
assert.ok(icPat && icPat[1] === "^[0-9A-Z._-]{1,40}$", "mã hàng khớp ^[0-9A-Z._-]{1,40}$");
assert.match(ic.body, /then upper\(btrim\(p_item_code\)\) end/, "khớp mẫu → mã viết hoa, còn lại NULL");
const itemCodeOf = s => {
  if (s == null) return null;
  const v = String(s).replace(/^ +| +$/g, "").toUpperCase(); // btrim chỉ bỏ dấu cách hai đầu
  return new RegExp(icPat[1]).test(v) ? v : null;
};
assert.equal(itemCodeOf(" cwsh02 "), "CWSH02");
assert.equal(itemCodeOf("Test01.a_b-c"), "TEST01.A_B-C");
assert.equal(itemCodeOf(""), null);
assert.equal(itemCodeOf("CW SH02"), null, "khoảng trắng giữa → sai mẫu");
assert.equal(itemCodeOf("\tCWSH02"), null, "tab không bị btrim → sai mẫu");
assert.equal(itemCodeOf("Đ01"), null, "chữ có dấu → sai mẫu");
assert.equal(itemCodeOf("A".repeat(40)), "A".repeat(40));
assert.equal(itemCodeOf("A".repeat(41)), null, "tối đa 40 ký tự");
assert.equal(itemCodeOf(null), null);
const IC_MSG = "'Mã hàng chỉ gồm chữ, số, . _ - (tối đa 40 ký tự)'";
// Không chuẩn hoá lặp lại ở nơi khác: mọi upper(btrim(p_item_code)) chỉ trong hàm chung.
assert.equal((code.match(/upper\(btrim\(p_item_code\)\)/g) || []).length, (ic.body.match(/upper\(btrim\(p_item_code\)\)/g) || []).length, "chuẩn hoá mã hàng chỉ ở _xa_vai_item_code");

// ---------- RPC đọc ----------
const READS = {
  xa_vai_measure_lookup: "p_group_uid text",
  xa_vai_measure_list: "p_item_code text default null, p_status text default 'queue'",
  xa_vai_measure_search: "p_item_code text default null, p_sku text default null, p_date_from date default null, p_date_to date default null, p_limit integer default 5000",
};
for (const [name, params] of Object.entries(READS)) {
  const d = one(name);
  assert.equal(d.params, params, `${name} sai chữ ký`);
  assert.match(d.head, /returns jsonb/i);
  assert.match(d.head, /security definer set search_path = ''/i, `${name}: security definer + search_path ''`);
  assert.doesNotMatch(d.body, /floor_access_check|p_access_token/, `${name}: đọc mở, không token`);
  assert.ok(revokedAll(name), `${name} phải revoke`);
  assert.ok(grantedTo(name, "anon") && grantedTo(name, "authenticated"), `${name} phải cấp anon, authenticated`);
}
const lookup = one("xa_vai_measure_lookup");
for (const key of ["groupUid", "sku", "itemCode", "productName", "lot", "roll", "uidStatus", "systemQty", "systemMm", "state", "actualMm", "measuredAt", "printedAt", "printJobId"])
  assert.equal((lookup.body.match(new RegExp(`'${key}'`, "g")) || []).length, 2, `lookup thiếu ${key} (cả nhánh đã đo và nhánh new)`);
assert.match(lookup.body, /'itemCode', v_row\.item_code/, "lookup đã đo: itemCode từ item_code");
assert.match(lookup.body, /'itemCode', null/, "lookup chưa đo: itemCode null");
assert.match(lookup.body, /'systemMm', v_row\.system_mm/, "lookup đã đo: systemMm từ system_mm");
assert.match(lookup.body, /'actualMm', v_row\.actual_mm/, "lookup đã đo: actualMm từ actual_mm");
assert.match(lookup.body, /'printJobId', v_row\.print_job_id/, "lookup đã đo: printJobId");
for (const c of ["INVALID_UID", "GROUP_UID_NOT_READY"]) assert.match(lookup.body, new RegExp(`'${c}'`), `lookup thiếu ${c}`);
assert.match(lookup.body, /'new'/, "lookup state new khi chưa đo");
assert.match(lookup.body, /public\.xa_vai_system_mm\(/, "lookup tính systemMm bằng xa_vai_system_mm");
assert.match(lookup.body, /public\."SKU_Name"/, "productName từ SKU_Name");
const item = one("_xa_vai_item_json");
for (const key of ["groupUid", "sku", "itemCode", "lot", "roll", "systemMm", "actualMm", "measuredAt", "status", "printedAt", "printJobId"])
  assert.match(item.body, new RegExp(`'${key}'`), `Item thiếu ${key}`);
assert.match(item.body, /'itemCode', p_row\.item_code/, "Item: itemCode từ item_code");
assert.match(item.body, /'systemMm', p_row\.system_mm, 'actualMm', p_row\.actual_mm/, "Item: systemMm / actualMm từ cột mm");
assert.match(item.body, /'printJobId', p_row\.print_job_id/, "Item: printJobId (màn theo dõi dòng printing của máy khác)");
assert.ok(!grantedTo("_xa_vai_item_json", "anon|authenticated|public"), "_xa_vai_item_json không cấp quyền");
const list = one("xa_vai_measure_list");
assert.match(list.body, /'queue'/);
assert.match(list.body, /'printed'/);
assert.match(list.body, /status in \('pending', ?'printing'\)/, "queue = pending + printing");
assert.match(list.body, /measured_at(, \w+\.group_uid_code)?\b/);
assert.match(list.body, /printed_at desc/);
assert.match(list.body, /limit 1000/, "tối đa 1000 dòng");
for (const key of ["items", "total"]) assert.match(list.body, new RegExp(`'${key}'`));
// V3: queue = mọi SKU, bỏ qua p_item_code; printed lọc theo mã hàng (khớp đúng sau chuẩn hoá).
assert.doesNotMatch(list.body, /\bm\.sku\b|\bv_sku\b|\bp_sku\b/, "list không còn lọc SKU");
{
  const a = list.body.indexOf("if v_status = 'queue' then");
  const b = list.body.indexOf("\n  else\n", a);
  assert.ok(a >= 0 && b > a, "list có nhánh queue / printed");
  assert.doesNotMatch(list.body.slice(a, b), /item_code/, "queue không lọc mã hàng");
  assert.equal((list.body.slice(b).match(/\(v_code is null or m\.item_code = v_code\)/g) || []).length, 2, "printed lọc item_code ở cả count và danh sách");
}
assert.match(list.body, /public\._xa_vai_item_code\(p_item_code\)/, "list chuẩn hoá mã hàng bằng hàm chung");
assert.match(list.body, /'INVALID_ITEM_CODE'/, "list: mã hàng sai mẫu → INVALID_ITEM_CODE");
assert.ok(list.body.includes(IC_MSG), "list: thông điệp INVALID_ITEM_CODE theo hợp đồng V3");
const search = one("xa_vai_measure_search");
assert.equal((search.body.match(/\(v_code is null or m\.item_code = v_code\)/g) || []).length, 2, "search lọc item_code khớp đúng (count + danh sách)");
assert.equal((search.body.match(/\(v_sku is null or m\.sku = v_sku\)/g) || []).length, 2, "search lọc SKU khớp đúng (count + danh sách)");
assert.match(search.body, /public\._xa_vai_item_code\(p_item_code\)/, "search chuẩn hoá mã hàng bằng hàm chung");
assert.match(search.body, /'INVALID_ITEM_CODE'/, "search: mã hàng sai mẫu → INVALID_ITEM_CODE");
assert.ok(search.body.includes(IC_MSG), "search: thông điệp INVALID_ITEM_CODE theo hợp đồng V3");
assert.match(search.body, /least\(greatest\(coalesce\(p_limit, ?5000\), ?1\), ?5000\)/, "p_limit kẹp 1–5000");
assert.match(search.body, /at time zone 'Asia\/Ho_Chi_Minh'/, "ngày theo giờ Việt Nam");
assert.match(search.body, /status = 'printed'/, "chỉ dòng printed");
for (const key of ["items", "total", "truncated"]) assert.match(search.body, new RegExp(`'${key}'`));
assert.doesNotMatch(search.body, /ilike/, "SKU khớp đúng, không ilike");

// ---------- RPC ghi (khoá máy) ----------
const WRITES = {
  xa_vai_measure_save: ["p_access_token text, p_group_uid text, p_actual_mm numeric, p_replace boolean default false", "p_access_token, p_group_uid, p_actual_mm, p_replace"],
  xa_vai_measure_delete: ["p_access_token text, p_group_uid text", "p_access_token, p_group_uid"],
  xa_vai_print_enqueue: ["p_access_token text, p_uids text[], p_copies integer, p_nonce text, p_reprint boolean default false, p_item_code text default null", "p_access_token, p_uids, p_copies, p_nonce, p_reprint, p_item_code"],
};
for (const [name, [params, args]] of Object.entries(WRITES)) {
  const pub = one(name);
  assert.equal(pub.params, params, `${name} sai chữ ký`);
  assert.match(pub.head, /returns jsonb/i);
  assert.match(pub.head, /security definer set search_path = ''/i);
  assert.match(pub.body, new RegExp(`v_access := public\\.floor_access_check\\(p_access_token, '${name}'\\);`), `${name} chưa gọi floor_access_check`);
  assert.match(pub.body, /if v_access = 'deny' then return public\.floor_access_denied\(\); end if;/, `${name} chưa chặn khi deny`);
  assert.match(pub.body, new RegExp(`return public\\.floor_access_result\\(v_access, public\\._${name}_body\\(${esc(args)}\\)\\);`), `${name} chưa gọi thân _${name}_body`);
  assert.equal((pub.body.match(/\breturn\b/g) || []).length, 2, `${name}: chỉ 2 chỗ return`);
  assert.ok(revokedAll(name), `${name} phải revoke`);
  assert.ok(grantedTo(name, "anon") && grantedTo(name, "authenticated"), `${name} phải cấp anon, authenticated`);
  const body = one(`_${name}_body`);
  assert.equal(body.params, params.replace(/ default (false|null)/g, ""), `_${name}_body cùng tham số (không default)`);
  assert.match(body.head, /security definer set search_path = ''/i);
  assert.ok(revokedAll(`_${name}_body`), `_${name}_body phải revoke`);
  assert.ok(!grantedTo(`_${name}_body`, "anon|authenticated|public"), `_${name}_body không được cấp quyền (anon gọi thẳng là vượt khoá máy)`);
}
const save = one("_xa_vai_measure_save_body");
for (const c of ["INVALID_UID", "INVALID_QTY", "GROUP_UID_NOT_READY", "ALREADY_MEASURED", "NOT_PENDING"])
  assert.match(save.body, new RegExp(`'${c}'`), `save thiếu ${c}`);
// V3: UID của SKU nào cũng lưu được — bỏ p_sku và SKU_MISMATCH ở save (cả thân lẫn hàm công khai).
for (const d of [save, one("xa_vai_measure_save")]) {
  assert.doesNotMatch(d.params + d.body, /\bp_sku\b|\bv_sel\b/, `${d.name}: còn p_sku`);
  assert.doesNotMatch(d.body, /SKU_MISMATCH|'uidSku'/, `${d.name}: còn SKU_MISMATCH`);
}
assert.doesNotMatch(code, /SKU_MISMATCH/, "không còn SKU_MISMATCH trong migration");
assert.doesNotMatch(save.body, /item_code/, "save không ghi mã hàng (nhập lúc in)");
assert.match(save.body, /'item', ?public\._xa_vai_item_json\(/, "ALREADY_MEASURED kèm item");
assert.match(save.body, /'replaced'/);
assert.match(save.body, /on conflict \(group_uid_code\) do nothing/, "chống đua: on conflict do nothing");
assert.match(save.body, /for update/, "khoá dòng có sẵn trước khi đổi");
assert.match(save.body, /public\.print_device_by_token\(p_access_token\)/, "device_id = máy đang ghi");
assert.match(save.body, /public\.xa_vai_system_mm\(/);
assert.match(save.body, /v_sys >= 100000000000 then/, "system_mm ≥ 1e11 → NULL");
assert.match(save.body, /round\(p_actual_mm, ?0\)/, "làm tròn mm nguyên");
assert.match(save.body, /p_actual_mm is null or p_actual_mm = 'NaN'::numeric or p_actual_mm <= 0 or p_actual_mm > 100000000 then/, "INVALID_QTY: NULL / NaN / ≤ 0 / > 100000000");
assert.match(save.body, /if v_mm <= 0 then/, "sau làm tròn ≤ 0 → INVALID_QTY");
assert.equal((save.body.match(/'Mét thực tế phải lớn hơn 0 và không quá 100\.000 m'/g) || []).length, 2, "thông điệp INVALID_QTY theo hợp đồng v2");
assert.match(save.body, /insert into public\.xa_vai_measures\(group_uid_code, sku, batch_code, roll_code, system_qty, system_mm, actual_mm, device_id\)/, "chèn cột mm");
assert.match(save.body, /set actual_mm = v_mm, measured_at = now\(\)/, "ghi đè actual_mm");
const del = one("_xa_vai_measure_delete_body");
for (const c of ["NOT_FOUND", "NOT_PENDING"]) assert.match(del.body, new RegExp(`'${c}'`), `delete thiếu ${c}`);
assert.match(del.body, /delete from public\.xa_vai_measures/);
assert.match(del.body, /for update/);
assert.match(del.body, /'groupUid'/);

const enq = one("_xa_vai_print_enqueue_body");
for (const c of ["INVALID_JOB", "NOT_FOUND", "NOT_PENDING", "INVALID_ITEM_CODE", "MIXED_ITEM_CODE"]) assert.match(enq.body, new RegExp(`'${c}'`), `enqueue thiếu ${c}`);
assert.match(enq.body, /p_copies is null or p_copies not between 1 and 5/, "copies 1–5");
// Agent từ chối cả lệnh khi SKU sai SKU_PATTERN hoặc UID không phải ASCII in được: máy chủ chặn sớm cùng mẫu (job-validator.mjs).
// V3: phiếu nhiều SKU → kiểm SKU của TỪNG dòng.
assert.match(enq.body, /m\.sku !~ '\^\[0-9A-Za-z\._-\]\{1,40\}\$'/, "enqueue chặn SKU (từng dòng) sai mẫu agent");
assert.doesNotMatch(enq.body, /cardinality\(v_skus\) > 1/, "V3: không còn chặn phiếu nhiều SKU");
// Chế độ thường: mã hàng bắt buộc, chuẩn hoá bằng hàm chung, kiểm trước khi khoá nonce; in lại bỏ qua p_item_code.
assert.match(enq.body, /if not v_reprint then\s+v_item := public\._xa_vai_item_code\(p_item_code\);\s+if v_item is null then\s+return jsonb_build_object\('ok', false, 'error', jsonb_build_object\('code', 'INVALID_ITEM_CODE'/, "thường: p_item_code sai / thiếu → INVALID_ITEM_CODE");
assert.ok(enq.body.includes(IC_MSG), "enqueue: thông điệp INVALID_ITEM_CODE theo hợp đồng V3");
assert.ok(enq.body.indexOf("'INVALID_ITEM_CODE'") < enq.body.indexOf("pg_advisory_xact_lock"), "kiểm mã hàng trước khi khoá nonce");
assert.equal((enq.body.match(/p_item_code/g) || []).length, 1, "p_item_code chỉ đọc một chỗ (nhánh thường)");
// In lại: mọi dòng cùng MỘT item_code khác null; khác nhau → MIXED_ITEM_CODE.
assert.match(enq.body, /'MIXED_ITEM_CODE',\s*'message', 'Mỗi phiếu một mã hàng'/, "MIXED_ITEM_CODE: 'Mỗi phiếu một mã hàng'");
{
  const r = enq.body.indexOf("if v_reprint then");
  assert.ok(r >= 0, "có nhánh in lại lấy mã hàng từ dòng");
  const seg = enq.body.slice(r, enq.body.indexOf("end if;", enq.body.indexOf("'MIXED_ITEM_CODE'")));
  assert.match(seg, /count\(distinct m\.item_code\)/, "in lại: đếm mã hàng khác nhau");
  assert.match(seg, /m\.item_code is null/, "in lại: dòng chưa có mã hàng cũng bị chặn");
  assert.ok(seg.includes("'MIXED_ITEM_CODE'"), "MIXED_ITEM_CODE nằm trong nhánh in lại");
  assert.ok(enq.body.indexOf("'NOT_PENDING'") < r, "in lại: kiểm trạng thái printed trước khi xét mã hàng");
}
assert.match(enq.body, /u !~ '\^\[ -~\]\{1,40\}\$'/, "enqueue chặn UID không phải ASCII in được");
assert.match(enq.body, /between 1 and 100/, "1–100 UID");
assert.match(enq.body, /length\(v_nonce\) > 120/, "nonce ≤ 120 ký tự");
assert.match(enq.body, /pg_advisory_xact_lock\(hashtextextended\('xa_vai_print_enqueue:' \|\| v_nonce, 0\)\)/, "tuần tự hoá theo nonce trước khi tra trùng");
assert.match(enq.body, /from public\.print_jobs j where j\.nonce = v_nonce/, "tra nonce đã có");
assert.match(enq.body, /'duplicate', ?true/);
assert.match(enq.body, /order by m\.group_uid_code for update/, "khoá dòng theo group_uid_code");
assert.match(enq.body, /insert into public\.print_jobs\(nonce, ?type, ?template_version, ?payload, ?copies, ?requested_by, ?device_id\)\s*values ?\(v_nonce, ?'xa_vai_sheet', ?1, ?v_payload, ?p_copies, ?'xa-vai', ?v_device\)/, "chèn lệnh xa_vai_sheet v1");
assert.match(enq.body, /insert into public\.print_events\(job_id, ?event_type, ?details\) values ?\(v_job\.id, ?'queued',/, "ghi sự kiện queued");
assert.match(enq.body, /perform public\.print_device_touch\(p_access_token, true\);/, "đếm lệnh in của máy");
assert.match(enq.body, /if not v_reprint then\s+update public\.xa_vai_measures set status = 'printing', print_job_id = v_job\.id, item_code = v_item\s+where group_uid_code = any\(v_uids\);\s+end if;/, "chế độ thường: sang printing + gắn lệnh + ghi item_code; in lại không đổi dòng");
assert.equal((enq.body.match(/update public\.xa_vai_measures/g) || []).length, 1, "enqueue chỉ một UPDATE dòng (nhánh thường)");
// Payload xa_vai_sheet v1 (V3): { itemCode, productName, printedAt, reprint, items[{ groupUid, sku, lot, roll, systemMm, actualMm, measuredAt }] }.
assert.match(enq.body, /select jsonb_build_object\('itemCode', v_item, 'productName', v_name, 'printedAt', public\._xa_vai_iso\(now\(\)\),\s*'reprint', v_reprint,\s*'items', coalesce\(jsonb_agg\(jsonb_build_object\('groupUid', m\.group_uid_code, 'sku', m\.sku, 'lot', m\.batch_code, 'roll', m\.roll_code,\s*'systemMm', m\.system_mm, 'actualMm', m\.actual_mm, 'measuredAt', public\._xa_vai_iso\(m\.measured_at\)\)/, "payload V3: itemCode + sku từng dòng, không sku mức payload");
assert.doesNotMatch(enq.body, /'sku', v_sku/, "không còn 'sku', v_sku ở mức payload");
assert.doesNotMatch(enq.body, /coalesce\(v_name, v_sku\)/, "productName không lấy SKU thay tên");
// productName: ≤ 180 ký tự CHỈ KHI mọi dòng cùng một SKU và có tên; còn lại null.
assert.match(enq.body, /if cardinality\(v_skus\) = 1 then\s+select left\(nullif\(btrim\(s\.product_name\), ''\), 180\) into v_name from public\."SKU_Name" s where s\.sku = v_skus\[1\];\s+end if;/, "productName chỉ khi một SKU");
assert.match(enq.body, /\bv_name text;/, "v_name khởi tạo null");
assert.match(enq.body, /order by m\.measured_at, m\.group_uid_code/, "items sắp theo measured_at, group_uid_code");
for (const key of ["id", "status", "duplicate", "count"]) assert.match(enq.body, new RegExp(`'${key}'`), `phản hồi thiếu ${key}`);
const iso = one("_xa_vai_iso");
assert.match(iso.body, /at time zone 'UTC'/);
assert.match(iso.body, /"Z"/, "ISO 8601 UTC kết thúc Z");

// ---------- CHECK loại lệnh ----------
assert.match(code, /alter table public\.print_jobs add constraint print_jobs_type_check\s+check \(type in \('sku', ?'group_uid', ?'fabric_relaxation', ?'location', ?'xa_vai_sheet'\)\);/, "CHECK giữ 4 loại cũ + xa_vai_sheet");
assert.ok(code.indexOf("drop constraint if exists print_jobs_type_check") < code.indexOf("add constraint print_jobs_type_check"), "drop rồi mới add");

// ---------- print_agent_claim: bản backend_hygiene_v1.sql + đúng một nhánh ----------
const claimOf = sql => {
  const a = sql.indexOf("create or replace function public.print_agent_claim(");
  assert.ok(a >= 0, "có print_agent_claim");
  return sql.slice(a, sql.indexOf("end$$;", a) + 6);
};
const BRANCH = "    (type='xa_vai_sheet' and template_version=1 and 'xa_vai_sheet:v1'=any(v_cap)) or\n";
// Hợp đồng v2 mục 2: UPDATE đầu hàm chỉ giao capability nằm trong print_agents.allowed_capabilities (null = không giới hạn);
// state vẫn lưu nguyên p_state; v_cap (returning) là bản đã giao nên mọi điều kiện chọn lệnh dùng bản đã giao.
const UPD_OLD = "  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb))),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;\n";
const UPD_NEW = "  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select c.cap from jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb)) as c(cap) where print_agents.allowed_capabilities is null or c.cap=any(print_agents.allowed_capabilities)),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;\n";
const claim = claimOf(raw);
const claimOld = claimOf(read("supabase/backend_hygiene_v1.sql"));
assert.ok(claimOld.includes(UPD_OLD), "bản gốc backend_hygiene_v1.sql có dòng UPDATE print_agents (neo test)");
assert.equal((claim.match(/xa_vai_sheet/g) || []).length, 2, "đúng một nhánh xa_vai_sheet (loại + capability)");
assert.ok(claim.includes(BRANCH + "    (type='location' and template_version=1 and 'location:v1'=any(v_cap))\n"), "nhánh xa_vai_sheet ngay trước nhánh location");
assert.ok(claim.includes(UPD_NEW), "UPDATE print_agents đầu claim chỉ giao capability trong allowed_capabilities");
assert.equal((claim.match(/allowed_capabilities/g) || []).length, 2, "allowed_capabilities chỉ ở dòng UPDATE đầu hàm");
assert.equal(claim.replace(BRANCH, "").replace(UPD_NEW, UPD_OLD), claimOld, "bỏ nhánh mới + trả dòng UPDATE cũ thì giống hệt bản backend_hygiene_v1.sql (giữ hai khối trả lease)");
assert.match(topLevel, /alter table public\.print_agents add column if not exists allowed_capabilities text\[\];/, "thêm cột print_agents.allowed_capabilities text[] (null = không giới hạn)");
assert.ok(code.indexOf("add column if not exists allowed_capabilities") < code.indexOf("create or replace function public.print_agent_claim("), "thêm cột trước khi tạo claim mới");
assert.doesNotMatch(code, /allowed_capabilities\s*=/, "migration không gán allowed_capabilities cho agent nào (lead đăng ký may-a4-01 bằng tay)");
// Mô phỏng phép lọc của UPDATE mới.
const delivered = (declared, allowed) => declared.filter(c => allowed == null || allowed.includes(c));
assert.deepEqual(delivered(["sku:v1", "group_uid:v1"], null), ["sku:v1", "group_uid:v1"], "null = không giới hạn (may-kho-01 giữ nguyên)");
assert.deepEqual(delivered(["sku:v1", "group_uid:v1"], ["xa_vai_sheet:v1"]), [], "agent A4 cấu hình sai khai tem → không nhận lệnh nào");
assert.deepEqual(delivered(["xa_vai_sheet:v1"], ["xa_vai_sheet:v1"]), ["xa_vai_sheet:v1"]);

// ---------- print_queue_status: bản print_devices_v1.sql, chỉ đổi đếm hàng đợi ----------
const statusOf = sql => {
  const a = sql.indexOf("create or replace function public.print_queue_status(p_access_token text)");
  assert.ok(a >= 0, "có print_queue_status");
  return sql.slice(a, sql.indexOf("end $$;", a) + 7);
};
const statusOld = statusOf(read("supabase/print_devices_v1.sql"));
const statusNew = statusOf(raw);
const OLD_COUNTS = [
  "    'queued',(select count(*) from public.print_jobs where status='queued'),\n",
  "    'queuedCopies',(select coalesce(sum(copies),0) from public.print_jobs where status='queued'),\n",
  "    'active',(select count(*) from public.print_jobs where status in ('claimed','rendering','sending','spooling')),\n",
].join("");
const NEW_COUNTS = [
  "    'queued',(select count(*) from public.print_jobs where status='queued' and type<>'xa_vai_sheet'),\n",
  "    'queuedCopies',(select coalesce(sum(copies),0) from public.print_jobs where status='queued' and type<>'xa_vai_sheet'),\n",
  "    'active',(select count(*) from public.print_jobs where status in ('claimed','rendering','sending','spooling') and type<>'xa_vai_sheet'),\n",
  "    'queuedA4',(select count(*) from public.print_jobs where status='queued' and type='xa_vai_sheet'),\n",
].join("");
assert.ok(statusOld.includes(OLD_COUNTS), "bản gốc print_devices_v1.sql có 3 dòng đếm (neo test)");
assert.ok(statusNew.includes(NEW_COUNTS), "print_queue_status: queued/queuedCopies/active bỏ xa_vai_sheet + thêm queuedA4");
assert.equal(statusNew.replace(NEW_COUNTS, OLD_COUNTS), statusOld, "ngoài các dòng đếm, print_queue_status giống hệt bản print_devices_v1.sql (agents, kiểm print_access_allowed, print_device_touch)");

// ---------- Trigger đồng bộ trạng thái UID ----------
const trg = one("xa_vai_measures_sync_job");
assert.match(trg.head, /returns trigger/i);
assert.match(trg.head, /security definer set search_path = ''/i);
assert.match(trg.body, /where print_job_id = new\.id and status = 'printing'/, "chỉ dòng printing gắn lệnh này");
// Hợp đồng v2 mục 3: khoá dòng cùng thứ tự group_uid_code với _xa_vai_print_enqueue_body trước hai UPDATE (chống deadlock).
const LOCK = "perform 1 from public.xa_vai_measures where print_job_id = new.id and status = 'printing' order by group_uid_code for update;";
assert.ok(trg.body.includes(LOCK), "trigger khoá dòng order by group_uid_code for update");
assert.ok(trg.body.indexOf(LOCK) < trg.body.indexOf("update public.xa_vai_measures"), "khoá trước UPDATE đầu tiên");
assert.match(trg.body, /new\.status = 'completed'/);
assert.match(trg.body, /set status = 'printed', printed_at = coalesce\(new\.completed_at, now\(\)\)/);
// V3: failed / cancelled → về chờ in, xoá print_job_id VÀ item_code (nhập lại mã lúc in lại); completed giữ item_code.
assert.match(trg.body, /set status = 'pending', print_job_id = null, item_code = null\s+where print_job_id = new\.id and status = 'printing';/, "failed/cancelled xoá item_code");
assert.match(trg.body, /set status = 'printed', printed_at = coalesce\(new\.completed_at, now\(\)\)\s+where print_job_id = new\.id and status = 'printing';/, "completed giữ item_code (không ghi cột)");
assert.equal((trg.body.match(/item_code/g) || []).length, 1, "trigger chỉ chạm item_code ở nhánh về chờ in");
assert.match(code, /create or replace trigger xa_vai_measures_sync_job\s+after update of status on public\.print_jobs\s+for each row\s+when \(new\.type = 'xa_vai_sheet' and new\.status in \('completed', ?'failed', ?'cancelled'\) and old\.status is distinct from new\.status\)\s+execute function public\.xa_vai_measures_sync_job\(\);/, "trigger sai điều kiện WHEN");

console.log(`xa_vai_a4_sql: PASS (${defs.length} định nghĩa hàm, CHECK + claim + queue_status + trigger)`);
