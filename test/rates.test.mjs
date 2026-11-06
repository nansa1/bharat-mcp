import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gstRatesForCode, gstRatesForProduct, plausibleRates } from "../dist/rates.js";
import { createInvoice } from "../dist/invoice.js";
import { gstinChecksum } from "../dist/gst.js";

const data = JSON.parse(readFileSync(new URL("../data/gst_rates.json", import.meta.url), "utf8"));
const hsn = JSON.parse(readFileSync(new URL("../data/hsn_sac.json", import.meta.url), "utf8"));
const rateOf = (code, words) => gstRatesForCode(code, { limit: 40 }).candidates.find((c) => !words || new RegExp(words, "i").test(c.description));

test("data: provenance, schedules, structure", () => {
  const ids = data.sources.map((s) => s.gazette_id);
  for (const id of ["CG-DL-E-17092025-266209", "CG-DL-E-17092025-266211", "CG-DL-E-17092025-266210", "CG-DL-E-31122025-268978", "CG-DL-E-01052026-272190", "CG-DL-E-27102026-277454"]) assert.ok(ids.includes(id), id);
  assert.deepEqual(data.schedule_rates, { I: 5, II: 18, III: 40, IV: 3, V: 0.25, VI: 1.5, Exempt: 0 });
  const count = (s) => data.entries.filter((e) => e.schedule === s).length;
  assert.equal(count("I"), 517); assert.equal(count("II"), 641); assert.equal(count("III"), 19); assert.equal(count("Exempt"), 173);
  assert.equal(count("VII"), 0, "Schedule VII was omitted from 1 Feb 2026");
  assert.equal(data.omitted.length, 6);
  for (const e of data.entries) {
    assert.equal(e.gst, e.cgst + e.sgst_utgst, e.ref); assert.equal(e.igst, e.gst, e.ref);
    assert.equal(e.gst, data.schedule_rates[e.schedule], e.ref);
    assert.ok(e.description.length > 2, e.ref);
  }
});

test("data: every code in the rate schedules is an official HSN code", () => {
  const known = new Set(hsn.goods.map(([c]) => c));
  const unknown = [...new Set(data.entries.flatMap((e) => [...e.codes, ...e.except]))].filter((c) => !known.has(c));
  assert.deepEqual(unknown, []);
});

// Rates checked against the notifications and the GST Council press releases
const CASES = [
  ["04059020", null, 5, "ghee"],
  ["0406", "chena or paneer", 0, "paneer exempt"],
  ["0406", "other than chena", 5, "cheese"],
  ["0401", null, 0, "fresh milk exempt"],
  ["2523", null, 18, "cement"],
  ["8415", "Air-conditioning", 18, "AC"],
  ["8528", "Television", 18, "TV"],
  ["7113", "jewellery", 3, "gold jewellery"],
  ["33074100", "Agarbatti", 5, "agarbatti"],
  ["21069020", "Pan masala", 40, "pan masala moved to 40% (19/2025)"],
  ["24021000", null, 40, "cigarettes 40%"],
  ["24031921", "Biris", 18, "biris 18% (19/2025)"],
  ["40121010", "Retreaded tractor", 5, "retreaded tractor tyres 5% (02/2026)"],
  ["12119013", "Psyllium", 0, "psyllium exempt (03/2026)"],
  ["9619", "Sanitary", 0, "sanitary pads exempt"],
];
for (const [code, words, rate, label] of CASES) {
  test(`rate: ${label}`, () => {
    const c = rateOf(code, words);
    assert.ok(c, `no entry for ${code} ${words ?? ""}`);
    assert.equal(c.gst_rate, rate);
    assert.match(c.entry, /\/20(25|26)-Central Tax \(Rate\)/);
  });
}

test("amendments are applied and recorded", () => {
  const pan = rateOf("21069020", "Pan masala");
  assert.match(pan.amended_by[0], /19\/2025-CTR \(from 2026-02-01\)/);
  const bev = data.entries.find((e) => e.ref === "09/2025-CTR Sch I S.No 151");
  assert.deepEqual(bev.codes, ["22029931", "22029939"]);
  assert.equal(bev.amended_by[0].by, "01/2026-CTR");
  const tyres = data.entries.find((e) => e.ref === "09/2025-CTR Sch II S.No 138");
  assert.match(tyres.description, /other than retreaded tractor tyres/);
  assert.match(tyres.amended_by[0].previous, /Retreaded or used pneumatic tyres/);
});

test("code lookup: possible rates, special-purpose entries, residual entry, services", () => {
  const phone = gstRatesForCode("85171300");
  assert.deepEqual(phone.possible_rates, [18]);
  assert.ok(phone.special_purpose_entries.length > 0);
  const toys = gstRatesForCode("95030010");
  assert.deepEqual(toys.possible_rates, [5, 18]);
  assert.match(toys.how_to_choose, /Several entries/);
  // a heading with no specific entry falls back to the residual 18% entry of Schedule II
  const known = new Set(data.entries.flatMap((e) => e.codes));
  const free = hsn.goods.map(([c]) => c).find((c) => c.length === 4 && !c.startsWith("99") && ![...known].some((k) => c.startsWith(k) || k.startsWith(c)));
  if (free) {
    const r = gstRatesForCode(free);
    assert.ok(r.candidates.some((x) => /residual/.test(x.match) && x.gst_rate === 18), `residual for ${free}`);
  }
  assert.equal(gstRatesForCode("998314").services, true);
  assert.throws(() => gstRatesForCode("27"), /at least a 4-digit/);
  assert.throws(() => gstRatesForCode("abc"), /not an HSN code/);
});

test("product search finds entries by the notifications' own wording", () => {
  assert.equal(gstRatesForProduct("namkeen bhujia").candidates[0].gst_rate, 5);
  const puja = gstRatesForProduct("puja samagri rudraksha").candidates[0];
  assert.equal(puja.gst_rate, 0); assert.match(puja.description, /Rudraksha/);
  const drugs = gstRatesForProduct("drugs medicines Annexure I").candidates.find((c) => c.referenced_list);
  assert.ok(drugs && /Inclisiran/.test(drugs.referenced_list.text));
});

test("invoice warns when the GST rate doesn't match the notified rates", async () => {
  assert.deepEqual(plausibleRates("04059020"), [5]);
  const s = "29AAPFU0939F1Z";
  const r = await createInvoice({
    invoice_number: "R-1", supplier: { name: "A", address: "B", gstin: s + gstinChecksum(s) }, buyer: { name: "C", address: "D", state: "Karnataka" },
    items: [
      { description: "Ghee", hsn_sac: "04059020", quantity: 1, rate: 500, gst_rate: 5 },
      { description: "Ghee wrong", hsn_sac: "04059020", quantity: 1, rate: 500, gst_rate: 12 },
      { description: "Consulting", hsn_sac: "998314", quantity: 1, rate: 1000, gst_rate: 18 },
    ],
    output_dir: mkdtempSync(join(tmpdir(), "bharat-rate-")),
  });
  assert.equal(r.warnings.length, 1, r.warnings.join("\n"));
  assert.match(r.warnings[0], /12% does not match any rate notified for HSN 04059020 \(5%\)/);
});

test("MCP: find_gst_rate tool", async (t) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "ignore" }));
  t.after(() => client.close());
  const call = async (args) => { const r = await client.callTool({ name: "find_gst_rate", arguments: args }); return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };
  const ghee = await call({ hsn_code: "0405 90 20" });
  assert.deepEqual(ghee.possible_rates, [5]);
  assert.equal(ghee.source.in_force_as_of, data.in_force_as_of);
  const p = await call({ hsn_code: "0406", product: "paneer" });
  assert.match(p.candidates[0].description, /paneer/i); assert.equal(p.candidates[0].gst_rate, 0);
  assert.match((await call({})).error, /hsn_code or a product/);
});
