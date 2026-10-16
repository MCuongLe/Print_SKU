-- Group UID sync apply v7 (16/10/2026): sửa theo review độc lập (Codex) của v6.
--   * Thành phần sản phẩm của nguồn được chuẩn hoá trong SQL (gu_src_prod: jsonb_to_recordset → jsonb_agg order by sku)
--     rồi mới so với database, không phụ thuộc thứ tự Extension sắp xếp (Codex #4).
--   * Xoá/chèn group_uid_products và xác minh đều kiểm lại "nguồn không cũ hơn dòng hiện tại" trên trạng thái hiện thời
--     (join group_uid_details lúc chạy), và khoá FOR UPDATE các dòng sắp ghi, để một tiến trình khác ghi chen vào giữa
--     không bị thành phần cũ đè lên (Codex #3).
--   * Giữ v6: chỉ ghi/xác minh dòng khác (gu_touch), chỉ khác updated_date thì không ghi; giữ v5: không chèn Canceled quá hạn.
-- Khoảng trống còn lại (ghi RULES.md): preview chưa so thành phần sản phẩm nên bản xem trước có thể báo 0 thay đổi mà apply vẫn
-- ghi thành phần (verification.written cho thấy số dòng thật ghi).
-- Chạy: python scripts/apply_supabase_sql.py supabase/group_uid_sync_v7_apply_guard.sql
begin;

create or replace function public.group_uid_sync_apply(p_run_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.group_uid_sync_runs;
  v_mismatch integer;
  v_verified integer;
  v_written integer;
  v_total integer;
  v_result jsonb;
begin
  select * into v_run from public.group_uid_sync_runs where id=p_run_id for update;
  if not found then raise exception 'RUN_NOT_FOUND'; end if;
  if v_run.status='completed' then
    return jsonb_build_object('runId',p_run_id,'status','completed','verification',v_run.verification,'alreadyCompleted',true);
  end if;
  if v_run.status<>'previewed' then raise exception 'RUN_NOT_PREVIEWED'; end if;
  if v_run.previewed_at is null or v_run.previewed_at < now()-interval '30 minutes' then raise exception 'PREVIEW_EXPIRED'; end if;
  update public.group_uid_sync_runs set status='applying',applied_at=now(),error_message=null where id=p_run_id;

  -- Thành phần nguồn, chuẩn hoá cùng dạng với database (mảng theo sku tăng dần, cùng 3 khoá).
  create temp table gu_src_prod on commit drop as
  select s.group_uid_code,
         jsonb_agg(jsonb_build_object('sku',x.sku,'quantity',x.quantity,'product_name',x.product_name) order by x.sku) as products
    from public.group_uid_sync_staging s
    cross join lateral jsonb_to_recordset(s.products) as x(sku text,quantity numeric,product_name text)
   where s.run_id=p_run_id and jsonb_array_length(s.products)>0
   group by s.group_uid_code;
  create index on gu_src_prod(group_uid_code);

  -- Thành phần hiện có, gộp một lần cho các UID trong lượt.
  create temp table gu_prod on commit drop as
  select p.group_uid_code,
         jsonb_agg(jsonb_build_object('sku',p.sku,'quantity',p.qty,'product_name',p.product_name) order by p.sku) as products
    from public.group_uid_products p
   where exists (select 1 from public.group_uid_sync_staging s where s.run_id=p_run_id and s.group_uid_code=p.group_uid_code)
   group by p.group_uid_code;
  create index on gu_prod(group_uid_code);

  -- Dòng cần ghi: mới, hoặc đã có + nguồn không cũ hơn + khác một trường nghiệp vụ / khác thành phần.
  create temp table gu_touch on commit drop as
  select s.group_uid_code, public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) as eff_sku, (g.group_uid_code is null) as is_new
    from public.group_uid_sync_staging s
    left join public.group_uid_details g on g.group_uid_code=s.group_uid_code
    left join gu_prod pr on pr.group_uid_code=s.group_uid_code
    left join gu_src_prod sp on sp.group_uid_code=s.group_uid_code
   where s.run_id=p_run_id
     and (g.group_uid_code is not null or not public.group_uid_expired_canceled(s.status,s.updated_date))
     and (g.group_uid_code is null or (s.updated_date >= g.updated_date and (
          g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
          g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
          g.sku is distinct from public.group_uid_sync_effective_sku(s.sku,s.products,g.sku) or
          g.qty is distinct from s.qty or g.updated_by is distinct from s.updated_by or
          g.status is distinct from s.status or
          (sp.group_uid_code is not null and coalesce(pr.products,'[]'::jsonb) is distinct from sp.products))));
  create index on gu_touch(group_uid_code);
  select count(*) into v_written from gu_touch;

  -- Khoá các dòng sắp ghi để không bị tiến trình khác chen vào giữa chừng.
  perform 1 from public.group_uid_details g join gu_touch t using(group_uid_code) for update of g;

  insert into public.group_uid_details(group_uid_code,batch_code,roll_code,warehouse,location,sku,qty,updated_by,updated_date,status)
  select s.group_uid_code,s.batch_code,s.roll_code,s.warehouse,s.location,t.eff_sku,s.qty,s.updated_by,s.updated_date,s.status
    from public.group_uid_sync_staging s join gu_touch t using(group_uid_code)
   where s.run_id=p_run_id
  on conflict(group_uid_code) do update set
    batch_code=excluded.batch_code,roll_code=excluded.roll_code,warehouse=excluded.warehouse,
    location=excluded.location,sku=excluded.sku,qty=excluded.qty,updated_by=excluded.updated_by,
    updated_date=excluded.updated_date,status=excluded.status
  where excluded.updated_date >= public.group_uid_details.updated_date;

  -- Thành phần: chỉ khi nguồn có thành phần và nguồn không cũ hơn dòng hiện tại (kiểm lại lúc ghi).
  delete from public.group_uid_products p
   using public.group_uid_sync_staging s
   join gu_touch t using(group_uid_code)
   join public.group_uid_details g using(group_uid_code)
   where s.run_id=p_run_id and p.group_uid_code=s.group_uid_code
     and jsonb_array_length(s.products)>0 and s.updated_date>=g.updated_date;
  insert into public.group_uid_products(group_uid_code,sku,qty,product_name)
  select s.group_uid_code,x.sku,x.quantity,x.product_name
    from public.group_uid_sync_staging s
    join gu_touch t using(group_uid_code)
    join public.group_uid_details g using(group_uid_code)
    cross join lateral jsonb_to_recordset(s.products) as x(sku text,quantity numeric,product_name text)
   where s.run_id=p_run_id and jsonb_array_length(s.products)>0 and s.updated_date>=g.updated_date
  on conflict(group_uid_code,sku) do update set qty=excluded.qty,product_name=excluded.product_name;

  -- Xác minh các dòng vừa ghi.
  create temp table gu_prod_after on commit drop as
  select p.group_uid_code,
         jsonb_agg(jsonb_build_object('sku',p.sku,'quantity',p.qty,'product_name',p.product_name) order by p.sku) as products
    from public.group_uid_products p join gu_touch t using(group_uid_code)
   group by p.group_uid_code;
  select count(*) into v_mismatch
    from public.group_uid_sync_staging s join gu_touch t using(group_uid_code)
    left join public.group_uid_details g using(group_uid_code)
    left join gu_prod_after pa using(group_uid_code)
    left join gu_src_prod sp using(group_uid_code)
   where s.run_id=p_run_id and (g.group_uid_code is null or (s.updated_date>=g.updated_date and (
      g.batch_code is distinct from s.batch_code or g.roll_code is distinct from s.roll_code or
      g.warehouse is distinct from s.warehouse or g.location is distinct from s.location or
      g.sku is distinct from t.eff_sku or g.qty is distinct from s.qty or
      g.updated_by is distinct from s.updated_by or g.updated_date is distinct from s.updated_date or
      g.status is distinct from s.status or
      (sp.group_uid_code is not null and coalesce(pa.products,'[]'::jsonb) is distinct from sp.products))));
  if v_mismatch>0 then raise exception 'VERIFY_FAILED:%',v_mismatch; end if;

  select count(*) into v_total from public.group_uid_details;
  v_verified := v_run.source_count-coalesce((v_run.change_counts->>'issues')::integer,0)
                -coalesce((v_run.change_counts->>'skippedCanceled')::integer,0);
  v_result := jsonb_build_object('verified',v_verified,'written',v_written,'databaseCount',v_total,'errors',jsonb_build_array());

  insert into public.group_uid_sync_state(singleton,last_successful_incremental_at,last_successful_full_at,updated_at)
  values(true,v_run.range_to,case when v_run.mode='full' then now() end,now())
  on conflict(singleton) do update set
    last_successful_incremental_at=greatest(coalesce(public.group_uid_sync_state.last_successful_incremental_at,'-infinity'::timestamptz),excluded.last_successful_incremental_at),
    last_successful_full_at=case when v_run.mode='full' then excluded.last_successful_full_at else public.group_uid_sync_state.last_successful_full_at end,
    updated_at=now();
  update public.group_uid_sync_runs set status='completed',verification=v_result,completed_at=now(),error_message=null where id=p_run_id;
  delete from public.group_uid_sync_pages where run_id=p_run_id;
  delete from public.group_uid_sync_staging where run_id=p_run_id;
  return jsonb_build_object('runId',p_run_id,'status','completed','changeCounts',v_run.change_counts,'verification',v_result);
end $$;

commit;
