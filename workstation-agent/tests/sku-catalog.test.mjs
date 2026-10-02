import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedMeasure, createTextCache, PROBE_TEXTS } from "../src/text-cache.mjs";
import { createSkuCatalog } from "../src/sku-catalog.mjs";
import { planProductNames } from "../src/render.mjs";

const config = { supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_test" };
function fakeBase() {
  const calls = [];
  const table = (texts, sizes) => new Map(texts.map((text) => [text, new Map(sizes.map((size) => [size, text.length * size * 0.45]))]));
  const fn = async (cfg, texts, sizes, options = {}) => {
    if (texts.join() !== PROBE_TEXTS.join()) calls.push(texts.length + (options.extra || []).reduce((n, group) => n + group.texts.length, 0));
    return Object.assign(table(texts, sizes), { extra: (options.extra || []).map((group) => table(group.texts, group.sizes)) });
  };
  fn.calls = calls;
  return fn;
}
// SKU_Name giả trên Supabase: hỏi updated_at mới nhất, hoặc đọc theo trang bằng header Range.
function fakeSupabase(rows, { updatedAt = "2026-10-01T00:56:50+00:00" } = {}) {
  const server = { rows, updatedAt, down: false, latestCalls: 0, pageCalls: 0 };
  server.fetch = async (url, init) => {
    if (server.down) throw new TypeError("fetch failed");
    const json = (data) => ({ ok: true, status: 200, json: async () => data });
    if (url.includes("select=updated_at")) { server.latestCalls += 1; return json([{ updated_at: server.updatedAt }]); }
    server.pageCalls += 1;
    const [from, to] = init.headers.Range.split("-").map(Number);
    return json(server.rows.slice(from, to + 1).map(([sku, name]) => ({ sku, product_name: name, status: "1" })));
  };
  return server;
}
const setup = (rows, options = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sku-catalog-"));
  const base = fakeBase();
  const textCache = createTextCache({ file: path.join(dir, "text-metrics-cache.json"), version: "t1", saveDelayMs: 0 });
  const measureText = cachedMeasure(base, textCache);
  const server = fakeSupabase(rows);
  const make = (extra = {}) => createSkuCatalog({
    config, measureText, textCache, baseMeasure: base, file: path.join(dir, "sku-catalog.json"),
    fetchImpl: server.fetch, pageSize: 3, chunkSize: 2, busyPollMs: 1, sleep: async () => {}, ...options, ...extra
  });
  return { dir, base, textCache, measureText, server, make };
};
const NAMES = [["422475229", "Chỉ may/None/None/Roman N0144/Be/None/5000m/mm"], ["422475228", "(Combo) Chỉ may/None/None/Roman N0144/Be/None/5000m/cuộn"],
  ["422483416", "Nút bấm/T09/POM/none/Dark Blue/none/9mm/pcs"], ["422478432", "Vải Pique/SK9115_Shaoxing Sukun/88% Nylon 12% Spandex/Navy/g"],
  ["422521090", "Đệm vai/SP27826-190T_5S/100% Polyester/none/Trắng-White/none/12.5*7.5*6mm/pcs"]];

test("refresh: tải đủ danh mục theo trang; updated_at không đổi thì không tải lại; đổi thì tải lại", async () => {
  const { server, make } = setup(NAMES);
  const catalog = make();
  assert.equal(await catalog.refresh(), true);
  assert.equal(catalog.size, 5);
  assert.equal(server.pageCalls, 2, "5 dòng, trang 3 dòng → 2 trang");
  assert.equal(await catalog.refresh(), false, "chưa có cập nhật mới");
  assert.equal(server.pageCalls, 2);
  server.updatedAt = "2026-10-02T00:55:00+00:00";
  server.rows = [...NAMES, ["422999999", "Dây luồn/81T/None/Navy/Size 140cm/8mm/Sợi"]];
  assert.equal(await catalog.refresh(), true, "sáng hôm sau đồng bộ SKU");
  assert.equal(catalog.size, 6);
  const reopened = make();
  assert.equal(reopened.size, 6, "lưu xuống đĩa, khởi động lại vẫn còn");
  assert.equal(reopened.updatedAt, "2026-10-02T00:55:00+00:00");
});

test("warm: đo sẵn mọi tên; lệnh in sau đó không phải gọi PowerShell; tên mới chỉ đo tên mới", async () => {
  const { base, measureText, server, make } = setup(NAMES);
  const catalog = make();
  await catalog.refresh();
  assert.equal(await catalog.warm(), 5);
  assert.equal(catalog.warmedCount, 5);
  const before = base.calls.length;
  const entries = NAMES.slice(0, 3).map(([sku, productName]) => ({ type: "sku", copies: 1, payload: { sku, productName, quantity: "", printedDate: "" } }));
  const planned = await planProductNames(entries, config, measureText, null);
  assert.equal(base.calls.length, before, "tên đã đo sẵn: in không gọi PowerShell");
  assert.ok(planned[0].payload.productNameLines.length > 0);
  assert.equal(await catalog.warm(), 0, "không có tên mới thì không đo gì");
  server.updatedAt = "2026-10-02T00:55:00+00:00";
  server.rows = [...NAMES, ["422999999", "Dây luồn/81T/None/Navy/Size 140cm/8mm/Sợi"]];
  await catalog.refresh();
  assert.equal(await catalog.warm(), 1, "chỉ đo đúng tên mới");
});

test("warm: đang in hoặc vừa in xong thì chờ, rảnh mới đo", async () => {
  let busyChecks = 0;
  const { make } = setup(NAMES);
  const catalog = make({ isBusy: () => (busyChecks += 1) <= 3 });
  await catalog.refresh();
  assert.equal(await catalog.warm(), 5);
  assert.ok(busyChecks > 3, "phải hỏi lại đến khi rảnh");
});

test("Mất mạng: giữ danh mục đang có, không ném lỗi ra vòng in", async () => {
  const { server, make } = setup(NAMES);
  const catalog = make({ checkMs: 1, initialDelayMs: 0 });
  await catalog.refresh();
  server.down = true;
  await assert.rejects(catalog.refresh(), /fetch failed/);
  assert.equal(catalog.size, 5, "vẫn giữ 5 SKU cũ");
  const controller = new AbortController();
  let ticks = 0;
  const looping = make({ checkMs: 1, initialDelayMs: 0, sleep: async () => { if ((ticks += 1) >= 3) controller.abort(); } });
  await looping.start(controller.signal);   // vòng nền: lỗi mạng chỉ ghi log, không ném ra
  assert.ok(ticks >= 3);
});

test("Bộ đo chữ được làm lại (đổi font) thì đo sẵn lại toàn bộ", async () => {
  const { textCache, make } = setup(NAMES);
  const catalog = make();
  await catalog.refresh();
  await catalog.warm();
  const changedFont = async (cfg, texts, sizes, options = {}) => {
    const table = (list, sz) => new Map(list.map((text) => [text, new Map(sz.map((size) => [size, text.length * size * 0.6]))]));
    return Object.assign(table(texts, sizes), { extra: (options.extra || []).map((group) => table(group.texts, group.sizes)) });
  };
  await textCache.validate(changedFont, {});
  assert.equal(await catalog.warm(), 5, "generation đổi → đo lại hết");
});
