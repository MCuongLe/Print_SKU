// Trang Options của Extension (options.html + options.js): đăng nhập Admin, tên máy, công tắc, trạng thái, lượt gần nhất, nhật ký.
// Chạy với python -m http.server 8000 (đổi bằng biến BASE). `chrome` được giả lập bằng addInitScript; không gọi mạng thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const URL = BASE + 'extension/inside-po-connector/options.html';

// chrome.runtime giả: lưu mọi thông điệp vào window.__msgs, trạng thái ở window.__st (cùng hình dạng AUTO_STATUS trong hợp đồng).
const fakeChrome = initial => {
  const st = {
    signedIn: false, email: '', device: '', enabled: true, running: null,
    last: {
      sku: { at: Date.now() - 600000, status: 'ok', runId: 'run-1', message: '12 SKU mới, 3 SKU sửa' },
      group_uid: { at: Date.now() - 1800000, status: 'held', runId: 'run-2', message: 'Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000' },
    },
    log: [
      { at: Date.now() - 600000, kind: 'sku', mode: 'incremental', status: 'ok', message: '12 SKU mới, 3 SKU sửa', runId: 'run-1' },
      { at: Date.now() - 1800000, kind: 'group_uid', mode: 'incremental', status: 'held', message: 'Giữ lại: 3.512 thay đổi vượt ngưỡng 3.000', runId: 'run-2' },
      { at: Date.now() - 3600000, kind: 'group_uid', mode: 'full', status: 'skipped', message: 'Không có tab WMS', runId: null },
    ],
    tabs: { wms: true, inside: false },
    nextAlarmAt: new Date(2026, 9, 17, 14, 30).getTime(),
    config: { enabled: true, intervalMinutes: 30 },
    ...initial,
  };
  window.__st = st;
  window.__msgs = [];
  window.chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ version: '0.10.2' }),
      sendMessage: async message => {
        window.__msgs.push(JSON.parse(JSON.stringify(message)));
        if (window.__failSend) throw new Error('Could not establish connection');
        switch (message.type) {
          case 'AUTO_STATUS': return JSON.parse(JSON.stringify(st));
          case 'AUTO_SIGN_IN':
            if (message.password === 'sai') return { ok: false, error: 'Email hoặc mật khẩu không đúng' };
            st.signedIn = true; st.email = message.email; return { ok: true };
          case 'AUTO_SIGN_OUT': st.signedIn = false; st.email = ''; return { ok: true };
          case 'AUTO_SET_DEVICE': st.device = message.device; return { ok: true };
          case 'AUTO_SET_ENABLED': st.enabled = message.enabled; return { ok: true };
          case 'AUTO_RUN_NOW': return { ok: true, result: { status: 'ok' } };
          default: return { ok: false, error: 'Không hỗ trợ' };
        }
      },
    },
  };
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    // 1) Luồng chính: chưa đăng nhập -> đăng nhập sai -> đúng -> tên máy -> công tắc -> Chạy ngay
    {
      const context = await browser.newContext({ viewport: { width: 760, height: 1100 } });
      await context.addInitScript(fakeChrome, {});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
      page.on('response', response => { if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) errors.push(response.status() + ' ' + response.url()); });
      page.on('dialog', dialog => { errors.push('alert: ' + dialog.message()); dialog.dismiss(); });
      await page.goto(URL);
      await page.locator('#log tr').first().waitFor();

      assert.equal((await page.locator('#ver').innerText()).trim(), 'v0.10.2');
      assert.equal((await page.locator('h1').innerText()).trim(), 'Đồng bộ tự động');
      assert.equal(await page.locator('#signin').isVisible(), true, 'chưa đăng nhập hiện form');
      assert.equal(await page.locator('#signed').isVisible(), false);
      assert.equal(await page.locator('#fatal').isVisible(), false);
      assert.equal(await page.locator('#enabled').isDisabled(), true, 'chưa có tên máy thì khóa công tắc');
      assert.equal((await page.locator('#enabled-sub').innerText()).trim(), 'Nhập tên máy');
      assert.equal((await page.locator('#txt-wms').innerText()).trim(), 'Đang mở');
      assert.equal((await page.locator('#txt-inside').innerText()).trim(), 'Không có tab');
      assert.equal(await page.locator('#dot-wms').getAttribute('data-on'), 'true');
      assert.equal(await page.locator('#dot-inside').getAttribute('data-on'), 'false');
      assert.equal((await page.locator('#next-text').innerText()).trim(), 'Lượt kế: 14:30');
      assert.equal(await page.locator('#paused').isVisible(), false);

      // Mọi khối có icon SVG, không ký tự biểu tượng
      assert.equal(await page.locator('header svg, .card h2 svg').count(), 6);
      assert.equal(await page.locator('svg[data-ico]').evaluateAll(nodes => nodes.every(node => node.querySelector('path, circle, rect, polygon'))), true, 'icon đã được vẽ');

      // Lượt gần nhất: hai hàng SKU / Group UID kèm chip và thông điệp
      const rows = page.locator('#last .last-row');
      assert.equal(await rows.count(), 2);
      assert.deepEqual(await rows.nth(0).locator('.chip').allInnerTexts(), ['Đã áp dụng']);
      assert.deepEqual(await rows.nth(1).locator('.chip').allInnerTexts(), ['Chờ Admin']);
      assert.match(await rows.nth(1).innerText(), /Giữ lại: 3\.512 thay đổi vượt ngưỡng 3\.000/);
      assert.equal((await rows.nth(0).locator('.head span').first().innerText()).trim(), 'SKU');
      assert.equal((await rows.nth(1).locator('.head span').first().innerText()).trim(), 'Group UID');

      // Nhật ký: 3 dòng, chip đúng tông
      const logRows = page.locator('#log tr');
      assert.equal(await logRows.count(), 3);
      assert.deepEqual(await page.locator('#log .chip').evaluateAll(nodes => nodes.map(node => [node.dataset.tone, node.textContent.trim()])), [['ok', 'Đã áp dụng'], ['held', 'Chờ Admin'], ['skipped', 'Bỏ qua']]);
      assert.deepEqual(await page.locator('#log tr').first().locator('td').evaluateAll(cells => cells.map(cell => cell.textContent.trim())).then(cells => [cells[1], cells[2], cells[4]]), ['SKU', 'Gia tăng', '12 SKU mới, 3 SKU sửa']);
      assert.deepEqual(await page.locator('#log tr').nth(2).locator('td').evaluateAll(cells => [cells[1].textContent.trim(), cells[2].textContent.trim()]), ['Group UID', 'Toàn bộ']);
      const chipColors = await page.locator('#log .chip').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
      assert.equal(new Set(chipColors).size, 3, 'ba tông chip khác màu chữ');

      // Đăng nhập sai: lỗi chữ đỏ ngay dưới form, không alert
      await page.locator('#email').fill('admin-test@example.com');
      await page.locator('#password').fill('sai');
      await page.locator('#signin-btn').click();
      await page.locator('#signin-err').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#signin-err').innerText()).trim(), 'Email hoặc mật khẩu không đúng');
      assert.equal(await page.locator('#signin-err').evaluate(node => getComputedStyle(node).color), 'rgb(180, 35, 24)');
      assert.equal(await page.locator('#signin').isVisible(), true);
      // Đăng nhập đúng: hiện email, ẩn form, ô mật khẩu xóa
      await page.locator('#password').fill('mat-khau-gia');
      await page.locator('#signin-btn').click();
      await page.locator('#signed').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#who-email').innerText()).trim(), 'admin-test@example.com');
      assert.equal(await page.locator('#signin').isVisible(), false);
      assert.equal(await page.locator('#password').inputValue(), '');
      const signIn = (await page.evaluate(() => window.__msgs)).filter(message => message.type === 'AUTO_SIGN_IN');
      assert.deepEqual(signIn.map(message => [message.email, message.password]), [['admin-test@example.com', 'sai'], ['admin-test@example.com', 'mat-khau-gia']]);

      // Tên máy: Enter lưu, công tắc mở khóa rồi tắt gửi AUTO_SET_ENABLED
      await page.locator('#device').fill('may-test');
      await page.locator('#device').press('Enter');
      await page.waitForFunction(() => !document.getElementById('enabled').disabled);
      assert.deepEqual((await page.evaluate(() => window.__msgs)).filter(message => message.type === 'AUTO_SET_DEVICE'), [{ type: 'AUTO_SET_DEVICE', device: 'may-test' }]);
      assert.equal(await page.locator('#enabled-sub').isVisible(), false);
      assert.equal(await page.locator('#enabled').isChecked(), true);
      await page.locator('#enabled').evaluate(node => node.click());
      await page.waitForFunction(() => window.__msgs.some(message => message.type === 'AUTO_SET_ENABLED'));
      assert.deepEqual((await page.evaluate(() => window.__msgs)).filter(message => message.type === 'AUTO_SET_ENABLED'), [{ type: 'AUTO_SET_ENABLED', enabled: false }]);
      await page.waitForFunction(() => !document.getElementById('enabled').checked);
      // Tên máy trống: báo lỗi, không gửi
      await page.locator('#device').fill('');
      await page.locator('#device').press('Enter');
      assert.equal((await page.locator('#device-err').innerText()).trim(), 'Nhập tên máy');
      await page.locator('#device').fill('may-test');
      await page.locator('#device').press('Enter');

      // Chạy ngay: menu 2 lựa chọn, chọn Toàn bộ gửi AUTO_RUN_NOW
      await page.locator('[data-run-toggle="sku"]').click();
      assert.deepEqual(await page.locator('[data-menu="sku"] button').allInnerTexts(), ['Gia tăng', 'Toàn bộ']);
      await page.locator('[data-menu="sku"] [data-mode="full"]').click();
      await page.waitForFunction(() => window.__msgs.some(message => message.type === 'AUTO_RUN_NOW'));
      assert.deepEqual((await page.evaluate(() => window.__msgs)).find(message => message.type === 'AUTO_RUN_NOW'), { type: 'AUTO_RUN_NOW', kind: 'sku', mode: 'full' });

      // Đăng xuất quay lại form
      await page.locator('#signout-btn').click();
      await page.locator('#signin').waitFor({ state: 'visible' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'không tràn ngang');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: process.env.SHOT || undefined, fullPage: true }).catch(() => {});
      await context.close();
      console.log('PASS options: form đăng nhập, lỗi đỏ, email sau đăng nhập, công tắc khóa khi chưa có tên máy, menu Chạy ngay, nhật ký 3 dòng đúng tông, không lỗi console');
    }

    // 2) Admin tạm dừng: dòng cam hiện; đang chạy: nút Chạy ngay khóa
    {
      const context = await browser.newContext({ viewport: { width: 760, height: 900 } });
      await context.addInitScript(fakeChrome, { signedIn: true, email: 'admin-test@example.com', device: 'may-test', config: { enabled: false }, running: { kind: 'group_uid' }, tabs: { wms: false, inside: true } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(URL);
      await page.locator('#signed').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#paused').isVisible(), true);
      assert.equal((await page.locator('#paused').innerText()).trim(), 'Admin tạm dừng');
      assert.equal(await page.locator('#enabled').isDisabled(), false);
      assert.equal(await page.locator('#dot-inside').getAttribute('data-on'), 'true');
      assert.equal((await page.locator('#txt-wms').innerText()).trim(), 'Không có tab');
      assert.deepEqual(await page.locator('[data-run-toggle]').evaluateAll(nodes => nodes.map(node => node.disabled)), [true, true], 'đang chạy thì khóa cả hai nút');
      assert.equal(await page.locator('[data-run-toggle="group_uid"] .spin').count(), 1, 'spinner ở hàng đang chạy');
      assert.equal(await page.locator('[data-run-toggle="sku"] .spin').count(), 0);
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS options: Admin tạm dừng hiện dòng cam, đang chạy khóa nút và có spinner');
    }

    // 3) Service worker không trả lời: hiện dòng lỗi, không ném lỗi
    {
      const context = await browser.newContext({ viewport: { width: 760, height: 900 } });
      await context.addInitScript(fakeChrome, {});
      await context.addInitScript(() => { window.__failSend = true; });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(URL);
      await page.locator('#fatal').waitFor({ state: 'visible' });
      assert.equal((await page.locator('#fatal').innerText()).trim(), 'Không gọi được service worker, Reload Extension');
      assert.deepEqual(errors, []);
      await context.close();
      console.log('PASS options: sendMessage lỗi hiện dòng Reload Extension');
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
