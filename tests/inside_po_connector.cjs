const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const extensionDir = path.resolve(__dirname, "..", "extension", "inside-po-connector");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, "0.6.0");
assert.ok(manifest.content_scripts.some(entry => entry.js.includes("inventory-audit-core.js")));
for (const type of ["GET_SKU_COUNT_WAREHOUSES", "GET_SKU_COUNT_APPROVED_PAGE", "GET_SKU_COUNT_INVENTORY_PAGE"]) assert.match(background, new RegExp(type));

const appMatches = manifest.content_scripts.find(entry => entry.js.includes("app-bridge.js"))?.matches || [];
assert.ok(appMatches.includes("http://localhost/*"));
assert.ok(appMatches.includes("http://127.0.0.1/*"));
assert.ok(appMatches.includes("https://mcuongle.github.io/Print_SKU/*"));

const patternLine = background.match(/^const APP_URL_PATTERN = .*;$/m)?.[0];
assert.ok(patternLine, "Không tìm thấy APP_URL_PATTERN");
const sandbox = { result: null };
vm.runInNewContext(`${patternLine}\nresult = APP_URL_PATTERN;`, sandbox);

assert.equal(sandbox.result.test("http://localhost:8000/#inspection"), true);
assert.equal(sandbox.result.test("http://127.0.0.1:8000/#inspection"), true);
assert.equal(sandbox.result.test("https://mcuongle.github.io/Print_SKU/#inspection"), true);
assert.equal(sandbox.result.test("https://evil.example/Print_SKU/#inspection"), false);
assert.equal(sandbox.result.test("https://mcuongle.github.io/Other_App/#inspection"), false);

console.log("inside_po_connector: manifest and allowed origins passed");
