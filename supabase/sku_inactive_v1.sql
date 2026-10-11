-- SKU ngừng hoạt động (11/10/2026) — bước 3, 4 và 5 của kế hoạch đã chốt:
--   * Định nghĩa: SKU ngừng = SKU_Name.status <> '1' (nguồn sự thật là Inside qua Extension sku-sync). Không xoá dòng.
--   * inactive_since: mốc SKU chuyển sang ngừng (trigger), dùng cho lưu trữ và hiển thị; quay lại hoạt động thì xoá mốc.
--   * Ẩn khỏi tìm kiếm/in: policy SELECT công khai trên SKU_Name chỉ còn trả SKU đang hoạt động (IN TEM SKU, TÌM SKU,
--     mọi lời gọi REST bằng publishable key). Các hàm SECURITY DEFINER (tra Group UID, Cắt UID, Combo, Admin) vẫn thấy đủ.
--   * Chặn in tem SKU mới cho SKU ngừng ở máy chủ (print_enqueue_unchecked, chỉ loại 'sku'; tem UID/vị trí vẫn in vì cuộn
--     vải còn trong kho). Cắt UID: vẫn lưu, trả cờ skuInactive để web cảnh báo.
--   * Lưu trữ: SKU ngừng quá 180 ngày, không còn UID sống, không trong Combo đang Active, không ở phiên xả vải đang mở,
--     không cắt trong 90 ngày → chuyển sang sku_archive (giữ nguyên cột + archived_at), pg_cron chủ nhật hằng tuần.
begin;

-- ---------- Mốc ngừng ----------
alter table public."SKU_Name" add column if not exists inactive_since timestamptz;
update public."SKU_Name" set inactive_since = coalesce(updated_at, now()) where status is distinct from '1' and inactive_since is null;
create index if not exists sku_name_inactive_idx on public."SKU_Name"(inactive_since) where inactive_since is not null;

create or replace function public.sku_name_inactive_since()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status is distinct from '1' then
    if tg_op = 'INSERT' or old.status = '1' or old.status is null then new.inactive_since := now();
    elsif new.inactive_since is null then new.inactive_since := coalesce(old.inactive_since, now());
    end if;
  else
    new.inactive_since := null;
  end if;
  return new;
end $$;
revoke all on function public.sku_name_inactive_since() from public, anon, authenticated;
drop trigger if exists sku_name_inactive_since on public."SKU_Name";
create trigger sku_name_inactive_since before insert or update of status, inactive_since on public."SKU_Name"
  for each row execute function public.sku_name_inactive_since();

-- ---------- Ẩn khỏi tìm kiếm công khai ----------
drop policy if exists "Enable read access for all users" on public."SKU_Name";
drop policy if exists sku_name_read_active on public."SKU_Name";
create policy sku_name_read_active on public."SKU_Name" for select to anon, authenticated using (status = '1');

-- ---------- Chặn in tem SKU ngừng ----------
create or replace function public.print_enqueue_unchecked(p_access_token text, p_nonce text, p_type text, p_template_version integer, p_payload jsonb, p_copies integer, p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean; v_items jsonb; v_bad integer; v_sum integer; v_device uuid; v_inactive text;
begin
  if p_type not in ('sku','group_uid','fabric_relaxation','location') or p_copies not between 1 and 500 or nullif(trim(p_nonce),'') is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Dữ liệu lệnh in không hợp lệ'));
  end if;
  if p_type = 'sku' then
    select string_agg(distinct x.sku, ', ' order by x.sku) into v_inactive
      from (select it.v->>'sku' as sku from jsonb_array_elements(public.print_job_items('sku', p_payload, p_copies)) as it(v)) x
      join public."SKU_Name" s on s.sku = x.sku
     where s.status is distinct from '1';
    if v_inactive is not null then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','SKU_INACTIVE','message','SKU đã ngừng hoạt động, không in tem mới: '||left(v_inactive,200)));
    end if;
  end if;
  if p_type = 'fabric_relaxation' then
    if p_template_version = 1 then
      if jsonb_typeof(p_payload->'itemCode') is distinct from 'string' or coalesce(p_payload->>'itemCode','') !~ '^[0-9A-Za-z._-]{1,40}$' then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mã hàng không hợp lệ'));
      end if;
    elsif p_template_version = 2 then
      if jsonb_typeof(p_payload->'itemCodes') is distinct from 'array' then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Danh sách mã hàng không hợp lệ'));
      end if;
      if jsonb_array_length(p_payload->'itemCodes') not between 1 and 5 or exists(
        select 1 from jsonb_array_elements(p_payload->'itemCodes') as item(value)
        where jsonb_typeof(item.value) is distinct from 'string'
           or coalesce(item.value #>> '{}','') !~ '^[0-9A-Za-z._-]{1,40}$'
      ) then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mỗi tem cần 1–5 mã hàng hợp lệ'));
      end if;
    elsif p_template_version = 3 then
      if coalesce(p_payload->>'handwritten','false') <> 'true' then
        return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Tem viết tay không hợp lệ'));
      end if;
    else
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Phiên bản tem Fabric Relaxation không được hỗ trợ'));
    end if;
  end if;
  if p_type = 'location' then
    if coalesce(p_template_version,1) <> 1 or jsonb_typeof(p_payload->'items') is distinct from 'array'
       or jsonb_array_length(p_payload->'items') not between 1 and 100 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mỗi lệnh in từ 1 đến 100 vị trí'));
    end if;
    select jsonb_agg(jsonb_build_object('code',x.code,'name',x.name,'copies',x.copies) order by x.ord),
           count(*) filter (where x.code !~ '^[0-9A-Z][0-9A-Z._/-]{0,39}$' or char_length(x.name) > 60 or x.name ~ '[[:cntrl:]]' or x.copies not between 1 and 500),
           sum(x.copies)
      into v_items,v_bad,v_sum
      from (select t.ord,
                   upper(btrim(coalesce(t.v->>'code',''))) as code,
                   btrim(regexp_replace(normalize(coalesce(t.v->>'name',''),NFC),'\s+',' ','g')) as name,
                   case when jsonb_typeof(t.v->'copies')='number' and (t.v->>'copies') ~ '^[0-9]{1,3}$' then (t.v->>'copies')::integer else 0 end as copies
              from jsonb_array_elements(p_payload->'items') with ordinality as t(v,ord)) x;
    if v_bad > 0 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mã vị trí cần 1–40 ký tự chữ hoa, số, . _ / -; tên tối đa 60 ký tự; số tem 1–500'));
    end if;
    if v_sum <> p_copies then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Tổng số tem không khớp lệnh in'));
    end if;
    p_payload := jsonb_build_object('items',v_items);
  end if;
  v_device := public.print_device_by_token(p_access_token);
  select exists(select 1 from public.print_jobs where nonce=p_nonce) into v_duplicate;
  insert into public.print_jobs(nonce,type,template_version,payload,copies,requested_by,device_id)
  values(p_nonce,p_type,greatest(coalesce(p_template_version,1),1),coalesce(p_payload,'{}'::jsonb),p_copies,left(coalesce(p_requested_by,''),100),v_device)
  on conflict(nonce) do update set updated_at=public.print_jobs.updated_at returning * into v_job;
  if not v_duplicate then
    insert into public.print_events(job_id,event_type,details) values(v_job.id,'queued',jsonb_build_object('copies',v_job.copies,'type',v_job.type));
    perform public.print_device_touch(p_access_token, true);
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end $$;
revoke all on function public.print_enqueue_unchecked(text,text,text,integer,jsonb,integer,text) from public, anon, authenticated;

-- ---------- Cắt UID: vẫn lưu, báo cờ skuInactive ----------
create or replace function public.cut_group_uid_scan(p_access_token text, p_group_uid text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_code text; v_source record; v_existing public.cut_group_uids; v_row public.cut_group_uids;
begin
  v_code := nullif(btrim(p_group_uid),'');
  if v_code is null or length(v_code)>40 or v_code ~ '[[:cntrl:]]' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_GROUP_UID','message','Group UID cần từ 1 đến 40 ký tự'));
  end if;
  select c.* into v_existing from public.cut_group_uids c where c.group_uid_code=v_code;
  if found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object(
      'code','ALREADY_CUT','message','Group UID này đã được cắt trước đó',
      'data',jsonb_build_object('groupUid',v_existing.group_uid_code,'sku',v_existing.sku,'status',v_existing.print_status,'cutAt',v_existing.cut_at)));
  end if;
  select g.group_uid_code,btrim(coalesce(g.sku,'')) sku,
         btrim(coalesce(s.product_name,'')) product_name,
         btrim(coalesce(g.batch_code,'')) lot,btrim(coalesce(g.roll_code,'')) roll,
         (s.sku is not null and s.status is distinct from '1') as sku_inactive
    into v_source
    from public.group_uid_details g
    left join public."SKU_Name" s on s.sku=g.sku
   where g.group_uid_code=v_code;
  if not found or v_source.sku='' or v_source.product_name='' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','GROUP_UID_NOT_READY','message','Group UID chưa có đủ dữ liệu. Hãy cập nhật dữ liệu Group UID rồi quét lại.'));
  end if;
  insert into public.cut_group_uids(group_uid_code,sku,product_name,lot,roll)
  values(v_source.group_uid_code,v_source.sku,v_source.product_name,left(v_source.lot,20),left(v_source.roll,20))
  on conflict (group_uid_code) do nothing
  returning * into v_row;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','ALREADY_CUT','message','Group UID này vừa được cắt trên thiết bị khác'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'groupUid',v_row.group_uid_code,'sku',v_row.sku,'productName',v_row.product_name,
    'lot',v_row.lot,'roll',v_row.roll,'printStatus',v_row.print_status,'cutAt',v_row.cut_at,'skuInactive',v_source.sku_inactive),
    'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end $$;

-- ---------- Lưu trữ SKU ngừng lâu ngày ----------
create table if not exists public.sku_archive (like public."SKU_Name" including defaults);
alter table public.sku_archive add column if not exists archived_at timestamptz not null default now();
alter table public.sku_archive add column if not exists archive_reason text not null default 'inactive';
create unique index if not exists sku_archive_sku_idx on public.sku_archive(sku, archived_at);
alter table public.sku_archive enable row level security;
revoke all on public.sku_archive from public, anon, authenticated;

create table if not exists public.print_maintenance (
  task text primary key, last_run_at timestamptz, last_result jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());

create or replace function public.sku_inactive_archive(p_keep interval default interval '180 days')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_moved integer; v_kept integer; v_result jsonb; v_cutoff timestamptz := now() - p_keep;
begin
  with candidates as (
    select s.* from public."SKU_Name" s
     where s.status is distinct from '1' and s.inactive_since is not null and s.inactive_since < v_cutoff
       and not exists (select 1 from public.group_uid_details g where g.sku = s.sku and g.status in ('Available','New','Processing'))
       and not exists (select 1 from public.sku_combo_links l where l.combo_status = 'Active' and (l.combo_sku = s.sku or l.normal_sku = s.sku))
       and not exists (select 1 from public.xa_vai_log x where x.sku = s.sku and x.ended_at is null)
       and not exists (select 1 from public.cut_group_uids c where c.sku = s.sku and c.cut_at > now() - interval '90 days')
  ), moved as (
    insert into public.sku_archive select c.*, now(), 'inactive' from candidates c returning sku
  ), gone as (
    delete from public."SKU_Name" s using moved m where s.sku = m.sku returning 1)
  select count(*) into v_moved from gone;
  select count(*) into v_kept from public."SKU_Name" where status is distinct from '1';
  v_result := jsonb_build_object('ok', true, 'cutoff', v_cutoff, 'archived', v_moved, 'inactiveRemaining', v_kept,
                                 'archiveTotal', (select count(*) from public.sku_archive));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('sku_inactive_archive', now(), v_result, now())
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end $$;
revoke all on function public.sku_inactive_archive(interval) from public, anon, authenticated;

create extension if not exists pg_cron with schema pg_catalog;
grant usage on schema cron to postgres;
-- Chủ nhật 20:45 UTC = 03:45 thứ hai giờ VN, sau hai lịch dọn hằng đêm.
select cron.schedule('sku-inactive-archive', '45 20 * * 0', $$select public.sku_inactive_archive()$$);

notify pgrst, 'reload schema';
commit;
