(() => {
  if (window.__HASAKI_INSIDE_PO_BRIDGE__) return;
  window.__HASAKI_INSIDE_PO_BRIDGE__ = true;

  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const numberValue = value => {
    const parsed = Number(String(value || "").replace(/,/g, "").replace(/[^0-9.-]/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const text = (element, fallback = "") => clean(element?.textContent || fallback);
  const normalizeDate = value => {
    const raw = clean(value);
    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const short = raw.match(/^(\d{2})-(\d{2})-(\d{2})/);
    if (short) return `20${short[1]}-${short[2]}-${short[3]}`;
    return raw;
  };
  const skuCore = globalThis.HasakiSkuSyncCore;
  const SKU_CATEGORIES = [
    { id: "954", name: "Thời Trang (Phụ Liệu)" },
    { id: "957", name: "Thời Trang (NVL)" },
    { id: "960", name: "Thời Trang" },
    { id: "961", name: "Thực phẩm" },
    { id: "962", name: "Mẫu Thời Trang" },
    { id: "963", name: "Nhận hàng gia công" },
    { id: "964", name: "Nguyên liệu nhận Gia công" }
  ];

  async function fetchDocument(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Inside trả mã ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const loginForm = doc.querySelector('input[type="password"], form[action*="login"], #login-form');
    if (loginForm || /login|sign in/i.test(doc.title || "")) throw new Error("Phiên Inside đã hết hạn; hãy đăng nhập lại");
    return doc;
  }

  function tableIndexes(doc, required) {
    const headers = [...doc.querySelectorAll("table thead th")].map(cell => clean(cell.textContent).toLowerCase());
    const indexes = {};
    for (const [key, label] of Object.entries(required)) {
      indexes[key] = headers.indexOf(label);
      if (indexes[key] < 0) throw new Error(`Inside đã đổi cấu trúc: không thấy cột ${label}`);
    }
    return indexes;
  }

  function parseProductPage(doc, category) {
    const indexes = tableIndexes(doc, { sku: "sku", name: "product name", status: "status", modified: "modified" });
    return [...doc.querySelectorAll("table tbody tr")].map(row => {
      const cells = [...row.cells];
      const productCell = cells[indexes.name];
      return {
        sku: text(cells[indexes.sku]),
        product_name: text(productCell?.querySelector("a"), text(productCell)),
        category_id: category.id,
        category_name: category.name,
        status: skuCore.statusCode(text(cells[indexes.status])),
        modified: text(cells[indexes.modified])
      };
    }).filter(row => row.sku && row.product_name && row.modified);
  }

  async function fetchProductPage(category, page) {
    const url = new URL("/sales/product", location.origin);
    Object.entries({ kw: "", category_id: category.id, barcode: "0", status: "", type: "0", pushweb: "", config: "", stocking_status: "0", hide_kw: "", limit: "200", page: String(page) })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    const doc = await fetchDocument(url);
    return { rows: parseProductPage(doc, category), sourceRowCount: doc.querySelectorAll("table tbody tr").length };
  }

  async function fetchChangedProducts(category, cutoff) {
    const result = [];
    for (let page = 1; page <= 200; page += 1) {
      const { rows } = await fetchProductPage(category, page);
      if (!rows.length) break;
      result.push(...rows.filter(row => row.modified >= cutoff));
      if (rows.some(row => row.modified < cutoff)) break;
    }
    return result;
  }

  // Đối chiếu toàn bộ: đọc hết trang của một nhóm hàng, 6 trang song song; dừng ở trang không đủ 200 dòng (trang cuối),
  // trang trống, hoặc trang lặp lại nội dung (Inside trả trang cuối cho số trang vượt quá).
  async function fetchAllProducts(category) {
    const result = [];
    const seenFirst = new Set();
    const batchSize = 6;
    for (let first = 1; first <= 400; first += batchSize) {
      const pages = await Promise.all(Array.from({ length: batchSize }, (_, index) => fetchProductPage(category, first + index)));
      let done = false;
      for (const page of pages) {
        const head = page.rows[0]?.sku;
        if (!page.sourceRowCount || (head && seenFirst.has(head))) { done = true; break; }
        if (head) seenFirst.add(head);
        result.push(...page.rows);
        if (page.sourceRowCount < 200) { done = true; break; }
      }
      if (done) break;
    }
    return result;
  }

  function parseComboPage(doc) {
    const indexes = tableIndexes(doc, { sku: "sku", name: "name", description: "description", modified: "modified", status: "status" });
    const sourceRows = [...doc.querySelectorAll("table tbody tr")];
    const issues = [];
    const rows = sourceRows.flatMap(row => {
      const cells = [...row.cells];
      const description = text(cells[indexes.description]);
      const detail = skuCore.parseComboDetail(description);
      const info = {
        combo_sku: text(cells[indexes.sku]),
        combo_name: text(cells[indexes.name]),
        description: description.slice(0, 300),
        source_modified_at: text(cells[indexes.modified])
      };
      if (!detail.matched) {
        if (info.combo_sku || description) issues.push({ type: "unparsed_combo_description", ...info, reason: "Mô tả không đúng dạng Combo A=B+C" });
      } else if (detail.rejected.length) {
        issues.push({ type: "partial_combo_description", ...info, reason: `Bỏ qua thành phần: ${detail.rejected.join(", ").slice(0, 150)}` });
      }
      return detail.relations.map(relation => ({
        combo_sku: relation.comboSku,
        normal_sku: relation.normalSku,
        quantity: relation.quantity,
        combo_name: info.combo_name,
        combo_status: text(cells[indexes.status]),
        source_modified_at: info.source_modified_at
      }));
    });
    const modified = sourceRows.map(row => text([...row.cells][indexes.modified]));
    return { rows, issues, sourceRowCount: sourceRows.length, modified };
  }

  async function fetchComboPage(page) {
    const url = new URL("/sales/product/combo", location.origin);
    Object.entries({ offset: "0", limit: "50", type: "2", page: String(page) })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    return parseComboPage(await fetchDocument(url));
  }

  const comboIssueKey = issue => [issue.type, issue.combo_sku, issue.normal_sku, issue.description, issue.reason].join("\u0000");

  async function fetchAllComboLinks() {
    const result = [];
    const issueByKey = new Map();
    const addIssue = issue => issueByKey.set(comboIssueKey(issue), issue);
    const batchSize = 8;
    for (let first = 1; first <= 300; first += batchSize) {
      const pages = await Promise.all(Array.from({ length: batchSize }, (_, index) => fetchComboPage(first + index)));
      for (const page of pages) {
        result.push(...page.rows);
        page.issues.forEach(addIssue);
      }
      if (pages.some(page => page.sourceRowCount < 50)) break;
    }
    return { ...finalizeCombos(result, issueByKey, addIssue), scope: "full" };
  }

  // Gia tăng (0.9.3): Inside liệt kê Combo theo Modified giảm dần → đọc tới trang có dòng cũ hơn mốc rồi dừng
  // (thường 1–2 lô thay vì ~117 trang). Thứ tự hoặc định dạng Modified khác kỳ vọng thì quay về đọc toàn bộ.
  async function fetchChangedComboLinks(cutoff) {
    const result = [];
    const issueByKey = new Map();
    const addIssue = issue => issueByKey.set(comboIssueKey(issue), issue);
    const batchSize = 8;
    let last = "";
    for (let first = 1; first <= 300; first += batchSize) {
      const pages = await Promise.all(Array.from({ length: batchSize }, (_, index) => fetchComboPage(first + index)));
      let done = false;
      for (const page of pages) {
        const stamps = page.modified.filter(Boolean);
        if (!skuCore.comboStampsOrdered(stamps, last)) return fetchAllComboLinks();
        if (stamps.length) last = stamps[stamps.length - 1];
        result.push(...page.rows);
        page.issues.forEach(addIssue);
        if (page.sourceRowCount < 50 || stamps.some(stamp => stamp < cutoff)) { done = true; break; }
      }
      if (done) break;
    }
    return { ...finalizeCombos(result.filter(row => row.source_modified_at >= cutoff), issueByKey, addIssue), scope: "changed" };
  }

  function finalizeCombos(result, issueByKey, addIssue) {
    const unique = new Map();
    result.forEach(row => {
      if (!row.combo_sku || !row.normal_sku || row.combo_sku === row.normal_sku || !Number.isFinite(row.quantity) || row.quantity <= 0) {
        addIssue({
          type: "invalid_combo_relation",
          combo_sku: row.combo_sku,
          normal_sku: row.normal_sku,
          quantity: row.quantity,
          combo_name: row.combo_name,
          source_modified_at: row.source_modified_at,
          reason: row.combo_sku === row.normal_sku ? "SKU Combo tự tham chiếu" : "Quan hệ thiếu mã hoặc số lượng không hợp lệ"
        });
        return;
      }
      unique.set(`${row.combo_sku}\u0000${row.normal_sku}`, row);
    });
    return { rows: [...unique.values()], sourceIssues: [...issueByKey.values()] };
  }

  async function getSkuSyncData(payload) {
    if (!skuCore) throw new Error("Extension chưa tải bộ đọc SKU; hãy Reload extension rồi thử lại");
    const full = payload?.full === true;
    const cutoff = full ? "" : skuCore.cutoffKey(payload?.cutoff);
    const comboCutoff = full ? "" : skuCore.comboCutoffKey(payload?.cutoff);
    // Toàn bộ: từng nhóm hàng tuần tự (mỗi nhóm 6 trang song song) để không dồn hơn 40 yêu cầu lên Inside cùng lúc.
    const groups = [];
    if (full) for (const category of SKU_CATEGORIES) groups.push(await fetchAllProducts(category));
    else groups.push(...await Promise.all(SKU_CATEGORIES.map(category => fetchChangedProducts(category, cutoff))));
    const normalBySku = new Map();
    groups.flat().forEach(row => normalBySku.set(row.sku, row));
    const comboData = full ? await fetchAllComboLinks() : await fetchChangedComboLinks(comboCutoff);
    const comboRows = comboData.rows;
    return {
      generatedAt: new Date().toISOString(),
      mode: full ? "full" : "incremental",
      full,
      cutoff,
      comboScope: comboData.scope,
      comboCutoff,
      categories: SKU_CATEGORIES,
      normalRows: [...normalBySku.values()],
      comboRows,
      sourceIssues: comboData.sourceIssues,
      sourceCounts: { normalRows: normalBySku.size, comboRows: comboRows.length, skippedInvalidComboRows: comboData.sourceIssues.filter(issue => issue.type === "invalid_combo_relation").length, sourceIssues: comboData.sourceIssues.length }
    };
  }

  function findPoRow(doc, poCode) {
    return [...doc.querySelectorAll("table tbody tr")].find(row => {
      const codeLink = [...row.querySelectorAll('a[href*="/purchase/order/"][href*="/edit"]')]
        .find(link => clean(link.textContent) === poCode);
      return Boolean(codeLink);
    });
  }

  function extractItems(doc) {
    const rows = [...doc.querySelectorAll("#po_detail_table_tbody tr")];
    return rows.map(row => {
      const cells = [...row.cells];
      const sku = clean(cells[1]?.querySelector('a[href*="detail-sku?sku="]')?.href.match(/[?&]sku=([^&]+)/)?.[1] || cells[1]?.querySelector("span")?.textContent || cells[1]?.textContent);
      const barcode = text(cells[2]);
      const name = text(cells[3]);
      const qtyNode = cells[8]?.querySelector("[data]");
      const orderedQty = numberValue(qtyNode?.getAttribute("data") || cells[8]?.textContent);
      return { sku, barcode, name, orderedQty };
    }).filter(item => item.sku && item.name && item.orderedQty > 0);
  }

  async function getPo(poCode) {
    const searchUrl = new URL("/purchase/order", location.origin);
    searchUrl.searchParams.set("kw", poCode);
    searchUrl.searchParams.set("pagination", "50");
    const listDoc = await fetchDocument(searchUrl);
    const row = findPoRow(listDoc, poCode);
    if (!row) throw new Error(`Không tìm thấy PO ${poCode}`);

    const cells = [...row.cells];
    const editLink = [...row.querySelectorAll('a[href*="/purchase/order/"][href*="/edit"]')]
      .find(link => clean(link.textContent) === poCode);
    if (!editLink) throw new Error("Không xác định được trang chi tiết PO");

    const detailDoc = await fetchDocument(editLink.href);
    const warehouse = text(detailDoc.querySelector("#selected_stock_id option:checked"), text(cells[3]));
    const items = extractItems(detailDoc);
    if (!items.length) throw new Error(`PO ${poCode} không có dòng SKU hợp lệ`);

    return {
      poId: editLink.href.match(/\/purchase\/order\/(\d+)\/edit/)?.[1] || "",
      poCode,
      vendor: text(cells[2]),
      warehouse,
      deliveryDate: normalizeDate(detailDoc.querySelector('input[name="delivery_date"]')?.value || text(cells[5])),
      status: text(cells[7]),
      items
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !["GET_PO", "GET_SKU_SYNC_DATA"].includes(message?.type)) return false;
    if (message.type === "GET_SKU_SYNC_DATA") {
      getSkuSyncData(message.payload || {})
        .then(data => sendResponse({ ok: true, data }))
        .catch(error => sendResponse({ ok: false, error: { code: "SKU_SYNC_READ_FAILED", message: clean(error?.message || error) } }));
      return true;
    }
    const poCode = clean(message.payload?.poCode);
    if (!/^[A-Za-z0-9._/-]{3,50}$/.test(poCode)) {
      sendResponse({ ok: false, error: { code: "INVALID_PO", message: "Mã PO không hợp lệ" } });
      return false;
    }
    getPo(poCode)
      .then(data => sendResponse({ ok: true, data }))
      .catch(error => sendResponse({ ok: false, error: { code: "PO_LOOKUP_FAILED", message: clean(error?.message || error) } }));
    return true;
  });
})();
