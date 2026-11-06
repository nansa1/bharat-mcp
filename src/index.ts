#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { amountInWords, calculateGst, validateGstin } from "./gst.js";
import { createInvoice } from "./invoice.js";
import { analyse, parseIndianDate, parseUpiNarration } from "./upi.js";
import { loadStatementFile, writeTransactionsCsv } from "./statement.js";

// stdout carries the MCP protocol; route any stray library logging to stderr
console.log = console.error;
console.info = console.error;
console.warn = console.error;
import { lookupIfsc, lookupPincode } from "./lookup.js";
import { lookupHsnSac, searchHsnSac } from "./hsn.js";
import { gstRatesForCode, gstRatesForProduct } from "./rates.js";

const VERSION = "0.4.0";
const server = new McpServer({ name: "bharat-mcp", version: VERSION });

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });
async function run<T>(fn: () => T | Promise<T>) {
  try { return json(await fn()); } catch (e) { return fail(e); }
}

const readOnlyLocal = { readOnlyHint: true, openWorldHint: false, idempotentHint: true };
const readOnlyWeb = { readOnlyHint: true, openWorldHint: true, idempotentHint: true };

// ---------------- GST ----------------

const lineItem = z.object({
  description: z.string().describe("Item or service description"),
  hsn_sac: z.string().optional().describe("HSN code (goods) or SAC code (services)"),
  quantity: z.number().positive(),
  unit: z.string().optional().describe("Unit, e.g. Nos, Kg, Hrs"),
  rate: z.number().nonnegative().describe("Price per unit in rupees"),
  gst_rate: z.number().min(0).max(100).describe("GST rate in percent, e.g. 5, 18, 40"),
  discount: z.number().nonnegative().optional().describe("Flat discount in rupees for this line"),
  cess_rate: z.number().min(0).optional().describe("Compensation cess in percent, if any"),
});

server.registerTool("validate_gstin", {
  title: "Validate GSTIN",
  description: "Check whether an Indian GSTIN is valid (format, state code and checksum) and decode its state, PAN and entity type. Works offline; it does not confirm the registration is active on the GST portal.",
  inputSchema: { gstin: z.string().describe("15-character GSTIN, e.g. 27AAPFU0939F1ZV") },
  annotations: readOnlyLocal,
}, ({ gstin }) => run(() => validateGstin(gstin)));

server.registerTool("calculate_gst", {
  title: "Calculate GST",
  description: "Calculate GST for one or more line items. Works out intra-state (CGST+SGST, or CGST+UTGST in UTs) vs inter-state (IGST) from the supplier state and place of supply, handles GST-inclusive prices, cess and round-off, and gives the total in words.",
  inputSchema: {
    supplier_state: z.string().describe("Supplier's state name, 2-digit state code, or GSTIN"),
    place_of_supply: z.string().describe("Place of supply: state name, 2-digit code, or buyer GSTIN"),
    items: z.array(lineItem).min(1),
    prices_include_gst: z.boolean().optional().describe("True if the rates already include GST (back-calculate tax)"),
    round_off: z.boolean().optional().describe("Round grand total to the nearest rupee (default true)"),
  },
  annotations: readOnlyLocal,
}, (args) => run(() => calculateGst(args)));

const party = z.object({
  name: z.string(),
  address: z.string(),
  gstin: z.string().optional(),
  state: z.string().optional().describe("State name; needed if the party has no GSTIN"),
  phone: z.string().optional(),
  email: z.string().optional(),
});

server.registerTool("create_gst_invoice", {
  title: "Create GST invoice PDF",
  description: "Generate a GST-compliant tax invoice as a PDF on the user's computer (supplier and buyer details, HSN/SAC, tax split, place of supply, reverse charge, amount in words, bank/UPI details). Returns the file path and the tax breakdown. Ask the user for any missing supplier or buyer details instead of inventing them.",
  inputSchema: {
    invoice_number: z.string().describe("Unique invoice number, max 16 chars (letters, digits, / or -)"),
    invoice_date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
    due_date: z.string().optional().describe("YYYY-MM-DD"),
    supplier: party.describe("Seller; GSTIN required"),
    buyer: party,
    ship_to: party.optional(),
    place_of_supply: z.string().optional().describe("Defaults to the buyer's GSTIN state or state"),
    items: z.array(lineItem).min(1),
    prices_include_gst: z.boolean().optional(),
    reverse_charge: z.boolean().optional(),
    notes: z.string().optional().describe("Payment terms or other notes"),
    bank_details: z.object({
      account_name: z.string().optional(), account_number: z.string().optional(), ifsc: z.string().optional(),
      bank: z.string().optional(), upi_id: z.string().optional(),
    }).optional(),
    output_dir: z.string().optional().describe("Folder to save the PDF in (default ~/bharat-mcp/invoices)"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, (args) => run(async () => {
  const r = await createInvoice(args);
  return { file_path: r.file_path, warnings: r.warnings, supply_type: r.tax.supply_type, totals: r.tax.totals, amount_in_words: r.tax.amount_in_words };
}));

server.registerTool("search_hsn_sac", {
  title: "Search HSN/SAC codes",
  description: "Find HSN codes (goods) or SAC codes (services) from the GST portal's official HSN/SAC master list, by everyday description (\"laptop\", \"ghee\", \"CA services\") or by code prefix. Works offline. Returns official descriptions with their chapter and heading. For the GST rate of goods, pass the code to find_gst_rate. Choosing the right classification is the user's responsibility: show the candidates, explain the differences, and suggest confirming with their CA when it is unclear.",
  inputSchema: {
    query: z.string().describe("Product/service description, or a code prefix such as 8471"),
    type: z.enum(["goods", "services", "any"]).optional().describe("Limit to goods (HSN) or services (SAC). Default: any"),
    limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
  },
  annotations: readOnlyLocal,
}, (args) => run(() => searchHsnSac(args.query, args)));

server.registerTool("lookup_hsn_sac", {
  title: "Look up an HSN/SAC code",
  description: "Check whether an HSN or SAC code exists in the GST portal's official list, and get its description, the chapter and heading it sits in, and its sub-codes. For a code that isn't listed, returns the nearest valid parent code and its sub-codes. Works offline. For the GST rate, use find_gst_rate.",
  inputSchema: { code: z.string().describe("2-8 digit HSN or SAC code, e.g. 0405, 847130, 998314") },
  annotations: readOnlyLocal,
}, ({ code }) => run(() => lookupHsnSac(code)));

server.registerTool("find_gst_rate", {
  title: "Find the GST rate for goods",
  description: "Official GST rates for goods, from the Gazette of India: Notification 09/2025-Central Tax (Rate) (rate schedules) and 10/2025-Central Tax (Rate) (exemptions), with every amendment up to the latest checked date applied (e.g. tobacco to 40% from 1 Feb 2026, psyllium exempt from 1 Nov 2026). Give an HSN code (4-8 digits) to get every entry that covers it, with the rate, CGST/SGST/IGST split, the notification and serial number, and the entry's exact wording; or give a product description to search the notifications' own wording. Several entries can cover one code with different rates: explain the conditions to the user rather than picking silently. Services (SAC 99xxxx) are not covered yet. Works offline.",
  inputSchema: {
    hsn_code: z.string().optional().describe("HSN code of the goods, 4-8 digits, e.g. 0406 or 21069020"),
    product: z.string().optional().describe("What is being sold, e.g. 'paneer', 'namkeen', 'retreaded tractor tyres'. With hsn_code, used to rank the matching entries"),
    limit: z.number().int().min(1).max(40).optional(),
  },
  annotations: readOnlyLocal,
}, (args) => run(() => {
  if (args.hsn_code) return gstRatesForCode(args.hsn_code, { product: args.product, limit: args.limit });
  if (args.product) return gstRatesForProduct(args.product, { limit: args.limit });
  throw new Error("Give an hsn_code or a product description.");
}));

server.registerTool("amount_in_words", {
  title: "Amount in words (Indian)",
  description: "Convert a rupee amount to words in the Indian numbering system (lakh, crore), as used on invoices and cheques.",
  inputSchema: { amount: z.number().nonnegative() },
  annotations: readOnlyLocal,
}, ({ amount }) => run(() => ({ amount, words: amountInWords(amount) })));

// ---------------- Banking / UPI ----------------

server.registerTool("parse_upi_narration", {
  title: "Parse UPI narration",
  description: "Decode bank-statement UPI narrations (e.g. 'UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment') into payee, VPA, app/bank, UTR/RRN reference and direction. Accepts up to 500 lines at once.",
  inputSchema: { narrations: z.array(z.string()).min(1).max(500) },
  annotations: readOnlyLocal,
}, ({ narrations }) => run(() => narrations.map((n) => ({ narration: n, ...parseUpiNarration(n) }))));

const txn = z.object({
  date: z.string().describe("Transaction date (YYYY-MM-DD or DD/MM/YYYY)"),
  narration: z.string(),
  debit: z.number().nonnegative().optional().describe("Money out"),
  credit: z.number().nonnegative().optional().describe("Money in"),
  balance: z.number().optional(),
});

const passwordParam = z.string().optional().describe("PDF password, if the statement is password-protected. Ask the user; never guess it.");

server.registerTool("analyze_bank_statement", {
  title: "Analyse bank statement",
  description: "Analyse an Indian bank statement locally: spending by category (food delivery, groceries, travel, bills, EMI, investments...), month-by-month in/out, top payees, largest spends, recurring payments and subscriptions, and UPI usage. Provide `file_path` to a PDF or CSV statement from net banking (SBI, HDFC, ICICI, Axis, Kotak and other layouts are detected automatically; password-protected PDFs need `password`), or pass `transactions` directly. Every PDF row is checked against the running balance. Data never leaves the computer.",
  inputSchema: {
    file_path: z.string().optional().describe("Path to a PDF or CSV statement"),
    password: passwordParam,
    transactions: z.array(txn).optional().describe("Rows to analyse if there is no readable file (e.g. a scanned statement you read yourself)"),
    from: z.string().optional().describe("Only include transactions on/after this date (YYYY-MM-DD)"),
    to: z.string().optional().describe("Only include transactions on/before this date (YYYY-MM-DD)"),
    top_n: z.number().int().min(1).max(50).optional(),
    include_transactions: z.boolean().optional().describe("Also return every transaction (can be long)"),
  },
  annotations: readOnlyLocal,
}, (args) => run(async () => {
  let txns;
  let meta: Record<string, unknown> = {};
  if (args.file_path) {
    const r = await loadStatementFile(args.file_path, { password: args.password });
    txns = r.transactions;
    meta = r.meta;
  } else if (args.transactions?.length) {
    txns = args.transactions.map((t, i) => {
      const date = parseIndianDate(t.date);
      if (!date) throw new Error(`Row ${i + 1}: cannot read date "${t.date}".`);
      return { date, narration: t.narration, debit: t.debit ?? 0, credit: t.credit ?? 0, balance: t.balance };
    });
  } else throw new Error("Provide either file_path or transactions.");
  const result = analyse(txns, args);
  return { statement: meta, ...result, ...(args.include_transactions ? { transactions: txns } : {}) };
}));

server.registerTool("convert_bank_statement", {
  title: "Convert bank statement to CSV/Excel",
  description: "Convert a PDF (or CSV) bank statement into a clean CSV that opens in Excel or Google Sheets: one row per transaction with date, narration, reference, debit, credit, balance, plus category, payee and decoded UPI details. Rows are checked against the running balance, and the result reports any that don't agree. Runs locally.",
  inputSchema: {
    file_path: z.string().describe("Path to the statement PDF or CSV"),
    password: passwordParam,
    output_path: z.string().optional().describe("Where to write the CSV (file or folder). Default: next to the statement, named *_converted.csv"),
    debug: z.boolean().optional().describe("If parsing fails, include a masked layout of the PDF (letters and digits hidden) that is safe to share in a bug report"),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
}, (args) => run(async () => {
  const r = await loadStatementFile(args.file_path, { password: args.password, debug: args.debug });
  if (!r.transactions.length) throw new Error("No transactions found in the statement.");
  const out = writeTransactionsCsv(r.transactions, args.file_path, args.output_path);
  const t = r.transactions;
  return {
    output_file: out,
    transactions: t.length,
    period: { from: t.reduce((a, x) => (x.date < a ? x.date : a), t[0].date), to: t.reduce((a, x) => (x.date > a ? x.date : a), t[0].date) },
    total_debit: Math.round(t.reduce((a, x) => a + x.debit, 0) * 100) / 100,
    total_credit: Math.round(t.reduce((a, x) => a + x.credit, 0) * 100) / 100,
    statement: r.meta,
  };
}));

server.registerTool("lookup_ifsc", {
  title: "Look up IFSC",
  description: "Find the bank, branch, address, MICR and supported payment modes (UPI/IMPS/NEFT/RTGS) for an IFSC code.",
  inputSchema: { ifsc: z.string().describe("11-character IFSC, e.g. SBIN0000001") },
  annotations: readOnlyWeb,
}, ({ ifsc }) => run(() => lookupIfsc(ifsc)));

server.registerTool("lookup_pincode", {
  title: "Look up PIN code",
  description: "Find the district, state and post offices for an Indian 6-digit PIN code.",
  inputSchema: { pincode: z.string().describe("6-digit PIN code, e.g. 110001") },
  annotations: readOnlyWeb,
}, ({ pincode }) => run(() => lookupPincode(pincode)));

// ---------------- Prompts ----------------

server.registerPrompt("monthly_money_review", {
  title: "Monthly money review",
  description: "Review a bank statement and suggest where to save",
  argsSchema: { file_path: z.string().describe("Path to your statement PDF or CSV") },
}, ({ file_path }) => ({
  messages: [{
    role: "user",
    content: {
      type: "text",
      text: `Use analyze_bank_statement on ${file_path} (if it says the PDF is password-protected, ask me for the password). Then give me: (1) a one-paragraph summary of where my money went, (2) a table of spending by category, (3) subscriptions and recurring payments I might cancel, (4) three specific, realistic ways to save next month, with rupee estimates. Use Indian number formatting (lakh/crore).`,
    },
  }],
}));

async function main() {
  await server.connect(new StdioServerTransport());
  console.error(`bharat-mcp ${VERSION} running on stdio`);
}
main().catch((e) => { console.error(e); process.exit(1); });
