-- Chi cho phep 1 UID dang xa vai tai mot thoi diem tren toan he thong. Phai ket
-- thuc UID dang xa moi duoc bat dau UID khac. Dung pg_advisory_xact_lock giong
-- sample_scan de tranh hai dien thoai cung bam Bat dau gan nhu dong thoi.
begin;

create or replace function public.xa_vai_start(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(p_group_uid), ''); v_gd public.group_uid_details; v_row public.xa_vai_log; v_running public.xa_vai_log;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  perform pg_advisory_xact_lock(hashtext('public.xa_vai_log_single_slot')::bigint);
  select * into v_running from public.xa_vai_log where ended_at is null limit 1;
  if found and v_running.group_uid_code <> v_code then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ANOTHER_RUNNING',
      'message','Đang có UID '||v_running.group_uid_code||' xả vải — vui lòng kết thúc UID đó trước khi bắt đầu UID khác.'));
  end if;
  select * into v_gd from public.group_uid_details where group_uid_code = v_code;
  if not found or coalesce(btrim(v_gd.sku),'') = '' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','UID chưa có dữ liệu SKU trong Group UID'));
  end if;
  insert into public.xa_vai_log(group_uid_code,sku,batch_code,roll_code,started_at)
  values(v_code,v_gd.sku,coalesce(v_gd.batch_code,''),coalesce(v_gd.roll_code,''),now())
  on conflict(group_uid_code) do nothing
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_STARTED','message','UID này đã bắt đầu xả vải trước đó'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'batchCode',v_row.batch_code,'rollCode',v_row.roll_code,'startedAt',v_row.started_at));
end $$;

-- Danh sach dang xa (started, chua ended) - voi rang buoc 1-tai-1-thoi-diem o
-- tren thi thuc te tra ve 0 hoac 1 dong, nhung van tra ve mang de frontend tu
-- xu ly dong nhat, khong gia dinh cung so luong.
create or replace function public.xa_vai_list_open()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'groupUid',l.group_uid_code,'sku',l.sku,'batchCode',l.batch_code,'rollCode',l.roll_code,
      'startedAt',l.started_at) order by l.started_at asc),'[]'::jsonb)
    into v_items
  from public.xa_vai_log l where l.ended_at is null;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items));
end $$;

revoke all on function public.xa_vai_list_open() from public;
grant execute on function public.xa_vai_list_open() to anon,authenticated;

commit;
