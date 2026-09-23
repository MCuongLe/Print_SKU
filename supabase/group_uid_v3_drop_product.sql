-- Product names come from SKU_Name. Update the lookup before dropping the
-- legacy WMS copy, so readers never reference the removed column.
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
           coalesce(nullif(btrim(s.product_name), ''), ''),
           coalesce(g.batch_code, ''), coalesce(g.roll_code, '')
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku = g.sku
    where g.group_uid_code in (select btrim(c) from unnest(p_codes) c);
end $$;
alter table public.group_uid_details drop column product;
comment on table public.group_uid_details is 'WMS snapshot: one row per Group UID. Product name is looked up in SKU_Name by SKU. Source dates use UTC+07:00.';
notify pgrst, 'reload schema';
commit;
