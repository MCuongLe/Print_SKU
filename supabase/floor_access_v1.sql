-- KHOÁ MÁY CHO NHÓM GHI Ở XƯỞNG — bắt buộc ngay (17/10/2026, kế hoạch docs/plans/2026-10-17-khoa-may-nhom-ghi.md).
--
-- Vì sao: rà quyền cho thấy các hàm ghi ở xưởng (Cắt Group UID, lấy mẫu theo PO, cấp vải, xả vải) ai biết địa chỉ web
-- cũng gọi được bằng publishable key: 6 hàm cut_group_uid_* nhận p_access_token nhưng không kiểm; cut_sample_scan/confirm,
-- fabric_issue_scan, xa_vai_start/end không có tham số khoá. Người dùng chọn bắt khoá máy (như in tem) cho nhóm GHI;
-- tra cứu (list/search/get/lookup/reconcile) vẫn mở. Quyết định 17/10 tối: BỎ pha ghi nhận, bật 'enforce' ngay và tắt
-- khoá chung print-web-main (đo 17/10: 227/228 lệnh in 6 ngày qua đi qua máy đã kích hoạt).
--
-- Tác động:
--   * Bảng mới public.floor_access_settings (một dòng, mode 'log' | 'enforce'; cột mặc định 'log', tệp này đặt 'enforce') và
--     public.floor_access_denials (fn, has_token, at — KHÔNG lưu token). RLS bật, chỉ service_role; web đọc qua RPC Admin.
--   * Tắt khoá chung print-web-main trong print_access_keys: máy/trình duyệt nào còn dùng chuỗi đó sẽ không in và không
--     ghi được ở xưởng cho tới khi kích hoạt máy (ô KÍCH HOẠT MÁY).
--   * public.floor_access_check(token, fn) → 'ok' | 'warn' | 'deny': token hợp lệ (print_access_allowed) → 'ok';
--     ngược lại ghi một dòng denial rồi trả 'warn' (mode log) hoặc 'deny' (mode enforce). Không cấp cho anon/authenticated.
--   * Thân cũ của 11 hàm ghi được chép NGUYÊN VĂN thành hàm nội bộ public._<tên>_body (không cấp quyền). Hàm công khai cùng
--     tên gọi check → 'deny' trả {ok:false,error:{code:'ACCESS_DENIED'}}; còn lại chạy thân cũ, 'warn' gộp thêm
--     accessWarning:true vào phản hồi (mọi nhánh, kể cả lỗi nghiệp vụ). Máy chưa kích hoạt KHÔNG ghi được từ khi chạy tệp này.
--   * 6 hàm cut_group_uid_* (scan, mark_adj, mark_queued, mark_result, adj_from_wms, adj_resolve) giữ nguyên chữ ký.
--     cut_group_uid_remove đã revoke khỏi anon/authenticated từ v2 nên không đụng.
--   * cut_sample_scan, cut_sample_confirm, fabric_issue_scan, xa_vai_start, xa_vai_end: THÊM bản có p_access_token làm tham
--     số đầu (không default, để PostgREST không lẫn hai bản). GIỮ bản cũ không token để trang cũ chưa tải lại nhận
--     ACCESS_DENIED rõ ràng thay vì 404; bản cũ gọi floor_access_check(null, …) nên luôn bị chặn khi mode enforce.
--   * RPC Admin floor_access_summary() (7 ngày theo hàm) và floor_access_set_mode(p_mode), kiểm print_admin_allowed(),
--     chỉ cấp authenticated. Lùi khẩn cấp: Admin đặt mode 'log' (vẫn chạy + ghi nhận), không cần migration.
--   * Dọn: public.floor_access_purge(p_keep, mặc định 30 ngày) + pg_cron 'floor-access-purge' 20:55 UTC (03:55 giờ VN).
--     Ghi kết quả vào print_maintenance (tạo nếu chưa có).
--
-- Thứ tự lên: chạy migration NGOÀI GIỜ LÀM (buổi tối) → push web (gửi khoá + thông báo) ngay sau → sáng hôm sau nhân viên
-- tải lại trang; máy nào chưa kích hoạt thì vào ô KÍCH HOẠT MÁY. Xem floor_access_summary để biết máy còn sót.
-- Bản cũ không token drop ở floor_access_v2 khi không còn lượt gọi.
-- Chạy lại được (idempotent; chạy lại đặt lại 'enforce' và tắt lại print-web-main — cố ý); không drop, không xoá dữ liệu.
-- Kiểm cục bộ: node tests/floor_access_sql.cjs; python scripts/apply_supabase_sql.py supabase/floor_access_v1.sql --dry-run

begin;

-- ---------- Bảng ----------
create table if not exists public.floor_access_settings (
  singleton boolean primary key default true check (singleton),
  mode text not null default 'log' check (mode in ('log', 'enforce')),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
-- Quyết định 17/10 tối: bỏ pha ghi nhận, bật bắt buộc ngay. Chạy lại tệp cũng đặt lại 'enforce' (cố ý).
-- Muốn lùi về ghi nhận: Admin gọi floor_access_set_mode('log'), không cần migration.
insert into public.floor_access_settings(singleton, mode) values (true, 'enforce')
on conflict (singleton) do update set mode = 'enforce', updated_at = now();

-- Ghi nhận MỘT DÒNG cho mỗi (hàm, có khoá hay không, mốc phút); lần trùng trong cùng phút bỏ qua (on conflict do nothing):
-- publishable key công khai nên người ngoài gọi dồn cũng chỉ tạo tối đa 2 dòng/hàm/phút và không update một dòng nóng
-- (Codex 17/10 vòng 1 + 2). Mục đích là phát hiện máy còn sót, không cần đếm từng lượt.
create table if not exists public.floor_access_denials (
  fn text not null,
  has_token boolean not null,
  bucket timestamptz not null,
  primary key (fn, has_token, bucket)
);
create index if not exists floor_access_denials_bucket_idx on public.floor_access_denials (bucket);

alter table public.floor_access_settings enable row level security;
alter table public.floor_access_denials enable row level security;
revoke all on table public.floor_access_settings from public, anon, authenticated;
revoke all on table public.floor_access_denials from public, anon, authenticated;
grant select, insert, update, delete on table public.floor_access_settings to service_role;
grant select, insert, update, delete on table public.floor_access_denials to service_role;

-- Tắt khoá chung print-web-main (tạo 08/09, token không có trong repo): đo 17/10, 227/228 lệnh in 6 ngày qua đi qua máy
-- đã kích hoạt, lệnh còn lại là in lại của Admin. Còn bật thì ai có chuỗi đó vượt được cả khoá in lẫn khoá nhóm ghi.
-- Bật lại (nếu thật sự cần) bằng màn Admin Thiết bị in (print_access_key_set_enabled).
-- legacy-public đã tắt từ 12/10 nhưng print_devices_v1.sql tạo nó ở trạng thái bật khi dựng lại database → tắt rõ cả hai.
update public.print_access_keys set enabled = false, updated_at = now() where name in ('print-web-main', 'legacy-public');

create table if not exists public.print_maintenance (
  task text primary key,
  last_run_at timestamptz,
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------- Kiểm khoá máy ----------
-- Chỉ gọi từ hàm security definer khác (chạy dưới quyền chủ sở hữu); anon/authenticated không gọi thẳng được.
-- Nhóm ghi chỉ nhận MÁY ĐÃ KÍCH HOẠT (print_device_by_token), KHÔNG nhận khoá chung print_access_keys: Admin có bật lại
-- khoá chung để xử lý sự cố in cũng không mở cổng xưởng (Codex 17/10). Thiếu dòng cấu hình hoặc mode lạ → chặn.
create or replace function public.floor_access_check(p_access_token text, p_fn text)
returns text language plpgsql security definer set search_path = '' as $$
declare v_mode text;
begin
  if public.print_device_by_token(p_access_token) is not null then
    return 'ok';
  end if;
  insert into public.floor_access_denials (fn, has_token, bucket)
  values (left(coalesce(nullif(btrim(p_fn), ''), '?'), 60), coalesce(p_access_token, '') not in ('', 'public'), date_trunc('minute', now()))
  on conflict (fn, has_token, bucket) do nothing;
  select s.mode into v_mode from public.floor_access_settings s where s.singleton;
  return case when v_mode = 'log' then 'warn' else 'deny' end;
end $$;
revoke all on function public.floor_access_check(text, text) from public, anon, authenticated;

-- Phản hồi khi bị chặn (mode enforce).
create or replace function public.floor_access_denied()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'ACCESS_DENIED', 'message', 'Máy chưa kích hoạt; vào ô KÍCH HOẠT MÁY.'))
$$;
revoke all on function public.floor_access_denied() from public, anon, authenticated;

-- Gộp cờ accessWarning vào phản hồi của thân cũ khi check trả 'warn' (mọi nhánh: thành công lẫn lỗi nghiệp vụ).
create or replace function public.floor_access_result(p_access text, p_result jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p_access = 'warn' and jsonb_typeof(p_result) = 'object'
              then p_result || jsonb_build_object('accessWarning', true) else p_result end
$$;
revoke all on function public.floor_access_result(text, jsonb) from public, anon, authenticated;

-- ---------- Thân cũ thành hàm nội bộ (không cấp quyền; chỉ hàm công khai bên dưới gọi) ----------

-- cut_group_uid_scan: thân chép nguyên văn từ sku_inactive_v1.sql.
create or replace function public._cut_group_uid_scan_body(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text; v_source record; v_existing public.cut_group_uids; v_row public.cut_group_uids;
begin
  v_code := nullif(btrim(p_group_uid),'');
  if v_code is null or length(v_code)>40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_GROUP_UID','message','Group UID cần từ 1 đến 40 ký tự'));
  end if;
  select c.* into v_existing from public.cut_group_uids c where c.group_uid_code=v_code;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object(
      'code','ALREADY_CUT','message','Group UID này đã được cắt trước đó',
      'data',jsonb_build_object('groupUid',v_existing.group_uid_code,'sku',v_existing.sku,'status',v_existing.print_status,'cutAt',v_existing.cut_at)));
  end if;
  select g.group_uid_code,btrim(coalesce(g.sku,'')) sku,
         btrim(coalesce(s.product_name,'')) product_name,
         btrim(coalesce(g.batch_code,'')) lot,btrim(coalesce(g.roll_code,'')) roll,
         (s.sku is not null and s.status is distinct from '1') as sku_inactive
    into v_source
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku=g.sku
   where g.group_uid_code=v_code;
  if not found or v_source.sku='' or v_source.product_name='' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','Group UID chưa có đủ dữ liệu. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  insert into public.cut_group_uids(group_uid_code,sku,product_name,lot,roll)
  values(v_source.group_uid_code,v_source.sku,v_source.product_name,left(v_source.lot,20),left(v_source.roll,20))
  on conflict (group_uid_code) do nothing
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_CUT','message','Group UID này vừa được cắt trên thiết bị khác'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'productName',v_row.product_name,
    'lot',v_row.lot,'roll',v_row.roll,'printStatus',v_row.print_status,'cutAt',v_row.cut_at,'skuInactive',v_source.sku_inactive),
    'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end $$;
revoke all on function public._cut_group_uid_scan_body(text, text) from public, anon, authenticated;

-- cut_group_uid_mark_adj: thân chép nguyên văn từ cut_group_uid_v5_adj_export.sql.
create or replace function public._cut_group_uid_mark_adj_body(p_access_token text,p_group_uid text,p_done boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text := nullif(btrim(coalesce(p_group_uid,'')),''); v_row public.cut_group_uids;
begin
  if v_code is null or p_done is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Thiếu UID hoặc trạng thái ADJ'));
  end if;
  update public.cut_group_uids
     set adj_exported_at=case when p_done then coalesce(adj_exported_at,now()) else null end,updated_at=now()
   where group_uid_code=v_code
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','UID chưa có trong danh sách đã cắt'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('groupUid',v_row.group_uid_code,'adjExportedAt',v_row.adj_exported_at),
    'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end$$;
revoke all on function public._cut_group_uid_mark_adj_body(text, text, boolean) from public, anon, authenticated;

-- cut_group_uid_mark_queued: thân chép nguyên văn từ cut_group_uid_v4_allow_reprint.sql.
create or replace function public._cut_group_uid_mark_queued_body(p_access_token text,p_codes text[],p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_job_id is null or coalesce(cardinality(p_codes),0) not between 1 and 100 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_PRINT_JOB','message','Lệnh in không hợp lệ'));
  end if;
  select count(*) into v_count from public.cut_group_uids where group_uid_code=any(p_codes) and print_status in ('pending','failed','printed');
  if v_count<>cardinality(p_codes) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','QUEUE_CONFLICT','message','Danh sách chờ in vừa thay đổi. Hãy tải lại.'));
  end if;
  update public.cut_group_uids set print_status='queued',print_job_id=p_job_id,queued_at=now(),updated_at=now()
   where group_uid_code=any(p_codes) and print_status in ('pending','failed','printed');
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;
revoke all on function public._cut_group_uid_mark_queued_body(text, text[], uuid) from public, anon, authenticated;

-- cut_group_uid_mark_result: thân chép nguyên văn từ cut_group_uid_v9_mark_result_missing_job.sql.
create or replace function public._cut_group_uid_mark_result_body(p_access_token text,p_job_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer; v_job_status text; v_missing boolean;
begin
  if p_status not in ('printed','failed') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_STATUS','message','Kết quả in không hợp lệ'));
  end if;
  select j.status into v_job_status from public.print_jobs j where j.id=p_job_id;
  v_missing := not found;
  if (v_missing and p_status='printed')
     or (not v_missing and ((p_status='printed' and v_job_status<>'completed') or (p_status='failed' and v_job_status not in ('failed','cancelled')))) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','JOB_NOT_FINISHED','message','Lệnh in chưa có kết quả phù hợp'));
  end if;
  update public.cut_group_uids set print_status=p_status,printed_at=case when p_status='printed' then now() else printed_at end,updated_at=now()
   where print_job_id=p_job_id and print_status='queued';
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id,'status',p_status),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;
revoke all on function public._cut_group_uid_mark_result_body(text, uuid, text) from public, anon, authenticated;

-- cut_group_uid_adj_from_wms: thân chép nguyên văn từ cut_group_uid_v6_wms_reconcile.sql.
create or replace function public._cut_group_uid_adj_from_wms_body(p_access_token text, p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_codes text[]; v_updated integer;
begin
  select coalesce(array_agg(distinct btrim(x)),'{}') into v_codes from unnest(coalesce(p_codes,'{}')) x where nullif(btrim(x),'') is not null;
  if cardinality(v_codes) not between 1 and 200 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lượt chọn từ 1 đến 200 UID'));
  end if;
  with eligible as (
    select c.group_uid_code, min(w.cut_at) as wms_at
      from public.cut_group_uids c
      join public.wms_group_uid_cuts w on w.group_uid_code = c.group_uid_code and w.cut_at >= c.cut_at
     where c.group_uid_code = any(v_codes) and c.adj_exported_at is null
     group by c.group_uid_code
    having count(*) = 1
  ), changed as (
    update public.cut_group_uids c set adj_exported_at = e.wms_at, updated_at = now()
      from eligible e where c.group_uid_code = e.group_uid_code and c.adj_exported_at is null
    returning c.group_uid_code, c.adj_exported_at
  )
  select count(*) into v_updated from changed;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('updated',v_updated,'skipped',cardinality(v_codes)-v_updated),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;
revoke all on function public._cut_group_uid_adj_from_wms_body(text, text[]) from public, anon, authenticated;

-- cut_group_uid_adj_resolve: thân chép nguyên văn từ cut_group_uid_v8_adj_resolved.sql.
create or replace function public._cut_group_uid_adj_resolve_body(p_access_token text, p_codes text[], p_state text, p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_codes text[]; v_count integer;
begin
  if p_done is null or (p_done and coalesce(p_state,'') not in ('wrong','missing','multi','forgot')) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Trạng thái lệch không hợp lệ'));
  end if;
  select coalesce(array_agg(distinct c),'{}') into v_codes
    from (select nullif(btrim(x),'') c from unnest(coalesce(p_codes,'{}'::text[])) as t(x)) s where c is not null;
  if cardinality(v_codes) not between 1 and 500 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Chọn từ 1 đến 500 UID'));
  end if;
  update public.cut_group_uids
     set adj_resolved_at = case when p_done then now() else null end,
         adj_resolved_state = case when p_done then p_state else null end,
         updated_at = now()
   where group_uid_code = any(v_codes);
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'missing',cardinality(v_codes)-v_count),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;
revoke all on function public._cut_group_uid_adj_resolve_body(text, text[], text, boolean) from public, anon, authenticated;

-- cut_sample_scan: thân chép nguyên văn từ cut_sample_v1.sql.
create or replace function public._cut_sample_scan_body(p_session uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(coalesce(p_group_uid, '')), ''); v_item public.cut_sample_items; v_other text; v_result text;
begin
  if v_code is null or length(v_code) > 40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_UID', 'message', 'Mã Group UID không hợp lệ'));
  end if;
  if not exists(select 1 from public.cut_sample_sessions where id = p_session) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu đã bị xóa'));
  end if;
  select i.* into v_item from public.cut_sample_items i where i.group_uid_code = v_code;
  if not found then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_IN_SESSION', 'message', 'UID không thuộc phiên lấy mẫu nào'));
  end if;
  if v_item.session_id <> p_session then
    select s.po into v_other from public.cut_sample_sessions s where s.id = v_item.session_id;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'OTHER_SESSION', 'message', 'UID thuộc phiên của PO khác',
      'data', jsonb_build_object('po', v_other, 'sessionId', v_item.session_id, 'item', public.cut_sample_item_json(v_item))));
  end if;
  update public.cut_sample_items i set scanned_at = now(), scanned_by = nullif(left(btrim(coalesce(p_by, '')), 60), '')
   where i.id = v_item.id and i.scanned_at is null returning i.* into v_item;
  if found then v_result := 'scanned';
  else
    v_result := 'already';
    select i.* into v_item from public.cut_sample_items i where i.group_uid_code = v_code;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('result', v_result, 'item', public.cut_sample_item_json(v_item),
    'counts', public.cut_sample_counts(p_session)), 'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public._cut_sample_scan_body(uuid, text, text) from public, anon, authenticated;

-- cut_sample_confirm: thân chép nguyên văn từ cut_sample_v1.sql.
create or replace function public._cut_sample_confirm_body(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_pushed integer; v_marked integer; v_missing text[]; v_left integer;
begin
  if not exists(select 1 from public.cut_sample_sessions where id = p_session) then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'SESSION_NOT_FOUND', 'message', 'Phiên lấy mẫu đã bị xóa'));
  end if;
  with todo as (
    select i.id, i.group_uid_code, i.sku, i.lot, i.roll, btrim(coalesce(s.product_name, '')) as product_name
      from public.cut_sample_items i left join public."SKU_Name" s on s.sku = i.sku
     where i.session_id = p_session and i.role = 'cut' and i.scanned_at is not null and i.pushed_at is null
  ), ins as (
    insert into public.cut_group_uids(group_uid_code, sku, product_name, lot, roll)
    select t.group_uid_code, t.sku, t.product_name, left(t.lot, 20), left(t.roll, 20) from todo t where t.product_name <> ''
    on conflict (group_uid_code) do nothing returning group_uid_code
  ), mark as (
    update public.cut_sample_items i set pushed_at = now() from todo t where i.id = t.id and t.product_name <> '' returning i.group_uid_code
  )
  select (select count(*) from ins), (select count(*) from mark),
         coalesce((select array_agg(t.group_uid_code order by t.group_uid_code) from todo t where t.product_name = ''), '{}'::text[])
    into v_pushed, v_marked, v_missing;
  select count(*) into v_left from public.cut_sample_items where session_id = p_session and role = 'cut' and scanned_at is null;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('pushed', v_pushed, 'alreadyCut', greatest(v_marked - v_pushed, 0),
    'missingName', to_jsonb(v_missing), 'cutUnscanned', v_left, 'counts', public.cut_sample_counts(p_session)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public._cut_sample_confirm_body(uuid) from public, anon, authenticated;

-- fabric_issue_scan: thân chép nguyên văn từ fabric_issue_v2_no_double_issue.sql.
create or replace function public._fabric_issue_scan_body(p_plan_id uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(p_group_uid), '');
  v_by text := left(btrim(coalesce(p_by, '')), 60);
  v_plan public.fabric_issue_plans; v_line public.fabric_issue_lines; v_g public.group_uid_details;
  v_known boolean; v_other_id uuid; v_other_name text; v_result text;
  v_dup_name text; v_dup_at timestamptz; v_dup_by text;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  select * into v_plan from public.fabric_issue_plans where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại hoặc đã bị xóa'));
  end if;
  -- Tuan tu hoa moi lan quet CUNG UID (ke ca o dot khac nhau) tai day, roi moi khoa dong: kiem tra "da cap o dot khac" khong bi dua.
  perform pg_advisory_xact_lock(hashtextextended('fabric_issue:' || v_code, 0));
  select * into v_line from public.fabric_issue_lines where plan_id = p_plan_id and group_uid_code = v_code for update;
  if found then
    if v_line.scanned_at is not null then
      v_result := 'already';
    elsif v_plan.status <> 'open' then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_CLOSED','message','Đợt cấp vải đã đóng'));
    else
      select p.name, o.scanned_at, o.scanned_by into v_dup_name, v_dup_at, v_dup_by
        from public.fabric_issue_lines o join public.fabric_issue_plans p on p.id = o.plan_id
       where o.group_uid_code = v_code and o.plan_id <> p_plan_id and o.scanned_at is not null
       order by o.scanned_at desc limit 1;
      if found then
        select * into v_g from public.group_uid_details where group_uid_code = v_code;
        return jsonb_build_object('ok',false,
          'error', jsonb_build_object('code','ISSUED_ELSEWHERE','message','UID này đã được cấp ở đợt khác'),
          'data', jsonb_build_object('groupUid', v_code, 'sku', coalesce(v_g.sku, v_line.sku), 'lot', coalesce(v_g.batch_code, v_line.lot_no), 'roll', coalesce(v_g.roll_code, v_line.roll_no),
                                     'location', v_g.location, 'wmsStatus', v_g.status,
                                     'otherPlan', jsonb_build_object('name', v_dup_name, 'scannedAt', v_dup_at, 'scannedBy', v_dup_by)));
      end if;
      update public.fabric_issue_lines set scanned_at = now(), scanned_by = nullif(v_by, '') where id = v_line.id;
      v_result := 'issued';
    end if;
    return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'result', v_result,
      'line', (public.fabric_issue_lines_json(p_plan_id, v_line.id)->0),
      'plan', public.fabric_issue_plan_json(p_plan_id)));
  end if;
  select * into v_g from public.group_uid_details where group_uid_code = v_code;
  v_known := found;
  select p.id, p.name into v_other_id, v_other_name
    from public.fabric_issue_lines l join public.fabric_issue_plans p on p.id = l.plan_id
   where l.group_uid_code = v_code and l.plan_id <> p_plan_id and p.status = 'open'
   order by p.created_at desc limit 1;
  return jsonb_build_object('ok',false,
    'error', jsonb_build_object(
      'code', case when v_known then 'NOT_IN_PLAN' else 'UID_UNKNOWN' end,
      'message', case when v_known then 'UID này không thuộc đợt cấp vải đang mở' else 'UID chưa có trong dữ liệu Group UID' end),
    'data', case when v_known then jsonb_build_object(
      'groupUid', v_g.group_uid_code, 'sku', coalesce(v_g.sku,''), 'lot', coalesce(v_g.batch_code,''), 'roll', coalesce(v_g.roll_code,''),
      'location', v_g.location, 'wmsStatus', v_g.status,
      'otherPlan', case when v_other_id is null then null else jsonb_build_object('id', v_other_id, 'name', v_other_name) end)
      else null end);
end$$;
revoke all on function public._fabric_issue_scan_body(uuid, text, text) from public, anon, authenticated;

-- xa_vai_start: thân chép nguyên văn từ xa_vai_log_v2_single_slot.sql.
create or replace function public._xa_vai_start_body(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(p_group_uid), ''); v_gd public.group_uid_details; v_row public.xa_vai_log; v_running public.xa_vai_log;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  perform pg_advisory_xact_lock(hashtext('public.xa_vai_log_single_slot')::bigint);
  select * into v_running from public.xa_vai_log where ended_at is null limit 1;
  if found and v_running.group_uid_code <> v_code then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ANOTHER_RUNNING',
      'message','Đang có UID '||v_running.group_uid_code||' xả vải — vui lòng kết thúc UID đó trước khi bắt đầu UID khác.'));
  end if;
  select * into v_gd from public.group_uid_details where group_uid_code = v_code;
  if not found or coalesce(btrim(v_gd.sku),'') = '' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','UID chưa có dữ liệu SKU trong Group UID'));
  end if;
  insert into public.xa_vai_log(group_uid_code,sku,batch_code,roll_code,started_at)
  values(v_code,v_gd.sku,coalesce(v_gd.batch_code,''),coalesce(v_gd.roll_code,''),now())
  on conflict(group_uid_code) do nothing
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_STARTED','message','UID này đã bắt đầu xả vải trước đó'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'batchCode',v_row.batch_code,'rollCode',v_row.roll_code,'startedAt',v_row.started_at));
end $$;
revoke all on function public._xa_vai_start_body(text) from public, anon, authenticated;

-- xa_vai_end: thân chép nguyên văn từ xa_vai_log_v1.sql.
create or replace function public._xa_vai_end_body(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(p_group_uid), ''); v_row public.xa_vai_log;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  select * into v_row from public.xa_vai_log where group_uid_code = v_code for update;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_STARTED','message','UID này chưa bấm bắt đầu xả vải'));
  end if;
  if v_row.ended_at is not null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_ENDED','message','UID này đã kết thúc xả vải lúc '||to_char(v_row.ended_at,'HH24:MI DD/MM')));
  end if;
  update public.xa_vai_log set ended_at = now() where group_uid_code = v_code returning * into v_row;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'batchCode',v_row.batch_code,'rollCode',v_row.roll_code,
    'startedAt',v_row.started_at,'endedAt',v_row.ended_at));
end $$;
revoke all on function public._xa_vai_end_body(text) from public, anon, authenticated;

-- ---------- Hàm công khai: kiểm khoá máy → thân cũ → gộp cờ accessWarning ----------

-- cut_group_uid_scan: giữ chữ ký, thêm kiểm khoá máy.
create or replace function public.cut_group_uid_scan(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_scan_body(p_access_token, p_group_uid));
end $$;

-- cut_group_uid_mark_adj: giữ chữ ký, thêm kiểm khoá máy.
create or replace function public.cut_group_uid_mark_adj(p_access_token text,p_group_uid text,p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_mark_adj');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_mark_adj_body(p_access_token, p_group_uid, p_done));
end $$;

-- cut_group_uid_mark_queued: giữ chữ ký, thêm kiểm khoá máy.
create or replace function public.cut_group_uid_mark_queued(p_access_token text,p_codes text[],p_job_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_mark_queued');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_mark_queued_body(p_access_token, p_codes, p_job_id));
end $$;

-- cut_group_uid_mark_result: giữ chữ ký, thêm kiểm khoá máy.
create or replace function public.cut_group_uid_mark_result(p_access_token text,p_job_id uuid,p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_mark_result');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_mark_result_body(p_access_token, p_job_id, p_status));
end $$;

-- cut_group_uid_adj_from_wms: giữ chữ ký, thêm kiểm khoá máy.
create or replace function public.cut_group_uid_adj_from_wms(p_access_token text, p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_adj_from_wms');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_adj_from_wms_body(p_access_token, p_codes));
end $$;

-- cut_group_uid_adj_resolve: giữ chữ ký, thêm kiểm khoá máy.
create or replace function public.cut_group_uid_adj_resolve(p_access_token text, p_codes text[], p_state text, p_done boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_group_uid_adj_resolve');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_group_uid_adj_resolve_body(p_access_token, p_codes, p_state, p_done));
end $$;

-- cut_sample_scan: bản cũ không khoá (trang cũ chưa tải lại) — luôn ghi nhận; mode enforce trả ACCESS_DENIED thay vì 404. Drop ở floor_access_v2.
create or replace function public.cut_sample_scan(p_session uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(null, 'cut_sample_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_sample_scan_body(p_session, p_group_uid, p_by));
end $$;

-- cut_sample_scan: bản mới, khoá máy là tham số đầu.
create or replace function public.cut_sample_scan(p_access_token text, p_session uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_sample_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_sample_scan_body(p_session, p_group_uid, p_by));
end $$;

-- cut_sample_confirm: bản cũ không khoá (trang cũ chưa tải lại) — luôn ghi nhận; mode enforce trả ACCESS_DENIED thay vì 404. Drop ở floor_access_v2.
create or replace function public.cut_sample_confirm(p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(null, 'cut_sample_confirm');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_sample_confirm_body(p_session));
end $$;

-- cut_sample_confirm: bản mới, khoá máy là tham số đầu.
create or replace function public.cut_sample_confirm(p_access_token text, p_session uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'cut_sample_confirm');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._cut_sample_confirm_body(p_session));
end $$;

-- fabric_issue_scan: bản cũ không khoá (trang cũ chưa tải lại) — luôn ghi nhận; mode enforce trả ACCESS_DENIED thay vì 404. Drop ở floor_access_v2.
create or replace function public.fabric_issue_scan(p_plan_id uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(null, 'fabric_issue_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._fabric_issue_scan_body(p_plan_id, p_group_uid, p_by));
end $$;

-- fabric_issue_scan: bản mới, khoá máy là tham số đầu.
create or replace function public.fabric_issue_scan(p_access_token text, p_plan_id uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'fabric_issue_scan');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._fabric_issue_scan_body(p_plan_id, p_group_uid, p_by));
end $$;

-- xa_vai_start: bản cũ không khoá (trang cũ chưa tải lại) — luôn ghi nhận; mode enforce trả ACCESS_DENIED thay vì 404. Drop ở floor_access_v2.
create or replace function public.xa_vai_start(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(null, 'xa_vai_start');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_start_body(p_group_uid));
end $$;

-- xa_vai_start: bản mới, khoá máy là tham số đầu.
create or replace function public.xa_vai_start(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_start');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_start_body(p_group_uid));
end $$;

-- xa_vai_end: bản cũ không khoá (trang cũ chưa tải lại) — luôn ghi nhận; mode enforce trả ACCESS_DENIED thay vì 404. Drop ở floor_access_v2.
create or replace function public.xa_vai_end(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(null, 'xa_vai_end');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_end_body(p_group_uid));
end $$;

-- xa_vai_end: bản mới, khoá máy là tham số đầu.
create or replace function public.xa_vai_end(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_access text;
begin
  v_access := public.floor_access_check(p_access_token, 'xa_vai_end');
  if v_access = 'deny' then return public.floor_access_denied(); end if;
  return public.floor_access_result(v_access, public._xa_vai_end_body(p_group_uid));
end $$;

revoke all on function public.cut_group_uid_scan(text, text) from public;
grant execute on function public.cut_group_uid_scan(text, text) to anon, authenticated;
revoke all on function public.cut_group_uid_mark_adj(text, text, boolean) from public;
grant execute on function public.cut_group_uid_mark_adj(text, text, boolean) to anon, authenticated;
revoke all on function public.cut_group_uid_mark_queued(text, text[], uuid) from public;
grant execute on function public.cut_group_uid_mark_queued(text, text[], uuid) to anon, authenticated;
revoke all on function public.cut_group_uid_mark_result(text, uuid, text) from public;
grant execute on function public.cut_group_uid_mark_result(text, uuid, text) to anon, authenticated;
revoke all on function public.cut_group_uid_adj_from_wms(text, text[]) from public;
grant execute on function public.cut_group_uid_adj_from_wms(text, text[]) to anon, authenticated;
revoke all on function public.cut_group_uid_adj_resolve(text, text[], text, boolean) from public;
grant execute on function public.cut_group_uid_adj_resolve(text, text[], text, boolean) to anon, authenticated;
revoke all on function public.cut_sample_scan(uuid, text, text) from public;
grant execute on function public.cut_sample_scan(uuid, text, text) to anon, authenticated;
revoke all on function public.cut_sample_scan(text, uuid, text, text) from public;
grant execute on function public.cut_sample_scan(text, uuid, text, text) to anon, authenticated;
revoke all on function public.cut_sample_confirm(uuid) from public;
grant execute on function public.cut_sample_confirm(uuid) to anon, authenticated;
revoke all on function public.cut_sample_confirm(text, uuid) from public;
grant execute on function public.cut_sample_confirm(text, uuid) to anon, authenticated;
revoke all on function public.fabric_issue_scan(uuid, text, text) from public;
grant execute on function public.fabric_issue_scan(uuid, text, text) to anon, authenticated;
revoke all on function public.fabric_issue_scan(text, uuid, text, text) from public;
grant execute on function public.fabric_issue_scan(text, uuid, text, text) to anon, authenticated;
revoke all on function public.xa_vai_start(text) from public;
grant execute on function public.xa_vai_start(text) to anon, authenticated;
revoke all on function public.xa_vai_start(text, text) from public;
grant execute on function public.xa_vai_start(text, text) to anon, authenticated;
revoke all on function public.xa_vai_end(text) from public;
grant execute on function public.xa_vai_end(text) to anon, authenticated;
revoke all on function public.xa_vai_end(text, text) from public;
grant execute on function public.xa_vai_end(text, text) to anon, authenticated;

-- ---------- RPC Admin ----------
-- Số lần máy chưa kích hoạt gọi hàm ghi trong 7 ngày, theo hàm.
create or replace function public.floor_access_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_since timestamptz := now() - interval '7 days'; v_set public.floor_access_settings;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được xem khoá máy xưởng'));
  end if;
  select * into v_set from public.floor_access_settings s where s.singleton;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'mode', coalesce(v_set.mode, 'enforce'), 'since', v_since, 'updatedAt', v_set.updated_at,
    'items', coalesce((select jsonb_agg(jsonb_build_object('fn', q.fn, 'count', q.n, 'withToken', q.with_token, 'lastAt', q.last_at)
                                        order by q.n desc, q.fn)
                         from (select d.fn, count(*) as n, count(*) filter (where d.has_token) as with_token, max(d.bucket) as last_at
                                 from public.floor_access_denials d where d.bucket >= v_since group by d.fn) q), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

create or replace function public.floor_access_set_mode(p_mode text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row public.floor_access_settings;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được đổi chế độ khoá máy xưởng'));
  end if;
  if p_mode is null or p_mode not in ('log', 'enforce') then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'INVALID_MODE', 'message', 'Chế độ khoá máy không hợp lệ'));
  end if;
  update public.floor_access_settings set mode = p_mode, updated_by = (select auth.uid()), updated_at = now()
   where singleton returning * into v_row;
  if not found then
    insert into public.floor_access_settings(singleton, mode, updated_by, updated_at)
    values (true, p_mode, (select auth.uid()), now()) returning * into v_row;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('mode', v_row.mode, 'updatedAt', v_row.updated_at),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;

revoke all on function public.floor_access_summary() from public, anon, authenticated;
revoke all on function public.floor_access_set_mode(text) from public, anon, authenticated;
grant execute on function public.floor_access_summary() to authenticated;
grant execute on function public.floor_access_set_mode(text) to authenticated;

-- ---------- Dọn ghi nhận cũ ----------
create or replace function public.floor_access_purge(p_keep interval default interval '30 days')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  v_keep interval := greatest(coalesce(p_keep, interval '30 days'), interval '1 day');
  n_deleted integer;
  v_result jsonb;
begin
  with gone as (
    delete from public.floor_access_denials where bucket < v_now - v_keep returning 1)
  select count(*) into n_deleted from gone;
  v_result := jsonb_build_object('ok', true, 'at', v_now, 'keep', v_keep::text, 'deleted', n_deleted,
                                 'remaining', (select count(*) from public.floor_access_denials));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('floor_access_purge', v_now, v_result, v_now)
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end $$;
revoke all on function public.floor_access_purge(interval) from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
-- 20:55 UTC = 03:55 giờ VN, sau print-assistant-purge 5 phút. Cùng tên thì pg_cron cập nhật lịch cũ.
select cron.schedule('floor-access-purge', '55 20 * * *', $$select public.floor_access_purge()$$);

notify pgrst, 'reload schema';

commit;
