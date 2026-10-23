import { renderGroupUidLabel } from "./group-uid-label.mjs";
import { renderSkuLabel } from "./sku-label.mjs";
import { renderLocationLabel } from "./location-label.mjs";

// 0.9.0: bỏ fabric_relaxation (web đã gỡ màn TEM XẢ VẢI 11/10/2026). Agent không còn khai capability này
// nên hàng đợi không giao lệnh loại đó cho agent nữa.
// 0.10.1: sku:v2 = tem Phụ liệu có PO + ngày nhận (templateVersion 2); lệnh v2 chỉ giao cho agent khai capability này.
// 0.10.2: sku:v3 = mẫu gộp v1 + v2 (khung PO/ngày theo từng tem, số lượng như v1); v1, v2 giữ cho lệnh cũ còn trong hàng đợi.
export const CAPABILITIES = ["sku:v1", "sku:v2", "sku:v3", "group_uid:v1", "location:v1", "location:name-optional"];

export function renderLabelSvg(job) {
  if (job.type === "sku") return renderSkuLabel(job.payload, { version: job.templateVersion });
  if (job.type === "group_uid") return renderGroupUidLabel(job.payload);
  if (job.type === "location") return renderLocationLabel(job.payload);
  throw new Error(`Không có template cho loại tem ${job.type}`);
}
