// Thư viện dùng chung cho test trình duyệt (không phải test; runner bỏ qua tệp này): chờ giao diện "yên" thay cho
// page.waitForTimeout cố định. Yên = hai khung hình đã qua, không còn animation / transition hữu hạn đang chạy và DOM không đổi
// trong `quiet` ms. Không bao giờ chờ quá `max` ms: đặt max = số ms của lệnh ngủ cũ thì trường hợp xấu nhất bằng cũ.
async function settle(page, { quiet = 150, max = 900 } = {}) {
  await page.evaluate(({ quiet, max }) => new Promise(resolve => {
    const start = performance.now();
    let last = start;
    const observer = new MutationObserver(() => { last = performance.now(); });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    const running = () => document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime));
    const check = () => {
      const now = performance.now();
      if (now - start >= max || (now - last >= quiet && !running())) { observer.disconnect(); resolve(); return; }
      setTimeout(check, 25);
    };
    requestAnimationFrame(() => requestAnimationFrame(check));
  }), { quiet, max });
}

module.exports = { settle };
