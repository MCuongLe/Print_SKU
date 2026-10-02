-- Tên vị trí KHÔNG bắt buộc (02/10/2026): vị trí chỉ có mã thì tem in QR + mã, không in tên.
-- Tên trống lưu là chuỗi rỗng ''. Áp dụng sau warehouse_location_v1.sql:
--   python scripts/apply_supabase_sql.py supabase/warehouse_location_v2_optional_name.sql --allow-destructive
-- (--allow-destructive chỉ vì thay CHECK constraint của cột tên; không xoá dữ liệu nào.)
--
-- Hai thay đổi:
--   1. CHECK của cột tên: bỏ cận dưới 1 ký tự (giữ tối đa 60, không khoảng trắng hai đầu, không ký tự điều khiển).
--   2. warehouse_location_upsert: tên rỗng hợp lệ, và phân biệt hai trường hợp —
--        "name": "..."          → đặt tên đúng như gửi lên (kể cả "" = xoá tên);
--        không có "name"/null   → GIỮ NGUYÊN tên đang có (dán danh sách mã từ Excel không được
--                                 xoá tên của các vị trí đã đặt); mã mới thì không có tên.
--      Mã đã xoá (archived) vẫn được khôi phục khi lưu lại, kể cả khi không gửi tên.
-- print_enqueue không đổi: tên lấy từ bảng theo mã, tên rỗng chuyển nguyên cho agent.
begin;

alter table public.warehouse_locations drop constraint if exists warehouse_locations_location_name_check;
alter table public.warehouse_locations add constraint warehouse_locations_location_name_check
  check (char_length(location_name) <= 60 and location_name = btrim(location_name) and location_name !~ '[[:cntrl:]]');

create or replace function public.warehouse_location_upsert(p_access_token text,p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_total integer; v_bad record; v_dup text; v_created integer; v_updated integer;
begin
  if not public.print_access_allowed(p_access_token) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ACCESS_DENIED','message','Mã quyền không hợp lệ'));
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ITEMS','message','Mỗi lần lưu từ 1 đến 500 vị trí'));
  end if;
  v_total := jsonb_array_length(p_items);

  select i.line,i.code,i.name into v_bad from public.warehouse_location_parse(p_items) i
   where i.code !~ '^[0-9A-Z][0-9A-Z._/-]{0,39}$' or char_length(i.name) > 60 or i.name ~ '[[:cntrl:]]'
   order by i.line limit 1;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_LOCATION',
      'message',format('Dòng %s: mã cần 1–40 ký tự chữ hoa, số, . _ / - và tên (nếu có) tối đa 60 ký tự',v_bad.line),
      'data',jsonb_build_object('line',v_bad.line,'code',v_bad.code)));
  end if;
  select i.code into v_dup from public.warehouse_location_parse(p_items) i group by i.code having count(*)>1 order by min(i.line) limit 1;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','DUPLICATE_CODE',
      'message',format('Mã %s bị lặp trong danh sách',v_dup),'data',jsonb_build_object('code',v_dup)));
  end if;

  -- Một câu lệnh: chèn mã mới (không có tên thì tên rỗng) + cập nhật mã đã có. Hai nhánh dữ liệu
  -- cùng thấy bản chụp ban đầu nên mã vừa chèn không bị cập nhật lần hai.
  with src as (
    select i.line,i.code,i.name,(jsonb_typeof(p_items->(i.line-1)->'name')='string') as has_name
      from public.warehouse_location_parse(p_items) i
  ), ins as (
    insert into public.warehouse_locations as l(location_code,location_name)
    select s.code,s.name from src s order by s.line
    on conflict (location_code) do nothing
    returning 1
  ), upd as (
    update public.warehouse_locations l
       set location_name=case when s.has_name then s.name else l.location_name end,archived_at=null,updated_at=now()
      from src s
     where l.location_code=s.code
       and (l.archived_at is not null or (s.has_name and l.location_name is distinct from s.name))
    returning 1
  )
  select (select count(*) from ins),(select count(*) from upd) into v_created,v_updated;

  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'created',v_created,'updated',v_updated,'unchanged',greatest(v_total-v_created-v_updated,0),
    'codes',(select jsonb_agg(i.code order by i.line) from public.warehouse_location_parse(p_items) i)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.warehouse_location_upsert(text,jsonb) from public;
grant execute on function public.warehouse_location_upsert(text,jsonb) to anon,authenticated;

commit;
notify pgrst,'reload schema';
