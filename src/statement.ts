// Loads a statement from CSV or PDF, and exports categorised transactions as CSV.
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, basename, extname, join, resolve } from "node:path";
import { parsePdfStatement, type PdfTxn } from "./pdf.js";
import { enrich, loadStatement as loadCsv } from "./upi.js";

export interface LoadedStatement {
  transactions: PdfTxn[];
  meta: Record<string, unknown>;
}

export async function loadStatementFile(path: string, opts: { password?: string; debug?: boolean } = {}): Promise<LoadedStatement> {
  const file = resolve(path.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  if (/\.pdf$/i.test(file)) {
    try {
      const r = await parsePdfStatement(file, opts);
      const { transactions, warnings, ...rest } = r;
      return {
        transactions,
        meta: { source: "pdf", ...rest, warnings: warnings.slice(0, 20), ...(warnings.length > 20 ? { more_warnings: warnings.length - 20 } : {}) },
      };
    } catch (e) {
      const preview = (e as { preview?: string[] }).preview;
      if (opts.debug && preview) {
        throw new Error(`${(e as Error).message}\n\nMasked layout (letters→x, digits→9; safe to share):\n${preview.join("\n")}`);
      }
      throw e;
    }
  }
  if (/\.(xlsx?|ods)$/i.test(file)) {
    throw new Error("Excel statements aren't supported yet. In Excel use File → Save As → CSV, or download the PDF or CSV version from net banking.");
  }
  const r = loadCsv(file);
  return { transactions: r.transactions, meta: { source: "csv", detected_columns: r.columns, skipped_rows: r.skipped_rows } };
}

const csvCell = (v: unknown) => {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function writeTransactionsCsv(txns: PdfTxn[], sourcePath: string, outputPath?: string): string {
  const src = resolve(sourcePath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  let out = outputPath ? resolve(outputPath.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")) : join(dirname(src), `${basename(src, extname(src))}_converted.csv`);
  if (!/\.csv$/i.test(out)) out = join(out, `${basename(src, extname(src))}_converted.csv`);
  mkdirSync(dirname(out), { recursive: true });
  const rows = enrich(txns);
  const header = ["Date", "Value Date", "Narration", "Reference", "Debit", "Credit", "Balance", "Category", "Payee", "UPI ID", "UPI App/Bank", "UPI Ref (RRN)"];
  const lines = [header.join(",")];
  rows.forEach((t, i) => {
    const src = txns[i];
    lines.push([
      t.date, src.value_date, t.narration, src.ref, t.debit || "", t.credit || "", t.balance,
      t.category, t.payee, t.upi?.vpa, t.upi?.psp_bank, t.upi?.rrn,
    ].map(csvCell).join(","));
  });
  writeFileSync(out, "﻿" + lines.join("\r\n") + "\r\n", "utf8"); // BOM so Excel reads ₹ and Hindi correctly
  return out;
}
