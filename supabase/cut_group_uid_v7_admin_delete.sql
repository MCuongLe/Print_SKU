-- CAT UID: Admin dang nhap duoc xoa Group UID da cat (08/10/2026).
-- cut_group_uid_remove (v1) van khoa voi anon/authenticated tu v2_lock_delete. Ham moi chi cap cho
-- authenticated va tu kiem vai tro admin bang auth.uid() (public.group_uid_admin_allowed, ban v4),
-- nen nguoi khong dang nhap goi thang REST cung bi Postgres tu choi.
-- Moi dong bi xoa duoc chep nguyen vao cut_group_uid_deletions (ai xoa, luc nao) de truy vet -
-- 25/09/2026 tung mat dong khong ro nguyen nhan. Khong xoa dong dang gui may in (print_status='queued').
--
-- Chay mot lan: python scripts/apply_supabase_sql.py supabase/cut_group_uid_v7_admin_delete.sql
-- Chi THEM (bang nhat ky, ham); khong sua ham cu.
begin;

create table if not exists public.cut_group_uid_deletions (
  id bigint generated always as identity primary key,
  group_uid_code text not null,
  row_data jsonb not null,
  deleted_by uuid,
  deleted_by_email text,
  deleted_at timestamptz not null default now()
);
create index if not exists cut_group_uid_deletions_code_idx on public.cut_group_uid_deletions (group_uid_code, deleted_at desc);
alter table public.cut_group_uid_deletions enable row level security;
revoke all on public.cut_group_uid_deletions from public, anon, authenticated;
grant select, insert on public.cut_group_uid_deletions to service_role;

create or replace function public.cut_group_uid_admin_delete(p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_codes text[]; v_queued text[]; v_deleted text[];
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xóa Group UID đã cắt'));
  end if;
  select coalesce(array_agg(distinct c),'{}') into v_codes
    from (select nullif(btrim(x),'') c from unnest(coalesce(p_codes,'{}'::text[])) as t(x)) s where c is not null;
  if cardinality(v_codes) not between 1 and 500 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Chọn từ 1 đến 500 Group UID để xóa'));
  end if;
  select coalesce(array_agg(group_uid_code order by group_uid_code),'{}') into v_queued
    from public.cut_group_uids where group_uid_code = any(v_codes) and print_status = 'queued';
  if cardinality(v_queued) > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','QUEUED','message','Có UID đang gửi máy in. Chờ in xong rồi xóa.','data',jsonb_build_object('codes',to_jsonb(v_queued))));
  end if;
  with d as (
    delete from public.cut_group_uids where group_uid_code = any(v_codes) and print_status <> 'queued' returning *
  ), a as (
    insert into public.cut_group_uid_deletions (group_uid_code, row_data, deleted_by, deleted_by_email)
    select d.group_uid_code, to_jsonb(d), (select auth.uid()), (select auth.jwt()->>'email') from d
    returning group_uid_code
  )
  select coalesce(array_agg(group_uid_code order by group_uid_code),'{}') into v_deleted from a;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',cardinality(v_deleted),'codes',to_jsonb(v_deleted),'missing',cardinality(v_codes)-cardinality(v_deleted)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.cut_group_uid_admin_delete(text[]) from public, anon;
grant execute on function public.cut_group_uid_admin_delete(text[]) to authenticated;

commit;
notify pgrst, 'reload schema';
