import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { measureTextWidths } from "../src/text-metrics.mjs";

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "text-metrics-"));
  return { tempDir: dir, rootDir: path.resolve(import.meta.dirname, "..") };
}

test("measureTextWidths: chuoi rong khong goi PowerShell, tra Map rong", async () => {
  let called = false;
  const config = tempConfig();
  const result = await measureTextWidths(config, [], [22], { __exec: async () => { called = true; } });
  assert.equal(called, false, "khong duoc goi PowerShell khi khong co gi de do");
  assert.equal(result.size, 0);
});

test("measureTextWidths: goi PowerShell DUNG MOT LAN du co bao nhieu chuoi/co chu", async () => {
  let callCount = 0;
  const config = tempConfig();
  const __exec = async (scriptFile, inputFile, outputFile) => {
    callCount += 1;
    const request = JSON.parse(fs.readFileSync(inputFile, "utf8"));
    // Gia lap GDI+: moi ky tu rong 10px, khong phu thuoc co chu de test don gian.
    const results = [];
    for (const size of request.sizes) {
      for (const text of request.texts) results.push({ text, size, width: text.length * 10 });
    }
    fs.writeFileSync(outputFile, JSON.stringify({ ok: true, results }), "utf8");
  };

  const texts = ["Áo", "Áo", "Quần", "Váy"]; // "Áo" lap lai co ty
  const result = await measureTextWidths(config, texts, [22, 18], { __exec });

  assert.equal(callCount, 1, "phai goi PowerShell dung mot lan cho ca lo, khong phai theo tung chuoi");
  assert.equal(result.get("Áo").get(22), 20);
  assert.equal(result.get("Áo").get(18), 20);
  assert.equal(result.get("Quần").get(22), 40);
  assert.equal(result.get("Váy").get(22), 30);
});

test("measureTextWidths: loai trung chuoi truoc khi gui, khong do lap", async () => {
  const config = tempConfig();
  let sentTexts = null;
  const __exec = async (scriptFile, inputFile, outputFile) => {
    const request = JSON.parse(fs.readFileSync(inputFile, "utf8"));
    sentTexts = request.texts;
    fs.writeFileSync(outputFile, JSON.stringify({
      ok: true,
      results: request.texts.map((t) => ({ text: t, size: 22, width: t.length })),
    }), "utf8");
  };
  await measureTextWidths(config, ["A", "A", "A", "B"], [22], { __exec });
  assert.deepEqual([...sentTexts].sort(), ["A", "B"]);
});

test("measureTextWidths: PowerShell bao loi thi nem loi ro rang, khong tra ket qua sai", async () => {
  const config = tempConfig();
  const __exec = async (scriptFile, inputFile, outputFile) => {
    fs.writeFileSync(outputFile, JSON.stringify({ ok: false, message: "Font khong ton tai" }), "utf8");
  };
  await assert.rejects(
    measureTextWidths(config, ["A"], [22], { __exec }),
    /Font khong ton tai/
  );
});

test("measureTextWidths: don file tam sau khi xong, ke ca khi loi", async () => {
  const config = tempConfig();
  const __exec = async (scriptFile, inputFile, outputFile) => {
    fs.writeFileSync(outputFile, JSON.stringify({ ok: false, message: "loi gia" }), "utf8");
  };
  try { await measureTextWidths(config, ["A"], [22], { __exec }); } catch { /* mong doi */ }
  const left = fs.readdirSync(config.tempDir).filter((f) => f.startsWith("measure-"));
  assert.deepEqual(left, [], `phai don sach file tam, con lai: ${left.join(", ")}`);
});
