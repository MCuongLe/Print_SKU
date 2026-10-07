(() => {
  if (globalThis.HasakiSkuSyncCore) return;

  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();

  function statusCode(value) {
    return clean(value).toLowerCase() === "active" ? "1" : "0";
  }

  function parseComboDescriptions(value) {
    const text = clean(value);
    const equation = text.match(/\bCombo\s+([^\s=]+)\s*=\s*(.+)$/i);
    if (!equation) return [];
    const comboSku = clean(equation[1]);
    return equation[2].split("+").map(part => {
      const component = clean(part);
      const match = component.match(/^([^\s,;+]+?)(?:\s*[xX×]\s*([0-9][0-9.,]*))?$/);
      if (!match) return null;
      const quantity = match[2] ? Number(match[2].replace(/,/g, "")) : 1;
      if (!Number.isFinite(quantity) || quantity <= 0) return null;
      return { comboSku, normalSku: clean(match[1]), quantity };
    }).filter(Boolean);
  }

  function parseComboDescription(value) {
    return parseComboDescriptions(value)[0] || null;
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

  globalThis.HasakiSkuSyncCore = Object.freeze({ clean, statusCode, parseComboDescription, parseComboDescriptions, cutoffKey });
})();
