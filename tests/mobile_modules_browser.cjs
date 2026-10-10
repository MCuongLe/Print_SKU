// Giao diện điện thoại đợt 1 (10/10/2026) cho các module còn lại: font hệ thống, tab Cắt UID / Xả vải không vỡ chữ (nhãn ngắn),
// nút bàn phím dạng icon cạnh ô quét (Xả vải, Gom hàng mẫu), số thứ tự khối IN TEM GROUP UID theo đúng thứ tự 1-2-3-4,
// dòng "Tìm thấy …" của Tra cứu không hiện ở tab Quét. Dữ liệu giả rỗng, không gọi Supabase thật. Chạy với python -m http.server 8000.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = 'http://127.0.0.1:8000/';
const SCREENS = { 'group-uid': 'uid-screen', inspection: 'ins-screen', sample: 'sample-screen', 'fabric-relaxation': 'fabric-screen', 'cut-group-uid': 'cut-group-uid-screen', 'xa-vai': 'xa-vai-screen', location: 'location-screen', 'storage-risk': 'storage-risk-screen' };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      const mobile = width < 800;
      const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(BASE)) return route.continue();
        if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return route.fulfill({ contentType: 'application/json', body: '[]' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, data: { agents: [], jobs: [], items: [], rows: [] } }) });
      });
      const open = async hash => { await page.goto(BASE + '#' + hash); await page.locator('#' + SCREENS[hash]).waitFor({ state: 'visible' }); await page.waitForTimeout(400); };

      for (const hash of Object.keys(SCREENS)) {
        await open(hash);
        const look = await page.evaluate(id => ({ font: getComputedStyle(document.getElementById(id)).fontFamily, overflow: document.documentElement.scrollWidth > innerWidth }), SCREENS[hash]);
        assert.ok(/^system-ui/.test(look.font), `${hash}: dùng font hệ thống trên mọi khổ (chuẩn chữ 10/10/2026) (${look.font})`);
        assert.equal(look.overflow, false, `${hash}: tràn ngang`);
      }

      // Tab Cắt UID / Xả vải: mỗi tab một dòng (điện thoại nhãn ngắn, máy tính nhãn đầy đủ)
      for (const [hash, labels] of [['cut-group-uid', mobile ? ['Quét', 'Tra cứu', 'Chờ in', 'Đối chiếu'] : ['Quét Group UID', 'Tra cứu UID đã cắt', 'Tem chờ in', 'Đối chiếu']], ['xa-vai', mobile ? ['Quét', 'Đang xả', 'Đã xả'] : ['Quét Group UID', 'Đang xả', 'Đã xả xong']]]) {
        await open(hash);
        const tabs = await page.locator(`#${SCREENS[hash]} .cut-tab`).evaluateAll(nodes => nodes.map(node => ({ text: node.innerText.replace(/\s+/g, ' ').replace(/\b\d+\b/g, '').trim(), h: Math.round(node.getBoundingClientRect().height), right: Math.round(node.getBoundingClientRect().right) })));
        assert.deepEqual(tabs.map(tab => tab.text), labels, `${hash}: nhãn tab`);
        for (const tab of tabs) { assert.ok(tab.h <= 52, `${hash}: tab "${tab.text}" bị vỡ dòng (cao ${tab.h})`); assert.ok(tab.right <= width, `${hash}: tab tràn`); }
      }

      // Dòng "Tìm thấy … UID đã cắt" (kết quả Tra cứu) không hiện ở tab Quét, hiện lại ở tab Tra cứu
      await open('cut-group-uid');
      await page.locator('#cut-tab-scan').click();
      await page.locator('#cut-sku').evaluate(input => { input.value = ''; });
      await page.locator('#cut-search').evaluate(form => form.requestSubmit());
      await page.waitForFunction(() => /Tìm thấy/.test(document.getElementById('cut-message').textContent));
      assert.equal(await page.locator('#cut-message').isVisible(), false, 'tab Quét không hiện số kết quả Tra cứu');
      await page.locator('#cut-tab-data').click();
      assert.equal(await page.locator('#cut-message').isVisible(), true, 'tab Tra cứu vẫn hiện số kết quả');

      if (mobile) {
        // Nút bàn phím là icon cạnh ô quét
        for (const [hash, input, keyboard] of [['xa-vai', '#xa-vai-code', '#xa-vai-keyboard'], ['sample', '#sample-sku', '#sample-keyboard']]) {
          await open(hash);
          const box = await page.evaluate(([i, k]) => { const a = document.querySelector(i).getBoundingClientRect(), b = document.querySelector(k).getBoundingClientRect(); return { sameRow: Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 6, right: b.left >= a.right, w: Math.round(b.width) }; }, [input, keyboard]);
          assert.equal(box.sameRow && box.right, true, `${hash}: nút bàn phím phải nằm cạnh ô quét`);
          assert.ok(box.w <= 48, `${hash}: nút bàn phím chỉ là icon (${box.w}px)`);
        }
        // Gom hàng mẫu: không còn câu hướng dẫn
        assert.equal((await page.locator('#sample-screen').innerText()).includes('quét SKU đầu tiên'), false);
        assert.equal(await page.locator('#sample-sku').getAttribute('placeholder'), 'Quét mã SKU');
      }

      // IN TEM GROUP UID: số khối theo đúng thứ tự xuất hiện
      await open('group-uid');
      const nums = await page.locator('#uid-screen .uid-panel__num').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width > 0).sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(node => node.textContent.trim()));
      if (mobile) assert.deepEqual(nums, ['1', '2', '3', '4'], `số khối IN TEM GROUP UID: ${nums}`);
      assert.deepEqual(await page.locator('#uid-screen .uid-panel__num').allTextContents(), ['1', '2', '3', '4'], 'thứ tự trong trang 1-2-3-4');

      assert.deepEqual(errors, []);
      console.log(`PASS ${width}px: các module — font hệ thống, tab không vỡ chữ, bàn phím dạng icon, số khối 1-2-3-4, "Tìm thấy…" không hiện ở tab Quét`);
      await context.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
