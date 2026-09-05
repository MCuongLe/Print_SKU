# Quy tắc giao diện Slate Hasaki

## Phạm vi

Giao diện ứng dụng in tem SKU vẫn mở trực tiếp và giữ nguyên toàn bộ luồng nghiệp vụ hiện có. Phần thay đổi chỉ áp dụng cho bố cục, màu sắc và nhận diện thương hiệu.

## Object – Field – Value – Rule

| Object | Field | Field Value | Rule | Kết quả |
| --- | --- | --- | --- | --- |
| Nhận diện | Màu chủ đạo | `#005F41` | Dùng cho logo, nút chính và trạng thái nổi bật | Nhất quán thương hiệu Hasaki |
| Bố cục | Desktop | Hai cột từ 768 px | Form bên trái, danh sách chờ in bên phải | Giảm cuộn và tận dụng chiều ngang |
| Bố cục | Mobile | Một cột | Giữ nút và ô nhập dễ thao tác | Không tràn ngang ở 375 px trở lên |
| Header | Thông tin ứng dụng | Tên, logo và phiên bản | Luôn nhìn thấy ở đầu trang | Nhận diện rõ môi trường Production |

## Mức bằng chứng

- Giao diện và bố cục: N2 – kiểm tra trực tiếp trong trình duyệt cục bộ.
- Luồng nhập, danh sách và in: N3/N4 theo phản hồi ứng dụng và máy chủ hiện có.
- Các luồng máy in, camera và phân quyền không bị thay đổi bởi giao diện này.

## Quy tắc giao diện

- Ứng dụng không có màn hình đăng nhập; người dùng vào thẳng màn hình thao tác.
- Tên ứng dụng, logo và phiên bản phải nhìn thấy rõ ở header.
- Màu chủ đạo Hasaki `#005F41`, tương phản đủ rõ trên nền slate tối.
- Nút chính cao tối thiểu 48 px; form dùng được ở màn hình 375 px trở lên và hỗ trợ bàn phím.
- Không thay đổi dữ liệu, API, quyền in, camera, mã vạch hoặc cấu trúc tem.

## Khi nào xem lại

Xem lại các quy tắc này khi thay đổi cấu trúc form, danh sách chờ in, header, thanh hành động hoặc kích thước tem in.
