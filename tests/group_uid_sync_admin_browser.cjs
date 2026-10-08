// Dashboard Group UID: hai chế độ, preview, bảng thay đổi, apply và responsive.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = "http://127.0.0.1:8000/", SESSION_KEY = "print-sku-admin-session-v1", RUN = "33333333-3333-4333-8333-333333333333";
const changes = [
  { groupUidCode: "1028261006000050", changeType: "added", before: null, after: { sku: "422268923", qty: 7429, status: "Available", updated_date: "2026-10-08T01:00:00Z" }, changedFields: ["group_uid_code"], sourceUpdatedAt: "2026-10-08T01:00:00Z" },
  { groupUidCode: "1028261006000049", changeType: "updated", before: { qty: 3000, status: "Available" }, after: { qty: 3180, status: "Allocated" }, changedFields: ["qty", "status"], sourceUpdatedAt: "2026-10-08T01:01:00Z" },
];
const counts = { added: 1, updated: 1, unchanged: 0, missing: 0, issues: 0, totalChanges: 2 };

const fakeExtension = () => addEventListener("message", event => {
  const request = event.data;
  if (!request || request.source !== "PRINT_SKU_APP") return;
  const data = request.type === "PING_WMS" ? { version: "0.4.0" } : request.type === "GET_GROUP_UID_PAGE" ? {
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
      if (body.action === "history") return ok({ state: { last_successful_incremental_at: "2026-10-08T00:00:00Z", last_successful_full_at: "2026-10-07T00:00:00Z" }, runs: [] });
      if (body.action === "prepare") return ok({ runId: RUN, mode: body.mode, status: "running", rangeFrom: body.mode === "incremental" ? "2026-10-07T23:30:00Z" : null, rangeTo: "2026-10-08T02:00:00Z" });
      if (body.action === "ingest") return ok({ runId: RUN, page: 1, pageCount: 1, totalPages: 1 });
      if (body.action === "preview") return ok({ runId: RUN, mode: "full", status: "previewed", rangeTo: "2026-10-08T02:00:00Z", pageCount: 1, sourceCount: 2, changeCounts: counts, changes });
      if (body.action === "detail") return ok({ id: RUN, runId: RUN, mode: "full", status: "previewed", range_to: "2026-10-08T02:00:00Z", page_count: 1, source_count: 2, change_counts: counts, changes: changes.filter(row => !body.changeType || row.changeType === body.changeType) });
      if (body.action === "apply") return ok({ runId: RUN, status: "completed", verification: { verified: 2, databaseCount: 28468 } });
      if (body.action === "cancel") return ok({ id: RUN, status: "failed" });
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
      await page.locator('[data-gu-kind="updated"]').click();await page.waitForFunction(()=>document.getElementById("gu-change-title").textContent==="UID cập nhật");assert.match(await page.locator("#gu-change-body").innerText(),/3\.000|3000/);assert.match(await page.locator("#gu-change-body").innerText(),/3\.180|3180/);
      await page.locator("#gu-apply").click();await page.waitForFunction(()=>/Hoàn tất/.test(document.getElementById("gu-status").textContent));
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);await context.close();console.log(`PASS ${width}px: Group UID full/preview/detail/apply, responsive`);
    }
  }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
