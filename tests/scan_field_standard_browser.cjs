// Khung quét chuẩn (18/10/2026, khối CSS #scan-field-std + script #scan-field-std-script): mọi ô quét Group UID / SKU / vị trí là một khối liền
// như Cắt UID — icon quét đầu ô + vạch ngăn, khay (camera · bàn phím) nằm TRONG ô bên phải; camera chỉ hiện khi máy mở được camera, không thì
// khay chỉ còn bàn phím; bàn phím ảo ẩn mặc định (inputmode="none"), nút bàn phím có aria-controls = id ô, bật/tắt và nhớ theo máy (localStorage),
// "Gõ tay" trong lớp quét bấm đúng nút này và đưa con trỏ về ô. Mốc chuẩn: #cut-code, #xa-vai-code, #cap-vai-code; ô kiểm: #uid-code, #uid-bulk-sku,
// #uc-code, #uh-sku, #uh-loc. Camera + bộ đọc mã giả lập, Supabase giả lập (không ghi dữ liệu thật). Chạy với python -m http.server 8000 (đổi bằng BASE).
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const BASE = process.env.BASE || 'http://127.0.0.1:8000/';
const FIELDS = [
  { id: 'cut-code', route: 'cut-group-uid', camera: 'cut-camera', key: 'cut-ban-phim', ref: true },
  { id: 'xa-vai-code', route: 'xa-vai', camera: 'xa-vai-camera', key: 'xa-vai-ban-phim', ref: true },
  { id: 'cap-vai-code', route: 'cap-vai', camera: 'cap-vai-camera', key: 'cap-vai-ban-phim', ref: true },
  { id: 'uid-code', route: 'group-uid', camera: 'uid-camera', key: 'uid-ban-phim', code: '1028260000000001' },
  { id: 'uid-bulk-sku', route: 'group-uid', camera: 'uid-sku-scan', key: 'uid-sku-ban-phim', code: '900000001' },
  { id: 'uc-code', route: 'unit-converter', camera: 'uc-camera', key: 'uc-ban-phim', code: '900000001' },
  { id: 'uh-sku', route: 'group-uid-history', camera: 'uh-sku-scan', key: 'uh-sku-ban-phim', code: '900000001' },
  { id: 'uh-loc', route: 'group-uid-history', camera: 'uh-loc-scan', key: 'uh-loc-ban-phim', code: 'F0-VR-00-00-00-00', want: 'F0-VR-00-00-00-00' }
];

// Camera giả: canvas.captureStream; window.__camError = tên lỗi để ev() ném lỗi; window.__code = mã bộ đọc trả về.
const fakeScanner = () => {
  const install = () => {
    const S = window.PrintSkuScanner; if (!S) return false;
    window.PrintSkuScanner = { ...S, gl: () => true, k0: () => true, Jp: async () => ({ doc: async () => (window.__code ? { ma: window.__code } : null) }),
      ev: async () => {
        if (window.__camError) throw Object.assign(new Error('giả lập'), { name: window.__camError });
        const c = document.createElement('canvas'); c.width = 640; c.height = 480; const g = c.getContext('2d');
        setInterval(() => { g.fillStyle = '#456'; g.fillRect(0, 0, 640, 480); }, 100);
        return c.captureStream(10);
      } };
    return true;
  };
  const t = setInterval(() => { if (install()) clearInterval(t); }, 20);
};
// Máy không mở được camera (không có mediaDevices): PrintSkuScanUI.canOpen() = false → mọi nút camera ẩn.
const noCamera = () => { Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => undefined }); };

const measure = ({ id, camera }) => {
  const input = document.getElementById(id);
  if (!input) return { missing: true };
  const rect = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const field = input.closest('.scan-field'), tools = field && field.querySelector(':scope > .scan-field__tools');
  const cs = getComputedStyle(input);
  const btn = e => {
    if (!e) return null;
    const s = getComputedStyle(e), p = getComputedStyle(e, '::before'), b = e.getBoundingClientRect();
    return { shown: b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && s.display !== 'none', ...rect(e), mask: p.webkitMaskImage || p.maskImage, bg: s.backgroundColor, radius: s.borderTopLeftRadius,
      pressed: e.getAttribute('aria-pressed'), label: e.getAttribute('aria-label'), title: e.title, controls: e.getAttribute('aria-controls'), name: (e.textContent || '').trim() };
  };
  const cam = document.getElementById(camera);
  const kb = tools && tools.querySelector(`:scope > button[aria-controls="${id}"]`);
  const ts = tools && getComputedStyle(tools);
  return {
    inField: !!field && input.parentElement === field,
    toolsInField: !!tools && tools.parentElement === field,
    cameraInTools: !!tools && !!cam && cam.parentElement === tools,
    input: { ...rect(input), radius: cs.borderTopLeftRadius, padL: cs.paddingLeft, padR: cs.paddingRight, bgImage: cs.backgroundImage, bgPos: cs.backgroundPosition, bgSize: cs.backgroundSize,
      border: cs.borderTopWidth, font: `${cs.fontSize}/${cs.fontWeight}`, mode: input.inputMode, placeholder: input.placeholder },
    tools: tools && { ...rect(tools), bg: ts.backgroundColor, radius: ts.borderTopLeftRadius },
    camera: btn(cam), kb: btn(kb),
    shownInTools: tools ? [...tools.children].filter(e => e.getBoundingClientRect().width > 0).length : 0,
    leftover: field ? field.querySelectorAll('.as-ico, svg').length : 0
  };
};

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const problems = [], ran = [], flows = { typed: 0, scanned: 0 };
  const near = (a, b, d = 1) => Math.abs(a - b) <= d;
  try {
    for (const [width, height] of [[390, 844], [1280, 800]]) {
      for (const cameraOn of [true, false]) {
        const mobile = width < 800, tag = `${width}px camera ${cameraOn ? 'có' : 'không'}`;
        const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
        await context.addInitScript(cameraOn ? fakeScanner : noCamera);
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(6000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
          const url = route.request().url(), json = body => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
          if (url.startsWith(BASE)) return route.continue();
          if (url.endsWith('/rpc/group_uid_lookup')) return json(route.request().postDataJSON().p_codes.map(code => ({ group_uid_code: code, sku: '900000001', product_name: 'Vải mẫu thử', lot: 'L1', roll: '01' })));
          if (url.endsWith('/rpc/sku_combo_by_normal')) return json([]);
          if (url.includes('/SKU_Name?')) return json([{ sku: '900000001', product_name: 'Vải mẫu thử' }]);
          if (url.includes('/rest/v1/') && !url.includes('/rpc/')) return json([]);
          return json({ ok: true, data: { agents: [], jobs: [], items: [], rows: [] } });
        });
        let ref = null;
        for (const f of FIELDS) {
          const bad = msg => problems.push(`${tag} · #${f.id}: ${msg}`);
          const kbSel = `.scan-field__tools > button[aria-controls="${f.id}"]`;
          await page.goto(BASE + '#' + f.route);
          await page.locator('#' + f.id).waitFor({ state: 'visible' });
          await page.waitForTimeout(400);
          await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); });
          const m = await page.evaluate(measure, f);
          if (m.missing) { bad('không có ô'); continue; }
          if (f.ref) ref = ref || m;

          // 1. Khối liền: ô nằm trong .scan-field, khay trong ô, không còn icon/ô trang trí lẻ
          if (!m.inField) bad('ô không nằm trong .scan-field');
          if (!m.toolsInField) bad('thiếu khay .scan-field__tools trong khung');
          if (m.tools) {
            const t = m.tools, i = m.input;
            if (t.t < i.t || t.b > i.b || t.r > i.r || t.l < i.l) bad('khay không nằm gọn trong mép ô');
          }
          if (m.leftover) bad(`còn ${m.leftover} icon/svg lẻ trong khung (icon quét chỉ vẽ nền ô)`);
          if (!m.kb) bad(`thiếu nút bàn phím có aria-controls="${f.id}" trong khay`);

          // 2. Cùng chiều cao / bo / icon quét + vạch ngăn / khay với ô mốc (Cắt UID), ± 1 px
          if (ref && ref !== m) {
            const i = m.input, r = ref.input;
            if (!near(i.h, r.h)) bad(`cao ô ${Math.round(i.h)} ≠ mốc ${Math.round(r.h)}`);
            if (i.radius !== r.radius) bad(`bo ô ${i.radius} ≠ mốc ${r.radius}`);
            if (i.border !== r.border) bad(`viền ô ${i.border} ≠ mốc ${r.border}`);
            if (i.font !== r.font) bad(`chữ ô ${i.font} ≠ mốc ${r.font}`);
            if (i.bgImage !== r.bgImage) bad('icon quét + vạch ngăn đầu ô khác mốc');
            if (i.bgPos !== r.bgPos || i.bgSize !== r.bgSize) bad(`vị trí/cỡ icon quét ${i.bgPos} | ${i.bgSize} ≠ mốc ${r.bgPos} | ${r.bgSize}`);
            if (i.padL !== r.padL || i.padR !== r.padR) bad(`đệm chữ ${i.padL}/${i.padR} ≠ mốc ${r.padL}/${r.padR}`);
            if (m.tools && ref.tools) {
              const t = m.tools, rt = ref.tools;
              if (t.bg !== rt.bg || t.radius !== rt.radius) bad(`khay ${t.bg} bo ${t.radius} ≠ mốc ${rt.bg} bo ${rt.radius}`);
              if (!near(t.t - i.t, rt.t - r.t) || !near(i.r - t.r, r.r - rt.r) || !near(i.b - t.b, r.b - rt.b)) bad('khoảng cách khay tới mép ô khác mốc');
              if (!near(t.w, rt.w)) bad(`khay rộng ${Math.round(t.w)} ≠ mốc ${Math.round(rt.w)}`);
            }
          }

          // 3. Camera: chỉ khi máy mở được camera; mask --i-camera, cao 44, nằm trong khay; không camera thì khay chỉ còn nút bàn phím
          if (cameraOn) {
            if (!m.camera || !m.camera.shown) bad('máy mở được camera nhưng không thấy nút camera');
            else {
              if (!m.cameraInTools) bad('nút camera không nằm trong khay');
              if (!near(m.camera.h, 44)) bad(`nút camera cao ${Math.round(m.camera.h)} ≠ 44`);
              if (ref && ref !== m && ref.camera && m.camera.mask !== ref.camera.mask) bad('icon camera không dùng mask --i-camera như mốc');
              if (!m.camera.label || m.camera.title !== m.camera.label) bad('nút camera thiếu aria-label/title');
              if (m.tools && (m.camera.t < m.tools.t || m.camera.b > m.tools.b || m.camera.r > m.tools.r)) bad('nút camera tràn ra ngoài khay');
            }
          } else {
            if (m.camera && m.camera.shown) bad('máy không có camera mà vẫn hiện nút camera');
            if (m.shownInTools !== 1) bad(`không camera: khay phải chỉ còn nút bàn phím (đang ${m.shownInTools} nút)`);
          }

          // 4. Bàn phím: mặc định ẩn, aria-controls = id ô, đúng nhãn / mask / cao 44 / rộng 48
          if (m.kb) {
            const k = m.kb;
            if (m.input.mode !== 'none') bad(`mặc định inputmode="${m.input.mode}" ≠ none`);
            if (k.pressed !== 'true') bad(`mặc định aria-pressed="${k.pressed}" ≠ true (đang ẩn)`);
            if (k.label !== 'Hiện bàn phím' || k.title !== 'Hiện bàn phím') bad(`nhãn mặc định "${k.label}" / "${k.title}"`);
            if (!near(k.h, 44) || !near(k.w, 48)) bad(`nút bàn phím ${Math.round(k.w)}×${Math.round(k.h)} ≠ 48×44`);
            if (ref && ref !== m && ref.kb && k.mask !== ref.kb.mask) bad('icon bàn phím khác mốc (--i-keyboard)');
            if (k.name) bad(`nút bàn phím có chữ "${k.name}" (chỉ icon)`);
          }
          if (!m.kb) continue;

          // 5. Bật / tắt bàn phím: đổi inputmode + nhãn, con trỏ về ô, nhớ theo máy (localStorage) kể cả tải lại trang
          const read = () => page.evaluate(([id, sel, key]) => { const i = document.getElementById(id), b = document.querySelector(sel); return { mode: i.inputMode, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), title: b.title, stored: localStorage.getItem(key), focus: document.activeElement === i }; }, [f.id, kbSel, f.key]);
          const focused = () => page.waitForFunction(id => document.activeElement?.id === id, f.id).then(() => true, () => false);
          await page.locator(kbSel).click();
          if (!await focused()) bad('bấm nút bàn phím không đưa con trỏ về ô');
          let s = await read();
          if (s.mode !== 'text' || s.pressed !== 'false' || s.label !== 'Ẩn bàn phím' || s.title !== 'Ẩn bàn phím') bad(`sau khi bật: ${JSON.stringify(s)}`);
          if (s.stored !== 'hien') bad(`khoá ${f.key} = ${s.stored} ≠ hien`);
          await page.reload(); await page.locator('#' + f.id).waitFor({ state: 'visible' });
          s = await read();
          if (s.mode !== 'text' || s.pressed !== 'false') bad(`tải lại không nhớ bàn phím đang hiện: ${JSON.stringify(s)}`);
          await page.locator(kbSel).click();
          if (!await focused()) bad('tắt bàn phím không đưa con trỏ về ô');
          s = await read();
          if (s.mode !== 'none' || s.pressed !== 'true' || s.label !== 'Hiện bàn phím' || s.stored !== 'an') bad(`sau khi tắt: ${JSON.stringify(s)}`);
          await page.reload(); await page.locator('#' + f.id).waitFor({ state: 'visible' });
          s = await read();
          if (s.mode !== 'none' || s.pressed !== 'true') bad(`tải lại không nhớ bàn phím đang ẩn: ${JSON.stringify(s)}`);

          // 6. Luồng camera giả lập (chỉ khi máy có camera): bị chặn quyền → "Gõ tay" bấm nút bàn phím của đúng ô; quét được → điền ô
          if (cameraOn && m.camera && m.camera.shown) {
            const pss = page.locator('.pss');
            const openCamera = async setup => { await page.evaluate(s => { Object.assign(window, { __code: '', __camError: '' }, s); }, setup); await page.locator('#' + f.camera).click(); };
            await openCamera({ __camError: 'NotAllowedError' });
            await page.waitForFunction(() => document.querySelector('.pss')?.dataset.state === 'error').catch(() => bad('camera bị chặn không ra thẻ lỗi'));
            await pss.locator('.pss-card [data-act="type"]').click().catch(() => bad('thẻ lỗi không có nút Gõ tay'));
            await pss.waitFor({ state: 'detached' }).catch(() => bad('Gõ tay không đóng lớp quét'));
            if (!await focused()) bad('Gõ tay không đưa con trỏ về đúng ô');
            flows.typed++;
            s = await read();
            if (s.mode !== 'text' || s.pressed !== 'false') bad(`Gõ tay không bật bàn phím của ô: ${JSON.stringify(s)}`);
            await page.locator(kbSel).click(); await focused(); // trả về trạng thái ẩn cho lần tải sau
            if (f.code) {
              await openCamera({ __code: f.code });
              await pss.waitFor({ state: 'detached', timeout: 8000 }).catch(() => bad('quét được mã nhưng lớp quét không đóng'));
              const ok = await page.waitForFunction(([id, code, want]) => {
                const v = document.getElementById(id).value;
                return v === (want || code) || (id === 'uid-code' && document.getElementById('uid-screen').innerText.includes(code));
              }, [f.id, f.code, f.want], { timeout: 4000 }).then(() => true, () => false);
              if (!ok) bad(`quét thành công mã ${f.code} nhưng ô không nhận`); else flows.scanned++;
            }
          }
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) bad('trang tràn ngang');
          ran.push(`${tag} #${f.id}`);
        }
        // IN TEM SKU #f-sku (Việc 2, bundle React — chỉ đổi bằng CSS, DOM giữ nguyên): .sku-row > .relative > (#f-sku + nút camera React) + #f-sku-kb.
        // Khay vẽ bằng .sku-row::after; nút camera và #f-sku-kb đặt tuyệt đối vào khay. Cùng khẳng định với các ô trên, so với ô mốc Cắt UID.
        {
          const bad = msg => problems.push(`${tag} · #f-sku: ${msg}`);
          await page.goto(BASE + '#worker');
          await page.locator('#f-sku').waitFor({ state: 'visible' });
          await page.waitForTimeout(400);
          await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(d => d.close()); });
          const s = await page.evaluate(() => {
            const input = document.getElementById('f-sku'), row = input.closest('.sku-row'), cs = getComputedStyle(input);
            const rect = e => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
            const r = rect(row), a = getComputedStyle(row, '::after'), px = v => parseFloat(v) || 0;
            const tray = a.content && a.content !== 'none' ? { l: r.r - px(a.right) - px(a.width), t: r.t + px(a.top), r: r.r - px(a.right), b: r.b - px(a.bottom), w: px(a.width), bg: a.backgroundColor, radius: a.borderTopLeftRadius } : null;
            const btn = e => { if (!e) return null; const st = getComputedStyle(e), p = getComputedStyle(e, '::before'), b = rect(e), svg = e.querySelector('svg');
              return { shown: b.w > 0 && b.h > 0 && st.display !== 'none', ...b, mask: p.webkitMaskImage || p.maskImage, svg: !!svg && svg.getBoundingClientRect().width > 0, pressed: e.getAttribute('aria-pressed'), label: e.getAttribute('aria-label'), title: e.title, name: (e.textContent || '').trim() }; };
            return { input: { ...rect(input), radius: cs.borderTopLeftRadius, padL: cs.paddingLeft, padR: cs.paddingRight, bgImage: cs.backgroundImage, bgPos: cs.backgroundPosition, bgSize: cs.backgroundSize, border: cs.borderTopWidth, font: `${cs.fontSize}/${cs.fontWeight}`, mode: input.inputMode },
              tray, camera: btn(row.querySelector('button[aria-label="Quét mã bằng camera"]')), kb: btn(document.getElementById('f-sku-kb')) };
          });
          const i = s.input, r = ref && ref.input;
          if (r) {
            if (!near(i.h, r.h)) bad(`cao ô ${Math.round(i.h)} ≠ mốc ${Math.round(r.h)}`);
            if (i.radius !== r.radius) bad(`bo ô ${i.radius} ≠ mốc ${r.radius}`);
            if (i.border !== r.border) bad(`viền ô ${i.border} ≠ mốc ${r.border}`);
            if (i.font !== r.font) bad(`chữ ô ${i.font} ≠ mốc ${r.font}`);
            if (i.bgImage !== r.bgImage) bad('icon quét + vạch ngăn đầu ô khác mốc');
            if (i.bgPos !== r.bgPos || i.bgSize !== r.bgSize) bad(`vị trí/cỡ icon quét ${i.bgPos} | ${i.bgSize} ≠ mốc`);
            if (i.padL !== r.padL || i.padR !== r.padR) bad(`đệm chữ ${i.padL}/${i.padR} ≠ mốc ${r.padL}/${r.padR}`);
          }
          if (!s.tray) bad('thiếu khay (.sku-row::after)');
          else if (ref && ref.tools) {
            const t = s.tray, rt = ref.tools, ri = ref.input;
            if (t.bg !== rt.bg || t.radius !== rt.radius) bad(`khay ${t.bg} bo ${t.radius} ≠ mốc ${rt.bg} bo ${rt.radius}`);
            if (!near(t.t - i.t, rt.t - ri.t) || !near(i.r - t.r, ri.r - rt.r) || !near(i.b - t.b, ri.b - rt.b)) bad('khoảng cách khay tới mép ô khác mốc');
            if (!near(t.w, rt.w)) bad(`khay rộng ${Math.round(t.w)} ≠ mốc ${Math.round(rt.w)}`);
          }
          const inTray = (b, what) => { if (s.tray && (b.l < s.tray.l - 1 || b.r > s.tray.r + 1 || b.t < s.tray.t - 1 || b.b > s.tray.b + 1)) bad(`${what} không nằm gọn trong khay`); };
          if (cameraOn) {
            const c = s.camera;
            if (!c || !c.shown) bad('máy mở được camera nhưng không thấy nút camera');
            else {
              if (!near(c.h, 44) || !near(c.w, 48)) bad(`nút camera ${Math.round(c.w)}×${Math.round(c.h)} ≠ 48×44`);
              if (c.svg) bad('nút camera còn hiện svg khung quét (phải là icon camera mask --i-camera)');
              if (ref && ref.camera && c.mask !== ref.camera.mask) bad('icon camera không dùng mask --i-camera như mốc');
              inTray(c, 'nút camera');
            }
          } else if (s.camera && s.camera.shown) bad('máy không có camera mà vẫn hiện nút camera');
          const k = s.kb;
          if (!k || !k.shown) bad('không thấy nút bàn phím');
          else {
            if (!near(k.h, 44) || !near(k.w, 48)) bad(`nút bàn phím ${Math.round(k.w)}×${Math.round(k.h)} ≠ 48×44`);
            if (ref && ref.kb && k.mask !== ref.kb.mask) bad('icon bàn phím khác mốc');
            if (k.name) bad(`nút bàn phím có chữ "${k.name}"`);
            inTray(k, 'nút bàn phím');
            if (i.mode !== 'none' || k.pressed !== 'true' || k.label !== 'Hiện bàn phím') bad(`mặc định phải ẩn bàn phím: ${i.mode} ${k.pressed} ${k.label}`);
            const read = () => page.evaluate(() => { const i = document.getElementById('f-sku'), b = document.getElementById('f-sku-kb'); return { mode: i.inputMode, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), stored: localStorage.getItem('print-sku-ban-phim'), bg: getComputedStyle(b).backgroundColor }; });
            const focused = () => page.waitForFunction(() => document.activeElement?.id === 'f-sku').then(() => true, () => false);
            await page.locator('#f-sku-kb').click();
            if (!await focused()) bad('bấm nút bàn phím không đưa con trỏ về ô');
            let st = await read();
            if (st.mode !== 'text' || st.pressed !== 'false' || st.label !== 'Ẩn bàn phím' || st.stored !== 'hien') bad(`sau khi bật: ${JSON.stringify(st)}`);
            if (st.bg !== 'rgb(255, 255, 255)') bad(`bàn phím đang hiện phải nền trắng như mốc (${st.bg})`);
            await page.reload(); await page.locator('#f-sku').waitFor({ state: 'visible' });
            st = await read();
            if (st.mode !== 'text' || st.pressed !== 'false') bad(`tải lại không nhớ bàn phím đang hiện: ${JSON.stringify(st)}`);
            await page.locator('#f-sku-kb').click(); await focused();
            st = await read();
            if (st.mode !== 'none' || st.pressed !== 'true' || st.stored !== 'an') bad(`sau khi tắt: ${JSON.stringify(st)}`);
            // Gõ tay từ lớp quét camera (Codex 18/10/2026): #f-sku-kb có aria-controls nhiều id ("f-sku f-pn f-sl f-ban") → phải bật được bàn phím
            if (cameraOn && s.camera && s.camera.shown) {
              await page.evaluate(() => { Object.assign(window, { __code: '', __camError: 'NotAllowedError' }); });
              await page.locator('#root .sku-row button[aria-label="Quét mã bằng camera"]').click();
              await page.waitForFunction(() => document.querySelector('.pss')?.dataset.state === 'error').catch(() => bad('camera bị chặn không ra thẻ lỗi'));
              await page.locator('.pss .pss-card [data-act="type"]').click().catch(() => bad('thẻ lỗi không có nút Gõ tay'));
              if (!await focused()) bad('Gõ tay không đưa con trỏ về #f-sku');
              st = await read();
              if (st.mode !== 'text' || st.pressed !== 'false') bad(`Gõ tay không bật bàn phím của ô SKU: ${JSON.stringify(st)}`);
              await page.locator('#f-sku-kb').click(); await focused();
            }
          }
          if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) bad('trang tràn ngang');
          ran.push(`${tag} #f-sku`);
        }
        if (errors.length) problems.push(`${tag}: lỗi JavaScript: ${errors.slice(0, 3).join(' | ')}`);
        await context.close();
      }
    }
  } finally { await browser.close(); }
  if (problems.length) { console.error(problems.slice(0, 80).join('\n')); console.error(`… ${problems.length} chỗ lệch khung quét chuẩn`); process.exitCode = 1; return; }
  console.log(`PASS khung quét chuẩn: ${FIELDS.length} ô + IN TEM SKU #f-sku × (390 + 1280 px) × (có / không camera) = ${ran.length} lượt kiểm, ${flows.typed} lượt Gõ tay, ${flows.scanned} lượt quét camera giả — khối liền, khay trong ô, camera mask --i-camera cao 44, bàn phím ẩn mặc định + nhớ theo máy + Gõ tay, cùng cỡ với ô mốc Cắt UID`);
})().catch(error => { console.error(error); process.exitCode = 1; });
