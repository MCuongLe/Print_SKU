const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("extension/inside-po-connector/sku-sync-core.js", "utf8");
const context = { Intl, Date, Object, String, Number, RegExp };
context.globalThis = context;
vm.runInNewContext(source, context);
const core = context.HasakiSkuSyncCore;

assert.deepEqual(
  JSON.parse(JSON.stringify(core.parseComboDescription("Combo 422531838=422522004x5000000"))),
  { comboSku: "422531838", normalSku: "422522004", quantity: 5000000 }
);
assert.deepEqual(
  JSON.parse(JSON.stringify(core.parseComboDescription("Combo A-01 = B-02 × 1,250"))),
  { comboSku: "A-01", normalSku: "B-02", quantity: 1250 }
);
assert.deepEqual(
  JSON.parse(JSON.stringify(core.parseComboDescriptions("Combo 422531687=422513490+422513485x2"))),
  [
    { comboSku: "422531687", normalSku: "422513490", quantity: 1 },
    { comboSku: "422531687", normalSku: "422513485", quantity: 2 }
  ]
);
assert.equal(core.parseComboDescription("không có quan hệ"), null);
assert.equal(core.statusCode(" Active "), "1");
assert.equal(core.statusCode("In-Active"), "0");
assert.match(core.cutoffKey("2026-10-07T01:02:03+07:00"), /^26-10-07 01:02:03$/);

const manifest = JSON.parse(fs.readFileSync("extension/inside-po-connector/manifest.json", "utf8"));
assert.equal(manifest.version, "0.3.1");
assert.deepEqual(manifest.content_scripts[1].js, ["sku-sync-core.js", "inside-bridge.js"]);
console.log("sku_sync_extension: ok");
