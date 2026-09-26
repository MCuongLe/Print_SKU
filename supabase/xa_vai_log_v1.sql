-- Theo doi Xa vai (relax vai sau khi cat) - so hoa "PHIEU THEO DOI XA VAI" giay
-- hien tai (STT, UID, Batch, Roll, SKU, Ngay bat dau xa, Gio bat dau xa, Gio xa
-- vai xong). Web chi doc/ghi qua RPC security definer, cung mo hinh voi Sample
-- va Cat Group UID - khong dang nhap, tra ve loi ro rang thay vi chan mo ho.
begin;

create table if not exists public.xa_vai_log (
  group_uid_code text primary key check (length(btrim(group_uid_code)) between 1 and 40),
  sku text not null check (length(btrim(sku)) between 1 and 40),
  batch_code text not null default '',
  roll_code text not null default '',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  check (ended_at is null or ended_at >= started_at)
);
create index if not exists xa_vai_log_sku_idx on public.xa_vai_log (sku, started_at desc);
create index if not exists xa_vai_log_open_idx on public.xa_vai_log (ended_at) where ended_at is null;
alter table public.xa_vai_log enable row level security;
revoke all on public.xa_vai_log from public,anon,authenticated;
grant select,insert,update on public.xa_vai_log to service_role;

-- Tra thong tin 1 UID: dang o trang thai nao (chua bat dau / dang xa / da xong),
-- de man hinh quyet dinh nut nao duoc bam ngay sau khi quet, khong can doi bam thu.
create or replace function public.xa_vai_lookup(p_group_uid text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_code text := nullif(btrim(p_group_uid), ''); v_gd public.group_uid_details; v_log public.xa_vai_log;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  select * into v_log from public.xa_vai_log where group_uid_code = v_code;
  if found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'groupUid',v_log.group_uid_code,'sku',v_log.sku,'batchCode',v_log.batch_code,'rollCode',v_log.roll_code,
      'startedAt',v_log.started_at,'endedAt',v_log.ended_at,
      'state', case when v_log.ended_at is not null then 'done' else 'running' end));
  end if;
  select * into v_gd from public.group_uid_details where group_uid_code = v_code;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','UID chưa có trong dữ liệu Group UID'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_gd.group_uid_code,'sku',coalesce(v_gd.sku,''),'batchCode',coalesce(v_gd.batch_code,''),'rollCode',coalesce(v_gd.roll_code,''),
    'startedAt',null,'endedAt',null,'state','new'));
end $$;

create or replace function public.xa_vai_start(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(p_group_uid), ''); v_gd public.group_uid_details; v_row public.xa_vai_log;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
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

create or replace function public.xa_vai_end(p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text := nullif(btrim(p_group_uid), ''); v_row public.xa_vai_log;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  select * into v_row from public.xa_vai_log where group_uid_code = v_code for update;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_STARTED','message','UID này chưa bấm bắt đầu xả vải'));
  end if;
  if v_row.ended_at is not null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_ENDED','message','UID này đã kết thúc xả vải lúc '||to_char(v_row.ended_at,'HH24:MI DD/MM')));
  end if;
  update public.xa_vai_log set ended_at = now() where group_uid_code = v_code returning * into v_row;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'batchCode',v_row.batch_code,'rollCode',v_row.roll_code,
    'startedAt',v_row.started_at,'endedAt',v_row.ended_at));
end $$;

-- Tra cuu/xuat Excel doi chieu, giong cach cut_group_uid_search dang lam.
create or replace function public.xa_vai_search(p_sku text default '', p_limit integer default 5000)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000); v_items jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
      'groupUid',l.group_uid_code,'sku',l.sku,'batchCode',l.batch_code,'rollCode',l.roll_code,
      'startedAt',l.started_at,'endedAt',l.ended_at) order by l.started_at desc),'[]'::jsonb)
    into v_items
  from (select * from public.xa_vai_log
        where nullif(btrim(p_sku),'') is null or sku ilike '%'||btrim(p_sku)||'%'
        order by started_at desc limit v_limit) l;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items));
end $$;

revoke all on function public.xa_vai_lookup(text) from public;
revoke all on function public.xa_vai_start(text) from public;
revoke all on function public.xa_vai_end(text) from public;
revoke all on function public.xa_vai_search(text,integer) from public;
grant execute on function public.xa_vai_lookup(text) to anon,authenticated;
grant execute on function public.xa_vai_start(text) to anon,authenticated;
grant execute on function public.xa_vai_end(text) to anon,authenticated;
grant execute on function public.xa_vai_search(text,integer) to anon,authenticated;

commit;
