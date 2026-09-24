import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
 * @returns {Promise<Map<string, Map<number, number>>>} text -> (size -> width px).
 *   Trả về Map rỗng nếu `texts` rỗng, không gọi PowerShell.
 */
export async function measureTextWidths(config, texts, fontSizesPx, { __exec = runPowerShell } = {}) {
  const uniqueTexts = [...new Set(texts.filter((t) => t))];
  if (!uniqueTexts.length) return new Map();

  const tempDir = config?.tempDir ?? ".";
  fs.mkdirSync(tempDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputFile = path.join(tempDir, `measure-in-${stamp}.json`);
  const outputFile = path.join(tempDir, `measure-out-${stamp}.json`);
  const scriptFile = path.join(config?.rootDir ?? ".", "powershell", "measure-text.ps1");

  try {
    fs.writeFileSync(inputFile, JSON.stringify({ texts: uniqueTexts, sizes: fontSizesPx }), "utf8");
    await __exec(scriptFile, inputFile, outputFile);
    const raw = fs.readFileSync(outputFile, "utf8").replace(/^﻿/, "");
    const parsed = JSON.parse(raw);
    if (!parsed.ok) throw new Error(parsed.message || "PowerShell báo lỗi khi đo chữ");

    const byText = new Map();
    for (const row of parsed.results) {
      if (!byText.has(row.text)) byText.set(row.text, new Map());
      byText.get(row.text).set(row.size, row.width);
    }
    return byText;
  } finally {
    for (const file of [inputFile, outputFile]) {
      try { fs.unlinkSync(file); } catch { /* file tạm dọn best-effort */ }
    }
  }
}

async function runPowerShell(scriptFile, inputFile, outputFile) {
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile, "-InputFile", inputFile, "-OutputFile", outputFile],
    { windowsHide: true, timeout: 15000 }
  );
}
