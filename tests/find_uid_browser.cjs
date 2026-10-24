// TÌM GROUP UID (21/10/2026): gộp CẤP VẢI và LỰA UID BLOCKED dưới một ô trang chủ; hai phần ĐỘC LẬP (màn, dữ liệu, quét giữ nguyên).
//   * trang chủ chỉ còn ô #barcode-find-uid "TÌM GROUP UID" (2 ô cũ ẩn → thanh bên cũng chỉ 1 mục "Tìm Group UID");
//   * bấm ô → phần dùng gần nhất (lần đầu: Cấp vải); công tắc đầu màn "Cấp vải | UID blocked" đổi qua lại (#cap-vai ↔ #uid-block);
//   * đường dẫn cũ #cap-vai, #uid-block vẫn mở thẳng; thanh bên sáng mục "Tìm Group UID" ở cả hai phần; 390 px không tràn ngang.
// Supabase giả lập, không dữ liệu thật. Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const assert = require("node:assert/strict");
const BASE = process.env.BASE || "http://127.0.0.1:8000/";

const mock = page => page.route("**/*", route => {
  const url = route.request().url(), json = b => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
  if (url.startsWith(BASE)) return route.continue();
  if (url.includes("/rest/v1/") && !url.includes("/rpc/")) return json([]);
  return json({ ok: true, data: { plans: [], items: [], rows: [], list: null, unchanged: false, agents: [], jobs: [] } });
});
const switchState = page => page.evaluate(() => {
  const screen = [...document.querySelectorAll("#cap-vai-screen, #uid-block-screen, #vendor-return-screen")].find(s => !s.hidden);
  const sw = screen?.querySelector(".fu-switch");
  return { hash: location.hash, screen: screen?.id || null, parts: sw ? [...sw.querySelectorAll("[data-fu]")].map(a => [a.dataset.fu, a.textContent.trim(), a.getAttribute("aria-current") === "page"]) : null };
});

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    for (const [width, height] of [[1280, 900], [390, 844]]) {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 800, hasTouch: width < 800 });
      const page = await context.newPage(), errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await mock(page);
      await page.goto(BASE + "#home");
      await page.locator("#barcode-find-uid").waitFor({ state: "visible" });
      assert.match(await page.locator("#barcode-find-uid").innerText(), /TÌM GROUP UID/);
      assert.equal(await page.locator("#barcode-cap-vai").isVisible(), false, "ô CẤP VẢI cũ ẩn");
      assert.equal(await page.locator("#barcode-uid-block").isVisible(), false, "ô LỰA UID BLOCKED cũ ẩn");
      // Lần đầu → Cấp vải; công tắc 2 phần, phần đang mở được đánh dấu
      await page.locator("#barcode-find-uid").click();
      await page.waitForFunction(() => !document.getElementById("cap-vai-screen").hidden);
      let st = await switchState(page);
      assert.equal(st.hash, "#cap-vai");
      assert.deepEqual(st.parts, [["cap-vai", "Cấp vải", true], ["uid-block", "UID blocked", false], ["tra-ncc", "Trả NCC", false]]);
      assert.match(await page.locator("#cap-vai-title").innerText(), /TÌM GROUP UID/);
      // Đổi sang UID blocked
      await page.locator('#cap-vai-screen .fu-switch [data-fu="uid-block"]').click();
      await page.waitForFunction(() => !document.getElementById("uid-block-screen").hidden);
      st = await switchState(page);
      assert.equal(st.hash, "#uid-block");
      assert.deepEqual(st.parts, [["cap-vai", "Cấp vải", false], ["uid-block", "UID blocked", true], ["tra-ncc", "Trả NCC", false]]);
      assert.match(await page.locator("#ub-title").innerText(), /TÌM GROUP UID/);
      assert.equal(await page.evaluate(() => document.getElementById("cap-vai-screen").hidden), true, "hai phần độc lập: chỉ một màn hiện");
      for (const id of ["uid-block-screen"]) assert.equal(await page.evaluate(id => { const s = document.getElementById(id); return s.scrollWidth <= s.clientWidth; }, id), true, `${width}: không tràn ngang`);
      // Phần thứ 3 (24/10/2026): Trả NCC
      await page.locator('#uid-block-screen .fu-switch [data-fu="tra-ncc"]').click();
      await page.waitForFunction(() => !document.getElementById("vendor-return-screen").hidden);
      st = await switchState(page);
      assert.equal(st.hash, "#tra-ncc");
      assert.deepEqual(st.parts, [["cap-vai", "Cấp vải", false], ["uid-block", "UID blocked", false], ["tra-ncc", "Trả NCC", true]]);
      assert.equal(await page.evaluate(() => { const s = document.getElementById("vendor-return-screen"); return s.scrollWidth <= s.clientWidth; }), true, `${width}: Trả NCC không tràn ngang`);
      await page.locator('#vendor-return-screen .fu-switch [data-fu="uid-block"]').click();
      await page.waitForFunction(() => !document.getElementById("uid-block-screen").hidden);
      // Về trang chủ rồi bấm ô lại → mở phần dùng gần nhất (UID blocked)
      await page.goto(BASE + "#home");
      await page.locator("#barcode-find-uid").click();
      await page.waitForFunction(() => location.hash === "#uid-block" && !document.getElementById("uid-block-screen").hidden);
      // Đường dẫn cũ mở thẳng
      await page.goto(BASE + "#cap-vai");
      await page.waitForFunction(() => !document.getElementById("cap-vai-screen").hidden);
      assert.equal((await switchState(page)).parts[0][2], true);
      if (width >= 1024) {
        // Thanh bên: đúng 1 mục "Tìm Group UID" (không còn Cấp vải / Lựa UID blocked), sáng ở cả hai phần
        const nav = await page.evaluate(() => [...document.querySelectorAll("#app-nav .an-item")].filter(e => !e.hidden && getComputedStyle(e).display !== "none").map(e => e.textContent.trim()).filter(Boolean));
        assert.equal(nav.filter(t => /Tìm Group UID/.test(t)).length, 1, `thanh bên có 1 mục Tìm Group UID: ${JSON.stringify(nav)}`);
        assert.equal(nav.some(t => /^(Cấp vải|Lựa UID blocked)$/.test(t)), false, "thanh bên không còn mục cũ");
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log("find_uid_browser: 1 ô TÌM GROUP UID (2 ô cũ ẩn), công tắc Cấp vải | UID blocked, nhớ phần dùng gần nhất, đường dẫn cũ mở thẳng, thanh bên 1 mục, 390 không tràn — passed");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
