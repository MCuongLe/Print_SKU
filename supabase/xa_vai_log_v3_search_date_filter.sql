-- Cum 3 doi thanh "Da xa xong": chi con dung UID da ket thuc (ended_at
-- khong null) - UID dang xa da co cum 2 rieng roi, khong can lan vao day
-- nua. Them loc theo ngay bat dau xa (theo gio VN, giong cot "Ngay bat dau
-- xa" da hien tren bang) de doi chieu theo tung ngay. Doi tham so nen phai
-- drop chu ky cu roi tao lai.
begin;

drop function if exists public.xa_vai_search(text,integer);

create or replace function public.xa_vai_search(p_sku text default '', p_date date default null, p_limit integer default 5000)
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
          and (p_date is null or (started_at at time zone 'Asia/Ho_Chi_Minh')::date = p_date)
        order by started_at desc limit v_limit) l;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items));
end $$;

revoke all on function public.xa_vai_search(text,date,integer) from public;
grant execute on function public.xa_vai_search(text,date,integer) to anon,authenticated;

commit;
notify pgrst,'reload schema';
