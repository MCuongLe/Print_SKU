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

  async function fetchDocument(url) {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`Inside trả mã ${response.status}`);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const loginForm = doc.querySelector('input[type="password"], form[action*="login"], #login-form');
    if (loginForm || /login|sign in/i.test(doc.title || "")) throw new Error("Phiên Inside đã hết hạn; hãy đăng nhập lại");
    return doc;
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
    if (sender.id !== chrome.runtime.id || message?.type !== "GET_PO") return false;
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
