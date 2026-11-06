// GST tax invoice PDF generator (fields per CGST Rule 46).
import PDFDocument from "pdfkit";
import { createWriteStream, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isKnownHsnSac } from "./hsn.js";
import { plausibleRates } from "./rates.js";
import { calculateGst, formatINR, validateGstin, type LineItemInput, type TaxResult } from "./gst.js";

export interface Party {
  name: string;
  address: string;
  gstin?: string;
  state?: string; // needed when no GSTIN (e.g. unregistered buyer)
  phone?: string;
  email?: string;
}

export interface InvoiceInput {
  invoice_number: string;
  invoice_date?: string; // YYYY-MM-DD, defaults to today
  due_date?: string;
  supplier: Party;
  buyer: Party;
  ship_to?: Party;
  place_of_supply?: string; // defaults to buyer state / GSTIN state
  items: LineItemInput[];
  prices_include_gst?: boolean;
  reverse_charge?: boolean;
  notes?: string;
  bank_details?: { account_name?: string; account_number?: string; ifsc?: string; bank?: string; upi_id?: string };
  output_dir?: string;
}

export interface InvoiceOutput {
  file_path: string;
  warnings: string[];
  tax: TaxResult;
}

const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso: string) => {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
};

export async function createInvoice(input: InvoiceInput): Promise<InvoiceOutput> {
  const warnings: string[] = [];

  if (!/^[A-Za-z0-9/-]{1,16}$/.test(input.invoice_number)) {
    warnings.push("GST rules require the invoice number to be at most 16 characters using letters, digits, '/' or '-'.");
  }
  if (!input.supplier.gstin) throw new Error("Supplier GSTIN is required for a tax invoice.");
  const sg = validateGstin(input.supplier.gstin);
  if (!sg.valid) throw new Error(`Supplier GSTIN is invalid: ${sg.errors.join(" ")}`);
  if (input.buyer.gstin) {
    const bg = validateGstin(input.buyer.gstin);
    if (!bg.valid) throw new Error(`Buyer GSTIN is invalid: ${bg.errors.join(" ")}`);
  }
  for (const it of input.items) {
    if (!it.hsn_sac) warnings.push(`Item "${it.description}" has no HSN/SAC code; most registered businesses must show one.`);
    else {
      const code = it.hsn_sac.replace(/[\s.]/g, "");
      if (!/^\d{4,8}$/.test(code)) warnings.push(`Item "${it.description}": HSN/SAC "${it.hsn_sac}" should be 4, 6 or 8 digits.`);
      else if (!isKnownHsnSac(code)) warnings.push(`Item "${it.description}": HSN/SAC ${code} is not in the GST portal's official HSN/SAC list. Check it with lookup_hsn_sac.`);
      else {
        const rates = plausibleRates(code);
        if (rates && !rates.includes(it.gst_rate)) {
          warnings.push(`Item "${it.description}": GST rate ${it.gst_rate}% does not match any rate notified for HSN ${code} (${rates.map((r) => r + "%").join(", ")}). Check with find_gst_rate.`);
        }
      }
    }
  }

  const pos = input.place_of_supply ?? input.buyer.gstin ?? input.buyer.state;
  if (!pos) throw new Error("Provide place_of_supply, or the buyer's GSTIN or state.");
  const tax = calculateGst({
    supplier_state: input.supplier.gstin,
    place_of_supply: pos,
    items: input.items,
    prices_include_gst: input.prices_include_gst,
  });

  const outDir = resolve(input.output_dir ?? process.env.BHARAT_MCP_OUTPUT_DIR ?? join(homedir(), "bharat-mcp", "invoices"));
  mkdirSync(outDir, { recursive: true });
  const safe = input.invoice_number.replace(/[^A-Za-z0-9-]/g, "_");
  const file = join(outDir, `Invoice_${safe}.pdf`);

  await renderPdf(file, input, tax);
  return { file_path: file, warnings, tax };
}

function renderPdf(file: string, inv: InvoiceInput, tax: TaxResult): Promise<void> {
  return new Promise((done, fail) => {
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    const stream = createWriteStream(file);
    stream.on("finish", () => done());
    stream.on("error", fail);
    doc.pipe(stream);

    const L = 36, R = 559, W = R - L;
    const intra = tax.supply_type === "intra-state";
    const stateHead = tax.tax_heads[1] ?? "SGST";

    doc.font("Helvetica-Bold").fontSize(16).text("TAX INVOICE", L, 36, { width: W, align: "center" });
    doc.font("Helvetica").fontSize(8).fillColor("#555")
      .text("Original for Recipient", L, 56, { width: W, align: "center" }).fillColor("#000");

    // Supplier block
    let y = 76;
    doc.font("Helvetica-Bold").fontSize(12).text(inv.supplier.name, L, y);
    doc.font("Helvetica").fontSize(9).text(inv.supplier.address, L, doc.y, { width: 300 });
    doc.text(`GSTIN: ${inv.supplier.gstin}   State: ${tax.supplier_state}`);
    if (inv.supplier.phone || inv.supplier.email) doc.text([inv.supplier.phone, inv.supplier.email].filter(Boolean).join("  |  "));

    // Invoice meta (right)
    const meta: [string, string][] = [
      ["Invoice No.", inv.invoice_number],
      ["Invoice Date", fmtDate(inv.invoice_date ?? today())],
      ...(inv.due_date ? [["Due Date", fmtDate(inv.due_date)] as [string, string]] : []),
      ["Place of Supply", tax.place_of_supply],
      ["Reverse Charge", inv.reverse_charge ? "Yes" : "No"],
    ];
    let my = y;
    for (const [k, v] of meta) {
      doc.font("Helvetica-Bold").fontSize(9).text(k, 360, my, { width: 80 });
      doc.font("Helvetica").text(v, 440, my, { width: 119 });
      my += 13;
    }

    y = Math.max(doc.y, my) + 10;
    doc.moveTo(L, y).lineTo(R, y).stroke();
    y += 6;

    const party = (title: string, p: Party, x: number) => {
      doc.font("Helvetica-Bold").fontSize(9).text(title, x, y);
      doc.font("Helvetica-Bold").text(p.name, x, doc.y, { width: 250 });
      doc.font("Helvetica").text(p.address, { width: 250 });
      if (p.gstin) doc.text(`GSTIN: ${p.gstin}`);
      else doc.text("Unregistered");
      if (p.state) doc.text(`State: ${p.state}`);
      return doc.y;
    };
    const y1 = party("Bill To", inv.buyer, L);
    const y2 = party("Ship To", inv.ship_to ?? inv.buyer, 310);
    y = Math.max(y1, y2) + 10;

    // Items table
    const cols = intra
      ? [["#", 18], ["Description", 118], ["HSN/SAC", 46], ["Qty", 38], ["Rate", 52], ["Taxable", 58], ["GST%", 30], ["CGST", 50], [stateHead, 50], ["Total", 0]]
      : [["#", 18], ["Description", 140], ["HSN/SAC", 50], ["Qty", 42], ["Rate", 56], ["Taxable", 64], ["GST%", 32], ["IGST", 56], ["Total", 0]];
    // last column absorbs remaining width
    const used = cols.slice(0, -1).reduce((a, c) => a + (c[1] as number), 0);
    (cols[cols.length - 1] as [string, number])[1] = W - used;

    const drawRow = (cells: string[], bold = false, fill?: string) => {
      const h = Math.max(...cells.map((c, i) => doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8)
        .heightOfString(c, { width: (cols[i][1] as number) - 6 }))) + 8;
      if (y + h > 780) { doc.addPage(); y = 36; }
      if (fill) doc.rect(L, y, W, h).fill(fill).fillColor("#000");
      let x = L;
      cells.forEach((c, i) => {
        const w = cols[i][1] as number;
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8)
          .text(c, x + 3, y + 4, { width: w - 6, align: i <= 2 ? "left" : "right" });
        x += w;
      });
      y += h;
      doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor("#bbb").stroke().strokeColor("#000").lineWidth(1);
    };

    drawRow(cols.map((c) => c[0] as string), true, "#eef2f7");
    tax.lines.forEach((l, i) => {
      const qty = `${l.quantity}${l.unit ? " " + l.unit : ""}`;
      const base = [String(i + 1), l.description, l.hsn_sac ?? "", qty, formatINR(l.rate), formatINR(l.taxable_value), `${l.gst_rate}%`];
      const taxes = intra ? [formatINR(l.cgst), formatINR(l.sgst + l.utgst)] : [formatINR(l.igst)];
      drawRow([...base, ...taxes, formatINR(l.total)]);
    });

    // Totals
    y += 8;
    const t = tax.totals;
    const totals: [string, string][] = [["Taxable Value", formatINR(t.taxable_value)]];
    if (intra) {
      totals.push(["CGST", formatINR(t.cgst)], [stateHead, formatINR(t.sgst + t.utgst)]);
    } else totals.push(["IGST", formatINR(t.igst)]);
    if (t.cess) totals.push(["Cess", formatINR(t.cess)]);
    if (t.round_off) totals.push(["Round Off", formatINR(t.round_off)]);
    totals.push(["Grand Total (Rs.)", formatINR(t.grand_total)]);
    if (y + totals.length * 14 + 80 > 800) { doc.addPage(); y = 36; }
    const ty = y;
    totals.forEach(([k, v], i) => {
      const last = i === totals.length - 1;
      doc.font(last ? "Helvetica-Bold" : "Helvetica").fontSize(last ? 10 : 9)
        .text(k, 360, y, { width: 110 }).text(v, 470, y, { width: 89, align: "right" });
      y += 14;
    });

    doc.font("Helvetica-Bold").fontSize(9).text("Amount in words:", L, ty, { width: 300 });
    doc.font("Helvetica").text(tax.amount_in_words, { width: 300 });
    if (inv.reverse_charge) doc.text("Tax is payable on reverse charge basis.", { width: 300 });

    const b = inv.bank_details;
    if (b) {
      doc.moveDown(0.6).font("Helvetica-Bold").text("Bank Details", { width: 300 }).font("Helvetica");
      if (b.account_name) doc.text(`A/c Name: ${b.account_name}`);
      if (b.bank) doc.text(`Bank: ${b.bank}`);
      if (b.account_number) doc.text(`A/c No.: ${b.account_number}`);
      if (b.ifsc) doc.text(`IFSC: ${b.ifsc}`);
      if (b.upi_id) doc.text(`UPI: ${b.upi_id}`);
    }
    if (inv.notes) doc.moveDown(0.6).font("Helvetica-Bold").text("Notes", { width: 300 }).font("Helvetica").text(inv.notes, { width: 300 });

    y = Math.max(y, doc.y) + 30;
    if (y > 770) { doc.addPage(); y = 60; }
    doc.font("Helvetica").fontSize(9).text(`For ${inv.supplier.name}`, 360, y, { width: 199, align: "right" });
    doc.text("Authorised Signatory", 360, y + 36, { width: 199, align: "right" });
    doc.fontSize(7).fillColor("#888").text("Generated with bharat-mcp", L, 790, { width: W, align: "center", lineBreak: false });

    doc.end();
  });
}
