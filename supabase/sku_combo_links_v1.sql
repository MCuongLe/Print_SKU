-- One row relates a Combo SKU to one Normal SKU, in the Normal SKU unit.
-- Categories/names are source snapshots; inactive SKUs may not exist in SKU_Name.
begin;
create table public.sku_combo_links (
  combo_sku text not null check (btrim(combo_sku) <> ''),
  normal_sku text not null check (btrim(normal_sku) <> ''),
  quantity numeric not null check (quantity > 0 and quantity <> 'NaN'::numeric and quantity <> 'Infinity'::numeric),
  combo_name text not null,
  normal_name text not null,
  combo_category_id text not null,
  combo_category_name text not null,
  normal_category_id text not null,
  normal_category_name text not null,
  combo_product_status text not null,
  normal_product_status text not null,
  combo_status text not null check (combo_status in ('Active','In-Active')),
  source_modified_at timestamptz not null,
  source_component_count integer not null check (source_component_count > 0),
  combo_scope_complete boolean not null,
  imported_at timestamptz not null default now(),
  primary key (combo_sku, normal_sku),
  check (combo_sku <> normal_sku)
);
comment on table public.sku_combo_links is 'Inside Combo export: one Combo-to-Normal relationship per row. Both source categories must exist in SKU_Name when imported. Product/category names and statuses are snapshots.';
comment on column public.sku_combo_links.quantity is 'Number of Normal SKU base units in one Combo SKU; preserve source quantity without converting units.';
comment on column public.sku_combo_links.combo_status is 'Status of the combo definition, independent of the parent product status.';
create index sku_combo_links_normal_sku_idx on public.sku_combo_links(normal_sku);
create index sku_combo_links_category_idx on public.sku_combo_links(combo_category_id,normal_category_id);
create function public.validate_sku_combo_link_categories()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (select 1 from public."SKU_Name" where category_id = new.combo_category_id)
     or not exists (select 1 from public."SKU_Name" where category_id = new.normal_category_id) then
    raise exception 'Both SKU categories must exist in SKU_Name';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_sku_combo_link_categories() from public,anon,authenticated;
create trigger sku_combo_links_category_scope
before insert or update on public.sku_combo_links
for each row execute function public.validate_sku_combo_link_categories();
alter table public.sku_combo_links enable row level security;
revoke all on public.sku_combo_links from public,anon,authenticated;
grant select,insert,update on public.sku_combo_links to service_role;
commit;
