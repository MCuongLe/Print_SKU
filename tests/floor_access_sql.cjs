// Khoá máy cho nhóm ghi ở xưởng (supabase/floor_access_v1.sql, kế hoạch docs/plans/2026-10-17-khoa-may-nhom-ghi.md).
// Không có Postgres cục bộ: kiểm cấu trúc tệp SQL bằng cách đọc văn bản.
//   * mọi hàm ghi công khai gọi floor_access_check rồi mới chạy thân cũ;
//   * thân cũ được chép NGUYÊN VĂN từ tệp migration mới nhất (so từng ký tự sau khi chuẩn hoá xuống dòng);
//   * mode bật 'enforce' ngay khi chạy migration, khoá chung print-web-main bị tắt (quyết định 17/10 tối);
//   * bản cũ không token của sample/fabric/xa_vai vẫn còn (trang cũ nhận ACCESS_DENIED thay vì 404) và gọi floor_access_check(null, ...);
//   * hàm nội bộ (check, thân, gộp cờ, dọn) không cấp cho anon/authenticated; RPC Admin kiểm print_admin_allowed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, "supabase", name), "utf8").replace(/\r\n/g, "\n");
const file = path.join(root, "supabase", "floor_access_v1.sql");
assert.ok(fs.existsSync(file), "Chưa có supabase/floor_access_v1.sql");
const sql = read("floor_access_v1.sql");
const code = sql.replace(/--[^\n]*/g, ""); // bỏ chú thích khi tìm câu lệnh

// Tách định nghĩa hàm: tên, tham số, phần đầu (returns ... as), thân giữa $$ ... $$.
const defs = src => {
  const out = [];
  const re = /create or replace function public\.(\w+)\(([^)]*)\)([\s\S]*?)\$\$([\s\S]*?)\$\$/gi;
  let m;
  while ((m = re.exec(src))) out.push({ name: m[1], params: m[2].replace(/\s+/g, " ").trim(), head: m[3], body: m[4] });
  return out;
};
const mine = defs(code);
const find = (name, firstParam) => mine.filter(d => d.name === name && (firstParam === undefined || d.params.split(",")[0].trim().startsWith(firstParam)));
const one = (name, firstParam) => {
  const list = find(name, firstParam);
  assert.equal(list.length, 1, `cần đúng 1 định nghĩa ${name}${firstParam ? ` (tham số đầu ${firstParam})` : ""}, thấy ${list.length}`);
  return list[0];
};
const granted = (name, roles) => new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to [^;]*\\b(${roles})\\b`, "i").test(code);
const grantedSig = (name, sig, role) => new RegExp(`grant execute on function public\\.${name}\\(${sig.replace(/[[\]]/g, "\\$&").replace(/\s*,\s*/g, "\\s*,\\s*")}\\) to [^;]*\\b${role}\\b`, "i").test(code);
const revokedAll = name => new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public,\\s*anon,\\s*authenticated`, "i").test(code);

// ---------- Khung migration ----------
assert.match(code, /^\s*begin;/m, "thiếu begin;");
assert.match(code, /^\s*commit;/m, "thiếu commit;");
assert.match(code, /notify pgrst,\s*'reload schema'/, "thiếu notify pgrst");
assert.doesNotMatch(code, /\bdrop\s+function\b/i, "pha ghi nhận không drop hàm nào (giữ bản cũ)");
assert.match(sql.slice(0, 1500), /Vì sao|vì sao/, "đầu tệp cần ghi vì sao");
assert.match(sql.slice(0, 2500), /Tác động|tác động/, "đầu tệp cần ghi tác động");

// ---------- Bảng ----------
assert.match(code, /create table if not exists public\.floor_access_settings\s*\([\s\S]*?singleton boolean primary key default true check \(singleton\)[\s\S]*?mode text not null default 'log' check \(mode in \('log',\s*'enforce'\)\)/i, "floor_access_settings sai khuôn");
// Quyết định 17/10 tối: bật bắt buộc ngay khi chạy migration (bỏ pha ghi nhận) và tắt khoá chung print-web-main.
assert.match(code, /insert into public\.floor_access_settings\(singleton, mode\) values \(true, 'enforce'\)\s*on conflict \(singleton\) do update set mode = 'enforce'/i, "dòng singleton phải đặt mode = 'enforce'");
// (thay bằng khẳng định tắt cả print-web-main lẫn legacy-public ở mục Codex 17/10 bên dưới)
assert.doesNotMatch(code, /print_access_keys set enabled = true/i, "không bật lại khoá chung nào");
assert.match(code, /create table if not exists public\.floor_access_denials\s*\([\s\S]*?fn text not null[\s\S]*?has_token boolean not null[\s\S]*?bucket timestamptz not null[\s\S]*?primary key \(fn, has_token, bucket\)/i, "floor_access_denials sai khuôn (gộp theo phút)");
assert.match(code, /create index if not exists \w+ on public\.floor_access_denials\s*\(bucket\)/i, "thiếu index (bucket)");
for (const t of ["floor_access_settings", "floor_access_denials"]) {
  assert.match(code, new RegExp(`alter table public\\.${t} enable row level security`, "i"), `${t} chưa bật RLS`);
  assert.match(code, new RegExp(`revoke all on (table )?public\\.${t} from public,\\s*anon,\\s*authenticated`, "i"), `${t} chưa revoke`);
  assert.match(code, new RegExp(`grant [^;]* on (table )?public\\.${t} to service_role`, "i"), `${t} chưa grant service_role`);
}
assert.doesNotMatch(code, /floor_access_denials[^;]*token text/i, "không lưu token");

// ---------- floor_access_check ----------
const check = one("floor_access_check");
assert.equal(check.params, "p_access_token text, p_fn text");
assert.match(check.head, /returns text/i);
assert.match(check.head, /security definer/i);
assert.match(check.body, /public\.print_device_by_token\(p_access_token\)/);
assert.match(check.body, /insert into public\.floor_access_denials/i);
assert.match(check.body, /coalesce\(p_access_token,\s*''\) not in \('',\s*'public'\)/);
assert.match(check.body, /'warn'/);
assert.match(check.body, /'deny'/);
assert.match(check.body, /'log'/);
assert.ok(revokedAll("floor_access_check"), "floor_access_check phải revoke khỏi public, anon, authenticated");

// Gộp cờ cảnh báo + câu trả lời bị chặn.
const flag = one("floor_access_result");
assert.match(flag.body, /'warn'/);
assert.match(flag.body, /'accessWarning',\s*true/);
const denied = one("floor_access_denied");
assert.match(denied.body, /'ok',\s*false/);
assert.match(denied.body, /'ACCESS_DENIED'/);
assert.match(denied.body, /Máy chưa kích hoạt; vào ô KÍCH HOẠT MÁY\./);

// ---------- Nhóm ghi bị siết ----------
// Kiểm cổng của một hàm công khai: gọi check với tên hàm, chặn khi deny, gộp cờ qua floor_access_result, chạy thân nội bộ.
const gate = (def, fn, tokenArg) => {
  const call = new RegExp(`public\\.floor_access_check\\(${tokenArg},\\s*'${fn}'\\)`);
  assert.match(def.body, call, `${fn}(${def.params}) chưa gọi floor_access_check(${tokenArg}, '${fn}')`);
  assert.match(def.body, /if v_access = 'deny' then return public\.floor_access_denied\(\); end if;/, `${fn} chưa chặn khi deny`);
  assert.match(def.body, new RegExp(`return public\\.floor_access_result\\(v_access,\\s*public\\._${fn}_body\\(`), `${fn} chưa gộp cờ từ _${fn}_body`);
  assert.equal((def.body.match(/\breturn\b/g) || []).length, 2, `${fn}: chỉ có 2 chỗ return (deny + kết quả)`);
  assert.match(def.head, /returns jsonb/i);
  assert.match(def.head, /security definer set search_path\s*=\s*''/i);
};
// Thân nội bộ phải trùng nguyên văn thân ở tệp migration mới nhất.
const sameBody = (fn, source, params) => {
  const orig = defs(read(source).replace(/--[^\n]*/g, "")).filter(d => d.name === fn).pop();
  assert.ok(orig, `không thấy ${fn} trong ${source}`);
  const body = one(`_${fn}_body`);
  assert.equal(body.params, orig.params, `_${fn}_body phải giữ tham số ${orig.params}`);
  assert.equal(body.body.trim(), orig.body.trim(), `_${fn}_body khác thân trong ${source}`);
  assert.match(body.head, /returns jsonb/i);
  assert.ok(revokedAll(`_${fn}_body`), `_${fn}_body phải revoke khỏi public, anon, authenticated`);
  assert.ok(!granted(`_${fn}_body`, "anon|authenticated|public"), `_${fn}_body không được cấp quyền`);
  return orig;
};

const CUT = {
  cut_group_uid_scan: ["sku_inactive_v1.sql", "text, text"],
  cut_group_uid_mark_adj: ["cut_group_uid_v5_adj_export.sql", "text, text, boolean"],
  cut_group_uid_mark_queued: ["cut_group_uid_v4_allow_reprint.sql", "text, text[], uuid"],
  cut_group_uid_mark_result: ["cut_group_uid_v9_mark_result_missing_job.sql", "text, uuid, text"],
  cut_group_uid_adj_from_wms: ["cut_group_uid_v6_wms_reconcile.sql", "text, text[]"],
  cut_group_uid_adj_resolve: ["cut_group_uid_v8_adj_resolved.sql", "text, text[], text, boolean"],
};
for (const [fn, [source, sig]] of Object.entries(CUT)) {
  const orig = sameBody(fn, source);
  const pub = one(fn);
  assert.equal(pub.params, orig.params, `${fn} phải giữ nguyên chữ ký`);
  gate(pub, fn, "p_access_token");
  assert.ok(grantedSig(fn, sig, "anon") && grantedSig(fn, sig, "authenticated"), `${fn}(${sig}) phải cấp anon, authenticated`);
}
assert.doesNotMatch(code, /cut_group_uid_remove/, "cut_group_uid_remove đã revoke, không đụng");

const LEGACY = {
  cut_sample_scan: ["cut_sample_v1.sql", "uuid, text, text"],
  cut_sample_confirm: ["cut_sample_v1.sql", "uuid"],
  fabric_issue_scan: ["fabric_issue_v2_no_double_issue.sql", "uuid, text, text"],
  xa_vai_start: ["xa_vai_log_v2_single_slot.sql", "text"],
  xa_vai_end: ["xa_vai_log_v1.sql", "text"],
};
for (const [fn, [source, sig]] of Object.entries(LEGACY)) {
  const orig = sameBody(fn, source);
  const versions = find(fn);
  assert.equal(versions.length, 2, `${fn}: cần bản cũ + bản có khoá, thấy ${versions.length}`);
  const legacy = versions.find(d => d.params === orig.params);
  assert.ok(legacy, `${fn}: bản cũ (${orig.params}) phải còn`);
  gate(legacy, fn, "null");
  const fresh = versions.find(d => d !== legacy);
  assert.equal(fresh.params, `p_access_token text, ${orig.params}`, `${fn}: bản mới = p_access_token text + tham số cũ`);
  gate(fresh, fn, "p_access_token");
  assert.ok(grantedSig(fn, sig, "anon") && grantedSig(fn, sig, "authenticated"), `${fn}(${sig}) bản cũ vẫn cấp anon, authenticated`);
  const sigNew = `text, ${sig}`;
  assert.ok(grantedSig(fn, sigNew, "anon") && grantedSig(fn, sigNew, "authenticated"), `${fn}(${sigNew}) phải cấp anon, authenticated`);
}

// ---------- Hàm nội bộ không lộ ----------
for (const fn of ["floor_access_check", "floor_access_result", "floor_access_denied", "floor_access_purge"]) {
  assert.ok(!granted(fn, "anon|authenticated|public"), `${fn} không được cấp cho anon/authenticated`);
  assert.ok(revokedAll(fn), `${fn} phải revoke khỏi public, anon, authenticated`);
}

// ---------- RPC Admin ----------
const summary = one("floor_access_summary");
const setMode = one("floor_access_set_mode");
assert.equal(setMode.params, "p_mode text");
for (const [def, fn] of [[summary, "floor_access_summary"], [setMode, "floor_access_set_mode"]]) {
  assert.match(def.body, /if not public\.print_admin_allowed\(\) then/, `${fn} chưa kiểm print_admin_allowed`);
  assert.match(def.body, /'FORBIDDEN'/, `${fn} chưa trả FORBIDDEN`);
  assert.ok(revokedAll(fn), `${fn} phải revoke khỏi public, anon, authenticated`);
  assert.ok(granted(fn, "authenticated"), `${fn} phải cấp authenticated`);
  assert.ok(!granted(fn, "anon|public"), `${fn} không cấp anon`);
}
assert.match(summary.body, /interval '7 days'/);
for (const key of ["mode", "since", "items", "fn", "count", "withToken", "lastAt"]) assert.match(summary.body, new RegExp(`'${key}'`), `summary thiếu ${key}`);
assert.match(setMode.body, /p_mode not in \('log',\s*'enforce'\)|p_mode, ''\) not in \('log',\s*'enforce'\)/);
assert.match(setMode.body, /updated_by\s*=\s*\(?select auth\.uid\(\)\)?|updated_by\s*=\s*auth\.uid\(\)/);

// ---------- Codex 17/10: chỉ máy đã kích hoạt, thiếu cấu hình thì chặn, ghi nhận gộp theo phút ----------
const checkFn = one("floor_access_check");
assert.match(checkFn.body, /public\.print_device_by_token\(p_access_token\) is not null/, 'nhóm ghi phải kiểm máy đã kích hoạt (print_device_by_token), không dùng print_access_allowed (khoá chung)');
assert.doesNotMatch(checkFn.body, /print_access_allowed/, 'floor_access_check không được coi khoá chung là máy đã kích hoạt');
assert.match(checkFn.body, /when v_mode = 'log' then 'warn' else 'deny'/, 'thiếu dòng cấu hình hoặc mode lạ phải chặn (fail-closed)');
assert.match(code, /bucket timestamptz not null/, 'floor_access_denials phải gộp theo mốc phút (bucket)');
assert.doesNotMatch(code, /hits integer/, 'không còn bộ đếm hits (Codex vòng 2: tranh chấp khoá dòng khi bị gọi dồn)');
assert.match(checkFn.body, /insert into public\.floor_access_denials \(fn, has_token, bucket\)[\s\S]*on conflict \(fn, has_token, bucket\) do nothing/, 'ghi nhận một dòng mỗi phút, lần trùng bỏ qua (không update dòng nóng)');
assert.match(code, /update public\.print_access_keys set enabled = false, updated_at = now\(\) where name in \('print-web-main', 'legacy-public'\)/, 'phải tắt rõ cả print-web-main lẫn legacy-public');
assert.match(summary.body, /count\(\*\)[\s\S]*max\(d\.bucket\)/, 'summary đếm số phút có lượt gọi, lần cuối = bucket mới nhất');

// ---------- Dọn ----------
const purge = one("floor_access_purge");
assert.match(purge.params, /p_keep interval default interval '30 days'/);
assert.match(purge.body, /delete from public\.floor_access_denials/i);
assert.match(code, /select cron\.schedule\('floor-access-purge',\s*'55 20 \* \* \*',\s*\$\$select public\.floor_access_purge\(\)\$\$\)/);

// ---------- Mọi hàm security definer khoá search_path ----------
for (const d of mine) if (/security definer/i.test(d.head)) assert.match(d.head, /set search_path\s*=\s*''/, `${d.name} thiếu set search_path = ''`);

console.log(`floor_access_sql: PASS (${mine.length} định nghĩa hàm)`);
