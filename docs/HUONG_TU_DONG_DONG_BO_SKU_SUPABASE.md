# Hướng tự động đồng bộ SKU lên Supabase

## Mục tiêu

Xây dựng một worker chạy theo lịch để tự lấy và đồng bộ các dữ liệu sau mà không cần người dùng gửi yêu cầu qua chat:

- SKU Normal và thông tin category từ Inside.
- Quan hệ SKU Combo – SKU Normal từ Inside.
- Group UID từ WMS.
- Kết quả xác minh và báo cáo thay đổi sau mỗi lần chạy.

Supabase là nguồn dữ liệu chuẩn cho ứng dụng in tem và các chức năng tra cứu SKU.

## Kiến trúc đề xuất

```text
Windows Task Scheduler
        ↓
scripts/auto_sync_all.py
        ├── Lấy SKU từ Inside
        ├── Lấy quan hệ Combo – Normal
        ├── Lấy Group UID từ WMS
        ├── Kiểm tra và đối chiếu dữ liệu
        ├── Upsert Supabase
        ├── Xác minh sau cập nhật
        └── Lưu báo cáo, dọn file tạm
```

Nên dùng script Python có logic xác định và chạy bằng Windows Task Scheduler. AI Agent chỉ dùng để đọc báo cáo, giải thích lỗi hoặc hỗ trợ xử lý trường hợp bất thường.

## Quy trình một lần chạy

1. Kiểm tra kết nối và thông tin xác thực của Inside, WMS và Supabase.
2. Tải dữ liệu SKU Normal thuộc các category được quản lý.
3. Tải file quan hệ SKU Combo – SKU Normal.
4. Tải file ZIP Group UID từ WMS và giải nén Excel.
5. Kiểm tra cấu trúc file, trường bắt buộc, khóa trùng và dữ liệu rỗng.
6. Đối chiếu dữ liệu nguồn với Supabase.
7. Dừng nếu phát hiện biến động vượt ngưỡng an toàn.
8. Chỉ upsert các dòng mới hoặc thay đổi.
9. Đọc lại Supabase và xác minh toàn bộ dữ liệu nguồn.
10. Lưu báo cáo; chỉ dọn file tạm sau khi xác minh thành công.

## Bảng dữ liệu Supabase

| Dữ liệu | Bảng | Khóa upsert |
| --- | --- | --- |
| SKU Normal và Combo | `SKU_Name` | `sku` |
| Quan hệ Combo – Normal | `sku_combo_links` | `(combo_sku, normal_sku)` |
| Group UID | `group_uid_details` | `group_uid_code` |

Đồng bộ mặc định không tự động xóa dòng vắng mặt trong file nguồn. Việc xóa dữ liệu phải dùng một quy trình riêng có kiểm tra và phê duyệt.

Với Group UID, chỉ cập nhật khi `updated_date` của dữ liệu nguồn mới hơn hoặc bằng dữ liệu trên Supabase.

## Cơ chế đăng nhập

Hướng ưu tiên là gọi API chính thức của Inside và WMS bằng tài khoản dịch vụ, access token hoặc refresh token.

Không nên phụ thuộc vào phiên đăng nhập Chrome vì:

- Cookie có thể hết hạn.
- Chrome hoặc máy tính có thể bị đóng.
- Giao diện web thay đổi có thể làm hỏng thao tác tự động.
- Quy trình không thể vận hành ổn định khi không có người giám sát.

Thông tin bí mật lưu trong `.env` hoặc Windows Credential Manager, không commit vào Git:

```text
INSIDE_ACCESS_TOKEN=...
WMS_ACCESS_TOKEN=...
SUPABASE_URL=...
SUPABASE_SECRET_KEY=...
SUPABASE_ACCESS_TOKEN=...
```

## Cơ chế an toàn

Worker phải tự dừng và không ghi Supabase nếu gặp một trong các trường hợp:

- API trả về dữ liệu rỗng hoặc thiếu category.
- File thay đổi tên hoặc thiếu cột bắt buộc.
- Có SKU hoặc Group UID trùng khóa.
- Combo tham chiếu SKU Normal không tồn tại.
- Số lượng SKU mới, đổi tên hoặc chuyển category vượt ngưỡng cấu hình.
- Số dòng giảm bất thường so với lần chạy thành công gần nhất.
- Có dòng Group UID thiếu trạng thái hoặc ngày cập nhật không hợp lệ.
- Kết quả đọc lại Supabase không khớp dữ liệu vừa ghi.

Sử dụng lock file để ngăn hai lượt đồng bộ chạy đồng thời:

```text
tmp/auto_sync_all.lock
```

## Lịch chạy đề xuất

| Dữ liệu | Tần suất |
| --- | --- |
| SKU Normal | Mỗi ngày một lần |
| SKU Combo | Mỗi ngày một lần, sau SKU Normal |
| Group UID thay đổi | Mỗi 1–3 giờ, dùng mốc đồng bộ thành công gần nhất và vùng chồng 30 phút |
| Group UID toàn bộ | Mỗi tuần và khi Admin yêu cầu để đối chiếu thiếu/thừa/sai lệch |
| Xác minh toàn bộ database | Mỗi đêm |
| Dọn file tạm | Sau khi xác minh thành công |

Windows Task Scheduler nên được cấu hình:

- Bật `PYTHONUTF8=1` trước khi chạy Python.
- Chạy lại sau 15 phút nếu thất bại, tối đa 3 lần.
- Dừng tác vụ nếu chạy quá 30 phút.
- Chạy bù khi máy bật lại nếu bỏ lỡ lịch.

## Báo cáo sau mỗi lần chạy

```text
outputs/auto-sync/YYYY-MM-DD/
├── summary.json
├── sku-changes.json
├── combo-changes.json
├── group-uid-changes.json
├── verification.json
└── sync.log
```

Báo cáo cần thể hiện:

- Số dòng nguồn và số dòng hợp lệ.
- Số dòng mới, cập nhật, không đổi và bị từ chối.
- Các trường dữ liệu đã thay đổi.
- Tổng số dòng trên Supabase sau đồng bộ.
- UID hoặc SKU bị thiếu, sai lệch.
- Thời gian bắt đầu, kết thúc và trạng thái cuối cùng.

## Thứ tự triển khai

1. Chuẩn hóa cơ chế lấy token và tự làm mới token của Inside/WMS.
2. Gộp các script hiện có vào `scripts/auto_sync_all.py`.
3. Bổ sung dry-run, ngưỡng an toàn, lock file và báo cáo.
4. Chạy thử thủ công với dữ liệu thật và đối chiếu Supabase.
5. Tạo lịch trong Windows Task Scheduler.
6. Theo dõi một tuần trước khi xem quy trình là hoàn toàn tự động.

Điều kiện quan trọng nhất là có cơ chế API/token ổn định cho Inside và WMS. Khi còn phụ thuộc vào tab Chrome, quy trình chỉ nên xem là bán tự động.

Thiết kế chi tiết hai chế độ đồng bộ Group UID và dashboard quản trị nằm tại
[`THIET_KE_DONG_BO_GROUP_UID_VA_DASHBOARD.md`](THIET_KE_DONG_BO_GROUP_UID_VA_DASHBOARD.md).
