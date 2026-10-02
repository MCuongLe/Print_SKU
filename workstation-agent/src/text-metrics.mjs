import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getPowerShellHost } from "./ps-host.mjs";

const execFileAsync = promisify(execFile);

/**
 * Đo bề rộng thật (px, GDI+ Arial) cho nhiều chuỗi trong MỘT lần gọi PowerShell.
 *
 * Đo thật ngày 24/09/2026: mở một tiến trình PowerShell rỗng mất ~800ms cố định;
 * đo thêm mỗi chuỗi bên trong cùng tiến trình đó gần như miễn phí (100 chuỗi khác
 * nhau chỉ tốn thêm ~16ms). Vì vậy hàm này LUÔN được gọi đúng MỘT LẦN cho cả lệnh
 * in — dù lệnh có 1 tem hay 100 tem, giống nhau hay khác nhau — không bao giờ gọi
 * riêng cho từng tem (làm vậy sẽ tốn hàng chục giây thay vì dưới 1 giây).
 *
 * @param {object} config cần config.tempDir để ghi file JSON tạm (tránh lỗi escape
 *   ký tự tiếng Việt/dấu nháy nếu truyền thẳng qua dòng lệnh).
 * @param {string[]} texts danh sách chuỗi cần đo (không cần loại trùng, hàm tự loại).
 * @param {number[]} fontSizesPx danh sách cỡ chữ (px) cần đo cho mỗi chuỗi.
 * @param {object} [options.extra] nhóm đo thêm trong CÙNG lần gọi PowerShell,
 *   mỗi nhóm `{ texts, sizes }` — dùng cho số lượng và ngày ở đáy tem SKU (cỡ
 *   chữ khác tên sản phẩm), để cả lệnh in vẫn chỉ gọi PowerShell đúng hai lần.
 * @returns {Promise<Map<string, Map<number, number>>>} text -> (size -> width px),
 *   kèm thuộc tính `extra`: mảng Map cùng dạng, theo đúng thứ tự `options.extra`.
 *   Không có gì để đo thì trả Map rỗng, không gọi PowerShell.
 */
export async function measureTextWidths(config, texts, fontSizesPx, { __exec = runPowerShell, extra = [] } = {}) {
  const unique = (values) => [...new Set(values.filter((t) => t))];
  const uniqueTexts = unique(texts);
  const extraRequests = extra.map((group) => ({ texts: unique(group.texts), sizes: group.sizes }));
  const empty = () => Object.assign(new Map(), { extra: extraRequests.map(() => new Map()) });
  if (!uniqueTexts.length && !extraRequests.some((group) => group.texts.length)) return empty();

  const tempDir = config?.tempDir ?? ".";
  fs.mkdirSync(tempDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputFile = path.join(tempDir, `measure-in-${stamp}.json`);
  const outputFile = path.join(tempDir, `measure-out-${stamp}.json`);
  const scriptFile = path.join(config?.rootDir ?? ".", "powershell", "measure-text.ps1");

  try {
    const request = { texts: uniqueTexts, sizes: fontSizesPx };
    if (extraRequests.length) request.extra = extraRequests;
    fs.writeFileSync(inputFile, JSON.stringify(request), "utf8");
    await __exec(scriptFile, inputFile, outputFile);
    const raw = fs.readFileSync(outputFile, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    if (!parsed.ok) throw new Error(parsed.message || "PowerShell báo lỗi khi đo chữ");

    const byText = empty();
    for (const row of parsed.results) {
      // Dòng có `group` thuộc nhóm đo thêm; không có là nhóm chính như trước.
      const target = Number.isInteger(row.group) ? byText.extra[row.group] : byText;
      if (!target) continue;
      if (!target.has(row.text)) target.set(row.text, new Map());
      target.get(row.text).set(row.size, row.width);
    }
    return byText;
  } finally {
    for (const file of [inputFile, outputFile]) {
      try { fs.unlinkSync(file); } catch { /* file tạm dọn best-effort */ }
    }
  }
}

async function runPowerShell(scriptFile, inputFile, outputFile) {
  // Đo chữ là việc lặp lại được: host lỗi kiểu nào cũng rơi về cách cũ (mở PowerShell mới).
  const host = getPowerShellHost();
  if (host) {
    try {
      await host.runScript(path.basename(scriptFile), { InputFile: inputFile, OutputFile: outputFile }, { timeoutMs: 15000 });
      return;
    } catch { /* rơi về cách cũ */ }
  }
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile, "-InputFile", inputFile, "-OutputFile", outputFile],
    { windowsHide: true, timeout: 15000 }
  );
}
