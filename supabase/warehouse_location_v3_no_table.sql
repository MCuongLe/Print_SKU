-- Mã vị trí KHÔNG lưu danh mục nữa (03/10/2026): người dùng hiếm khi in lại một vị trí, nên bỏ bảng
-- warehouse_locations cùng các hàm lưu/tìm/xoá và trigger đếm số tem đã in (v1, v2). Web nhập mã + tên
-- rồi gửi thẳng lệnh in. Không giữ lịch sử vị trí: print_jobs cũng có lúc được dọn (03/10/2026 chỉ còn
-- lệnh trong ngày), nên đừng coi print_jobs.payload là nơi lưu.
--
-- print_enqueue (loại `location`): kiểm tra và chuẩn hoá đúng mã/tên trong lệnh — mã chữ hoa
-- [0-9A-Z._/-] 1–40 ký tự, tên không bắt buộc tối đa 60 ký tự, số tem 1–500 khớp tổng lệnh. Các loại
-- tem khác giữ nguyên từng dòng. print_agent_claim không đổi (vẫn cần capability `location:v1`).
--
-- Xoá bảng cùng dữ liệu trong đó (người dùng đồng ý 03/10/2026; lúc đó bảng còn 2 mã:
-- F01-WH2-501-01-01-01 "Sân chứa VLXD" và F0-TF-00-00-00-02 "TF-02" đã ẩn).
--
-- Chạy TRƯỚC khi cập nhật index.html (web mới gửi mã chưa có trong bảng, print_enqueue cũ sẽ từ chối):
--   python scripts/apply_supabase_sql.py supabase/warehouse_location_v3_no_table.sql --allow-destructive
-- Từ lúc chạy tới lúc cập nhật index.html, màn MÃ VỊ TRÍ bản cũ báo lỗi đọc danh sách (các màn khác không ảnh hưởng).
-- Dự án mới chỉ cần chạy file này (bỏ qua warehouse_location_v1/v2).
begin;

create or replace function public.print_enqueue(p_access_token text,p_nonce text,p_type text,p_template_version integer,p_payload jsonb,p_copies integer,p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean; v_items jsonb; v_bad integer; v_sum integer;
begin
  if p_type not in ('sku','group_uid','fabric_relaxation','location') or p_copies not between 1 and 500 or nullif(trim(p_nonce),'') is null then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_JOB','message','Dữ liệu lệnh in không hợp lệ'));
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
  select exists(select 1 from public.print_jobs where nonce=p_nonce) into v_duplicate;
  insert into public.print_jobs(nonce,type,template_version,payload,copies,requested_by)
  values(p_nonce,p_type,greatest(coalesce(p_template_version,1),1),coalesce(p_payload,'{}'::jsonb),p_copies,left(coalesce(p_requested_by,''),100))
  on conflict(nonce) do update set updated_at=public.print_jobs.updated_at returning * into v_job;
  if not v_duplicate then insert into public.print_events(job_id,event_type,details) values(v_job.id,'queued',jsonb_build_object('copies',v_job.copies,'type',v_job.type)); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',v_job.id,'status',v_job.status,'duplicate',v_duplicate),'meta',jsonb_build_object('updatedAt',v_job.updated_at,'schemaVersion',1));
end$$;

-- Bỏ trigger đếm tem đã in và toàn bộ hàm của danh mục vị trí.
drop trigger if exists print_jobs_location_printed on public.print_jobs;
drop function if exists public.warehouse_location_mark_printed();
drop function if exists public.warehouse_location_upsert(text,jsonb);
drop function if exists public.warehouse_location_search(text,text,integer);
drop function if exists public.warehouse_location_archive(text,text);
drop function if exists public.warehouse_location_parse(jsonb);
drop function if exists public.warehouse_location_fold(text);

drop table if exists public.warehouse_locations;

commit;
notify pgrst,'reload schema';
