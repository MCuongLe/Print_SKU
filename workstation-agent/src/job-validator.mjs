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

// 0.11.0 phiếu xả vải: ngày giờ ISO 8601 có múi giờ (Postgres trả "2026-11-04T08:30:00.123456+00:00").
// Bắt buộc có múi giờ để giờ in trên phiếu không phụ thuộc đồng hồ máy trạm.
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/i;
const XA_VAI_MAX_COPIES = 5;
const XA_VAI_MAX_ITEMS = 100;
// CONTRACT V2: actual_mm ≤ 100.000 m (check của bảng xa_vai_measures); Lot/Roll phiếu tối đa 40 ký tự.
const XA_VAI_MAX_MM = 100000000;
// Trần số lượng theo đơn vị gốc (g / mm / m) của phiếu 0.12.0: rộng hơn mm vì vải g có cuộn hàng chục kg.
const XA_VAI_MAX_QTY = 1e9;
const XA_VAI_CODE_LENGTH = 40;
// CONTRACT V3: Mã hàng (mã kiểu hàng, ví dụ CWSH02) — cùng mẫu với check item_code của bảng xa_vai_measures.
const XA_VAI_ITEM_CODE = /^[0-9A-Z._-]{1,40}$/;

function validIsoDateTime(value) {
  return typeof value === "string" && ISO_DATE_TIME.test(value.trim()) && Number.isFinite(Date.parse(value.trim()));
}

// Số đo (mm) của phiếu xả vải: số JSON, hoặc chuỗi số (phòng khi phía máy chủ trả numeric dạng chuỗi). null, "", true... không phải số.
function meterNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value.trim());
  return Number.NaN;
}

// Loại lệnh mỗi chế độ máy in được nhận (hàng đợi đã chia theo capability; đây là chốt chặn thứ hai).
const KIND_TYPES = { label: ["sku", "group_uid", "location"], a4: ["xa_vai_sheet"] };

export function normalizeJob(input, { printerKind } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const payload = source.payload && typeof source.payload === "object" ? source.payload : {};
  const type = cleanText(source.type, 30).toLowerCase();
  const templateVersion = Number(source.templateVersion) || 1;
  const copies = validCopies(source.copies);
  const errors = [];
  if (!source.id) errors.push("Thiếu id của lệnh in");
  if (!source.nonce) errors.push("Thiếu nonce chống gửi trùng");
  if (type === "xa_vai_sheet") {
    if (!copies || copies > XA_VAI_MAX_COPIES) errors.push(`Số bản phiếu phải từ 1 đến ${XA_VAI_MAX_COPIES}`);
  } else if (!copies) errors.push("Số tem phải từ 1 đến 500");
  if (!['sku', 'group_uid', 'location', 'xa_vai_sheet'].includes(type)) errors.push("Loại tem không được hỗ trợ");
  else if (printerKind && !(KIND_TYPES[printerKind] ?? KIND_TYPES.label).includes(type)) {
    errors.push(printerKind === "a4" ? "Máy in A4 chỉ in phiếu xả vải, không in tem" : "Máy in tem không in phiếu A4");
  }

  let normalizedPayload = {};
  if (type === "sku") {
    if (![1, 2, 3].includes(templateVersion)) errors.push("Phiên bản tem SKU không được hỗ trợ");
    // v2 (0.10.1, tem Phụ liệu) và v3 (0.10.2, mẫu gộp): giữ PO + ngày nhận (tuỳ chọn), kiểm như tem Group UID;
    // v1 giữ nguyên (bỏ trường lạ). Số lượng giữ ở mọi phiên bản (v2 không in, xem sku-label.mjs).
    const keepsPoDate = templateVersion === 2 || templateVersion === 3;
    const normalizeSku = (item) => ({
      sku: rawCode(item.sku),
      productName: cleanText(item.productName, 180),
      quantity: cleanText(item.quantity, 40),
      printedDate: cleanText(item.printedDate, 20),
      ...(keepsPoDate ? { po: String(item.po ?? "").trim(), receivedDate: String(item.receivedDate ?? "").trim() } : {}),
      copies: validCopies(item.copies ?? 1) || 0
    });
    const skuExtraErrors = (item, where) => (keepsPoDate ? uidExtraErrors(item, where) : []);
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

  if (type === "xa_vai_sheet") {
    // Phiếu theo dõi xả vải (0.11.0): mọi số liệu do máy chủ dựng từ DB; sai bất kỳ trường nào thì từ chối cả lệnh,
    // không in phiếu thiếu dòng. Số đo là mm nguyên (systemMm, actualMm — CONTRACT V2); payload v1 chỉ có systemM/actualM
    // thì thiếu actualMm → từ chối. Lot/Roll giữ 40 ký tự (phiếu là bản ghi theo dõi, mã không nên bị cắt im lặng; mẫu
    // phiếu tự thu cỡ / cắt "…" trong ô); tem Group UID vẫn 20. Tên sản phẩm cắt 180 như mọi loại tem.
    // CONTRACT V3: itemCode = mã kiểu hàng nhập lúc in (máy chủ đã chuẩn hoá viết hoa) — bắt buộc, đúng mẫu, KHÔNG sửa giúp
    // (mã bị sửa là phiếu treo nhầm hàng); sku nằm ở TỪNG dòng (một phiếu nhiều SKU); productName tuỳ chọn (null khi nhiều SKU).
    if (templateVersion !== 1) errors.push("Phiên bản phiếu xả vải không được hỗ trợ");
    const itemCode = typeof payload.itemCode === "string" ? payload.itemCode : "";
    if (!XA_VAI_ITEM_CODE.test(itemCode)) errors.push("Mã hàng chỉ gồm chữ IN HOA, số, . _ - (1–40 ký tự)");
    const printedAt = typeof payload.printedAt === "string" ? payload.printedAt.trim() : "";
    if (!validIsoDateTime(printedAt)) errors.push("Ngày giờ in không hợp lệ");
    const sourceItems = Array.isArray(payload.items) ? payload.items : [];
    if (!sourceItems.length) errors.push("Danh sách Group UID đang trống");
    if (sourceItems.length > XA_VAI_MAX_ITEMS) errors.push(`Phiếu tối đa ${XA_VAI_MAX_ITEMS} Group UID`);
    // 0.12.0 (máy chủ xa_vai_a4_v2): trường thêm cho mẫu phiếu mới — có khoá `unit` ở MỌI dòng thì giữ unit / systemQty / actualQty (đơn vị gốc),
    // fabricCode, color, itNumber; số lượng sai thì từ chối cả lệnh như mét. itNumbers: số phiếu IT 16 chữ số (bỏ mã sai, tối đa 10).
    const rich = sourceItems.length > 0 && sourceItems.every((entry) => entry && typeof entry === "object" && Object.prototype.hasOwnProperty.call(entry, "unit"));
    const optionalQty = (value, label, where) => {
      if (value === null || value === undefined || value === "") return null;
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > XA_VAI_MAX_QTY) { errors.push(`${label}${where} không hợp lệ`); return null; }
      return number;
    };
    const itNumbers = [...new Set((Array.isArray(payload.itNumbers) ? payload.itNumbers : []).map((value) => String(value ?? "").trim()).filter((value) => /^\d{16}$/.test(value)))].slice(0, 10);
    const items = sourceItems.slice(0, XA_VAI_MAX_ITEMS).map((raw, index) => {
      const entry = raw && typeof raw === "object" ? raw : {};
      const where = ` dòng ${index + 1}`;
      const groupUid = rawCode(entry.groupUid);
      if (!validGroupUid(groupUid)) errors.push(`Group UID${where} không hợp lệ`);
      const sku = rawCode(entry.sku);
      if (!SKU_PATTERN.test(sku)) errors.push(`SKU${where} không hợp lệ`);
      const actualMm = Math.round(meterNumber(entry.actualMm));
      if (!Number.isFinite(actualMm) || actualMm < 1 || actualMm > XA_VAI_MAX_MM) errors.push(`Mét thực tế${where} phải lớn hơn 0 và không quá 100.000 m`);
      const systemMm = entry.systemMm === null || entry.systemMm === undefined ? null : Math.round(meterNumber(entry.systemMm));
      if (systemMm !== null && !(Number.isFinite(systemMm) && systemMm >= 0)) errors.push(`Mét hệ thống${where} không hợp lệ`);
      const measuredAt = typeof entry.measuredAt === "string" ? entry.measuredAt.trim() : "";
      if (!validIsoDateTime(measuredAt)) errors.push(`Giờ nhập${where} không hợp lệ`);
      const base = { groupUid, sku, lot: cleanText(entry.lot, XA_VAI_CODE_LENGTH), roll: cleanText(entry.roll, XA_VAI_CODE_LENGTH), systemMm, actualMm, measuredAt };
      if (!rich) return base;
      const itNumber = String(entry.itNumber ?? "").trim();
      return {
        ...base,
        unit: cleanText(entry.unit, 20) || null,
        systemQty: optionalQty(entry.systemQty, "Số lượng hệ thống", where),
        actualQty: optionalQty(entry.actualQty, "Số lượng thực tế", where),
        fabricCode: cleanText(entry.fabricCode, 80) || null,
        color: cleanText(entry.color, 80) || null,
        itNumber: /^\d{16}$/.test(itNumber) ? itNumber : null
      };
    });
    normalizedPayload = {
      itemCode,
      productName: cleanText(payload.productName, 180) || null,
      printedAt,
      reprint: payload.reprint === true,
      ...(rich ? { itNumbers } : {}),
      items
    };
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
