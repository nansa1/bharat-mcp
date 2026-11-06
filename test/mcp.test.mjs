// Talks to the real server over stdio using the official MCP client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Fake IFSC / PIN APIs so tests run offline
const mock = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/HDFC0000001") return res.end(JSON.stringify({ BANK: "HDFC Bank", BRANCH: "SANDOZ HOUSE", ADDRESS: "Worli", CITY: "MUMBAI", DISTRICT: "MUMBAI", STATE: "MAHARASHTRA", UPI: true, IMPS: true, NEFT: true, RTGS: true, MICR: "400240015" }));
  if (req.url === "/pincode/110001") return res.end(JSON.stringify([{ Status: "Success", PostOffice: [{ Name: "Connaught Place", BranchType: "Sub Post Office", DeliveryStatus: "Non-Delivery", District: "Central Delhi", State: "Delhi", Region: "Delhi", Division: "New Delhi Central", Block: "New Delhi" }] }]));
  res.statusCode = 404; res.end('"Not Found"');
});

test("MCP server end to end", async (t) => {
  await new Promise((r) => mock.listen(0, r));
  const base = `http://127.0.0.1:${mock.address().port}`;
  const outDir = mkdtempSync(join(tmpdir(), "bharat-"));
  const transport = new StdioClientTransport({
    command: "node", args: ["dist/index.js"],
    env: { ...process.env, BHARAT_MCP_IFSC_API: base, BHARAT_MCP_PINCODE_API: base, HTTPS_PROXY: "", HTTP_PROXY: "" },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  t.after(async () => { await client.close(); mock.close(); });

  const call = async (name, args) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
  };

  const tools = (await client.listTools()).tools.map((x) => x.name).sort();
  assert.deepEqual(tools, ["amount_in_words", "analyze_bank_statement", "calculate_gst", "convert_bank_statement", "create_gst_invoice", "find_gst_rate", "lookup_hsn_sac", "lookup_ifsc", "lookup_pincode", "parse_upi_narration", "search_hsn_sac", "validate_gstin"]);
  assert.equal((await client.listPrompts()).prompts[0].name, "monthly_money_review");

  assert.equal((await call("validate_gstin", { gstin: "27AAPFU0939F1ZV" })).data.valid, true);
  assert.equal((await call("amount_in_words", { amount: 250000 })).data.words, "Rupees Two Lakh Fifty Thousand Only");

  const inv = await call("create_gst_invoice", {
    invoice_number: "INV/2026-27/001",
    supplier: { name: "Untold Stories Studio", address: "12 MG Road, Bengaluru 560001", gstin: "29AAPFU0939F1ZR".slice(0, 14) + "X" },
    buyer: { name: "Acme Media Pvt Ltd", address: "Andheri East, Mumbai 400069", gstin: "27AAPFU0939F1ZV" },
    items: [{ description: "Video editing", hsn_sac: "998387", quantity: 10, unit: "Hrs", rate: 1500, gst_rate: 18 }],
    output_dir: outDir,
  });
  assert.equal(inv.isError, true, "bad supplier GSTIN must be rejected");
  assert.match(inv.data, /Supplier GSTIN is invalid/);

  const { gstinChecksum } = await import("../dist/gst.js");
  const sup = "29AAPFU0939F1Z"; const supplierGstin = sup + gstinChecksum(sup);
  const ok = await call("create_gst_invoice", {
    invoice_number: "INV/2026-27/001",
    invoice_date: "2026-11-04",
    supplier: { name: "Untold Stories Studio", address: "12 MG Road, Bengaluru 560001", gstin: supplierGstin, phone: "+91 98765 43210" },
    buyer: { name: "Acme Media Pvt Ltd", address: "Andheri East, Mumbai 400069", gstin: "27AAPFU0939F1ZV" },
    items: [
      { description: "Video editing", hsn_sac: "998387", quantity: 10, unit: "Hrs", rate: 1500, gst_rate: 18 },
      { description: "Voice-over recording", quantity: 1, rate: 4999.99, gst_rate: 18 },
    ],
    bank_details: { account_name: "Untold Stories Studio", bank: "HDFC Bank", account_number: "50100012345678", ifsc: "HDFC0000001", upi_id: "untold@hdfcbank" },
    notes: "Payment due within 15 days.",
    output_dir: outDir,
  });
  assert.ok(!ok.isError, ok.data);
  assert.equal(ok.data.supply_type, "inter-state");
  assert.equal(ok.data.totals.igst, 3600);
  assert.equal(ok.data.totals.grand_total, 23600);
  assert.ok(ok.data.warnings.some((w) => /HSN/.test(w)));
  assert.ok(existsSync(ok.data.file_path) && statSync(ok.data.file_path).size > 1000);
  console.log("invoice:", ok.data.file_path);

  const st = await call("analyze_bank_statement", { file_path: new URL("./fixtures/hdfc_sample.csv", import.meta.url).pathname });
  assert.equal(st.data.period.transactions, 14);
  const rows = await call("analyze_bank_statement", { transactions: [
    { date: "01/10/2026", narration: "UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment", debit: 300 },
    { date: "02/10/2026", narration: "SALARY", credit: 50000 },
  ] });
  assert.equal(rows.data.totals.spent, 300);

  assert.equal((await call("lookup_ifsc", { ifsc: "hdfc0000001" })).data.bank, "HDFC Bank");
  assert.equal((await call("lookup_ifsc", { ifsc: "HDFC0999999" })).data.found, false);
  assert.equal((await call("lookup_ifsc", { ifsc: "BAD" })).isError, true);
  assert.equal((await call("lookup_pincode", { pincode: "110001" })).data.district, "Central Delhi");
});
