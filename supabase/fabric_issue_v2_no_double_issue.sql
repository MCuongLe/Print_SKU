-- CAP VAI v2 (12/10/2026): chan cap trung mot UID o nhieu dot.
--
-- Loi tim thay khi kiem tra luong thuc te: v1 chi xet UID trong dot dang quet, nen cung mot Group UID nam o hai dot
-- (vi du nhap lai file Packing List, dot cu van mo) duoc danh dau "da cap" o ca hai dot ma khong canh bao.
--
-- Doi thay:
--  1. fabric_issue_scan: UID da quet o dot khac -> khong danh dau them, tra loi ISSUED_ELSEWHERE kem ten dot, gio, may da quet.
--     Khoa tu van theo UID (pg_advisory_xact_lock) de hai may quet CUNG UID o HAI dot khac nhau cung luc van chi mot may duoc cap
--     (khoa dong cua tung dot chi chan cung mot dong, khong du cho truong hop nay). Moi lan quet khoa theo thu tu: UID roi dong.
--  2. fabric_issue_lines_json: them truong elsewhere (dot khac da cap UID cua dong nay: ten dot, gio, may) de giao dien bao truoc.
--  3. fabric_issue_import: tra them overlap {shared, issuedElsewhere} = so cuon trung UID voi dot khac / trong do da cap o dot khac.
--
-- Chi create or replace 3 ham co san (giu nguyen chu ky, cap lai quyen nhu v1); khong doi bang, khong drop: khong can --allow-destructive.
begin;

create or replace function public.fabric_issue_lines_json(p_plan_id uuid, p_line_id bigint default null)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', l.id, 'no', l.line_no, 'sku', l.sku, 'color', l.color, 'lot', l.lot_no, 'roll', l.roll_no, 'qtyM', l.qty_m,
    'state', l.match_state, 'note', l.match_note, 'groupUid', l.group_uid_code,
    'scannedAt', l.scanned_at, 'scannedBy', l.scanned_by,
    'location', g.location, 'warehouse', g.warehouse, 'wmsStatus', g.status, 'wmsQty', g.qty,
    'elsewhere', (select jsonb_build_object('plan', p.name, 'at', o.scanned_at, 'by', o.scanned_by)
                    from public.fabric_issue_lines o join public.fabric_issue_plans p on p.id = o.plan_id
                   where o.group_uid_code = l.group_uid_code and o.plan_id <> l.plan_id and o.scanned_at is not null
                   order by o.scanned_at desc limit 1)
  ) order by l.line_no), '[]'::jsonb)
  from public.fabric_issue_lines l
  left join public.group_uid_details g on g.group_uid_code = l.group_uid_code
  where l.plan_id = p_plan_id and (p_line_id is null or l.id = p_line_id)
$$;

create or replace function public.fabric_issue_import(p_plan jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_line jsonb; v_i integer := 0; v_name text; v_lines jsonb; v_qty numeric; v_shared integer; v_issued integer;
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
  -- Cuon trung UID voi dot khac (vi du nhap lai file) / trong do da cap o dot khac: de giao dien canh bao Admin.
  select count(*) filter (where exists (select 1 from public.fabric_issue_lines o where o.group_uid_code = l.group_uid_code and o.plan_id <> l.plan_id)),
         count(*) filter (where exists (select 1 from public.fabric_issue_lines o where o.group_uid_code = l.group_uid_code and o.plan_id <> l.plan_id and o.scanned_at is not null))
    into v_shared, v_issued
    from public.fabric_issue_lines l where l.plan_id = v_id and l.group_uid_code is not null;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'plan', public.fabric_issue_plan_json(v_id),
    'overlap', jsonb_build_object('shared', v_shared, 'issuedElsewhere', v_issued)));
end$$;

create or replace function public.fabric_issue_scan(p_plan_id uuid, p_group_uid text, p_by text default '')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := nullif(btrim(p_group_uid), '');
  v_by text := left(btrim(coalesce(p_by, '')), 60);
  v_plan public.fabric_issue_plans; v_line public.fabric_issue_lines; v_g public.group_uid_details;
  v_known boolean; v_other_id uuid; v_other_name text; v_result text;
  v_dup_name text; v_dup_at timestamptz; v_dup_by text;
begin
  if v_code is null or length(v_code) > 40 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_UID','message','UID không hợp lệ'));
  end if;
  select * into v_plan from public.fabric_issue_plans where id = p_plan_id;
  if not found then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_NOT_FOUND','message','Đợt cấp vải không tồn tại hoặc đã bị xóa'));
  end if;
  -- Tuan tu hoa moi lan quet CUNG UID (ke ca o dot khac nhau) tai day, roi moi khoa dong: kiem tra "da cap o dot khac" khong bi dua.
  perform pg_advisory_xact_lock(hashtextextended('fabric_issue:' || v_code, 0));
  select * into v_line from public.fabric_issue_lines where plan_id = p_plan_id and group_uid_code = v_code for update;
  if found then
    if v_line.scanned_at is not null then
      v_result := 'already';
    elsif v_plan.status <> 'open' then
      return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PLAN_CLOSED','message','Đợt cấp vải đã đóng'));
    else
      select p.name, o.scanned_at, o.scanned_by into v_dup_name, v_dup_at, v_dup_by
        from public.fabric_issue_lines o join public.fabric_issue_plans p on p.id = o.plan_id
       where o.group_uid_code = v_code and o.plan_id <> p_plan_id and o.scanned_at is not null
       order by o.scanned_at desc limit 1;
      if found then
        select * into v_g from public.group_uid_details where group_uid_code = v_code;
        return jsonb_build_object('ok',false,
          'error', jsonb_build_object('code','ISSUED_ELSEWHERE','message','UID này đã được cấp ở đợt khác'),
          'data', jsonb_build_object('groupUid', v_code, 'sku', coalesce(v_g.sku, v_line.sku), 'lot', coalesce(v_g.batch_code, v_line.lot_no), 'roll', coalesce(v_g.roll_code, v_line.roll_no),
                                     'location', v_g.location, 'wmsStatus', v_g.status,
                                     'otherPlan', jsonb_build_object('name', v_dup_name, 'scannedAt', v_dup_at, 'scannedBy', v_dup_by)));
      end if;
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

-- create or replace giu quyen cu; cap lai y het v1 cho chac.
revoke all on function public.fabric_issue_lines_json(uuid,bigint) from public, anon, authenticated;
revoke all on function public.fabric_issue_import(jsonb) from public, anon, authenticated;
revoke all on function public.fabric_issue_scan(uuid,text,text) from public, anon, authenticated;
grant execute on function public.fabric_issue_import(jsonb) to authenticated;
grant execute on function public.fabric_issue_scan(uuid,text,text) to anon, authenticated;

commit;
