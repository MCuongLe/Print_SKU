-- Them loc theo Lot cho cut_group_uid_search, phuc vu viec chon tem de in
-- ngay tu bang tra cuu (loc theo SKU va Lot) roi "day" qua muc cho in, thay vi
-- chi chon trong danh sach cho in khong loc duoc. Doi tham so (them p_lot) nen
-- phai drop chu ky cu roi tao lai - create or replace khong doi duoc chu ky.
begin;

drop function if exists public.cut_group_uid_search(text,text,integer);

create or replace function public.cut_group_uid_search(p_access_token text,p_sku text default '',p_lot text default '',p_limit integer default 5000)
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
       order by c.cut_at desc limit v_limit
    ) q),'[]'::jsonb),
    'filterSku',v_sku,'filterLot',v_lot,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.cut_group_uid_search(text,text,text,integer) from public;
grant execute on function public.cut_group_uid_search(text,text,text,integer) to anon,authenticated;

commit;
notify pgrst,'reload schema';
