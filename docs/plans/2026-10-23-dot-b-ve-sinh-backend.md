# Đợt B — vệ sinh backend sau review 23/10/2026

Trạng thái: ĐANG BUILD (23/10/2026). Nguồn: đánh giá backend + luồng dữ liệu 23/10 (`outputs/backend-review/fable-loc.md`, không vào git; tóm tắt ở RULES.md 23/10 tối). Đợt A (P1 Trợ lý in) đã lên 41a8a0d.

## Người dùng chốt (23/10/2026)
- C1 Lưu trữ SKU: GIỮ SKU còn UID **Blocked** và SKU là **thành phần** (`group_uid_products`) — cả `sku_archive_missing` lẫn `sku_inactive_archive`.
- C2 Email nhân viên: **che phần sau @** cho người ngoài (anon) ở Lịch sử Group UID (`group_uid_moves_lookup`), Đối chiếu ADJ (`cut_group_uid_reconcile` → `wmsCuts.by`), UID tạm (`uid_temp_overview` / `uid_temp_snapshot` → `createdBy`); Admin vẫn thấy đầy đủ. Thay quyết định 10/10 (RULES "hiển thị đầy đủ"). `sku_count_overview.lastApprovedBy` giữ nguyên (chốt 12/10, không hỏi lại).
- C3 Lệnh in kẹt: **nút Huỷ cho Admin** ở màn Lệnh in (lệnh `queued`); không tự huỷ theo giờ.
- C4 Mã kích hoạt nhiều máy (max_uses): **để sau**.

## Việc
### 1. Migration `supabase/backend_hygiene_v1.sql` (một tệp, không DROP, không `--allow-destructive`)
- [ ] P2 `print_agent_claim` (bản sau `print_sku_v3_v1`): hết lease ở `claimed/rendering` → `queued`, `agent_id = null` như cũ; ở `sending/spooling` → `queued` nhưng GIỮ `agent_id`, và chọn lệnh `(agent_id is null or agent_id = p_agent_id)`. `print_jobs_purge`: lệnh `queued` còn `agent_id` quá 30 phút → `failed` `SENT_UNCONFIRMED`. **Bắt buộc trước khi cài may-kho-02.**
- [ ] Q2/Q6 `alter default privileges for role postgres in schema public revoke … from public, anon, authenticated` (functions / tables / sequences; giữ service_role) + revoke quyền sequence còn lại của anon/authenticated.
- [ ] Q4/P3c/P4 `print_enqueue_unchecked` (bản sau `print_name_from_db_v1`): `sku` / `group_uid` items 1–100 và tổng `copies` item = `p_copies`; `template_version` ngoài {1,2,3} (sku) / ≠ 1 (group_uid) → từ chối; chặn SKU ngừng dùng `btrim`.
- [ ] Q8 `cut_group_uid_mark_queued`: `p_job_id` phải là lệnh `group_uid` có thật.
- [x] P5 `print_job_status`: KHÔNG cần — bản đang chạy trên Supabase đã kiểm `print_access_allowed` (repo `print_queue_v1.sql` là bản cũ hơn; kiểm md5 23/10). Mọi hàm khác của đợt: bản đang chạy = tệp mới nhất trong repo (kiểm md5 23/10).
- [ ] D5 `sync_history_purge`: lượt SKU `applying` > 1 giờ → `failed` + dọn payload.
- [ ] D8 hàm nạp Cut WMS: chặn `p_data_until > now() + 5 phút`.
- [ ] Index `uid_block_scans(device_id)`.
- [ ] C1 hai hàm lưu trữ SKU giữ thêm Blocked + SKU thành phần.
- [ ] C2 che email cho anon ở 3 nhóm hàm (Admin = `group_uid_admin_allowed()` thấy đầy đủ).
- [ ] C3 RPC Admin `print_job_cancel(p_job_id)`: chỉ lệnh `queued` → `cancelled` (ghi `print_events`); `print_jobs_purge` đã dọn `cancelled`.
- [ ] Test tĩnh SQL + test "danh sách hàm anon gọi được = danh sách chốt".

### 2. Edge `sku-sync`
- [ ] D4 `fetchAll("sku_combo_links…")` thêm `order=combo_sku.asc,normal_sku.asc` (2 chỗ).

### 3. Extension 0.10.8
- [ ] D2 `storage-risk-core.js` skuCount: so `rows.length` với `total`, lệch → đọc lại ≤ 2 lần rồi ném lỗi; khử trùng theo id nếu có.
- [ ] D7 `sku-sync-core.js`: trạng thái chỉ nhận active/inactive, khác → lỗi đọc (lượt lỗi, không ghi).
- [ ] D8 `cut-adj-core.js`: không có dòng → `p_data_until = min(to, giờ server)`; R7: phần i < cuối gửi `data_until` = `cut_at` dòng cuối của phần.
- [ ] Nâng phiên bản: `manifest.json` + `tests/inside_po_connector.cjs` + `tests/sku_sync_extension.cjs` + README Extension.

### 4. Web (`index.html`)
- [ ] D2 bản chép `sr-run` (Rủi ro lưu trữ / Kiểm kê) so total như Extension.
- [ ] C3 nút Huỷ (icon + nhãn ngắn) cho lệnh `queued` ở `print-jobs-admin-script`, xác nhận bằng `WhDialog`.

### 5. Kiểm + review
- [ ] Test đỏ trước cho mỗi sửa logic; cả bộ `run_tests.py`; agent `node --test` nếu đụng.
- [ ] Codex + /review-claude + Fable lọc (tối đa 3 vòng).
- [ ] PROJECT_MAP (chuỗi `print_agent_claim`, `print_enqueue_unchecked`, purge, Extension 0.10.8), RULES (cả nhật ký + mục lục: C2 thay quyết định 10/10).

## Thứ tự lên
1. `python scripts/apply_supabase_sql.py supabase/backend_hygiene_v1.sql` (không cần `--allow-destructive`).
2. `python scripts/deploy_sku_sync.py`.
3. Reload Extension 0.10.8 (tải lại tab Inside/WMS).
4. Push web.
