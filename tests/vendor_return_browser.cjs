// TÌM GROUP UID · Trả nhà cung cấp (24/10/2026, docs/plans/2026-10-24-tra-nha-cung-cap.md): danh sách Navy / Black (Admin nạp Excel),
// máy đã kích hoạt quét Group UID → đánh dấu; ngoài danh sách báo đỏ; trùng báo máy + giờ. Supabase giả lập, mã giả 1028260000000xxx.
//   node tests/vendor_return_browser.cjs   (máy chủ tĩnh cổng 8000, đổi bằng BASE)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");

const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SESSION_KEY = "print-sku-admin-session-v1";
const LIST = { id: "33333333-3333-4333-8333-333333333333", fileName: "tra-ncc-gia.xlsx", createdAt: "2026-10-24T01:00:00Z", itemCount: 5 };
const item = (code, color, extra = {}) => ({ groupUid: code, color, sku: color === "navy" ? "900000496" : "900000494", productName: "Vải giả", lot: "L1", roll: "1", location: "F0-KHO-000-00-00-01", qty: 1000, scannedAt: null, device: null, ...extra });
const ITEMS = () => [
  item("1028260000000101", "navy", { scannedAt: "2026-10-24T01:30:00Z", device: "Máy giả 1" }),
  item("1028260000000102", "navy"),
  item("1028260000000103", "navy"),
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
    if (args.p_list_id !== srv.list.id) return json({ ok: false, error: { code: "STALE_LIST", message: "Danh sách đã đổi", data: { listId: srv.list.id } } });
    const it = srv.items.find(x => x.groupUid === args.p_group_uid);
    if (!it) return json({ ok: true, data: { result: "not_in_list" } });
    if (it.scannedAt) return json({ ok: true, data: { result: "dup", scannedAt: it.scannedAt, device: it.device } });
    Object.assign(it, { scannedAt: "2026-10-24T02:00:00Z", device: "Máy giả 2" });
    return json({ ok: true, data: { result: "new", color: it.color, scannedAt: it.scannedAt, device: it.device } });
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

const open = async (browser, { width = 1280, admin = false } = {}) => {
  const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 800, hasTouch: width < 800 });
  await context.addInitScript(() => localStorage.setItem("tb-khoa", "khoa-may-gia"));
  if (admin) await context.addInitScript(key => sessionStorage.setItem(key, JSON.stringify({ access_token: "test-admin-token", refresh_token: "r" })), SESSION_KEY);
  const page = await context.newPage(), errors = [], srv = { calls: [], list: { ...LIST }, items: ITEMS() };
  page.on("pageerror", e => errors.push(e.message));
  await page.route("**/*", backend(srv));
  await page.goto(BASE + "#tra-ncc");
  await page.locator("#vendor-return-screen").waitFor({ state: "visible" });
  await page.waitForFunction(() => document.getElementById("vr-navy-total").textContent.trim() !== "—");
  return { context, page, errors, srv };
};
const scan = async (page, code) => { await page.locator("#vr-code").fill(code); await page.locator("#vr-code").press("Enter"); };
const result = page => page.evaluate(() => { const r = document.getElementById("vr-result"); return { tone: r.dataset.tone, title: r.querySelector(".vr-result__title")?.textContent || "", note: r.querySelector(".vr-result__note")?.textContent || "" }; });
const shot = async (page, name) => { if (process.env.VR_SHOTS) await page.screenshot({ path: `${process.env.VR_SHOTS}/${name}.png`, fullPage: true }); };
const counts = page => page.evaluate(() => ["navy", "black"].map(c => `${document.getElementById(`vr-${c}-done`).textContent}/${document.getElementById(`vr-${c}-total`).textContent}`));

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1280, 390]) {
      const { context, page, errors, srv } = await open(browser, { width });
      // Thẻ đếm hai màu + tab Navy mặc định, dòng đã quét được đánh dấu
      assert.deepEqual(await counts(page), ["1/3", "0/2"]);
      assert.equal(await page.locator("#vr-body tr").count(), 3, "tab Navy: 3 dòng");
      assert.equal(await page.locator("#vr-body tr[data-scanned]").count(), 1);
      assert.match(await page.locator("#vr-body tr[data-scanned]").innerText(), /Đã quét[\s\S]*Máy giả 1/);
      assert.equal(await page.locator("#vr-admin-panel").isVisible(), false, "không Admin: ẩn phần nạp Excel");
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
      const call = srv.calls.filter(c => c.rpc === "vendor_return_scan").pop();
      assert.deepEqual([call.args.p_access_token, call.args.p_list_id, call.args.p_group_uid], ["khoa-may-gia", LIST.id, "1028260000000201"]);
      assert.deepEqual(await counts(page), ["1/3", "1/2"]);
      assert.equal(await page.locator('.vr-card[data-color="black"]').getAttribute("aria-selected"), "true", "quét Black → mở tab Black");
      assert.equal(await page.locator("#vr-body tr[data-scanned]").count(), 1);
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
      await page.waitForFunction(() => document.getElementById("vr-navy-done").textContent.trim() === "3", null, { timeout: 10000 });
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
      // Bấm thẻ Navy → bảng Navy
      await page.locator('.vr-card[data-color="navy"]').click();
      assert.equal(await page.locator("#vr-body tr").count(), 3);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: không tràn ngang`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // Admin nạp Excel: chỉ sheet tên chứa navy / black, bỏ dòng pivot (không phải mã), bỏ sheet khác
    {
      const { context, page, errors, srv } = await open(browser, { admin: true });
      await page.locator("#vr-admin-panel").waitFor({ state: "visible" });
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
      await page.waitForFunction(() => document.getElementById("vr-message").dataset.tone === "ok");
      const imp = srv.imported;
      assert.equal(imp.p_file_name, "tra-ncc-moi.xlsx");
      assert.deepEqual(imp.p_items.map(i => [i.groupUid, i.color, i.sku, i.lot, i.roll, i.location, i.qty]), [
        ["1028260000000301", "navy", "900000496", "L1", "1", "F0-KHO-000-00-00-01", 1000],
        ["1028260000000302", "navy", "900000496", "L2", "2", "F0-KHO-000-00-00-02", null],
        ["1028260000000401", "black", "900000494", "L1", "1", "F0-KHO-000-00-00-01", 1000],
      ], "chỉ sheet navy / black, bỏ dòng pivot (kể cả nhãn toàn số), Qty trống → null, bỏ sheet khác");
      assert.equal(srv.calls.find(c => c.rpc === "vendor_return_import").auth, "Bearer test-admin-token", "nạp bằng phiên Admin");
      await page.waitForFunction(() => document.getElementById("vr-navy-total").textContent.trim() === "2");
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
    console.log("vendor_return_browser: thẻ Navy/Black, đánh dấu dòng đã quét, ngoài danh sách đỏ, trùng báo máy, mã mới gửi khoá máy + chuyển tab, bị từ chối không đánh dấu, Admin nạp Excel (sheet navy/black, bỏ pivot); 1280 / 390 — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
