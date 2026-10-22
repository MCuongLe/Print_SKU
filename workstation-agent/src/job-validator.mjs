const ASCII_BARCODE = /^[\x20-\x7E]+$/;
const SKU_PATTERN = /^[0-9A-Za-z._-]{1,40}$/;
// Mã vị trí kho: chữ IN HOA, số và . _ / - (print_enqueue trên Supabase dùng đúng mẫu này).
const LOCATION_PATTERN = /^[0-9A-Z][0-9A-Z._\/-]{0,39}$/;

const MAX_CODE_LENGTH = 40;
// Tem Group UID (0.10.0): số PO, RFID là mã định danh → chỉ cắt khoảng trắng hai đầu, sai mẫu hoặc quá dài thì từ chối cả lệnh
// (không gộp khoảng trắng bên trong, không cắt bớt như Lot/Roll). Mẫu ký tự giới hạn để chữ luôn vừa ô PO (xem fitTextBlock).
const PO_PATTERN = /^[0-9A-Za-z._\/ -]{1,20}$/;
const RFID_PATTERN = /^[0-9A-Za-z]{1,20}$/;
const RECEIVED_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

function cleanText(value, maxLength) {
  return String(value ?? "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

// Mã định danh (SKU, Group UID) không được cắt bớt hay gộp khoảng trắng: mã bị sửa là in ra tem của một mã KHÁC.
// Dài quá hoặc sai mẫu thì để bước kiểm bên dưới từ chối cả lệnh.
function rawCode(value) {
  return String(value ?? "").trim();
}

function validGroupUid(code) {
  return code.length >= 1 && code.length <= MAX_CODE_LENGTH && ASCII_BARCODE.test(code);
}

function validReceivedDate(value) {
  const match = RECEIVED_DATE_PATTERN.exec(value);
  if (!match) return false;
  const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
  if (year < 2000 || year > 2099) return false; // gõ năm hai chữ số ra 0026 ở ô ngày của web thì bị từ chối ở đây
  const date = new Date(Date.UTC(year, month - 1, day)); // ngày có thật trên lịch (31/02 không qua)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Các trường tuỳ chọn của tem Group UID: trống thì hợp lệ (template bỏ phần đó), có thì phải đúng dạng.
function uidExtraErrors(item, where) {
  const errors = [];
  if (item.po && !PO_PATTERN.test(item.po)) errors.push(`Số PO${where} chỉ gồm chữ, số, . _ / - và khoảng trắng, tối đa 20 ký tự`);
  if (item.rfid && !RFID_PATTERN.test(item.rfid)) errors.push(`RFID${where} chỉ gồm chữ và số, tối đa 20 ký tự`);
  if (item.receivedDate && !validReceivedDate(item.receivedDate)) errors.push(`Ngày nhận${where} phải dạng dd/mm/yyyy`);
  return errors;
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
  if (!['sku', 'group_uid', 'location'].includes(type)) errors.push("Loại tem không được hỗ trợ");

  let normalizedPayload = {};
  if (type === "sku") {
    if (templateVersion !== 1 && templateVersion !== 2) errors.push("Phiên bản tem SKU không được hỗ trợ");
    // v2 (0.10.1, tem Phụ liệu): giữ PO + ngày nhận, kiểm như tem Group UID; v1 giữ nguyên (bỏ trường lạ).
    const normalizeSku = (item) => ({
      sku: rawCode(item.sku),
      productName: cleanText(item.productName, 180),
      quantity: cleanText(item.quantity, 40),
      printedDate: cleanText(item.printedDate, 20),
      ...(templateVersion === 2 ? { po: String(item.po ?? "").trim(), receivedDate: String(item.receivedDate ?? "").trim() } : {}),
      copies: validCopies(item.copies ?? 1) || 0
    });
    const skuExtraErrors = (item, where) => (templateVersion === 2 ? uidExtraErrors(item, where) : []);
    if (Array.isArray(payload.items)) {
      const items = payload.items.slice(0, 100).map(normalizeSku);
      if (!items.length) errors.push("Danh sách SKU đang trống");
      items.forEach((item, index) => {
        if (!SKU_PATTERN.test(item.sku)) errors.push(`SKU dòng ${index + 1} không hợp lệ`);
        if (!item.productName) errors.push(`Thiếu tên sản phẩm dòng ${index + 1}`);
        errors.push(...skuExtraErrors(item, ` dòng ${index + 1}`));
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
      errors.push(...skuExtraErrors(normalizedPayload, ""));
    }
  }

  if (type === "group_uid") {
    // Lot và Roll không bắt buộc: trước đây người vận hành ghi bút lên tem.
    // Bỏ trống thì template không vẽ dòng đó.
    const normalizeUid = (item) => ({
      groupUid: rawCode(item.groupUid),
      sku: rawCode(item.sku),
      productName: cleanText(item.productName ?? item.materialName, 180),
      lot: cleanText(item.lot, 20),
      roll: cleanText(item.roll, 20),
      rfid: String(item.rfid ?? "").trim(),
      po: String(item.po ?? "").trim(),
      receivedDate: String(item.receivedDate ?? "").trim(),
      copies: validCopies(item.copies ?? 1) || 0
    });
    if (Array.isArray(payload.items)) {
      const items = payload.items.slice(0, 100).map(normalizeUid);
      if (!items.length) errors.push("Danh sách Group UID đang trống");
      items.forEach((item, index) => {
        if (!validGroupUid(item.groupUid)) errors.push(`Group UID dòng ${index + 1} không hợp lệ`);
        if (item.sku && !SKU_PATTERN.test(item.sku)) errors.push(`SKU dòng ${index + 1} không hợp lệ`);
        if (!item.productName) errors.push(`Thiếu tên sản phẩm dòng ${index + 1}`);
        errors.push(...uidExtraErrors(item, ` dòng ${index + 1}`));
        if (!item.copies) errors.push(`Số bản dòng ${index + 1} không hợp lệ`);
      });
      const totalCopies = items.reduce((sum, item) => sum + item.copies, 0);
      if (totalCopies !== copies) errors.push("Tổng số bản Group UID không khớp lệnh in");
      normalizedPayload = { items };
    } else {
      normalizedPayload = normalizeUid(payload);
      delete normalizedPayload.copies;
      if (!validGroupUid(normalizedPayload.groupUid)) errors.push("Group UID không hợp lệ");
      if (normalizedPayload.sku && !SKU_PATTERN.test(normalizedPayload.sku)) errors.push("SKU không hợp lệ");
      if (!normalizedPayload.productName) errors.push("Thiếu tên sản phẩm");
      errors.push(...uidExtraErrors(normalizedPayload, ""));
    }
  }

  if (type === "location") {
    if (templateVersion !== 1) errors.push("Phiên bản tem vị trí không được hỗ trợ");
    // Không cắt bớt mã/tên: mã bị cắt là in ra tem của một vị trí KHÁC — sai thì từ chối cả lệnh.
    const items = Array.isArray(payload.items) ? payload.items.slice(0, 100).map((item) => ({
      code: String(item?.code ?? "").trim(),
      name: cleanText(item?.name, 200),
      copies: validCopies(item?.copies ?? 1) || 0
    })) : [];
    if (!items.length) errors.push("Danh sách vị trí đang trống");
    items.forEach((item, index) => {
      if (!LOCATION_PATTERN.test(item.code)) errors.push(`Mã vị trí dòng ${index + 1} không hợp lệ`);
      // Tên là tùy chọn (02/10/2026): trống thì tem chỉ in QR + mã.
      if (item.name.length > 60) errors.push(`Tên vị trí dòng ${index + 1} tối đa 60 ký tự`);
      if (!item.copies) errors.push(`Số tem dòng ${index + 1} không hợp lệ`);
    });
    const totalCopies = items.reduce((sum, item) => sum + item.copies, 0);
    if (items.length && totalCopies !== copies) errors.push("Tổng số tem vị trí không khớp lệnh in");
    normalizedPayload = { items };
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
