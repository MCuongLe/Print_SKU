-- Vệ sinh backend sau review 23/10/2026 (đợt B, docs/plans/2026-10-23-dot-b-ve-sinh-backend.md; bằng chứng trong
-- outputs/backend-review/, không vào git). Người dùng chốt C1–C3 ngày 23/10/2026.
--
-- Vì sao: soát quyền hàm + luồng in + luồng đồng bộ 23/10/2026 tìm ra một loạt lỗ nhỏ gom được vào một migration không phá:
--   (a) P2  Lệnh in hết lease ở bước sending/spooling (đã gửi byte xuống máy in) về hàng đợi cho agent BẤT KỲ: khi có agent thứ
--           hai (may-kho-02) sẽ in trùng. BẮT BUỘC chạy trước khi cài may-kho-02.
--   (b) Q2  Quyền mặc định schema public tự cấp EXECUTE / ALL cho anon, authenticated (grant riêng theo schema của Supabase).
--   (c) Q4/P3c/P4  print_enqueue_unchecked không giới hạn số dòng / tổng số tem / phiên bản tem cho sku, group_uid (agent mới
--           từ chối, trigger PO đã ghi lúc INSERT); chặn SKU ngừng so mã chưa btrim.
--   (d) Q8  cut_group_uid_mark_queued nhận p_job_id tuỳ ý.
--   (e) D5  Lượt đồng bộ SKU kẹt 'applying' không ai dọn.
--   (f) D8  Nạp Cut WMS nhận mốc data_until ở tương lai (đồng hồ máy lệch → Cut sót vĩnh viễn khỏi Đối chiếu ADJ).
--   (g) FK uid_block_scans.device_id thiếu index.
--   (h) C1  Lưu trữ SKU (rời nhóm / ngừng lâu) chưa giữ SKU còn UID Blocked và SKU là thành phần Group UID.
--   (i) C2  Email nhân viên lộ cho người ngoài (anon) ở Lịch sử Group UID, Đối chiếu ADJ, UID tạm (thay quyết định 10/10/2026
--           "hiển thị đầy đủ"); sku_count_overview.lastApprovedBy giữ nguyên (chốt 12/10).
--   (j) C3  Lệnh queued không huỷ được: thêm RPC Admin print_job_cancel.
--
-- Tác động:
--   * Mọi hàm cũ thay bằng create or replace CÙNG chữ ký (không DROP) nên quyền giữ nguyên như bản gốc; thân chép NGUYÊN bản
--     đang chạy (đã đối chiếu md5 với Supabase 23/10/2026) rồi sửa tối thiểu:
--       print_agent_claim (print_sku_v3_v1.sql), print_jobs_purge (print_jobs_admin_v1.sql),
--       print_enqueue_unchecked (print_name_from_db_v1.sql), _cut_group_uid_mark_queued_body (floor_access_v1.sql),
--       sync_history_purge + sku_archive_missing (sku_missing_archive_v1.sql), sku_inactive_archive (sku_inactive_v1.sql),
--       group_uid_moves_lookup (group_uid_moves_v2_lookup.sql), cut_group_uid_reconcile (cut_group_uid_po_v1.sql),
--       uid_temp_overview (uid_temp_snapshot_v1.sql; uid_temp_snapshot gọi lại hàm này nên không cần thay),
--       wms_group_uid_cut_import (cut_group_uid_v6_wms_reconcile.sql).
--   * (a) Lệnh sending/spooling hết lease: về 'queued' nhưng GIỮ agent_id, chỉ agent đó nhận lại (đối chiếu sổ tay, không in
--     lại); claimed/rendering như cũ. print_jobs_purge (mỗi lần cron gọi, kể cả khi lượt dọn 3 ngày bị bỏ qua) đóng lệnh
--     'queued' còn agent_id quá 30 phút thành 'failed' SENT_UNCONFIRMED + ghi print_events. Agent in không cần cập nhật.
--   * (b) Hàm / bảng / sequence tạo SAU migration này (bởi postgres) không còn nhận grant RIÊNG của anon, authenticated. Lưu ý:
--     revoke theo schema không gỡ EXECUTE mặc định toàn cục của PUBLIC (tài liệu PostgreSQL, ALTER DEFAULT PRIVILEGES) — hàm mới
--     VẪN phải `revoke … from public, anon, authenticated` rồi grant rõ (không revoke toàn cục: ảnh hưởng mọi schema, đã chốt). Thu hồi quyền sequence còn sót của anon, authenticated (web chỉ đọc SKU_Name / user_roles, không ghi bảng trực
--     tiếp; mọi INSERT dùng sequence chạy trong hàm SECURITY DEFINER của postgres). Không đụng service_role.
--   * (c) Lệnh sku / group_uid sai luật agent bị từ chối INVALID_JOB ngay ở máy chủ (không ghi lệnh, không ghi PO).
--   * (h) Lưu trữ SKU giữ thêm SKU còn UID Blocked và SKU thành phần (group_uid_products) của UID Available/New/Processing/Blocked.
--   * (i) Người không phải Admin (group_uid_admin_allowed()) nhận phần trước '@'; Admin (gọi bằng JWT) nhận đầy đủ.
--   * Index mới uid_block_scans_device_idx; hàm mới print_job_cancel (chỉ authenticated, kiểm Admin bên trong).
-- Không DROP, không xoá dữ liệu ở cấp cao nhất (delete chỉ nằm trong thân hàm dọn / lưu trữ có sẵn) → không cần cờ xoá.
-- Chạy lại nhiều lần được (create or replace / if not exists / alter default privileges idempotent).
-- Thứ tự lên: migration này → deploy Edge sku-sync → Reload Extension 0.10.8 → push web (nút Huỷ gọi print_job_cancel).
-- Kiểm cục bộ: node tests/backend_hygiene_sql.cjs; python scripts/apply_supabase_sql.py supabase/backend_hygiene_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/backend_hygiene_v1.sql
begin;

-- ---------- (b) Q2/Q6: quyền mặc định schema public + sequence ----------
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------- (g) index FK uid_block_scans.device_id (print_devices xoá → on delete set null quét theo cột này) ----------
create index if not exists uid_block_scans_device_idx on public.uid_block_scans(device_id);

-- ---------- (a) P2: print_agent_claim (bản gốc print_sku_v3_v1.sql) ----------
create or replace function public.print_agent_claim(p_agent_id text,p_agent_token text,p_state jsonb,p_lease_ms integer default 120000)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_cap text[];
begin
  if not public.print_agent_allowed(p_agent_id,p_agent_token) then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','AGENT_DENIED','message','Agent token không hợp lệ')); end if;
  update public.print_agents set state=coalesce(p_state,'{}'::jsonb),capabilities=coalesce(array(select jsonb_array_elements_text(coalesce(p_state->'capabilities','[]'::jsonb))),'{}'),last_seen_at=now(),updated_at=now() where id=p_agent_id returning capabilities into v_cap;
  -- Chưa gửi byte xuống máy in (claimed/rendering): về hàng đợi chung như cũ, agent nào cũng nhận lại được — TRỪ lệnh từng gửi
  -- byte (print_events sending/spooling) rồi được chính agent đó nhận lại để đối chiếu sổ tay: vẫn giữ agent_id (review vòng 1).
  update public.print_jobs set status='queued',agent_id=case when exists (select 1 from public.print_events e where e.job_id=print_jobs.id and e.event_type in ('sending','spooling')) then agent_id else null end,lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent trước không hoàn tất trong thời hạn lease' where status in ('claimed','rendering') and lease_expires_at<now();
  -- Đã gửi byte (sending/spooling): về hàng đợi nhưng GIỮ agent_id, chỉ agent đó nhận lại (đối chiếu sổ tay, không in lại);
  -- agent khác không có sổ tay sẽ in trùng. Quá 30 phút không ai nhận: print_jobs_purge đóng failed SENT_UNCONFIRMED.
  update public.print_jobs set status='queued',lease_expires_at=null,updated_at=now(),error_code='LEASE_EXPIRED',error_message='Agent đã gửi tem nhưng chưa báo hoàn tất trong thời hạn lease, chỉ agent đó được nhận lại' where status in ('sending','spooling') and lease_expires_at<now();
  if coalesce(p_state#>>'{printer,blocked}','false')='true' then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  select * into v_job from public.print_jobs where status='queued' and (agent_id is null or agent_id=p_agent_id) and (
    (type='sku' and template_version=1 and 'sku:v1'=any(v_cap)) or
    (type='sku' and template_version=2 and 'sku:v2'=any(v_cap)) or
    (type='sku' and template_version=3 and 'sku:v3'=any(v_cap)) or
    (type='group_uid' and template_version=1 and 'group_uid:v1'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=1 and 'fabric_relaxation:v1'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=2 and 'fabric_relaxation:v2'=any(v_cap)) or
    (type='fabric_relaxation' and template_version=3 and 'fabric_relaxation:v3'=any(v_cap)) or
    (type='location' and template_version=1 and 'location:v1'=any(v_cap))
  ) order by created_at limit 1 for update skip locked;
  if not found then return jsonb_build_object('ok',true,'data',jsonb_build_object('job',null),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1)); end if;
  update public.print_jobs set status='claimed',agent_id=p_agent_id,attempt_count=attempt_count+1,claimed_at=coalesce(claimed_at,now()),lease_expires_at=now()+(least(greatest(p_lease_ms,30000),900000)||' milliseconds')::interval,updated_at=now() where id=v_job.id returning * into v_job;
  insert into public.print_events(job_id,agent_id,event_type,details) values(v_job.id,p_agent_id,'claimed',jsonb_build_object('attempt',v_job.attempt_count));
  return jsonb_build_object('ok',true,'data',jsonb_build_object('job',jsonb_build_object('id',v_job.id::text,'nonce',v_job.nonce,'type',v_job.type,'templateVersion',v_job.template_version,'copies',v_job.copies,'requestedBy',v_job.requested_by,'payload',v_job.payload)),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

-- ---------- (a) P2: print_jobs_purge (bản gốc print_jobs_admin_v1.sql) ----------
create or replace function public.print_jobs_purge(p_keep interval default interval '3 days', p_every interval default interval '3 days', p_force boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz; v_cutoff timestamptz := now() - p_keep; v_jobs integer; v_events integer; v_result jsonb;
        v_unconfirmed integer;
begin
  -- Lệnh đã gửi xuống máy in mà agent không báo hoàn tất (queued còn agent_id, xem print_agent_claim) quá 30 phút: đóng
  -- failed SENT_UNCONFIRMED, không ai tự in lại (tránh trùng tem). Chạy mỗi lần gọi, kể cả khi lượt dọn bị bỏ qua.
  with closed as (
    update public.print_jobs
       set status = 'failed', lease_expires_at = null, updated_at = now(), error_code = 'SENT_UNCONFIRMED',
           error_message = 'Agent đã gửi tem tới máy in nhưng không xác nhận hoàn tất, không tự in lại để tránh trùng tem'
     where status = 'queued' and agent_id is not null and updated_at < now() - interval '30 minutes'
    returning id, agent_id
  ), logged as (
    insert into public.print_events(job_id, agent_id, event_type, details)
    select c.id, c.agent_id, 'failed', jsonb_build_object('code', 'SENT_UNCONFIRMED', 'by', 'print_jobs_purge') from closed c
    returning 1)
  select count(*) into v_unconfirmed from logged;
  select last_run_at into v_last from public.print_maintenance where task = 'print_jobs_purge' for update;
  -- Trừ hao 1 giờ để lần chạy 03:00 không trôi sang ngày thứ 4 vì lệch vài giây.
  if not p_force and v_last is not null and now() - v_last < p_every - interval '1 hour' then
    return jsonb_build_object('ok', true, 'skipped', true, 'lastRunAt', v_last, 'sentUnconfirmed', v_unconfirmed);
  end if;
  with gone as (
    delete from public.print_jobs
     where status in ('completed', 'failed', 'cancelled') and created_at < v_cutoff
    returning 1)
  select count(*) into v_jobs from gone;
  with gone as (
    delete from public.print_events where job_id is null and created_at < v_cutoff returning 1)
  select count(*) into v_events from gone;
  v_result := jsonb_build_object('ok', true, 'skipped', false, 'cutoff', v_cutoff, 'deletedJobs', v_jobs,
                                 'deletedAgentEvents', v_events, 'sentUnconfirmed', v_unconfirmed, 'remainingJobs', (select count(*) from public.print_jobs));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('print_jobs_purge', now(), v_result, now())
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end$$;

-- ---------- (c) Q4/P3c/P4: print_enqueue_unchecked (bản gốc print_name_from_db_v1.sql) ----------
create or replace function public.print_enqueue_unchecked(p_access_token text, p_nonce text, p_type text, p_template_version integer, p_payload jsonb, p_copies integer, p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean; v_items jsonb; v_bad integer; v_sum integer; v_device uuid; v_inactive text; v_renamed jsonb := '[]'::jsonb; v_tv integer; v_count integer;
begin
  if p_type not in ('sku','group_uid','fabric_relaxation','location') or p_copies not between 1 and 500 or nullif(trim(p_nonce),'') is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Dữ liệu lệnh in không hợp lệ'));
  end if;
  -- Lệnh sku / group_uid theo đúng luật agent (workstation-agent/src/job-validator.mjs), kiểm ngay ở máy chủ: phiên bản tem
  -- agent hỗ trợ (sku 1–3, group_uid 1), 1–100 dòng (dạng đơn không có items = 1 dòng), số tem từng dòng 1–500 (thiếu copies
  -- tính là 1), tổng số tem từng dòng = p_copies. Trước đây chỉ agent từ chối, khi trigger PO đã ghi lúc INSERT.
  if p_type in ('sku','group_uid') then
    v_tv := greatest(coalesce(p_template_version,1),1);
    if (p_type = 'sku' and v_tv not in (1,2,3)) or (p_type = 'group_uid' and v_tv <> 1) then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Phiên bản tem không được hỗ trợ'));
    end if;
    select count(*),
           count(*) filter (where jsonb_typeof(t.v) is distinct from 'object' or x.copies is null or x.copies not between 1 and 500),
           sum(x.copies)
      into v_count,v_bad,v_sum
      from jsonb_array_elements(public.print_job_items(p_type, p_payload, p_copies)) as t(v)
      cross join lateral (select case
          when jsonb_typeof(t.v->'copies') is null or jsonb_typeof(t.v->'copies') = 'null' then 1
          when jsonb_typeof(t.v->'copies') = 'number' and (t.v->>'copies') ~ '^[0-9]{1,3}(\.0+)?$' then (t.v->>'copies')::numeric::integer
          when jsonb_typeof(t.v->'copies') = 'string' and btrim(t.v->>'copies') ~ '^[0-9]{1,3}$' then btrim(t.v->>'copies')::integer
        end as copies) x;
    if jsonb_typeof(p_payload) is distinct from 'object' or v_count not between 1 and 100 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Mỗi lệnh in từ 1 đến 100 dòng'));
    end if;
    if v_bad > 0 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Số tem mỗi dòng phải từ 1 đến 500'));
    end if;
    if v_sum <> p_copies then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Tổng số tem không khớp lệnh in'));
    end if;
  end if;
  if p_type = 'sku' then
    select string_agg(distinct x.sku, ', ' order by x.sku) into v_inactive
      from (select btrim(it.v->>'sku') as sku from jsonb_array_elements(public.print_job_items('sku', p_payload, p_copies)) as it(v)) x
      join public."SKU_Name" s on s.sku = x.sku
     where s.status is distinct from '1';
    if v_inactive is not null then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','SKU_INACTIVE','message','SKU đã ngừng hoạt động, không in tem mới: '||left(v_inactive,200)));
    end if;
  end if;
  -- Tên in theo database: SKU có trong SKU_Name, đang hoạt động, tên khác rỗng → thay productName; còn lại giữ tên web gửi.
  if p_type in ('sku','group_uid') and jsonb_typeof(p_payload) = 'object' then
    with src as (
      select t.ord, t.v,
             case when jsonb_typeof(t.v) = 'object' then btrim(coalesce(t.v->>'sku', '')) else '' end as sku,
             case when jsonb_typeof(t.v) = 'object' then coalesce(t.v->>'productName', case when p_type = 'group_uid' then t.v->>'materialName' end) end as web_name
        from jsonb_array_elements(case when jsonb_typeof(p_payload->'items') = 'array' then p_payload->'items'
                                       else jsonb_build_array(p_payload) end) with ordinality as t(v, ord)
    ), named as (
      select src.ord, src.v, src.sku, src.web_name, btrim(s.product_name) as db_name
        from src
        left join public."SKU_Name" s on s.sku = src.sku and s.status = '1' and btrim(coalesce(s.product_name, '')) <> '' and src.sku <> ''
    )
    select coalesce((select jsonb_agg(case when n.db_name is null then n.v else n.v || jsonb_build_object('productName', n.db_name) end order by n.ord) from named n), '[]'::jsonb),
           coalesce((select jsonb_agg(jsonb_build_object('sku', r.sku, 'productName', r.db_name) order by r.first_ord)
                       from (select n.sku, n.db_name, min(n.ord) as first_ord
                               from named n
                              where n.db_name is not null
                                and btrim(coalesce(n.web_name, '')) <> ''
                                and normalize(btrim(coalesce(n.web_name, '')), NFC) is distinct from normalize(n.db_name, NFC)
                              group by n.sku, n.db_name) r), '[]'::jsonb)
      into v_items, v_renamed;
    if jsonb_typeof(p_payload->'items') = 'array' then
      p_payload := jsonb_set(p_payload, '{items}', v_items);
    else
      p_payload := v_items->0;
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
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate,'renamed',case when v_duplicate then '[]'::jsonb else v_renamed end),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end $$;

-- ---------- (d) Q8: thân cut_group_uid_mark_queued (bản gốc floor_access_v1.sql; hàm công khai bọc khoá máy giữ nguyên) ----------
create or replace function public._cut_group_uid_mark_queued_body(p_access_token text,p_codes text[],p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  if p_job_id is null or coalesce(cardinality(p_codes),0) not between 1 and 100 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_PRINT_JOB','message','Lệnh in không hợp lệ'));
  end if;
  -- p_job_id phải là lệnh in Group UID có thật (web gọi ngay sau print_enqueue), chưa lỗi / chưa huỷ, và tập mã p_codes BẰNG
  -- tập UID trong payload (cả hai chiều, không NULL/rỗng) — không gắn UID khác hoặc thiếu UID vào lệnh. Lệnh completed vẫn nhận:
  -- web gửi lại cùng nonce sau lỗi mạng có thể nhận về lệnh đã in xong, đánh dấu là đúng.
  if exists (select 1 from unnest(p_codes) c where nullif(btrim(c),'') is null) or not exists (
       select 1 from public.print_jobs j
        cross join lateral (select coalesce(array_agg(btrim(i.v->>'groupUid')),'{}') as uids from jsonb_array_elements(public.print_job_items('group_uid', j.payload, j.copies)) i(v)) x
        where j.id=p_job_id and j.type='group_uid' and j.status not in ('failed','cancelled')
          and not exists (select 1 from unnest(x.uids) u where nullif(u,'') is null)
          and not exists (select 1 from unnest(p_codes) c where not (btrim(c) = any (x.uids)))
          and not exists (select 1 from unnest(x.uids) u where not (u = any (p_codes)))) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_PRINT_JOB','message','Lệnh in không hợp lệ'));
  end if;
  select count(*) into v_count from public.cut_group_uids where group_uid_code=any(p_codes) and print_status in ('pending','failed','printed');
  if v_count<>cardinality(p_codes) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','QUEUE_CONFLICT','message','Danh sách chờ in vừa thay đổi. Hãy tải lại.'));
  end if;
  update public.cut_group_uids set print_status='queued',print_job_id=p_job_id,queued_at=now(),updated_at=now()
   where group_uid_code=any(p_codes) and print_status in ('pending','failed','printed');
  get diagnostics v_count=row_count;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('count',v_count,'jobId',p_job_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- ---------- (e) D5: sync_history_purge (bản gốc sku_missing_archive_v1.sql) ----------
create or replace function public.sync_history_purge(
  p_keep_changes interval default interval '30 days',
  p_keep_runs interval default interval '180 days',
  p_keep_payload interval default interval '1 day',
  p_keep_import_rows interval default interval '7 days'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := now();
  n_expired integer; n_failed_changes integer; n_pages integer; n_staging integer; n_old_changes integer;
  n_gu_runs integer; n_sku_payload integer; n_sku_changes integer; n_sku_runs integer;
  n_import_rows integer; n_import_runs integer; n_sku_expired integer; n_import_expired integer; v_result jsonb;
  n_sku_stuck integer;
begin
  -- Lượt Group UID kẹt quá 30 phút: hết hạn (cùng quy tắc với group_uid_sync_prepare, để không chờ tới lượt kế tiếp).
  with gone as (
    update public.group_uid_sync_runs
       set status = 'expired', completed_at = v_now, error_message = coalesce(error_message, 'Hết hạn sau 30 phút (dọn định kỳ)')
     where (status = 'previewed' and previewed_at < v_now - interval '30 minutes')
        or (status = 'running' and created_at < v_now - interval '30 minutes')
    returning 1)
  select count(*) into n_expired from gone;

  -- Lượt thất bại / hết hạn: chi tiết không còn giá trị, xoá ngay.
  with gone as (
    delete from public.group_uid_sync_changes c using public.group_uid_sync_runs r
     where c.run_id = r.id and r.status in ('failed', 'expired') returning 1)
  select count(*) into n_failed_changes from gone;
  update public.group_uid_sync_runs set changes_purged_at = v_now
   where status in ('failed', 'expired') and changes_purged_at is null;

  -- Pages / staging chỉ cần trong lúc lượt đang chạy.
  with gone as (
    delete from public.group_uid_sync_pages p using public.group_uid_sync_runs r
     where p.run_id = r.id and r.status in ('completed', 'failed', 'expired', 'held') returning 1)
  select count(*) into n_pages from gone;
  with gone as (
    delete from public.group_uid_sync_staging s using public.group_uid_sync_runs r
     where s.run_id = r.id and r.status in ('completed', 'failed', 'expired', 'held') returning 1)
  select count(*) into n_staging from gone;

  -- Lượt thành công / giữ lại (held, sync_auto_v1): giữ chi tiết cũ→mới p_keep_changes rồi xoá.
  with gone as (
    delete from public.group_uid_sync_changes c using public.group_uid_sync_runs r
     where c.run_id = r.id and r.status in ('completed', 'held')
       and coalesce(r.completed_at, r.created_at) < v_now - p_keep_changes returning 1)
  select count(*) into n_old_changes from gone;
  update public.group_uid_sync_runs set changes_purged_at = v_now
   where status in ('completed', 'held') and changes_purged_at is null
     and coalesce(completed_at, created_at) < v_now - p_keep_changes;

  -- Dòng lượt Group UID quá p_keep_runs (changes/pages/staging còn sót đi theo on delete cascade).
  with gone as (
    delete from public.group_uid_sync_runs
     where status in ('completed', 'failed', 'expired', 'held') and created_at < v_now - p_keep_runs returning 1)
  select count(*) into n_gu_runs from gone;

  -- sku_sync_runs: bản xem trước bỏ dở quá p_keep_payload thì đóng (dữ liệu Inside đã cũ, lượt sau sẽ tạo bản mới);
  -- Edge Function từ chối apply lượt không còn 'previewed', nên không có đường nào nạp nhầm bản cũ.
  with gone as (
    update public.sku_sync_runs
       set status = 'failed', completed_at = v_now, error_message = coalesce(error_message, 'Bản xem trước bỏ dở, đã đóng khi dọn định kỳ')
     where status = 'previewed' and created_at < v_now - p_keep_payload returning 1)
  select count(*) into n_sku_expired from gone;
  -- Lượt kẹt 'applying' quá 1 giờ (Edge sku-sync dừng giữa chừng; một lượt apply chỉ chạy vài phút): đóng failed và dọn payload
  -- ngay như nhánh failed. Edge chỉ apply lượt 'previewed' nên lượt này không thể chạy tiếp.
  with gone as (
    update public.sku_sync_runs
       set status = 'failed', completed_at = v_now, error_message = coalesce(error_message, 'Lượt cập nhật kẹt quá 1 giờ, đã đóng khi dọn định kỳ'),
           staged_skus = '[]'::jsonb, staged_combo_links = '[]'::jsonb, staged_missing_skus = null, payload_purged_at = v_now
     where status = 'applying' and coalesce(applied_at, created_at) < v_now - interval '1 hour' returning 1)
  select count(*) into n_sku_stuck from gone;
  -- Payload đã nạp chỉ cần tới lúc apply; chi tiết cũ→mới giữ p_keep_changes.
  with gone as (
    update public.sku_sync_runs
       set staged_skus = '[]'::jsonb, staged_combo_links = '[]'::jsonb, staged_missing_skus = null, payload_purged_at = v_now
     where status in ('completed', 'failed', 'held') and payload_purged_at is null
       and coalesce(completed_at, created_at) < v_now - p_keep_payload returning 1)
  select count(*) into n_sku_payload from gone;
  with gone as (
    update public.sku_sync_runs
       set changes = '{}'::jsonb, changes_purged_at = v_now
     where status in ('completed', 'failed', 'held') and changes_purged_at is null
       and coalesce(completed_at, created_at) < v_now - p_keep_changes returning 1)
  select count(*) into n_sku_changes from gone;
  with gone as (
    delete from public.sku_sync_runs
     where status in ('completed', 'failed', 'held') and created_at < v_now - p_keep_runs returning 1)
  select count(*) into n_sku_runs from gone;

  -- Nạp Excel (màn web đã bỏ 07/10/2026; script CLI còn dùng bảng): lượt bỏ dở (uploading/validated/applying)
  -- quá p_keep_import_rows thì đóng — không còn màn nào tiếp tục được lượt đó.
  with gone as (
    update public.group_uid_import_runs
       set status = 'failed', completed_at = v_now, error_message = coalesce(error_message, 'Lượt nạp bỏ dở, đã đóng khi dọn định kỳ')
     where status in ('uploading', 'validated', 'applying') and created_at < v_now - p_keep_import_rows returning 1)
  select count(*) into n_import_expired from gone;
  -- Dòng của lượt đã kết thúc quá p_keep_import_rows.
  with gone as (
    delete from public.group_uid_import_rows r using public.group_uid_import_runs h
     where r.run_id = h.id and h.status in ('completed', 'failed')
       and h.created_at < v_now - p_keep_import_rows returning 1)
  select count(*) into n_import_rows from gone;
  with gone as (
    delete from public.group_uid_import_runs h
     where h.status in ('completed', 'failed') and h.created_at < v_now - p_keep_runs
       and not exists (select 1 from public.group_uid_import_rows r where r.run_id = h.id) returning 1)
  select count(*) into n_import_runs from gone;

  v_result := jsonb_build_object('ok', true, 'at', v_now,
    'groupUid', jsonb_build_object('expiredRuns', n_expired, 'failedChanges', n_failed_changes, 'pages', n_pages,
                                   'staging', n_staging, 'oldChanges', n_old_changes, 'runs', n_gu_runs,
                                   'remainingChanges', (select count(*) from public.group_uid_sync_changes)),
    'sku', jsonb_build_object('expiredPreviews', n_sku_expired, 'stuckApplying', n_sku_stuck, 'payloads', n_sku_payload, 'changes', n_sku_changes,
                              'runs', n_sku_runs, 'remainingRuns', (select count(*) from public.sku_sync_runs)),
    'import', jsonb_build_object('expiredRuns', n_import_expired, 'rows', n_import_rows, 'runs', n_import_runs,
                                 'remainingRows', (select count(*) from public.group_uid_import_rows)));
  insert into public.print_maintenance(task, last_run_at, last_result, updated_at)
  values ('sync_history_purge', v_now, v_result, v_now)
  on conflict (task) do update set last_run_at = excluded.last_run_at, last_result = excluded.last_result, updated_at = now();
  return v_result;
end$$;

-- ---------- (h) C1: sku_archive_missing (bản gốc sku_missing_archive_v1.sql) ----------
-- Giữ thêm SKU còn UID Blocked (hàng thật chờ xử lý) và SKU là thành phần (group_uid_products) của UID còn sống.
create or replace function public.sku_archive_missing(p_skus text[], p_reason text default 'left_sync_scope')
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := left(coalesce(nullif(btrim(p_reason), ''), 'left_sync_scope'), 40);
  v_sku text;
  v_kept_reason text;
  v_archived text[] := '{}';
  v_kept jsonb := '[]'::jsonb;
begin
  if coalesce(cardinality(p_skus), 0) > 30000 then
    raise exception 'TOO_MANY_SKUS';
  end if;
  for v_sku in
    select distinct btrim(x) from unnest(coalesce(p_skus, '{}')) x where nullif(btrim(x), '') is not null order by 1
  loop
    -- Khoá dòng SKU để lượt khác không ghi chen giữa lúc kiểm và lúc chuyển; SKU không còn trong bảng thì bỏ qua.
    perform 1 from public."SKU_Name" s where s.sku = v_sku for update;
    if not found then continue; end if;
    v_kept_reason := case
      when exists (select 1 from public.group_uid_details g where g.sku = v_sku and g.status in ('Available','New','Processing','Blocked')) then 'còn Group UID'
      when exists (select 1 from public.group_uid_products p join public.group_uid_details d on d.group_uid_code = p.group_uid_code where p.sku = v_sku and d.status in ('Available','New','Processing','Blocked')) then 'còn trong Group UID nhiều SKU'
      when exists (select 1 from public.sku_combo_links l where l.combo_status = 'Active' and (l.combo_sku = v_sku or l.normal_sku = v_sku)) then 'còn combo'
      when exists (select 1 from public.xa_vai_log x where x.sku = v_sku and x.ended_at is null) then 'đang xả vải'
      when exists (select 1 from public.cut_group_uids c where c.sku = v_sku and c.cut_at > now() - interval '90 days') then 'mới cắt'
    end;
    if v_kept_reason is not null then
      v_kept := v_kept || jsonb_build_array(jsonb_build_object('sku', v_sku, 'reason', v_kept_reason));
      continue;
    end if;
    insert into public.sku_archive select s.*, now(), v_reason from public."SKU_Name" s where s.sku = v_sku;
    delete from public."SKU_Name" s where s.sku = v_sku;
    v_archived := v_archived || v_sku;
  end loop;
  return jsonb_build_object('archived', cardinality(v_archived), 'archivedSkus', to_jsonb(v_archived),
                            'kept', jsonb_array_length(v_kept), 'keptSkus', v_kept);
end $$;

-- ---------- (h) C1: sku_inactive_archive (bản gốc sku_inactive_v1.sql) ----------
create or replace function public.sku_inactive_archive(p_keep interval default interval '180 days')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_moved integer; v_kept integer; v_result jsonb; v_cutoff timestamptz := now() - p_keep;
begin
  with candidates as (
    select s.* from public."SKU_Name" s
     where s.status is distinct from '1' and s.inactive_since is not null and s.inactive_since < v_cutoff
       and not exists (select 1 from public.group_uid_details g where g.sku = s.sku and g.status in ('Available','New','Processing','Blocked'))
       and not exists (select 1 from public.group_uid_products p join public.group_uid_details d on d.group_uid_code = p.group_uid_code where p.sku = s.sku and d.status in ('Available','New','Processing','Blocked'))
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

-- ---------- (i) C2: group_uid_moves_lookup (bản gốc group_uid_moves_v2_lookup.sql) ----------
-- Người không phải Admin nhận phần trước '@' của người chuyển; Admin (gọi kèm JWT) nhận đầy đủ.
create or replace function public.group_uid_moves_lookup(
  p_warehouse text default '', p_location text default '', p_match text default 'to', p_sku text default '',
  p_from timestamptz default null, p_to timestamptz default null, p_limit integer default 1000
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_wh text := btrim(coalesce(p_warehouse,'')); v_loc text := btrim(coalesce(p_location,'')); v_sku text := btrim(coalesce(p_sku,''));
  v_match text := case when p_match in ('to','from','any') then p_match else 'to' end;
  v_limit integer := least(greatest(coalesce(p_limit,1000),1),5000);
  v_loc_like text; v_sku_like text; v_total integer; v_items jsonb;
  v_admin boolean := public.group_uid_admin_allowed();
begin
  v_loc_like := '%' || replace(replace(replace(v_loc, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  v_sku_like := '%' || replace(replace(replace(v_sku, E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') || '%';
  with ranked as (
    select m.*, lead(m.to_location) over w as next_location, lead(m.moved_at) over w as next_at
      from public.group_uid_moves m
    window w as (partition by m.group_uid_code order by m.moved_at, m.history_id)
  ), hit as (
    select r.history_id, r.group_uid_code, r.warehouse, r.from_location, r.to_location, r.moved_by, r.moved_at,
           r.next_location, r.next_at, count(*) over () as total_rows
      from ranked r
     where (v_wh = '' or r.warehouse = v_wh)
       and (p_from is null or r.moved_at >= p_from)
       and (p_to is null or r.moved_at < p_to)
       and (v_loc = '' or (v_match in ('to','any') and r.to_location ilike v_loc_like)
                       or (v_match in ('from','any') and r.from_location ilike v_loc_like))
       and (v_sku = '' or exists (select 1 from public.group_uid_details d where d.group_uid_code = r.group_uid_code and d.sku ilike v_sku_like)
                       or exists (select 1 from public.group_uid_products p where p.group_uid_code = r.group_uid_code and p.sku ilike v_sku_like))
  ), page as (
    select * from hit order by moved_at desc, history_id desc limit v_limit
  )
  select coalesce(max(q.total_rows),0),
         coalesce(jsonb_agg(jsonb_build_object(
           'id',q.history_id,'uid',q.group_uid_code,'warehouse',q.warehouse,'from',q.from_location,'to',q.to_location,
           'by',case when v_admin then q.moved_by else split_part(q.moved_by,'@',1) end,'at',q.moved_at,'nextLocation',q.next_location,'nextAt',q.next_at,
           'sku',coalesce(d.sku,(select string_agg(s.sku,', ' order by s.sku) from (select p.sku from public.group_uid_products p where p.group_uid_code = q.group_uid_code order by p.sku limit 3) s)),
           'skuCount',case when d.sku is not null then 1 else (select count(*) from public.group_uid_products p where p.group_uid_code = q.group_uid_code) end,
           'product',(select p.product_name from public.group_uid_products p where p.group_uid_code = q.group_uid_code order by p.sku limit 1)
         ) order by q.moved_at desc, q.history_id desc),'[]'::jsonb)
    into v_total, v_items
    from page q left join public.group_uid_details d on d.group_uid_code = q.group_uid_code;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('items',v_items,'total',v_total,'limit',v_limit,'truncated',v_total > v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- ---------- (i) C2: cut_group_uid_reconcile (bản gốc cut_group_uid_po_v1.sql) — wmsCuts.by ----------
create or replace function public.cut_group_uid_reconcile(
  p_access_token text, p_sku text default '', p_lot text default '',
  p_date_from date default null, p_date_to date default null, p_limit integer default 5000,
  p_po text default ''
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_sku text := btrim(coalesce(p_sku,'')); v_lot text := btrim(coalesce(p_lot,''));
        v_limit integer := least(greatest(coalesce(p_limit,5000),1),5000);
        v_po text := btrim(coalesce(p_po,''));
        v_admin boolean := public.group_uid_admin_allowed();
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
        'groupUid',q.group_uid_code,'sku',q.sku,'productName',q.product_name,'lot',q.lot,'roll',q.roll,
        'printStatus',q.print_status,'cutAt',q.cut_at,'adjExportedAt',q.adj_exported_at,
        'adjResolvedAt',q.adj_resolved_at,'adjResolvedState',q.adj_resolved_state,
        'qcStatus',q.qc_status,'po',q.eff_po,
        'wmsCuts',coalesce((select jsonb_agg(jsonb_build_object('cutAt',w.cut_at,'qty',w.qty,'remaining',w.remaining_qty,'by',case when v_admin then w.cut_by else split_part(w.cut_by,'@',1) end) order by w.cut_at)
                              from public.wms_group_uid_cuts w where w.group_uid_code=q.group_uid_code and w.cut_at>=q.cut_at),'[]'::jsonb)
      ) order by q.cut_at desc) from (
        select c.*, g.qc_status, coalesce(c.po,g.purchase_order) as eff_po from public.cut_group_uids c
          left join public.group_uid_details g on g.group_uid_code=c.group_uid_code
         where (v_sku='' or c.sku ilike '%'||v_sku||'%')
           and (v_lot='' or c.lot ilike '%'||v_lot||'%')
           and (p_date_from is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_date_from)
           and (p_date_to is null or (c.cut_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_date_to)
           and (v_po='' or coalesce(c.po,g.purchase_order)=v_po)
         order by c.cut_at desc limit v_limit
      ) q),'[]'::jsonb),
    'coverage',(select case when count(*)=0 then null else jsonb_build_object(
        'from',min(data_from),'until',max(data_until),'files',count(*),'importedAt',max(created_at)) end
        from public.wms_group_uid_history_imports),
    'lastImport',(select jsonb_build_object('fileName',i.file_name,'createdAt',i.created_at,'cutRows',i.cut_rows,
        'newRows',i.new_rows,'changedRows',i.changed_rows,'dataUntil',i.data_until)
        from public.wms_group_uid_history_imports i order by i.created_at desc limit 1),
    'filterSku',v_sku,'filterLot',v_lot,'filterDateFrom',p_date_from,'filterDateTo',p_date_to,'filterPo',v_po,'limit',v_limit),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- ---------- (i) C2: uid_temp_overview (bản gốc uid_temp_snapshot_v1.sql) — createdBy; uid_temp_snapshot dùng lại hàm này ----------
create or replace function public.uid_temp_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run public.uid_temp_runs; v_admin boolean := public.group_uid_admin_allowed();
begin
  select * into v_run from public.uid_temp_runs order by read_at desc, created_at desc, id desc limit 1;
  if not found then
    return jsonb_build_object('ok',true,'data',jsonb_build_object('run',null,'rows','[]'::jsonb,'history','[]'::jsonb),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'run', jsonb_build_object('id',v_run.id,'readAt',v_run.read_at,'warehouses',v_run.warehouses,'warn',to_jsonb(v_run.warn),
                              'scanned',v_run.scanned,'pages',v_run.pages,'rangeDays',v_run.range_days,'rowCount',v_run.row_count),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('wh',r.wh,'warehouseName',r.warehouse_name,'sku',r.sku,'productName',coalesce(r.product_name,''),
                                          'qty',r.qty,'sourceCode',coalesce(r.source_code,''),'mappingId',coalesce(r.mapping_id,''),
                                          'createdBy',coalesce(case when v_admin then r.created_by else split_part(r.created_by,'@',1) end,''),'createdAt',r.created_at) order by r.idx)
        from public.uid_temp_rows r where r.run_id = v_run.id), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('id',h.id,'readAt',h.read_at,'rowCount',h.row_count) order by h.read_at desc, h.created_at desc, h.id desc)
        from public.uid_temp_runs h), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- ---------- (f) D8: wms_group_uid_cut_import (bản gốc cut_group_uid_v6_wms_reconcile.sql) ----------
create or replace function public.wms_group_uid_cut_import(
  p_file_name text, p_file_sha256 text, p_total_rows integer,
  p_data_from timestamptz, p_data_until timestamptz, p_rows jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_import uuid; v_bad integer; v_new integer := 0; v_changed integer := 0; v_previous integer; v_cut integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nạp file lịch sử WMS'));
  end if;
  if nullif(btrim(p_file_name),'') is null or length(p_file_name) > 240
     or p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$'
     or p_total_rows is null or p_total_rows < 0
     or p_data_from is null or p_data_until is null or p_data_until < p_data_from
     or p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_FILE','message','File không hợp lệ hoặc có quá 5.000 dòng Cut'));
  end if;
  -- Mốc dữ liệu ở tương lai (đồng hồ máy lệch): lượt gia tăng sau bắt đầu từ mốc này nên Cut ở giữa bị sót vĩnh viễn → từ chối.
  if p_data_until > now() + interval '5 minutes' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_FILE','message','Mốc dữ liệu đến sau giờ máy chủ quá 5 phút, hãy kiểm tra đồng hồ máy'));
  end if;
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,qty numeric,remaining_qty numeric,sku text,cut_by text,warehouse text)
   where nullif(btrim(group_uid_code),'') is null or length(btrim(group_uid_code)) > 40
      or cut_at is null or qty is null or qty < 0 or qty = 'NaN'::numeric or qty = 'Infinity'::numeric
      or (remaining_qty is not null and (remaining_qty < 0 or remaining_qty = 'NaN'::numeric or remaining_qty = 'Infinity'::numeric));
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng Cut thiếu hoặc sai dữ liệu'));
  end if;

  select count(*) into v_previous from public.wms_group_uid_history_imports where file_sha256 = p_file_sha256;
  v_cut := jsonb_array_length(p_rows);
  insert into public.wms_group_uid_history_imports(file_name,file_sha256,total_rows,cut_rows,data_from,data_until,created_by)
  values (btrim(p_file_name),p_file_sha256,p_total_rows,v_cut,p_data_from,p_data_until,(select auth.uid()))
  returning id into v_import;

  with src as (
    select distinct on (btrim(group_uid_code), cut_at)
           btrim(group_uid_code) as group_uid_code, cut_at, qty, remaining_qty,
           nullif(btrim(sku),'') as sku, nullif(btrim(cut_by),'') as cut_by, nullif(btrim(warehouse),'') as warehouse
      from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,qty numeric,remaining_qty numeric,sku text,cut_by text,warehouse text)
     order by btrim(group_uid_code), cut_at
  ), written as (
    insert into public.wms_group_uid_cuts as w(group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,import_id)
    select group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,v_import from src
    on conflict (group_uid_code,cut_at) do update
      set qty=excluded.qty, remaining_qty=excluded.remaining_qty, sku=excluded.sku,
          cut_by=excluded.cut_by, warehouse=excluded.warehouse, import_id=excluded.import_id
      where (w.qty,w.remaining_qty,w.sku,w.cut_by,w.warehouse)
            is distinct from (excluded.qty,excluded.remaining_qty,excluded.sku,excluded.cut_by,excluded.warehouse)
    returning (xmax = 0) as inserted
  )
  select coalesce(count(*) filter (where inserted),0), coalesce(count(*) filter (where not inserted),0)
    into v_new, v_changed from written;

  update public.wms_group_uid_history_imports set new_rows=v_new, changed_rows=v_changed where id=v_import;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'importId',v_import,'cutRows',v_cut,'newRows',v_new,'changedRows',v_changed,
      'unchangedRows',greatest(v_cut-v_new-v_changed,0),'previousImports',v_previous),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
exception when others then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','IMPORT_ERROR','message',left(sqlerrm,300)));
end $$;

-- ---------- (j) C3: Admin huỷ lệnh in đang chờ (màn Lệnh in) ----------
-- Chỉ lệnh 'queued' (chưa agent nào giữ) → 'cancelled'; lệnh đang in không huỷ được. print_jobs_purge dọn lệnh cancelled sau
-- 3 ngày; cut_group_uid_mark_result nhận cancelled như failed. Không tự huỷ theo giờ (người dùng chốt 23/10/2026).
create or replace function public.print_job_cancel(p_job_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_job public.print_jobs; v_status text;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'FORBIDDEN', 'message', 'Chỉ Admin được huỷ lệnh in'));
  end if;
  update public.print_jobs
     set status = 'cancelled', lease_expires_at = null, completed_at = now(), updated_at = now(),
         error_code = 'CANCELLED', error_message = 'Admin đã huỷ lệnh'
   where id = p_job_id and status = 'queued'
  returning * into v_job;
  if not found then
    select status into v_status from public.print_jobs where id = p_job_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_FOUND', 'message', 'Không tìm thấy lệnh in (có thể đã được dọn)'));
    end if;
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'NOT_QUEUED', 'message', 'Chỉ huỷ được lệnh đang chờ in', 'status', v_status));
  end if;
  -- Lệnh Group UID: trả UID đang chờ in về 'failed' ngay (chọn in lại được), không chờ màn Cắt UID mở để thăm dò.
  if v_job.type = 'group_uid' then
    update public.cut_group_uids set print_status = 'failed', updated_at = now() where print_job_id = v_job.id and print_status = 'queued';
  end if;
  insert into public.print_events(job_id, agent_id, event_type, details)
  values (v_job.id, v_job.agent_id, 'cancelled', jsonb_build_object(
    'userId', (select auth.uid()),
    'username', (select username from public.user_roles where user_id = (select auth.uid()) limit 1)));
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('id', v_job.id, 'status', v_job.status));
end$$;
revoke all on function public.print_job_cancel(uuid) from public, anon, authenticated;
grant execute on function public.print_job_cancel(uuid) to authenticated;

commit;
notify pgrst, 'reload schema';
