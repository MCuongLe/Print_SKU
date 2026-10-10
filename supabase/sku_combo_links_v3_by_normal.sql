-- Reverse lookup of v2: from a Normal SKU to the Combo SKUs that contain it.
-- quantity = Normal base units in one Combo (a thread Combo "cuộn 5000m" over a "/mm" Normal gives 5000000 = full-roll spec).
-- component_count lets the caller keep only single-component Combos; the table itself stays private.
begin;
create or replace function public.sku_combo_by_normal(p_sku text)
returns table(combo_sku text, product_name text, quantity numeric, component_count integer, available boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_sku is null or length(btrim(p_sku)) not between 1 and 64 then
    raise exception 'Invalid SKU';
  end if;
  return query
  select l.combo_sku, coalesce(nullif(c.product_name,''), l.combo_name), l.quantity,
         l.source_component_count,
         coalesce(c.status='1' and l.combo_product_status='Active',false)
  from public.sku_combo_links l
  left join public."SKU_Name" c on c.sku=l.combo_sku
  where l.normal_sku=btrim(p_sku) and l.combo_status='Active'
    and exists(select 1 from public."SKU_Name" x where x.category_id=l.combo_category_id)
    and exists(select 1 from public."SKU_Name" x where x.category_id=l.normal_category_id)
  order by coalesce(c.status='1' and l.combo_product_status='Active',false) desc, l.quantity, l.combo_sku
  limit 50;
end $$;
revoke all on function public.sku_combo_by_normal(text) from public;
grant execute on function public.sku_combo_by_normal(text) to anon,authenticated;
notify pgrst, 'reload schema';
commit;
