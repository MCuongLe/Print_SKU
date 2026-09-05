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
