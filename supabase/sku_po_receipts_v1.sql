-- In lại tem SKU có PO khi quét SKU (23/10/2026, docs/plans/2026-10-23-in-lai-tem-sku-po.md).
-- Vì sao: PO + ngày nhận của tem Phụ liệu (tem SKU template_version 2) chỉ nằm trong print_jobs, mà print_jobs tự dọn sau 3 ngày
-- (print_jobs_purge). Bảng sku_po_receipts giữ lâu dài "SKU đã về theo PO nào, ngày nhận nào" để IN TEM SKU quét SKU là in lại
-- được tem có PO (SKU nhiều PO → người dùng chọn trên pop-up, PO mới nhất trên cùng).
-- Tác động:
--   * Bảng mới public.sku_po_receipts (khoá sku + po), chỉ service_role đọc/ghi trực tiếp (RLS bật, không policy).
--   * Trigger after insert trên print_jobs: mỗi lệnh type 'sku', template_version 2 (tem Phụ liệu) hoặc 3 (mẫu gộp, item có PO)
--     → upsert từng item có sku + po đúng mẫu agent (^[0-9A-Za-z._/ -]{1,20}$; sai thì bỏ qua item) — receivedDate dd/mm/yyyy năm
--     2000–2099 → date, sai dạng thì để trống. Lệnh trùng nonce không insert nên không đếm.
--     Lỗi trong trigger KHÔNG được làm hỏng lệnh in: bọc exception, chỉ ghi warning vào log Postgres.
--   * Quy ước (người dùng chốt 23/10): cùng PO nhận nhiều đợt → ngày nhận = ngày của lần in gần nhất có ngày.
--   * Nạp bù từ print_jobs đang có, chỉ lệnh đã in xong (status completed) — không lấy lệnh thử / lỗi.
--   * RPC sku_po_lookup(p_skus text[]) cho anon/authenticated (như sku_combo_lookup): tối đa 100 SKU, mỗi SKU tối đa 20 PO gần nhất
--     {po, receivedDate (dd/mm/yyyy | null)} xếp ngày nhận mới nhất trước, rồi lần in gần nhất.
-- Không đổi hàm / bảng cũ. Chạy: python scripts/apply_supabase_sql.py supabase/sku_po_receipts_v1.sql
begin;

create table if not exists public.sku_po_receipts (
  sku text not null check (length(sku) between 1 and 80),
  po text not null check (length(po) between 1 and 20),
  received_date date,
  product_name text,
  first_printed_at timestamptz not null default now(),
  last_printed_at timestamptz not null default now(),
  print_count integer not null default 1,
  primary key (sku, po)
);
alter table public.sku_po_receipts enable row level security;
revoke all on table public.sku_po_receipts from public, anon, authenticated;
create index if not exists sku_po_receipts_sku_recent_idx on public.sku_po_receipts (sku, received_date desc nulls last, last_printed_at desc);
comment on table public.sku_po_receipts is
  'SKU đã in tem có PO theo PO nào (ghi từ print_jobs type sku v2/v3 bằng trigger) — IN TEM SKU tra để in lại tem có PO.';

-- Ghi các item có PO của một lệnh sku v2 vào sku_po_receipts. Dùng cho trigger và nạp bù.
create or replace function public._sku_po_receipts_capture(p_payload jsonb, p_at timestamptz)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer := 0; v_item jsonb; v_sku text; v_po text; v_date text; v_received date;
begin
  if jsonb_typeof(p_payload) <> 'object' then return 0; end if;
  -- Lệnh nhiều tem {items:[…]} hoặc một tem {sku, …} (hàng đợi nhận cả hai dạng).
  for v_item in select value from jsonb_array_elements(case when jsonb_typeof(p_payload->'items') = 'array' then p_payload->'items' else jsonb_build_array(p_payload) end) loop
    if jsonb_typeof(v_item) <> 'object' then continue; end if;
    v_sku := nullif(btrim(coalesce(v_item->>'sku', '')), '');
    v_po := nullif(btrim(coalesce(v_item->>'po', '')), '');
    if v_sku is null or v_po is null or length(v_sku) > 80 or v_po !~ '^[0-9A-Za-z._/ -]{1,20}$' then continue; end if;
    v_date := btrim(coalesce(v_item->>'receivedDate', ''));
    v_received := null;
    if v_date ~ '^\d{2}/\d{2}/\d{4}$' then
      begin v_received := to_date(v_date, 'DD/MM/YYYY'); exception when others then v_received := null; end;
      if v_received is not null and (to_char(v_received, 'DD/MM/YYYY') <> v_date or extract(year from v_received) not between 2000 and 2099) then v_received := null; end if;
    end if;
    insert into public.sku_po_receipts as r (sku, po, received_date, product_name, first_printed_at, last_printed_at, print_count)
    values (v_sku, v_po, v_received, nullif(btrim(coalesce(v_item->>'productName', '')), ''), p_at, p_at, 1)
    on conflict (sku, po) do update set
      received_date = coalesce(excluded.received_date, r.received_date),
      product_name = coalesce(excluded.product_name, r.product_name),
      first_printed_at = least(r.first_printed_at, excluded.first_printed_at),
      last_printed_at = greatest(r.last_printed_at, excluded.last_printed_at),
      print_count = r.print_count + 1;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;
revoke all on function public._sku_po_receipts_capture(jsonb, timestamptz) from public, anon, authenticated;

create or replace function public.sku_po_receipts_on_print_job()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public._sku_po_receipts_capture(new.payload, coalesce(new.created_at, now()));
  exception when others then
    -- Nhật ký PO không được chặn lệnh in; để lại vết trong log Postgres.
    raise warning 'sku_po_receipts: %', sqlerrm;
  end;
  return new;
end $$;
revoke all on function public.sku_po_receipts_on_print_job() from public, anon, authenticated;


create or replace trigger sku_po_receipts_capture
  after insert on public.print_jobs
  for each row when (new.type = 'sku' and new.template_version in (2, 3))
  execute function public.sku_po_receipts_on_print_job();

-- Nạp bù: chỉ khi bảng còn trống (chạy lại migration không đếm trùng).
do $$
begin
  if not exists (select 1 from public.sku_po_receipts) then
    perform public._sku_po_receipts_capture(j.payload, j.created_at)
      from public.print_jobs j where j.type = 'sku' and j.template_version in (2, 3) and j.status = 'completed' order by j.created_at;
  end if;
end $$;

-- Tra PO đã nhận của các SKU (IN TEM SKU). Trả {ok, data:{items:[{sku, pos:[{po, receivedDate}]}]}}; SKU không có PO thì pos rỗng.
create or replace function public.sku_po_lookup(p_skus text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_skus text[];
begin
  -- Chặn mảng quá lớn TRƯỚC khi unnest / khử trùng (hàm mở cho anon).
  if coalesce(cardinality(p_skus), 0) > 100 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'TOO_MANY', 'message', 'Tối đa 100 SKU mỗi lần tra'));
  end if;
  select coalesce(array_agg(distinct s), '{}') into v_skus
    from (select nullif(btrim(x), '') as s from unnest(coalesce(p_skus, '{}')) as x) t where s is not null and length(s) <= 80;
  if cardinality(v_skus) > 100 then
    return jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'TOO_MANY', 'message', 'Tối đa 100 SKU mỗi lần tra'));
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('sku', s.sku, 'pos', coalesce((
      select jsonb_agg(jsonb_build_object('po', q.po, 'receivedDate', to_char(q.received_date, 'DD/MM/YYYY'))
                       order by q.received_date desc nulls last, q.last_printed_at desc, q.po desc)
        from (select r.po, r.received_date, r.last_printed_at from public.sku_po_receipts r where r.sku = s.sku
               order by r.received_date desc nulls last, r.last_printed_at desc, r.po desc limit 20) q), '[]'::jsonb)) order by s.sku)
    from unnest(v_skus) as s(sku)), '[]'::jsonb)),
    'meta', jsonb_build_object('updatedAt', now(), 'schemaVersion', 1));
end $$;
revoke all on function public.sku_po_lookup(text[]) from public;
grant execute on function public.sku_po_lookup(text[]) to anon, authenticated;

commit;

notify pgrst, 'reload schema';
