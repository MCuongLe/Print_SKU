// Thanh biên (23/10/2026, người dùng chọn đề xuất 1 + 2 + 3, giữ "thu gọn = ẩn hẳn"):
// 1) Ngăn kéo < 1024 px: tiêu đề nhóm đọc được (≥ 4,5:1, trước thừa hưởng chữ sáng của trang), mỗi nhóm đúng màu như máy tính.
// 2) Ngăn kéo là hộp thoại: focus vào mục đang mở, Tab quay vòng trong ngăn kéo, Esc đóng và trả focus về nút ☰; Ctrl + \ thu/mở thanh.
// 3) Máy tính, thanh đang thu: rê sát mép trái thì "mở tạm" (đè lên nội dung, không đẩy), rời chuột / Esc thì ẩn; trạng thái nhớ không đổi.
// Chạy với python -m http.server 8000 (đổi bằng BASE). Dữ liệu giả rỗng, không gọi mạng thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const clickTopToggle = () => { const b = [...document.querySelectorAll('.an-toggle')].find(x => { const r = x.getBoundingClientRect(); return r.width && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('.an-toggle') === x; }); if (!b) return false; b.click(); return true; };
const contrast = el => {
  const rgba = c => { const m = c.match(/[\d.]+/g).map(Number); return [m[0], m[1], m[2], m.length > 3 ? m[3] : 1]; };
  const over = (t, b) => [0, 1, 2].map(i => t[i] * t[3] + b[i] * (1 - t[3])).concat(1);
  let bg = [255, 255, 255, 1]; const chain = []; for (let n = el; n; n = n.parentElement) chain.push(n);
  for (const n of chain.reverse()) { const b = rgba(getComputedStyle(n).backgroundColor); if (b[3] > 0) bg = over(b, bg); }
  const L = c => { const l = v => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; return 0.2126 * l(c[0]) + 0.7152 * l(c[1]) + 0.0722 * l(c[2]); };
  const a = L(over(rgba(getComputedStyle(el).color), bg)), b = L(bg);
  return Math.round((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) * 100) / 100;
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const route = page => page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.fulfill({ contentType: 'application/json', body: '[]' }));

    // ── Ngăn kéo (768 px) ──
    let page = await browser.newPage({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await route(page);
    await page.goto(BASE + '#cut-group-uid'); await page.waitForTimeout(800);
    assert.equal(await page.evaluate(clickTopToggle), true, 'bấm được nút ☰');
    await page.waitForTimeout(350);
    const drawer = await page.evaluate(contrastSrc => {
      const contrast = eval(contrastSrc), nav = document.getElementById('app-nav');
      const heads = [...nav.querySelectorAll('.an-head')].map(h => ({ text: h.textContent.trim(), ratio: contrast(h), tone: h.closest('.an-group').dataset.tone, mark: getComputedStyle(h, '::before').backgroundColor }));
      return { open: document.documentElement.classList.contains('app-nav-mobile-open'), role: nav.getAttribute('role'), modal: nav.getAttribute('aria-modal'), focusIn: nav.contains(document.activeElement), focusCurrent: document.activeElement?.getAttribute('aria-current'), heads };
    }, `(${contrast})`);
    assert.equal(drawer.open, true, 'ngăn kéo mở');
    for (const h of drawer.heads) assert.ok(h.ratio >= 4.5, `tiêu đề nhóm "${h.text}" ${h.ratio}:1 < 4,5`);
    const mark = Object.fromEntries(drawer.heads.map(h => [h.tone, h.mark]));
    assert.equal(mark.ops, 'rgb(31, 99, 181)', 'nhóm Vận hành kho: xanh dương');
    assert.equal(mark.check, 'rgb(217, 134, 31)', 'nhóm Kiểm tra: cam');
    assert.equal(new Set(Object.values(mark)).size >= 3, true, 'các nhóm khác màu nhau');
    assert.equal(drawer.role, 'dialog', 'ngăn kéo là hộp thoại');
    assert.equal(drawer.modal, 'true', 'aria-modal');
    assert.equal(drawer.focusIn, true, 'focus vào ngăn kéo');
    assert.equal(drawer.focusCurrent, 'page', 'focus vào mục đang mở');
    // Tab quay vòng
    const trap = await page.evaluate(() => { const b = [...document.querySelectorAll('#app-nav button')].filter(x => x.offsetParent !== null); b[b.length - 1].focus(); return b.length; });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => { const b = [...document.querySelectorAll('#app-nav button')].filter(x => x.offsetParent !== null); return document.activeElement === b[0]; }), true, `Tab ở mục cuối quay về mục đầu (${trap} mục)`);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.evaluate(() => { const b = [...document.querySelectorAll('#app-nav button')].filter(x => x.offsetParent !== null); return document.activeElement === b[b.length - 1]; }), true, 'Shift+Tab ở mục đầu sang mục cuối');
    // Esc đóng, trả focus về nút ☰
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    const closed = await page.evaluate(() => ({ open: document.documentElement.classList.contains('app-nav-mobile-open'), role: document.getElementById('app-nav').getAttribute('role'), focusToggle: !!document.activeElement?.closest('.an-toggle') }));
    assert.deepEqual(closed, { open: false, role: null, focusToggle: true }, 'Esc đóng ngăn kéo, trả focus về nút ☰');
    // Ctrl + \ mở / đóng ngăn kéo
    await page.keyboard.press('Control+Backslash'); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('app-nav-mobile-open')), true, 'Ctrl+\\ mở ngăn kéo');
    await page.keyboard.press('Control+Backslash'); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('app-nav-mobile-open')), false, 'Ctrl+\\ đóng ngăn kéo');
    // Codex 23/10: nền sau ngăn kéo inert; nút X đóng (44 px) trả focus; resize trong cùng khổ không đóng; Esc đã có lớp khác xử lý thì bỏ qua
    const isOpen = () => page.evaluate(() => document.documentElement.classList.contains('app-nav-mobile-open'));
    await page.evaluate(clickTopToggle); await page.waitForTimeout(300);
    const bg = await page.evaluate(() => { const c = document.querySelector('#app-nav .an-close'), r = c && c.getBoundingClientRect(); return { inert: document.getElementById('cut-group-uid-screen').closest('[inert]') !== null, close: c ? [Math.round(r.width), Math.round(r.height), getComputedStyle(c).display] : null }; });
    assert.equal(bg.inert, true, 'nền sau ngăn kéo inert');
    assert.ok(bg.close && bg.close[0] >= 44 && bg.close[1] >= 44 && bg.close[2] !== 'none', `nút X đóng ngăn kéo 44 px (${JSON.stringify(bg.close)})`);
    await page.setViewportSize({ width: 768, height: 900 }); await page.waitForTimeout(250);
    assert.equal(await isOpen(), true, 'resize trong cùng khổ (thanh địa chỉ co giãn) không đóng ngăn kéo');
    await page.evaluate(() => { window.__eatEsc = e => { if (e.key === 'Escape') e.preventDefault(); }; addEventListener('keydown', window.__eatEsc, true); });
    await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    assert.equal(await isOpen(), true, 'Esc đã được lớp khác xử lý (defaultPrevented) thì không đóng ngăn kéo');
    await page.evaluate(() => removeEventListener('keydown', window.__eatEsc, true));
    await page.locator('#app-nav .an-close').click(); await page.waitForTimeout(300);
    const afterX = await page.evaluate(() => ({ open: document.documentElement.classList.contains('app-nav-mobile-open'), inert: document.getElementById('cut-group-uid-screen').closest('[inert]') !== null, focusToggle: !!document.activeElement?.closest('.an-toggle') }));
    assert.deepEqual(afterX, { open: false, inert: false, focusToggle: true }, 'nút X đóng ngăn kéo, bỏ inert, trả focus về nút ☰');
    await page.evaluate(clickTopToggle); await page.waitForTimeout(300);
    await page.setViewportSize({ width: 1280, height: 900 }); await page.waitForTimeout(300);
    assert.equal(await isOpen(), false, 'đổi qua mốc 1024 px thì đóng ngăn kéo');
    assert.equal(await page.evaluate(() => document.querySelector('[inert]') === null || !document.getElementById('cut-group-uid-screen').closest('[inert]')), true, 'đóng do đổi khổ cũng bỏ inert');
    // Codex vòng 2: bấm mục để chuyển màn → ngăn kéo đóng hẳn (không còn nhận focus / Tab), focus không kẹt trong menu vô hình
    await page.setViewportSize({ width: 768, height: 1024 }); await page.waitForTimeout(250);
    await page.evaluate(clickTopToggle); await page.waitForTimeout(300);
    await page.locator('#app-nav [data-an-tile="barcode-find-sku"]').click(); await page.waitForTimeout(450);
    const gone = await page.evaluate(() => ({ open: document.documentElement.classList.contains('app-nav-mobile-open'), vis: getComputedStyle(document.getElementById('app-nav')).visibility, focusIn: !!document.activeElement?.closest('#app-nav'), hash: location.hash }));
    assert.deepEqual(gone, { open: false, vis: 'hidden', focusIn: false, hash: '#find-sku' }, 'bấm mục: chuyển màn, ngăn kéo đóng hẳn (ẩn, không giữ focus)');
    assert.deepEqual(errors, [], '768px: lỗi JavaScript');
    await page.close();
    // Codex vòng 2: màn thấp (390 × 600), mục đang mở ở cuối danh sách → mở ngăn kéo thì cuộn tới mục đó
    page = await browser.newPage({ viewport: { width: 390, height: 600 }, isMobile: true, hasTouch: true });
    page.on('pageerror', e => errors.push(e.message));
    await route(page);
    await page.goto(BASE + '#site-control'); await page.waitForTimeout(800);
    await page.evaluate(clickTopToggle); await page.waitForTimeout(400);
    const seen = await page.evaluate(() => { const it = document.querySelector('#app-nav .an-item[aria-current="page"]'), sc = document.querySelector('#app-nav .an-scroll'); const a = it.getBoundingClientRect(), b = sc.getBoundingClientRect(); return { label: it.textContent.trim(), inView: a.top >= b.top - 1 && a.bottom <= b.bottom + 1, focused: document.activeElement === it }; });
    assert.equal(seen.focused, true, `mục đang mở được focus (${seen.label})`);
    assert.equal(seen.inView, true, `mục đang mở "${seen.label}" nằm trong vùng thấy của ngăn kéo`);
    assert.deepEqual(errors, [], '390px: lỗi JavaScript');
    await page.close();

    // ── Máy tính (1280 px) ──
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.on('pageerror', e => errors.push(e.message));
    await route(page);
    await page.addInitScript(() => { try { localStorage.setItem('wh-app-nav-collapsed', '0'); } catch (_) {} });
    await page.goto(BASE + '#cut-group-uid'); await page.waitForTimeout(800);
    const isCollapsed = () => page.evaluate(() => document.documentElement.classList.contains('app-nav-collapsed'));
    assert.equal(await isCollapsed(), false, 'bắt đầu: thanh mở');
    await page.keyboard.press('Control+Backslash'); await page.waitForTimeout(350);
    assert.equal(await isCollapsed(), true, 'Ctrl+\\ thu thanh');
    assert.equal(await page.evaluate(() => localStorage.getItem('wh-app-nav-collapsed')), '1', 'nhớ trạng thái thu');
    const screenLeft = await page.evaluate(() => Math.round(document.getElementById('cut-group-uid-screen').getBoundingClientRect().left));
    // Mở tạm: rê sát mép trái
    await page.mouse.move(600, 400); await page.mouse.move(3, 400, { steps: 4 }); await page.waitForTimeout(400);
    const peek = await page.evaluate(() => {
      const nav = document.getElementById('app-nav'), item = nav.querySelector('.an-item'), r = item.getBoundingClientRect();
      return { peek: document.documentElement.classList.contains('app-nav-peek'), visible: getComputedStyle(nav).visibility, onTop: document.elementFromPoint(r.left + 40, r.top + r.height / 2)?.closest('#app-nav') === nav,
        left: Math.round(document.getElementById('cut-group-uid-screen').getBoundingClientRect().left), saved: localStorage.getItem('wh-app-nav-collapsed') };
    });
    assert.deepEqual(peek, { peek: true, visible: 'visible', onTop: true, left: screenLeft, saved: '1' }, 'rê sát mép trái: thanh mở tạm đè lên nội dung, không đẩy, không đổi trạng thái nhớ');
    // Rời chuột khỏi thanh → ẩn
    await page.mouse.move(150, 400, { steps: 3 }); await page.mouse.move(900, 400, { steps: 4 }); await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => [document.documentElement.classList.contains('app-nav-peek'), getComputedStyle(document.getElementById('app-nav')).visibility]), [false, 'hidden'], 'rời chuột: thanh ẩn lại');
    // Esc khi đang mở tạm
    await page.mouse.move(3, 300, { steps: 4 }); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('app-nav-peek')), true, 'mở tạm lần hai');
    await page.keyboard.press('Escape'); await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('app-nav-peek')), false, 'Esc ẩn thanh mở tạm');
    // Codex 23/10: chạm (không phải chuột) vào mép không mở tạm; rời cửa sổ (blur) thì ẩn; ẩn lúc focus đang trong thanh thì đưa focus ra ngoài
    const peeking = () => page.evaluate(() => document.documentElement.classList.contains('app-nav-peek'));
    await page.mouse.move(900, 300); await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('app-nav-edge').dispatchEvent(new PointerEvent('pointerenter', { pointerType: 'touch' })));
    await page.waitForTimeout(300);
    assert.equal(await peeking(), false, 'chạm vào mép (pointerType touch) không mở tạm');
    assert.ok(await page.evaluate(() => document.getElementById('app-nav-edge').getBoundingClientRect().width <= 6), 'mép trái ≤ 6 px');
    await page.mouse.move(3, 300, { steps: 4 }); await page.waitForTimeout(400);
    assert.equal(await peeking(), true, 'mở tạm lần ba');
    await page.evaluate(() => dispatchEvent(new Event('blur')));
    await page.waitForTimeout(150);
    assert.equal(await peeking(), false, 'rời cửa sổ (blur) thì ẩn thanh mở tạm');
    await page.mouse.move(900, 300); await page.mouse.move(3, 300, { steps: 4 }); await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#app-nav .an-item').focus());
    await page.mouse.move(150, 300, { steps: 2 }); await page.mouse.move(900, 300, { steps: 4 }); await page.waitForTimeout(500);
    assert.deepEqual(await page.evaluate(() => [document.documentElement.classList.contains('app-nav-peek'), !!document.activeElement?.closest('#app-nav')]), [false, false], 'ẩn mở tạm thì focus không còn kẹt trong thanh ẩn');
    // Mở hẳn bằng phím tắt thì không còn mở tạm
    await page.keyboard.press('Control+Backslash'); await page.waitForTimeout(350);
    assert.deepEqual(await page.evaluate(() => [document.documentElement.classList.contains('app-nav-collapsed'), document.documentElement.classList.contains('app-nav-peek')]), [false, false], 'Ctrl+\\ mở hẳn thanh');
    assert.deepEqual(errors, [], '1280px: lỗi JavaScript');
    await page.close();
    console.log('PASS thanh biên: ngăn kéo rõ tiêu đề + màu nhóm + nút X, là hộp thoại (nền inert, focus, Tab quay vòng, Esc trả focus, resize cùng khổ không đóng), Ctrl+\\ thu/mở, mở tạm khi rê chuột sát mép trái (chạm / rời cửa sổ không kẹt)');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
