-- Dọn hai module không còn dùng (11/10/2026): GOM HÀNG MẪU (sample_*) và TEM XẢ VẢI (fabric_relaxation).
--
-- Gom hàng mẫu: bỏ 4 RPC sample_scan / sample_decrement / sample_delete / sample_list và bảng sample_bags
-- (142 bao, lần quét cuối 19/09/2026; đã xuất outputs/sample_bags_backup_2026-10-11.csv trước khi xoá, file ngoài git).
-- Tem xả vải: web đã bỏ màn #fabric-relaxation. Máy chủ GIỮ nguyên: print_jobs.type vẫn cho phép 'fabric_relaxation'
-- (CHECK có sẵn), print_enqueue_unchecked vẫn kiểm payload loại này, agent 0.8.9 vẫn khai capability — không gây hại,
-- và bỏ sẽ phải đổi CHECK trên bảng có dữ liệu + phát hành agent mới. Khi nâng agent lần tới có thể bỏ mẫu tem này.
begin;

drop function if exists public.sample_scan(text, text);
drop function if exists public.sample_decrement(text, text);
drop function if exists public.sample_delete(text, text);
drop function if exists public.sample_list(text);
drop table if exists public.sample_bags;

notify pgrst, 'reload schema';
commit;
