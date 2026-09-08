import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { LABEL_GAP_MM, LABEL_HEIGHT, LABEL_HEIGHT_MM, LABEL_WIDTH, ROW_GAP_MM, ROW_WIDTH } from "./templates/common.mjs";
import { renderLabelSvg } from "./templates/index.mjs";

function innerSvg(svg) {
  return svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
}

export function renderRowSvg(job, count = 2) {
  const label = innerSvg(renderLabelSvg(job));
  const secondX = LABEL_WIDTH + LABEL_GAP_MM * 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ROW_WIDTH}" height="${LABEL_HEIGHT}" viewBox="0 0 ${ROW_WIDTH} ${LABEL_HEIGHT}" shape-rendering="crispEdges"><rect width="${ROW_WIDTH}" height="${LABEL_HEIGHT}" fill="#fff"/><g>${label}</g>${count > 1 ? `<g transform="translate(${secondX},0)">${label}</g>` : ""}</svg>`;
}

export function rawToMonochrome(raw, width, height, threshold = 170) {
  const bytesPerRow = Math.ceil(width / 8);
  // TSPL BITMAP uses 0 for a printed (black) dot and 1 for an unprinted (white) dot.
  const bitmap = Buffer.alloc(bytesPerRow * height, 0xff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (raw[y * width + x] < threshold) bitmap[y * bytesPerRow + (x >> 3)] &= ~(0x80 >> (x & 7));
    }
  }
  return { bitmap, bytesPerRow };
}

async function rowBitmap(job, count) {
  const svg = renderRowSvg(job, count);
  const { data, info } = await sharp(Buffer.from(svg)).flatten({ background: "#fff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { ...rawToMonochrome(data, info.width, info.height), width: info.width, height: info.height };
}

function tsplHeader(config) {
  const rowWidthMm = 40 * 2 + LABEL_GAP_MM;
  return Buffer.from(`SIZE ${rowWidthMm} mm,${LABEL_HEIGHT_MM} mm\r\nGAP ${ROW_GAP_MM} mm,0\r\nDIRECTION 1\r\nREFERENCE 0,0\r\nDENSITY ${config.density}\r\nSPEED ${config.speed}\r\n`, "ascii");
}

export async function renderJobTspl(job, config, onProgress = null) {
  const pieces = [tsplHeader(config)];
  const entries = job.type === "sku" && Array.isArray(job.payload?.items)
    ? job.payload.items.map((item) => ({ ...job, copies: item.copies, payload: item }))
    : [job];
  let rendered = 0;
  for (const entry of entries) {
    let remaining = entry.copies;
    while (remaining > 0) {
      const count = Math.min(2, remaining);
      const row = await rowBitmap(entry, count);
      pieces.push(Buffer.from(`CLS\r\nBITMAP 0,0,${row.bytesPerRow},${row.height},0,`, "ascii"));
      pieces.push(row.bitmap);
      pieces.push(Buffer.from("\r\nPRINT 1\r\n", "ascii"));
      remaining -= count;
      rendered += count;
      if (onProgress && (rendered % 20 === 0 || rendered === job.copies)) await onProgress(rendered, job.copies);
    }
  }
  return Buffer.concat(pieces);
}

export async function writePreview(job, outputFile) {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  await sharp(Buffer.from(renderLabelSvg(job))).png().toFile(outputFile);
  return outputFile;
}
