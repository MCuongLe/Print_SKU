-- Exact-SKU lookup for the existing label-entry screens; table stays private.
begin;
create or replace function public.sku_combo_lookup(p_sku text)
returns table(normal_sku text, product_name text, category_name text, quantity numeric, available boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_sku is null or length(btrim(p_sku)) not between 1 and 64 then
    raise exception 'Invalid SKU';
  end if;
  return query
  select l.normal_sku, coalesce(nullif(s.product_name,''),l.normal_name),
         l.normal_category_name, l.quantity,
         coalesce(s.status='1' and l.normal_product_status='Active',false)
  from public.sku_combo_links l
  left join public."SKU_Name" s on s.sku=l.normal_sku
  where l.combo_sku=btrim(p_sku) and l.combo_status='Active'
    and exists(select 1 from public."SKU_Name" c where c.category_id=l.combo_category_id)
    and exists(select 1 from public."SKU_Name" c where c.category_id=l.normal_category_id)
  order by l.normal_sku;
end $$;
revoke all on function public.sku_combo_lookup(text) from public;
grant execute on function public.sku_combo_lookup(text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
