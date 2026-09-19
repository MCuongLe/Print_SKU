-- Gom hàng mẫu cùng SKU vào một bao cho màn Sample.
-- Chạy một lần trong Supabase SQL Editor, sau print_queue_v1.sql (cần extension pgcrypto đã bật ở đó).
-- Cùng quy ước với hàng đợi in: bảng bị RLS chặn đọc/ghi trực tiếp, web chỉ đi qua RPC security definer.
-- p_access_token giữ nguyên hình dạng tham số của print_* nhưng không kiểm tra, vì bất kỳ ai có link ứng dụng đều được dùng.

create table if not exists public.sample_bags (
  id uuid primary key default gen_random_uuid(),
  bag_no integer not null unique,
  sku text not null unique,
  quantity integer not null default 1 check(quantity > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.sample_bags enable row level security;
revoke all on public.sample_bags from anon,authenticated;

-- Quét một SKU: chưa có bao thì cấp số bao mới (max + 1, bắt đầu từ 1), đã có bao thì cộng 1 vào số lượng.
-- SKU không nằm trong danh mục tổng public."SKU_Name" bị từ chối với mã SKU_INACTIVE.
create or replace function public.sample_scan(p_access_token text,p_sku text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_sku text; v_row public.sample_bags; v_created boolean := false;
begin
  v_sku := nullif(trim(p_sku),'');
  if v_sku is null then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','INVALID_SKU','message','Chưa có mã SKU')); end if;
  if not exists(select 1 from public."SKU_Name" where sku=v_sku) then
    return jsonb_build_object('ok',false,'error',jsonb_build_object('code','SKU_INACTIVE','message','SKU này inactive'));
  end if;
  select * into v_row from public.sample_bags where sku=v_sku for update;
  if not found then
    -- Khoá cả bảng trong giao dịch này để hai máy quét cùng lúc không giành cùng một số bao.
    perform pg_advisory_xact_lock(hashtext('public.sample_bags')::bigint);
    select * into v_row from public.sample_bags where sku=v_sku for update;
  end if;
  if found then
    update public.sample_bags set quantity=quantity+1,updated_at=now() where id=v_row.id returning * into v_row;
  else
    insert into public.sample_bags(bag_no,sku,quantity)
    values((select coalesce(max(bag_no),0)+1 from public.sample_bags),v_sku,1) returning * into v_row;
    v_created := true;
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('bagNo',v_row.bag_no,'sku',v_row.sku,'quantity',v_row.quantity,'created',v_created,'createdAt',v_row.created_at,'updatedAt',v_row.updated_at),'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end$$;

create or replace function public.sample_list(p_access_token text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'bags',coalesce((select jsonb_agg(jsonb_build_object('bagNo',bag_no,'sku',sku,'quantity',quantity,'createdAt',created_at,'updatedAt',updated_at) order by bag_no) from public.sample_bags),'[]'::jsonb),
    'totalBags',(select count(*) from public.sample_bags),
    'totalQuantity',(select coalesce(sum(quantity),0) from public.sample_bags)
  ),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

-- Quét nhầm: bớt 1 mẫu. Bao còn đúng 1 mẫu thì xoá hẳn dòng vì bao rỗng không còn nghĩa gì.
create or replace function public.sample_decrement(p_access_token text,p_sku text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.sample_bags;
begin
  select * into v_row from public.sample_bags where sku=nullif(trim(p_sku),'') for update;
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','SKU này chưa có bao')); end if;
  if v_row.quantity<=1 then
    delete from public.sample_bags where id=v_row.id;
    return jsonb_build_object('ok',true,'data',jsonb_build_object('bagNo',v_row.bag_no,'sku',v_row.sku,'quantity',0,'removed',true),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  update public.sample_bags set quantity=quantity-1,updated_at=now() where id=v_row.id returning * into v_row;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('bagNo',v_row.bag_no,'sku',v_row.sku,'quantity',v_row.quantity,'removed',false),'meta',jsonb_build_object('updatedAt',v_row.updated_at,'schemaVersion',1));
end$$;

create or replace function public.sample_delete(p_access_token text,p_sku text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_row public.sample_bags;
begin
  delete from public.sample_bags where sku=nullif(trim(p_sku),'') returning * into v_row;
  if not found then return jsonb_build_object('ok',false,'error',jsonb_build_object('code','NOT_FOUND','message','SKU này chưa có bao')); end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object('bagNo',v_row.bag_no,'sku',v_row.sku,'quantity',0,'removed',true),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.sample_scan(text,text) from public;
revoke all on function public.sample_list(text) from public;
revoke all on function public.sample_decrement(text,text) from public;
revoke all on function public.sample_delete(text,text) from public;
grant execute on function public.sample_scan(text,text) to anon,authenticated;
grant execute on function public.sample_list(text) to anon,authenticated;
grant execute on function public.sample_decrement(text,text) to anon,authenticated;
grant execute on function public.sample_delete(text,text) to anon,authenticated;
