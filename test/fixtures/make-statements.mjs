// Generates synthetic bank statement PDFs in the layouts used by major Indian banks.
// All names, numbers and accounts are made up. Used by test/pdf.test.mjs.
import PDFDocument from "pdfkit";
import { createWriteStream } from "node:fs";
import { join } from "node:path";

const inr = (n) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n) => String(n).padStart(2, "0");

// ---- logical transactions (shared by all banks) ----
const MERCHANTS = [
  ["SWIGGY", "swiggy@ybl", "YESB", 452], ["ZOMATO", "zomato@hdfcbank", "HDFC", 389.5], ["BLINKIT", "blinkit.payu@axisbank", "UTIB", 1230.5],
  ["UBER INDIA", "uber.rides@icici", "ICIC", 312], ["NETFLIX COM", "netflixupi.payu@hdfcbank", "HDFC", 649], ["AMAZON PAY INDIA", "amazonpay@apl", "UTIB", 2499],
  ["JIO PREPAID", "jiorecharge@paytm", "PYTM", 349], ["ZEPTO", "zepto.payu@axisbank", "UTIB", 876.25], ["BOOKMYSHOW", "bookmyshow@icici", "ICIC", 720],
];
export function makeTxns() {
  const out = [];
  let seq = 0;
  const rrn = () => String(421234560000 + seq++ * 7919);
  for (const [mi, m] of [8, 9, 10].entries()) {
    out.push({ d: [2026, m, 1], kind: "salary", amount: 85000 + mi * 1000, dir: "credit" });
    for (let i = 0; i < 7; i++) {
      const [name, vpa, bank, amt] = MERCHANTS[(i + mi * 3) % MERCHANTS.length];
      out.push({ d: [2026, m, 2 + i * 3], kind: "upi_m", name, vpa, bank, rrn: rrn(), amount: amt + mi, dir: "debit" });
    }
    out.push({ d: [2026, m, 5], kind: "upi_p", name: "RAHUL SHARMA", vpa: "rahul.sharma@okaxis", bank: "UTIB", rrn: rrn(), amount: 18000, dir: "debit", note: `RENT ${MON[m - 1].toUpperCase()}` });
    out.push({ d: [2026, m, 10], kind: "emi", amount: 4500, dir: "debit" });
    out.push({ d: [2026, m, 15], kind: "atm", amount: 5000, dir: "debit" });
    out.push({ d: [2026, m, 18], kind: "upi_in", name: "PRIYA NAIR", vpa: "priya.nair@oksbi", bank: "SBIN", rrn: rrn(), amount: 1200 + mi * 50, dir: "credit" });
  }
  out.sort((a, b) => (a.d[1] - b.d[1]) || (a.d[2] - b.d[2]));
  let bal = 50000;
  for (const t of out) { bal = Math.round((bal + (t.dir === "credit" ? t.amount : -t.amount)) * 100) / 100; t.balance = bal; }
  return { opening: 50000, txns: out };
}

// ---- per-bank narration styles ----
const NARR = {
  sbi: (t) => ({
    salary: "BY TRANSFER-NEFT*CITI0000002*CITIN26123456*ACME TECH PVT LTD-SALARY",
    upi_m: `TO TRANSFER-UPI/DR/${t.rrn}/${t.name}/${t.bank}/${t.vpa}/Payment`,
    upi_p: `TO TRANSFER-UPI/DR/${t.rrn}/${t.name}/${t.bank}/${t.vpa}/${t.note}`,
    upi_in: `BY TRANSFER-UPI/CR/${t.rrn}/${t.name}/${t.bank}/${t.vpa}/UPI`,
    emi: "DEBIT-ACHDr BAJAJ FINANCE LTD EMI123456",
    atm: "ATM WDL-ATM CASH 1234 ANDHERI MUMBAI",
  })[t.kind],
  hdfc: (t) => ({
    salary: "NEFT CR-CITI0000002-ACME TECH PVT LTD-SALARY-CITIN26123456",
    upi_m: `UPI-${t.name}-${t.vpa}-${t.bank}0000100-${t.rrn}-PAYMENT FROM PHONE`,
    upi_p: `UPI-${t.name}-${t.vpa}-${t.bank}0000123-${t.rrn}-${t.note}`,
    upi_in: `UPI-${t.name}-${t.vpa}-${t.bank}0001234-${t.rrn}-UPI`,
    emi: "ACH D- BAJAJ FINANCE LTD-EMI123456",
    atm: "NWD-XXXXXX1234-ATM ANDHERI MUMBAI",
  })[t.kind],
  icici: (t) => ({
    salary: "NEFT-CITIN26123456-ACME TECH PVT LTD-SALARY",
    upi_m: `UPI/${t.rrn}/Payment/${t.vpa}/${t.name} BANK LTD/ICI1234`,
    upi_p: `UPI/${t.rrn}/${t.note}/${t.vpa}/AXIS BANK/ICI5678`,
    upi_in: `UPI/${t.rrn}/UPI/${t.vpa}/STATE BANK OF I/ICI9012`,
    emi: "ACH/BAJAJ FINANCE LTD/EMI123456",
    atm: "ATM/CASH WDL/ANDHERI MUMBAI/1234",
  })[t.kind],
  axis: (t) => ({
    salary: "NEFT/CITIN26123456/ACME TECH PVT LTD/SALARY",
    upi_m: `UPI/P2M/${t.rrn}/${t.name}/Payment/${t.bank}`,
    upi_p: `UPI/P2A/${t.rrn}/${t.name}/${t.note}/${t.bank}`,
    upi_in: `UPI/P2A/${t.rrn}/${t.name}/UPI/${t.bank}`,
    emi: "ACH-DR-BAJAJ FINANCE LTD-EMI123456",
    atm: "ATM-CASH-AXIS-ANDHERI MUMBAI",
  })[t.kind],
  kotak: (t) => ({
    salary: "NEFT ACME TECH PVT LTD SALARY CITIN26123456",
    upi_m: `UPI/${t.name}/${t.rrn}/UPI Payment ${t.vpa}`,
    upi_p: `UPI/${t.name}/${t.rrn}/${t.note} ${t.vpa}`,
    upi_in: `UPI/${t.name}/${t.rrn}/UPI ${t.vpa}`,
    emi: "NACH-DR-BAJAJ FINANCE LTD-EMI123456",
    atm: "ATL/1234/ATM ANDHERI MUMBAI",
  })[t.kind],
};

const DATE = {
  sbi: ([y, m, d]) => `${d} ${MON[m - 1]} ${y}`,
  hdfc: ([y, m, d]) => `${p2(d)}/${p2(m)}/${String(y).slice(2)}`,
  icici: ([y, m, d]) => `${p2(d)}/${p2(m)}/${y}`,
  axis: ([y, m, d]) => `${p2(d)}-${p2(m)}-${y}`,
  kotak: ([y, m, d]) => `${p2(d)}-${MON[m - 1]}-${y}`,
};

// ---- layouts ----
export const LAYOUTS = {
  sbi: {
    bank: "State Bank of India", password: "12345010190", style: "below", font: 7.5,
    cols: [["Txn Date", 52, "date"], ["Value Date", 52, "date"], ["Description", 160, "narr"], ["Ref No./Cheque No.", 78, "ref"], ["Debit", 58, "debit"], ["Credit", 58, "credit"], ["Balance", 65, "bal"]],
    openingLine: true,
  },
  hdfc: {
    bank: "HDFC BANK Ltd.", style: "below", font: 7, cutNarration: 30,
    cols: [["Date", 42, "date"], ["Narration", 168, "narr"], ["Chq./Ref.No.", 78, "ref"], ["Value Dt", 42, "date"], ["Withdrawal Amt.", 62, "debit"], ["Deposit Amt.", 62, "credit"], ["Closing Balance", 69, "bal"]],
  },
  icici: {
    bank: "ICICI Bank Limited", style: "centered", font: 7, rowGap: 7,
    cols: [["S No.", 22, "sno"], ["Value Date", 48, "date"], [["Transaction", "Date"], 48, "date"], [["Cheque", "Number"], 42, "ref"], ["Transaction Remarks", 150, "narr"], [["Withdrawal Amount", "(INR )"], 68, "debit"], [["Deposit Amount", "(INR )"], 68, "credit"], [["Balance", "(INR )"], 77, "bal"]],
  },
  axis: {
    bank: "AXIS BANK", style: "below", font: 7.5, newestFirst: true, balSuffix: "Cr",
    cols: [["Tran Date", 52, "date"], ["Particulars", 200, "narr"], ["Chq No", 60, "ref"], ["Amount", 66, "amount"], ["DR/CR", 34, "type"], ["Balance", 111, "bal"]],
  },
  kotak: {
    bank: "Kotak Mahindra Bank", style: "below", font: 7.5, amtSuffix: true, balSuffix: "(Cr)",
    cols: [["Date", 56, "date"], ["Narration", 190, "narr"], ["Chq/Ref No", 70, "ref"], ["Withdrawal (Dr)/ Deposit (Cr)", 120, "amount"], ["Balance", 87, "bal"]],
  },
};

export function makeStatementPdf(key, dir, opts = {}) {
  const L = LAYOUTS[key];
  const { opening, txns } = makeTxns();
  const rows = txns.map((t, i) => ({ ...t, sno: String(i + 1), narration: NARR[key](t), ref: t.rrn ? t.rrn : t.kind === "atm" ? "" : "CITIN26123456".slice(0, 10) }));
  const kept = rows.filter((_, i) => i !== opts.dropIndex);
  const draw = L.newestFirst ? [...kept].reverse() : kept;
  const file = join(dir, `${key}_statement${opts.dropIndex !== undefined ? "_missing_row" : ""}.pdf`);
  const doc = new PDFDocument({ size: "A4", margin: 36, ...(L.password ? { userPassword: L.password, ownerPassword: "owner-" + L.password, pdfVersion: "1.7" } : {}) });
  const done = new Promise((res, rej) => { const s = createWriteStream(file); s.on("finish", res); s.on("error", rej); doc.pipe(s); });
  const F = L.font, lineH = F * 1.18;
  let page = 1;

  const footer = () => doc.font("Helvetica").fontSize(7).fillColor("#666").text(`Page ${page}`, 36, 806, { width: 523, align: "center", lineBreak: false }).fillColor("#000");
  const header = (y) => {
    let x = 36;
    const lines = Math.max(...L.cols.map((c) => (Array.isArray(c[0]) ? c[0].length : 1)));
    doc.rect(36, y - 2, 523, lines * lineH + 4).fill("#e8eef5").fillColor("#000");
    for (const [title, w, key] of L.cols) {
      const parts = Array.isArray(title) ? title : [title];
      const right = ["debit", "credit", "amount", "bal"].includes(key);
      parts.forEach((p, i) => doc.font("Helvetica-Bold").fontSize(F).text(p, x + 2, y + i * lineH, { width: w - 4, align: right ? "right" : "left", lineBreak: false }));
      x += w;
    }
    return y + lines * lineH + 6;
  };

  // letterhead
  doc.font("Helvetica-Bold").fontSize(14).text(L.bank, 36, 36);
  doc.font("Helvetica").fontSize(8)
    .text("Account Name : MR ADNAN KHAN", 36, 58).text("Address : 12 MG Road, Bengaluru 560001")
    .text("Account No : XXXXXXXX4821").text("IFSC : " + ({ sbi: "SBIN0000813", hdfc: "HDFC0000001", icici: "ICIC0000104", axis: "UTIB0000004", kotak: "KKBK0000958" })[key])
    .text("Statement From : 01/08/2026 To : 31/10/2026");
  let y = 130;
  if (L.openingLine) { doc.font("Helvetica-Bold").fontSize(8).text(`Opening Balance : ${inr(opening)}`, 36, y); y += 16; }
  y = header(y);

  const fmtAmt = (t) => L.amtSuffix ? `${inr(t.amount)}(${t.dir === "debit" ? "Dr" : "Cr"})` : inr(t.amount);
  for (const t of draw) {
    let narr = t.narration;
    if (L.cutNarration) narr = narr.match(new RegExp(`.{1,${L.cutNarration}}`, "g")).join("\n"); // HDFC cuts at fixed width
    const nW = L.cols.find((c) => c[2] === "narr")[1] - 4;
    doc.font("Helvetica").fontSize(F);
    const nLines = Math.round(doc.heightOfString(narr, { width: nW, lineGap: 0 }) / doc.currentLineHeight()) || 1;
    const rowH = nLines * doc.currentLineHeight() + (L.rowGap ?? 4);
    if (y + rowH > 780) { footer(); doc.addPage(); page++; y = 60; doc.font("Helvetica").fontSize(7).text(L.bank + " - Statement of Account", 36, 40); y = header(y); }
    const midY = L.style === "centered" ? y + Math.floor((nLines - 1) / 2) * doc.currentLineHeight() : y;
    let x = 36;
    for (const [, w, key] of L.cols) {
      const cell = {
        sno: t.sno, date: DATE[key === "date" ? keyOf(L) : keyOf(L)](t.d), narr, ref: t.ref,
        debit: t.dir === "debit" ? inr(t.amount) : "", credit: t.dir === "credit" ? inr(t.amount) : "",
        amount: fmtAmt(t), type: t.dir === "debit" ? "DR" : "CR", bal: inr(t.balance) + (L.balSuffix ? (L.balSuffix.startsWith("(") ? L.balSuffix : " " + L.balSuffix) : ""),
      }[key];
      const right = ["debit", "credit", "amount", "bal"].includes(key);
      doc.font("Helvetica").fontSize(F);
      if (key === "narr") doc.text(cell, x + 2, y, { width: w - 4, lineGap: 0 });
      else doc.text(cell, x + 2, midY, { width: w - 4, align: right ? "right" : "left", lineBreak: false });
      x += w;
    }
    y += rowH;
  }
  // summary + disclaimer after the table
  y += 14;
  if (y > 740) { footer(); doc.addPage(); page++; y = 60; }
  doc.font("Helvetica-Bold").fontSize(8).text("Statement Summary", 36, y);
  doc.font("Helvetica").fontSize(7.5)
    .text("Opening Balance        Dr Count    Cr Count    Debits          Credits         Closing Bal", 36, y + 12)
    .text(`${inr(opening)}        30          6           ${inr(rows.filter((r) => r.dir === "debit").reduce((a, r) => a + r.amount, 0))}     ${inr(rows.filter((r) => r.dir === "credit").reduce((a, r) => a + r.amount, 0))}     ${inr(rows[rows.length - 1].balance)}`, 36, y + 22)
    .text("This is a computer generated statement and does not require a signature. Registered Office: Mumbai.", 36, y + 40, { width: 523 });
  footer();
  doc.end();
  return done.then(() => ({ file, rows, opening, password: L.password, newestFirst: !!L.newestFirst }));
}
const keyOf = (L) => Object.keys(LAYOUTS).find((k) => LAYOUTS[k] === L);

export async function makeAll(dir) {
  const out = {};
  for (const k of Object.keys(LAYOUTS)) out[k] = await makeStatementPdf(k, dir);
  return out;
}
