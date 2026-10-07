(() => {
  if (globalThis.HasakiSkuSyncCore) return;

  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();

  function statusCode(value) {
    return clean(value).toLowerCase() === "active" ? "1" : "0";
  }

  function parseComboDescription(value) {
    const text = clean(value);
    const match = text.match(/\bCombo\s+([^\s=]+)\s*=\s*([^\s,;+]+?)\s*[xX×]\s*([0-9][0-9.,]*)\b/i);
    if (!match) return null;
    const quantity = Number(match[3].replace(/,/g, ""));
    if (!Number.isFinite(quantity) || quantity <= 0) return null;
    return { comboSku: clean(match[1]), normalSku: clean(match[2]), quantity };
  }

  function cutoffKey(value) {
    const date = new Date(value || Date.now() - 7 * 86400000);
    const safe = Number.isFinite(date.getTime()) ? date : new Date(Date.now() - 7 * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Bangkok", year: "2-digit", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
    }).formatToParts(safe).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }

  globalThis.HasakiSkuSyncCore = Object.freeze({ clean, statusCode, parseComboDescription, cutoffKey });
})();
