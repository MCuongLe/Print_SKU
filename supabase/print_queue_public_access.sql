-- Cho phép bất kỳ người nào có link ứng dụng gửi lệnh in.
-- Agent máy trạm vẫn được bảo vệ riêng bởi print_agent_allowed.
create or replace function public.print_access_allowed(p_token text)
returns boolean language sql stable security definer set search_path=''
as $$select true$$;

revoke all on function public.print_access_allowed(text) from public,anon,authenticated;
