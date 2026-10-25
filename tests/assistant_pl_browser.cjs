// TRỢ LÝ IN → PACKING LIST CẤP VẢI (đợt 1, 24/10/2026; docs/plans/2026-10-24-tro-ly-in-tao-pl.md).
// Dán chữ / đính kèm Excel·CSV có Group UID → RPC fabric_issue_lookup_uids → thẻ xem trước → Tạo đợt (fabric_issue_import, đọc lại
// fabric_issue_get so UID) hoặc Tải PL (.xlsx đọc lại được bằng bộ đọc Packing List của CẤP VẢI). Chỉ Admin. Supabase giả lập, dữ liệu giả.
// Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readXlsx } = require("./xlsx_read.cjs");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";
const SHOTS = process.env.SHOTS || "";

const SKU = "900000011", SKU_KG = "900000012", PO = "100000001";
const PRODUCTS = { [SKU]: "Vải giả double face/TEST-1/100% Polyester/58in-300gsm/Đen-Deep black/mm", [SKU_KG]: "Bo giả/TEST-2/Trắng-White/kg" };
const G = (uid, sku, lot, roll, qty, status = "Available") => ({ uid, sku, lot, roll, qty, warehouse: "WH - MATERIAL - MTG", location: "F0-KHO-900-01-01-01", status, qcStatus: null, po: PO });
const ITEMS = [
  G("1028260000000101", SKU, "15", "4", 29000), G("1028260000000102", SKU, "15", "23", 29001), G("1028260000000103", SKU, "15", "7", 28000),
  G("1028260000000104", SKU, "15", "9", 30000, "Blocked"), G("1028260000000105", SKU, "15", "11", 27000), G("1028260000000106", SKU_KG, "3", "1", 5),
  G("1028260000000107", SKU, "15", "", 26000), // thiếu Roll → khoá tick (fabric_issue_import từ chối cả đợt)
];
const MISSING = "1028260000000199";
// Dòng fabric_issue_get đúng hợp đồng fabric_issue_lines_json (camelCase): ghép được → groupUid; chưa ghép → groupUid null + state
const L = (no, uid, state = "matched") => ({ id: `l-${no}`, no, sku: SKU, color: "", lot: "15", roll: "", qtyM: 0, state, note: "", groupUid: state === "matched" ? uid : null, scannedAt: null });
const IN_PLANS = [{ uid: "1028260000000105", planId: "plan-open", planName: "TEST01 · DEEP BLACK", planStatus: "open", scannedAt: null }];
// Danh sách đợt CẤP VẢI giả: đợt cũ đang mở (CẤP VẢI chọn trước) + đợt Trợ lý in vừa tạo
const PLAN = (id, name) => ({ id, name, status: "open", styleNo: "", poNo: "", total: 0, matched: 0, scanned: 0, qtyTotal: 0, qtyScanned: 0, createdAt: "2026-10-22T07:00:00Z" });
const PLANS = [PLAN("plan-old", "TEST01 · DEEP BLACK"), PLAN("plan-new", "TEST01 · DEEP BLACK · bổ sung")];
const OPEN_PLANS = [{ id: "plan-open", name: "TEST01 · DEEP BLACK", styleNo: "TEST01", poNo: "", createdAt: "2026-10-22T07:00:00Z", skus: [SKU] }];
// Chữ dán từ bảng WMS (tab), có tiêu đề + một UID lặp lại + một UID không có trên hệ thống
const PASTE = ["Group UID Code\tBatch Code\tRoll Code\tWarehouse\tLocation\tSKU\tQty",
  ...ITEMS.map(i => `${i.uid}\t${i.lot}\t${i.roll}\t${i.warehouse}\t${i.location}\t${i.sku}\t${i.qty.toLocaleString("en-US")},000`),
  `1028260000000101\t15\t4\tWH - MATERIAL - MTG\tF0-KHO-900-01-01-01\t${SKU}\t29,000`, `${MISSING}\t1\t1\tWH\tX\t${SKU}\t1`].join("\n");

async function open(browser, { admin = true, width = 1280 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [], rpc = [];
  let lines = []; // dòng fabric_issue_get trả về (đợt vừa tạo đã ghép UID nào)
  // importMode: "drop" máy chủ ghi xong nhưng phản hồi mất (Failed to fetch); "lost" rớt trước khi tới máy chủ (không ghi);
  // "empty200" ghi xong, thân phản hồi rỗng; "gw504" cổng trả 504 JSON không có code (giao dịch vẫn ghi)
  let importMode = "ok", lastImport = null;
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route("**/*", async route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    const name = (url.match(/\/rpc\/([a-z_]+)/) || [])[1];
    if (name) {
      const body = JSON.parse(route.request().postData() || "{}");
      rpc.push({ name, body, auth: route.request().headers().authorization || "" });
      if (name === "fabric_issue_lookup_uids") {
        const codes = body.p_codes || [];
        return json({ ok: true, data: { items: ITEMS.filter(i => codes.includes(i.uid)), missing: codes.filter(c => !ITEMS.some(i => i.uid === c)),
          products: PRODUCTS, inPlans: IN_PLANS.filter(p => codes.includes(p.uid)), openPlans: OPEN_PLANS } });
      }
      if (name === "fabric_issue_import") {
        lastImport = body.p_plan;
        if (importMode === "drop" || importMode === "lost") return route.abort("internetdisconnected");
        if (importMode === "empty200") return route.fulfill({ status: 200, contentType: "application/json", body: "" });
        if (importMode === "gw504") return json({ message: "The upstream server is timing out" }, 504);
        const n = body.p_plan.lines.length;
        return json({ ok: true, data: { plan: { id: "plan-new", name: body.p_plan.name, total: n, matched: n }, overlap: { shared: 0, issuedElsewhere: 0 } } });
      }
      if (name === "fabric_issue_get") {
        return json({ ok: true, data: { plan: PLANS.find(x => x.id === body.p_plan_id) || PLAN(body.p_plan_id, "?"), lines, products: PRODUCTS } });
      }
      if (name === "fabric_issue_list") {
        const wrote = lastImport && ["drop", "empty200", "gw504"].includes(importMode);
        const made = wrote ? [{ ...PLAN("plan-new", lastImport.name), sourceName: lastImport.sourceName, total: lastImport.lines.length, matched: lastImport.lines.length, createdAt: new Date().toISOString() }] : [];
        // Đợt cũ CÙNG TÊN do Trợ lý in tạo vài phút trước (mã thao tác khác) — không được nhận nhầm
        const older = lastImport ? [{ ...PLAN("plan-older", lastImport.name), sourceName: "Trợ lý in:00000000-0000-4000-8000-000000000000", total: 1, matched: 1, createdAt: new Date(Date.now() - 120000).toISOString() }] : [];
        return json({ ok: true, data: { plans: [...made, ...older, ...PLANS] } });
      }
      return json({ ok: true, data: {} });
    }
    if (url.includes("/rest/v1/")) return json([]);
    return json({ ok: true, data: {} });
  });
  await page.goto(BASE + "#home");
  await page.evaluate(admin => {
    window.__admin = admin;
    window.PrintSkuAdminAuth = { accessToken: async () => { if (!window.__admin) throw new Error("Phiên Admin đã hết hạn. Hãy đăng nhập lại."); return "t"; }, user: () => ({ email: "admin-test@example.com" }) };
    window.PrintSkuAdminAccess = { ...window.PrintSkuAdminAccess, peekToken: () => window.__admin ? "t" : "", isAuthorized: () => window.__admin, getToken: async () => window.__admin ? "t" : "" };
  }, admin);
  await page.evaluate(() => { location.hash = "#assistant"; });
  await page.locator("#assistant-screen").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  return { page, context, errors, rpc, setLines: v => { lines = v; }, setImport: v => { importMode = v; } };
}
// Trả về true khi trang chặn dán (preventDefault) — danh sách được Trợ lý in nhận
const paste = (page, text) => page.locator("#pa-input").evaluate((el, text) => {
  const data = new DataTransfer(); data.setData("text/plain", text);
  el.focus(); return !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, text);
const card = page => page.locator("#pa-pl");
const rowsOf = page => page.evaluate(() => [...document.querySelectorAll("#pa-pl .pa-pl-row")].map(r => ({
  uid: r.dataset.uid, on: r.querySelector("[data-pl-on]").checked, locked: r.querySelector("[data-pl-on]").disabled, m: r.querySelector(".pa-pl-m").textContent.trim(), flag: r.querySelector(".pa-flag")?.textContent.trim() || "" })));
const shot = async (page, name) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); };

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // 1) Dán bảng WMS → thẻ xem trước: bỏ trùng, đổi mm → m, cờ, gợi ý tên/style/PO, tick mặc định
    {
      const { page, context, errors, rpc, setLines } = await open(browser);
      assert.equal(await page.locator("#pa-attach").isVisible(), true, "thiếu nút đính kèm");
      assert.equal(await page.locator("#pa-attach").getAttribute("aria-label"), "Đính kèm danh sách Group UID");
      await shot(page, "pl_1280_1_trong.png");
      await paste(page, PASTE);
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      assert.equal(await page.locator("#pa-input").inputValue(), "", "chữ dán dài không được đổ vào ô câu lệnh");
      const look = rpc.filter(r => r.name === "fabric_issue_lookup_uids");
      assert.equal(look.length, 1);
      assert.equal(look[0].auth, "Bearer t", "tra UID phải mang JWT Admin");
      assert.deepEqual(look[0].body.p_codes, [...ITEMS.map(i => i.uid), MISSING], "bỏ trùng, giữ thứ tự");
      const rows = await rowsOf(page);
      assert.deepEqual(rows.map(r => r.uid), ["1028260000000107", "1028260000000101", "1028260000000103", "1028260000000104", "1028260000000105", "1028260000000102", "1028260000000106"], "xếp theo SKU, lot, roll (số)");
      const by = Object.fromEntries(rows.map(r => [r.uid, r]));
      assert.equal(by["1028260000000101"].m, "29", "29000 mm → 29 m");
      assert.equal(by["1028260000000103"].m, "28");
      assert.equal(by["1028260000000102"].m, "29,001", "29001 mm → 29,001 m (không làm tròn 2 chữ số)");
      assert.match(by["1028260000000107"].flag, /Thiếu Roll/);
      assert.equal(by["1028260000000107"].locked, true, "thiếu Roll thì khoá tick");
      assert.deepEqual(rows.filter(r => r.on).map(r => r.uid).sort(), ["1028260000000101", "1028260000000102", "1028260000000103"], "chỉ tick cuộn Available, chưa thuộc đợt nào, đổi được sang mét");
      assert.match(by["1028260000000104"].flag, /Blocked/);
      assert.match(by["1028260000000105"].flag, /TEST01 · DEEP BLACK/);
      assert.match(by["1028260000000106"].flag, /kg/);
      assert.match(await card(page).locator(".pa-pl-missing").innerText(), new RegExp(MISSING), "liệt kê UID không có");
      assert.equal(await page.locator("#pa-pl-name").inputValue(), "TEST01 · DEEP BLACK · bổ sung");
      assert.equal(await page.locator("#pa-pl-style").inputValue(), "TEST01");
      assert.equal(await page.locator("#pa-pl-po").inputValue(), PO);
      assert.match(await page.locator("#pa-pl-total").innerText(), /^3 cuộn · 86,001 m$/);
      // Tick thêm cuộn Blocked → tổng đổi; bỏ lại
      await card(page).locator('.pa-pl-row[data-uid="1028260000000104"] [data-pl-on]').check();
      assert.match(await page.locator("#pa-pl-total").innerText(), /^4 cuộn · 116,001 m$/);
      await card(page).locator('.pa-pl-row[data-uid="1028260000000104"] [data-pl-on]').uncheck();
      // Bố cục hàng: tick | UID + thông tin | số mét trên cùng một dòng (.pa-main của thẻ phiếu IT từng kéo ra hàng ngầm)
      const lay = await page.evaluate(() => [...document.querySelectorAll("#pa-pl .pa-pl-row")].map(r => {
        const b = r.querySelector("[data-pl-on]").getBoundingClientRect(), m = r.querySelector(".pa-main").getBoundingClientRect(), q = r.querySelector(".pa-pl-qty").getBoundingClientRect();
        return { ok: b.right <= m.left && m.right <= q.left && m.top < b.bottom && q.top < m.bottom, h: Math.round(r.getBoundingClientRect().height) };
      }));
      assert.ok(lay.every(x => x.ok), `hàng PL vỡ bố cục: ${JSON.stringify(lay)}`);
      // Không tràn ngang ở 1280
      assert.equal(await page.evaluate(() => document.getElementById("assistant-screen").scrollWidth <= innerWidth), true, "thẻ PL tràn ngang");
      await shot(page, "pl_1280_2_the.png");

      // 2) Tải PL → tệp đọc lại được bằng bộ đọc Packing List của CẤP VẢI
      const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#pa-pl-xlsx").click()]);
      assert.match(download.suggestedFilename(), /\.xlsx$/);
      const file = path.join(os.tmpdir(), `pl-test-${Date.now()}.xlsx`);
      await download.saveAs(file);
      const cap = await context.newPage();
      await cap.route("**/*", r => r.request().url().startsWith(BASE) ? r.continue() : r.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, data: { plans: [] } }) }));
      await cap.goto(BASE + "#cap-vai"); await cap.waitForTimeout(800);
      await cap.setInputFiles("#cap-vai-file", file);
      const dlg = cap.locator("dialog[open]").last();
      await dlg.waitFor({ timeout: 8000 });
      const text = await dlg.innerText();
      assert.match(text, /3 cuộn · /, `CẤP VẢI đọc tệp tải về sai: ${text}`); // CẤP VẢI tự làm tròn số mét khi hiện
      // Tệp giữ đủ 3 chữ số mét (29001 mm → 29.001) và Group UID dạng chữ
      const book = readXlsx(fs.readFileSync(file));
      assert.deepEqual(book.table[0], ["SKU", "COLOR", "LOT NO", "ROLLS NO", "QTY (M)", "GROUP UID", "LOCATION", "PO NO"]);
      assert.ok(book.table.some(r => r[3] === "23" && Number(r[4]) === 29.001 && r[5] === "1028260000000102"), `tệp mất chữ số mét: ${JSON.stringify(book.table)}`);
      assert.match(text, new RegExp(SKU));
      await dlg.getByRole("button", { name: "Hủy" }).click();
      await cap.close(); fs.rmSync(file, { force: true });

      // 3) Tạo đợt → fabric_issue_import đúng payload → đọc lại fabric_issue_get so UID → báo ghép + mở CẤP VẢI
      setLines([L(1, "1028260000000101"), L(2, "1028260000000103"), L(3, "1028260000000102")]);
      await page.locator("#pa-pl-create").click();
      await page.locator("#pa-thread [data-pl-open]").waitFor({ timeout: 8000 });
      const imp = rpc.filter(r => r.name === "fabric_issue_import");
      assert.equal(imp.length, 1);
      const plan = imp[0].body.p_plan;
      assert.equal(plan.name, "TEST01 · DEEP BLACK · bổ sung");
      assert.equal(plan.styleNo, "TEST01");
      assert.equal(plan.poNo, PO);
      assert.match(plan.sourceName, /^Trợ lý in:[0-9a-f-]{36}$/, "mỗi lần tạo một mã thao tác (đối soát khi rớt mạng)");
      assert.deepEqual(plan.lines, [
        { sku: SKU, color: "Đen-Deep black", lotNo: "15", rollNo: "4", qtyM: 29, gw: null, nw: null },
        { sku: SKU, color: "Đen-Deep black", lotNo: "15", rollNo: "7", qtyM: 28, gw: null, nw: null },
        { sku: SKU, color: "Đen-Deep black", lotNo: "15", rollNo: "23", qtyM: 29.001, gw: null, nw: null }]);
      assert.equal(imp[0].auth, "Bearer t");
      const last = await page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].pop().textContent);
      assert.match(last, /ghép 3\/3/i);
      const all3 = await page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join("\n"));
      assert.doesNotMatch(all3, /lệch/i, "ghép đủ đúng UID thì không báo lệch");
      assert.equal(await page.locator("#pa-pl-create").isDisabled(), true, "tạo xong khoá thẻ (không tạo trùng)");
      await shot(page, "pl_1280_3_da_tao.png");
      await page.locator("#pa-thread [data-pl-open]").click();
      assert.equal(await page.evaluate(() => location.hash), "#cap-vai");
      assert.equal(await page.evaluate(() => localStorage.getItem("cap-vai-dot")), "plan-new", "mở CẤP VẢI chọn sẵn đợt mới");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 4) Ghép lệch UID (trùng SKU + Lot + Roll) → cảnh báo tên UID khác
    {
      const { page, context, errors, setLines } = await open(browser);
      await paste(page, "1028260000000101 1028260000000102");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      setLines([L(1, "1028260000000101"), L(2, null, "ambiguous"), L(3, "1028260000000888")]);
      await page.locator("#pa-pl-create").click();
      await page.locator("#pa-thread [data-pl-open]").waitFor({ timeout: 8000 });
      const msgs = await page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join("\n"));
      assert.match(msgs, /1028260000000102/, "phải nêu UID đã chọn mà không được ghép");
      assert.match(msgs, /1028260000000888/, "phải nêu UID bị ghép thay");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 5) Đính kèm Excel + CSV; gõ một UID rồi Enter cũng ra thẻ PL (không đi luồng phiếu IT)
    {
      const { page, context, errors, rpc } = await open(browser);
      const xlsx = await page.evaluate(async () => {
        const blob = window.AdminSyncUI.xlsxBlob(["Group UID Code", "SKU", "Qty"], [["1028260000000101", "900000011", 29000], ["1028260000000102", "900000011", 29000]], "UID");
        return [...new Uint8Array(await blob.arrayBuffer())];
      });
      await page.setInputFiles("#pa-file", [
        { name: "uid.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(xlsx) },
        { name: "them.csv", mimeType: "text/csv", buffer: Buffer.from("uid,sku\n1028260000000103,900000011\n1028260000000101,900000011\n", "utf8") }]);
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      assert.deepEqual((await rowsOf(page)).map(r => r.uid), ["1028260000000101", "1028260000000103", "1028260000000102"]);
      const userMsg = await page.evaluate(() => [...document.querySelectorAll('#pa-thread .pa-msg[data-from="user"]')].pop().textContent);
      assert.match(userMsg, /uid\.xlsx/); assert.match(userMsg, /them\.csv/);
      await page.locator("#pa-pl-cancel").click();
      assert.equal(await card(page).count(), 0, "Huỷ bỏ thẻ");
      await page.locator("#pa-input").fill("1028260000000103");
      await page.locator("#pa-input").press("Enter");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      assert.equal(rpc.filter(r => r.name === "fabric_issue_lookup_uids").length, 2);
      assert.equal(await page.evaluate(() => window.__calls?.read?.length || 0), 0, "không đọc phiếu IT");
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 7) Đã mở CẤP VẢI trước (đang chọn đợt cũ) → tạo đợt ở Trợ lý in → "Mở Cấp vải" chọn đúng đợt mới
    {
      const { page, context, errors, setLines } = await open(browser);
      await page.evaluate(() => { location.hash = "#cap-vai"; });
      await page.waitForFunction(() => document.getElementById("cap-vai-plan")?.value === "plan-old", null, { timeout: 8000 });
      await page.evaluate(() => { location.hash = "#assistant"; });
      await page.locator("#assistant-screen").waitFor({ state: "visible" });
      await paste(page, "1028260000000101");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      setLines([L(1, "1028260000000101")]);
      await page.locator("#pa-pl-create").click();
      await page.locator("#pa-thread [data-pl-open]").last().click();
      await page.waitForFunction(() => document.getElementById("cap-vai-plan")?.value === "plan-new", null, { timeout: 8000 })
        .catch(async () => assert.fail(`CẤP VẢI vẫn chọn đợt ${await page.evaluate(() => document.getElementById("cap-vai-plan")?.value)}`));
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 8) Số phiếu IT trên WMS cũng 16 chữ số: dán vào ô câu lệnh như cũ (không thành Packing List); có chữ IT gõ trước cũng vậy
    {
      const { page, context, errors, rpc } = await open(browser);
      assert.equal(await paste(page, "1007261015013137"), false, "dán số phiếu IT 16 số bị chặn");
      await page.locator("#pa-input").fill("IT ");
      assert.equal(await paste(page, "1028260000000101"), false, "ô đã có chữ IT thì dán để vào ô câu lệnh");
      await page.waitForTimeout(300);
      assert.equal(rpc.filter(r => r.name === "fabric_issue_lookup_uids").length, 0);
      assert.equal(await card(page).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 9) Excel ô KIỂU SỐ (Excel chỉ giữ 15 chữ số → UID sai chữ số cuối) và CSV dạng 1.02826E+15: không tra, báo số ô bị làm tròn
    {
      const { page, context, errors, rpc } = await open(browser);
      const xlsx = await page.evaluate(async () => {
        const blob = window.AdminSyncUI.xlsxBlob(["Group UID Code"], [["1028260000000101"], [1028260000000100]], "UID");
        return [...new Uint8Array(await blob.arrayBuffer())];
      });
      await page.setInputFiles("#pa-file", [
        { name: "so.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(xlsx) },
        { name: "lam-tron.csv", mimeType: "text/csv", buffer: Buffer.from("uid\n1.02826E+15\n1028260000000103\n", "utf8") }]);
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      const look = rpc.filter(r => r.name === "fabric_issue_lookup_uids");
      assert.deepEqual(look[0].body.p_codes, ["1028260000000101", "1028260000000103"], "ô số / dạng khoa học không được dùng làm UID");
      assert.match(await card(page).innerText(), /2 ô số bị làm tròn/);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 10) Tạo đợt rớt mạng sau khi máy chủ đã ghi → "chưa rõ", khoá thẻ, tìm lại đợt trên máy chủ → coi như đã tạo (không cho tạo trùng)
    {
      const { page, context, errors, rpc, setLines, setImport } = await open(browser);
      await paste(page, "1028260000000101");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      setImport("drop"); setLines([L(1, "1028260000000101")]);
      await page.locator("#pa-pl-create").click();
      await page.waitForFunction(() => /Chưa rõ/.test([...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join(" ")), null, { timeout: 8000 });
      assert.equal(await page.locator("#pa-pl-create").isDisabled(), true, "chưa rõ thì khoá nút Tạo đợt");
      await page.locator("#pa-thread [data-pl-open]").waitFor({ timeout: 30000 });
      const msgs = await page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join("\n"));
      assert.match(msgs, /ghép 1\/1/);
      assert.equal(rpc.filter(r => r.name === "fabric_issue_import").length, 1, "không gửi import lần hai");
      assert.equal(await page.locator("#pa-thread [data-pl-open]").last().getAttribute("data-pl-open"), "plan-new", "nhận đúng đợt vừa ghi (không nhận đợt cũ cùng tên)");
      assert.equal(await page.locator("#pa-pl-create").isDisabled(), true);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 11) Luồng phiếu IT đang bận: nút Tạo đợt tắt theo; dán danh sách thì báo bận, không mất im lặng
    {
      const { page, context, errors, rpc } = await open(browser);
      await paste(page, "1028260000000101");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      await page.evaluate(() => window.PrintSkuAssistant.setBusy(true));
      assert.equal(await page.locator("#pa-pl-create").isDisabled(), true, "IT đang bận mà Tạo đợt vẫn bật");
      assert.equal(await paste(page, "1028260000000102"), true, "đang bận vẫn phải chặn dán (không đổ danh sách vào ô câu lệnh)");
      const last = await page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].pop().textContent);
      assert.match(last, /Đang xử lý/);
      assert.equal(rpc.filter(r => r.name === "fabric_issue_lookup_uids").length, 1);
      await page.evaluate(() => window.PrintSkuAssistant.setBusy(false));
      assert.equal(await page.locator("#pa-pl-create").isDisabled(), false);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 12) Rớt mạng TRƯỚC khi tới máy chủ, có đợt cũ cùng tên (mã thao tác khác): không nhận nhầm, máy chủ không có → mở lại nút
    {
      const { page, context, errors, rpc, setImport } = await open(browser);
      await paste(page, "1028260000000101");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      setImport("lost");
      await page.locator("#pa-pl-create").click();
      await page.waitForFunction(() => /Chưa rõ/.test([...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join(" ")), null, { timeout: 8000 });
      await page.waitForFunction(() => document.getElementById("pa-pl-create")?.disabled === false, null, { timeout: 40000 });
      assert.equal(await page.locator("#pa-thread [data-pl-open]").count(), 0, "không được coi đợt cũ cùng tên là đợt vừa tạo");
      assert.equal(rpc.filter(r => r.name === "fabric_issue_import").length, 1);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 13) Import trả 200 nhưng thân rỗng / cổng 504 JSON không code: máy chủ có thể đã ghi → "chưa rõ", khoá thẻ (không báo "không tạo được")
    for (const mode of ["empty200", "gw504"]) {
      const { page, context, errors, setImport } = await open(browser);
      await paste(page, "1028260000000101");
      await card(page).waitFor({ state: "visible", timeout: 8000 });
      setImport(mode);
      await page.locator("#pa-pl-create").click();
      await page.waitForFunction(() => /Chưa rõ|Không tạo được/.test([...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join(" ")), null, { timeout: 8000 });
      const msgs = await page.evaluate(() => [...document.querySelectorAll("#pa-thread .pa-msg")].map(m => m.textContent).join("\n"));
      assert.match(msgs, /Chưa rõ/, `${mode}: phải báo chưa rõ`);
      assert.doesNotMatch(msgs, /Không tạo được/, `${mode}: không được khẳng định chưa tạo`);
      assert.equal(await page.locator("#pa-pl-create").isDisabled(), true, `${mode}: khoá nút Tạo đợt`);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // 6) Không phải Admin: nút đính kèm tắt, dán danh sách không gọi RPC
    {
      const { page, context, errors, rpc } = await open(browser, { admin: false });
      assert.equal(await page.locator("#pa-attach").isDisabled(), true, "không Admin thì không đính kèm");
      await paste(page, "1028260000000101");
      await page.waitForTimeout(500);
      assert.equal(rpc.filter(r => r.name === "fabric_issue_lookup_uids").length, 0);
      assert.equal(await card(page).count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log("PASS assistant_pl: dán bảng WMS (bỏ trùng, mm→m, cờ Blocked/đợt khác/kg/không có, gợi ý tên·style·PO, tick mặc định), Tải PL đọc lại ở CẤP VẢI, Tạo đợt (payload + so UID + mở CẤP VẢI), ghép lệch UID, đính kèm xlsx+csv, gõ UID, CẤP VẢI đã mở chọn đúng đợt mới, dán số phiếu IT 16 số, ô Excel số / 1.02826E+15, rớt mạng khi tạo đợt (đã ghi / chưa tới máy chủ / 200 thân rỗng / 504), IT đang bận, không Admin");
})().catch(e => { console.error(e); process.exitCode = 1; });
