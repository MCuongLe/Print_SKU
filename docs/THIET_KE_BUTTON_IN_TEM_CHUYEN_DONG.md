# Hướng thiết kế button In tem chuyển động

> Phạm vi: nghiên cứu và thiết kế concept. **Đã ghép vào `index.html` ngày 03/10/2026 theo kiểu ĐƠN GIẢN theo yêu cầu**: bấm là nút đổi icon quay và hiện đường load chạy dưới nút, chạy tới khi lệnh in xong thì dừng (không có tem chạy vào máy in, đèn trạng thái, dấu kiểm hay trạng thái "gửi một phần"/"không chắc" như bản concept bên dưới). Chi tiết trong README mục "Nút In tem" và `RULES.md`; prototype: [print-button-prototype.html](./button-design/print-button-prototype.html).

## 1. Kết luận đề xuất

Nên thiết kế button theo ý tưởng **“tem chạy vào máy in”**, nhưng chuyển động chỉ xuất hiện sau khi người dùng nhấn và trong giai đoạn ứng dụng đang gửi lệnh. Khi hệ thống xác nhận đã nhận lệnh, button chuyển sang dấu kiểm cùng nội dung “Đã gửi … tem”.

Không nên duy trì animation cho đến khi máy in vật lý in xong. Ứng dụng hiện sử dụng hàng đợi; “đã gửi lệnh”, “đang chờ”, “đang in” và “đã in xong” là các trạng thái khác nhau. Nếu hình tem tiếp tục chạy trong nhiều giây hoặc nhiều phút, người dùng có thể hiểu nhầm lệnh chưa được nhận và bấm lại, dẫn đến in trùng.

## 2. Tệp thiết kế

- Bản xem nhanh PNG: [print-label-motion-button.png](./button-design/print-label-motion-button.png)
- Bản vector SVG: [print-label-motion-button.svg](./button-design/print-label-motion-button.svg)
- Prototype SVG có chuyển động: [print-label-motion-preview.svg](./button-design/print-label-motion-preview.svg)

Prototype SVG tự lặp để thuận tiện xem concept. Khi triển khai thật, animation chỉ được kích hoạt sau thao tác nhấn và phải kết thúc theo phản hồi của hàng đợi.

## 3. Hình thức button

### Kích thước

| Thuộc tính | Mobile | Desktop |
| --- | --- | --- |
| Chiều rộng | 100% vùng nội dung | tối thiểu 220 px |
| Chiều cao | 56–60 px | 52–56 px |
| Bo góc | 999 px dạng pill | 999 px dạng pill |
| Padding ngang | 20–24 px | 20–24 px |
| Icon/stage | 72 × 40 px | 72 × 40 px |
| Cỡ chữ | 16 px, đậm 750 | 15–16 px, đậm 750 |

Chiều cao tối thiểu 48 px được giữ theo quy chuẩn UI của dự án. WCAG 2.2 yêu cầu mục tiêu trỏ tối thiểu 24 × 24 CSS px trong trường hợp thông thường; kích thước đề xuất lớn hơn mức này để phù hợp thao tác kho bằng điện thoại.

### Màu sắc

| Trạng thái | Nền | Chữ/icon | Viền |
| --- | --- | --- | --- |
| Sẵn sàng | `#005F41` | trắng | không |
| Đang gửi | gradient `#087655` → `#005F41` | trắng | không |
| Đã nhận lệnh | `#EAF7F1` | `#075C40` | `#B9DECF` |
| Lỗi | trắng | `#9D342F` | `#C2413B` |
| Disabled | `#E8EFEC` | `#899A93` | không |

## 4. Storyboard trạng thái

### S0 — Sẵn sàng

- Icon máy in đứng yên.
- Nhãn chứa số lượng thật: “In 12 tem”.
- Không tự chạy animation để tránh gây phân tâm và không tạo cảm giác máy đang làm việc.

### S1 — Nhấn

- Button thu nhẹ xuống `scale(0.98)` trong 80–120 ms rồi trở lại.
- Khóa thao tác nhấn lặp ngay lập tức.
- Nhãn đổi thành “Đang gửi 12 tem…”.
- Giữ số lượng trong nhãn để người dùng kiểm tra lại tác vụ vừa thực hiện.

### S2 — Tem chạy vào máy in

- Ba tờ tem nhỏ xuất hiện bên trái máy in.
- Mỗi tờ lệch nhau 110–140 ms.
- Tem di chuyển theo trục ngang vào khe máy in, nhỏ dần và mờ dần.
- Máy in đứng yên; chỉ đèn trạng thái nhấp nhẹ một lần khi tem cuối cùng đi vào.
- Nếu phản hồi mạng lâu hơn 900 ms, chu kỳ có thể lặp chậm, nhưng tối đa một tem mỗi 650–750 ms.

### S3 — Đã nhận lệnh

- Dừng animation ngay khi server/hàng đợi xác nhận đã nhận lệnh.
- Chuyển sang nền xanh nhạt, dấu kiểm và dòng “Đã gửi 12 tem”.
- Có thể thêm dòng nhỏ “Lệnh đã vào hàng đợi”.
- Giữ trạng thái khoảng 700 ms, sau đó trở về trạng thái phù hợp với dữ liệu mới.

Đây là xác nhận **đã nhận lệnh**, không phải xác nhận đã in xong.

### S4 — Lỗi

- Dừng animation.
- Button chuyển sang nền trắng, viền đỏ và nội dung “Gửi lại lệnh in”.
- Có thể rung ngang một lần trong tối đa 160 ms; không rung liên tục.
- Lý do và cách xử lý hiển thị dưới button, ví dụ “Kiểm tra mạng rồi gửi lại”.
- Không thay toàn bộ lỗi bằng icon; luôn có nhãn chữ.

## 5. Cấu tạo hình minh họa

Nên dùng **inline SVG kết hợp CSS**, không dùng GIF, video hoặc ảnh tải từ CDN.

Máy in gồm các hình đơn giản:

- Thân máy dạng hình chữ nhật bo góc.
- Khay giấy phía trên.
- Khe nhận tem nằm ở cạnh trái hoặc giữa thân máy.
- Khay tem đầu ra phía dưới.
- Một chấm trạng thái nhỏ.

Mỗi tờ tem gồm:

- Hình chữ nhật trắng bo 3–4 px.
- Hai hoặc ba đường barcode màu xanh thương hiệu.
- Không cần chữ nhỏ vì sẽ không đọc được ở kích thước button.

SVG giúp hình sắc nét trên màn hình mật độ cao, dùng được trong file HTML độc lập và không thêm request mạng.

## 6. Motion specification

| Thành phần | Thuộc tính | Giá trị đề xuất |
| --- | --- | --- |
| Button khi nhấn | `transform` | `scale(1)` → `scale(0.98)` → `scale(1)` |
| Tờ tem | `translateX` | `-12px` → `31px` |
| Tờ tem | `scale` | `1` → `0.72` |
| Tờ tem | `opacity` | `1` → `0` tại khe máy in |
| Một chu kỳ | duration | 780–900 ms |
| Stagger | delay | 110–140 ms/tờ |
| Easing | curve | `cubic-bezier(.2,.8,.2,1)` |
| Thành công | duration | giữ 700 ms |
| Rung lỗi | duration | 120–160 ms, một lần |

Chỉ nên animate `transform` và `opacity`. Đây là hai nhóm thuộc tính trình duyệt thường có thể tối ưu ở giai đoạn compositing, tránh thay đổi `width`, `left`, `padding` hoặc các thuộc tính gây layout lại.

## 7. Quan hệ với trạng thái in hiện tại

Nên tách rõ hai khu vực:

### Trong button

- Sẵn sàng gửi.
- Đang gửi lên hàng đợi.
- Hàng đợi đã nhận.
- Gửi thất bại và cho phép gửi lại.

### Khu vực trạng thái bên dưới hoặc trên header

- Trước bạn còn bao nhiêu đợt.
- Máy in đang chạy đợt nào.
- Máy in đang mắc hoặc mất kết nối.
- Đã in xong hoặc in lỗi.

Không ép tất cả trạng thái dài vào button. Button chỉ giải thích thao tác do chính người dùng vừa thực hiện; khu vực status giải thích quá trình bất đồng bộ của máy in.

## 8. Khả năng tiếp cận

- Dùng phần tử `<button type="button">` thật, không dùng `div` giả button.
- Trong lúc gửi, khóa nhấn lặp bằng trạng thái `disabled` hoặc logic tương đương; nhãn vẫn phải đọc được.
- Cập nhật nội dung thông báo trong vùng `role="status"` hoặc `aria-live="polite"`, không tự chuyển focus.
- Dùng `aria-busy="true"` cho vùng tác vụ trong thời gian đang gửi, sau đó chuyển về `false`.
- Hỗ trợ bàn phím với Enter và Space theo hành vi button chuẩn.
- Focus ring tối thiểu 2 px, không bị cắt bởi `overflow: hidden` của vùng animation.
- Khi `prefers-reduced-motion: reduce`, bỏ chuyển động chạy ngang; dùng crossfade icon máy in → dấu ba chấm → dấu kiểm.
- Trạng thái thành công và lỗi luôn có chữ, không dựa duy nhất vào xanh/đỏ.

## 9. Hướng kỹ thuật khi triển khai sau này

### Cấu trúc trạng thái

Nên điều khiển component bằng một trạng thái hữu hạn thay vì dùng nhiều boolean rời rạc:

```text
idle → submitting → accepted → idle/disabled
                 ↘ failed → retrying
```

Các tên trạng thái đề xuất:

```text
idle | submitting | accepted | failed | disabled
```

Animation không được tự quyết định thời điểm thành công. Chỉ phản hồi API/hàng đợi mới được chuyển `submitting` sang `accepted` hoặc `failed`.

### Cấu trúc trực quan đề xuất

```text
button.print-motion-button
├── span.motion-stage [aria-hidden=true]
│   ├── svg.label-1
│   ├── svg.label-2
│   ├── svg.label-3
│   └── svg.printer
├── span.button-label
└── span.sr-only trạng thái bổ sung
```

Không cần thư viện animation mới. CSS keyframes và inline SVG đủ cho hiệu ứng này, phù hợp yêu cầu ứng dụng chạy độc lập và không thêm dependency/CDN.

## 10. Những hướng không nên dùng

- Không sao chép animation xe tải từ hình tham khảo vì ngữ nghĩa “giao hàng” không phù hợp hành động in tem.
- Không dùng GIF: khó đổi màu theo theme, không phản ứng đúng trạng thái và khó hỗ trợ reduced motion.
- Không cho animation tự chạy khi người dùng chưa bấm.
- Không dùng progress giả từ 0–100% nếu hệ thống không có tiến độ thật.
- Không đổi sang “Đã in xong” ngay sau khi API nhận lệnh.
- Không giữ animation vô hạn mà không có nhãn giải thích hoặc lối xử lý khi lỗi.
- Không thêm thư viện animation hoặc tài nguyên mạng chỉ cho một button.

## 11. Đối chiếu với project

Project hiện đã có các nền tảng phù hợp:

- Button chính đã có kích thước lớn và nội dung theo số tem.
- Luồng gửi lệnh đã có cờ đang gửi và ngăn thao tác trùng.
- Có trạng thái hàng đợi: chờ, đang in, xong và lỗi.
- CSS hiện có quy tắc tắt animation khi người dùng bật reduced motion.
- Ứng dụng đã dùng inline SVG/icon nên có thể giữ trang chạy độc lập.

Khi triển khai, chỉ nên thay phần trình bày bên trong button và ánh xạ vào trạng thái hiện có. Không cần thay đổi nghiệp vụ hàng đợi hoặc thêm thư viện ngoài.

## 12. Nguồn nghiên cứu

- [MDN — CSS animation](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/animation)
- [MDN — prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/%40media/prefers-reduced-motion)
- [web.dev — Animations and performance](https://web.dev/articles/animations-and-performance)
- [W3C WAI — Button Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
- [W3C WAI — Target Size Minimum](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum)
- [WAI-ARIA — status và aria-busy](https://www.w3.org/TR/wai-aria/states_and_properties)
- [Apple Human Interface Guidelines — Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)
- [Apple Human Interface Guidelines — Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators)
