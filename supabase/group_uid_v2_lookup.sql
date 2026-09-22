-- Read only label lookup for the existing public worker screen.
-- No warehouse/location, updater identity or inventory quantity is exposed.
begin;
create or replace function public.group_uid_lookup(p_codes text[])
returns table (group_uid_code text, sku text, product_name text, lot text, roll text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(cardinality(p_codes), 0) < 1 or cardinality(p_codes) > 100 then
    raise exception 'Supply 1 to 100 Group UID codes';
  end if;
  if exists(select 1 from unnest(p_codes) c where c is null or length(btrim(c)) not between 1 and 40) then
    raise exception 'Invalid Group UID code';
  end if;
  return query
    select g.group_uid_code, coalesce(g.sku, ''),
           coalesce(nullif(btrim(s.product_name), ''), g.product, ''),
           coalesce(g.batch_code, ''), coalesce(g.roll_code, '')
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku = g.sku
    where g.group_uid_code in (select btrim(c) from unnest(p_codes) c);
end $$;
revoke all on function public.group_uid_lookup(text[]) from public;
grant execute on function public.group_uid_lookup(text[]) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
