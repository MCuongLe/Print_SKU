// KIỂM TRA ĐẦU VÀO → In tem Phụ liệu có PO + ngày nhận (22/10/2026, docs/plans/2026-10-22-tem-phu-lieu-po.md):
// nút In tem ở thẻ 3 → hộp #ins-tem: SKU Normal (Combo đổi sang Normal, Normal ngừng hoạt động bị bỏ, trùng gộp), mặc định 1 tem/SKU,
// PO + Ngày nhận lấy ở thẻ 2 → lệnh type sku, templateVersion 2. Chưa có agent khai sku:v2 / PO sai mẫu / máy chưa kích hoạt → không gửi.
// Dữ liệu giả; Supabase + Extension giả lập, mọi request ngoài localhost bị chặn. Chạy với python -m http.server 8000.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";

// sku, tên, số lượng (PO)
const ITEMS = [
  ["900100001", "(Combo) Chỉ mẫu A/FX-0001_NCC Alpha/100% Polyester/none/Xám/Tex 24/none/cuộn 5000m", 145],
  ["900100002", "(Combo) Bo cổ - tay mẫu/BO-0002_NCC Beta/98% Cotton 2% Spandex/none/Navy/Size 7x35cm/none/set", 60],
  ["900100004", "Nhãn care mẫu D/LAB004_ACME LABELS/100% Polyester/none/White/none/25x78mm/pcs", 1200],
  ["900100005", "(Combo) Chỉ mẫu A lô 2/FX-0001_NCC Alpha/100% Polyester/none/Xám/Tex 24/none/cuộn 5000m", 20],
  ["900100006", "(Combo) Dây kéo mẫu thiếu liên kết/ZIP-0006_NCC Alpha/100% Polyester/none/Đen/20cm/none/pcs", 15], // Combo chưa có SKU Normal
  ["900100007", "Dây kéo thường G/ZIP-0007_NCC Alpha/100% Polyester/none/Đen/20cm/none/pcs", 5], // SKU thường, tra Combo lỗi mạng → vẫn in
  ["900100008 A", "Nhãn mã sai/LAB-0008_NCC Alpha/100% Polyester/none/Trắng/none/pcs", 5], // SKU sai mẫu agent → loại, liệt kê
];
const NORMALS = {
  "900100001": [{ normal_sku: "900900001", product_name: "Chỉ mẫu A Normal/mm", category_name: "Phụ liệu", quantity: 5000000, available: true }],
  "900100002": [
    { normal_sku: "900900002", product_name: "Bo cổ mẫu Normal/pcs", category_name: "Phụ liệu", quantity: 1, available: true },
    { normal_sku: "900900003", product_name: "Bo tay mẫu Normal/pcs", category_name: "Phụ liệu", quantity: 2, available: false },
  ],
  "900100005": [{ normal_sku: "900900001", product_name: "Chỉ mẫu A Normal/mm", category_name: "Phụ liệu", quantity: 5000000, available: true }], // trùng Normal với dòng 1
};

const buildXlsx = page => page.evaluate(async items => {
  const enc = new TextEncoder();
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const text = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  const num = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
  const rows = [
    `<row r="4">${text("G4", "Mã số")}${text("H4", "99900000000001")}</row>`,
    `<row r="16">${["STT", "SKU", "Tên", "Barcode", "Mã NCC", "Số lượng", "Giá(+VAT)", "Thành tiền"].map((h, i) => text("ABCDEFGH"[i] + 16, h)).join("")}</row>`,
    ...items.map(([sku, name, qty], i) => `<row r="${17 + i}">${num("A" + (17 + i), i + 1)}${text("B" + (17 + i), sku)}${text("C" + (17 + i), name)}${num("F" + (17 + i), qty)}</row>`),
  ].join("");
  const parts = {
    "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    "xl/workbook.xml": '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
  };
  return Array.from(window.PrintSkuZip.buildZip(Object.entries(parts).map(([name, xml]) => ({ name, data: enc.encode(xml) }))));
}, ITEMS);

async function run(browser, width) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [], enqueued = [];
  let caps = ["sku:v1", "sku:v2"], mode = "ok", slowStatus = false;
  page.on("pageerror", e => errors.push(e.message));
  await page.addInitScript(() => { try { localStorage.setItem("tb-khoa", "tb-khoa-test"); } catch (_) {} });
  await page.route("**/*", route => {
    const url = route.request().url(), json = body => route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST, GET, OPTIONS" } });
    const rpc = url.match(/\/rest\/v1\/rpc\/([a-z_]+)/)?.[1];
    if (rpc === "sku_combo_lookup") { const sku = route.request().postDataJSON().p_sku; if (sku === "900100007") return route.fulfill({ status: 500, body: "error" }); return json(NORMALS[sku] || []); }
    if (rpc === "print_queue_status" && slowStatus) { slowStatus = false; return new Promise(resolve => setTimeout(resolve, 1500)).then(() => json({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: [{ id: "may-test", capabilities: caps }] } })); }
    if (rpc === "print_queue_status") return json({ ok: true, data: { queued: 0, queuedCopies: 0, active: 0, agents: [{ id: "may-test", capabilities: caps, lastSeenAt: new Date().toISOString() }] } });
    if (rpc === "print_enqueue") {
      enqueued.push(JSON.parse(route.request().postData() || "{}"));
      // abort-once: máy chủ đã nhận nhưng mất phản hồi (lần đầu); second-fails: lệnh thứ hai của lô bị từ chối
      if (mode === "abort-once") { mode = "ok"; return route.abort(); }
      if (mode === "second-fails" && enqueued.length === 2) { mode = "ok"; return json({ ok: false, error: { code: "INVALID_JOB", message: "Hàng đợi tạm lỗi" } }); } // không dùng ACCESS_DENIED (mở hộp kích hoạt máy)
      return json({ ok: true, data: { id: `99999999-0000-4000-8000-${String(enqueued.length).padStart(12, "0")}`, status: "queued", duplicate: false } });
    }
    if (rpc === "print_job_status") return json({ ok: true, data: { status: "completed" } });
    if (rpc) return json([]);
    return route.abort();
  });
  await page.goto(BASE + "#inspection");
  await page.waitForSelector("#ins-file", { state: "attached" });
  assert.equal(await page.locator("#ins-print").count(), 1, "có nút In tem");
  await page.setInputFiles("#ins-file", { name: "po.xlsx", mimeType: "application/octet-stream", buffer: Buffer.from(await buildXlsx(page)) });
  await page.waitForFunction(n => document.querySelectorAll(".ins-row[data-index]").length === n, ITEMS.length);
  await page.waitForFunction(() => document.querySelectorAll(".ins-sku").length === 3);
  assert.equal(await page.locator("#ins-print").isDisabled(), false, "có danh sách thì In tem bấm được");
  await page.locator("#ins-po").fill("10000000000001");
  await page.locator("#ins-date").fill("15/06/2026");
  // Tên sửa tay của SKU thường (chưa có trong danh mục) phải lên tem
  await page.locator('.ins-row[data-index="2"] input[data-field="name"]').fill("Nhãn sửa tay");

  // Mở hộp: SKU Normal, trùng gộp, Normal ngừng bị bỏ, mặc định 1 tem
  await page.locator("#ins-print").click();
  await page.waitForFunction(() => document.getElementById("ins-tem")?.open && document.querySelectorAll("#ins-tem .skit__item").length > 0);
  const rows = await page.$$eval("#ins-tem .skit__item", list => list.map(r => ({ sku: r.querySelector("b").textContent, copies: r.querySelector('[data-field="copies"]').value, on: r.querySelector('[data-field="on"]').checked })));
  assert.deepEqual(rows, [
    { sku: "900900001", copies: "1", on: true },
    { sku: "900900002", copies: "1", on: true },
    { sku: "900100004", copies: "1", on: true },
    { sku: "900100007", copies: "1", on: true },
  ], "Combo → SKU Normal, gộp trùng, bỏ Normal ngừng hoạt động; SKU thường tra lỗi vẫn in; SKU sai mẫu bị loại");
  assert.match(await page.locator("#ins-tem-info").innerText(), /10000000000001[\s\S]*15\/06\/2026/, "hiện PO + ngày nhận");
  assert.match(await page.locator("#ins-tem-status").innerText(), /1 SKU Normal ngừng hoạt động/);
  assert.match(await page.locator("#ins-tem-status").innerText(), /1 dòng Combo chưa có SKU Normal/);
  assert.match(await page.locator("#ins-tem-status").innerText(), /1 SKU sai mẫu/);
  assert.match(await page.locator("#ins-tem-ok").innerText(), /In 4 tem/);
  const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
  assert.ok(noScroll, `${width}px: không tràn ngang`);

  // Chưa có agent khai sku:v2 → không gửi
  caps = ["sku:v1"];
  await page.locator("#ins-tem-ok").click();
  await page.locator(".whd-ok").click(); // còn 1 dòng Combo chưa có SKU Normal → đồng ý in thiếu
  await page.waitForFunction(() => /0\.10\.1/.test(document.getElementById("ins-tem-status").textContent));
  assert.equal(enqueued.length, 0, "agent cũ thì không gửi");
  caps = ["sku:v1", "sku:v2"];

  // PO sai mẫu → không gửi
  await page.locator("#ins-tem [data-field='copies']").nth(1).fill("2");
  await page.locator("#ins-tem-close").click();
  await page.locator("#ins-po").fill("PO#1234567890123456789");
  await page.locator("#ins-print").click();
  await page.waitForFunction(() => document.getElementById("ins-tem")?.open);
  await page.locator("#ins-tem-ok").click();
  await page.waitForFunction(() => /Số PO/.test(document.getElementById("ins-tem-status").textContent));
  assert.equal(enqueued.length, 0, "PO sai mẫu thì không gửi");
  await page.locator("#ins-tem-close").click();

  // Gửi: type sku, templateVersion 2, item có PO + ngày nhận + printedDate, không số lượng
  await page.locator("#ins-po").fill("10000000000001");
  await page.locator("#ins-print").click();
  await page.waitForFunction(() => document.getElementById("ins-tem")?.open && document.querySelectorAll("#ins-tem .skit__item").length === 4);
  const copiesInput = i => page.locator("#ins-tem [data-field='copies']").nth(i);
  // Số tem thập phân → không cho in (không làm tròn ngầm)
  await copiesInput(0).fill("2.9");
  assert.equal(await page.locator("#ins-tem-ok").isDisabled(), true, "số tem thập phân thì chưa in được");
  await page.locator("#ins-tem [data-step='1']").first().click();
  await page.locator("#ins-tem [data-step='-1']").first().click();
  assert.equal(await copiesInput(0).inputValue(), "2.9", "nút +/− không làm tròn số lẻ");
  assert.equal(await page.locator("#ins-tem-ok").isDisabled(), true);
  await copiesInput(0).fill("200");
  await copiesInput(1).fill("200");
  await copiesInput(2).fill("200");
  // Còn Combo chưa có SKU Normal → hỏi lại, Huỷ thì không gửi
  await page.locator("#ins-tem-ok").click();
  assert.deepEqual(await page.locator(".whd-list li").allTextContents(), ["900100006", "900100008 A"], "hộp hỏi liệt kê dòng bị bỏ");
  await page.locator(".whd-cancel").click();
  await page.waitForTimeout(200);
  assert.equal(enqueued.length, 0, "huỷ hộp hỏi thì không gửi");
  // Lô 2 lệnh (400 + 200 tem; ≤ 500 tem/lệnh), lệnh thứ hai lỗi → báo phần đã gửi, KHOÁ danh sách (gửi lại đúng các lệnh cũ)
  // Trạng thái máy in trả chậm: trong lúc chờ mọi điều khiển khoá, không đóng được → nội dung gửi đúng cái vừa xác nhận
  mode = "second-fails"; slowStatus = true;
  await page.locator("#ins-tem-ok").click();
  await page.locator(".whd-ok").click();
  await page.waitForFunction(() => document.getElementById("ins-tem-ok").textContent === "Đang gửi…");
  assert.equal(await copiesInput(0).isDisabled(), true, "đang gửi: khoá số tem");
  assert.equal(await page.locator("#ins-tem-close").isDisabled(), true, "đang gửi: không đóng được");
  await page.keyboard.press("Escape");
  assert.ok(await page.locator("#ins-tem").evaluate(d => d.open), "Esc không đóng khi đang gửi");
  await page.waitForFunction(() => /đã gửi 400 tem/.test(document.getElementById("ins-tem-status").textContent));
  assert.equal(enqueued.length, 2);
  assert.ok(await page.locator("#ins-tem").evaluate(d => d.open), "lỗi giữa chừng: hộp vẫn mở");
  assert.equal(await copiesInput(0).isDisabled(), true, "lần gửi dở: khoá sửa số tem");
  assert.equal((await page.locator("#ins-tem-ok").innerText()).trim(), "Gửi lại");
  assert.match(await page.locator("#ins-tem-status").innerText(), /đã gửi 400 tem/);
  // Đã có lệnh vào hàng đợi: Gửi lại gửi thẳng (cùng nonce), không kiểm lại agent → không thể bị xoá lần gửi dở vì đọc trạng thái lỗi
  // Đóng / mở lại hộp vẫn giữ lần gửi dở (không sinh nonce mới)
  await page.locator("#ins-tem-close").click();
  await page.locator("#ins-print").click();
  await page.waitForFunction(() => document.getElementById("ins-tem").open && /chưa xong/.test(document.getElementById("ins-tem-status").textContent));
  // Bỏ lần gửi khi đã có lệnh vào hàng đợi: phải xác nhận (cảnh báo có thể in trùng); Huỷ thì giữ nguyên
  await page.locator("#ins-tem-drop").click();
  await page.locator(".whd-cancel").click();
  assert.equal((await page.locator("#ins-tem-ok").innerText()).trim(), "Gửi lại", "huỷ bỏ lần gửi: vẫn giữ");
  // Gửi lại mà lệnh đầu mất phản hồi (lỗi mạng) → vẫn khoá, rồi gửi lại lần nữa thành công
  mode = "abort-once";
  await page.locator("#ins-tem-ok").click();
  await page.waitForFunction(n => window.__ok !== false && document.getElementById("ins-tem-status").dataset.tone === "error" && document.getElementById("ins-tem-ok").textContent.startsWith("Gửi lại"), 0);
  await page.waitForFunction(() => !document.getElementById("ins-tem-ok").disabled);
  assert.equal(enqueued.length, 3);
  await page.locator("#ins-tem-ok").click();
  await page.waitForFunction(() => !document.getElementById("ins-tem").open);
  assert.equal(enqueued.length, 5);
  assert.deepEqual([enqueued[2].p_nonce, enqueued[3].p_nonce], [enqueued[0].p_nonce, enqueued[0].p_nonce], "lệnh 1 gửi lại cùng nonce (hàng đợi trả lệnh cũ, không in trùng)");
  assert.equal(enqueued[4].p_nonce, enqueued[1].p_nonce, "lệnh 2 gửi lại cùng nonce");
  assert.notEqual(enqueued[0].p_nonce, enqueued[1].p_nonce);
  const first = enqueued[0], last = enqueued[4];
  assert.equal(first.p_type, "sku"); assert.equal(first.p_template_version, 2); assert.equal(first.p_access_token, "tb-khoa-test");
  assert.deepEqual(first.p_payload.items.map(i => [i.sku, i.copies, i.po, i.receivedDate]), [["900900001", 200, "10000000000001", "15/06/2026"], ["900900002", 200, "10000000000001", "15/06/2026"]]);
  assert.equal(first.p_copies, 400);
  assert.deepEqual(last.p_payload.items.map(i => [i.sku, i.copies, i.productName]), [["900100004", 200, "Nhãn sửa tay"], ["900100007", 1, ITEMS[5][1]]], "lệnh 2 = SKU sửa tên tay + SKU thường tra lỗi (tên đang hiện trên bảng)");
  assert.equal(last.p_copies, 201);
  assert.ok([first, last].flatMap(j => j.p_payload.items).every(i => i.productName && /^\d{2}\/\d{2}\/\d{2}$/.test(i.printedDate) && !i.quantity), "có tên, ngày in dd/mm/yy, không số lượng");
  assert.match(await page.locator("#ins-status").innerText(), /Đã gửi 601 tem · 4 SKU · 2 lệnh/);
  // Hết thời gian chờ (DOMException TimeoutError, code chỉ đọc) ở lệnh thứ hai: lỗi vẫn mang uncertain + phần đã gửi
  const timeout = await page.evaluate(async () => {
    const queue = window.PrintSkuQueue, original = queue.enqueue;
    let calls = 0;
    queue.enqueue = async () => { calls += 1; if (calls === 2) throw new DOMException("signal timed out", "TimeoutError"); return { ok: true, data: { id: `id-${calls}` } }; };
    try {
      await window.HasakiSkuIt.enqueue([{ sku: "900000001", productName: "A", copies: 200 }, { sku: "900000002", productName: "B", copies: 200 }, { sku: "900000003", productName: "C", copies: 200 }], { nonceBase: "t" });
      return { thrown: false };
    } catch (error) { return { thrown: true, name: error.name, uncertain: error.uncertain, jobIds: error.jobIds, labels: error.labels, message: error.message }; }
    finally { queue.enqueue = original; }
  });
  assert.deepEqual([timeout.thrown, timeout.uncertain, timeout.jobIds, timeout.labels], [true, true, ["id-1"], 400], `lỗi hết giờ vẫn có phần đã gửi: ${JSON.stringify(timeout)}`);

  // 23/10/2026 mẫu tem SKU gộp v3: ô Số lượng từng dòng; agent cũ (chỉ sku:v2) + có số lượng → chặn; có sku:v3 → template 3 kèm số lượng
  await page.locator("#ins-print").click();
  await page.waitForFunction(() => document.getElementById("ins-tem")?.open && document.querySelectorAll("#ins-tem .skit__item").length > 0);
  assert.equal(await page.locator('#ins-tem .skit__item input[data-field="qty"]').count(), await page.locator("#ins-tem .skit__item").count(), "mỗi dòng có ô Số lượng");
  await page.locator('#ins-tem .skit__item').first().locator('input[data-field="qty"]').fill("1200");
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/ins-tem-so-luong-${width}.png` });
  const sent = enqueued.length;
  caps = ["sku:v1", "sku:v2"];
  await page.locator("#ins-tem-ok").click();
  await page.locator(".whd-ok").click(); // còn dòng Combo chưa có SKU Normal → đồng ý in thiếu
  await page.waitForFunction(() => /cần agent 0\.10\.2/.test(document.getElementById("ins-tem-status").innerText));
  assert.equal(enqueued.length, sent, "agent cũ không in được số lượng → không gửi");
  caps = ["sku:v1", "sku:v2", "sku:v3"];
  await page.locator("#ins-tem-ok").click();
  await page.locator(".whd-ok").click();
  await page.waitForFunction(() => !document.getElementById("ins-tem").open);
  const v3 = enqueued.slice(sent);
  assert.ok(v3.length >= 1 && v3.every(job => job.p_template_version === 3), `có sku:v3 → template 3: ${v3.map(j => j.p_template_version)}`);
  const v3Items = v3.flatMap(job => job.p_payload.items);
  assert.equal(v3Items[0].quantity, "1200", "số lượng nhập lên tem");
  assert.ok(v3Items.slice(1).every(item => item.quantity === ""), "dòng không nhập số lượng → trống");
  assert.ok(v3Items.every(item => item.po === "10000000000001" && item.receivedDate === "15/06/2026"));
  assert.deepEqual(errors, []);
  await context.close();
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const width of [1280, 390]) { await run(browser, width); console.log(`PASS ${width}px: In tem Phụ liệu (SKU Normal, PO + ngày nhận, templateVersion 2, chặn agent cũ / PO sai)`); }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
