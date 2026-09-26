-- Doi loc theo 1 ngay thanh loc theo KHOANG ngay (tu ngay ... den ngay ...),
-- van theo cot "Ngay bat dau xa" (gio VN) da hien tren bang. Doi tham so nen
-- phai drop chu ky cu roi tao lai.
begin;

drop function if exists public.xa_vai_search(text,date,integer);

create or replace function public.xa_vai_search(p_sku text default '', p_date_from date default null, p_date_to date default null, p_limit integer default 5000)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000); v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'groupUid',l.group_uid_code,'sku',l.sku,'batchCode',l.batch_code,'rollCode',l.roll_code,
      'startedAt',l.started_at,'endedAt',l.ended_at) order by l.started_at desc),'[]'::jsonb)
    into v_items
  from (select * from public.xa_vai_log
        where ended_at is not null
          and (nullif(btrim(p_sku),'') is null or sku ilike '%'||btrim(p_sku)||'%')
          and (p_date_from is null or (started_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
          and (p_date_to is null or (started_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
        order by started_at desc limit v_limit) l;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items));
end $$;

revoke all on function public.xa_vai_search(text,date,date,integer) from public;
grant execute on function public.xa_vai_search(text,date,date,integer) to anon,authenticated;

commit;
notify pgrst,'reload schema';
