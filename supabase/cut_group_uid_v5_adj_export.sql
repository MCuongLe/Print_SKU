-- Danh dau Group UID da cat "da xuat ADJ" (phieu dieu chinh ton kho tren WMS da
-- dua UID ra khoi kho). Nguoi dung bam UID o "Tra cuu UID da cat" de mo popup
-- barcode, quet ma tren man hinh vao phieu ADJ cua WMS roi tick "Da xuat ADJ
-- xong" -> ghi adj_exported_at. Bo tick (bam nham) thi tra ve null. Tick lai mot
-- UID da tick (vd hai may cung luc) giu nguyen thoi diem tick dau tien.
--
-- Them bo loc ADJ cho cut_group_uid_search (p_adj: '' = tat ca, 'done' = da
-- xuat, 'pending' = chua xuat) va tra them adjExportedAt. Doi chu ky ham nen
-- phai drop chu ky v4 roi tao lai; p_adj co default nen trang web cu (goi theo
-- ten, khong co p_adj) van goi duoc ham moi.
begin;

alter table public.cut_group_uids add column if not exists adj_exported_at timestamptz;

create or replace function public.cut_group_uid_mark_adj(p_access_token text,p_group_uid text,p_done boolean)
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

drop function if exists public.cut_group_uid_search(text,text,text,date,date,integer);

create or replace function public.cut_group_uid_search(p_access_token text,p_sku text default '',p_lot text default '',p_date_from date default null,p_date_to date default null,p_adj text default '',p_limit integer default 5000)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,'')); v_adj text := lower(btrim(coalesce(p_adj,''))); v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
begin
  if v_adj not in ('','done','pending') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ADJ_FILTER','message','Bộ lọc ADJ không hợp lệ'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
      'printStatus',q.print_status,'cutAt',q.cut_at,'printedAt',q.printed_at,'adjExportedAt',q.adj_exported_at
    ) order by q.cut_at desc) from (
      select * from public.cut_group_uids c
       where (v_sku='' or c.sku ilike '%'||v_sku||'%')
         and (v_lot='' or c.lot ilike '%'||v_lot||'%')
         and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
         and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
         and (v_adj='' or (v_adj='done')=(c.adj_exported_at is not null))
       order by c.cut_at desc limit v_limit
    ) q),'[]'::jsonb),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'filterAdj',v_adj,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.cut_group_uid_mark_adj(text,text,boolean) from public;
revoke all on function public.cut_group_uid_search(text,text,text,date,date,text,integer) from public;
grant execute on function public.cut_group_uid_mark_adj(text,text,boolean) to anon,authenticated;
grant execute on function public.cut_group_uid_search(text,text,text,date,date,text,integer) to anon,authenticated;

commit;
notify pgrst,'reload schema';
