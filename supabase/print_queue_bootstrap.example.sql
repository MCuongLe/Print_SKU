-- Thay hai chuỗi REPLACE_* bằng token tạo ở máy quản trị rồi chạy trong SQL Editor.
-- Không lưu hoặc commit file sau khi đã thay token thật.
insert into public.print_access_keys(name,token_hash)
values('print-web-main',public.print_token_hash('REPLACE_WEB_PRINT_TOKEN'))
on conflict(name) do update set token_hash=excluded.token_hash,enabled=true,updated_at=now();

insert into public.print_agents(id,name,token_hash,capabilities)
values('may-kho-01','Máy kho 01',public.print_token_hash('REPLACE_AGENT_TOKEN'),array['sku:v1','group_uid:v1'])
on conflict(id) do update set token_hash=excluded.token_hash,enabled=true,capabilities=excluded.capabilities,updated_at=now();
