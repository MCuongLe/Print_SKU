-- TÌM SKU bằng camera (30/09/2026): Edge Function `sku-vision` gọi Gemini
-- đọc chữ trên tem nhà cung cấp. Ứng dụng đang mở công khai
-- (print_access_allowed luôn true), nên thứ duy nhất giữ hạn mức Gemini miễn
-- phí không bị một máy hoặc người lạ đốt hết là bộ đếm lượt dưới đây.
--
-- Ngày tính theo giờ Pacific vì hạn mức "requests per day" của Gemini reset
-- lúc nửa đêm Pacific — đếm cùng mốc thì trần tổng mới khớp với trần thật.
-- Chỉ Edge Function (service role) gọi hàm này; anon/authenticated không có quyền.

create table if not exists public.sku_vision_usage (
  day date not null,
  device text not null,
  calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, device)
);

alter table public.sku_vision_usage enable row level security;
revoke all on public.sku_vision_usage from anon, authenticated;

create or replace function public.sku_vision_take(p_device text, p_device_limit integer, p_global_limit integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
  v_device text := left(coalesce(nullif(trim(p_device), ''), 'khong-ro'), 64);
  v_total integer;
  v_mine integer;
begin
  -- Khoá theo ngày để hai lượt cùng lúc không cùng lọt qua trần tổng.
  perform pg_advisory_xact_lock(hashtext('sku_vision_take:' || v_day::text));
  select coalesce(sum(calls), 0) into v_total from public.sku_vision_usage where day = v_day;
  select coalesce(max(calls), 0) into v_mine from public.sku_vision_usage where day = v_day and device = v_device;
  if v_total >= p_global_limit then
    return jsonb_build_object('ok', false, 'code', 'GLOBAL_LIMIT', 'globalUsed', v_total, 'globalLimit', p_global_limit);
  end if;
  if v_mine >= p_device_limit then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_LIMIT', 'deviceUsed', v_mine, 'deviceLimit', p_device_limit);
  end if;
  insert into public.sku_vision_usage (day, device, calls) values (v_day, v_device, 1)
  on conflict (day, device) do update set calls = public.sku_vision_usage.calls + 1, updated_at = now();
  return jsonb_build_object('ok', true, 'deviceUsed', v_mine + 1, 'deviceLimit', p_device_limit,
    'globalUsed', v_total + 1, 'globalLimit', p_global_limit);
end$$;

revoke all on function public.sku_vision_take(text, integer, integer) from public, anon, authenticated;
