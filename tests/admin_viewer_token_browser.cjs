// Đợt B (23/10/2026, C2): máy chủ che phần sau @ của email cho người ngoài (backend_hygiene_v1). Admin đã đăng nhập phải gửi kèm
// phiên Admin ở 3 chỗ đọc có email — Lịch sử Group UID (group_uid_moves_lookup), Đối chiếu ADJ (cut_group_uid_reconcile), UID tạm
// (uid_temp_snapshot / uid_temp_overview) — để thấy email đầy đủ. PrintSkuAdminAccess.viewerToken(): có phiên còn hạn → token,
// không phiên → "" (KHÔNG mở hộp đăng nhập), token sắp hết hạn → gia hạn qua PrintSkuAdminAuth.
//   node tests/admin_viewer_token_browser.cjs   (máy chủ tĩnh cổng 8000, đổi bằng BASE)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const SESSION_KEY = 'print-sku-admin-session-v1';
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = expSec => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: '00000000-0000-0000-0000-000000000001', exp: expSec })}.sig`;
const FRESH = jwt(Math.floor(Date.now() / 1000) + 3600);
const STALE = jwt(Math.floor(Date.now() / 1000) + 20);

// Ba chỗ gọi trong index.html gửi viewerToken (kiểm tĩnh — mỗi màn đã có test riêng cho dữ liệu)
const html = fs.readFileSync('index.html', 'utf8');
assert.ok(html.includes("rpc('cut_group_uid_reconcile',args,await window.PrintSkuAdminAccess?.viewerToken?.())"), 'Đối chiếu ADJ gửi phiên Admin');
assert.match(html, /const viewer = await window\.PrintSkuAdminAccess\?\.viewerToken\?\.\(\) \|\| "";\s+const data = await anonRpc\("group_uid_moves_lookup", \{[^}]*\}, viewer\);/, 'Lịch sử Group UID gửi phiên Admin');
assert.ok(html.includes('key:viewer?"uid_temp:admin":"uid_temp"') && html.includes('call:(name,args)=>rpcCall(name,args,viewer)') && html.includes('rpcCall("uid_temp_overview",{},viewer)'), 'UID tạm: phiên Admin + khoá cache riêng');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const [label, session, expect] of [['không phiên', null, ''], ['phiên còn hạn', FRESH, FRESH], ['phiên sắp hết hạn', STALE, 'renewed-token']]) {
      const context = await browser.newContext();
      if (session) await context.addInitScript(([key, token]) => sessionStorage.setItem(key, JSON.stringify({ access_token: token, refresh_token: 'r' })), [SESSION_KEY, session]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => (route.request().url().startsWith(BASE) ? route.continue() : route.fulfill({ contentType: 'application/json', body: '{"ok":true,"data":{}}' })));
      await page.goto(BASE + '#home');
      await page.waitForFunction(() => typeof window.PrintSkuAdminAccess?.viewerToken === 'function');
      const got = await page.evaluate(async () => {
        window.__renew = 0;
        window.PrintSkuAdminAuth.accessToken = async () => { window.__renew++; return 'renewed-token'; };
        const token = await window.PrintSkuAdminAccess.viewerToken();
        return { token, renew: window.__renew, login: Boolean(document.querySelector('#admin-auth:not([hidden])')?.offsetParent) };
      });
      assert.equal(got.token, expect, `${label}: token`);
      assert.equal(got.renew, session === STALE ? 1 : 0, `${label}: chỉ gia hạn khi sắp hết hạn`);
      assert.equal(got.login, false, `${label}: không mở hộp đăng nhập`);
      assert.deepEqual(errors, []);
      await context.close();
    }
    console.log('admin_viewer_token_browser: viewerToken (không phiên → "", còn hạn → token, sắp hết → gia hạn, không mở đăng nhập); 3 chỗ đọc email gửi phiên Admin passed');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
