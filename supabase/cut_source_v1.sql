-- Nguồn phiếu ADJ / IT cho từng lần Cut của Đối chiếu ADJ (26/10/2026, kế hoạch docs/plans/2026-10-26-nguon-phieu-cat-uid-rui-ro.md việc 1).
-- Vì sao: dòng Cut của WMS không mang số phiếu; app coi mọi Cut là xuất ADJ nên Cut chuyển nội bộ (phiếu IT) bị tính lệch số lượng
--   chuẩn 1 m và vào nhóm Cắt mẫu QC. Người dùng chốt 26/10/2026: chỉ Cut có nguồn phiếu ADJ mới là xuất test; phiếu IT là chuyển nội bộ.
--   Extension / nút Đọc WMS ghép Cut ↔ dòng xuất của báo cáo Import/Export (cut-source-core.js) rồi ghi nguồn qua hai RPC mới dưới đây.
-- Tác động:
--   * wms_group_uid_cuts thêm source_type ('ADJ' | 'IT'; null = Chưa rõ), source_code (số phiếu 1008… / 1007…), source_reason (lý do ADJ),
--     source_at (giờ dòng Import/Export), source_note (ADJ: số PO; IT: kho nhận · mô tả; ≤ 200 ký tự). Dòng cũ để null.
--   * wms_group_uid_cut_import (bản backend_hygiene_v1, giữ chặn p_data_until tương lai) nhận thêm năm cột nguồn mỗi dòng (tuỳ chọn) và
--     KHÔNG ghi đè nguồn đã có: Extension / file cũ gửi dòng không nguồn thì nguồn đã gán giữ nguyên.
--   * cut_group_uid_reconcile (bản backend_hygiene_v1, giữ che email) trả thêm sourceType, sourceCode, sourceReason, sourceNote trong
--     wmsCuts[]; người ngoài Admin thấy email trong sourceNote rút về phần trước @ (N1185).
--   * Hàm mới chỉ Admin (authenticated + group_uid_admin_allowed()): wms_group_uid_cut_set_source(p_rows) ghi nguồn cho Cut CHƯA có
--     nguồn theo khoá (group_uid_code, cut_at), 1–5.000 dòng; wms_group_uid_cut_unresolved(p_days) trả Cut chưa có nguồn trong p_days
--     ngày (1–60, mặc định 30) và các phiếu đã gán (SKU + loại + giờ phiếu) để lượt ghép sau không dùng lại.
--   * Tick giúp (_cut_group_uid_adj_from_wms_body, bản floor_access_v1): chỉ đếm Cut có source_type khác 'IT' (Cut Chưa rõ vẫn tính).
--   * Mọi hàm cũ giữ chữ ký (create or replace giữ quyền); không DROP / DELETE → không cần --allow-destructive; chạy lại được.
-- Thứ tự lên: migration này → Reload Extension (bản có GET_WMS_DOC_INFO) + tải lại tab WMS → push web.
-- Kiểm cục bộ: node tests/cut_source_sql.cjs; python scripts/apply_supabase_sql.py supabase/cut_source_v1.sql --dry-run
-- Chạy: python scripts/apply_supabase_sql.py supabase/cut_source_v1.sql
-- kiem: select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'wms_group_uid_cuts' and column_name in ('source_type','source_code','source_reason','source_at','source_note')) = 5 and to_regprocedure('public.wms_group_uid_cut_set_source(jsonb)') is not null and to_regprocedure('public.wms_group_uid_cut_unresolved(integer)') is not null as ok
-- kiem: select position('source_type' in pg_get_functiondef('public.wms_group_uid_cut_import(text,text,integer,timestamptz,timestamptz,jsonb)'::regprocedure)) > 0 and position('sourceType' in pg_get_functiondef('public.cut_group_uid_reconcile(text,text,text,date,date,integer,text)'::regprocedure)) > 0 and position('source_type' in pg_get_functiondef('public._cut_group_uid_adj_from_wms_body(text,text[])'::regprocedure)) > 0 as ok
-- Rút lui (web / Extension mới gặp lỗi thì báo "chưa gán được nguồn phiếu", nạp Cut vẫn chạy): chép lại ba hàm từ bản cũ
--   (wms_group_uid_cut_import + cut_group_uid_reconcile từ backend_hygiene_v1.sql, _cut_group_uid_adj_from_wms_body từ floor_access_v1.sql),
--   rồi: drop function if exists public.wms_group_uid_cut_set_source(jsonb); drop function if exists public.wms_group_uid_cut_unresolved(integer);
--   Cột nguồn giữ lại được (không hàm cũ nào đọc); muốn bỏ hẳn: alter table public.wms_group_uid_cuts drop column if exists source_type,
--   drop column if exists source_code, drop column if exists source_reason, drop column if exists source_at, drop column if exists source_note;
begin;

alter table public.wms_group_uid_cuts
  add column if not exists source_type text check (source_type is null or source_type in ('ADJ','IT')),
  add column if not exists source_code text check (source_code is null or source_code ~ '^[0-9]{6,40}$'),
  add column if not exists source_reason text check (source_reason is null or length(source_reason) <= 120),
  add column if not exists source_at timestamptz,
  add column if not exists source_note text check (source_note is null or length(source_note) <= 200);
create index if not exists wms_group_uid_cuts_unresolved_idx on public.wms_group_uid_cuts (cut_at) where source_type is null;

-- ---------- Nạp Cut (bản gốc backend_hygiene_v1.sql): thêm cột nguồn, không ghi đè nguồn đã có ----------
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
    from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,qty numeric,remaining_qty numeric,sku text,cut_by text,warehouse text,source_type text,source_code text,source_reason text,source_at timestamptz,source_note text)
   where nullif(btrim(group_uid_code),'') is null or length(btrim(group_uid_code)) > 40
      or cut_at is null or qty is null or qty < 0 or qty = 'NaN'::numeric or qty = 'Infinity'::numeric
      or (remaining_qty is not null and (remaining_qty < 0 or remaining_qty = 'NaN'::numeric or remaining_qty = 'Infinity'::numeric))
      -- Nguồn tuỳ chọn: có loại thì phải là ADJ / IT kèm số phiếu chữ số.
      or (nullif(btrim(source_type),'') is not null and (btrim(source_type) not in ('ADJ','IT') or coalesce(btrim(source_code),'') !~ '^[0-9]{6,40}$'));
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
           nullif(btrim(source_type),'') as source_type,
           case when nullif(btrim(source_type),'') is null then null else btrim(source_code) end as source_code,
           case when nullif(btrim(source_type),'') is null then null else left(nullif(btrim(source_reason),''),120) end as source_reason,
           case when nullif(btrim(source_type),'') is null then null else source_at end as source_at,
           case when nullif(btrim(source_type),'') is null then null else left(nullif(btrim(source_note),''),200) end as source_note,
           nullif(btrim(sku),'') as sku, nullif(btrim(cut_by),'') as cut_by, nullif(btrim(warehouse),'') as warehouse
      from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,qty numeric,remaining_qty numeric,sku text,cut_by text,warehouse text,source_type text,source_code text,source_reason text,source_at timestamptz,source_note text)
     order by btrim(group_uid_code), cut_at
  ), written as (
    insert into public.wms_group_uid_cuts as w(group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,import_id,source_type,source_code,source_reason,source_at,source_note)
    select group_uid_code,cut_at,qty,remaining_qty,sku,cut_by,warehouse,v_import,source_type,source_code,source_reason,source_at,source_note from src
    on conflict (group_uid_code,cut_at) do update
      set qty=excluded.qty, remaining_qty=excluded.remaining_qty, sku=excluded.sku,
          -- Nguồn đã có thì giữ: dòng không nguồn (Extension / file cũ) không xoá, nguồn khác cũng không đè.
          source_type=case when w.source_type is null then excluded.source_type else w.source_type end,
          source_code=case when w.source_type is null then excluded.source_code else w.source_code end,
          source_reason=case when w.source_type is null then excluded.source_reason else w.source_reason end,
          source_at=case when w.source_type is null then excluded.source_at else w.source_at end,
          source_note=case when w.source_type is null then excluded.source_note else w.source_note end,
          cut_by=excluded.cut_by, warehouse=excluded.warehouse, import_id=excluded.import_id
      where (w.qty,w.remaining_qty,w.sku,w.cut_by,w.warehouse)
            is distinct from (excluded.qty,excluded.remaining_qty,excluded.sku,excluded.cut_by,excluded.warehouse)
         or (w.source_type is null and excluded.source_type is not null)
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

-- ---------- Đối chiếu (bản gốc backend_hygiene_v1.sql): wmsCuts[] trả thêm nguồn phiếu ----------
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
        'wmsCuts',coalesce((select jsonb_agg(jsonb_build_object('cutAt',w.cut_at,'qty',w.qty,'remaining',w.remaining_qty,'by',case when v_admin then w.cut_by else split_part(w.cut_by,'@',1) end,
                                'sourceType',w.source_type,'sourceCode',w.source_code,'sourceReason',w.source_reason,
                                'sourceNote',case when v_admin then w.source_note else regexp_replace(w.source_note,'([^[:space:]@]+)@[^[:space:]@]+','\1','g') end) order by w.cut_at)
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

-- ---------- Ghi nguồn phiếu cho Cut chưa có nguồn (Extension / nút Đọc WMS, chỉ Admin) ----------
create or replace function public.wms_group_uid_cut_set_source(p_rows jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_total integer; v_bad integer; v_updated integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được ghi nguồn phiếu của Cut'));
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lần ghi từ 1 đến 5.000 dòng nguồn phiếu'));
  end if;
  v_total := jsonb_array_length(p_rows);
  select count(*) into v_bad
    from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,source_type text,source_code text,source_reason text,source_at timestamptz,source_note text)
   where nullif(btrim(group_uid_code),'') is null or length(btrim(group_uid_code)) > 40 or cut_at is null
      or coalesce(btrim(source_type),'') not in ('ADJ','IT')
      or coalesce(btrim(source_code),'') !~ '^[0-9]{6,40}$';
  if v_bad > 0 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_ROWS','message','Có dòng nguồn phiếu thiếu hoặc sai dữ liệu'));
  end if;
  with src as (
    select distinct on (btrim(group_uid_code), cut_at)
           btrim(group_uid_code) as group_uid_code, cut_at, btrim(source_type) as source_type, btrim(source_code) as source_code,
           left(nullif(btrim(source_reason),''),120) as source_reason, source_at, left(nullif(btrim(source_note),''),200) as source_note
      from jsonb_to_recordset(p_rows) as x(group_uid_code text,cut_at timestamptz,source_type text,source_code text,source_reason text,source_at timestamptz,source_note text)
     order by btrim(group_uid_code), cut_at
  ), changed as (
    -- Chỉ dòng chưa có nguồn: hai máy ghép cùng lúc thì bản ghi trước giữ nguyên (khoá dòng của update xét lại điều kiện).
    update public.wms_group_uid_cuts w
       set source_type=s.source_type, source_code=s.source_code, source_reason=s.source_reason, source_at=s.source_at, source_note=s.source_note
      from src s
     where w.group_uid_code=s.group_uid_code and w.cut_at=s.cut_at and w.source_type is null
    returning 1
  )
  select count(*) into v_updated from changed;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('updated',v_updated,'skipped',v_total-v_updated),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
exception when others then
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','SET_SOURCE_ERROR','message',left(sqlerrm,300)));
end $$;

-- ---------- Cut chưa có nguồn + phiếu đã gán (để ghép lại khi phiếu IT đến trễ, chỉ Admin) ----------
create or replace function public.wms_group_uid_cut_unresolved(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_days integer := least(greatest(coalesce(p_days,30),1),60);
        v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days,30),1),60));
        v_count integer; v_cuts jsonb;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đọc Cut chưa có nguồn phiếu'));
  end if;
  select count(*) into v_count from public.wms_group_uid_cuts w where w.source_type is null and w.cut_at >= v_since and w.sku is not null;
  select coalesce(jsonb_agg(jsonb_build_object('groupUid',q.group_uid_code,'cutAt',q.cut_at,'qty',q.qty,'sku',q.sku) order by q.cut_at, q.group_uid_code),'[]'::jsonb)
    into v_cuts
    from (select w.group_uid_code, w.cut_at, w.qty, w.sku from public.wms_group_uid_cuts w
           where w.source_type is null and w.cut_at >= v_since and w.sku is not null
           order by w.cut_at desc limit 5000) q;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'days',v_days,'since',v_since,'cuts',v_cuts,'truncated',v_count > 5000,
      'used',coalesce((select jsonb_agg(jsonb_build_object('sku',u.sku,'type',u.source_type,'at',u.source_at) order by u.source_at)
                         from (select distinct w.sku, w.source_type, w.source_at from public.wms_group_uid_cuts w
                                where w.source_type is not null and w.source_at >= v_since - interval '1 day' and w.sku is not null) u),'[]'::jsonb)),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;

-- ---------- Tick giúp (thân chép từ floor_access_v1.sql): bỏ Cut nguồn IT ----------
create or replace function public._cut_group_uid_adj_from_wms_body(p_access_token text, p_codes text[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_codes text[]; v_updated integer;
begin
  select coalesce(array_agg(distinct btrim(x)),'{}') into v_codes from unnest(coalesce(p_codes,'{}')) x where nullif(btrim(x),'') is not null;
  if cardinality(v_codes) not between 1 and 200 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Mỗi lượt chọn từ 1 đến 200 UID'));
  end if;
  with eligible as (
    select c.group_uid_code, min(w.cut_at) as wms_at
      from public.cut_group_uids c
      join public.wms_group_uid_cuts w on w.group_uid_code = c.group_uid_code and w.cut_at >= c.cut_at and w.source_type is distinct from 'IT'
     where c.group_uid_code = any(v_codes) and c.adj_exported_at is null
     group by c.group_uid_code
    having count(*) = 1
  ), changed as (
    update public.cut_group_uids c set adj_exported_at = e.wms_at, updated_at = now()
      from eligible e where c.group_uid_code = e.group_uid_code and c.adj_exported_at is null
    returning c.group_uid_code, c.adj_exported_at
  )
  select count(*) into v_updated from changed;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('updated',v_updated,'skipped',cardinality(v_codes)-v_updated),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end $$;
revoke all on function public._cut_group_uid_adj_from_wms_body(text, text[]) from public, anon, authenticated;

revoke all on function public.wms_group_uid_cut_set_source(jsonb) from public, anon, authenticated;
revoke all on function public.wms_group_uid_cut_unresolved(integer) from public, anon, authenticated;
grant execute on function public.wms_group_uid_cut_set_source(jsonb) to authenticated;
grant execute on function public.wms_group_uid_cut_unresolved(integer) to authenticated;

commit;
notify pgrst, 'reload schema';
