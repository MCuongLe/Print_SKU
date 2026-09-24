const ASCII_BARCODE = /^[\x20-\x7E]+$/;
const SKU_PATTERN = /^[0-9A-Za-z._-]{1,40}$/;

function cleanText(value, maxLength) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function validCopies(value) {
  const copies = Number(value ?? 1);
  return Number.isInteger(copies) && copies >= 1 && copies <= 500 ? copies : null;
}

export function normalizeJob(input) {
  const source = input && typeof input === "object" ? input : {};
  const payload = source.payload && typeof source.payload === "object" ? source.payload : {};
  const type = cleanText(source.type, 30).toLowerCase();
  const templateVersion = Number(source.templateVersion) || 1;
  const copies = validCopies(source.copies);
  const errors = [];
  if (!source.id) errors.push("Thiếu id của lệnh in");
  if (!source.nonce) errors.push("Thiếu nonce chống gửi trùng");
  if (!copies) errors.push("Số tem phải từ 1 đến 500");
  if (!['sku', 'group_uid', 'fabric_relaxation'].includes(type)) errors.push("Loại tem không được hỗ trợ");

  let normalizedPayload = {};
  if (type === "fabric_relaxation") {
    if (templateVersion === 1) {
      const itemCode = String(payload.itemCode ?? "").trim();
      if (!SKU_PATTERN.test(itemCode)) errors.push("Mã hàng phải có 1–40 ký tự: chữ, số, dấu chấm, gạch ngang hoặc gạch dưới");
      normalizedPayload = { itemCode };
    } else if (templateVersion === 2) {
      const itemCodes = Array.isArray(payload.itemCodes) ? payload.itemCodes.map(value => String(value ?? "").trim()) : [];
      if (itemCodes.length < 1 || itemCodes.length > 5) errors.push("Mỗi tem phải có từ 1 đến 5 mã hàng");
      itemCodes.forEach((itemCode, index) => {
        if (!SKU_PATTERN.test(itemCode)) errors.push(`Mã hàng dòng ${index + 1} không hợp lệ`);
      });
      normalizedPayload = { itemCodes };
    } else if (templateVersion === 3) {
      if (payload.handwritten !== true) errors.push("Tem viết tay không hợp lệ");
      normalizedPayload = { handwritten: true };
    } else errors.push("Phiên bản tem Fabric Relaxation không được hỗ trợ");
  }
  if (type === "sku") {
    const normalizeSku = (item) => ({
      sku: cleanText(item.sku, 40),
      productName: cleanText(item.productName, 180),
      quantity: cleanText(item.quantity, 40),
      printedDate: cleanText(item.printedDate, 20),
      copies: validCopies(item.copies ?? 1) || 0
    });
    if (Array.isArray(payload.items)) {
      const items = payload.items.slice(0, 100).map(normalizeSku);
      if (!items.length) errors.push("Danh sách SKU đang trống");
      items.forEach((item, index) => {
        if (!SKU_PATTERN.test(item.sku)) errors.push(`SKU dòng ${index + 1} không hợp lệ`);
        if (!item.productName) errors.push(`Thiếu tên sản phẩm dòng ${index + 1}`);
        if (!item.copies) errors.push(`Số bản dòng ${index + 1} không hợp lệ`);
      });
      const totalCopies = items.reduce((sum, item) => sum + item.copies, 0);
      if (totalCopies !== copies) errors.push("Tổng số bản SKU không khớp lệnh in");
      normalizedPayload = { items };
    } else {
      normalizedPayload = normalizeSku(payload);
      delete normalizedPayload.copies;
      if (!SKU_PATTERN.test(normalizedPayload.sku)) errors.push("SKU không hợp lệ");
      if (!normalizedPayload.productName) errors.push("Thiếu tên sản phẩm");
    }
  }

  if (type === "group_uid") {
    // Lot và Roll không bắt buộc: trước đây người vận hành ghi bút lên tem.
    // Bỏ trống thì template không vẽ dòng đó.
    const normalizeUid = (item) => ({
      groupUid: cleanText(item.groupUid, 40),
      sku: cleanText(item.sku, 40),
      productName: cleanText(item.productName ?? item.materialName, 180),
      lot: cleanText(item.lot, 20),
      roll: cleanText(item.roll, 20),
      copies: validCopies(item.copies ?? 1) || 0
    });
    if (Array.isArray(payload.items)) {
      const items = payload.items.slice(0, 100).map(normalizeUid);
      if (!items.length) errors.push("Danh sách Group UID đang trống");
      items.forEach((item, index) => {
        if (!item.groupUid || !ASCII_BARCODE.test(item.groupUid)) errors.push(`Group UID dòng ${index + 1} không hợp lệ`);
        if (item.sku && !SKU_PATTERN.test(item.sku)) errors.push(`SKU dòng ${index + 1} không hợp lệ`);
        if (!item.productName) errors.push(`Thiếu tên sản phẩm dòng ${index + 1}`);
        if (!item.copies) errors.push(`Số bản dòng ${index + 1} không hợp lệ`);
      });
      const totalCopies = items.reduce((sum, item) => sum + item.copies, 0);
      if (totalCopies !== copies) errors.push("Tổng số bản Group UID không khớp lệnh in");
      normalizedPayload = { items };
    } else {
      normalizedPayload = normalizeUid(payload);
      delete normalizedPayload.copies;
      if (!normalizedPayload.groupUid || !ASCII_BARCODE.test(normalizedPayload.groupUid)) errors.push("Group UID không hợp lệ");
      if (normalizedPayload.sku && !SKU_PATTERN.test(normalizedPayload.sku)) errors.push("SKU không hợp lệ");
      if (!normalizedPayload.productName) errors.push("Thiếu tên sản phẩm");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    job: {
      id: cleanText(source.id, 100),
      nonce: cleanText(source.nonce, 120),
      type,
      templateVersion,
      copies: copies || 0,
      requestedBy: cleanText(source.requestedBy, 100),
      payload: normalizedPayload
    }
  };
}
