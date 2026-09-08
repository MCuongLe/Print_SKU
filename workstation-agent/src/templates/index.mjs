import { renderGroupUidLabel } from "./group-uid-label.mjs";
import { renderSkuLabel } from "./sku-label.mjs";

export const CAPABILITIES = ["sku:v1", "group_uid:v1"];

export function renderLabelSvg(job) {
  if (job.type === "sku") return renderSkuLabel(job.payload);
  if (job.type === "group_uid") return renderGroupUidLabel(job.payload);
  throw new Error(`Không có template cho loại tem ${job.type}`);
}
