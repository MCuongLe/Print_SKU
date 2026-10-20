// LỰA UID BLOCKED (20/10/2026, docs/plans/2026-10-20-lua-uid-blocked.md, khối #uid-block-script).
//   * ô trang chủ + #uid-block; danh sách blocked tải về máy (uid_block_snapshot, cache kiểm phiên bản khoá "uid_block");
//   * máy scan bắn mã (kèm tiền tố / Enter) vào khung quét: UID trong danh sách → thẻ đỏ BLOCKED + SKU/Lot/Roll/kho/vị trí, ghi "Đã lựa";
//     quét lại → thẻ vàng "đã lựa lúc …"; UID ngoài danh sách → thẻ xanh; mã không phải Group UID → thẻ cảnh báo;
//   * lượt quét lưu Supabase dùng chung (uid_block_scan kèm khoá máy; uid_block_scans đồng bộ): máy khác đã scan → thẻ vàng ĐÃ SCAN + tên máy;
//     máy chưa kích hoạt → thẻ đỏ "chưa ghi nhận", không tính đã lựa; mất mạng → thẻ đỏ + hàng chờ, có mạng lại tự gửi;
//   * lượt quét đọc lại từ máy chủ sau tải lại trang; danh sách mới (listId khác) → lượt theo danh sách mới;
//   * Admin nạp Excel: đọc MỌI sheet theo workbook.xml.rels, dòng tiêu đề nằm dưới dòng tên báo cáo, lấy Status = Blocked, bỏ trùng, đếm mã lỗi;
//     xem trước + đối chiếu (uid_block_compare; đang chờ thì khoá Lưu, lỗi thì không hiện số 0); Lưu → uid_block_import.
// Supabase giả lập, dữ liệu giả (Group UID 1028260000000xxx, SKU 9000000xx). Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const item = (n, extra = {}) => ({ groupUid: `10282600000001${String(n).padStart(2, "0")}`, sku: `90000000${n}`, productName: `Vải giả ${n}`, lot: `L${n}`, roll: `R${n}`, warehouse: "WH - MATERIAL - MTG", location: `F0-A0-00-00-00-0${n}`, fileStatus: "Blocked", ...extra });
const LIST_A = { list: { id: "11111111-1111-4111-8111-111111111111", fileName: "danh-sach-gia-A.xlsx", sheets: ["blocked"], itemCount: 3, byWarehouse: { "WH - MATERIAL - MTG": 3 }, importedAt: "2026-10-20T01:00:00+00:00" }, items: [item(1), item(2), item(3)] };
const LIST_B = { list: { id: "22222222-2222-4222-8222-222222222222", fileName: "danh-sach-gia-B.xlsx", sheets: ["blocked"], itemCount: 1, byWarehouse: { "WH - MATERIAL - GARMENT": 1 }, importedAt: "2026-10-20T02:00:00+00:00" }, items: [item(9, { warehouse: "WH - MATERIAL - GARMENT" })] };
const settle = ms => new Promise(r => setTimeout(r, ms));
const DEVICE = "pd_test_device";

const open = async (browser, srv, { width = 1280, height = 900, admin = false } = {}) => {
  const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 800, hasTouch: width < 800 });
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "test-refresh-token" })), SESSION_KEY);
  if (srv.device !== false) await context.addInitScript(t => { if (!localStorage.getItem("tb-khoa")) localStorage.setItem("tb-khoa", t); }, DEVICE);
  srv.scans = srv.scans || {};
  const page = await context.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", async route => {
    const req = route.request(), url = req.url(), json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/auth/v1/user")) return json({ id: "test-admin" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Test Admin", role: "admin" }]);
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_0-9]+)/)?.[1];
    const body = JSON.parse(req.postData() || "{}");
    if (rpc) srv.calls.push({ rpc, body, admin: /test-admin-token/.test(req.headers().authorization || "") });
    if (rpc === "uid_block_snapshot") {
      if (srv.offline) return route.abort("internetdisconnected");
      const cur = srv.list;
      return json({ ok: true, data: cur && body.p_known_list_id === cur.list.id ? { unchanged: true, listId: cur.list.id } : { unchanged: false, ...(cur || { list: null, items: [] }) } });
    }
    if (rpc === "uid_block_scan") {
      if (srv.offlineScan) return route.abort("internetdisconnected");
      if (srv.scanHtml) return route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>Wi-Fi login</body></html>" });
      if (srv.scanDelay) await settle(srv.scanDelay);
      if (body.p_access_token !== DEVICE) return json({ ok: false, error: { code: "ACCESS_DENIED", message: "Máy chưa kích hoạt" } });
      const cur = srv.list;
      if (!cur || body.p_list_id !== cur.list.id) return json({ ok: false, error: { code: "STALE_LIST", message: "Danh sách đã đổi", data: { listId: cur?.list.id } } });
      if (!cur.items.some(i => i.groupUid === body.p_group_uid)) return json({ ok: true, data: { result: "not_blocked", groupUid: body.p_group_uid } });
      const m = scansOf(srv, cur.list.id), had = m.get(body.p_group_uid);
      if (had) return json({ ok: true, data: { result: "dup", groupUid: body.p_group_uid, scannedAt: had.scannedAt, deviceName: had.deviceName, mine: had.device === body.p_access_token } });
      const row = { scannedAt: body.p_scanned_at || new Date().toISOString(), deviceName: "Máy test", device: body.p_access_token };
      m.set(body.p_group_uid, row);
      return json({ ok: true, data: { result: "new", groupUid: body.p_group_uid, scannedAt: row.scannedAt, deviceName: row.deviceName, mine: true } });
    }
    if (rpc === "uid_block_scans") {
      if (srv.offline) return route.abort("internetdisconnected");
      const m = srv.hideScans ? new Map() : scansOf(srv, body.p_list_id), count = m.size;
      if (body.p_known_count === count) return json({ ok: true, data: { listId: body.p_list_id, unchanged: true, count } });
      return json({ ok: true, data: { listId: body.p_list_id, unchanged: false, count, rows: [...m].map(([groupUid, r]) => ({ groupUid, scannedAt: r.scannedAt, deviceName: r.deviceName })) } });
    }
    if (rpc === "uid_block_compare") {
      if (srv.compareFail) return json({ ok: false, error: { code: "INTERNAL", message: "giả lập lỗi đối chiếu" } });
      if (srv.compareDelay) await settle(srv.compareDelay);
      const codes = body.p_codes || [];
      return json({ ok: true, data: { rows: codes.filter(c => c !== "1028260000000199").map(c => ({ groupUid: c, status: c.endsWith("103") ? "Available" : "Blocked", qcStatus: null, warehouse: "WH - MATERIAL - MTG", location: "F0-A0-00-00-00-01" })), missing: codes.filter(c => c === "1028260000000199"), blockedOutside: [{ groupUid: "1028260000000188", warehouse: "WH - MATERIAL - MTG", sku: "900000088" }], blockedOutsideTotal: 1 } });
    }
    if (rpc === "uid_block_import") { srv.imported = body; srv.list = { list: { ...LIST_A.list, id: "33333333-3333-4333-8333-333333333333", fileName: body.p_list.fileName, itemCount: body.p_items.length }, items: body.p_items.map(i => ({ ...i, fileStatus: "Blocked" })) }; return json({ ok: true, data: { listId: srv.list.list.id, itemCount: body.p_items.length, byWarehouse: {} } }); }
    if (url.includes("/rest/v1/") && !rpc) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
  return { context, page, errors };
};
const scansOf = (srv, id) => ((srv.scans = srv.scans || {})[id] = srv.scans[id] || new Map());
const picked = (page, n) => page.waitForFunction(v => document.getElementById("ub-picked").textContent.trim() === v, String(n), { timeout: 10000 });
const toneIs = (page, t) => page.waitForFunction(v => document.getElementById("ub-result").dataset.tone === v, t, { timeout: 10000 });
const scan = async (page, text) => { await page.locator("#ub-code").fill(text); await page.locator("#ub-form").press("Enter"); };
const tone = page => page.locator("#ub-result").getAttribute("data-tone");
const ready = page => page.waitForFunction(() => document.getElementById("ub-total")?.textContent?.trim() !== "—", null, { timeout: 15000 });

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      const srv = { calls: [], list: LIST_A };
      const { context, page, errors } = await open(browser, srv, { width, height });
      // 1) Ô trang chủ → màn
      await page.goto(BASE + "#home");
      await page.locator("#barcode-uid-block").click();
      await page.locator("#uid-block-screen").waitFor({ state: "visible" });
      assert.equal(await page.evaluate(() => location.hash), "#uid-block");
      assert.equal(await page.evaluate(() => document.getElementById("root")?.inert), true, "màn phủ khoá cây #root phía sau");
      await ready(page);
      assert.equal((await page.locator("#ub-total").innerText()).trim(), "3", `${width}: tổng UID của danh sách`);
      assert.match(await page.locator("#ub-file").innerText(), /danh-sach-gia-A\.xlsx/);
      // 2) Máy scan: UID blocked kèm tiền tố → thẻ đỏ + thông tin
      await scan(page, "UID:1028260000000101");
      assert.equal(await tone(page), "blocked");
      const card = (await page.locator("#ub-result").innerText()).replace(/\s+/g, " ");
      assert.match(card, /BLOCKED/); assert.match(card, /1028260000000101/); assert.match(card, /900000001/); assert.match(card, /L1/); assert.match(card, /R1/); assert.match(card, /F0-A0-00-00-00-01/);
      assert.equal((await page.locator("#ub-picked").innerText()).trim(), "1");
      assert.equal((await page.locator("#ub-left").innerText()).trim(), "2");
      const sent = srv.calls.find(c => c.rpc === "uid_block_scan");
      assert.equal(sent.body.p_access_token, DEVICE, "ghi lượt quét kèm khoá máy");
      assert.equal(sent.body.p_list_id, LIST_A.list.id);
      assert.equal(scansOf(srv, LIST_A.list.id).has("1028260000000101"), true, "lượt quét lưu trên máy chủ");
      // 3) Quét lại → đã lựa; UID ngoài danh sách → xanh; mã sai → cảnh báo
      await scan(page, "1028260000000101");
      assert.equal(await tone(page), "dup");
      assert.match(await page.locator("#ub-result").innerText(), /ĐÃ SCAN/);
      assert.match(await page.locator("#ub-result").innerText(), /Đã scan lúc/, "scan trùng → báo đã scan + giờ scan lần đầu");
      await scan(page, "1028260000000777");
      assert.equal(await tone(page), "ok");
      await scan(page, "ABC-123");
      assert.equal(await tone(page), "bad");
      // Review 20/10: mã dài hơn 16 số (vận đơn, mã khác) chứa UID blocked ở đầu → KHÔNG được cắt thành UID
      await scan(page, "10282600000001019");
      assert.equal(await tone(page), "bad", "mã 17 số → không phải Group UID");
      await scan(page, "10282600000001010000");
      assert.equal(await tone(page), "bad", "mã 20 số → không phải Group UID");
      assert.equal((await page.locator("#ub-picked").innerText()).trim(), "1", "chỉ UID blocked mới tính đã lựa");
      // 4) Tab Còn thiếu: gom theo vị trí (mỗi vị trí một nhóm, số cuộn còn), bảng 2 dòng; Đã lựa: 1 dòng
      await page.locator('[data-ub-tab="left"]').click();
      await page.waitForFunction(() => document.querySelectorAll("#ub-body tr").length === 2);
      const groups = await page.locator("#ub-groups [data-ub-loc]").evaluateAll(els => els.map(e => ({ loc: e.dataset.ubLoc, n: e.querySelectorAll("[data-ub-uid]").length, head: e.querySelector(".ub-loc__head")?.textContent.replace(/\s+/g, " ").trim() })));
      assert.deepEqual(groups.map(g => [g.loc, g.n]), [["F0-A0-00-00-00-02", 1], ["F0-A0-00-00-00-03", 1]], "gom theo vị trí, chỉ UID còn thiếu, xếp theo vị trí");
      assert.match(groups[0].head, /F0-A0-00-00-00-02.*1/);
      await page.locator('[data-ub-tab="picked"]').click();
      await page.waitForFunction(() => document.querySelectorAll("#ub-body tr").length === 1 && /1028260000000101/.test(document.getElementById("ub-body").textContent));
      // 5) Tải lại trang: lượt quét đọc lại từ máy chủ, chỉ hỏi phiên bản danh sách (gửi mã danh sách đang giữ)
      srv.calls.length = 0;
      await page.reload(); await ready(page); await picked(page, 1);
      assert.equal(srv.calls.find(c => c.rpc === "uid_block_snapshot")?.body.p_known_list_id, LIST_A.list.id);
      // 6) Máy khác (3 người quét chung): 102 đã scan trên máy chủ → đồng bộ về, quét 102 → ĐÃ SCAN + tên máy; 103 máy khác vừa scan
      //    (máy này chưa đồng bộ) → máy chủ trả dup → ĐÃ SCAN, không phải BLOCKED
      scansOf(srv, LIST_A.list.id).set("1028260000000102", { scannedAt: "2026-10-20T03:04:05+00:00", deviceName: "Máy B", device: "pd_b" });
      await page.reload(); await ready(page); await picked(page, 2);
      await scan(page, "1028260000000102");
      await toneIs(page, "dup");
      assert.match(await page.locator("#ub-result").innerText(), /Máy B/, "báo máy đã scan trước");
      scansOf(srv, LIST_A.list.id).set("1028260000000103", { scannedAt: "2026-10-20T03:05:00+00:00", deviceName: "Máy C", device: "pd_c" });
      await scan(page, "1028260000000103");
      await page.waitForFunction(() => /1028260000000103/.test(document.getElementById("ub-result").textContent), null, { timeout: 10000 });
      assert.equal(await tone(page), "dup");
      assert.match(await page.locator("#ub-result").innerText(), /Máy C/, "máy chủ báo trùng → ĐÃ SCAN dù máy này chưa đồng bộ");
      scansOf(srv, LIST_A.list.id).delete("1028260000000102"); scansOf(srv, LIST_A.list.id).delete("1028260000000103");
      // 7) Mất mạng khi ghi: vẫn báo BLOCKED + chờ gửi; có mạng lại → tự gửi lên máy chủ
      await page.reload(); await ready(page); await picked(page, 1);
      srv.offlineScan = true;
      await scan(page, "1028260000000102");
      await toneIs(page, "blocked");
      await page.waitForFunction(() => /Chưa gửi được/.test(document.getElementById("ub-result").textContent), null, { timeout: 10000 });
      assert.equal(scansOf(srv, LIST_A.list.id).has("1028260000000102"), false);
      srv.offlineScan = false;
      await page.reload(); await ready(page); await picked(page, 2);
      await page.waitForFunction(() => !JSON.parse(localStorage.getItem("uid-block-cho-gui") || "[]").length, null, { timeout: 10000 });
      assert.equal(scansOf(srv, LIST_A.list.id).has("1028260000000102"), true, "hàng chờ tự gửi khi có mạng");
      // 8) Mất mạng cả danh sách lẫn ghi: vẫn quét theo bản trên máy, nhớ lượt đã scan
      srv.offline = true; srv.offlineScan = true;
      await page.reload(); await ready(page);
      await scan(page, "1028260000000101");
      await toneIs(page, "dup");
      await scan(page, "1028260000000103");
      await toneIs(page, "blocked");
      srv.offline = false; srv.offlineScan = false;
      // 9) Danh sách mới trên máy chủ → lượt theo danh sách mới
      srv.list = LIST_B;
      await page.reload();
      await page.waitForFunction(() => document.getElementById("ub-total")?.textContent?.trim() === "1");
      await picked(page, 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: không tràn ngang`);
      // Màn có overflow-x:auto nên document không tràn dù nội dung tràn — đo chính màn (ảnh 390 ngày 20/10 bị cắt mép phải).
      for (const tab of ["scan", "left", "list"]) {
        await page.locator(`[data-ub-tab="${tab}"]`).click();
        assert.equal(await page.evaluate(() => { const s = document.getElementById("uid-block-screen"); return s.scrollWidth <= s.clientWidth; }), true, `${width} tab ${tab}: màn không tràn ngang`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 8) Admin nạp Excel nhiều sheet: lấy dòng Status = Blocked, bỏ trùng; xem trước + đối chiếu; Lưu
    {
      const srv = { calls: [], list: LIST_A, compareDelay: 800 };
      const { context, page, errors } = await open(browser, srv, { admin: true });
      await page.goto(BASE + "#uid-block"); await ready(page);
      await page.locator('[data-ub-tab="list"]').click();
      await page.locator("#ub-import").waitFor({ state: "visible" });
      await page.evaluate(async () => {
        const enc = new TextEncoder(), x = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
        const row = (r, cells) => `<row r="${r}">${cells.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${r}" t="inlineStr"><is><t>${x(v)}</t></is></c>`).join("")}</row>`;
        const head = ["No.", "Group UID Code", "Batch Code", "Roll Code", "Warehouse", "Location", "SKU", "Product Name", "Status"];
        const sheet = rows => `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${[["Danh sách Group UID kho Material"], ["Group UID Code"], head, ...rows].map((r, i) => row(i + 1, r)).join("")}</sheetData></worksheet>`;
        const s1 = sheet([["1", "1028260000000101", "L1", "R1", "WH - MATERIAL - MTG", "F0-A0-00-00-00-01", "900000001", "Vải giả 1", "Blocked"], ["2", "1028260000000103", "L3", "R3", "WH - MATERIAL - MTG", "F0-A0-00-00-00-03", "900000003", "Vải giả 3", "Blocked"], ["3", "1.02826E+15", "L4", "R4", "WH - MATERIAL - MTG", "F0-A0-00-00-00-04", "900000004", "Vải giả 4", "Blocked"]]);
        const s2 = sheet([["1", "1028260000000101", "L1", "R1", "WH - MATERIAL - MTG", "F0-A0-00-00-00-01", "900000001", "Vải giả 1", "Blocked"], ["2", "1028260000000150", "L5", "R5", "WH - MATERIAL - GARMENT", "F0-B0-00-00-00-05", "900000005", "Vải giả 5", "Available"], ["3", "1028260000000199", "L9", "R9", "WH - MATERIAL - GARMENT", "F0-B0-00-00-00-09", "900000009", "Vải giả 9", "blocked"]]);
        const wb = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="blocked-QC fail" sheetId="1" r:id="rId1"/><sheet name="toan-kho" sheetId="2" r:id="rId2"/></sheets></workbook>`;
        // Quan hệ đảo: sheet "blocked-QC fail" (rId1) nằm ở tệp sheet2.xml, "toan-kho" (rId2) ở sheet1.xml
        const rels = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
        const bytes = window.PrintSkuZip.buildZip([{ name: "xl/workbook.xml", data: enc.encode(wb) }, { name: "xl/_rels/workbook.xml.rels", data: enc.encode(rels) }, { name: "xl/worksheets/sheet2.xml", data: enc.encode(s1) }, { name: "xl/worksheets/sheet1.xml", data: enc.encode(s2) }]);
        const file = new File([bytes], "danh-sach-gia-moi.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const dt = new DataTransfer(); dt.items.add(file);
        const input = document.getElementById("ub-file-input"); input.files = dt.files; input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.locator("#ub-preview").waitFor({ state: "visible", timeout: 10000 });
      assert.equal(await page.locator("#ub-save").isDisabled(), true, "đang đối chiếu → khoá Lưu");
      await page.waitForFunction(() => /1028260000000188/.test(document.getElementById("ub-preview").textContent), null, { timeout: 10000 });
      assert.equal(await page.locator("#ub-save").isDisabled(), false);
      const preview = (await page.locator("#ub-preview").innerText()).replace(/\s+/g, " ");
      assert.match(preview, /Sheet blocked-QC fail 2 dòng · 1 mã lỗi/, "tên sheet theo workbook.xml.rels, đếm ô Group UID lỗi");
      assert.match(preview, /Sheet toan-kho 2 dòng · bỏ 1/);
      assert.match(preview, /3 UID/, "3 UID blocked (bỏ trùng, bỏ Available, nhận 'blocked' chữ thường)");
      assert.match(preview, /1028260000000103[\s\S]*Available/, "đối chiếu: UID trong tệp mà WMS hiện Available");
      assert.match(preview, /1028260000000199/, "đối chiếu: UID không có trên WMS");
      assert.match(preview, /1028260000000188/, "đối chiếu: Blocked trên WMS ngoài tệp");
      await page.locator("#ub-save").click();
      await page.waitForFunction(() => document.getElementById("ub-total")?.textContent?.trim() === "3" && /danh-sach-gia-moi\.xlsx/.test(document.getElementById("ub-file").textContent), null, { timeout: 10000 });
      assert.deepEqual(srv.imported.p_items.map(i => i.groupUid).sort(), ["1028260000000101", "1028260000000103", "1028260000000199"]);
      assert.equal(srv.imported.p_list.fileName, "danh-sach-gia-moi.xlsx");
      assert.deepEqual(srv.imported.p_list.sheets, ["blocked-QC fail", "toan-kho"]);
      assert.equal(srv.calls.find(c => c.rpc === "uid_block_import").admin, true, "lưu bằng token Admin");
      // Đối chiếu lỗi → báo lỗi riêng, không dựng bảng số 0 như đã khớp
      srv.compareFail = true; srv.compareDelay = 0;
      await page.locator("#ub-compare").click();
      await page.waitForFunction(() => /Chưa đối chiếu được/.test(document.getElementById("ub-compare-out").textContent), null, { timeout: 10000 });
      assert.doesNotMatch(await page.locator("#ub-compare-out").innerText(), /Khớp Blocked/);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 10) Máy chưa kích hoạt: vẫn báo BLOCKED nhưng "chưa ghi nhận", không tính đã lựa, không lưu máy chủ
    {
      const srv = { calls: [], list: LIST_A, device: false };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#uid-block"); await ready(page);
      await scan(page, "1028260000000101");
      await page.waitForFunction(() => /máy chưa kích hoạt/.test(document.getElementById("ub-result").textContent), null, { timeout: 10000 });
      assert.equal(await tone(page), "blocked");
      assert.equal((await page.locator("#ub-picked").innerText()).trim(), "0");
      assert.equal(scansOf(srv, LIST_A.list.id).size, 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 12) Review vòng 2: lượt trùng của CHÍNH máy khi bản trên máy trống → ĐÃ SCAN (không báo BLOCKED lựa lại); trang portal Wi-Fi
    //     trả HTML → giữ hàng chờ + chip "Chờ gửi", có mạng thật thì gửi; kết quả về sau 2 giây → vẽ lại thẻ thành ĐÃ SCAN
    {
      const srv = { calls: [], list: LIST_A, hideScans: true };
      scansOf(srv, LIST_A.list.id).set("1028260000000101", { scannedAt: "2026-10-20T01:30:00+00:00", deviceName: "Máy test", device: DEVICE });
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#uid-block"); await ready(page);
      await scan(page, "1028260000000101");
      await page.waitForFunction(() => /1028260000000101/.test(document.getElementById("ub-result").textContent), null, { timeout: 10000 });
      assert.equal(await tone(page), "dup", "máy chủ trả dup + mine (lượt cũ) → ĐÃ SCAN");
      srv.scanHtml = true;
      await scan(page, "1028260000000102");
      await page.waitForFunction(() => /1028260000000102[\s\S]*Chưa gửi được/.test(document.getElementById("ub-result").textContent), null, { timeout: 10000 });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("uid-block-cho-gui") || "[]").length), 1, "trang portal → giữ hàng chờ");
      assert.match(await page.locator("#ub-pending").innerText(), /Chờ gửi 1/);
      // Codex vòng 3: quét lại lượt còn chờ gửi → ĐÃ SCAN nhưng ghi rõ "chờ gửi" (máy chủ chưa có), hàng chờ giữ nguyên
      await scan(page, "1028260000000102");
      await toneIs(page, "dup");
      assert.match(await page.locator("#ub-result").innerText(), /chờ gửi/);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("uid-block-cho-gui") || "[]").length), 1);
      srv.scanHtml = false;
      await page.evaluate(() => dispatchEvent(new Event("online")));
      await page.waitForFunction(() => !JSON.parse(localStorage.getItem("uid-block-cho-gui") || "[]").length, null, { timeout: 10000 });
      assert.equal(scansOf(srv, LIST_A.list.id).has("1028260000000102"), true);
      assert.equal(await page.locator("#ub-pending").isVisible(), false);
      scansOf(srv, LIST_A.list.id).set("1028260000000103", { scannedAt: "2026-10-20T03:05:00+00:00", deviceName: "Máy C", device: "pd_c" });
      srv.scanDelay = 2600;
      await scan(page, "1028260000000103");
      await page.waitForFunction(() => /1028260000000103/.test(document.getElementById("ub-result").textContent) && document.getElementById("ub-result").dataset.tone === "blocked", null, { timeout: 1000 });
      await page.waitForFunction(() => document.getElementById("ub-result").dataset.tone === "dup", null, { timeout: 10000 });
      assert.match(await page.locator("#ub-result").innerText(), /Máy C/, "kết quả về muộn vẽ lại thẻ ĐÃ SCAN");
      assert.match(await page.locator("#ub-recent li").first().innerText(), /1028260000000103[\s\S]*Đã scan/, "kết quả muộn sửa dòng Vừa quét");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 13) Cố vấn 20/10: máy chủ chậm → thẻ BLOCKED hiện NGAY theo danh sách trên máy; bắn lặp cùng mã → ĐÃ SCAN, lượt đầu vẫn có
    //     dòng "Blocked"; quét chen mã khác → lượt trước vẫn giữ dòng Blocked và được ghi lên máy chủ
    {
      const srv = { calls: [], list: LIST_A, scanDelay: 1500 };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#uid-block"); await ready(page);
      await scan(page, "1028260000000101");
      await page.waitForFunction(() => document.getElementById("ub-result").dataset.tone === "blocked", null, { timeout: 500 });
      await scan(page, "1028260000000101");
      await toneIs(page, "dup");
      await scan(page, "1028260000000102");
      await scan(page, "1028260000000777");
      await toneIs(page, "ok");
      await page.waitForFunction(() => [...document.querySelectorAll("#ub-recent li")].filter(li => /Blocked/.test(li.textContent) && !/chờ gửi|chưa ghi nhận/.test(li.textContent)).length === 2, null, { timeout: 10000 });
      const recent = await page.locator("#ub-recent li").evaluateAll(els => els.map(e => e.textContent.replace(/\s+/g, " ")));
      assert.ok(recent.some(t => /1028260000000101\s*Blocked/.test(t)), "lượt đầu 101 vẫn có dòng Blocked");
      assert.ok(recent.some(t => /1028260000000102\s*Blocked/.test(t)), "lượt 102 bị chen vẫn có dòng Blocked");
      for (let i = 0; i < 50 && !scansOf(srv, LIST_A.list.id).has("1028260000000102"); i++) await settle(100);
      assert.equal(scansOf(srv, LIST_A.list.id).has("1028260000000102"), true, "lượt bị chen vẫn ghi máy chủ");
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 11) Người không phải Admin không thấy nút Nạp Excel
    {
      const srv = { calls: [], list: LIST_A };
      const { context, page, errors } = await open(browser, srv);
      await page.goto(BASE + "#uid-block"); await ready(page);
      await page.locator('[data-ub-tab="list"]').click();
      assert.equal(await page.locator("#ub-import").isVisible(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("uid_block_browser: ô trang chủ → màn, máy scan (tiền tố) báo BLOCKED đỏ + thông tin, quét lại / ngoài danh sách / mã sai, Đã lựa / Còn thiếu, phiên giữ qua tải lại, mất mạng vẫn báo, danh sách mới → phiên mới, Admin nạp Excel nhiều sheet (Blocked, bỏ trùng) + đối chiếu + Lưu — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
