# Gợi ý tối ưu giao diện TÌM SKU trên mobile

**Ngày đánh giá:** 30/09/2026\
**Phạm vi:** Màn `#find-sku` trong ứng dụng WH-MATERIAL\
**Trạng thái:** Tài liệu đề xuất, chưa chỉnh sửa hoặc build ứng dụng

## 1. Mục tiêu

Giúp nhân viên kho tìm đúng SKU, tính đúng số lượng và đưa tem vào hàng chờ in bằng một tay, trong môi trường thao tác nhanh bằng điện thoại. Luồng cần giữ tối đa ba bước:

1. Quét hoặc nhập mã trên tem.
2. Xác nhận SKU và số lượng.
3. Kiểm tra hàng chờ rồi in.

Các ưu tiên chính là giảm cuộn trang, giảm nhập bàn phím, đưa hành động chính vào vùng ngón tay cái và ngăn người dùng chuyển bước khi dữ liệu chưa hợp lệ.

## 2. Kết quả kiểm tra giao diện hiện tại

Đã kiểm tra trang local ở viewport **375 × 812 px**. Trang không tràn ngang; chiều cao nội dung bước quét là khoảng **878 px**, nên người dùng phải cuộn ngay cả khi camera chưa được bật.

| Mức | Quan sát hiện tại | Ảnh hưởng khi dùng mobile |
| --- | --- | --- |
| P0 | Ba tab có nhãn dài, mỗi tab chỉ khoảng 105 px và cỡ chữ nhỏ | Khó đọc nhanh; vùng bấm sát nhau; số bước nổi bật hơn nhiệm vụ |
| P0 | Ô nhập mã và nút `Tìm` xuất hiện trước camera | Thứ tự thị giác chưa đúng với luồng quét tem là thao tác chính |
| P0 | Đoạn hướng dẫn dài nằm giữa nút tìm và nút camera | Đẩy nút camera xuống dưới; người dùng phải đọc lại nội dung quen thuộc |
| P0 | Hành động chính không cố định ở đáy màn hình | Khi trang dài, người dùng phải cuộn để tiếp tục hoặc thêm vào chờ in |
| P0 | Có thể mở bước `Chờ in` khi danh sách rỗng; bước `Tính số lượng` không mở khi chưa chọn SKU nhưng chưa giải thích lý do | Trạng thái điều hướng thiếu nhất quán và dễ gây cảm giác nút không hoạt động |
| P1 | Nút `Bật camera`, `Chọn ảnh`, `Đọc lại tem` cùng xuất hiện trong một nhóm | Nhiều lựa chọn ngang cấp dù tần suất và điều kiện sử dụng khác nhau |
| P1 | Kết quả gợi ý hiển thị nhiều thông tin như phần trăm khớp và từ khóa khớp | Thẻ kết quả dài; phần trăm tạo cảm giác chính xác giả khi ảnh đọc chưa tốt |
| P1 | Phần tính từ cân chứa nhiều trường và lựa chọn trong một màn dài | Tải nhận thức cao; dễ nhầm đơn vị kg/g hoặc dùng nhầm thông số được nhớ từ lô trước |
| P1 | Danh sách chờ in có vùng cuộn riêng trong trang | Có nguy cơ tạo cuộn lồng nhau, khó thao tác bằng một tay |
| P2 | Trạng thái camera, AI, danh mục SKU và mạng chưa được gom thành thông báo thống nhất | Người dùng khó biết cần chờ, thử lại hay chuyển sang nhập tay |

## 3. Hướng giao diện đề xuất

### 3.1. Khung chung trên mobile

- Header cao khoảng 52–56 px: nút quay lại, tiêu đề ngắn `Tìm SKU`, biểu tượng hàng chờ kèm số lượng.
- Thanh bước cố định ở đáy màn hình, gồm ba nhãn ngắn: `Quét`, `Số lượng`, `Chờ in`.
- Chỉ bước hợp lệ mới cho phép bấm. Nếu bước bị khóa, chạm vào sẽ hiện lời giải thích ngắn, ví dụ `Hãy chọn một SKU trước`.
- Chừa `safe-area-inset-bottom` để nút không sát mép trên iPhone.
- Một màn hình chỉ có một hành động chính màu xanh. Các hành động phụ dùng nút viền hoặc liên kết chữ.
- Mọi vùng bấm chính cao tối thiểu 48 px, khoảng cách giữa hai vùng bấm tối thiểu 8 px.

```text
┌─────────────────────────────┐
│ ←  Tìm SKU           Chờ 2  │
├─────────────────────────────┤
│                             │
│       Nội dung bước         │
│                             │
├─────────────────────────────┤
│  Quét   Số lượng   Chờ in   │
└─────────────────────────────┘
```

Thanh bước dưới là điều hướng trạng thái, không thay thế nút hành động chính trong từng bước.

### 3.2. Bước 1 — Quét và nhận diện

Ưu tiên camera, sau đó mới đến ảnh có sẵn và nhập mã thủ công.

```text
┌─────────────────────────────┐
│ Đưa mã hoặc tên SP vào khung│
│ ┌─────────────────────────┐ │
│ │                         │ │
│ │       KHUNG CAMERA      │ │
│ │                         │ │
│ └─────────────────────────┘ │
│ Giữ yên — đang lấy nét...   │
│                             │
│ [       Bật camera       ]  │
│  Chọn ảnh       Gõ mã tay   │
└─────────────────────────────┘
```

Đề xuất chi tiết:

- Khi camera chưa bật, dùng khung minh họa gọn và nút `Bật camera` làm hành động chính.
- Sau khi camera bật, khung camera nên chiếm phần lớn chiều cao khả dụng. Đặt trạng thái lấy nét/đọc mã ngay trên khung.
- Thu phóng, đèn pin và chụp thủ công là biểu tượng tối thiểu 44 × 44 px nằm sát cạnh dưới của camera.
- `Chọn ảnh` và `Gõ mã tay` là hai hành động phụ. Khi chọn `Gõ mã tay`, mở một bottom sheet có ô nhập và bàn phím phù hợp.
- Nội dung hướng dẫn dài đổi thành một câu trạng thái theo ngữ cảnh. Hướng dẫn đầy đủ đặt sau liên kết `Cách quét tem`.
- `Đọc lại tem` chỉ xuất hiện sau khi đã có ảnh hoặc dữ liệu OCR.
- `Chữ đọc được trên tem` và `Tải lại danh mục` chuyển vào mục `Chi tiết xử lý`; không hiển thị trong luồng thường ngày.

### 3.3. Kết quả nhận diện SKU

Chỉ hiển thị tối đa ba kết quả. Mỗi thẻ ưu tiên thông tin theo thứ tự:

1. Mã SKU.
2. Tên sản phẩm, tối đa hai dòng.
3. Nhãn trạng thái: `Khớp chính xác`, `Khả năng cao`, `Cần kiểm tra`, `SKU ngừng dùng` hoặc `SKU Combo`.
4. Nút `Chọn SKU này`.

Không dùng phần trăm làm thông tin chính. Nếu cần phục vụ kiểm tra kỹ thuật, đặt tỷ lệ và từ khóa khớp trong phần `Xem lý do gợi ý`.

| Trạng thái | Cách xử lý đề xuất |
| --- | --- |
| Khớp chính xác mã | Làm nổi bật kết quả đầu; vẫn yêu cầu một lần chạm xác nhận |
| Khả năng cao | Hiện tối đa ba thẻ để người dùng chọn |
| Độ tin cậy thấp | Cảnh báo màu vàng; đề nghị chụp lại hoặc nhập mã |
| Không có kết quả | Giữ ảnh/OCR hiện tại; cho phép sửa mã, chụp lại hoặc chọn ảnh khác |
| SKU ngừng dùng | Không cho tiếp tục; giải thích ngắn và đề nghị chọn SKU khác |
| SKU Combo | Hiện quan hệ Combo → Normal và cho chọn SKU Normal trước khi sang bước số lượng |

Sau khi chọn, hiển thị toast `Đã chọn SKU …` rồi tự chuyển sang bước `Số lượng`.

### 3.4. Bước 2 — Tính số lượng

Phần đầu luôn hiển thị thẻ SKU đã chọn dạng gọn: mã, tên sản phẩm và nút `Đổi SKU`. Không lặp lại toàn bộ dữ liệu nhận diện.

Tách hai cách nhập thành lựa chọn đầu tiên:

- `Nhập số lượng trực tiếp`.
- `Tính từ cân`.

Với `Tính từ cân`, trình bày thành ba nhóm tuần tự:

1. **Thông số cuộn:** định mức cuộn đầy, trọng lượng lõi, đơn vị.
2. **Khối lượng trả về:** tổng cân và số cuộn/lõi còn lại.
3. **Kết quả:** số lượng quy đổi, công thức tóm tắt và cảnh báo nếu dữ liệu bất thường.

Các giá trị được nhớ từ lần trước phải có nhãn `Đã nhớ từ lô trước`, kèm nút sửa. Đơn vị kg/g phải nằm cạnh ô nhập và không được tự thay đổi ngầm. Nếu kết quả âm, bằng 0, vượt giới hạn hoặc thiếu thông số, khóa nút tiếp tục và chỉ rõ trường cần sửa.

Nút chính `Thêm vào chờ in` cố định phía trên thanh bước dưới. Trước khi thêm, hiển thị một dòng xác nhận:

```text
SKU 422510744 · 1.200 m/tem · 3 tem = 3.600 m
```

### 3.5. Bước 3 — Chờ in

- Hàng chờ hiển thị dạng danh sách toàn trang, không dùng vùng cuộn lồng nhau.
- Mỗi dòng gồm checkbox, SKU, số lượng/tem, số tem và trạng thái máy in.
- Chạm cả dòng để chọn; checkbox tối thiểu 44 × 44 px.
- Thanh hành động cố định ở đáy hiển thị `Đã chọn X SKU · Y tem` và nút `In tem`.
- Khi hàng chờ rỗng, nút `Quét tem` là hành động chính; không cần hiển thị nút chọn tất cả bị vô hiệu hóa.
- Trước khi gửi in, mở bottom sheet xác nhận tổng SKU, tổng số tem và máy in đang nhận lệnh.
- Sau khi gửi, từng dòng có trạng thái rõ ràng: `Đang gửi`, `Đã nhận`, `Đã in`, `Lỗi — thử lại`.

## 4. Định hướng giao diện chuyên nghiệp

### 4.1. Phong cách tổng thể

Giao diện nên theo hướng **công cụ vận hành hiện đại, rõ ràng và ít trang trí**. Nền ứng dụng dùng xám rất nhạt; nội dung chính nằm trên các bề mặt trắng; màu xanh thương hiệu chỉ dùng cho hành động chính, trạng thái đã chọn và kết quả thành công.

Tránh dùng quá nhiều khung viền, gradient hoặc bóng đậm. Mỗi màn nên tạo ba lớp thị giác rõ ràng:

1. **Header:** người dùng đang ở đâu và hàng chờ có bao nhiêu tem.
2. **Nội dung:** dữ liệu cần đọc hoặc nhập ở bước hiện tại.
3. **Vùng hành động:** nút tiếp tục cố định gần ngón tay cái.

### 4.2. Bộ quy chuẩn hình ảnh đề xuất

| Thành phần | Quy chuẩn đề xuất |
| --- | --- |
| Nền ứng dụng | `#F5F7F6`, tạo độ tách nhẹ với thẻ trắng |
| Bề mặt/thẻ | Trắng `#FFFFFF`, viền `#E2E8E5` |
| Xanh chính | `#006B4F` hoặc giữ đúng màu thương hiệu hiện tại |
| Xanh nhạt | `#E8F4F0`, dùng cho lựa chọn và trạng thái thành công |
| Chữ chính | `#17211D`, không dùng màu đen tuyệt đối |
| Chữ phụ | `#66736D`, đảm bảo tương phản dễ đọc ngoài kho |
| Cảnh báo | Nền vàng nhạt, chữ nâu đậm; luôn có biểu tượng và nội dung chữ |
| Lỗi | Nền đỏ nhạt, chữ đỏ đậm; không chỉ đổi màu đường viền |
| Font | Giữ font hệ thống để tải nhanh; nội dung 15–16 px, tiêu đề 20–22 px |
| Bo góc | Thẻ 16 px, ô nhập/nút 12 px, bottom sheet 24 px ở hai góc trên |
| Khoảng cách | Dùng hệ 4 px; khoảng phổ biến 8, 12, 16, 24 px |
| Bóng đổ | Chỉ dùng bóng nhẹ cho header, thanh hành động và bottom sheet |
| Biểu tượng | Một kiểu nét, kích thước 20–24 px, luôn kèm nhãn nếu ý nghĩa chưa rõ |

Màu trên chỉ là định hướng. Khi triển khai cần ưu tiên token màu thương hiệu đang có và kiểm tra tương phản WCAG AA.

### 4.3. Header và điều hướng

Header mobile nên gọn, cân đối và giữ cố định khi cuộn:

```text
┌────────────────────────────────┐
│  ‹   Tìm SKU          🖨 Chờ 2 │
└────────────────────────────────┘
```

- Nút quay lại là icon trong vùng bấm 44 × 44 px, không lặp chữ `WH-MATERIAL` trên màn nhỏ.
- Tiêu đề căn trái và có độ đậm vừa; không dùng toàn bộ chữ hoa.
- Hàng chờ là một nút dạng pill gọn, badge số lượng có độ tương phản cao.
- Header nền trắng, viền dưới mảnh hoặc bóng rất nhẹ; không chiếm quá 56 px chiều cao.

Thanh bước ở đáy dùng icon và nhãn ngắn. Bước hiện tại có nền xanh nhạt hoặc indicator; bước hoàn tất có dấu kiểm; bước chưa sẵn sàng dùng màu trung tính nhưng vẫn đọc được.

```text
┌────────────────────────────────┐
│  ◉ Quét      ② Số lượng    ③ Chờ in │
└────────────────────────────────┘
```

Không dùng ba nút pill rời có câu chữ dài như hiện tại. Thanh bước nên tạo cảm giác đây là một quy trình liên tục.

### 4.4. Khu vực camera

Camera là điểm nhấn thị giác của bước quét:

- Dùng khung bo góc 16 px, nền xám đậm để ảnh tem dễ nổi bật.
- Vùng định vị tem dùng bốn góc trắng hoặc xanh; tránh viền chữ nhật kín gây rối ảnh.
- Trạng thái `Đang lấy nét`, `Đã thấy mã`, `Giữ yên` hiển thị dạng chip ở đáy khung camera.
- Các nút đèn pin, thu phóng và chụp tay nằm trên camera với nền tối trong suốt, bảo đảm tương phản.
- Khi nhận diện thành công, viền khung chuyển xanh trong thời gian ngắn và rung nhẹ nếu thiết bị cho phép.
- Khi camera chưa bật, dùng minh họa camera đơn sắc và một nút xanh `Bật camera`; không để một vùng đen trống.

### 4.5. Thẻ kết quả SKU

Thẻ kết quả cần dễ so sánh bằng mắt và không giống một bảng dữ liệu thu nhỏ.

```text
┌────────────────────────────────┐
│ KHỚP CHÍNH XÁC                 │
│ 422510744                       │
│ Vải single jersey 2c/HP SV18…  │
│ Thời Trang (NVL)               │
│                                │
│              [ Chọn SKU này ]  │
└────────────────────────────────┘
```

- Mã SKU là nội dung lớn nhất trong thẻ, dùng kiểu chữ tabular number nếu có.
- Tên sản phẩm tối đa hai dòng; phần còn lại mở bằng `Xem thêm`.
- Category là metadata một dòng, màu chữ phụ.
- Nhãn `Khớp chính xác`, `Khả năng cao`, `SKU Combo` hoặc `Ngừng dùng` nằm ở đầu thẻ.
- Kết quả được đề xuất cao nhất có viền xanh và nhãn `Gợi ý phù hợp nhất`; không dùng bóng đậm.
- Toàn bộ thẻ có thể bấm, nhưng vẫn giữ nút rõ ràng để người dùng hiểu hành động.
- Khi chọn SKU Combo, mở bottom sheet chọn SKU Normal thay vì popup nhỏ hoặc hộp thoại sát mép màn hình.

### 4.6. Bottom sheet chọn SKU Normal

Bottom sheet phù hợp hơn modal giữa màn hình trên mobile vì gần vùng thao tác ngón tay và dùng tốt với danh sách dài.

```text
┌────────────────────────────────┐
│             ───                │
│ Chọn SKU Normal                │
│ Combo 422510742                │
│                                │
│ ○ 422510744                    │
│   Vải single jersey 2c/HP…     │
│   1 Combo = 1.000 đơn vị       │
│                                │
│ [      Xác nhận SKU       ]    │
│          Giữ SKU Combo         │
└────────────────────────────────┘
```

- Chiều cao tối đa khoảng 85% viewport, bo hai góc trên 24 px.
- Có thanh kéo, tiêu đề cố định và danh sách cuộn độc lập bên trong sheet.
- SKU Normal hiển thị dạng radio card với mã, tên và tỷ lệ quy đổi.
- Nút `Xác nhận SKU` cố định ở đáy sheet; chỉ bật sau khi có lựa chọn.
- `Giữ SKU Combo` là hành động phụ bằng chữ và cần diễn đạt rõ hậu quả.
- Khi chỉ có một SKU Normal, chọn sẵn nhưng vẫn yêu cầu người dùng xác nhận.

### 4.7. Ô nhập và phần tính số lượng

- Label luôn nằm phía trên ô nhập, không chỉ dùng placeholder.
- Số và đơn vị đặt trong cùng một component; đơn vị nằm bên phải, không làm người dùng nhập lại.
- Các nút chọn kg/g, cách cân và định mức cuộn dùng segmented control tối đa hai hoặc ba lựa chọn.
- Trường đang focus có viền xanh 2 px; trường lỗi có thông báo ngay dưới, không dùng toast cho lỗi nhập liệu.
- Các giá trị nhớ từ lần trước có chip `Đã nhớ`; chạm vào chip để xem nguồn hoặc đặt lại.
- Kết quả quy đổi nằm trong một summary card nền xanh nhạt, con số lớn và công thức nhỏ hơn bên dưới.

```text
┌────────────────────────────────┐
│ Kết quả quy đổi                │
│ 3.600 m                        │
│ 1.200 m/tem × 3 tem            │
└────────────────────────────────┘
```

### 4.8. Nút và phản hồi tương tác

| Loại | Cách dùng |
| --- | --- |
| Primary | Nền xanh, chữ trắng; mỗi màn chỉ có một primary |
| Secondary | Nền trắng, viền xám/xanh; dùng cho chọn ảnh hoặc thử lại |
| Tertiary | Chỉ chữ và icon; dùng cho xem chi tiết hoặc đổi SKU |
| Destructive | Chữ/viền đỏ; chỉ dùng khi bỏ dữ liệu hoặc xóa hàng chờ |
| Disabled | Nền xám nhạt nhưng chữ vẫn đủ tương phản; kèm lý do khi người dùng chạm |

Khi bấm nút, cần có trạng thái nhấn tức thời. Với thao tác đang xử lý, thay nội dung nút bằng spinner và động từ cụ thể như `Đang đọc tem…` hoặc `Đang gửi in…`; không để người dùng bấm lặp.

Animation chỉ nên kéo dài khoảng 150–250 ms. Tôn trọng thiết lập `prefers-reduced-motion` và không dùng chuyển động cho dữ liệu quan trọng.

### 4.9. Khoảng trống và mật độ thông tin

- Lề ngang mobile 16 px; thiết bị rất hẹp có thể dùng 12–14 px.
- Khoảng cách giữa hai khối nội dung chính 16–24 px.
- Padding trong thẻ 16 px.
- Không đặt văn bản hướng dẫn dài trong thẻ chính. Dùng một câu ngắn, sau đó là `Xem hướng dẫn`.
- Không hiển thị đồng thời camera, form nhập tay, OCR chi tiết và kết quả. Mỗi trạng thái chỉ hiện phần người dùng cần lúc đó.
- Empty state dùng một icon đơn sắc, một câu giải thích và một hành động; không để các nút disabled chiếm diện tích.

### 4.10. Hình ảnh tổng thể mong muốn

Màn sau khi cập nhật nên tạo cảm giác:

- **Gọn:** người dùng nhìn thấy ngay việc cần làm tiếp theo.
- **Chắc chắn:** SKU, đơn vị và số lượng được nhấn mạnh; trạng thái lỗi nói rõ cách sửa.
- **Nhất quán:** cùng một kiểu card, nút, badge và bottom sheet trong cả ba bước.
- **Nhanh:** ít chữ, ít thao tác bàn phím, hành động chính luôn trong tầm tay.
- **Phù hợp vận hành:** chữ đủ lớn, tương phản tốt và dùng được khi cầm máy bằng một tay.

## 5. Trạng thái bắt buộc cần thiết kế

| Tình huống | Thông báo cho người dùng | Hành động chính |
| --- | --- | --- |
| Camera chưa được cấp quyền | `Cần quyền camera để quét tem` | `Cho phép camera` |
| Người dùng từ chối camera | `Không mở được camera` | `Gõ mã tay` |
| Thiết bị không có camera | `Thiết bị này không hỗ trợ camera` | `Chọn ảnh` |
| Ảnh rung hoặc thiếu sáng | `Ảnh chưa rõ — giữ máy ổn định` | Tự thử lại; cho phép chụp tay |
| Đang đọc tem | `Đang nhận diện…` kèm tiến trình | Cho phép hủy |
| AI hoặc mạng lỗi | `Chưa đọc được tem` | `Thử lại` và `Gõ mã tay` |
| Danh mục SKU đang tải | `Đang cập nhật danh mục SKU…` | Chờ; không gửi tìm kiếm lặp |
| Không có SKU phù hợp | `Không tìm thấy SKU phù hợp` | `Sửa mã` |
| SKU Combo | `Chọn SKU Normal cần in` | `Chọn SKU Normal` |
| Dữ liệu tính chưa đủ | Nêu chính xác trường còn thiếu | Cuộn/focus đến trường lỗi |
| Máy in không sẵn sàng | `Máy in đang bận hoặc mất kết nối` | `Thử lại` |

Thông báo lỗi phải nói người dùng cần làm gì tiếp theo; không hiển thị mã lỗi kỹ thuật trong luồng chính.

## 6. Thứ tự triển khai đề xuất

### P0 — Tác động lớn, nên làm trước

1. Rút gọn điều hướng ba bước và cố định ở đáy trên mobile.
2. Đưa camera thành điểm bắt đầu; chuyển nhập mã và chọn ảnh thành phương án phụ.
3. Thêm nút hành động chính cố định theo từng bước.
4. Điều khiển việc mở bước bằng trạng thái luồng: có SKU mới vào được `Số lượng`; có hàng chờ mới kích hoạt thao tác in.
5. Rút gọn header và nội dung hướng dẫn trong màn đầu.

### P1 — Giảm sai sót vận hành

1. Rút gọn thẻ kết quả; thay phần trăm bằng mức tin cậy dễ hiểu.
2. Chia bộ tính từ cân thành ba nhóm tuần tự và đánh dấu dữ liệu được nhớ.
3. Thêm thanh tổng kết cố định cho hàng chờ và bottom sheet xác nhận in.
4. Bổ sung đầy đủ trạng thái camera, OCR, danh mục, Combo → Normal và máy in.
5. Bỏ cuộn lồng nhau trong danh sách kết quả và hàng chờ.

### P2 — Cải thiện tốc độ cho người dùng thường xuyên

1. Khôi phục lần thao tác chưa hoàn tất sau khi tải lại trang, kèm nút bỏ dữ liệu cũ.
2. Hiển thị thời điểm cập nhật danh mục SKU gần nhất và trạng thái offline.
3. Cho phép rung/âm báo nhẹ khi nhận diện thành công hoặc gửi in lỗi, nếu thiết bị cho phép.
4. Lưu lịch sử ngắn các SKU vừa quét trên chính thiết bị.
5. Thu thập số liệu ẩn danh ở mức thao tác: thời gian tìm, tỷ lệ chụp lại, tỷ lệ chọn kết quả đầu; chỉ triển khai khi được phê duyệt.

## 7. Ánh xạ với giao diện hiện tại

| Thành phần hiện tại | Hướng điều chỉnh |
| --- | --- |
| `fsk-tab-scan`, `fsk-tab-calc`, `fsk-tab-print` | Đổi thành thanh bước ngắn ở đáy; giữ badge hàng chờ |
| `fsk-code-form` | Chuyển vào bottom sheet `Gõ mã tay` |
| `fsk-cam` | Hành động chính ở trạng thái camera chưa bật |
| `fsk-results` | Danh sách tối đa ba thẻ gọn; toàn trang, không cuộn lồng |
| `fsk-more` | Đổi tên `Chi tiết xử lý`; chứa OCR và công cụ phục hồi |
| `fsk-cd-toggle` | Hai chế độ rõ ràng: nhập trực tiếp hoặc tính từ cân |
| `fsk-add` | Nút cố định đáy, chỉ bật sau khi kết quả hợp lệ |
| `fsk-print` | Nút cố định đáy kèm tổng SKU/tem đã chọn |

## 8. Tiêu chí nghiệm thu mobile

### Bố cục và thao tác

- Kiểm tra tối thiểu ở chiều rộng 360, 375, 390 và 430 px.
- Không tràn ngang và không có vùng cuộn lồng trong luồng chính.
- Nội dung thiết yếu và hành động chính nằm trong tầm ngón tay cái.
- Vùng bấm chính tối thiểu 48 px; icon đơn lẻ tối thiểu 44 px.
- Bàn phím mở không che ô đang nhập hoặc nút tiếp tục.
- Nút cố định đáy không che nội dung cuối danh sách và tôn trọng safe area.

### Luồng nghiệp vụ

- Có thể hoàn tất luồng quét → chọn SKU → nhập số lượng → thêm hàng chờ bằng tối đa ba màn chính.
- Không thể tính số lượng khi chưa chọn SKU hợp lệ.
- Không thể thêm vào hàng chờ khi số lượng hoặc số tem không hợp lệ.
- SKU Combo luôn yêu cầu chọn SKU Normal tương ứng trước khi in.
- Hàng chờ và bước đang làm được khôi phục hợp lý sau khi tải lại, nhưng không đưa người dùng vào bước mất dữ liệu phụ thuộc.
- Mỗi lệnh in có xác nhận tổng SKU, tổng tem và trạng thái máy in.

### Khả năng tiếp cận và phản hồi

- Tương phản chữ/nền đạt WCAG AA cho nội dung thường.
- Màu sắc không phải tín hiệu duy nhất; trạng thái luôn có chữ hoặc biểu tượng.
- Focus bàn phím rõ ràng và thứ tự focus theo đúng trình tự nghiệp vụ.
- Trạng thái tải, thành công và lỗi được thông báo bằng vùng `aria-live` phù hợp.
- Camera có luồng dự phòng: chọn ảnh và nhập mã tay.

## 9. Phạm vi không thực hiện trong tài liệu này

- Không sửa `index.html`.
- Không thay đổi dữ liệu SKU, Supabase, camera, OCR hoặc agent in.
- Không thêm thư viện, API hay tài nguyên ngoài.
- Không build, deploy, commit hoặc push mã nguồn.

Khi triển khai, nên làm P0 trước trên nhánh riêng và kiểm tra bằng dữ liệu SKU giả lập. Sau đó mới mở rộng phần tính từ cân và trạng thái in để tránh tạo một thay đổi lớn trong bundle HTML hiện tại.
