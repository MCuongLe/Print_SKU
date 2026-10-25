# Chuẩn viết tài liệu (25/10/2026)

Áp cho mọi tài liệu trong repo và cho `RULES.md`. Đọc khi viết hoặc sửa tài liệu, ghi quyết định, ghi nhật ký.
Luật về cách viết tài liệu chỉ nằm ở tệp này; tệp khác trỏ về đây.

## 1. Mỗi chủ đề một nguồn

| Nội dung | Nơi duy nhất |
|---|---|
| Luật cứng, thứ tự đọc, loại việc → đọc gì | `AGENTS.md` |
| Quy trình một yêu cầu (bước 1–9), đội agent, review | `docs/DOI_AGENT.md` |
| Bản đồ 6 nguồn ngữ cảnh | `docs/CONTEXT_MAP.md` |
| Module ↔ khối `index.html` ↔ Extension ↔ Edge ↔ SQL ↔ test | `docs/PROJECT_MAP.md` |
| Cách viết tài liệu, khuôn mẫu | tệp này |
| Chuẩn kỹ thuật theo chủ đề | `docs/chuan/*.md` |
| Quyết định đang hiệu lực | `docs/QUYET_DINH.md` |
| Lịch sử, số đo, căn cứ | nhật ký `RULES.md` (chỉ trên máy) |
| Kế hoạch nhiều bước | `docs/plans/` (khuôn ở `docs/plans/README.md`) |
| Hướng dẫn vận hành | `README.md`, `workstation-agent/README.md`, `extension/inside-po-connector/README.md` |
| Sở thích riêng của lead | bộ nhớ Claude |

- Một luật chỉ viết đầy đủ ở một nơi; nơi khác chỉ một dòng trỏ ("xem `<tệp>` mục …").
- Bộ nhớ Claude không chứa luật áp cho mọi phiên, vì Codex, phiên cloud và máy khác không đọc được. Luật chung phải nằm trong git.

## 2. Cách viết

- Tiếng Việt có dấu. Tên mã, đường dẫn, lệnh, id khối để trong `backtick`.
- Ngày `dd/mm/yyyy` (trong dòng ngắn được `dd/mm`); giờ Việt Nam `hh:mm`.
- Mỗi dòng văn xuôi ≤ 400 ký tự; bảng và khối mã không tính. Ý dài hơn thì tách gạch con.
- Một gạch đầu dòng một ý. Không viết khối chữ liền nhiều ý.
- Tài liệu luật nêu luật trước, lý do sau một vế ("vì …"). Lịch sử ("trước đây …", "đổi ngày …") ghi nhật ký, không ghi tài liệu luật.
- Số đo kèm thời điểm và cách đo.
- Dữ liệu ví dụ dùng bộ giả chuẩn: SKU `9000000xx`, UID `1028260000000xxx`, PO `100000001`. Không ghi SKU, UID, PO, email, khoá hay token thật — repo public.

## 3. Mã tham chiếu ổn định

- Mỗi mục nhật ký mới mở bằng mã `[N<yyyymmdd>-<hhmm>]` theo giờ Việt Nam lúc ghi, vd. `[N20261025-2130]`. Trùng phút thì thêm `b`, `c`.
- Dòng nhật ký cũ được trỏ tới mang mã `[N0965]`: 4 số là số dòng nhật ký gốc, đông cứng ngày 25/10/2026.
- `docs/QUYET_DINH.md` và tài liệu khác trỏ bằng mã, không bằng số dòng: `(17/10 · N0965, N0966)`; đoạn liền: `N0106–N0130`.
- Tra: grep `[N0965]` trong `RULES.md`.

## 4. Khuôn mẫu

**Mục nhật ký `RULES.md`** (thêm ở cuối tệp):

```markdown
- [N20261025-2130] **25/10/2026 — <tiêu đề ≤ 200 ký tự> (người dùng: "<câu nguyên văn ngắn>").**
  - Quyết định: <…>
  - Số đo: <… — thời điểm, cách đo>
  - Commit / lên thật: <mã commit, migration, deploy>
  - Chưa kiểm: <việc người dùng còn phải thử thật>
```

**Dòng trong `docs/QUYET_DINH.md`** (đúng chủ đề trong 12 chủ đề):

```markdown
- <luật đang hiệu lực, một câu>. (<ngày chốt> · <mã nhật ký>)
```

Thay luật cũ thì sửa hoặc xoá dòng cũ; không để hai bản cùng hiệu lực. Luật đã bỏ chuyển sang mục "Đã bỏ hẳn".

**Mục "Trạng thái lên thật"** (cuối `docs/QUYET_DINH.md`):
- Tiêu đề ghi ngày kiểm và cách kiểm (Supabase MCP chỉ đọc, git).
- Nhóm theo thứ tự: Web · Migration · Edge · Extension / agent / cron · CHƯA LÊN · Đã lên, CHƯA thử thật.
- Mỗi dòng có bằng chứng: tên đối tượng trên DB, bản Edge và giờ deploy, commit.
- Kiểm quá 3 ngày thì coi là cũ: kiểm lại trước khi dựa vào.

**Tệp chuẩn `docs/chuan/<CHU_DE>.md`** (≤ 2 trang, chỉ luật đang hiệu lực):

```markdown
# Chuẩn <chủ đề> (<ngày>)

Áp cho: <…>. Đọc khi: <loại việc>.

## <nhóm luật>
- <luật>. Giữ bởi: `tests/<…>` | `commit_gate` | chưa có. Nguồn: (<ngày> · <mã nhật ký>)

## Quy ước đang dùng trong mã, chưa chốt thành luật   ← tuỳ chọn: thấy trong mã, chưa có quyết định
## Chưa thống nhất (chờ chốt)                         ← tuỳ chọn: hai nguồn lệch nhau, hoặc chưa có quy ước
```

Gom luật vào tệp chuẩn thì chỉ chép luật đã có quyết định; quy ước chỉ thấy trong mã ghi ở mục "chưa chốt" để người dùng quyết.

**Hàng `docs/PROJECT_MAP.md` mục 2** — giữ 4 cột:

```markdown
| <TÊN Ô TRANG CHỦ> `#<id ô>` | `#<hash>` | <khối style / script / section theo id> | <Extension, RPC, bảng, test> |
```

**Mục module trong `README.md`**:

```markdown
## <TÊN MODULE> (`#<hash>`)

- Dùng để: <…>
- Ai dùng: <Worker | Admin> · <điện thoại | máy tính>
- Màn: khối `<style id>` / `<script id>`
- Dữ liệu: RPC `<…>`, bảng `<…>`; Extension `<lệnh>`
- Test: `tests/<…>`

<mô tả hành vi; mỗi đoạn ≤ 600 ký tự>
```

README mô tả hành vi hiện tại; lịch sử thay đổi ghi nhật ký `RULES.md` hoặc tệp kế hoạch.

**Kế hoạch nhiều bước**: khuôn ở `docs/plans/README.md`.

## 5. Cập nhật cùng commit

| Khi đổi | Sửa |
|---|---|
| Module, khối `index.html`, lệnh Extension, action Edge, chuỗi migration | `docs/PROJECT_MAP.md` |
| Thêm / bỏ Edge, Extension, agent, hệ thống ngoài; luồng nghiệp vụ mới qua ≥ 2 module; cách gói repomix, công cụ tìm khối | `docs/CONTEXT_MAP.md` |
| Quy trình, đội agent, review | `docs/DOI_AGENT.md` + dòng `docs/QUYET_DINH.md` |
| Hành vi người dùng thấy | mục module trong `README.md` |
| Quyết định mới | nhật ký `RULES.md` (mã mới) + dòng `docs/QUYET_DINH.md` |
| Lên thật migration / Edge / Extension / agent | `docs/QUYET_DINH.md` mục "Trạng thái lên thật" |
| Cách viết tài liệu | tệp này |

## 6. Kiểm trước khi báo xong

- `git diff --check` sạch.
- Dòng văn xuôi mới ≤ 400 ký tự.
- Mọi mã trỏ mới (`N…`) grep ra đúng một dòng trong `RULES.md`.
- Không có dữ liệu thật hay khoá trong phần sửa.
