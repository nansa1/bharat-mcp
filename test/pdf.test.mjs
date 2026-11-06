import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { makeAll, makeStatementPdf } from "./fixtures/make-statements.mjs";
import { parsePdfStatement, _internals } from "../dist/pdf.js";
import { loadStatementFile } from "../dist/statement.js";
import { analyse } from "../dist/upi.js";
import { createInvoice } from "../dist/invoice.js";
import { gstinChecksum } from "../dist/gst.js";

const dir = mkdtempSync(join(tmpdir(), "bharat-pdf-"));
let F;
before(async () => { F = await makeAll(dir); });

const iso = ([y, m, d]) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const strip = (s) => s.replace(/\s+/g, "");
const BANK = { sbi: "SBI", hdfc: "HDFC Bank", icici: "ICICI Bank", axis: "Axis Bank", kotak: "Kotak Mahindra Bank" };

for (const key of ["sbi", "hdfc", "icici", "axis", "kotak"]) {
  test(`PDF layout: ${key}`, async () => {
    const f = F[key];
    const r = await parsePdfStatement(f.file, { password: f.password });
    assert.equal(r.bank, BANK[key]);
    assert.equal(r.account_last4, "4821");
    assert.equal(r.order, f.newestFirst ? "newest_first" : "oldest_first");
    assert.equal(r.transactions.length, f.rows.length);
    r.transactions.forEach((t, i) => {
      const e = f.rows[i];
      assert.equal(t.date, iso(e.d), `row ${i + 1} date`);
      assert.equal(strip(t.narration), strip(e.narration), `row ${i + 1} narration`);
      assert.equal(t.narration, e.narration, `row ${i + 1} narration (exact)`);
      assert.equal(e.dir === "debit" ? t.debit : t.credit, e.amount, `row ${i + 1} amount`);
      assert.equal(e.dir === "debit" ? t.credit : t.debit, 0, `row ${i + 1} other side`);
      assert.equal(t.balance, e.balance, `row ${i + 1} balance`);
      assert.equal(t.ref, e.ref || undefined, `row ${i + 1} reference`);
    });
    assert.equal(r.opening_balance, f.opening);
    assert.equal(r.closing_balance, f.rows.at(-1).balance);
    assert.equal(r.reconciliation.mismatches.length, 0);
    assert.ok(r.reconciliation.matched >= f.rows.length - 1);
    assert.deepEqual(r.warnings, []);
  });
}

test("PDF statement feeds the analyser: categories and recurring payments", async () => {
  const r = await parsePdfStatement(F.hdfc.file);
  const a = analyse(r.transactions);
  const cats = Object.fromEntries(a.by_category.map((c) => [c.category, c.total]));
  assert.equal(cats["Rent & Housing"], 54000);
  assert.equal(cats["Loans & EMI"], 13500);
  assert.equal(cats["Cash Withdrawal"], 15000);
  assert.ok(a.recurring_payments.some((p) => p.payee === "Rahul Sharma"));
  assert.equal(a.totals.received, 85000 + 86000 + 87000 + 1200 + 1250 + 1300);
});

test("password handling", async () => {
  await assert.rejects(parsePdfStatement(F.sbi.file), /password-protected/);
  await assert.rejects(parsePdfStatement(F.sbi.file, { password: "wrong" }), /password is incorrect/);
});

test("missing row is caught by balance reconciliation", async () => {
  const f = await makeStatementPdf("hdfc", dir, { dropIndex: 10 });
  const r = await parsePdfStatement(f.file);
  assert.equal(r.transactions.length, f.rows.length - 1);
  assert.equal(r.reconciliation.mismatches.length, 1);
  assert.equal(r.reconciliation.mismatches[0].date, iso(f.rows[11].d));
  assert.match(r.reconciliation.verdict, /do not agree/);
});

test("non-statement PDF and scanned PDF give helpful errors", async () => {
  const s = "29AAPFU0939F1Z";
  const inv = await createInvoice({
    invoice_number: "T-1", supplier: { name: "A", address: "B", gstin: s + gstinChecksum(s) },
    buyer: { name: "C", address: "D", state: "Karnataka" }, items: [{ description: "x", hsn_sac: "9983", quantity: 1, rate: 100, gst_rate: 18 }], output_dir: dir,
  });
  await assert.rejects(parsePdfStatement(inv.file_path), /Couldn't find the transaction table/);
  await assert.rejects(loadStatementFile(inv.file_path, { debug: true }), (e) => /Masked layout/.test(e.message) && !/Karnataka/.test(e.message));

  const scan = join(dir, "scan.pdf");
  await new Promise((res) => { const d = new PDFDocument(); const st = createWriteStream(scan); st.on("finish", res); d.pipe(st); d.rect(50, 50, 200, 100).fill("#888"); d.end(); });
  await assert.rejects(parsePdfStatement(scan), /no text layer/);
});

test("text split into per-character / per-word fragments is rebuilt into cells", () => {
  const chars = [..."UPI/DR/4212/SWIGGY"].map((c, i) => ({ text: c, x0: 100 + i * 4, x1: 104 + i * 4, y: 200, h: 8 }));
  const words = [];
  for (const w of ["ACH", "D-", "BAJAJ", "FINANCE"]) { const x = words.length ? words.at(-1).x1 + 2.2 : 100; words.push({ text: w, x0: x, x1: x + w.length * 4.4, y: 220.4, h: 8 }); }
  const cells = [{ text: "05/08/26", x0: 36, x1: 68, y: 200, h: 8 }, { text: "452.00", x0: 400, x1: 425, y: 200.6, h: 8 }, { text: "1,01,548.00", x0: 470, x1: 515, y: 199.8, h: 8 }];
  const lines = _internals.groupLines([...chars, ...words, ...cells], 1).map((l) => l.segs.map((s) => s.text));
  assert.deepEqual(lines, [["05/08/26", "UPI/DR/4212/SWIGGY", "452.00", "1,01,548.00"], ["ACH D- BAJAJ FINANCE"]]);
});

test("header wording from different banks", () => {
  const r = _internals.roleOf;
  assert.equal(r("Withdrawal Amt."), "debit"); assert.equal(r("Deposit Amount (INR )"), "credit");
  assert.equal(r("Closing Balance"), "balance"); assert.equal(r("Chq./Ref.No."), "ref");
  assert.equal(r("Value Dt"), "value_date"); assert.equal(r("Txn Date"), "date"); assert.equal(r("Particulars"), "narration");
  assert.equal(r("Withdrawal (Dr)/ Deposit (Cr)"), "amount"); assert.equal(r("DR/CR"), "type"); assert.equal(r("Transaction Remarks"), "narration");
});

test("MCP: convert_bank_statement writes an Excel-ready CSV", async (t) => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], stderr: "ignore" }));
  t.after(() => client.close());
  const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text); };

  const locked = await call("convert_bank_statement", { file_path: F.sbi.file });
  assert.match(locked.error, /password-protected/);

  const out = join(dir, "exports");
  const r = await call("convert_bank_statement", { file_path: F.sbi.file, password: F.sbi.password, output_path: out });
  assert.equal(r.transactions, 36);
  assert.equal(r.statement.bank, "SBI");
  assert.equal(r.statement.reconciliation.mismatches.length, 0);
  assert.ok(existsSync(r.output_file) && r.output_file.startsWith(out));
  const csv = readFileSync(r.output_file, "utf8");
  assert.ok(csv.startsWith("﻿Date,Value Date,Narration"));
  assert.equal(csv.trim().split("\r\n").length, 37);
  assert.match(csv, /Rent & Housing,Rahul Sharma,rahul\.sharma@okaxis/);
  assert.match(csv, /,TO TRANSFER-UPI\/DR\/421234560000\/SWIGGY\/YESB\/swiggy@ybl\/Payment,/); // no stray space at the wrap
  assert.match(csv, /Salary & Income,Acme Tech Pvt Ltd,/);

  const a = await call("analyze_bank_statement", { file_path: F.icici.file });
  assert.equal(a.period.transactions, 36);
  assert.equal(a.statement.bank, "ICICI Bank");
});
