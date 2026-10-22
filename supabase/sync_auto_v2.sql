-- Đồng bộ tự động qua Extension, bản 2 (22/10/2026, Extension 0.10.7).
-- Vì sao: Extension (service worker, phiên Admin riêng) tự chạy thêm 2 việc mà trước đây Admin bấm tay trên web:
--   * cut_adj: đọc lịch sử Cut kho WH - MATERIAL - MTG (GET_GROUP_UID_HISTORY_PAGE) cho tab Đối chiếu ADJ của CẮT GROUP UID,
--     nạp bằng wms_group_uid_cut_import (cut_group_uid_v6_wms_reconcile.sql, kiểm Admin như cũ);
--   * storage_risk: Rủi ro lưu trữ = Kiểm kê 2 kho (sku_count_save_start/chunk/finish) + UID tạm (uid_temp_save).
--   Cần khoá thuê + giãn cách giữa các máy như sku / group_uid, và một hàm đọc mốc phủ lịch sử WMS nhẹ cho lượt gia tăng
--   (không gọi cả cut_group_uid_reconcile chỉ để lấy coverage).
-- Tác động:
--   * sync_auto_leases.kind nhận thêm 'cut_adj', 'storage_risk' (thay check sync_auto_leases_kind_check — tên mặc định của check
--     viết liền cột trong sync_auto_v1.sql; khối kiểm ngay sau dừng migration nếu còn check kind cũ mang tên khác).
--   * sync_auto_lease / sync_auto_release: thân chép nguyên văn sync_auto_v1.sql, chỉ đổi danh sách loại; cùng chữ ký nên chỉ
--     create or replace, quyền giữ như cũ (chỉ service_role, Edge sku-sync gọi).
--   * Hàm mới wms_cut_coverage() (Admin, JWT authenticated): {ok:true,data:null|{from,until,files,importedAt}} — đúng biểu thức
--     "coverage" mà cut_group_uid_reconcile (bản mới nhất cut_group_uid_po_v1.sql) trả cho web; không phải Admin → FORBIDDEN.
--   * Không đổi bảng dữ liệu nào khác, không xoá dữ liệu. Edge sku-sync (AUTO_KINDS 4 loại) deploy SAU migration này:
--     Edge mới gửi kind lạ cho hàm cũ → INVALID_LEASE.
-- Chạy lại nhiều lần được (drop constraint if exists / create or replace).
-- Lệnh (có ALTER TABLE … DROP CONSTRAINT nên apply_supabase_sql.py cần cờ; chỉ thay check kind, không xoá dữ liệu):
--   python scripts/apply_supabase_sql.py supabase/sync_auto_v2.sql --allow-destructive
-- Thứ tự lên: migration này → python scripts/deploy_sku_sync.py → Reload Extension 0.10.7 mọi máy (tải lại tab WMS/Inside) → push web.
begin;

alter table public.sync_auto_leases drop constraint if exists sync_auto_leases_kind_check;
alter table public.sync_auto_leases add constraint sync_auto_leases_kind_check
  check (kind in ('sku','group_uid','cut_adj','storage_risk'));
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'public.sync_auto_leases'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ~ '\mkind\M'
       and pg_get_constraintdef(oid) not like '%storage_risk%'
  ) then
    raise exception 'Còn ràng buộc check cột kind không có storage_risk (tên khác sync_auto_leases_kind_check); kiểm pg_constraint rồi sửa migration';
  end if;
end $$;

-- Khoá thuê: thân giữ nguyên sync_auto_v1.sql, chỉ thêm cut_adj, storage_risk vào danh sách loại.
create or replace function public.sync_auto_lease(p_kind text, p_holder text, p_ttl_seconds integer default 900,
  p_cooldown_seconds integer default 0)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_holder text := left(btrim(coalesce(p_holder,'')),80);
  v_ttl integer := least(greatest(coalesce(p_ttl_seconds,900),60),3600);
  v_cooldown integer := least(greatest(coalesce(p_cooldown_seconds,0),0),10800);
  v_row public.sync_auto_leases;
begin
  if p_kind is null or p_kind not in ('sku','group_uid','cut_adj','storage_risk') or v_holder = '' then
    raise exception 'INVALID_LEASE';
  end if;
  perform pg_advisory_xact_lock(hashtext('sync_auto_'||p_kind));
  select * into v_row from public.sync_auto_leases where kind = p_kind;
  if found and v_row.holder is not null and v_row.holder <> v_holder
     and v_row.leased_until is not null and v_row.leased_until >= now() then
    return jsonb_build_object('ok',false,'holder',v_row.holder,'leasedUntil',v_row.leased_until);
  end if;
  if v_cooldown > 0 and found and v_row.last_finished_at is not null
     and v_row.last_finished_at > now() - make_interval(secs => v_cooldown)
     and not (v_row.holder is not distinct from v_holder and v_row.leased_until is not null and v_row.leased_until >= now()) then
    return jsonb_build_object('ok',false,'reason','COOLDOWN','lastFinishedAt',v_row.last_finished_at,
      'retryAfter',v_row.last_finished_at + make_interval(secs => v_cooldown));
  end if;
  insert into public.sync_auto_leases(kind,holder,run_id,leased_until,updated_at)
  values (p_kind,v_holder,null,now()+make_interval(secs => v_ttl),now())
  on conflict (kind) do update set
    run_id = case when public.sync_auto_leases.holder = excluded.holder then public.sync_auto_leases.run_id end,
    holder = excluded.holder,
    leased_until = excluded.leased_until,
    updated_at = now()
  returning * into v_row;
  return jsonb_build_object('ok',true,'holder',v_row.holder,'leasedUntil',v_row.leased_until);
end $$;

-- Nhả khoá: thân giữ nguyên sync_auto_v1.sql, chỉ thêm cut_adj, storage_risk vào danh sách loại.
create or replace function public.sync_auto_release(p_kind text, p_holder text, p_finished boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_holder text := left(btrim(coalesce(p_holder,'')),80);
  v_count integer;
begin
  if p_kind is null or p_kind not in ('sku','group_uid','cut_adj','storage_risk') or v_holder = '' then
    raise exception 'INVALID_LEASE';
  end if;
  perform pg_advisory_xact_lock(hashtext('sync_auto_'||p_kind));
  update public.sync_auto_leases set holder = null, run_id = null, leased_until = null, updated_at = now(),
         last_finished_at = case when coalesce(p_finished,false) then now() else last_finished_at end
   where kind = p_kind and holder = v_holder;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok',true,'released',v_count > 0);
end $$;

-- Mốc phủ lịch sử Cut WMS đã nạp, cho lượt tự động cut_adj của Extension (đọc gia tăng từ until − 30 phút như nút Đọc WMS
-- trên web). Cùng biểu thức coverage với cut_group_uid_reconcile; null = chưa nạp lần nào → Extension đọc toàn bộ.
create or replace function public.wms_cut_coverage()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đọc mốc lịch sử WMS'));
  end if;
  return jsonb_build_object('ok',true,'data',(select case when count(*)=0 then null else jsonb_build_object(
        'from',min(data_from),'until',max(data_until),'files',count(*),'importedAt',max(created_at)) end
        from public.wms_group_uid_history_imports),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.sync_auto_lease(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.sync_auto_release(text,text,boolean) from public, anon, authenticated;
grant execute on function public.sync_auto_lease(text,text,integer,integer) to service_role;
grant execute on function public.sync_auto_release(text,text,boolean) to service_role;
revoke all on function public.wms_cut_coverage() from public, anon;
grant execute on function public.wms_cut_coverage() to authenticated;

comment on table public.sync_auto_leases is
  'Khoá thuê theo loại đồng bộ tự động (sku, group_uid, cut_adj, storage_risk) để chỉ một máy chạy tại một thời điểm.';

notify pgrst, 'reload schema';
commit;
