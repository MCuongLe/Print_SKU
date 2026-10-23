// Âm báo + rung khi quét dùng chung (23/10/2026, Đợt 4 theo skill UI UX Pro Max; người dùng chọn "Gom về một bộ chung"):
// một bộ window.PrintSkuScanCue cho 4 màn đang có âm (Cấp vải, Cắt UID khối quét, UID blocked, camera IN TEM SKU) — cùng nghĩa cùng tiếng:
// đạt 1040 Hz · cảnh báo 2×660 Hz · lỗi 180 Hz trầm · blocked 220+180 Hz dài · QC 880+1320 · lưu kho 520; rung theo loại; tắt âm vẫn rung.
// Giả AudioContext + navigator.vibrate để ghi lại. Chạy với python -m http.server 8000 (đổi bằng BASE). Không gọi mạng thật.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';

(async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.equal((html.match(/createOscillator/g) || []).length, 1, 'chỉ một nơi tạo âm (bộ chung), không chép riêng từng màn');
  assert.match(html, /PrintSkuScanCue\.play\("ok"\)/, 'camera IN TEM SKU dùng tiếng đạt chung');

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await context.addInitScript(() => {
      window.__cue = { osc: [], vib: [] };
      class FakeCtx {
        constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
        resume() { return Promise.resolve(); }
        createOscillator() { const o = { frequency: { value: 0 }, connect: n => n, start: () => window.__cue.osc.push(o.frequency.value), stop() {} }; return o; }
        createGain() { const g = { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: n => n }; return g; }
      }
      window.AudioContext = FakeCtx; window.webkitAudioContext = FakeCtx;
      navigator.vibrate = p => { window.__cue.vib.push(p); return true; };
    });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto(BASE + '#home');
    await page.waitForTimeout(500);

    const play = (tone, opts) => page.evaluate(([tone, opts]) => { window.__cue = { osc: [], vib: [] }; window.PrintSkuScanCue.play(tone, opts); return window.__cue; }, [tone, opts]);
    assert.equal(await page.evaluate(() => typeof (window.PrintSkuScanCue && window.PrintSkuScanCue.play)), 'function', 'có window.PrintSkuScanCue.play');
    const want = { ok: [[1040], 40], warn: [[660, 660], [70, 50, 70]], error: [[180], [70, 50, 70]], blocked: [[220, 180], [220, 90, 220, 90, 220]], qc: [[880, 1320], 40], store: [[520], 40] };
    for (const [tone, [freqs, vib]] of Object.entries(want)) {
      const r = await play(tone);
      assert.deepEqual(r.osc, freqs, `tiếng ${tone}`);
      assert.deepEqual(r.vib, [vib], `rung ${tone}`);
    }
    const muted = await play('error', { sound: false });
    assert.deepEqual(muted.osc, [], 'tắt âm: không kêu');
    assert.deepEqual(muted.vib, [[70, 50, 70]], 'tắt âm: vẫn rung');
    // Bí danh của từng màn (Codex 23/10: UID blocked "dup" từng rơi vào tiếng lỗi) — cùng nghĩa cùng tiếng như trước khi gom
    for (const [alias, freqs] of [['dup', [660, 660]], ['bad', [180]], ['cut', [1040]]]) assert.deepEqual((await play(alias)).osc, freqs, `bí danh ${alias}`);
    // Mọi tên tiếng có trong mã phải là tiếng/bí danh đã biết (không lặng lẽ rơi vào tiếng lỗi)
    const known = await page.evaluate(() => window.PrintSkuScanCue.tones);
    // cue('…') của từng màn + lời gọi thẳng PrintSkuScanCue.play('…') + vai trò động của Cắt UID (item.role ∈ cut/qc/store)
    const used = new Set([...html.matchAll(/\bcue\('([a-z]+)'\)|PrintSkuScanCue\.play\(["']([a-z]+)["']/g)].map(m => m[1] || m[2]).concat(['qc', 'store', 'cut']));
    assert.deepEqual([...used].filter(t => !known.includes(t)), [], 'tên tiếng trong mã chưa có trong bộ chung');

    // Mỗi màn đi qua bộ chung: bật lại âm (nút loa) → màn phát tiếng thử qua PrintSkuScanCue.play
    for (const [route, btn] of [['cap-vai', '#cap-vai-sound'], ['uid-block', '#ub-sound'], ['cut-group-uid', '#cs-sound']]) {
      await page.goto(BASE + '#' + route);
      await page.waitForTimeout(600);
      const calls = await page.evaluate(btn => {
        const seen = [], real = window.PrintSkuScanCue.play;
        window.PrintSkuScanCue.play = (tone, opts) => { seen.push([tone, opts && opts.sound]); return real(tone, opts); };
        const b = document.querySelector(btn); b.click(); b.click(); // tắt rồi bật lại (hoặc bật rồi tắt) → có đúng một lần phát thử khi bật
        window.PrintSkuScanCue.play = real;
        return seen;
      }, btn);
      assert.equal(calls.length, 1, `${route}: nút loa phát thử qua bộ chung (${JSON.stringify(calls)})`);
      assert.deepEqual(calls[0][1], true, `${route}: phát thử khi đang bật âm`);
    }
    assert.deepEqual(errors, [], 'lỗi JavaScript');
    console.log('PASS âm báo chung: 6 loại tiếng + rung, tắt âm vẫn rung, 3 màn có nút loa đi qua PrintSkuScanCue, camera IN TEM SKU dùng tiếng đạt chung');
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
