# Quy trình test theo phạm vi (2026-11-05)

Trạng thái (05/11/2026 09:20): **ĐÃ DUYỆT, ĐÃ SỬA LUẬT** — người dùng "Duyệt, sửa luật" theo cả 3 khuyến nghị (3 test chuẩn ở bậc 1; lưới an toàn nền sau push bậc 2; ngưỡng 8 test). Bốn tệp luật sửa cùng commit này; nhật ký `RULES.md` [N20261105-0915].

## Thiết kế

- **Yêu cầu (05/11/2026):** "viết lại quy trình test để cải thiện tốc độ nhưng vẫn đảm bảo chất lượng; việc cần test chỗ nào sẽ do Fable hoặc Opus quyết định."
- **Thay gì:** bản chốt sáng 05/11 (`5ce360f`, N20261105-0800): "sửa chỗ nào test chỗ đó, cả bộ chỉ khi người dùng bảo, đạt thì tự commit + push". Bản đó bỏ cả bộ nhưng chưa nói ai quyết phạm vi, tối thiểu phải chạy gì, và lưới an toàn ở đâu.
- **Số đo thật (`outputs/test-times.json`, 146 test, 05/11/2026):**
  - Tổng thời gian từng test cộng lại 1.830 s; cả bộ `--jobs 4` 385–527 s khi máy rảnh, 1.748 s khi máy bận (cây tạm 05/11 sáng).
  - 86 test ≤ 10 s (SQL tĩnh, Node, Python); 54 test 10–60 s; 6 test > 60 s (`a11y_axe` 105, `vendor_return` 104, `scan_field_standard` 85, `xa_vai_a4` 75, `floor_access` 70, `admin_web_sync` 64).
  - Bộ chuẩn giao diện: `design_tokens_ratchet` 0 s, `icon_standard` 37, `ui_standard` 36, `typography` 32, `app_nav` 19, `mobile_home` 13, `a11y_axe` 105 → 240 s cộng dồn, ~2 phút với 4 tiến trình.
  - Ví dụ một màn: Xả vải = `xa_vai_a4_sql` 0 + `xa_vai_printed_delete_sql` 0 + `xa_vai_printed_delete_browser` 12 + `xa_vai_a4_browser` 75 → ~1,5 phút.
  - Bằng chứng chất lượng cần giữ: 04/11 `design_tokens_ratchet` bắt màu mới thêm ở màn Lệnh in (màu 430 > trần 429); lỗi CSS `1a6defe` (tab Quét hiện luôn Chờ in) không bị test của tab đang sửa bắt; 6 test chập chờn khi máy bận ở lượt cả bộ 05/11.
- **Kết quả nhìn thấy được:** mỗi đợt việc có một dòng "Phạm vi test" do lead Fable / Opus quyết, kèm bậc, danh sách test đã chạy và lý do không chạy phần còn lại; đợt thường xong test trong 1–3 phút thay vì 7–30 phút; cả bộ vẫn chạy nhưng ở nền, sau khi push, cho thay đổi lan toả.

## Quy trình đề xuất

### 1. Ai quyết

- Lead **Fable hoặc Opus** quyết phạm vi test của đợt, ghi thành dòng `Phạm vi test:` trong báo cáo và nhật ký (mẫu ở mục 4). Runner (`--changed --list`) chỉ gợi ý; lead thêm / bớt và chịu trách nhiệm.
- Phiên **Sonnet** (tài liệu, commit, dọn, soát) chỉ làm bậc 0. Agent được giao việc (`thuc-thi-logic`, `kiem-thu`) chạy đúng danh sách test ghi trong bản giao việc: được chạy thêm, không được bớt.
- Không ai chạy cả bộ "cho chắc". Cả bộ có điều kiện kích hoạt rõ (bậc 3).

### 2. Bốn bậc theo loại thay đổi

Mỗi bậc có phần **tối thiểu** (bắt buộc) và lead được thêm. Thời gian là mục tiêu khi máy rảnh, 4 tiến trình.

| Bậc | Thay đổi | Tối thiểu | Mục tiêu |
|---|---|---|---|
| 0 | Tài liệu, kế hoạch, `RULES.md`, bộ nhớ, chú thích | `commit_gate --cached` | 10 s |
| 1 | Cục bộ một màn / module: khối `index.html` của một màn, tệp SQL chỉ **thêm** hàm / bảng mới, test của màn đó, Edge action chỉ màn đó gọi | test đỏ → xanh của chỗ sửa; `--only <màn>` (mọi test nhắc id khối hoặc tên tệp); SQL tĩnh nếu có `.sql`; `design_tokens_ratchet` + `icon_standard` + `ui_standard` khi đổi markup / CSS | ≤ 3 phút |
| 2 | Dùng chung / lan toả: khối dùng chung (xem danh sách dưới bảng); SQL `create or replace` hàm **đang chạy**, trigger; Edge dùng chung (`sku-sync`); Extension; agent máy trạm; `scripts/commit_gate.py` | bậc 1 + test của **mọi nơi gọi** (lead grep id khối / tên hàm, liệt kê trong dòng Phạm vi test) + cả bộ chuẩn giao diện khi `index.html` đổi | ≤ 8 phút |

Khối dùng chung của bậc 2: `PrintSkuQueue`, `WhDialog`, `scan-field`, `PrintSkuAdminAuth` / `PrintSkuAdminAccess`, `PrintSkuNotice`, `app-nav`, token CSS (`:root`), `PrintSkuScanUI`, `PrintSkuFloorAccess`.
| 3 | Cả bộ `python scripts/run_tests.py` | — | 7–9 phút máy rảnh |

Bậc 3 chạy khi một trong bốn điều kiện:
- (a) người dùng bảo;
- (b) lead không liệt kê được nơi gọi (grep ra khối không có id, hoặc > 8 test liên quan — lúc đó cả bộ không chậm hơn bao nhiêu);
- (c) đổi hạ tầng test: `scripts/run_tests.py`, `tests/page_settle.cjs`, `tests/xlsx_read.cjs`, mock dùng chung, cách nạp Playwright;
- (d) **lưới an toàn**: sau khi push một đợt bậc 2, cả bộ chạy **nền, không chặn báo xong**; lead báo kết quả khi có (hoặc giao `kiem-thu`); hỏng thì sửa ở commit riêng. Với (a)(b)(c) cả bộ chạy trước push.

Bậc do lead chọn theo tệp đổi (`git status`), nghi ngờ thì lấy bậc cao hơn. Một đợt đụng nhiều bậc lấy bậc cao nhất.

### 3. Tốc độ: không làm việc thừa

- **Sau mỗi vòng review chỉ chạy lại test chạm chỗ vừa sửa** (cùng tinh thần `--since last` của Codex); test đã xanh và không đụng lại thì không chạy lại.
- **Không chạy cả bộ cùng lúc với Codex** (giữ luật 18/10); bậc 1–2 nhỏ được chạy song song với Codex nếu ≤ 3 phút.
- **`--changed --list` để gợi ý**, không để chạy: danh sách ra cả bộ (tệp không map được) thì lead đổi sang `--only` theo màn, không chấp nhận cả bộ mặc định.
- **Test chập chờn**: hỏng ở lượt song song → chạy riêng `--only <tên> --jobs 1`; đạt → ghi CHẬP CHỜN, không chặn; vẫn hỏng → phân loại theo luật cũ (lỗi thật / test lệch / chập chờn), kiểm trên HEAD trước khi kết luận.
- **Commit tách hunk** (nhiều phiên cùng sửa `index.html`): trên cây tạm chỉ chạy bậc tương ứng của đợt, không cả bộ (trừ bậc 3). Cây tạm không có `node_modules`: `a11y_axe` / `cut_adj_reconcile` chạy sau khi nối junction như luật 04/11.
- **Cải tiến công cụ (tuỳ chọn, commit riêng, không chặn quy trình):** `--only` nhận nhiều từ khoá cách nhau dấu phẩy (hiện chỉ một chuỗi); `--changed --list` in rõ "khối không test nào nhắc" để lead biết màn nào chưa có test.

### 4. Bằng chứng và cách ghi

Dòng `Phạm vi test:` bắt buộc trong báo cáo xong việc và trong mục nhật ký `RULES.md` của đợt:

```
Phạm vi test: bậc 1 (Xả vải, khối xa-vai-script + hàm SQL mới) — xa_vai_printed_delete_sql PASS, xa_vai_printed_delete_browser PASS 1280/375, xa_vai_a4_browser PASS, design_tokens_ratchet PASS (màu 429), icon_standard PASS, ui_standard PASS. Không chạy: cả bộ (không hàm / khối dùng chung đổi).
```

- Dòng test đã chạy chép nguyên văn dòng PASS / FAIL (luật cứng 1); "không chạy" phải có lý do.
- `commit_gate --cached` "Đủ điều kiện commit" vẫn là cổng trước mọi commit.
- Commit + push: test của bậc đạt + `commit_gate` đạt → lead tự commit phần của mình và push (giữ chốt 05/11); luật 4 (migration / Edge trước push) không đổi.

### 5. Chất lượng: ba lưới giữ lại

1. **Test đỏ trước** khi sửa lỗi / đổi logic (không đổi).
2. **Bộ chuẩn giao diện** bắt buộc theo bậc: bậc 1 đổi markup / CSS → `design_tokens_ratchet` + `icon_standard` + `ui_standard` (~75 s cộng dồn, ~40 s song song); bậc 2 → thêm `a11y_axe`, `typography`, `app_nav`, `mobile_home`.
3. **Cả bộ nền sau push bậc 2** (điều kiện d) — bắt lỗi lan sang màn khác mà không chặn người dùng; kết quả ghi `RULES.md` kèm mục CHẬP CHỜN.

Đánh đổi nói rõ: lỗi lan toả từ một đợt bậc 1 (ví dụ CSS `1a6defe`) có thể lọt tới lượt cả bộ kế tiếp hoặc tới người dùng. Giảm bằng: CSS đổi `display` / vị trí của thẻ tab thì xếp bậc 2 (đã có luật 04/11); bộ chuẩn giao diện ở bậc 1.

## Kế hoạch (sau khi duyệt)

### Việc 1 — Sửa bốn tệp luật · Fable / Opus · [x]
- [x] `AGENTS.md`: luật cứng 3 (thêm "phạm vi test do lead Fable / Opus quyết, ghi dòng Phạm vi test"); mục Kiểm chứng ý 6 (bốn bậc, link `KIEM_THU_GIT.md`); ý 3 nói rõ "khổ điện thoại thuộc test của màn, không phải cả bộ".
- [x] `docs/chuan/KIEM_THU_GIT.md`: thay mục "Chạy test" bằng bốn bậc + lưới an toàn + mẫu dòng Phạm vi test; sửa tiêu đề ngày; bỏ "Nguồn: Nguồn:" lặp.
- [x] `docs/DOI_AGENT.md`: bước 2 (chọn bậc khi bắt đầu), bước 4 (test theo bậc + dòng Phạm vi test), bảng vai (`kiem-thu` = chạy bậc 3 nền và phân loại).
- [x] `docs/QUYET_DINH.md` chủ đề 1: thay dòng chốt 05/11 sáng bằng bốn bậc, ghi "đổi chốt 05/11 chiều".
- [x] `RULES.md` mã `[N20261105-hhmm]`: quyết định, số đo trên, lý do đổi; bộ nhớ `feedback_remind_commit_when_done` + `project_test_speedup_plan` cập nhật.
- [ ] `commit_gate --cached` không cảnh báo dòng > 400 ký tự; commit + push (bậc 0).

### Việc 2 — Cải tiến runner (commit riêng) · lead · [x]
- [x] `--only a,b,c` nhiều từ khoá (`only_filter`); test đỏ trước `ScopeTest` ở `tests/test_run_tests.py` (4 ca đỏ → 30/30 OK).
- [x] `--changed --list` in gợi ý + hai nhóm (`split_unmapped`, `changed_summary`) + lệnh `--only` sẵn; không `--list` giữ hành vi cũ.

## Chờ người dùng chốt

1. **Bậc 1 có bắt buộc 3 test chuẩn giao diện (`design_tokens_ratchet`, `icon_standard`, `ui_standard`, ~40 s) khi đổi markup / CSS không?** Khuyến nghị: **có** (chính 3 test này bắt lỗi 04/11; a11y 105 s để bậc 2).
2. **Lưới an toàn (d): cả bộ nền sau khi push bậc 2?** Khuyến nghị: **có**, không chặn báo xong. Bỏ thì lỗi lan toả chỉ còn trông vào người dùng.
3. **Ngưỡng "không liệt kê được nơi gọi" = 8 test** (vượt thì chạy cả bộ)? Khuyến nghị: 8.

## Nhật ký
- 05/11/2026 09:10 Soạn bản nháp (phiên Fable), đo `outputs/test-times.json`; chưa sửa tệp luật.
- 05/11/2026 09:20 Người dùng duyệt cả 3 khuyến nghị; sửa 4 tệp luật + nhật ký, commit + push `94200f3` (bậc 0).
- 05/11/2026 09:45 Việc 2 (người dùng "Làm Việc 2"): runner `--only` nhiều từ khoá, `--changed --list` tách nhóm; bậc 3 (hạ tầng test) cả bộ trước push.
