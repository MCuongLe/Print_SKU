-- Mã kích hoạt hiện cho mọi Admin (12/10/2026). Bản v1 chỉ trả mã rõ một lần cho người tạo và lưu hash,
-- nên Admin khác (hoặc tải lại trang) không thấy mã đang còn hạn. Nay lưu thêm mã rõ trong lúc còn hiệu lực
-- (tối đa 24 giờ, mặc định 30 phút), trả về trong print_devices_admin cho mã còn hạn; thu hồi hoặc hết hạn thì xoá.
-- Rủi ro: mã rõ nằm trong bảng chỉ Admin đọc được qua RPC, sống ngắn, và chỉ đổi được lấy khoá máy — chấp nhận.
begin;

alter table public.print_activation_codes add column if not exists code_plain text;

create or replace function public.print_activation_create(p_minutes integer default 30, p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; v_bytes bytea; v_code text := ''; v_id uuid; v_exp timestamptz; i integer; v_shown text;
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được tạo mã kích hoạt'));
  end if;
  if coalesce(p_minutes, 30) not between 5 and 1440 then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_MINUTES','message','Hiệu lực từ 5 phút tới 24 giờ'));
  end if;
  delete from public.print_activation_codes where expires_at < now() - interval '7 days';
  delete from public.print_activation_attempts where minute < now() - interval '1 day';
  -- Mã hết hạn hoặc đã thu hồi thì bỏ bản rõ.
  update public.print_activation_codes set code_plain = null where code_plain is not null and (revoked_at is not null or expires_at <= now());
  v_bytes := extensions.gen_random_bytes(8);
  for i in 0..7 loop
    v_code := v_code || substr(v_alpha, (get_byte(v_bytes, i) % 32) + 1, 1);
  end loop;
  v_shown := substr(v_code,1,4) || '-' || substr(v_code,5,4);
  v_exp := now() + make_interval(mins => coalesce(p_minutes, 30));
  insert into public.print_activation_codes(code_hash, code_plain, note, created_by, expires_at)
  values (public.print_token_hash(v_code), v_shown, left(btrim(coalesce(p_note,'')), 80), (select auth.uid()), v_exp)
  returning id into v_id;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id', v_id, 'code', v_shown, 'expiresAt', v_exp, 'minutes', coalesce(p_minutes,30)));
end $$;

create or replace function public.print_activation_revoke(p_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được thu hồi mã'));
  end if;
  update public.print_activation_codes set revoked_at = now(), code_plain = null where id = p_id and revoked_at is null;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('id',p_id,'revoked',found));
end $$;

create or replace function public.print_devices_admin()
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.print_admin_allowed() then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','FORBIDDEN','message','Chỉ Admin được xem thiết bị in'));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'devices', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'name', d.name, 'enabled', d.enabled, 'activatedAt', d.activated_at, 'lastSeenAt', d.last_seen_at,
        'lastPrintAt', d.last_print_at, 'printCount', d.print_count, 'userAgent', d.user_agent, 'disabledAt', d.disabled_at,
        'jobsToday', (select count(*) from public.print_jobs j where j.device_id = d.id and j.created_at >= date_trunc('day', now() at time zone 'Asia/Ho_Chi_Minh') at time zone 'Asia/Ho_Chi_Minh')
      ) order by d.enabled desc, coalesce(d.last_seen_at, d.activated_at) desc) from public.print_devices d), '[]'::jsonb),
    'codes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'note', c.note, 'createdAt', c.created_at, 'expiresAt', c.expires_at, 'revokedAt', c.revoked_at, 'useCount', c.use_count,
        'active', c.revoked_at is null and c.expires_at > now(),
        'code', case when c.revoked_at is null and c.expires_at > now() then c.code_plain end,
        'createdBy', (select username from public.user_roles u where u.user_id = c.created_by limit 1)
      ) order by c.created_at desc) from public.print_activation_codes c where c.created_at > now() - interval '7 days'), '[]'::jsonb),
    'legacyKeys', coalesce((select jsonb_agg(jsonb_build_object(
        'name', k.name, 'enabled', k.enabled, 'createdAt', k.created_at, 'isPublic', k.token_hash = public.print_token_hash('public')
      ) order by k.created_at) from public.print_access_keys k), '[]'::jsonb),
    'now', now()));
end $$;

notify pgrst, 'reload schema';
commit;
