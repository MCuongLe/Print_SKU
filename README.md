# Print SKU

Ứng dụng in tem SKU chạy trực tiếp từ `index.html`.

## Database SKU

Xuất danh sách sản phẩm từ Mastige Inside bằng menu **Download → File**, sau đó nhập file XLSX vào SQLite:

```powershell
python scripts/import_sku_xlsx.py "C:\path\to\hasaki-product-all-sku-cate.xlsx"
```

Database được tạo tại `data/sku.db`. Mỗi lần chạy, bảng `products` được thay bằng dữ liệu từ bản xuất mới nhất. Bảng `column_map` lưu ánh xạ tên cột Excel sang tên cột SQLite và `import_runs` lưu lịch sử nhập.

Để bổ sung một category đã lọc trên Mastige mà không ghi đè dữ liệu hiện có, tải bằng **Download → Category** rồi chạy:

```powershell
python scripts/merge_sku_category_xlsx.py "C:\path\to\product-list.xlsx" `
  --category-id 957 `
  --category-name "Thời Trang (NVL)" `
  --backup data/sku.before-merge.db
```

Lệnh ghép dùng SKU làm khóa, bỏ qua SKU trùng và lưu category đang chọn trên Mastige vào `category_id`/`category_name`.

Ví dụ tra cứu:

```sql
SELECT * FROM products WHERE sku = '100000001';
```

File database chứa dữ liệu nội bộ và được loại khỏi Git theo mặc định.

## Agent máy trạm

Source agent Windows độc lập dành cho ứng dụng này nằm trong [`workstation-agent`](workstation-agent/README.md). Agent mới có template riêng cho tem SKU và Group UID, không đọc hay sửa thư mục AuditFactory.

Agent hỗ trợ preview PNG, dựng TSPL không in, kiểm tra dữ liệu, kiểm tra máy in và hàng đợi Supabase có lease. Web chuyển các lệnh SKU sang queue mới và có màn hình `#group-uid`; SKU trong tem Group UID là tùy chọn, tên sản phẩm có thể tra tự động từ Supabase hoặc nhập thủ công.

## Màn Sample — gom hàng mẫu vào bao

Màn `#sample` quét mã QR SKU trên hàng mẫu, gom các mẫu cùng SKU vào một bao và báo SKU inactive.

Trước khi dùng, nạp schema một lần:

```powershell
python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql
python scripts/apply_supabase_sql.py supabase/sample_bag_v2_lock_delete.sql
```

Hoặc dán tay nội dung `supabase/sample_bag_v1.sql` vào Supabase SQL Editor nếu không muốn dùng token.

File này tạo bảng `public.sample_bags` (`bag_no`, `sku`, `quantity`) cùng bốn RPC `sample_scan`, `sample_list`, `sample_decrement`, `sample_delete`. Bảng bật RLS và không cho `anon` đọc/ghi trực tiếp — web chỉ gọi RPC, giống hàng đợi in. Chưa chạy file này thì màn Sample báo `Không đọc được danh sách bao`.

Số bao chạy từ 1 trên một danh sách duy nhất, không reset theo ngày hay theo đợt. Nút `Xuất Excel theo dõi` tạo file `.xlsx` ngay trên trình duyệt, không cần thư viện ngoài.

## Nạp schema lên Supabase

`scripts/apply_supabase_sql.py` chạy một file `.sql` lên project qua Management API — không cần `psql`, không cần Supabase CLI, chỉ dùng thư viện chuẩn của Python.

Một lần duy nhất: tạo **personal access token** ở https://supabase.com/dashboard/account/tokens (bắt đầu bằng `sbp_`), rồi đặt vào biến môi trường `SUPABASE_ACCESS_TOKEN` hoặc vào file `.env` ở gốc repo (`.env` đã nằm trong `.gitignore`).

```
SUPABASE_ACCESS_TOKEN=sbp_...
```

Token này khác publishable key và secret key: hai key kia chỉ tới được PostgREST nên không chạy được `create table`. Script không bao giờ in token ra màn hình.

```powershell
python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql --dry-run   # xem trước, không gọi Supabase
python scripts/apply_supabase_sql.py supabase/sample_bag_v1.sql             # chạy thật
```

Project ref lấy tự động từ `SUPABASE_URL`, ghi đè bằng `--project-ref`. Chạy xong script liệt kê lại toàn bộ bảng và hàm trong schema `public` để đối chiếu.

**Cầu dao:** file chứa `DROP`, `TRUNCATE` hay `DELETE FROM` ở cấp cao nhất bị chặn, phải thêm `--allow-destructive` mới chạy. Câu lệnh nằm trong thân hàm `$$ ... $$` không tính — đó là định nghĩa chứ không phải lệnh chạy, và nếu chặn cả hai thì ai cũng gõ `--allow-destructive` theo phản xạ, lúc đó cầu dao hết tác dụng.

## Database Group UID

`public.group_uid_details` lưu 10 trường: `group_uid_code`, `batch_code`,
`roll_code`, `warehouse`, `location`, `sku`, `qty`, `updated_by`,
`updated_date`, `status`. Khóa chính là Group UID Code; mã lưu dạng text để giữ
số 0 đầu. `qty` lấy từ Qty (không phải SKU Qty). Tên sản phẩm được tra qua
`SKU_Name.product_name` bằng SKU, không lưu lại trong bảng Group UID. SKU, vị trí
và người cập nhật có thể trống. Không ràng buộc SKU vào danh mục Active vì file
WMS có thể chứa SKU ngoài danh mục đó.

Tạo bảng một lần trên project hiện tại:

```powershell
python scripts/apply_supabase_sql.py supabase/group_uid_v1.sql
python scripts/apply_supabase_sql.py supabase/group_uid_v2_lookup.sql
python scripts/apply_supabase_sql.py supabase/group_uid_v3_drop_product.sql --allow-destructive
```

Kiểm tra rồi nhập file export (chỉ cần Python standard library):

```powershell
python scripts/import_group_uid_xlsx.py "C:\path\to\GROUP_UID_DETAIL.xlsx"
python scripts/import_group_uid_xlsx.py "C:\path\to\GROUP_UID_DETAIL.xlsx" --apply
```

Lệnh nhập dùng `SUPABASE_URL` và personal access token giống script nạp schema.
Toàn bộ file được kiểm tra trước khi gửi và upsert theo lô 500 dòng để nằm trong
giới hạn Management API; mỗi lô là một giao dịch nguyên tử. Nếu gián đoạn, các lô
đã xong vẫn được giữ; chạy lại cùng file để hoàn tất mà không tạo dòng trùng.
Mã trùng trong file, số lượng âm/không hợp lệ hoặc ngày thiếu/sai sẽ bị từ chối.
File cũ không ghi đè bản ghi có Updated Date mới hơn; mã không có trong file
không bị xóa. Ngày không có múi giờ được hiểu là UTC+07:00. Updated By và
Updated Date giữ thông tin WMS, không tự đổi thành người/giờ nhập Supabase.
Status giữ nguyên văn bản WMS để tiếp nhận trạng thái mới.

Bảng bật RLS; chưa mở quyền đọc/ghi cho `anon` hoặc `authenticated`.
Quản trị truy cập bằng SQL Editor/Management API hoặc backend `service_role`.
Không lưu file dữ liệu thật vào Git.

Màn `#group-uid` tự gọi RPC `group_uid_lookup` khi thêm mã hoặc import Excel,
chuyển UID đủ tên sản phẩm sang Sẵn sàng in. Tên lấy từ `SKU_Name`;
Batch Code → Lot, Roll Code → Roll. Mỗi UID vẫn in
một tem, không lấy Qty tồn kho làm số bản in. Thiếu tên/chưa có mã/lỗi mạng thì
chuyển về chờ gán thủ công; SKU, lot và roll đã tra được vẫn giữ khi bổ sung tên.

RPC được định nghĩa trong `supabase/group_uid_v2_lookup.sql`, chỉ trả thông tin
tem theo danh sách tối đa 100 mã chính xác, không trả người cập nhật hoặc vị trí kho.
Migration v2 đã triển khai sau khi chủ ứng dụng xác nhận quyền tra cứu thông tin
tem cho người không đăng nhập (`anon`). Bảng vẫn không mở quyền đọc/ghi trực tiếp.
Migration v3 xóa cột `product` và sửa RPC để chỉ dùng tên từ `SKU_Name`.
Các UID có SKU chưa có tên trong `SKU_Name` sẽ chờ gán tên thủ công.
Đã kiểm tra frontend với RPC thật: UID có dữ liệu tự chuyển sang Sẵn sàng in,
đủ SKU, tên sản phẩm, lot và roll. Frontend báo lỗi và cho gán tay nếu RPC không truy cập được.

## Đồng bộ danh mục SKU lên Supabase

Đặt `SUPABASE_URL` và `SUPABASE_SECRET_KEY` trong biến môi trường của máy chạy đồng bộ. Không lưu secret key trong source code hoặc Git.

Kiểm tra dữ liệu local mà không gọi Supabase:

```powershell
python scripts/sync_sku_to_supabase.py --database data/sku.db --dry-run
```

Upsert các SKU Active lên bảng `SKU_Name`:

```powershell
python scripts/sync_sku_to_supabase.py --database data/sku.db
```

Đồng bộ chỉ thêm mới hoặc cập nhật theo khóa `sku`; script không tự xóa bản ghi trên Supabase.
