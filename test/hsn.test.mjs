import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchHsnSac, lookupHsnSac, isKnownHsnSac, hsnSource } from "../dist/hsn.js";
import { createInvoice } from "../dist/invoice.js";
import { gstinChecksum } from "../dist/gst.js";

const data = JSON.parse(readFileSync(new URL("../data/hsn_sac.json", import.meta.url), "utf8"));

test("data file matches the official master it was built from", () => {
  assert.equal(data.source.url, "https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx");
  assert.match(data.source.sha256, /^[0-9a-f]{64}$/);
  assert.equal(data.goods.length, data.source.hsn_codes);
  assert.equal(data.services.length, data.source.sac_codes);
  assert.ok(data.goods.length > 20000 && data.services.length > 600);
  const codes = new Set();
  for (const [c, parts] of data.goods) { assert.match(c, /^(\d{2}|\d{4}|\d{6}|\d{8})$/); assert.ok(parts.length && parts.every((p) => p && !/_x000D_/.test(p))); codes.add(c); }
  for (const [c] of data.services) { assert.match(c, /^99(\d{2}){0,2}$/); codes.add(c); }
  assert.equal(codes.size, data.goods.length + data.services.length, "codes are unique");
  for (const [orig, fixed] of data.fixes) { assert.ok(codes.has(fixed)); assert.ok(!codes.has(orig.replace(/\s/g, "")) || orig.replace(/\s/g, "") === fixed); }
  assert.deepEqual(hsnSource(), data.source);
});

const EXPECT = {
  laptop: "847130", ghee: "04059020", "basmati rice": "100630", "led bulb": "853950", agarbatti: "330741",
  "chartered accountant services": "99822", "software development": "998314", "hotel stay": "996311",
  "gold jewellery": "7113", atta: "1101", "tyres for car": "4011", "air conditioner": "8415", dal: "0713",
  "silver jewellery": "7113", cement: "2523",
};
for (const [q, prefix] of Object.entries(EXPECT)) {
  test(`search: "${q}" finds ${prefix}`, () => {
    const r = searchHsnSac(q, { limit: 3 });
    assert.ok(r.results.some((x) => x.code.startsWith(prefix)), r.results.map((x) => x.code).join(","));
  });
}

test("every everyday-name synonym finds official codes", () => {
  const src = readFileSync(new URL("../src/hsn.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("const SYNONYMS"), src.indexOf("};", src.indexOf("const SYNONYMS")));
  const keys = [...block.matchAll(/^\s+(\w+):/gm)].map((m) => m[1].replace(/_/g, " "));
  assert.ok(keys.length > 25);
  for (const k of keys) {
    const r = searchHsnSac(k, { limit: 1 });
    assert.ok(r.results.length && r.results[0].matched_all_words, `synonym "${k}" found nothing`);
  }
});

test("search filters by type and by code prefix", () => {
  assert.ok(searchHsnSac("accounting", { type: "services" }).results.every((x) => x.code.startsWith("99")));
  assert.ok(searchHsnSac("cheese", { type: "goods" }).results.every((x) => !x.code.startsWith("99")));
  const p = searchHsnSac("8471", { limit: 50 });
  assert.equal(p.match_type, "code_prefix");
  assert.ok(p.results.every((x) => x.code.startsWith("8471")));
});

test("no invented matches for words not in the official list", () => {
  const r = searchHsnSac("namkeen");
  assert.equal(r.results.length, 0);
  assert.match(r.note, /partial|No code matches/);
});

test("code lookup: hierarchy, sub-codes, unknown codes and formatting", () => {
  const h = lookupHsnSac("8517");
  assert.equal(h.found, true); assert.equal(h.level, "heading"); assert.equal(h.within[0].code, "85");
  assert.ok(h.sub_codes.some((x) => x.code === "851713"));
  assert.match(h.invoice_guidance, /4 digits.*₹5 crore/);
  assert.equal(lookupHsnSac("0405 90 20").code, "04059020");
  assert.equal(lookupHsnSac("998314").type, "SAC (services)");
  const miss = lookupHsnSac("85171399");
  assert.equal(miss.found, false); assert.equal(miss.nearest_parent.code, "851713");
  assert.throws(() => lookupHsnSac("abc"), /not an HSN\/SAC code/);
  assert.equal(isKnownHsnSac("8471 30"), true); assert.equal(isKnownHsnSac("99999999"), false);
});

test("invoice warns about HSN/SAC codes that aren't in the official list", async () => {
  const s = "29AAPFU0939F1Z";
  const r = await createInvoice({
    invoice_number: "H-1", supplier: { name: "A", address: "B", gstin: s + gstinChecksum(s) }, buyer: { name: "C", address: "D", state: "Karnataka" },
    items: [
      { description: "Ghee", hsn_sac: "0405 90 20", quantity: 1, rate: 500, gst_rate: 5 },
      { description: "Typo", hsn_sac: "04059099", quantity: 1, rate: 100, gst_rate: 5 },
      { description: "Short", hsn_sac: "04", quantity: 1, rate: 100, gst_rate: 5 },
    ],
    output_dir: mkdtempSync(join(tmpdir(), "bharat-hsn-")),
  });
  assert.equal(r.warnings.length, 2, r.warnings.join("\n"));
  assert.match(r.warnings[0], /04059099 is not in the GST portal's official HSN\/SAC list/);
  assert.match(r.warnings[1], /should be 4, 6 or 8 digits/);
});

test("search is fast enough for interactive use", () => {
  searchHsnSac("warm up");
  const t = Date.now();
  for (const q of ["laptop", "ghee", "cotton saree", "software development", "tyres for car"]) searchHsnSac(q);
  assert.ok(Date.now() - t < 1500, `5 searches took ${Date.now() - t}ms`);
});
