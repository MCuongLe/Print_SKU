-- Read-only dashboard for storage risks in Combo -> Normal relationships.
-- The underlying table stays private; the browser receives only the fields
-- required to review missing and multiple links.
begin;

create or replace function public.sku_combo_risk_dashboard(
  p_kind text default 'summary',
  p_search text default '',
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_kind text := lower(coalesce(nullif(btrim(p_kind), ''), 'summary'));
  v_search text := btrim(coalesce(p_search, ''));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_scope integer;
  v_missing integer;
  v_multiple integer;
  v_total integer;
  v_total_links integer;
  v_max_links integer;
  v_items jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'admin'
  ) then
    raise insufficient_privilege using message = 'Admin access required';
  end if;

  if v_kind not in ('summary', 'missing', 'multiple') then
    raise exception 'Invalid risk kind';
  end if;

  select count(*) into v_scope
  from (
    select l.combo_sku from public.sku_combo_links l
    union
    select s.sku from public."SKU_Name" s
    where s.product_name ilike '(Combo)%'
  ) scope_rows;

  select count(*) into v_missing
  from public."SKU_Name" s
  where s.status = '1'
    and s.product_name ilike '(Combo)%'
    and not exists (
      select 1 from public.sku_combo_links l
      where l.combo_sku = s.sku and l.combo_status = 'Active'
    );

  select count(*) into v_multiple
  from (
    select l.combo_sku
    from public.sku_combo_links l
    where l.combo_status = 'Active'
    group by l.combo_sku
    having count(*) > 1
  ) multiple_rows;

  if v_kind = 'summary' then
    return jsonb_build_object(
      'ok', true,
      'data', jsonb_build_object(
        'scope', v_scope,
        'missing', v_missing,
        'multiple', v_multiple,
        'total', v_missing + v_multiple,
        'generatedAt', now()
      )
    );
  end if;

  if v_kind = 'missing' then
    select count(*) into v_total
    from public."SKU_Name" s
    where s.status = '1'
      and s.product_name ilike '(Combo)%'
      and not exists (
        select 1 from public.sku_combo_links l
        where l.combo_sku = s.sku and l.combo_status = 'Active'
      )
      and (v_search = '' or s.sku ilike '%' || v_search || '%'
           or s.product_name ilike '%' || v_search || '%'
           or s.category_name ilike '%' || v_search || '%');

    select coalesce(jsonb_agg(jsonb_build_object(
      'comboSku', x.sku,
      'comboName', x.product_name,
      'categoryId', x.category_id,
      'categoryName', x.category_name,
      'status', x.status,
      'normalCount', 0
    ) order by x.sku), '[]'::jsonb) into v_items
    from (
      select s.sku, s.product_name, s.category_id, s.category_name, s.status
      from public."SKU_Name" s
      where s.status = '1'
        and s.product_name ilike '(Combo)%'
        and not exists (
          select 1 from public.sku_combo_links l
          where l.combo_sku = s.sku and l.combo_status = 'Active'
        )
        and (v_search = '' or s.sku ilike '%' || v_search || '%'
             or s.product_name ilike '%' || v_search || '%'
             or s.category_name ilike '%' || v_search || '%')
      order by s.sku
      limit v_limit offset v_offset
    ) x;

    return jsonb_build_object(
      'ok', true,
      'data', jsonb_build_object(
        'kind', v_kind,
        'scope', v_scope,
        'riskTotal', v_missing,
        'filteredTotal', v_total,
        'multiple', v_multiple,
        'items', v_items,
        'limit', v_limit,
        'offset', v_offset,
        'generatedAt', now()
      )
    );
  end if;

  with grouped as (
    select l.combo_sku, count(*)::integer normal_count
    from public.sku_combo_links l
    where l.combo_status = 'Active'
    group by l.combo_sku
    having count(*) > 1
  ), filtered as (
    select g.combo_sku, g.normal_count,
           coalesce(nullif(s.product_name, ''), max(l.combo_name)) combo_name,
           coalesce(nullif(s.category_name, ''), max(l.combo_category_name)) category_name
    from grouped g
    join public.sku_combo_links l on l.combo_sku = g.combo_sku and l.combo_status = 'Active'
    left join public."SKU_Name" s on s.sku = g.combo_sku
    group by g.combo_sku, g.normal_count, s.product_name, s.category_name
  )
  select count(*), coalesce(sum(normal_count), 0), coalesce(max(normal_count), 0)
    into v_total, v_total_links, v_max_links
  from filtered f
  where v_search = '' or f.combo_sku ilike '%' || v_search || '%'
    or f.combo_name ilike '%' || v_search || '%'
    or f.category_name ilike '%' || v_search || '%';

  with grouped as (
    select l.combo_sku, count(*)::integer normal_count
    from public.sku_combo_links l
    where l.combo_status = 'Active'
    group by l.combo_sku
    having count(*) > 1
  ), filtered as (
    select g.combo_sku, g.normal_count,
           coalesce(nullif(s.product_name, ''), max(l.combo_name)) combo_name,
           coalesce(nullif(s.category_name, ''), max(l.combo_category_name)) category_name
    from grouped g
    join public.sku_combo_links l on l.combo_sku = g.combo_sku and l.combo_status = 'Active'
    left join public."SKU_Name" s on s.sku = g.combo_sku
    group by g.combo_sku, g.normal_count, s.product_name, s.category_name
  ), page as (
    select f.*
    from filtered f
    where v_search = '' or f.combo_sku ilike '%' || v_search || '%'
      or f.combo_name ilike '%' || v_search || '%'
      or f.category_name ilike '%' || v_search || '%'
    order by f.normal_count desc, f.combo_sku
    limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'comboSku', p.combo_sku,
    'comboName', p.combo_name,
    'categoryName', p.category_name,
    'normalCount', p.normal_count,
    'normals', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'normalSku', l.normal_sku,
        'normalName', coalesce(nullif(s.product_name, ''), l.normal_name),
        'categoryName', l.normal_category_name,
        'quantity', l.quantity,
        'available', coalesce(s.status = '1' and l.normal_product_status = 'Active', false)
      ) order by l.normal_sku), '[]'::jsonb)
      from public.sku_combo_links l
      left join public."SKU_Name" s on s.sku = l.normal_sku
      where l.combo_sku = p.combo_sku and l.combo_status = 'Active'
    )
  ) order by p.normal_count desc, p.combo_sku), '[]'::jsonb) into v_items
  from page p;

  return jsonb_build_object(
    'ok', true,
    'data', jsonb_build_object(
      'kind', v_kind,
      'scope', v_scope,
      'riskTotal', v_multiple,
      'filteredTotal', v_total,
      'totalLinks', v_total_links,
      'maxLinks', v_max_links,
      'missing', v_missing,
      'items', v_items,
      'limit', v_limit,
      'offset', v_offset,
      'generatedAt', now()
    )
  );
end $$;

revoke all on function public.sku_combo_risk_dashboard(text,text,integer,integer) from public;
revoke all on function public.sku_combo_risk_dashboard(text,text,integer,integer) from anon;
grant execute on function public.sku_combo_risk_dashboard(text,text,integer,integer) to authenticated;
notify pgrst, 'reload schema';

commit;
