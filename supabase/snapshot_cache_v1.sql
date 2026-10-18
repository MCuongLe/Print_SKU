-- Cache trên máy + kiểm phiên bản (18/10/2026).
--
-- Vì sao: KIỂM KÊ SKU, UID tạm (Rủi ro lưu trữ) và danh mục SKU (IN TEM SKU / TÌM SKU) mỗi lần mở màn đều tải lại toàn bộ
-- dữ liệu dù không có gì đổi. Web nay giữ bản sao trên máy (chỉ đọc, Supabase luôn là nguồn đúng) và mỗi lần mở màn gọi ĐÚNG
-- MỘT hàm dưới đây để biết bản sao còn dùng được không:
--   * sku_count_snapshot(p_known_run_id)  — lượt Kiểm kê hoàn tất mới nhất trùng runId web đang giữ → {unchanged:true, runId};
--     khác (hoặc web chưa có) → nguyên kết quả sku_count_overview() kèm unchanged:false.
--   * uid_temp_snapshot(p_known_run_id)   — như trên cho uid_temp_overview() (giữ khoá history).
--   * sku_catalog_changes(p_since)        — phiên bản danh mục {activeCount, maxUpdatedAt} + phần đổi từ p_since:
--     upserts = SKU đang hoạt động có updated_at > p_since; removed = MÃ SKU (không tên) đã ngừng sau p_since hoặc đã bị
--     chuyển sang sku_archive sau p_since (SKU rời nhóm đồng bộ bị XOÁ khỏi SKU_Name, sku_missing_archive_v1); quá 2.000 dòng
--     hoặc p_since null → tooMany:true, hai mảng rỗng (web tự tải toàn bộ). Cần SECURITY DEFINER vì anon chỉ thấy status '1'
--     qua policy sku_name_read_active (sku_inactive_v1) và không đọc được sku_archive.
--
-- Tác động: chỉ THÊM ba hàm chỉ-đọc (stable, SECURITY DEFINER, search_path ''), cấp anon + authenticated như sku_count_overview.
-- Không đổi bảng, không thay sku_count_overview() / uid_temp_overview() (trang cũ còn gọi; thêm tham số mặc định vào hàm cũ sẽ
-- sinh hai hàm cùng gọi được bằng {} → PostgREST PGRST203). Không drop gì: không cần --allow-destructive.
-- Chạy migration TRƯỚC khi push index.html (web mới gọi ba hàm này).
-- Chạy: python scripts/apply_supabase_sql.py supabase/snapshot_cache_v1.sql
begin;

-- Kiểm kê SKU: chọn lượt mới nhất giống hệt sku_count_overview(); trùng lượt web đang giữ thì không gửi lại các dòng.
create or replace function public.sku_count_snapshot(p_known_run_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_known_run_id is not null then
    select id into v_id from public.sku_count_runs where status = 'completed' order by completed_at desc, id desc limit 1;
    if v_id = p_known_run_id then
      return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',true,'runId',v_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
    end if;
  end if;
  -- Lượt mới, web chưa có, hoặc chưa có lượt nào ({run:null, rows:[]}): nguyên kết quả hàm cũ + unchanged:false.
  return jsonb_set(public.sku_count_overview(), '{data,unchanged}', 'false'::jsonb, true);
end$$;

-- UID tạm: chọn lượt mới nhất giống hệt uid_temp_overview() (theo giờ đọc, không theo giờ ghi).
create or replace function public.uid_temp_snapshot(p_known_run_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_id uuid;
begin
  if p_known_run_id is not null then
    select id into v_id from public.uid_temp_runs order by read_at desc, created_at desc, id desc limit 1;
    if v_id = p_known_run_id then
      return jsonb_build_object('ok',true,'data',jsonb_build_object('unchanged',true,'runId',v_id),'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
    end if;
  end if;
  -- Gồm run, rows và history như uid_temp_overview(); chưa có lượt nào → {run:null, rows:[], history:[]}.
  return jsonb_set(public.uid_temp_overview(), '{data,unchanged}', 'false'::jsonb, true);
end$$;

-- Danh mục SKU: phiên bản + phần thay đổi từ p_since (web truyền maxUpdatedAt của bản đang giữ).
create or replace function public.sku_catalog_changes(p_since timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_active integer; v_max timestamptz; v_total integer; v_upserts jsonb; v_removed jsonb;
begin
  -- maxUpdatedAt tính trên MỌI dòng (kể cả ngừng) và cả mốc lưu trữ: SKU bị chuyển sang sku_archive cũng làm đổi phiên bản.
  select count(*) filter (where s.status = '1'),
         greatest(max(s.updated_at), max(s.inactive_since), (select max(a.archived_at) from public.sku_archive a))
    into v_active, v_max
    from public."SKU_Name" s;

  with upserts as (
    select s.sku, s.product_name, s.status from public."SKU_Name" s
     where s.status = '1' and s.updated_at > p_since
  ), removed as (
    select s.sku from public."SKU_Name" s
     where s.status is distinct from '1' and s.inactive_since > p_since
    union
    select a.sku from public.sku_archive a
     where a.archived_at > p_since and not exists (select 1 from public."SKU_Name" x where x.sku = a.sku and x.status = '1')
  ), sizes as (
    select (select count(*) from upserts) + (select count(*) from removed) as n
  )
  select z.n,
         case when z.n <= 2000 then (select coalesce(jsonb_agg(jsonb_build_object('sku', u.sku, 'product_name', u.product_name, 'status', u.status) order by u.sku), '[]'::jsonb) from upserts u) end,
         case when z.n <= 2000 then (select coalesce(jsonb_agg(r.sku order by r.sku), '[]'::jsonb) from removed r) end
    into v_total, v_upserts, v_removed
    from sizes z;

  -- Web chưa có bản nào (p_since null) hoặc đổi quá nhiều: tải lại toàn bộ rẻ hơn ghép từng dòng.
  if p_since is null or v_total > 2000 then
    return jsonb_build_object('ok',true,'data',jsonb_build_object(
      'version', jsonb_build_object('activeCount',v_active,'maxUpdatedAt',v_max),
      'tooMany', true, 'upserts', '[]'::jsonb, 'removed', '[]'::jsonb),
      'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
  end if;
  return jsonb_build_object('ok',true,'data',jsonb_build_object(
    'version', jsonb_build_object('activeCount',v_active,'maxUpdatedAt',v_max),
    'tooMany', false, 'upserts', v_upserts, 'removed', v_removed),
    'meta',jsonb_build_object('updatedAt',now(),'schemaVersion',1));
end$$;

revoke all on function public.sku_count_snapshot(uuid) from public;
revoke all on function public.uid_temp_snapshot(uuid) from public;
revoke all on function public.sku_catalog_changes(timestamptz) from public;
grant execute on function public.sku_count_snapshot(uuid) to anon, authenticated;
grant execute on function public.uid_temp_snapshot(uuid) to anon, authenticated;
grant execute on function public.sku_catalog_changes(timestamptz) to anon, authenticated;

commit;
notify pgrst,'reload schema';
