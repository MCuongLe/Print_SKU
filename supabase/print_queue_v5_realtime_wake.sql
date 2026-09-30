-- Đánh thức agent bằng Supabase Realtime (30/09/2026, agent 0.8.4).
--
-- Trước đây agent hỏi hàng đợi mỗi giây, 24/7 (~86.000 lần gọi/ngày) chỉ để biết có lệnh
-- mới hay chưa — chiếm gần hết 1 GB nhật ký/tháng của gói Free. Nay mỗi khi một lệnh VÀO
-- hàng đợi (insert) hoặc QUAY VỀ hàng đợi (requeue, hết lease), cơ sở dữ liệu phát một tin
-- Broadcast công khai trên topic `print-queue`; agent giữ một kết nối Realtime và chỉ hỏi
-- hàng đợi khi nhận tin, ngoài ra hỏi dự phòng thưa (xem workstation-agent/src/agent.mjs).
--
-- Tin chỉ mang id/loại/số tem của lệnh — không có nội dung tem. Topic công khai nên ai có
-- publishable key cũng nghe được, nhưng nghe được cũng chỉ biết "vừa có lệnh"; gửi tin giả
-- vào topic chỉ khiến agent hỏi hàng đợi thêm một lần, vô hại.
--
-- realtime.send KHÔNG được phép làm hỏng lệnh in: nó ghi vào realtime.messages, bảng phân
-- vùng theo ngày mà chỉ client Realtime đang kết nối mới tạo phân vùng (tài liệu Supabase).
-- Chưa có phân vùng của ngày → insert lỗi; vì vậy bọc EXCEPTION và bỏ qua — agent vẫn còn
-- đường hỏi dự phòng.

create or replace function public.print_jobs_wake_agent()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('jobId', new.id, 'type', new.type, 'copies', new.copies, 'status', new.status),
      'queued',
      'print-queue',
      false
    );
  exception when others then
    raise warning 'print_jobs_wake_agent: không phát được tín hiệu Realtime cho lệnh % (%): %', new.id, new.status, sqlerrm;
  end;
  return new;
end$$;

revoke all on function public.print_jobs_wake_agent() from public, anon, authenticated;

drop trigger if exists print_jobs_wake_agent on public.print_jobs;
create trigger print_jobs_wake_agent
  after insert or update of status on public.print_jobs
  for each row
  when (new.status = 'queued')
  execute function public.print_jobs_wake_agent();
