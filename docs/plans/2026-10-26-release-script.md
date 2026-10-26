# Release script: migration → Edge → Reload → push bằng một lệnh (2026-10-26)

## Thiết kế
- **Yêu cầu:** "Migration và deploy tôi cần làm tự động bạn đề xuất model" → người dùng chọn mô hình A: `scripts/release.py` chạy cục bộ, có cổng xác nhận; chưa cho Claude chạy hộ (mô hình C để sau).
- **Kết quả nhìn thấy được:**
  - `python scripts/release.py --plan` (chỉ đọc) in việc chờ theo thứ tự cố định: migration, Edge, Extension, web.
  - `--apply` chạy tuần tự, mỗi cổng người gõ `y` trên terminal thật; xong ghi biên bản và sổ.
  - Không có cờ `--yes`; không có terminal thật thì thoát.
- **Đã chốt với người dùng (26/10/2026):**
  - Sổ việc đã chạy nằm ở database (`release_ledger`), không phải tệp cục bộ.
  - `--init` ghi nhận 89 tệp migration hiện có và 4 Edge là "đã chạy" (đã kiểm 89/89 bằng `live_status.py` 26/10).
  - Migration mới có dòng `-- kiem:` và `-- Rút lui` trong đầu tệp; tệp cũ không bắt buộc.
  - `release.py` tự `git push` ở cổng cuối, để thứ tự do script giữ.
  - Không đổi AGENTS luật 4: script chỉ thực thi luật đó.
- **Số đo thật (26/10/2026, chỉ đọc):**
  - Không có `.github/workflows`; máy không có `gh`; push `main` đưa web lên ngay.
  - Bốn script `deploy_*.py` (sku-sync, group-uid-sync, print-assistant, sku-vision) mỗi script gửi một tệp `index.ts`.
  - `live_status.py` chỉ nhận ra migration có tạo đối tượng (bảng, hàm, chỉ mục, trigger, cron); tệp chỉ `ALTER` (như cột + CHECK của `sync_auto_v3`) thì không.
  - `GET /v1/projects/<ref>/functions/<slug>/body` trả bundle `ESZIP2.3` (141.899 byte với `sku-sync`); nguồn không nằm nguyên khối trong bundle.
  - Dấu vết chuỗi ký tự dài một dòng (≥ 14 ký tự) có đủ trong bundle: `sku-sync` 21/21, `group-uid-sync` 18/18; 2 chuỗi mới của đợt cổng bản nhận ra 2/2.
  - `print-assistant` và `sku-vision` có chuỗi nhiều dòng (template literal): bộ tách chuỗi thô báo thiếu 7 và 9 chuỗi, là lỗi bộ tách, không phải lỗi bundle.
- **Hợp đồng:**
  - Lệnh: `release.py [--plan | --apply | --status | --init | --accept <tệp.sql>] [--only migrations|edge] [--rerun <tệp.sql>] [--project-ref <ref>]`; không cờ = `--plan`.
  - Thoát: 0 xong hoặc không có việc; 1 dừng vì lỗi hoặc người dùng từ chối; 2 cần terminal thật hoặc cờ sai; 3 preflight không đạt.
  - Tái dùng mã: `apply_supabase_sql` (`read_token`, `project_ref`, `run_query`, `destructive_statements`), `live_status` (`migration_files`, `sql_objects`, `expected_objects`, `missing_by_file`, `STATUS_SQL`, `select_only`, `edge_functions`). Deploy bằng `subprocess` gọi `scripts/deploy_<slug, đổi - thành _>.py`; slug chưa có script thì dừng và nói rõ.
  - Sổ: bảng `public.release_ledger(kind, name, sha256, commit_sha, applied_at, applied_by, note)`, khoá chính (`kind`, `name`), `kind` ∈ migration | edge | extension | lock; RLS bật, không policy, chỉ `service_role`; tạo bằng `supabase/release_ledger_v1.sql`.
  - Hash: sha256 hex của nội dung đã đổi CRLF → LF; nguồn đọc bằng `git show HEAD:<đường dẫn>`, không đọc cây làm việc.
  - Việc chờ:
    - Migration: tệp `supabase/*.sql` ở `HEAD` chưa có trong sổ. Có trong sổ mà sha khác = "đã sửa sau khi chạy": `--apply` dừng mã 3 trước mọi cổng (người dùng đổi chốt 26/10, trước đó chỉ cảnh báo); lối thoát `--rerun <tệp>` hoặc `--accept <tệp>`.
    - Edge: sha nguồn `HEAD` của `supabase/functions/<slug>/index.ts` khác sổ.
    - Extension: `manifest.json` version ở `HEAD` khác `note` của dòng `extension` / `inside-po-connector`.
    - Web: `git rev-list origin/main..HEAD` còn commit.
  - Thứ tự cố định: migration (theo thứ tự `live_status.migration_files()`) → Edge → Extension (cổng người) → push.
  - Preflight (dừng với mã 3 nếu hỏng):
    - Nhánh `main`; `git status --porcelain --untracked-files=no` rỗng.
    - Sau `git fetch`, `HEAD` không tụt `origin/main`.
    - `commit_gate.py --commit HEAD` đạt.
    - Có token, ref đúng, sổ tồn tại, lấy được khoá.
    - Nếu diff `origin/main..HEAD` có `.js` `.ts` `.html` `.sql` `.cjs`: hỏi "đã có kết quả cả bộ test cho HEAD này?" (gõ `y`). Script không tự chạy bộ test.
  - Cổng migration (mỗi tệp một màn): hiện tên, commit, 12 dòng đầu chú thích, cờ DROP / DELETE / TRUNCATE (qua `destructive_statements`) và `SECURITY DEFINER`, khối `-- Rút lui` nếu có; hỏi `[y/N]`. Tệp có DROP / DELETE / TRUNCATE phải gõ nguyên tên tệp; chỉ tệp đó được thêm `--allow-destructive`.
  - Xác minh migration: lệnh chạy không lỗi; mọi đối tượng tệp tạo ra có trên database (`expected_objects` + `STATUS_SQL`); mỗi dòng `-- kiem: <một câu SELECT, một dòng, trả true>` chạy qua `select_only` phải trả true. Tệp không có `-- kiem:` thì in "xác minh yếu" (cảnh báo, không chặn).
  - Cổng Edge (mỗi hàm một màn): hiện version, giờ deploy, sha nguồn mới so với sổ; `[y/N]`; deploy; xác minh: version tăng đúng 1, `updated_at` sau lúc bắt đầu, `status` ACTIVE, và dấu vết nội dung.
  - Dấu vết nội dung: tách chuỗi ký tự một dòng (nháy kép / nháy đơn, có escape; bỏ qua thân template literal) ≥ 14 ký tự từ nguồn; phải có đủ trong bundle `GET .../functions/<slug>/body` (giải mã UTF-8). Thiếu khi đã tách chắc chắn: dừng, không ghi sổ. Bộ tách không chắc: cảnh báo "bỏ qua dấu vết", không chặn.
  - Cổng Extension: in checklist Reload; nếu có bảng `sync_auto_devices`, in từng máy và bản đã khai báo (máy còn bản cũ: cảnh báo vàng nhưng vẫn cho tiếp). Hỏi "đã Reload Extension <ver> trên mọi máy Admin đang đồng bộ và tải lại tab Inside / WMS?" `[y/N]`; `y` thì ghi sổ.
  - Cổng push: in `git log origin/main..HEAD --oneline`; `[y/N]`; `git push`.
  - Ghi sổ: từng mục, chỉ sau khi xác minh đạt; `applied_by` = tên máy + `#` + mã ngẫu nhiên; `commit_sha` = `HEAD` rút gọn. Ghi sổ lỗi sau khi migration đã chạy: in lỗi lớn "ĐÃ CHẠY nhưng chưa ghi sổ; chạy lại an toàn vì tệp idempotent".
  - Khoá: một dòng `kind=lock, name=release`, hạn 30 phút kể từ `applied_at`; lấy bằng một câu `insert … on conflict … do update … where <hết hạn> returning`, nhả khi xong hoặc khi lỗi (`finally`).
  - `--init`: gõ `SEED` để xác nhận; chạy `supabase/release_ledger_v1.sql`; yêu cầu `live_status` không còn tệp thiếu đối tượng (còn thì dừng và liệt kê); ghi mọi tệp `supabase/*.sql` ở `HEAD` (gồm chính `release_ledger_v1.sql`) và từng Edge.
    - Edge có `updated_at` trước commit cuối của thư mục hàm thì phải gõ tên slug xác nhận.
    - Hỏi bản Extension đang chạy trên các máy (để trống = chưa ghi dòng `extension`).
  - Báo cáo: `outputs/release/release-<yyyymmdd-hhmm>.md` (ngoài git): preflight, kế hoạch, từng bước (giờ, kết quả, số đo), sổ trước và sau, khối "Trạng thái lên thật" do `live_status.render`, khuôn dòng RULES.md có mã `[N<yyyymmdd>-<hhmm>]`.
  - Lỗi: dừng ngay tại bước lỗi; mỗi tệp migration là một giao dịch nên lỗi thì không đổi gì; deploy Edge lỗi thì giữ bản cũ; không rollback tự động, chỉ in khối `-- Rút lui`; chạy lại `--apply` thì tiếp từ mục chưa vào sổ.
  - Chỗ để dành cho mô hình C (chưa làm): `--plan` in được JSON kèm hash kế hoạch.
- **Rủi ro và cách chặn:**
  - Chạy nhầm SQL chưa commit → chỉ đọc từ `HEAD`, cây sạch bắt buộc.
  - DROP / DELETE lọt qua `y` chung → gõ nguyên tên tệp, cờ chỉ cho tệp đó.
  - Ghi sổ trước khi xác minh → test đột biến bắt.
  - Hai máy cùng phát hành → khoá có hạn.
  - Push trước migration / Edge → thứ tự cố định trong mã, test đột biến bắt.
  - Token lộ trong biên bản hoặc log → test khẳng định không in token.
  - Dấu vết nội dung báo sai → bộ tách không chắc thì cảnh báo, không chặn.
- **Chưa kiểm được bằng máy:**
  - Chạy thật `--init` và `--apply` trên Supabase (người dùng làm lần đầu).
  - Bộ tách chuỗi trên mọi hàm Edge ngoài bốn hàm hiện có.
  - Hành vi `git push` thật.

## Kế hoạch
Thứ tự chạy: Việc 1 + Việc 2 (một khối cho `thuc-thi-logic`) → Việc 3 (lead) → Việc 4 → Việc 5.

### Việc 1 — `supabase/release_ledger_v1.sql` · thuc-thi-logic · [x] (build xong, chưa commit, chưa chạy thật)
- Tệp và neo: tệp mới; khuôn `supabase/sync_auto_v3.sql` (đầu tệp Vì sao / Tác động / Lệnh / Rút lui / `-- kiem:`; `begin;` … `commit;`; `notify pgrst`).
- [x] Bảng `release_ledger` đúng hợp đồng, RLS bật, `revoke all … from public, anon, authenticated`, `grant select, insert, update, delete … to service_role`; check `kind`, `sha256` dạng hex 64 hoặc null. Bằng chứng: `supabase/release_ledger_v1.sql` (CRLF, 37 dòng); `node tests/release_ledger_sql.cjs` 15/15 đột biến bị bắt.
- [x] Đầu tệp có dòng `-- kiem:` (bảng tồn tại, RLS bật) và `-- Rút lui` (`drop table` ghi trong chú thích, không chạy). Bằng chứng: hai dòng đầu tệp; đột biến "mất -- kiem" và "biến dòng rút lui thành lệnh chạy" bị bắt.
- [x] Test: kiểm văn bản theo khuôn `tests/sync_auto_v3_sql.cjs` (bảng, check, RLS, quyền, không `drop` ngoài chú thích, CRLF); đột biến. Bằng chứng: đỏ trước (`AssertionError: có bảng release_ledger`), xanh sau; lead chạy lại 26/10 15:5x.
- Ngoài phạm vi: chạy migration.

### Việc 2 — `scripts/release.py` + `tests/test_release.py` · thuc-thi-logic · [x] (build xong, chưa commit, chưa chạy thật)
- Tệp và neo: tệp mới; tái dùng hàm của `scripts/apply_supabase_sql.py` và `scripts/live_status.py`, không sửa hai tệp đó.
- [x] Hàm thuần có test: tính việc chờ (migration, Edge, Extension, web), so sha CRLF → LF, đọc chú thích đầu migration (`-- kiem:`, `-- Rút lui` có / không dấu, 12 dòng đầu), phân loại tệp có DROP / DELETE / TRUNCATE, tách chuỗi ký tự cho dấu vết nội dung, dựng biên bản, đổi tên slug → script. Bằng chứng: `tests/test_release.py` 67 test (agent chạy bộ thật; lead chạy lại: OK).
- [x] Luồng `--plan`, `--apply`, `--init`, `--status` chạy với bản giả của `run_query`, Management API, git, `input`, `isatty`; không gọi mạng. Bằng chứng: lớp `Ctx` + `FakeCtx`; khi test chạy `urlopen`, `subprocess`, `input`, `read_token` thật bị chặn.
- [x] Đột biến bị test bắt: push trước migration; ghi sổ trước xác minh; chấp nhận `--yes`; bỏ cổng gõ tên tệp cho DROP; bỏ khoá; đọc cây làm việc thay vì `HEAD`; không thoát khi không có terminal; in token. Bằng chứng: 21/21 đột biến Python bị bắt (8 đột biến bản giao + 13 thêm, gồm bỏ lọc `*.example.sql`).
- [x] Chạy thử `python scripts/release.py --plan` khi không có token: thoát mã 3 kèm câu rõ, không văng lỗi. Bằng chứng: thoát mã 3 kèm câu rõ khi không có token (wrapper thay `read_token`); lead chạy `--plan` thật chỉ đọc: "Chưa có sổ … chạy --init".
- Ngoài phạm vi: chạy `--init` / `--apply` thật, gọi Supabase thật, commit.

### Việc 3 — Tài liệu · lead · [x]
- [x] `docs/chuan/DU_LIEU.md`: quy trình phát hành bằng `release.py`; quy ước `-- kiem:` và `-- Rút lui`. Bằng chứng: 8 dòng mới ở mục Migration (quy trình, sổ, commit sạch, xác minh, `-- kiem` / `-- Rút lui`, push theo sha, DO / EXECUTE, kết quả chưa rõ).
- [x] `docs/PROJECT_MAP.md` mục 5 (lệnh) và mục 4 (bảng `release_ledger`); `docs/QUYET_DINH.md` chủ đề 9; `docs/CONTEXT_MAP.md` nếu cần. Bằng chứng: mục 4 (bảng `release_ledger`, chuỗi `release_ledger_v1`), mục 5 (lệnh + test); `docs/QUYET_DINH.md` chủ đề 9 (2 dòng) + CHƯA LÊN + chủ đề 12.
- [x] `.claude/skills/commit-push/SKILL.md`: khi `release.py --plan` còn việc chờ thì dừng ở commit và gợi ý `release.py`. Bằng chứng: một dòng ở mục 2 (`release.py --plan` trước khi push); `AGENTS.md` thêm một câu trỏ tới `release.py`.
- [x] `git diff --check`; dòng mới ≤ 400 ký tự; mã `N…` mới có đúng một thẻ trong `RULES.md`. Bằng chứng: sạch; dòng thêm ≤ 400 ký tự; mã `N20261026-1548` có một thẻ trong `RULES.md`.

### Việc 4 — Review · lead · [x]
- [x] Codex + `/review-claude` một vòng (chạm token, SQL, quy trình lên thật); `co-van` lọc; sửa nhóm nên sửa; cả bộ `run_tests.py` + `commit_gate.py`.
  - Bằng chứng: Codex 7 nhóm, A 6 nhóm, BC 8 nhóm → Fable lọc 15 vấn đề gốc; sửa 9 mục (`test_release.py` 67 → 100 test, đột biến 21 → 48); cả bộ `run_tests.py` 128/128 PASS 1156 s (không chập chờn); `commit_gate` 7 mục ĐẠT. Phần sửa chưa review lại (người dùng chỉ yêu cầu một vòng).

### Việc 5 — Nghiệm thu · lead + người dùng · [ ]
- [ ] Lead chạy `python scripts/release.py --plan` thật (chỉ đọc) và so với `live_status.py`; dán kết quả cho người dùng.
- [ ] Người dùng chạy `--init` một lần; lead kiểm chỉ đọc bảng `release_ledger` (88 tệp migration + `release_ledger_v1.sql` = 89 dòng, loại `*.example.sql`; 4 Edge).
- [ ] Lần phát hành thật kế tiếp chạy bằng `--apply`; ghi số đo vào `RULES.md`.

## Phát sinh
- Làm sau (Fable xếp, chưa làm):
  - sổ Edge đối chiếu bản đang chạy / fingerprint ở `--init` (A6, 40 điểm).
  - câu chữ "chưa có bảng" khi lỗi khác (BC7).
  - hash thư mục Extension vào sổ (Codex 6, 40 điểm: kéo cả README / RULES.md trong thư mục Extension, cột `sha256` chỉ chứa 64 hex).
  - fencing holder trên câu ghi sổ.
  - chuyển `deep_destructive` sang `apply_supabase_sql.py` (đổi hành vi lệnh chạy tay, cần người dùng gật).
  - mẫu phản hồi thật `insert … returning` (lấy ở Việc 5).

## Lệch kế hoạch
- Push bằng `git push origin <sha>:refs/heads/main` (sha chốt một lần trước preflight, kiểm lại HEAD và nhánh sau khi gõ `y`) thay cho `git push origin main`. Lead đã thử trên kho tạm: chỉ đẩy tới đúng sha và `origin/main` cục bộ tự cập nhật.
- `--init` dừng mã 3 khi sổ đã có dòng migration; sau `acquire_lock` đọc lại sổ và dựng lại kế hoạch; dòng seed có `note=init`; in danh sách tệp không có đối tượng để kiểm (9/89 tệp trên HEAD).
- Cổng DROP / DELETE quét cả khối `DO` và `EXECUTE` động (`deep_destructive` trong `release.py`; `apply_supabase_sql.py` giữ nguyên). Trên HEAD thêm đúng một tệp bị gắn cờ: `sku_sync_full_v1.sql`.
- Trạng thái "KẾT QUẢ CHƯA RÕ" cho hết giờ / mất kết nối / HTTP ≥ 500 / 408; HTTP 4xx còn lại là bị từ chối rõ ràng. Cổng bộ test hỏi thêm khi diff có `.py` / `.mjs` và dừng mã 3 khi `git diff` lỗi.
- Tệp migration đã sửa sau khi chạy: người dùng ĐÃ ĐỔI CHỐT (26/10) từ chỉ cảnh báo sang chặn. `--apply` (mọi `--only`) dừng mã 3 trước mọi cổng, in `git diff --stat` từ commit trong sổ và gợi ý lối thoát (`--accept` khi chỉ khác chú thích, `--rerun` khi khác nội dung); `--plan` / `--status` liệt kê; chế độ `--accept <tệp>` chỉ cập nhật sha trong sổ (gõ nguyên tên tệp, lấy khoá, không chạy SQL).
- Nguồn đọc bằng `git show <sha HEAD chốt một lần lúc bắt đầu>:<đường dẫn>` (không phải chữ `HEAD:`), và kiểm HEAD không đổi trước khi push; vì phiên khác có thể commit giữa chừng. Đã báo người dùng.
- Khoá được gia hạn trước mỗi mục và trước push (người dùng có thể chờ ở cổng Reload quá 30 phút); mất khoá thì dừng.
- Script deploy đọc cây làm việc (không sửa được): trước khi deploy so sha `index.ts` cây làm việc với `HEAD`, khác thì dừng.
- `--apply --only edge` khi còn migration chờ thoát mã 3 (giữ thứ tự migration → Edge); `--init` chạy đủ preflight như `--apply`.
- Loại mọi `supabase/*.example.sql` khỏi tập migration của `release.py` (tệp ví dụ, không phải migration); `live_status.py` vẫn đếm tệp này.
- Chỉ chạy `commit_gate --commit HEAD` (không cho cả khoảng commit): hook đã chạy cổng ở từng commit.

## Nhật ký
- 26/10/2026 15:48 [N20261026-1548] Người dùng duyệt thiết kế mô hình A theo 4 khuyến nghị; lead ghi kế hoạch này và giao Việc 1 + 2 cho `thuc-thi-logic` (Opus).
- 26/10/2026 16:29 Việc 1 + 2: `thuc-thi-logic` build xong 4 tệp mới (`release_ledger_v1.sql`, `release.py` ~1.535 dòng, `test_release.py`, `release_ledger_sql.cjs`); lead chạy lại: `test_release` 67 OK, `release_ledger_sql` 15/15, `commit_gate` 7 mục ĐẠT. Chưa review Codex / `/review-claude`, chưa tài liệu (Việc 3), chưa commit.
- 26/10/2026 17:33 Việc 3 + 4: tài liệu xong; review vòng 1 (Codex + A + BC + Fable) và 9 mục sửa xong; `test_release` 100 test / 48 đột biến, cả bộ 128/128 PASS, `commit_gate` 7 mục ĐẠT. Chưa commit; chưa chạy `--init` / `--apply` thật.
- 26/10/2026 17:51 Chặn tệp migration đã sửa + `--accept`: `thuc-thi-logic` sửa theo chốt mới; `test_release` 115 test, 57 đột biến; lead chạy lại các test Python 7/7 PASS, `release_ledger_sql` 15/15, `commit_gate` 7 mục ĐẠT. Chưa commit.
