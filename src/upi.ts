// UPI narration parsing, bank statement (CSV) parsing, categorisation and spend analysis.
// Everything here runs locally; no transaction data leaves the machine.
import { readFileSync } from "node:fs";
import { round2 } from "./gst.js";

// ---------------- UPI narration parsing ----------------

export interface UpiInfo {
  is_upi: boolean;
  direction?: "debit" | "credit";
  type?: "P2M" | "P2P";
  payee?: string;
  vpa?: string;
  psp_bank?: string;
  rrn?: string;
  note?: string;
}

const VPA_RE = /([a-z0-9][a-z0-9._]{1,63})@([a-z][a-z0-9]{1,30})/i; // hyphen left out: HDFC uses "-" as the field separator
const RRN_RE = /(?<![0-9])([0-9]{12})(?![0-9])/;

const PSP: Record<string, string> = {
  okaxis: "Google Pay (Axis)", okhdfcbank: "Google Pay (HDFC)", okicici: "Google Pay (ICICI)", oksbi: "Google Pay (SBI)",
  ybl: "PhonePe (Yes Bank)", ibl: "PhonePe (ICICI)", axl: "PhonePe (Axis)", paytm: "Paytm", ptyes: "Paytm (Yes Bank)",
  ptaxis: "Paytm (Axis)", pthdfc: "Paytm (HDFC)", ptsbi: "Paytm (SBI)", apl: "Amazon Pay", yapl: "Amazon Pay",
  axisbank: "Axis Bank", hdfcbank: "HDFC Bank", icici: "ICICI Bank", sbi: "SBI", upi: "BHIM", kotak: "Kotak",
  ikwik: "MobiKwik", freecharge: "Freecharge", jupiteraxis: "Jupiter", fbl: "Federal Bank", waaxis: "WhatsApp Pay (Axis)",
  wahdfcbank: "WhatsApp Pay (HDFC)", wasbi: "WhatsApp Pay (SBI)", waicici: "WhatsApp Pay (ICICI)", naviaxis: "Navi",
  superyes: "super.money", yescred: "CRED", axisb: "CRED (Axis)",
};

const NOISE = new Set([
  "UPI", "DR", "CR", "P2M", "P2A", "P2P", "PAYMENT", "PAY", "TO", "FROM", "TRANSFER", "UPI PAYMENT", "PAYMENT FROM PHONE",
  "SENT USING PAYTM UPI", "NA", "NULL", "IMPS", "NEFT", "REV", "COLLECT", "MANDATE", "AUTOPAY", "MB", "IB", "BY", "TRF",
  "PAYMENT ON CRED", "PAID VIA SUPERMONEY", "UPIINTENT", "UPI INTENT", "OTHERS", "OK",
  "TO TRANSFER", "BY TRANSFER", "TRANSFER TO", "TRANSFER FROM", "UPI TRANSFER", "UPI/DR", "UPI/CR",
]);
const BANK_TOKENS = /^(SBIN|HDFC|ICIC|UTIB|KKBK|YESB|PUNB|BARB|CNRB|UBIN|IDIB|IDFB|INDB|FDRL|PYTM|AIRP|JIOP|BKID|CBIN|IOBA|MAHB|UCBA|ESFB|AUBL|RATN)[A-Z0-9]*$/;

export function parseUpiNarration(narration: string): UpiInfo {
  const n = narration.trim();
  const is_upi = /\bUPI\b|UPI[\/-]|@[a-z]{2,}/i.test(n);
  if (!is_upi) return { is_upi: false };

  const info: UpiInfo = { is_upi: true };
  if (/UPI\/DR|\/DR\/|^DR\b|UPI-DR|\bDEBIT\b|TO TRANSFER/i.test(n)) info.direction = "debit";
  else if (/UPI\/CR|\/CR\/|^CR\b|UPI-CR|\bCREDIT\b|BY TRANSFER/i.test(n)) info.direction = "credit";
  if (/P2M/i.test(n)) info.type = "P2M";
  else if (/P2A|P2P/i.test(n)) info.type = "P2P";

  const vpa = n.match(VPA_RE);
  if (vpa) {
    info.vpa = vpa[0].toLowerCase();
    info.psp_bank = PSP[vpa[2].toLowerCase()] ?? vpa[2].toLowerCase();
  }
  const rrn = n.replace(VPA_RE, " ").match(RRN_RE);
  if (rrn) info.rrn = rrn[1];

  // Payee: first meaningful alphabetic token between / or - separators
  const tokens = n.replace(VPA_RE, " ").split(/[\/|]| - |-(?=[A-Za-z])|(?<=[A-Za-z])-/).map((t) => t.trim()).filter(Boolean);
  const candidates = tokens.filter((t) => {
    const u = t.toUpperCase();
    return /[A-Za-z]{2,}/.test(t) && !NOISE.has(u) && !BANK_TOKENS.test(u) && !/^[0-9X*]+$/.test(t)
      && !/BANK( LTD| LIMITED)?$/i.test(t) && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(u);
  });
  if (candidates.length) info.payee = titleCase(candidates[0]);
  else if (vpa) info.payee = vpa[1];
  if (candidates.length > 1) {
    const last = candidates[candidates.length - 1];
    if (last.toUpperCase() !== candidates[0].toUpperCase()) info.note = last;
  }
  if (!info.type && info.vpa) {
    // Merchant VPAs usually contain merchant words or are on known merchant handles
    info.type = /(pay|merchant|store|shop|razorpay|cashfree|paytm-|bharatpe|\.rzp|swiggy|zomato|amazon|flipkart|irctc|q[0-9]{5,})/i.test(info.vpa) ? "P2M" : "P2P";
  }
  return info;
}

function titleCase(s: string) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, " ").trim();
}

// ---------------- Categorisation ----------------

const CATEGORY_RULES: [string, RegExp][] = [
  ["Salary & Income", /\bSALARY\b|\bSAL\b|PAYROLL|STIPEND/i],
  ["Interest & Refunds", /\bINT(EREST)?\.?\s?(PD|CREDIT|PAID)?\b.*|REFUND|CASHBACK|REVERSAL|\bREV\b/i],
  ["Food Delivery & Dining", /SWIGGY(?!.*INSTAMART)|ZOMATO|DOMINO|MCDONALD|KFC|PIZZA|STARBUCKS|CAFE|RESTAURANT|EATCLUB|BURGER|CHAAYOS|HALDIRAM|BIRYANI/i],
  ["Groceries", /BLINKIT|ZEPTO|BIGBASKET|BBNOW|INSTAMART|DMART|AVENUE SUPERMART|JIOMART|RELIANCE (FRESH|SMART|RETAIL)|MORE RETAIL|SPENCER|NATURE.?S BASKET|KIRANA|GROCER|MILKBASKET|COUNTRY DELIGHT|DAIRY/i],
  ["Shopping", /AMAZON(?! PAY.*(BILL|RECHARGE))|FLIPKART|MYNTRA|MEESHO|AJIO|NYKAA|TATA ?CLIQ|SNAPDEAL|DECATHLON|IKEA|CROMA|RELIANCE DIGITAL|LENSKART|FIRSTCRY|PEPPERFRY/i],
  ["Travel & Transport", /UBER|\bOLA\b|OLACABS|RAPIDO|IRCTC|MAKEMYTRIP|\bMMT\b|GOIBIBO|CLEARTRIP|REDBUS|INDIGO|AIR ?INDIA|AKASA|SPICEJET|VISTARA|IXIGO|\bMETRO\b|DMRC|BMRCL|FASTAG|NHAI|YATRA|ABHIBUS|NAMMA YATRI|BLUSMART/i],
  ["Fuel", /PETROL|DIESEL|\bHPCL\b|\bIOCL\b|\bBPCL\b|INDIAN ?OIL|HP PAY|BHARAT PETROLEUM|HINDUSTAN PETROLEUM|SHELL|NAYARA|FUEL/i],
  ["Bills & Utilities", /ELECTRICITY|BESCOM|MSEDCL|TATA ?POWER|ADANI ?(ELECTRICITY|GAS)|TORRENT|BSES|TNEB|TANGEDCO|KSEB|CESC|WATER|GAS|\bLPG\b|INDANE|AIRTEL|\bJIO\b|VODAFONE|\bVI\b|BSNL|BROADBAND|ACT FIBERNET|HATHWAY|DTH|TATA ?PLAY|RECHARGE|BILLDESK|BBPS|POSTPAID/i],
  ["Entertainment & Subscriptions", /NETFLIX|HOTSTAR|JIOHOTSTAR|SPOTIFY|PRIME VIDEO|AMAZON ?PRIME|YOUTUBE|GOOGLE ?PLAY|APPLE\.COM|ITUNES|BOOKMYSHOW|PVR|INOX|SONYLIV|ZEE5|GAANA|DISTRICT/i],
  ["Investments", /ZERODHA|GROWW|UPSTOX|KUVERA|\bCOIN\b|\bSIP\b|MUTUAL ?FUND|\bMF\b|ICCL|INDIAN CLEARING|NSE ?CLEARING|BSE|PPF|\bNPS\b|SMALLCASE|ANGEL ?ONE|DHAN|PAYTM ?MONEY|\bRD\b|FIXED DEPOSIT|\bFD\b/i],
  ["Insurance", /\bLIC\b|INSURANCE|POLICYBAZAAR|ACKO|DIGIT|HDFC ?ERGO|ICICI ?LOMBARD|STAR ?HEALTH|TATA ?AIA|MAX ?LIFE|BAJAJ ?ALLIANZ|NIVA BUPA/i],
  ["Loans & EMI", /\bEMI\b|LOAN|BAJAJ ?FIN|NACH|ECS|HOME ?FIRST|CRED(?!IT)|CREDIT ?CARD|CC ?PAYMENT|\bCARD ?BILL\b/i],
  ["Health", /PHARM|MEDIC|1MG|TATA ?1MG|APOLLO|NETMEDS|HOSPITAL|CLINIC|DIAGNOSTIC|PRACTO|HEALTHIANS|LAB|DENTAL|CULT\.?FIT|CUREFIT/i],
  ["Education", /SCHOOL|COLLEGE|UNIVERSITY|TUITION|BYJU|UNACADEMY|UDEMY|COURSERA|VEDANTU|PHYSICSWALLAH|EXAM FEE|FEES/i],
  ["Rent & Housing", /\bRENT\b|NOBROKER|MAINTENANCE|SOCIETY|NOBROKERHOOD|MYGATE|HOUSING/i],
  ["Taxes & Government", /INCOME ?TAX|\bTDS\b|\bGST\b|CBDT|TIN ?NSDL|CHALLAN|MUNICIPAL|PROPERTY ?TAX|PASSPORT|TRAFFIC|E-?CHALLAN/i],
  ["Cash Withdrawal", /\bATM\b|CASH ?WDL|CASH ?WITHDRAWAL|\bNWD\b|\bATW\b/i],
  ["Bank Charges", /CHARGES|CHGS|\bFEE\b|PENALTY|MIN BAL|SMS ALERT|ANNUAL FEE|DEBIT CARD FEE/i],
];

export function categorise(narration: string, direction: "debit" | "credit", upi?: UpiInfo): string {
  const hay = [narration, upi?.vpa ?? "", upi?.payee ?? ""].join(" ");
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  if (direction === "credit") return upi?.is_upi ? "Received (UPI)" : "Other Income";
  if (upi?.is_upi && upi.type === "P2P") return "Transfers to People";
  if (/NEFT|IMPS|RTGS|\bTRF\b|TRANSFER/i.test(narration)) return "Transfers to People";
  return "Other / Uncategorised";
}

// ---------------- CSV statement parsing ----------------

export interface Txn {
  date: string; // YYYY-MM-DD
  narration: string;
  debit: number;
  credit: number;
  balance?: number;
}

export interface EnrichedTxn extends Txn {
  amount: number;
  direction: "debit" | "credit";
  category: string;
  payee?: string;
  upi?: UpiInfo;
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  const delim = guessDelimiter(text);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell.trim()); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim()); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

function guessDelimiter(text: string) {
  const sample = text.slice(0, 5000);
  const counts = [",", ";", "\t", "|"].map((d) => [d, sample.split(d).length] as const);
  return counts.sort((a, b) => b[1] - a[1])[0][0];
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export function parseIndianDate(s: string): string | undefined {
  const t = s.trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/); // Indian banks use DD/MM/YYYY
  if (m) return iso(year(+m[3]), +m[2], +m[1]);
  m = t.match(/^(\d{1,2})[\s\-\/]([A-Za-z]{3,9})[\s\-\/,]+(\d{2,4})/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return iso(year(+m[3]), mo, +m[1]);
  }
  m = t.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) return iso(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]);
  return undefined;
}
const year = (y: number) => (y < 100 ? 2000 + y : y);
function iso(y: number, mo: number, d: number) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const t = s.replace(/[₹,\s]|INR|Rs\.?/gi, "").replace(/(CR|DR)$/i, "");
  if (!t || t === "-") return 0;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const v = parseFloat(t.replace(/[()\-]/g, ""));
  return isNaN(v) ? 0 : neg ? -v : v;
}

const H = {
  date: /^(txn |transaction |value |tran )?date$|^date$|^txn date|^transaction date|^tran date/i,
  narration: /narration|description|particulars|remarks|details|transaction details/i,
  debit: /withdrawal|debit|^dr\b|dr amount|amount dr|paid out|money out/i,
  credit: /deposit|credit|^cr\b|cr amount|amount cr|paid in|money in/i,
  amount: /^amount|txn amount|transaction amount/i,
  type: /^(dr ?\/ ?cr|cr ?\/ ?dr|type|txn type|debit\/credit)$/i,
  balance: /balance/i,
};

export function parseStatementCsv(text: string): { transactions: Txn[]; columns: Record<string, string>; skipped_rows: number } {
  const rows = parseCsv(text);
  const headerIdx = rows.findIndex((r) => r.some((c) => H.date.test(c)) && r.some((c) => H.narration.test(c)));
  if (headerIdx < 0) {
    throw new Error("Could not find a header row with a Date and a Narration/Description/Particulars column. " +
      "Export the statement as CSV from net banking, or pass rows via the `transactions` parameter instead.");
  }
  const header = rows[headerIdx];
  const find = (re: RegExp, exclude: number[] = []) => header.findIndex((c, i) => re.test(c) && !exclude.includes(i));
  const di = find(H.date);
  const ni = find(H.narration);
  const bi = find(H.balance);
  const dbi = find(H.debit, [bi]);
  const cri = find(H.credit, [bi, dbi]);
  const ai = dbi < 0 ? find(H.amount, [bi]) : -1;
  const ti = find(H.type);
  if (dbi < 0 && ai < 0) throw new Error("Could not find Debit/Withdrawal or Amount columns in the CSV header: " + header.join(" | "));

  const out: Txn[] = [];
  let skipped = 0;
  for (const r of rows.slice(headerIdx + 1)) {
    const date = parseIndianDate(r[di] ?? "");
    if (!date) { skipped++; continue; }
    let debit = 0, credit = 0;
    if (dbi >= 0) {
      debit = Math.abs(parseAmount(r[dbi]));
      credit = cri >= 0 ? Math.abs(parseAmount(r[cri])) : 0;
    } else {
      const raw = r[ai] ?? "";
      const amt = parseAmount(raw);
      const typ = (ti >= 0 ? r[ti] : raw).toUpperCase();
      if (/CR|CREDIT/.test(typ) || (ti < 0 && amt > 0 && /CR$/i.test(raw))) credit = Math.abs(amt);
      else if (/DR|DEBIT/.test(typ)) debit = Math.abs(amt);
      else if (amt < 0) debit = -amt;
      else credit = amt;
    }
    if (!debit && !credit) { skipped++; continue; }
    out.push({ date, narration: r[ni] ?? "", debit, credit, balance: bi >= 0 ? parseAmount(r[bi]) || undefined : undefined });
  }
  return {
    transactions: out,
    columns: Object.fromEntries(
      Object.entries({ date: di, narration: ni, debit: dbi, credit: cri, amount: ai, type: ti, balance: bi })
        .filter(([, i]) => i >= 0).map(([k, i]) => [k, header[i]]),
    ),
    skipped_rows: skipped,
  };
}

export function loadStatement(path: string) {
  if (!/\.(csv|txt|tsv)$/i.test(path)) {
    throw new Error("loadStatement only reads CSV/TSV; use loadStatementFile for PDFs.");
  }
  return parseStatementCsv(readFileSync(path, "utf8").replace(/^﻿/, ""));
}

// ---------------- Analysis ----------------

export function enrich(txns: Txn[]): EnrichedTxn[] {
  return txns.map((t) => {
    const direction = t.debit > 0 ? "debit" : "credit";
    const upi = parseUpiNarration(t.narration);
    return {
      ...t,
      amount: direction === "debit" ? t.debit : t.credit,
      direction,
      upi: upi.is_upi ? upi : undefined,
      payee: upi.payee ?? cleanPayee(t.narration),
      category: categorise(t.narration, direction, upi),
    };
  });
}

const NON_PAYEE = /^(NEFT|IMPS|RTGS|ACH|NACH|ACHDR|ACHCR|DEBIT|CREDIT|DR|CR|TO|BY|FROM|TRANSFER|TRF|POS|ECOM|INB|MB|IB|UPI|SI|ECS|INF|INFT|REF|NO|CHQ|ATM|WDL|CASH|NWD|ATW|ATL|PAYMENT|PMT)$/i;

/** Best-effort counterparty name from a non-UPI narration, e.g. "NEFT CR-CITI0000002-ACME TECH PVT LTD-SALARY" -> "Acme Tech Pvt Ltd". */
export function cleanPayee(n: string): string | undefined {
  for (const part of n.split(/[\/*|:]|-(?=\S)|\s-\s/)) {
    const words = part.trim().split(/\s+/).filter((w) =>
      !NON_PAYEE.test(w) && !/\d{3,}/.test(w) && !/^[A-Z]{4}0[A-Z0-9]{6}$/i.test(w) && /[A-Za-z]{2,}/.test(w));
    if (words.length) return titleCase(words.slice(0, 4).join(" "));
  }
  return undefined;
}

export function analyse(txns: Txn[], opts: { from?: string; to?: string; top_n?: number } = {}) {
  const top = opts.top_n ?? 10;
  const all = enrich(txns)
    .filter((t) => (!opts.from || t.date >= opts.from) && (!opts.to || t.date <= opts.to))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!all.length) return { message: "No transactions in the selected range." };

  const debits = all.filter((t) => t.direction === "debit");
  const credits = all.filter((t) => t.direction === "credit");
  const sum = (a: EnrichedTxn[]) => round2(a.reduce((s, t) => s + t.amount, 0));
  const group = <K extends string>(a: EnrichedTxn[], key: (t: EnrichedTxn) => K) => {
    const m = new Map<K, { total: number; count: number }>();
    for (const t of a) {
      const k = key(t);
      const g = m.get(k) ?? { total: 0, count: 0 };
      g.total = round2(g.total + t.amount); g.count++;
      m.set(k, g);
    }
    return [...m.entries()].sort((x, y) => y[1].total - x[1].total);
  };

  const spent = sum(debits);
  const byCategory = group(debits, (t) => t.category).map(([category, g]) => ({
    category, ...g, share_pct: spent ? round2((g.total / spent) * 100) : 0,
  }));
  const byMonth = new Map<string, { spent: number; received: number }>();
  for (const t of all) {
    const k = t.date.slice(0, 7);
    const g = byMonth.get(k) ?? { spent: 0, received: 0 };
    if (t.direction === "debit") g.spent = round2(g.spent + t.amount); else g.received = round2(g.received + t.amount);
    byMonth.set(k, g);
  }

  // Recurring payments: same payee + similar amount (within 10%) in 3+ distinct months
  const recurring: { payee: string; typical_amount: number; months: number; category: string; last_paid: string }[] = [];
  const byPayee = new Map<string, EnrichedTxn[]>();
  for (const t of debits) {
    const k = (t.upi?.vpa ?? t.payee ?? "").toLowerCase();
    if (!k) continue;
    byPayee.set(k, [...(byPayee.get(k) ?? []), t]);
  }
  for (const list of byPayee.values()) {
    const amounts = list.map((t) => t.amount).sort((a, b) => a - b);
    const median = amounts[Math.floor(amounts.length / 2)];
    const similar = list.filter((t) => Math.abs(t.amount - median) <= median * 0.1);
    const months = new Set(similar.map((t) => t.date.slice(0, 7)));
    if (months.size >= 3) {
      recurring.push({ payee: list[0].payee ?? list[0].upi?.vpa ?? "?", typical_amount: median, months: months.size, category: list[0].category, last_paid: similar[similar.length - 1].date });
    }
  }

  const upiDebits = debits.filter((t) => t.upi);
  const small = upiDebits.filter((t) => t.amount <= 200);

  return {
    period: { from: all[0].date, to: all[all.length - 1].date, transactions: all.length },
    totals: { spent, received: sum(credits), net: round2(sum(credits) - spent) },
    upi: {
      payments: upiDebits.length,
      amount: sum(upiDebits),
      share_of_spend_pct: spent ? round2((sum(upiDebits) / spent) * 100) : 0,
      small_payments_under_200: { count: small.length, total: sum(small) },
    },
    by_category: byCategory,
    by_month: [...byMonth.entries()].map(([month, g]) => ({ month, ...g, net: round2(g.received - g.spent) })),
    top_payees: group(debits, (t) => t.payee ?? "Unknown").slice(0, top).map(([payee, g]) => ({ payee, ...g })),
    largest_debits: [...debits].sort((a, b) => b.amount - a.amount).slice(0, top)
      .map((t) => ({ date: t.date, amount: t.amount, payee: t.payee, category: t.category, narration: t.narration })),
    recurring_payments: recurring.sort((a, b) => b.typical_amount - a.typical_amount),
    uncategorised_sample: debits.filter((t) => t.category.startsWith("Other")).slice(0, 15)
      .map((t) => ({ date: t.date, amount: t.amount, narration: t.narration })),
  };
}
