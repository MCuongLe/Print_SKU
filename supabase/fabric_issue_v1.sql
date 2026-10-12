-- Module CAP VAI (12/10/2026): nhap Packing List (Excel), ghep Group UID theo SKU + Batch(Lot) + Roll, quet UID de danh dau da cap.
--
-- Admin nhap file Packing List tren web; web doc Excel ngay tren trinh duyet roi gui danh sach dong
-- (sku, color, lot, roll, qty) len ham fabric_issue_import. Ham nay tao mot "dot cap vai" va ghep tung dong
-- voi group_uid_details (chi UID dang Available, khop sku + batch_code + roll_code sau khi chuan hoa).
-- Moi nhan vien kho quet Group UID: ham fabric_issue_scan danh dau "da quet" va bao UID nao duoc cap;
-- UID khong thuoc dot (hoac da quet roi) duoc bao ro ly do.
--
-- Mo hinh giong Theo doi xa vai (doc/quet = anon qua RPC) + Kiem ke SKU (ghi/nhap = Admin kiem group_uid_admin_allowed()):
-- bang chi cap cho service_role, web chi di qua ham security definer.
--
-- Chi them bang va ham moi, khong drop gi: khong can --allow-destructive.
-- Chay migration TRUOC khi cap nhat index.html.
begin;

create table if not exists public.fabric_issue_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  style_no text not null default '' check (length(style_no) <= 60),
  po_no text not null default '' check (length(po_no) <= 60),
  item_no text not null default '' check (length(item_no) <= 60),
  source_name text not null default '' check (length(source_name) <= 200),
  needs jsonb not null default '[]'::jsonb check (jsonb_typeof(needs) = 'array'),
  status text not null default 'open' check (status in ('open','closed')),
  created_by uuid,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists fabric_issue_plans_list_idx on public.fabric_issue_plans (status, created_at desc);

create table if not exists public.fabric_issue_lines (
  id bigint generated always as identity primary key,
  plan_id uuid not null references public.fabric_issue_plans(id) on delete cascade,
  line_no integer not null check (line_no > 0),
  sku text not null check (length(btrim(sku)) between 1 and 40),
  color text not null default '' check (length(color) <= 120),
  lot_no text not null default '' check (length(lot_no) <= 60),
  roll_no text not null default '' check (length(roll_no) <= 60),
  qty_m numeric not null default 0 check (qty_m >= 0 and qty_m <> 'NaN'::numeric and qty_m <> 'Infinity'::numeric),
  gross_kg numeric check (gross_kg is null or (gross_kg >= 0 and gross_kg <> 'NaN'::numeric)),
  net_kg numeric check (net_kg is null or (net_kg >= 0 and net_kg <> 'NaN'::numeric)),
  group_uid_code text,
  match_state text not null default 'not_found'
    check (match_state in ('matched','not_found','not_available','duplicate','ambiguous')),
  match_note text not null default '' check (length(match_note) <= 120),
  scanned_at timestamptz,
  scanned_by text check (scanned_by is null or length(scanned_by) <= 60),
  unique (plan_id, line_no),
  check ((match_state = 'matched') = (group_uid_code is not null)),
  check (scanned_at is null or group_uid_code is not null)
);
create unique index if not exists fabric_issue_lines_uid_idx on public.fabric_issue_lines (plan_id, group_uid_code) where group_uid_code is not null;
create index if not exists fabric_issue_lines_code_idx on public.fabric_issue_lines (group_uid_code) where group_uid_code is not null;

alter table public.fabric_issue_plans enable row level security;
alter table public.fabric_issue_lines enable row level security;
revoke all on public.fabric_issue_plans from public, anon, authenticated;
revoke all on public.fabric_issue_lines from public, anon, authenticated;
grant select, insert, update, delete on public.fabric_issue_plans to service_role;
grant select, insert, update, delete on public.fabric_issue_lines to service_role;

-- Chuan hoa Lot/Roll de so khop: bo khoang trang, "12.0" -> "12", "007" -> "7", khong phan biet hoa thuong.
create or replace function public.fabric_issue_norm(p text)
returns text language sql immutable set search_path = '' as $$
  select case
    when btrim(coalesce(p,'')) = '' then ''
    else regexp_replace(
           lower(regexp_replace(
             case when btrim(p) ~ '^[0-9]+\.0+$' then split_part(btrim(p),'.',1) else btrim(p) end,
             '\s+', '', 'g')),
           '^0+(?=[0-9])', '')
  end
$$;

-- Tim UID cho mot dong Packing List. p_taken = UID da gan cho dong khac trong cung dot.
-- Tra {state, code?, status?, count?}:
--   matched       : dung 1 UID Available khop (sku + batch + roll)
--   not_found     : khong co UID nao khop
--   not_available : co UID khop nhung khong con Available (status = trang thai WMS)
--   duplicate     : UID khop da gan cho dong truoc trong dot (Packing List lap dong)
--   ambiguous     : nhieu UID Available cung khop, khong doan bua
-- Buoc 1 khop nguyen van sau chuan hoa; buoc 2 (neu khong co) Roll Code dang "<batch>-<roll>" thi so phan sau dau '-' '/' ' ' cuoi.
create or replace function public.fabric_issue_find_uid(p_sku text, p_lot text, p_roll text, p_taken text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_lot text := public.fabric_issue_norm(p_lot);
  v_roll text := public.fabric_issue_norm(p_roll);
  v_all text[]; v_free text[]; v_status text;
begin
  if v_roll = '' then return jsonb_build_object('state','not_found'); end if;
  select coalesce(array_agg(g.group_uid_code order by g.group_uid_code), '{}') into v_all
    from public.group_uid_details g
   where g.sku = p_sku and lower(btrim(g.status)) = 'available'
     and (v_lot = '' or public.fabric_issue_norm(g.batch_code) = v_lot)
     and public.fabric_issue_norm(g.roll_code) = v_roll;
  if cardinality(v_all) = 0 then
    select coalesce(array_agg(g.group_uid_code order by g.group_uid_code), '{}') into v_all
      from public.group_uid_details g
     where g.sku = p_sku and lower(btrim(g.status)) = 'available'
       and (v_lot = '' or public.fabric_issue_norm(g.batch_code) = v_lot)
       and public.fabric_issue_norm(regexp_replace(coalesce(g.roll_code,''), '^.*[-/ ]', '')) = v_roll;
  end if;
  if cardinality(v_all) = 0 then
    select g.status into v_status
      from public.group_uid_details g
     where g.sku = p_sku
       and (v_lot = '' or public.fabric_issue_norm(g.batch_code) = v_lot)
       and public.fabric_issue_norm(g.roll_code) = v_roll
     order by g.updated_date desc limit 1;
    if v_status is not null then
      return jsonb_build_object('state','not_available','status',v_status);
    end if;
    return jsonb_build_object('state','not_found');
  end if;
  v_free := array(select c from unnest(v_all) c where not (c = any(coalesce(p_taken, '{}'))));
  if cardinality(v_free) = 0 then return jsonb_build_object('state','duplicate'); end if;
  if cardinality(v_free) > 1 then return jsonb_build_object('state','ambiguous','count',cardinality(v_free)); end if;
  return jsonb_build_object('state','matched','code',v_free[1]);
end$$;

-- Cac dong cua mot dot (hoac 1 dong) kem vi tri/trang thai/so luong WMS hien tai cua UID.
create or replace function public.fabric_issue_lines_json(p_plan_id uuid, p_line_id bigint default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'no', l.line_no, 'sku', l.sku, 'color', l.color, 'lot', l.lot_no, 'roll', l.roll_no, 'qtyM', l.qty_m,
    'state', l.match_state, 'note', l.match_note, 'groupUid', l.group_uid_code,
    'scannedAt', l.scanned_at, 'scannedBy', l.scanned_by,
    'location', g.location, 'warehouse', g.warehouse, 'wmsStatus', g.status, 'wmsQty', g.qty
  ) order by l.line_no), '[]'::jsonb)
  from public.fabric_issue_lines l
  left join public.group_uid_details g on g.group_uid_code = l.group_uid_code
  where l.plan_id = p_plan_id and (p_line_id is null or l.id = p_line_id)
$$;

-- Thong tin dot + so dem tien do.
create or replace function public.fabric_issue_plan_json(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'name', p.name, 'styleNo', p.style_no, 'poNo', p.po_no, 'itemNo', p.item_no, 'sourceName', p.source_name,
    'status', p.status, 'createdAt', p.created_at, 'closedAt', p.closed_at, 'needs', p.needs,
    'total', count(l.id),
    'matched', count(l.id) filter (where l.group_uid_code is not null),
    'scanned', count(l.id) filter (where l.scanned_at is not null),
    'qtyTotal', coalesce(sum(l.qty_m), 0),
    'qtyScanned', coalesce(sum(l.qty_m) filter (where l.scanned_at is not null), 0))
  from public.fabric_issue_plans p
  left join public.fabric_issue_lines l on l.plan_id = p.id
  where p.id = p_id
  group by p.id
$$;

-- Ghep lai cac dong chua co UID (sau khi dong bo them Group UID). Dung chung cho import va rematch.
create or replace function public.fabric_issue_match_plan(p_plan_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_taken text[]; v_line public.fabric_issue_lines; v_r jsonb; v_hit integer := 0;
begin
  v_taken := array(select group_uid_code from public.fabric_issue_lines where plan_id = p_plan_id and group_uid_code is not null);
  for v_line in
    select * from public.fabric_issue_lines
     where plan_id = p_plan_id and group_uid_code is null and scanned_at is null
     order by line_no
  loop
    v_r := public.fabric_issue_find_uid(v_line.sku, v_line.lot_no, v_line.roll_no, v_taken);
    update public.fabric_issue_lines set
        match_state = v_r->>'state',
        group_uid_code = v_r->>'code',
        match_note = case v_r->>'state'
          when 'not_available' then 'Trạng thái WMS: ' || left(coalesce(v_r->>'status',''), 40)
          when 'ambiguous' then (v_r->>'count') || ' UID cùng khớp'
          else '' end
      where id = v_line.id;
    if v_r->>'state' = 'matched' then
      v_taken := v_taken || (v_r->>'code');
      v_hit := v_hit + 1;
    end if;
  end loop;
  return v_hit;
end$$;

-- ADMIN: tao dot cap vai tu Packing List va ghep UID.
-- p_plan = {name, styleNo, poNo, itemNo, sourceName, needs:[{sku,color,requiredM,unit}], lines:[{sku,color,lotNo,rollNo,qtyM,gw,nw}]}
create or replace function public.fabric_issue_import(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_line jsonb; v_i integer := 0; v_name text; v_lines jsonb; v_qty numeric;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được nhập Packing List'));
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_plan->'lines') <> 'array' then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Dữ liệu Packing List không hợp lệ'));
  end if;
  v_lines := p_plan->'lines';
  v_name := left(btrim(coalesce(p_plan->>'name','')), 120);
  if v_name = '' or jsonb_array_length(v_lines) not between 1 and 3000 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Packing List cần có tên và từ 1 đến 3000 dòng'));
  end if;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    -- Ep kieu qtyM chi khi no that su la so (Postgres khong dam bao thu tu danh gia cua OR).
    v_qty := case when jsonb_typeof(v_line) = 'object' and jsonb_typeof(v_line->'qtyM') = 'number' then (v_line->>'qtyM')::numeric end;
    if jsonb_typeof(v_line) <> 'object'
       or length(btrim(coalesce(v_line->>'sku',''))) not between 1 and 40
       or length(btrim(coalesce(v_line->>'rollNo',''))) not between 1 and 60
       or length(coalesce(v_line->>'lotNo','')) > 60
       or length(coalesce(v_line->>'color','')) > 120
       or v_qty is null or v_qty < 0 or v_qty > 1000000 then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Có dòng Packing List thiếu SKU/Roll hoặc số lượng không hợp lệ'));
    end if;
  end loop;
  insert into public.fabric_issue_plans(name, style_no, po_no, item_no, source_name, needs, created_by)
  values (v_name, left(btrim(coalesce(p_plan->>'styleNo','')),60), left(btrim(coalesce(p_plan->>'poNo','')),60),
          left(btrim(coalesce(p_plan->>'itemNo','')),60), left(btrim(coalesce(p_plan->>'sourceName','')),200),
          case when jsonb_typeof(p_plan->'needs') = 'array' then p_plan->'needs' else '[]'::jsonb end,
          (select auth.uid()))
  returning id into v_id;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_i := v_i + 1;
    insert into public.fabric_issue_lines(plan_id, line_no, sku, color, lot_no, roll_no, qty_m, gross_kg, net_kg, match_state)
    values (v_id, v_i, btrim(v_line->>'sku'), btrim(coalesce(v_line->>'color','')), btrim(coalesce(v_line->>'lotNo','')),
            btrim(v_line->>'rollNo'), (v_line->>'qtyM')::numeric,
            case when jsonb_typeof(v_line->'gw') = 'number' then greatest((v_line->>'gw')::numeric, 0) end,
            case when jsonb_typeof(v_line->'nw') = 'number' then greatest((v_line->>'nw')::numeric, 0) end,
            'not_found');
  end loop;
  perform public.fabric_issue_match_plan(v_id);
  return jsonb_build_object('ok',true,'data',jsonb_build_object('plan',public.fabric_issue_plan_json(v_id)));
end$$;

-- ADMIN: ghep lai cac dong chua co UID.
create or replace function public.fabric_issue_rematch(p_plan_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_hit integer;
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được ghép lại'));
  end if;
  perform 1 from public.fabric_issue_plans where id = p_plan_id for update;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại'));
  end if;
  v_hit := public.fabric_issue_match_plan(p_plan_id);
  return jsonb_build_object('ok',true,'data',jsonb_build_object('newlyMatched',v_hit,'plan',public.fabric_issue_plan_json(p_plan_id)));
end$$;

-- ADMIN: dong / mo lai dot (dot dong chi con xem, khong quet them).
create or replace function public.fabric_issue_set_status(p_plan_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được đóng/mở đợt'));
  end if;
  if p_status not in ('open','closed') then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_INPUT','message','Trạng thái không hợp lệ'));
  end if;
  update public.fabric_issue_plans set status = p_status, closed_at = case when p_status = 'closed' then now() else null end
   where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('plan',public.fabric_issue_plan_json(p_plan_id)));
end$$;

-- ADMIN: xoa han mot dot (cac dong xoa theo).
create or replace function public.fabric_issue_delete(p_plan_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xóa đợt'));
  end if;
  delete from public.fabric_issue_plans where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('deleted',true));
end$$;

-- ADMIN: bo dau "da quet" cua mot UID (quet nham).
create or replace function public.fabric_issue_unscan(p_plan_id uuid, p_group_uid text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_line public.fabric_issue_lines; v_code text := nullif(btrim(p_group_uid), '');
begin
  if not public.group_uid_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được bỏ dấu đã quét'));
  end if;
  update public.fabric_issue_lines set scanned_at = null, scanned_by = null
   where plan_id = p_plan_id and group_uid_code = v_code
   returning * into v_line;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_IN_PLAN','message','UID không thuộc đợt này'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'line',(public.fabric_issue_lines_json(p_plan_id, v_line.id)->0),'plan',public.fabric_issue_plan_json(p_plan_id)));
end$$;

-- Moi nguoi: danh sach dot (dot dang mo len truoc), toi da 40.
create or replace function public.fabric_issue_list()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('ok',true,'data',jsonb_build_object('plans',
    coalesce((select jsonb_agg(public.fabric_issue_plan_json(x.id) order by (x.status = 'open') desc, x.created_at desc)
                from (select id, status, created_at from public.fabric_issue_plans
                       order by (status = 'open') desc, created_at desc limit 40) x), '[]'::jsonb)))
$$;

-- Moi nguoi: mot dot day du (dong + ten san pham de biet don vi).
create or replace function public.fabric_issue_get(p_plan_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_products jsonb;
begin
  if not exists (select 1 from public.fabric_issue_plans where id = p_plan_id) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại hoặc đã bị xóa'));
  end if;
  select coalesce(jsonb_object_agg(s.sku, s.product_name), '{}'::jsonb) into v_products
    from public."SKU_Name" s
   where s.sku in (select distinct sku from public.fabric_issue_lines where plan_id = p_plan_id);
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'plan', public.fabric_issue_plan_json(p_plan_id),
    'lines', public.fabric_issue_lines_json(p_plan_id),
    'products', v_products));
end$$;

-- Moi nguoi: quet mot Group UID trong dot.
-- Thanh cong: data.result = 'issued' (vua danh dau) | 'already' (da quet truoc do) kem dong + tien do.
-- That bai: error.code = INVALID_UID | PLAN_NOT_FOUND | PLAN_CLOSED | NOT_IN_PLAN | UID_UNKNOWN (kem data neu biet UID).
create or replace function public.fabric_issue_scan(p_plan_id uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(p_group_uid), '');
  v_by text := left(btrim(coalesce(p_by, '')), 60);
  v_plan public.fabric_issue_plans; v_line public.fabric_issue_lines; v_g public.group_uid_details;
  v_known boolean; v_other_id uuid; v_other_name text; v_result text;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  select * into v_plan from public.fabric_issue_plans where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại hoặc đã bị xóa'));
  end if;
  select * into v_line from public.fabric_issue_lines where plan_id = p_plan_id and group_uid_code = v_code for update;
  if found then
    if v_line.scanned_at is not null then
      v_result := 'already';
    elsif v_plan.status <> 'open' then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_CLOSED','message','Đợt cấp vải đã đóng'));
    else
      update public.fabric_issue_lines set scanned_at = now(), scanned_by = nullif(v_by, '') where id = v_line.id;
      v_result := 'issued';
    end if;
    return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'result', v_result,
      'line', (public.fabric_issue_lines_json(p_plan_id, v_line.id)->0),
      'plan', public.fabric_issue_plan_json(p_plan_id)));
  end if;
  select * into v_g from public.group_uid_details where group_uid_code = v_code;
  v_known := found;
  select p.id, p.name into v_other_id, v_other_name
    from public.fabric_issue_lines l join public.fabric_issue_plans p on p.id = l.plan_id
   where l.group_uid_code = v_code and l.plan_id <> p_plan_id and p.status = 'open'
   order by p.created_at desc limit 1;
  return jsonb_build_object('ok',false,
    'error', jsonb_build_object(
      'code', case when v_known then 'NOT_IN_PLAN' else 'UID_UNKNOWN' end,
      'message', case when v_known then 'UID này không thuộc đợt cấp vải đang mở' else 'UID chưa có trong dữ liệu Group UID' end),
    'data', case when v_known then jsonb_build_object(
      'groupUid', v_g.group_uid_code, 'sku', coalesce(v_g.sku,''), 'lot', coalesce(v_g.batch_code,''), 'roll', coalesce(v_g.roll_code,''),
      'location', v_g.location, 'wmsStatus', v_g.status,
      'otherPlan', case when v_other_id is null then null else jsonb_build_object('id', v_other_id, 'name', v_other_name) end)
      else null end);
end$$;

revoke all on function public.fabric_issue_norm(text) from public, anon, authenticated;
revoke all on function public.fabric_issue_find_uid(text,text,text,text[]) from public, anon, authenticated;
revoke all on function public.fabric_issue_lines_json(uuid,bigint) from public, anon, authenticated;
revoke all on function public.fabric_issue_plan_json(uuid) from public, anon, authenticated;
revoke all on function public.fabric_issue_match_plan(uuid) from public, anon, authenticated;
revoke all on function public.fabric_issue_import(jsonb) from public, anon, authenticated;
revoke all on function public.fabric_issue_rematch(uuid) from public, anon, authenticated;
revoke all on function public.fabric_issue_set_status(uuid,text) from public, anon, authenticated;
revoke all on function public.fabric_issue_delete(uuid) from public, anon, authenticated;
revoke all on function public.fabric_issue_unscan(uuid,text) from public, anon, authenticated;
revoke all on function public.fabric_issue_list() from public, anon, authenticated;
revoke all on function public.fabric_issue_get(uuid) from public, anon, authenticated;
revoke all on function public.fabric_issue_scan(uuid,text,text) from public, anon, authenticated;
grant execute on function public.fabric_issue_import(jsonb) to authenticated;
grant execute on function public.fabric_issue_rematch(uuid) to authenticated;
grant execute on function public.fabric_issue_set_status(uuid,text) to authenticated;
grant execute on function public.fabric_issue_delete(uuid) to authenticated;
grant execute on function public.fabric_issue_unscan(uuid,text) to authenticated;
grant execute on function public.fabric_issue_list() to anon, authenticated;
grant execute on function public.fabric_issue_get(uuid) to anon, authenticated;
grant execute on function public.fabric_issue_scan(uuid,text,text) to anon, authenticated;

commit;
