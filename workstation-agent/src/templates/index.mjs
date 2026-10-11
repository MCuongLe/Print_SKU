import { renderGroupUidLabel } from "./group-uid-label.mjs";
import { renderSkuLabel } from "./sku-label.mjs";
import { renderLocationLabel } from "./location-label.mjs";

// 0.9.0: bỏ fabric_relaxation (web đã gỡ màn TEM XẢ VẢI 11/10/2026). Agent không còn khai capability này
// nên hàng đợi không giao lệnh loại đó cho agent nữa.
export const CAPABILITIES = ["sku:v1", "group_uid:v1", "location:v1", "location:name-optional"];

export function renderLabelSvg(job) {
  if (job.type === "sku") return renderSkuLabel(job.payload);
  if (job.type === "group_uid") return renderGroupUidLabel(job.payload);
  if (job.type === "location") return renderLocationLabel(job.payload);
  throw new Error(`Không có template cho loại tem ${job.type}`);
}
