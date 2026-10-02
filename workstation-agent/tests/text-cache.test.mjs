import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedMeasure, createTextCache, PROBE_SIZES, PROBE_TEXTS } from "../src/text-cache.mjs";

// measureTextWidths giả: bề rộng = số ký tự × cỡ × hệ số; ghi lại từng lần "gọi PowerShell".
function fakeBase(factor = 0.5) {
  const calls = [];
  const table = (texts, sizes) => new Map(texts.map((text) => [text, new Map(sizes.map((size) => [size, text.length * size * factor]))]));
  const fn = async (config, texts, sizes, options = {}) => {
    calls.push({ texts: [...texts], sizes: [...sizes], extra: (options.extra || []).map((group) => ({ texts: [...group.texts], sizes: [...group.sizes] })) });
    return Object.assign(table(texts, sizes), { extra: (options.extra || []).map((group) => table(group.texts, group.sizes)) });
  };
  fn.calls = calls;
  return fn;
}
const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "text-cache-")), "text-metrics-cache.json");
// Bỏ lần gọi đo chuỗi mẫu (đối chiếu font) khỏi số lần gọi cần kiểm tra.
const realCalls = (base) => base.calls.filter((call) => call.texts.join() !== PROBE_TEXTS.join());

test("cachedMeasure: lần đầu đo qua PowerShell, lần sau trùng cache không gọi nữa, kết quả y hệt", async () => {
  const base = fakeBase();
  const cache = createTextCache({ file: tempFile(), version: "t1" });
  const measure = cachedMeasure(base, cache);
  const opts = { extra: [{ texts: ["300.000"], sizes: [40, 36] }, { texts: ["30/09/26"], sizes: [24] }] };
  const first = await measure({}, ["Chỉ ", "may/"], [22, 16], opts);
  assert.equal(realCalls(base).length, 1, "lần đầu: đúng một lần gọi cho cả lô");
  const second = await measure({}, ["Chỉ ", "may/"], [22, 16], opts);
  assert.equal(realCalls(base).length, 1, "lần sau: không gọi PowerShell");
  assert.equal(second.get("may/").get(16), first.get("may/").get(16));
  assert.equal(second.extra[0].get("300.000").get(36), 7 * 36 * 0.5);
  assert.equal(second.extra[1].get("30/09/26").get(24), 8 * 24 * 0.5);
});

test("cachedMeasure: thiếu một phần thì chỉ đo đúng phần thiếu, vẫn một lần gọi", async () => {
  const base = fakeBase();
  const cache = createTextCache({ file: tempFile(), version: "t1" });
  const measure = cachedMeasure(base, cache);
  await measure({}, ["A ", "B "], [22], { extra: [{ texts: ["x"], sizes: [40] }] });
  const result = await measure({}, ["A ", "C "], [22], { extra: [{ texts: ["x", "y"], sizes: [40] }] });
  const calls = realCalls(base);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].texts, ["C "], "chỉ đo chữ chưa có");
  assert.deepEqual(calls[1].extra.map((group) => group.texts), [["y"]]);
  assert.equal(result.get("A ").get(22), 2 * 22 * 0.5);
  assert.equal(result.extra[0].get("y").get(40), 1 * 40 * 0.5);
});

test("Lưu xuống đĩa rồi mở lại (khởi động lại agent): dùng tiếp cache, không đo lại", async () => {
  const file = tempFile();
  const base = fakeBase();
  const first = createTextCache({ file, version: "t1", saveDelayMs: 0 });
  await cachedMeasure(base, first)({}, ["Vải "], [22, 20]);
  first.flush();
  const reopened = createTextCache({ file, version: "t1" });
  const again = fakeBase();
  const result = await cachedMeasure(again, reopened)({}, ["Vải "], [22, 20]);
  assert.equal(realCalls(again).length, 0, "đã có trong file thì không gọi PowerShell");
  assert.equal(result.get("Vải ").get(20), 4 * 20 * 0.5);
  assert.equal(reopened.generation, first.generation, "cùng thế hệ cache");
});

test("Đổi phiên bản agent hoặc font đo khác chuỗi mẫu → bỏ cache, đổi generation", async () => {
  const file = tempFile();
  const first = createTextCache({ file, version: "0.8.6|Arial", saveDelayMs: 0 });
  await cachedMeasure(fakeBase(0.5), first)({}, ["Nút "], [22]);
  first.flush();
  const newVersion = createTextCache({ file, version: "0.8.7|Arial" });
  assert.equal(newVersion.size, 0, "phiên bản khác: không đọc file cũ");
  const sameVersion = createTextCache({ file, version: "0.8.6|Arial" });
  assert.ok(sameVersion.size > 0);
  const changedFont = fakeBase(0.6);   // Windows đổi font: chuỗi mẫu ra số khác
  await sameVersion.ensureValid(changedFont, {});
  assert.equal(sameVersion.ready, true);
  assert.equal(sameVersion.get("Nút ", 22), undefined, "mục cũ phải bị xoá");
  assert.notEqual(sameVersion.generation, first.generation);
});

test("File hỏng hoặc chưa đối chiếu được chuỗi mẫu: không vỡ, đo thẳng như bản cũ", async () => {
  const file = tempFile();
  fs.writeFileSync(file, "{ nửa chừng");
  const cache = createTextCache({ file, version: "t1" });
  assert.equal(cache.size, 0);
  let probeFails = true;
  const flaky = async (config, texts, sizes, options) => {
    if (probeFails && texts.join() === PROBE_TEXTS.join()) throw new Error("PowerShell bận");
    return fakeBase()(config, texts, sizes, options);
  };
  const measure = cachedMeasure(flaky, cache);
  const result = await measure({}, ["Dây "], [22]);
  assert.equal(cache.ready, false, "chưa đối chiếu được thì không dùng cache");
  assert.equal(result.get("Dây ").get(22), 4 * 22 * 0.5, "vẫn đo được bằng PowerShell");
  probeFails = false;
  await measure({}, ["Dây "], [22]);
  assert.equal(cache.ready, true, "lần sau đối chiếu lại thành công");
  assert.equal(cache.get(PROBE_TEXTS[0], PROBE_SIZES[0]), undefined, "chuỗi mẫu không lẫn vào cache");
});

test("Vượt trần số mục thì bỏ bớt mục cũ nhất, mục mới vẫn còn", async () => {
  const cache = createTextCache({ file: tempFile(), version: "t1", maxEntries: 10 });
  const measure = cachedMeasure(fakeBase(), cache);
  // Tên chỉ gồm chữ cái (chữ số bị gộp khoá từ 0.8.8): "AA ", "BA ", ... đều khác nhau.
  const name = (i) => `${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))} `;
  for (let i = 0; i < 30; i += 1) await measure({}, [name(i)], [22]);
  assert.ok(cache.size <= 10);
  assert.ok(cache.get(name(29), 22) !== undefined, "mục mới nhất phải còn");
  assert.equal(cache.get(name(0), 22), undefined, "mục cũ nhất bị bỏ");
});
