-- Them loc theo NGAY CAT (cut_at, gio Viet Nam) cho cut_group_uid_search, giong
-- bo loc "tu ngay -> den ngay" o Xa vai (xa_vai_search). Hai ngay de trong (null)
-- = khong loc, dung nhu ban v3. Doi chu ky (them p_date_from/p_date_to) nen phai
-- drop chu ky cu roi tao lai. Hai tham so moi co default nen trang web cu (goi
-- theo ten p_access_token/p_sku/p_lot/p_limit) van goi duoc ham moi.
begin;

drop function if exists public.cut_group_uid_search(text,text,text,integer);

create or replace function public.cut_group_uid_search(p_access_token text,p_sku text default '',p_lot text default '',p_date_from date default null,p_date_to date default null,p_limit integer default 5000)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,'')); v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
      'printStatus',q.print_status,'cutAt',q.cut_at,'printedAt',q.printed_at
    ) order by q.cut_at desc) from (
      select * from public.cut_group_uids c
       where (v_sku='' or c.sku ilike '%'||v_sku||'%')
         and (v_lot='' or c.lot ilike '%'||v_lot||'%')
         and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
         and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
       order by c.cut_at desc limit v_limit
    ) q),'[]'::jsonb),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.cut_group_uid_search(text,text,text,date,date,integer) from public;
grant execute on function public.cut_group_uid_search(text,text,text,date,date,integer) to anon,authenticated;

commit;
notify pgrst,'reload schema';
