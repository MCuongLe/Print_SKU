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

## Đồng bộ lên Supabase

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
