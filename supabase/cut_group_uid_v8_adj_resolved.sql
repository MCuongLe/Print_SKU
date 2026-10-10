-- CAT UID - Doi chieu ADJ: tick "Da xu ly" cho UID dang lech (10/10/2026).
-- Nguoi kho kiem tra xong mot UID dang bao lech (Sai so luong, Tick WMS khong co, Cut nhieu lan, Quen tick)
-- thi tick Da xu ly de luu lai: dashboard tach UID do khoi nhom lech sang nhom "Da xu ly".
-- Luu kem kieu lech luc xu ly (adj_resolved_state): neu sau do du lieu WMS doi lam UID roi vao kieu lech
-- khac, dau "da xu ly" khong con ap dung va UID hien lai o nhom lech moi.
-- Khong sua adj_exported_at hay du lieu WMS. Cung mo hinh quyen voi "Tick giup" (anon goi RPC).
--
-- Chay mot lan: python scripts/apply_supabase_sql.py supabase/cut_group_uid_v8_adj_resolved.sql
-- Chi THEM cot + ham moi; cut_group_uid_reconcile giu nguyen chu ky, chi tra them 2 truong.
begin;

alter table public.cut_group_uids add column if not exists adj_resolved_at timestamptz;
alter table public.cut_group_uids add column if not exists adj_resolved_state text;

create or replace function public.cut_group_uid_adj_resolve(p_access_token text, p_codes text[], p_state text, p_done boolean)
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

create or replace function public.cut_group_uid_reconcile(
  p_access_token text, p_sku text default '', p_lot text default '',
  p_date_from date default null, p_date_to date default null, p_limit integer default 5000
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,''));
        v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
        'printStatus',q.print_status,'cutAt',q.cut_at,'adjExportedAt',q.adj_exported_at,
        'adjResolvedAt',q.adj_resolved_at,'adjResolvedState',q.adj_resolved_state,
        'wmsCuts',coalesce((select jsonb_agg(jsonb_build_object('cutAt',w.cut_at,'qty',w.qty,'remaining',w.remaining_qty,'by',w.cut_by) order by w.cut_at)
                              from public.wms_group_uid_cuts w where w.group_uid_code=q.group_uid_code and w.cut_at>=q.cut_at),'[]'::jsonb)
      ) order by q.cut_at desc) from (
        select * from public.cut_group_uids c
         where (v_sku='' or c.sku ilike '%'||v_sku||'%')
           and (v_lot='' or c.lot ilike '%'||v_lot||'%')
           and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
           and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
         order by c.cut_at desc limit v_limit
      ) q),'[]'::jsonb),
    'coverage',(select case when count(*)=0 then null else jsonb_build_object(
        'from',min(data_from),'until',max(data_until),'files',count(*),'importedAt',max(created_at)) end
        from public.wms_group_uid_history_imports),
    'lastImport',(select jsonb_build_object('fileName',i.file_name,'createdAt',i.created_at,'cutRows',i.cut_rows,
        'newRows',i.new_rows,'changedRows',i.changed_rows,'dataUntil',i.data_until)
        from public.wms_group_uid_history_imports i order by i.created_at desc limit 1),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

revoke all on function public.cut_group_uid_adj_resolve(text,text[],text,boolean) from public;
grant execute on function public.cut_group_uid_adj_resolve(text,text[],text,boolean) to anon, authenticated;

commit;
notify pgrst, 'reload schema';
