// TÌM GROUP UID · Trả nhà cung cấp (24/10/2026, docs/plans/2026-10-24-tra-nha-cung-cap.md): danh sách Navy / Black (Admin nạp Excel),
// máy đã kích hoạt quét Group UID → đánh dấu; ngoài danh sách báo đỏ; trùng báo máy + giờ. Supabase giả lập, mã giả 1028260000000xxx.
//   node tests/vendor_return_browser.cjs   (máy chủ tĩnh cổng 8000, đổi bằng BASE)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const LIST_CREATED = "2026-10-24T01:00:00Z";
const LIST = { id: "33333333-3333-4333-8333-333333333333", fileName: "tra-ncc-gia.xlsx", createdAt: LIST_CREATED, itemCount: 5 };
const item = (code, color, extra = {}) => ({ groupUid: code, color, sku: color === "navy" ? "900000496" : "900000494", productName: "Vải giả", lot: "L1", roll: "1", location: "F0-KHO-000-00-00-01", currentLocation: "F0-KHO-000-00-00-01", warehouse: "WH - MATERIAL - MTG", qty: 1000, scannedAt: null, device: null, ...extra });
const ITEMS = () => [
  item("1028260000000101", "navy", { scannedAt: "2026-10-24T01:30:00Z", device: "Máy giả 1" }),
  item("1028260000000102", "navy"),
  item("1028260000000103", "navy", { currentLocation: "F0-KHO-000-00-00-09" }),   // đã chuyển chỗ so với Excel
  item("1028260000000201", "black"),
  item("1028260000000202", "black"),
];

const backend = srv => route => {
  const url = route.request().url(), json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
  if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
  const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
  const args = JSON.parse(route.request().postData() || "{}");
  if (rpc) srv.calls.push({ rpc, args, auth: route.request().headers().authorization || "" });
  if (rpc === "vendor_return_snapshot" && srv.snapFail) return json({ message: "mất mạng giả" }, 503);
  if (rpc === "vendor_return_snapshot") return json({ ok: true, data: { list: srv.list, items: srv.items } });
  if (rpc === "vendor_return_scan") {
    if (srv.scanDelay) return new Promise(r => setTimeout(r, srv.scanDelay)).then(() => { srv.scanDelay = 0; return backend(srv)(route); });
    if (srv.deny) return json({ ok: false, error: { code: "ACCESS_DENIED", message: "Máy chưa kích hoạt" } });
    if (srv.noListOnce) {   // Admin vừa xoá đợt: lượt quét nhận NO_LIST; nextList / nextItems = đợt Admin khác nạp ngay sau đó (nếu có)
      srv.noListOnce = false; srv.list = srv.nextList || null; srv.items = srv.nextItems || [];
      return json({ ok: false, error: { code: "NO_LIST", message: "Chưa có danh sách trả nhà cung cấp" } });
    }
    if (!srv.list) return json({ ok: false, error: { code: "NO_LIST", message: "Chưa có danh sách trả nhà cung cấp" } });
    if (args.p_list_id !== srv.list.id) return json({ ok: false, error: { code: "STALE_LIST", message: "Danh sách đã đổi", data: { listId: srv.list.id } } });
    const it = srv.items.find(x => x.groupUid === args.p_group_uid);
    if (!it) return json({ ok: true, data: { result: "not_in_list" } });
    if (it.scannedAt) return json({ ok: true, data: { result: "dup", scannedAt: it.scannedAt, device: it.device } });
    Object.assign(it, { scannedAt: "2026-10-24T02:00:00Z", device: "Máy giả 2" });
    return json({ ok: true, data: { result: "new", color: it.color, scannedAt: it.scannedAt, device: it.device } });
  }
  if (rpc === "vendor_return_reconcile") {
    srv.reconciled = args;
    for (const r of args.p_rows) { const it = srv.items.find(x => x.groupUid === r.groupUid); if (it) Object.assign(it, { currentLocation: r.location || null, status: r.status || null, locationSource: "wms" }); }
    srv.list = { ...srv.list, reconciledAt: "2026-10-24T03:00:00Z" };
    return json({ ok: true, data: { updated: args.p_rows.length, reconciledAt: srv.list.reconciledAt } });
  }
  if (rpc === "vendor_return_delete") {   // máy chủ giả: Admin + đúng đợt đang dùng → xoá cả danh sách lẫn lượt quét
    if (srv.deleteDelay) { const ms = srv.deleteDelay; srv.deleteDelay = 0; return new Promise(r => setTimeout(r, ms)).then(() => backend(srv)(route)); }
    // Lỗi bất định (review c9e790d G1): máy chủ XOÁ rồi phản hồi mới mất / chậm / cổng 502 (lose-after*, gateway-after, slow-after); lose-before = chưa xoá gì
    if (["lose-after", "lose-after-new", "gateway-after", "slow-after"].includes(srv.deleteMode)) {
      srv.list = null; srv.items = [];
      if (srv.deleteMode === "lose-after-new") { srv.list = { ...LIST, id: "55555555-5555-4555-8555-555555555555", fileName: "tra-ncc-khac.xlsx" }; srv.items = ITEMS(); }   // Admin khác nạp đợt mới ngay sau đó
      if (srv.deleteMode === "gateway-after") return route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" });
      if (srv.deleteMode === "slow-after") return new Promise(r => setTimeout(r, 1500)).then(() => route.abort("failed")).catch(() => {});
      return route.abort("failed");
    }
    if (srv.deleteMode === "lose-before") return route.abort("failed");
    if (srv.deleteMode === "forbidden") return json({ ok: false, error: { code: "FORBIDDEN", message: "Chỉ Admin được xoá đợt trả nhà cung cấp" } });
    if (srv.deleteMode === "stale") {   // Admin khác vừa nạp danh sách mới trong lúc máy này còn giữ đợt cũ
      srv.list = { ...LIST, id: "55555555-5555-4555-8555-555555555555", fileName: "tra-ncc-khac.xlsx" }; srv.items = ITEMS();
      return json({ ok: false, error: { code: "STALE_LIST", message: "Danh sách đã đổi, chưa xoá gì", data: { listId: srv.list.id } } });
    }
    if (!srv.list) return json({ ok: false, error: { code: "NO_LIST", message: "Chưa có danh sách" } });
    if (args.p_list_id !== srv.list.id) return json({ ok: false, error: { code: "STALE_LIST", message: "Danh sách đã đổi", data: { listId: srv.list.id } } });
    const data = { deleted: true, listId: srv.list.id, items: srv.items.length, scans: srv.items.filter(x => x.scannedAt).length };
    srv.deleted = args; srv.list = null; srv.items = [];
    return json({ ok: true, data });
  }
  if (rpc === "vendor_return_import") {
    srv.imported = args;
    srv.list = { ...LIST, id: "44444444-4444-4444-8444-444444444444", fileName: args.p_file_name, itemCount: args.p_items.length };
    srv.items = args.p_items.map(x => ({ ...x, scannedAt: null, device: null }));
    return json({ ok: true, data: { listId: srv.list.id, itemCount: args.p_items.length, navy: 2, black: 1, carriedScans: 0 } });
  }
  if (url.includes("/rest/v1/") && !rpc) return json([]);
  return json({ ok: true, data: { agents: [], jobs: [], items: [], list: null } });
};

// Extension giả: GET_GROUP_UID_PAGE (xếp id bản ghi giảm dần như WMS) trả 102 về F0-VR (id 75) + bản ghi cũ cùng giờ của 102 (id 70, vị trí cũ —
// id lớn hơn phải thắng), 103 đã rời kho (Closed, không vị trí), 1 UID ngoài danh sách. __extDrift: tổng WMS lệch số bản ghi → đọc lại rồi báo lỗi.
const mockExtension = () => addEventListener("message", event => {
  const r = event.data;
  if (!r || r.source !== "PRINT_SKU_APP") return;
  (window.__extCalls ||= []).push({ type: r.type, payload: r.payload });
  const reply = data => postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: r.requestId, ok: true, data }, location.origin);
  if (r.type === "GET_GROUP_UID_PAGE") {
    const rows = [
      { group_uid_code: "1028260000000102", location: "F0-VR-00-00-00-00", status: "Blocked", updated_date: "2026-10-24T02:30:00.000Z" },
      { group_uid_code: "1028260000000102", location: "F0-KHO-000-00-00-01", status: "Blocked", updated_date: "2026-10-24T02:30:00.000Z" },
      { group_uid_code: "1028260000000103", location: null, status: "Closed", updated_date: "2026-10-24T02:20:00.000Z" },
      { group_uid_code: "1028260000000888", location: "F0-VR-00-00-00-00", status: "Blocked", updated_date: "2026-10-24T02:31:00.000Z" },
    ], ids = [75, 70, 60, 50];
    const send = () => reply({ page: 1, size: 500, total: window.__extDrift ? 5 : 4, totalPages: 1, rows, ids, rowIds: ids, codes: rows.map(x => x.group_uid_code) });
    return window.__extSlow ? setTimeout(send, window.__extSlow) : send();   // __extSlow: giữ Đối chiếu đang chạy để kiểm cờ bận chung
  }
  return reply({ version: "0.12.5" });
});
const open = async (browser, { width = 1280, admin = false, fastTimeout = false } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 800, hasTouch: width < 800 });
  await context.addInitScript(() => localStorage.setItem("tb-khoa", "khoa-may-gia"));
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "r" })), SESSION_KEY);
  if (admin) await context.addInitScript(mockExtension);
  // Hết giờ chờ nhanh: AbortSignal.timeout → TimeoutError (DOMException mang code SỐ 23, không phải mã nghiệp vụ chuỗi)
  if (fastTimeout) await context.addInitScript(() => { const t = AbortSignal.timeout.bind(AbortSignal); AbortSignal.timeout = ms => t(Math.min(ms, 300)); });
  const page = await context.newPage(), errors = [], srv = { calls: [], list: { ...LIST }, items: ITEMS() };
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", backend(srv));
  await page.goto(BASE + "#tra-ncc");
  await page.locator("#vendor-return-screen").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("vr-total").textContent.trim() !== "—");
  return { context, page, errors, srv };
};
const scan = async (page, code) => { await page.locator("#vr-code").fill(code); await page.locator("#vr-code").press("Enter"); };
const result = page => page.evaluate(() => { const r = document.getElementById("vr-result"); return { tone: r.dataset.tone, title: r.querySelector(".vr-result__title")?.textContent || "", note: r.querySelector(".vr-result__note")?.textContent || "" }; });
const shot = async (page, name) => { if (process.env.VR_SHOTS) await page.screenshot({ path: `${process.env.VR_SHOTS}/${name}.png`, fullPage: true }); };
const counts = page => page.evaluate(() => ["navy", "black"].map(c => document.getElementById(`vr-${c}`).textContent));
const locHeads = page => page.locator("#vr-locs .vr-loc__head").allInnerTexts().then(t => t.map(x => x.replace(/\s+/g, " ").trim()));

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1280, 390]) {
      const { context, page, errors, srv } = await open(browser, { width });
      // Bố cục như UID blocked (24/10/2026): dải tiến độ Đã quét / tổng · Còn thiếu · Navy / Black · Về F0-VR
      assert.deepEqual(await counts(page), ["1/3", "0/2"]);
      assert.deepEqual(await page.evaluate(() => ["vr-done", "vr-total", "vr-left", "vr-vr", "vr-tab-left", "vr-tab-done"].map(id => document.getElementById(id).textContent)), ["1", "5", "4", "0/5", "4", "1"]);
      // Còn thiếu: thẻ theo vị trí HIỆN TẠI (UID chưa quét), đóng sẵn; chạm mở → danh sách UID
      assert.deepEqual(await locHeads(page), ["F0-KHO-000-00-00-01 3 cuộn", "F0-KHO-000-00-00-09 1 cuộn"]);
      await page.locator('#vr-locs [data-vr-loc="F0-KHO-000-00-00-09"] summary').click();
      assert.match(await page.locator('#vr-locs [data-vr-loc="F0-KHO-000-00-00-09"] li').innerText(), /1028260000000103[\s\S]*Navy · 900000496 · Lot L1 · Roll 1 · SL 1.000 · File F0-KHO-000-00-00-01/, "UID đã chuyển chỗ: nằm ở vị trí hiện tại, kèm vị trí trong file");
      await page.locator('[data-vr-color="navy"]').click();
      assert.deepEqual(await locHeads(page), ["F0-KHO-000-00-00-01 1 cuộn", "F0-KHO-000-00-00-09 1 cuộn"], "lọc màu Navy");
      await page.locator('[data-vr-color="all"]').click();
      await page.locator("#vr-loc-filter").fill("0202");
      assert.deepEqual(await locHeads(page), ["F0-KHO-000-00-00-01 1 cuộn"], "lọc theo Group UID");
      await page.locator("#vr-loc-filter").fill("");
      // Đã quét: bảng dùng chung (tìm, lọc, Xuất Excel)
      await page.locator('[data-vr-tab="done"]').click();
      assert.equal(await page.locator("#vr-body tr").count(), 1);
      assert.match(await page.locator("#vr-body tr").innerText(), /1028260000000101[\s\S]*Navy[\s\S]*1\.000[\s\S]*Máy giả 1/, "có SL (review Codex)");
      await page.locator("#vr-tools input[type=search]").fill("24/10/2026");
      assert.equal(await page.locator("#vr-body tr:has(code)").count(), 1, "tìm theo ngày quét đủ năm");
      await page.locator("#vr-tools input[type=search]").fill("");
      // Danh sách: ai cũng xem ô thông tin; Nạp Excel / Đối chiếu chỉ Admin
      await page.locator('[data-vr-tab="list"]').click();
      assert.match(await page.locator("#vr-info").innerText(), /Navy\s*3[\s\S]*Black\s*2[\s\S]*Về F0-VR\s*0\/5[\s\S]*Đối chiếu WMS\s*Chưa/);
      assert.equal(await page.locator("#vr-file").innerText(), "tra-ncc-gia.xlsx");
      assert.equal(await page.locator("#vr-admin-panel").isVisible(), false, "không Admin: ẩn phần nạp Excel");
      assert.equal(await page.locator("#vr-reconcile").isVisible(), false, "không Admin: ẩn Đối chiếu");
      assert.equal(await page.locator("#vr-delete").isVisible(), false, "không Admin: ẩn Xoá đợt");
      assert.equal(srv.calls.some(c => c.rpc === "vendor_return_delete"), false);
      await shot(page, `tra-ncc-list-${width}`);
      await page.locator('[data-vr-tab="left"]').click();
      // Ngoài danh sách → đỏ, không gọi máy chủ
      const before = srv.calls.filter(c => c.rpc === "vendor_return_scan").length;
      await scan(page, "1028260000000999");
      await page.waitForFunction(() => document.getElementById("vr-result").dataset.tone === "bad");
      assert.equal((await result(page)).title, "Không thuộc danh sách trả");
      // Đã quét → báo trùng + máy, không gọi máy chủ
      await scan(page, "1028260000000101");
      await page.waitForFunction(() => document.getElementById("vr-result").dataset.tone === "dup");
      assert.match((await result(page)).title, /^Đã quét · Navy$/);
      assert.match((await result(page)).note, /Máy giả 1/);
      assert.equal(srv.calls.filter(c => c.rpc === "vendor_return_scan").length, before, "ngoài danh sách / đã quét: kiểm trên máy");
      // Mã mới Black → gọi máy chủ kèm khoá máy, đánh dấu, chuyển tab Black
      await scan(page, "1028260000000201");
      await page.waitForFunction(() => document.getElementById("vr-result").dataset.tone === "ok");
      assert.equal((await result(page)).title, "Đúng · Black");
      assert.equal(await page.locator("#vr-pop").isVisible(), true, "pop-up kết quả");
      await page.locator("#vr-pop").waitFor({ state: "hidden", timeout: 4000 });   // Đúng: tự đóng
      const call = srv.calls.filter(c => c.rpc === "vendor_return_scan").pop();
      assert.deepEqual([call.args.p_access_token, call.args.p_list_id, call.args.p_group_uid], ["khoa-may-gia", LIST.id, "1028260000000201"]);
      assert.deepEqual(await counts(page), ["1/3", "1/2"]);
      assert.deepEqual(await locHeads(page), ["F0-KHO-000-00-00-01 2 cuộn", "F0-KHO-000-00-00-09 1 cuộn"], "quét xong → rời Còn thiếu");
      await shot(page, `tra-ncc-${width}`);
      // Máy chưa kích hoạt → không đánh dấu, báo lỗi
      srv.deny = true;
      await page.locator("#pdv-dialog").evaluate(d => d?.close?.()).catch(() => {});
      await scan(page, "1028260000000202");
      await page.waitForFunction(() => /Chưa lưu được/.test(document.getElementById("vr-result").textContent));
      await page.keyboard.press("Escape");
      assert.deepEqual(await counts(page), ["1/3", "1/2"], "bị từ chối: không đánh dấu");
      srv.deny = false;
      // Quét dồn (review vòng 1): mã A đang lưu chậm, mã B gửi ngay sau → cả hai được xử lý lần lượt, không bỏ lượt
      srv.scanDelay = 800;
      await scan(page, "1028260000000102");
      await scan(page, "1028260000000103");
      await page.waitForFunction(() => document.getElementById("vr-navy").textContent.trim() === "3/3", null, { timeout: 10000 });
      assert.deepEqual(srv.calls.filter(c => c.rpc === "vendor_return_scan").slice(-2).map(c => c.args.p_group_uid), ["1028260000000102", "1028260000000103"]);
      // Mã lạ khi tải lại danh sách lỗi (review vòng 2): không kết luận "ngoài danh sách" theo danh sách cũ
      await page.waitForTimeout(3200);
      srv.snapFail = true;
      await scan(page, "1028260000000998");
      await page.waitForFunction(() => /Không tải được danh sách/.test(document.getElementById("vr-result").textContent));
      srv.snapFail = false;
      // Danh sách đổi trên máy chủ trong lúc máy giữ bản cũ (review vòng 3): mã của danh sách mới → STALE_LIST → tải lại → nhận
      srv.list = { ...srv.list, id: "55555555-5555-4555-8555-555555555555" };
      const staleBefore = srv.calls.filter(c => c.rpc === "vendor_return_scan").length;
      await scan(page, "1028260000000202");
      await page.waitForFunction(() => /Đúng · Black/.test(document.getElementById("vr-result").textContent), null, { timeout: 10000 });
      const staleCalls = srv.calls.filter(c => c.rpc === "vendor_return_scan").slice(staleBefore).map(c => c.args.p_list_id);
      assert.deepEqual(staleCalls, [LIST.id, "55555555-5555-4555-8555-555555555555"], "STALE_LIST → tải lại → quét lại với danh sách mới");
      // Mã có tiền tố / chữ → không hợp lệ (không tự bỏ ký tự để thành mã khác)
      await scan(page, "PO-1028260000000202");
      await page.waitForFunction(() => document.getElementById("vr-result").textContent.includes("Mã không hợp lệ"));
      // Pop-up kết quả (24/10/2026): lỗi ở lại tới khi bấm Đóng, rồi ô quét lấy lại con trỏ
      assert.equal(await page.locator("#vr-pop").isVisible(), true, "lỗi: pop-up ở lại");
      await shot(page, `tra-ncc-pop-${width}`);
      await page.locator("#vr-result .vr-result__close").click();
      assert.equal(await page.locator("#vr-pop").isVisible(), false, "Đóng → ẩn pop-up");
      await page.waitForFunction(() => document.activeElement?.id === "vr-code");
      // Navy đã quét đủ → lọc Navy không còn thẻ vị trí
      await page.locator('[data-vr-color="navy"]').click();
      assert.equal(await page.locator("#vr-locs .vr-loc").count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: không tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Admin nạp Excel: chỉ sheet tên chứa navy / black, bỏ dòng pivot (không phải mã), bỏ sheet khác
    {
      const { context, page, errors, srv } = await open(browser, { admin: true });
      await page.locator('[data-vr-tab="list"]').click();
      await page.locator("#vr-admin-panel").waitFor({ state: "visible" });
      // Đối chiếu (Admin): đọc WMS qua Extension → chỉ gửi mã thuộc danh sách → vị trí hiện tại đổi, đếm "Về F0-VR", nhóm đích
      assert.equal(await page.locator("#vr-reconcile").isVisible(), true, "Admin: có nút Đối chiếu");
      assert.equal(await page.locator("#vr-vr").innerText(), "0/5");
      // WMS đổi dữ liệu trong lúc đọc (review vòng 1) → đọc lại tối đa 3 lần rồi báo đỏ, KHÔNG gọi vendor_return_reconcile (mốc không nâng)
      await page.evaluate(() => { window.__extDrift = true; });
      await page.locator("#vr-reconcile").click();
      await page.waitForFunction(() => /Chưa đối chiếu được: WMS đổi dữ liệu/.test(document.getElementById("vr-message").textContent), null, { timeout: 15000 });
      assert.equal(srv.reconciled, undefined, "đọc lệch: không lưu");
      assert.equal(await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_PAGE").length), 3, "đọc lại 3 lần");
      await page.evaluate(() => { window.__extDrift = false; window.__extCalls = []; });
      await page.locator("#vr-reconcile").click();
      await page.waitForFunction(() => /Đối chiếu xong/.test(document.getElementById("vr-message").textContent), null, { timeout: 15000 });
      assert.deepEqual(srv.reconciled.p_rows, [
        { groupUid: "1028260000000102", location: "F0-VR-00-00-00-00", status: "Blocked", updatedAt: "2026-10-24T02:30:00.000Z" },
        { groupUid: "1028260000000103", location: "", status: "Closed", updatedAt: "2026-10-24T02:20:00.000Z" },
      ], "chỉ mã thuộc danh sách; cùng giờ → id bản ghi lớn thắng; không vị trí vẫn gửi (rỗng)");
      assert.equal(srv.reconciled.p_list_id, LIST.id);
      assert.match(await page.locator("#vr-message").innerText(), /2 Group UID cập nhật · 1\/5 đã ở F0-VR-00-00-00-00 · 1 đã rời kho/, "số máy chủ cập nhật");
      assert.equal(await page.locator("#vr-vr").innerText(), "1/5");
      assert.match(await page.locator("#vr-info").innerText(), /Về F0-VR\s*1\/5[\s\S]*Đối chiếu WMS\s*\d{2}:\d{2}/);
      // Còn thiếu: vị trí → F0-VR (Đích) → Đã rời kho (người dùng chọn 24/10/2026, không tính Về F0-VR)
      await page.locator('[data-vr-tab="left"]').click();
      assert.equal(await page.locator('#vr-locs .vr-loc[data-target]').count(), 1, "thẻ vị trí đích F0-VR");
      assert.deepEqual(await locHeads(page), ["F0-KHO-000-00-00-01 2 cuộn", "F0-VR-00-00-00-00 Đích 1 cuộn", "Đã rời kho 1 cuộn"]);
      await page.locator('#vr-locs .vr-loc[data-out] summary').click();
      assert.match(await page.locator('#vr-locs .vr-loc[data-out] li').innerText(), /1028260000000103[\s\S]*Đã đóng/, "trạng thái WMS tiếng Việt");
      assert.match(await page.locator("#vr-listname").innerText(), /Đối chiếu/);
      await shot(page, "tra-ncc-doi-chieu-1280");
      const calls = await page.evaluate(() => window.__extCalls.filter(c => c.type === "GET_GROUP_UID_PAGE").map(c => c.payload));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].from, new Date(Date.parse(LIST_CREATED) - 24 * 3600e3).toISOString(), "đọc từ 1 ngày trước lúc nạp danh sách");
      await page.locator('[data-vr-tab="list"]').click();
      await page.evaluate(async () => {
        const enc = new TextEncoder(), x = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const row = (r, cells) => `<row r="${r}">${cells.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${r}" t="inlineStr"><is><t>${x(v)}</t></is></c>`).join("")}</row>`;
        const head = ["No.", "Group UID Code", "RFID Mapping", "Batch Code", "Roll Code", "Type", "Warehouse", "Location", "SKU Qty", "Product Qty", "SKU", "Barcode", "Product Name", "Qty"];
        const r = (n, code, sku) => [String(n), code, "", "L" + n, String(n), "Fabric Roll", "WH - MATERIAL - MTG", "F0-KHO-000-00-00-0" + n, "1", "1000", sku, "", "Vải giả", "1000"];
        const sheet = rows => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[head, ...rows].map((rr, i) => row(i + 1, rr)).join("")}</sheetData></worksheet>`;
        const navy = sheet([r(1, "1028260000000301", "900000496"), [...r(2, "1028260000000302", "900000496").slice(0, 13), ""], ["", "Row Labels", "Count of Roll Code"], ["", "2410010001", "9"], ["", "Grand Total", "2"]]);
        const black = sheet([r(1, "1028260000000401", "900000494")]);
        const other = sheet([r(1, "1028260000000501", "900000495")]);
        const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="tong hop" sheetId="1" r:id="rId1"/><sheet name="navy" sheetId="2" r:id="rId2"/><sheet name="black 900000494" sheetId="3" r:id="rId3"/><sheet name="navy cu" sheetId="4" r:id="rId4"/></sheets></workbook>`;
        const rel = (id, n) => `<Relationship Id="rId${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`;
        const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1, 1)}${rel(2, 2)}${rel(3, 3)}${rel(4, 4)}</Relationships>`;
        const bytes = window.PrintSkuZip.buildZip([{ name: "xl/workbook.xml", data: enc.encode(wb) }, { name: "xl/_rels/workbook.xml.rels", data: enc.encode(rels) }, { name: "xl/worksheets/sheet1.xml", data: enc.encode(other) }, { name: "xl/worksheets/sheet2.xml", data: enc.encode(navy) }, { name: "xl/worksheets/sheet3.xml", data: enc.encode(black) }, { name: "xl/worksheets/sheet4.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${row(1, ["Group UID Code"])}${row(2, ["1028260000000701"])}${row(3, ["2410010001"])}</sheetData></worksheet>`) }]);
        const dt = new DataTransfer(); dt.items.add(new File([bytes], "tra-ncc-moi.xlsx"));
        const input = document.getElementById("vr-file-input"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.locator("#vr-save").waitFor({ state: "visible" });
      assert.match(await page.locator("#vr-preview").innerText(), /Navy 2 · Black 1/);
      assert.match(await page.locator("#vr-preview").innerText(), /navy cu: không có cột SKU/, "sheet thiếu cột SKU bị bỏ (review vòng 2)");
      await shot(page, "tra-ncc-admin-1280");
      await page.locator("#vr-save").click();
      await page.locator("dialog.whd .whd-ok").click();   // thay danh sách đang dùng
      await page.waitForFunction(() => /Đã lưu/.test(document.getElementById("vr-message").textContent));
      const imp = srv.imported;
      assert.equal(imp.p_file_name, "tra-ncc-moi.xlsx");
      assert.deepEqual(imp.p_items.map(i => [i.groupUid, i.color, i.sku, i.lot, i.roll, i.location, i.qty]), [
        ["1028260000000301", "navy", "900000496", "L1", "1", "F0-KHO-000-00-00-01", 1000],
        ["1028260000000302", "navy", "900000496", "L2", "2", "F0-KHO-000-00-00-02", null],
        ["1028260000000401", "black", "900000494", "L1", "1", "F0-KHO-000-00-00-01", 1000],
      ], "chỉ sheet navy / black, bỏ dòng pivot (kể cả nhãn toàn số), Qty trống → null, bỏ sheet khác");
      assert.equal(srv.calls.find(c => c.rpc === "vendor_return_import").auth, "Bearer test-admin-token", "nạp bằng phiên Admin");
      await page.waitForFunction(() => document.getElementById("vr-navy").textContent.trim() === "0/2");
      assert.deepEqual(await counts(page), ["0/2", "0/1"]);
      // Mã trùng giữa hai sheet → báo trùng, không có nút Lưu
      await page.evaluate(async () => {
        const enc = new TextEncoder(), x = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const row = (r, cells) => `<row r="${r}">${cells.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${r}" t="inlineStr"><is><t>${x(v)}</t></is></c>`).join("")}</row>`;
        const sheet = rows => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[["Group UID Code", "SKU"], ...rows].map((rr, i) => row(i + 1, rr)).join("")}</sheetData></worksheet>`;
        const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="navy" sheetId="1" r:id="rId1"/><sheet name="black" sheetId="2" r:id="rId2"/></sheets></workbook>`;
        const rel = n => `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`;
        const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel(1)}${rel(2)}</Relationships>`;
        const bytes = window.PrintSkuZip.buildZip([{ name: "xl/workbook.xml", data: enc.encode(wb) }, { name: "xl/_rels/workbook.xml.rels", data: enc.encode(rels) }, { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet([["1028260000000601", "900000496"]])) }, { name: "xl/worksheets/sheet2.xml", data: enc.encode(sheet([["1028260000000601", "900000494"]])) }]);
        const dt = new DataTransfer(); dt.items.add(new File([bytes], "trung.xlsx"));
        const input = document.getElementById("vr-file-input"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.waitForFunction(() => /Trùng 1 Group UID/.test(document.getElementById("vr-preview").textContent));
      assert.equal(await page.locator("#vr-save").count(), 0, "mã trùng: không cho lưu");
      await page.locator("#vr-cancel").click();
      assert.equal(await page.locator("#vr-preview").isVisible(), false, "Huỷ đóng xem trước");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Admin xoá đợt (26/10/2026, vendor_return_v3): nút chỉ có khi Admin + có danh sách; hộp xác nhận nêu tên tệp + số đã quét; Giữ = không gọi máy chủ;
    // Xoá → vendor_return_delete bằng phiên Admin với đúng mã đợt, màn về "Chưa có danh sách" (lượt quét xoá theo ở máy chủ giả)
    {
      const { context, page, errors, srv } = await open(browser, { admin: true });
      await page.locator('[data-vr-tab="list"]').click();
      await page.locator("#vr-delete").waitFor({ state: "visible" });
      await page.locator("#vr-delete").click();
      const dlg = page.locator("dialog.whd");
      await dlg.waitFor({ state: "visible" });
      const text = await dlg.innerText();
      assert.match(text, /Xoá đợt trả NCC\?/);
      assert.match(text, /tra-ncc-gia\.xlsx/);
      assert.match(text, /5 Group UID · 1 đã quét/, "nêu số lượt quét sẽ mất");
      assert.equal(await dlg.evaluate(d => d.dataset.tone), "danger");
      await shot(page, "tra-ncc-xoa-dot-1280");
      await dlg.locator(".whd-cancel").click();
      await dlg.waitFor({ state: "hidden" });
      assert.equal(srv.calls.some(c => c.rpc === "vendor_return_delete"), false, "Giữ: không gọi máy chủ");
      assert.equal(await page.locator("#vr-total").innerText(), "5", "Giữ: danh sách còn nguyên");
      await page.locator("#vr-delete").click();
      await dlg.locator(".whd-ok").click();
      await page.waitForFunction(() => /Đã xoá đợt/.test(document.getElementById("vr-message").textContent));
      const del = srv.calls.find(c => c.rpc === "vendor_return_delete");
      assert.deepEqual(del.args, { p_list_id: LIST.id }, "gửi đúng mã đợt đang hiện");
      assert.equal(del.auth, "Bearer test-admin-token", "xoá bằng phiên Admin, không phải khoá công khai");
      assert.match(await page.locator("#vr-message").innerText(), /Đã xoá đợt tra-ncc-gia\.xlsx · 5 Group UID · 1 lượt quét/);
      assert.equal(await page.locator("#vr-total").innerText(), "—");
      assert.equal(await page.locator("#vr-file").innerText(), "Chưa có danh sách");
      assert.equal(await page.locator("#vr-delete").isVisible(), false, "hết danh sách: ẩn Xoá đợt");
      assert.equal(await page.locator("#vr-pick").isVisible(), true, "vẫn nạp được danh sách mới");
      await page.locator('[data-vr-tab="left"]').click();
      assert.match(await page.locator("#vr-locs").innerText(), /Chưa có danh sách/);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Xoá đợt khi máy chủ từ chối / danh sách đã đổi / đã bị xoá: báo rõ, không giả "đã xoá", không xoá nhầm đợt khác
    {
      const { context, page, errors, srv } = await open(browser, { admin: true });
      await page.locator('[data-vr-tab="list"]').click();
      const confirmDelete = async () => { await page.locator("#vr-delete").click(); await page.locator("dialog.whd .whd-ok").click(); };
      const said = re => page.waitForFunction(s => new RegExp(s).test(document.getElementById("vr-message").textContent), re.source);
      srv.deleteMode = "forbidden";
      await confirmDelete();
      await said(/Chưa xoá được: Chỉ Admin/);
      assert.equal(await page.locator("#vr-total").innerText(), "5", "bị từ chối: danh sách còn nguyên");
      assert.equal(await page.locator("#vr-delete").isDisabled(), false, "bị từ chối: nút mở lại");
      srv.deleteMode = "stale";
      await confirmDelete();
      await said(/vừa đổi sang đợt khác, chưa xoá gì/);
      assert.equal(await page.locator("#vr-file").innerText(), "tra-ncc-khac.xlsx", "tải lại thấy đợt mới, không xoá nhầm");
      srv.deleteMode = ""; srv.list = null; srv.items = [];
      await confirmDelete();
      await said(/đã được xoá trước đó/);
      assert.equal(await page.locator("#vr-total").innerText(), "—", "đợt đã bị xoá nơi khác: tải lại → trống");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Review c9e790d vòng 1 (26/10/2026), G1: mất phản hồi / hết giờ chờ / cổng 502 sau khi máy chủ ĐÃ xoá → "Chưa rõ" + đối soát bằng tải lại, KHÔNG báo "Chưa xoá được";
    // đợt còn nguyên → "vẫn đang hiện"; đợt mới do Admin khác nạp → nêu tên đợt đang hiện (chặn bấm xoá nhầm theo thông báo sai)
    for (const [mode, fast, expect, total] of [
      ["lose-after", false, /Chưa rõ kết quả xoá · đợt tra-ncc-gia\.xlsx không còn trên máy chủ \(có thể đã xoá\)\.$/, "—"],
      ["gateway-after", false, /Chưa rõ kết quả xoá · đợt tra-ncc-gia\.xlsx không còn trên máy chủ/, "—"],
      ["slow-after", true, /Chưa rõ kết quả xoá · đợt tra-ncc-gia\.xlsx không còn trên máy chủ/, "—"],   // TimeoutError mang code số 23
      ["lose-after-new", false, /không còn trên máy chủ \(có thể đã xoá\) · đang hiện tra-ncc-khac\.xlsx\.$/, "5"],
      ["lose-before", false, /Chưa rõ kết quả xoá · đợt tra-ncc-gia\.xlsx vẫn đang hiện\.$/, "5"],
    ]) {
      const { context, page, errors, srv } = await open(browser, { admin: true, fastTimeout: fast });
      await page.locator('[data-vr-tab="list"]').click();
      srv.deleteMode = mode;
      await page.locator("#vr-delete").click(); await page.locator("dialog.whd .whd-ok").click();
      await page.waitForFunction(() => /Chưa rõ kết quả xoá|Chưa xoá được/.test(document.getElementById("vr-message").textContent), null, { timeout: 10000 });
      const msg = (await page.locator("#vr-message").innerText()).trim();
      assert.doesNotMatch(msg, /Chưa xoá được/, `${mode}: lỗi bất định không được báo chắc là chưa xoá`);
      assert.match(msg, expect, mode);
      assert.equal(await page.locator("#vr-message .ps-retry").count(), 1, `${mode}: có nút Thử lại (tải lại để kiểm)`);
      assert.equal(await page.locator("#vr-delete").isDisabled(), false, `${mode}: nút mở lại`);
      assert.equal(await page.locator("#vr-total").innerText(), total, `${mode}: màn theo máy chủ sau khi tải lại`);
      if (mode === "lose-after-new") assert.equal(await page.locator("#vr-file").innerText(), "tra-ncc-khac.xlsx");
      assert.deepEqual(errors, [], mode);
      await context.close();
    }

    // G2: xoá thành công nhưng tải lại lỗi → "Đã xoá…" kèm "chưa tải lại được danh sách", GIỮ nút Thử lại, màn bỏ đợt cũ; Thử lại → tải lại thật
    {
      const { context, page, errors, srv } = await open(browser, { admin: true });
      await page.locator('[data-vr-tab="list"]').click();
      await page.locator("#vr-delete").click();
      srv.snapFail = true;
      await page.locator("dialog.whd .whd-ok").click();
      await page.waitForFunction(() => /Đã xoá đợt/.test(document.getElementById("vr-message").textContent));
      assert.match((await page.locator("#vr-message").innerText()).trim(), /Đã xoá đợt tra-ncc-gia\.xlsx · 5 Group UID · 1 lượt quét · chưa tải lại được danh sách\.$/);
      assert.equal(await page.locator("#vr-message .ps-retry").count(), 1, "giữ nút Thử lại sau khi báo đã xoá");
      assert.equal(await page.locator("#vr-file").innerText(), "Chưa có danh sách", "không còn hiện đợt đã xoá");
      srv.snapFail = false;
      const snaps = () => srv.calls.filter(c => c.rpc === "vendor_return_snapshot").length, before = snaps();
      await page.locator("#vr-message .ps-retry").click();
      await page.waitForTimeout(600);
      assert.ok(snaps() > before, "Thử lại tải lại danh sách");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // G3a: bản chụp đã cũ (> 3 s), đợt bị xoá trên máy chủ → mã lạ → tải lại thấy không còn đợt → "Chưa có danh sách" (không phải "Không thuộc danh sách trả")
    {
      const { context, page, errors, srv } = await open(browser);
      await page.waitForTimeout(3300);
      srv.list = null; srv.items = [];
      await scan(page, "1028260000000999");
      await page.waitForFunction(() => document.getElementById("vr-result").dataset.tone === "bad");
      assert.equal((await result(page)).title, "Chưa có danh sách");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // G3c: máy quét nhận NO_LIST nhưng tải lại thấy đợt mới (Admin xoá rồi nạp lại) → quét lại ngay với đợt mới, không báo "Chưa có danh sách"
    {
      const { context, page, errors, srv } = await open(browser);
      const NEXT = "66666666-6666-4666-8666-666666666666";
      srv.noListOnce = true; srv.nextList = { ...LIST, id: NEXT, fileName: "tra-ncc-nap-lai.xlsx" }; srv.nextItems = ITEMS();
      await scan(page, "1028260000000102");
      await page.waitForFunction(() => document.getElementById("vr-result").dataset.tone === "ok", null, { timeout: 10000 });
      assert.equal((await result(page)).title, "Đúng · Navy");
      assert.deepEqual(srv.calls.filter(c => c.rpc === "vendor_return_scan").map(c => c.args.p_list_id), [LIST.id, NEXT], "NO_LIST → tải lại → quét lại với đợt mới");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // G3d (Codex): NO_LIST + tải lại lỗi → máy chủ đã nói không còn đợt cũ → bỏ bản chụp cũ (không giữ màn đợt đã xoá), báo "chưa tải lại được"
    {
      const { context, page, errors, srv } = await open(browser);
      srv.list = null; srv.items = []; srv.snapFail = true;
      await scan(page, "1028260000000102");
      await page.waitForFunction(() => document.getElementById("vr-result").dataset.tone === "bad");
      assert.deepEqual(await result(page), { tone: "bad", title: "Chưa có danh sách", note: "Danh sách đã bị xoá · chưa tải lại được" });
      assert.equal(await page.locator("#vr-total").innerText(), "—", "bỏ bản chụp của đợt đã bị xoá");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // G5: một cờ bận chung cho nhóm Admin — Đối chiếu đang đọc WMS thì Xoá / Nạp bị khoá; xoá đang chờ máy chủ thì Đối chiếu bị khoá (không thoát im lặng, không đè thông báo nhau)
    {
      const { context, page, errors, srv } = await open(browser, { admin: true });
      await page.locator('[data-vr-tab="list"]').click();
      await page.evaluate(() => { window.__extSlow = 1500; });
      await page.locator("#vr-reconcile").click();
      await page.waitForFunction(() => document.getElementById("vr-reconcile").disabled);
      for (const id of ["vr-delete", "vr-pick"]) assert.equal(await page.locator(`#${id}`).isDisabled(), true, `${id}: khoá khi Đối chiếu đang chạy`);
      await page.waitForFunction(() => /Đối chiếu xong/.test(document.getElementById("vr-message").textContent), null, { timeout: 15000 });
      for (const id of ["vr-delete", "vr-pick", "vr-reconcile"]) assert.equal(await page.locator(`#${id}`).isDisabled(), false, `${id}: mở lại khi xong`);
      srv.deleteDelay = 1200;
      await page.locator("#vr-delete").click(); await page.locator("dialog.whd .whd-ok").click();
      await page.waitForFunction(() => document.getElementById("vr-delete").disabled);
      assert.equal(await page.locator("#vr-reconcile").isDisabled(), true, "Đối chiếu bị khoá khi đang xoá");
      await page.waitForFunction(() => /Đã xoá đợt/.test(document.getElementById("vr-message").textContent), null, { timeout: 10000 });
      assert.equal(await page.locator("#vr-reconcile").isDisabled(), false, "xoá xong: mở lại");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Máy quét còn giữ đợt vừa bị Admin xoá: lượt quét → NO_LIST → tải lại → "Chưa có danh sách" (không báo đã lưu)
    {
      const { context, page, errors, srv } = await open(browser);
      srv.list = null; srv.items = [];
      await scan(page, "1028260000000102");
      await page.waitForFunction(() => document.getElementById("vr-total").textContent.trim() === "—");
      assert.deepEqual(await result(page), { tone: "bad", title: "Chưa có danh sách", note: "Danh sách đã bị xoá" });
      assert.equal(srv.calls.filter(c => c.rpc === "vendor_return_scan").length, 1);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("vendor_return_browser: thẻ Navy/Black, đánh dấu dòng đã quét, ngoài danh sách đỏ, trùng báo máy, mã mới gửi khoá máy + chuyển tab, bị từ chối không đánh dấu, Admin nạp Excel (sheet navy/black, bỏ pivot), Admin xoá đợt (xác nhận, Giữ, bị từ chối, đợt đã đổi / đã xoá, mất phản hồi / hết giờ / 502 báo \"chưa rõ\" + đối soát, xoá xong tải lại lỗi giữ Thử lại, cờ bận chung), máy quét thấy NO_LIST (tải lại thấy đợt mới thì quét lại, tải lại lỗi thì bỏ bản chụp cũ, bản chụp cũ thấy hết đợt); 1280 / 390 — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
