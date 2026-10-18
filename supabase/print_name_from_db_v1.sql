-- Tên in theo database (18/10/2026, docs/plans/2026-10-18-danh-muc-sku-tren-may.md, Việc 1).
--
-- Vì sao: web (IN TEM SKU, TÌM SKU, Trợ lý in, Phiếu IT, Gán WMS, In lại Admin…) sắp tra tên SKU từ danh mục giữ trên máy;
-- bản sao đó có thể cũ. Người dùng chốt 18/10/2026: SKU có trong database và đang hoạt động → tem LUÔN in theo tên database;
-- SKU không có trong database (hoặc tên database rỗng) → in theo tên web gửi; SKU ngừng → chặn như cũ (SKU_INACTIVE).
-- Áp cả tem Group UID.
--
-- Tác động: chỉ thay thân public.print_enqueue_unchecked (chung cho print_enqueue và print_admin_reprint) — chép NGUYÊN bản
-- đang chạy (supabase/sku_inactive_v1.sql, đã đối chiếu pg_get_functiondef) và thêm một bước ngay sau bước chặn SKU ngừng:
--   * p_type 'sku' hoặc 'group_uid', payload {items:[…]} (giữ thứ tự, giữ mọi trường khác) hoặc dạng đơn {sku, productName, …}
--     (Group UID dạng đơn có groupUid): productName := btrim(SKU_Name.product_name) khi SKU (so sau btrim) có trong bảng với
--     status '1' và tên khác rỗng sau btrim. Group UID chỉ có materialName → thêm productName (agent đọc productName ?? materialName).
--   * data.renamed = [{sku, productName}] cho SKU có tên web (sau btrim, chuẩn hoá NFC) khác tên database, mỗi SKU một lần
--     theo thứ tự xuất hiện; lệnh trùng nonce (payload đã lưu không đổi) → renamed: []. Web cũ bỏ qua khoá mới.
-- Không đổi chữ ký, quyền (vẫn chỉ gọi được qua print_enqueue / print_admin_reprint), bảng, print_enqueue. Không xoá gì.
-- print_admin_reprint không chuyển tiếp renamed (tem in lại vẫn mang tên database).
-- Chạy migration TRƯỚC khi push index.html dùng data.renamed.
-- Chạy: python scripts/apply_supabase_sql.py supabase/print_name_from_db_v1.sql
begin;

create or replace function public.print_enqueue_unchecked(p_access_token text, p_nonce text, p_type text, p_template_version integer, p_payload jsonb, p_copies integer, p_requested_by text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_job public.print_jobs; v_duplicate boolean; v_items jsonb; v_bad integer; v_sum integer; v_device uuid; v_inactive text; v_renamed jsonb := '[]'::jsonb;
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
revoke all on function public.print_enqueue_unchecked(text,text,text,integer,jsonb,integer,text) from public, anon, authenticated;

commit;
notify pgrst,'reload schema';
