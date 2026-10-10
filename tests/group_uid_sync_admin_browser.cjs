// Dashboard Group UID: hai chế độ, preview, bảng thay đổi, apply và responsive.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = "http://127.0.0.1:8000/", SESSION_KEY = "print-sku-admin-session-v1", RUN = "33333333-3333-4333-8333-333333333333";
const changes = [
  { groupUidCode: "1028261006000050", changeType: "added", before: null, after: { sku: null, qty: 44, products: [{ sku: "422439472", quantity: 7 }, { sku: "422439483", quantity: 17 }], status: "Available", updated_by: "creator@hasaki.vn", updated_date: "2026-10-08T01:00:00Z" }, changedFields: ["group_uid_code"], sourceUpdatedAt: "2026-10-08T01:00:00Z" },
  { groupUidCode: "1028261006000049", changeType: "updated", before: { qty: 3000, status: "Available", updated_by: "old@hasaki.vn" }, after: { qty: 3180, status: "Allocated", updated_by: "old@hasaki.vn" }, changedFields: ["qty", "status"], sourceUpdatedAt: "2026-10-08T01:01:00Z" },
];
const counts = { added: 1, updated: 1, unchanged: 0, missing: 0, issues: 0, totalChanges: 2 };
const warnCounts = { ...counts, missing: 3, issues: 1 };
let scenario = "normal", cancelCalls = 0;
const WHS = ["WH - MATERIAL - MTG", "WH - MATERIAL - GARMENT", "WH - SEMI PRODUCT - MTG"];
const MANY = Array.from({ length: 120 }, (_, i) => ({ groupUidCode: `1028261006${String(i).padStart(6, "0")}`, changeType: "updated", before: { qty: 1000 + i, status: "Available", location: `A-${i}`, warehouse: WHS[i % 3] }, after: { qty: 1180 + i, status: "Allocated", location: `B-${i}`, warehouse: WHS[i % 3] }, changedFields: i % 2 ? ["qty", "status"] : ["qty", "location"], sourceUpdatedAt: new Date(Date.UTC(2026, 9, 8, 1, 0, i)).toISOString() }));
const manyCounts = { added: 0, updated: 120, unchanged: 1880, missing: 0, issues: 0, totalChanges: 120 };

const fakeExtension = () => addEventListener("message", event => {
  const request = event.data;
  if (!request || request.source !== "PRINT_SKU_APP") return;
  const data = request.type === "PING_WMS" ? { version: "0.4.2" } : request.type === "GET_GROUP_UID_PAGE" ? {
    page: 1, size: 500, total: 2, totalPages: 1, rows: [
      { group_uid_code: "1028261006000050", sku: "422268923", qty: 7429, status: "Available", updated_date: "2026-10-08T01:00:00Z" },
      { group_uid_code: "1028261006000049", sku: "422273475", qty: 3180, status: "Allocated", updated_date: "2026-10-08T01:01:00Z" },
    ],
  } : null;
  postMessage({ source: "HASAKI_INSIDE_CONNECTOR", requestId: request.requestId, ok: Boolean(data), data, error: data ? null : { message: "Loại yêu cầu chưa giả lập" } }, location.origin);
});

async function mock(page) {
  await page.route("**/*", route => {
    const url = route.request().url(), json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.startsWith(BASE)) return route.continue();
    if (url.endsWith("/auth/v1/user")) return json({ id: "00000000-0000-4000-8000-000000000001" });
    if (url.includes("/rest/v1/user_roles")) return json([{ username: "Admin", role: "admin" }]);
    if (url.includes("/functions/v1/group-uid-sync")) {
      const body = JSON.parse(route.request().postData() || "{}"), ok = data => json({ ok: true, data });
      if (body.action === "history") return ok({ state: { last_successful_incremental_at: "2026-10-08T00:00:00Z", last_successful_full_at: "2026-10-07T00:00:00Z" }, runs: [{ id: "44444444-4444-4444-8444-444444444444", mode: "full", status: "failed", error_message: "Admin hủy bản xem trước", created_at: "2026-10-08T01:00:00Z", source_count: 2, change_counts: {}, range_to: "2026-10-08T01:00:00Z" }] });
      if (body.action === "prepare") return ok({ runId: RUN, mode: body.mode, status: "running", rangeFrom: body.mode === "incremental" ? "2026-10-07T23:30:00Z" : null, rangeTo: "2026-10-08T02:00:00Z" });
      if (body.action === "ingest") return ok({ runId: RUN, page: 1, pageCount: 1, totalPages: 1 });
      if (body.action === "preview") return ok(scenario === "many" ? { runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2000, changeCounts: manyCounts, verification: { previousFullCount: 0, fullDropPercent: 0 }, changes: MANY } : scenario === "warn"
        ? { runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2, changeCounts: warnCounts, verification: { previousFullCount: 30000, fullDropPercent: 5 }, changes }
        : { runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2, changeCounts: counts, verification: { previousFullCount: 2, fullDropPercent: 0 }, changes });
      if (body.action === "detail") return ok({ id: RUN, runId: RUN, mode: "full", status: "previewed", range_to: "2026-10-08T02:00:00Z", page_count: 1, source_count: 2, change_counts: counts, changes: (scenario === "many" ? MANY : changes).filter(row => !body.changeType || row.changeType === body.changeType) });
      if (body.action === "apply") return ok({ runId: RUN, status: "completed", verification: { verified: 2, databaseCount: 28468 } });
      if (body.action === "cancel") { cancelCalls += 1; return ok({ id: RUN, status: "failed" }); }
    }
    if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
    return json({ ok: true, data: { agents: [], jobs: [], items: [] } });
  });
}

(async()=>{
  const browser=await chromium.launch({channel:"chrome",headless:true});
  try{
    for(const width of [1280,375]){
      const context=await browser.newContext({viewport:{width,height:900}});
      await context.addInitScript(key=>sessionStorage.setItem(key,JSON.stringify({access_token:"test-admin-token",refresh_token:"test-refresh-token"})),SESSION_KEY);
      await context.addInitScript(fakeExtension);
      const page=await context.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));await mock(page);
      await page.goto(BASE+"#admin/group-uid-sync");await page.locator("#group-uid-sync-screen").waitFor({state:"visible"});
      await page.locator("#gu-run-full").click();await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      assert.equal((await page.locator("#gu-source").innerText()).trim(),"2");assert.equal((await page.locator("#gu-added").innerText()).trim(),"1");assert.equal((await page.locator("#gu-updated").innerText()).trim(),"1");assert.equal(await page.locator("#gu-apply").isEnabled(),true);
      assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),false,"xem trước xong không tự mở popup");assert.equal(await page.locator("#gu-apply").getAttribute("data-count"),"2","nút Cập nhật ghi số thay đổi");assert.equal(await page.locator('[data-gu-kind="missing"]').getAttribute("data-zero"),"true");await page.locator('[data-gu-kind="missing"]').click();await page.waitForTimeout(150);assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),false,"ô 0 dòng không mở popup");
      await page.locator('[data-gu-kind="added"]').click();await page.locator("#gu-dialog").waitFor({state:"visible"});assert.equal((await page.locator("#gu-change-title").innerText()).trim(),"UID mới");assert.equal(await page.locator("#gu-dialog .as-d-mark svg").count(),1);
      assert.match(await page.locator("#gu-change-body").innerText(),/422439472 × 7/);assert.match(await page.locator("#gu-change-body").innerText(),/creator@hasaki\.vn/,"UID mới ghi người cập nhật");
      await page.locator('.as-tab[data-gu-tab="updated"]').click();await page.waitForFunction(()=>document.getElementById("gu-change-title").textContent==="UID cập nhật");assert.match(await page.locator("#gu-change-body").innerText(),/3\.000|3000/);assert.match(await page.locator("#gu-change-body").innerText(),/3\.180|3180/);assert.match(await page.locator("#gu-change-body").innerText(),/old@hasaki\.vn/,"cột Cập nhật WMS ghi người cập nhật kể cả khi người cập nhật không đổi");assert.equal(await page.locator("#gu-change-body .as-diff .as-k",{hasText:"Người cập nhật"}).count(),0,"người cập nhật không đổi thì không hiện thành dòng so sánh");assert.equal(await page.locator("#gu-change-body .as-by").count(),1);
      await page.keyboard.press("Escape");await page.locator("#gu-dialog").waitFor({state:"hidden"});assert.equal(await page.locator("#gu-warn").isHidden(),true,"không có cảnh báo khi dữ liệu bình thường");assert.equal(await page.locator("#gu-cancel").isEnabled(),true);
      await page.locator("#gu-apply").click();const confirm=page.locator("dialog.whd");await confirm.waitFor({state:"visible"});assert.match(await confirm.locator(".whd-title").innerText(),/^Cập nhật 2 UID vào Supabase$/);assert.deepEqual(await confirm.locator(".whd-facts li").allInnerTexts(),["1 UID mới","1 UID cập nhật"]);await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Hoàn tất/.test(document.getElementById("gu-status").textContent));
      assert.equal(await page.locator("#gu-cancel").isDisabled(),true,"đã cập nhật xong thì không còn gì để hủy");assert.match(await page.locator("#gu-history").textContent(),/Đã hủy/);
      assert.equal(await page.locator("#gu-history").isVisible(),false,"lịch sử gọn: bảng chỉ mở khi bấm");assert.match(await page.locator("#gu-hist-count").innerText(),/lượt$/);await page.locator("#gu-history-btn").click();await page.locator("#gu-hist-dialog").waitFor({state:"visible"});assert.match(await page.locator("#gu-hist-note").innerText(),/lượt gần nhất$/);await page.keyboard.press("Escape");await page.locator("#gu-hist-dialog").waitFor({state:"hidden"});
      scenario="warn";cancelCalls=0;await page.locator("#gu-run-full").click();await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      assert.equal(await page.locator("#gu-warn").isVisible(),true);const warn=await page.locator("#gu-warn").innerText();assert.match(warn,/giảm 5%/);assert.match(warn,/3 UID thiếu trên WMS/);assert.match(warn,/1 UID có dữ liệu WMS cũ hơn database/);await page.locator('#gu-warn [data-gu-tab="missing"]').click();await page.locator("#gu-dialog").waitFor({state:"visible"});assert.equal((await page.locator("#gu-change-title").innerText()).trim(),"Thiếu trên WMS");await page.keyboard.press("Escape");await page.locator("#gu-dialog").waitFor({state:"hidden"});
      await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-cancel").click();await confirm.waitFor({state:"hidden"});assert.equal(cancelCalls,0,"Giữ lại thì không hủy");assert.equal(await page.locator("#gu-cancel").isEnabled(),true);
      await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Đã hủy bản xem trước/.test(document.getElementById("gu-status").textContent));
      assert.equal(cancelCalls,1);assert.equal(await page.locator("#gu-apply").isDisabled(),true);assert.equal(await page.locator("#gu-cancel").isDisabled(),true);assert.equal(await page.locator("#gu-warn").isHidden(),true);assert.equal((await page.locator("#gu-source").innerText()).trim(),"0");assert.match(await page.locator("#gu-change-body").innerText(),/Chưa có dữ liệu đối chiếu/);scenario="normal";
      scenario="many";await page.locator("#gu-run-full").click();await page.waitForFunction(()=>/Đối chiếu xong/.test(document.getElementById("gu-status").textContent));
      await page.locator('[data-gu-kind="updated"]').click();await page.locator("#gu-dialog").waitFor({state:"visible"});assert.equal(await page.locator("#gu-dialog .as-tab").count(),4);assert.match(await page.locator('#gu-dialog .as-tab[aria-selected="true"]').textContent(),/120/);
      assert.equal(await page.locator("#gu-bar i").count()>=2,true,"thanh cơ cấu có từ 2 đoạn");assert.match(await page.locator("#gu-legend").innerText(),/Không đổi/);assert.match(await page.locator("#gu-legend").innerText(),/%/);assert.equal(await page.locator(".gu-note").count(),0,"không còn câu giải thích");
      assert.equal((await page.locator("#gu-pager").innerText()).includes("Hiển thị 1–50 / 120"),true);assert.equal(await page.locator("#gu-change-body tr").count(),50);
      await page.locator('[data-as-page="1"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("Hiển thị 51–100 / 120"),true);
      const rowText=await page.locator("#gu-change-body tr").first().innerText();for(const part of ["Số lượng","+180"])assert.equal(rowText.includes(part),true,part);assert.equal(rowText.includes("updated_date"),false);
      await page.locator("#gu-tools input").fill("000050");assert.equal(await page.locator("#gu-change-body tr").count(),1);assert.equal((await page.locator("#gu-change-note").innerText()).trim(),"1 / 120 dòng");await page.locator("#gu-tools input").fill("");
      await page.locator('[data-as-tag="loc"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 60"),true);await page.locator('[data-as-tag="loc"]').click();
      // Cột Kho + bộ lọc Kho (chọn nhiều, có số đếm), chip cũ đổi tên "Đổi kho"
      assert.deepEqual(await page.locator("#gu-change-head th").allInnerTexts(),["Group UID","Kho","Thay đổi","Cập nhật WMS"]);
      assert.equal((await page.locator("#gu-change-body tr").first().locator("td").nth(1).innerText()).includes("WH - "),true,"mỗi dòng hiện kho");
      await page.locator('[data-as-facet="wh"] .as-facet-btn').click();
      assert.equal(await page.locator(".as-facet-pop").isVisible(),true);assert.equal(await page.locator(".as-opt").count(),3);
      for(const n of await page.locator(".as-opt b").allInnerTexts())assert.equal(n.trim(),"40","mỗi kho 40 dòng");
      await page.locator('.as-opt:has-text("MATERIAL - GARMENT") input').check();
      assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 40"),true);assert.equal(await page.locator(".as-facet-pop").isVisible(),true,"chọn xong danh sách vẫn mở");
      assert.equal((await page.locator(".as-facet-btn").innerText()).includes("1"),true,"nút Kho hiện số kho đã chọn");
      await page.keyboard.press("Escape");assert.equal(await page.locator(".as-facet-pop").count(),0,"Esc đóng danh sách kho");assert.equal(await page.locator("#gu-dialog").evaluate(d=>d.open),true,"Esc chỉ đóng danh sách, không đóng cửa sổ");
      assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 40"),true,"bộ lọc kho còn hiệu lực sau khi đóng");
      await page.locator('[data-as-tag="loc"]').click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 20"),true,"kho GARMENT và đổi vị trí = 20");await page.locator('[data-as-tag="loc"]').click();
      await page.locator('[data-as-facet="wh"] .as-facet-btn').click();assert.deepEqual(await page.locator(".as-opt b").allInnerTexts(),["40","40","40"]);
      await page.locator('.as-opt:has-text("SEMI PRODUCT") input').check();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 80"),true,"chọn 2 kho = 80");
      await page.locator("[data-as-clear]").click();assert.equal((await page.locator("#gu-pager").innerText()).includes("/ 120"),true,"Xóa chọn trả về đủ 120");await page.keyboard.press("Escape");
      await page.locator("#gu-tools input").fill("semi product");assert.equal((await page.locator("#gu-change-note").innerText()).trim(),"40 / 120 dòng","ô tìm tìm được cả theo tên kho");await page.locator("#gu-tools input").fill("");
            await page.locator('[data-as-sort="wms"]').click();assert.equal(await page.locator("#gu-change-head th[aria-sort=descending]").count(),1);assert.equal((await page.locator("#gu-change-body code").first().innerText()).trim().endsWith("000119"),true,"mới nhất đứng đầu");
      const [download]=await Promise.all([page.waitForEvent("download"),page.locator("#gu-tools [data-as-export]").click()]);assert.equal(download.suggestedFilename().startsWith("group-uid-updated-"),true);const csv=require("node:fs").readFileSync(await download.path(),"utf8");assert.equal(csv.charCodeAt(0),0xfeff);assert.match(csv,/Người cập nhật/);assert.equal(csv.trim().split(String.fromCharCode(13,10)).length,121,"tiêu đề + 120 dòng");assert.equal(csv.split(String.fromCharCode(13,10))[0].includes('"Kho"'),true,"CSV có cột Kho");assert.equal(csv.includes("WH - SEMI PRODUCT - MTG"),true);
      await page.keyboard.press("Escape");await page.locator("#gu-dialog").waitFor({state:"hidden"});
      await page.locator("#gu-cancel").click();await confirm.waitFor({state:"visible"});await confirm.locator(".whd-ok").click();await page.waitForFunction(()=>/Đã hủy bản xem trước/.test(document.getElementById("gu-status").textContent));scenario="normal";
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}px: Group UID full/preview/detail/apply, cảnh báo, hủy xem trước, responsive`);
    }
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
