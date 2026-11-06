// PDF bank statement parser.
//
// Works on text-based PDFs (the kind net banking emails you), not scans. Steps:
//   1. pull every text fragment with its x/y position (pdf.js)
//   2. rebuild lines and cells
//   3. find the table header and work out which column is date / narration / debit / credit / balance
//   4. rows with a date are transactions; wrapped narration lines are attached to the nearest row
//   5. reconcile every row against the running balance to fix debit/credit mix-ups and catch missed rows
import { readFileSync } from "node:fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { round2 } from "./gst.js";
import { parseAmount, parseIndianDate, type Txn } from "./upi.js";

interface Seg { text: string; x0: number; x1: number; y: number; h: number }
interface Line { page: number; y: number; h: number; segs: Seg[] }

type Role = "serial" | "date" | "value_date" | "narration" | "ref" | "debit" | "credit" | "amount" | "type" | "balance";
interface Col { role: Role; title: string; x0: number; x1: number; lo: number; hi: number }

export interface PdfTxn extends Txn { ref?: string; value_date?: string }

export interface PdfStatement {
  bank?: string;
  account_last4?: string;
  pages: number;
  order: "oldest_first" | "newest_first";
  opening_balance?: number;
  closing_balance?: number;
  columns: Record<string, string>;
  transactions: PdfTxn[];
  reconciliation: {
    rows_with_balance: number;
    matched: number;
    auto_fixed_direction: number;
    mismatches: { row: number; date: string; narration: string; expected_balance: number; statement_balance: number }[];
    verdict: string;
  };
  warnings: string[];
  layout_preview?: string[];
}

// ---------------------------------------------------------------- extraction

const PASSWORD_HELP =
  "Indian banks usually lock statement PDFs. The password is normally explained in the email the statement came with " +
  "(often a mix of your name, date of birth, customer ID or mobile number). Ask the user for it and pass it as `password`.";

async function extractLines(data: Uint8Array, password?: string) {
  const task = getDocument({ data, password, verbosity: 0, disableFontFace: true, useSystemFonts: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    await task.destroy().catch(() => {});
    const err = e as { name?: string; code?: number; message?: string };
    if (err?.name === "PasswordException") {
      if (err.code === 2) throw new Error("The PDF password is incorrect. " + PASSWORD_HELP);
      throw new Error("This statement PDF is password-protected. " + PASSWORD_HELP);
    }
    throw new Error(`Could not open the PDF: ${err?.message ?? String(e)}`);
  }

  const lines: Line[] = [];
  let firstPageText = "";
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { height } = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const raw: Seg[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const t = item.transform as number[];
        const h = item.height || Math.hypot(t[2], t[3]) || 8;
        raw.push({ text: item.str.trim(), x0: t[4], x1: t[4] + (item.width || item.str.length * h * 0.5), y: height - t[5], h });
      }
      if (p === 1) firstPageText = raw.map((s) => s.text).join(" ");
      lines.push(...groupLines(raw, p));
      page.cleanup();
    }
    return { lines, pages: doc.numPages, firstPageText };
  } finally {
    await task.destroy();
  }
}

function groupLines(segs: Seg[], page: number): Line[] {
  segs.sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const lines: Line[] = [];
  for (const s of segs) {
    const tol = (l: Line) => Math.max(1.5, 0.4 * Math.min(l.h, s.h));
    const line = lines.slice(-4).find((l) => Math.abs(l.y - s.y) <= tol(l));
    if (line) { line.segs.push(s); line.h = Math.max(line.h, s.h); }
    else lines.push({ page, y: s.y, h: s.h, segs: [s] });
  }
  for (const l of lines) {
    l.segs.sort((a, b) => a.x0 - b.x0);
    const merged: Seg[] = [];
    for (const s of l.segs) {
      const cur = merged[merged.length - 1];
      const gap = cur ? s.x0 - cur.x1 : Infinity;
      if (cur && gap < 0.6 * Math.max(cur.h, s.h) && gap > -cur.h) {
        cur.text += (gap > 0.12 * s.h ? " " : "") + s.text;
        cur.x1 = Math.max(cur.x1, s.x1);
      } else merged.push({ ...s });
    }
    l.segs = merged;
  }
  return lines.sort((a, b) => a.y - b.y);
}

// ---------------------------------------------------------------- header + columns

function roleOf(title: string): Role | undefined {
  const s = title.toLowerCase().replace(/\s+/g, " ").trim();
  if (/^(dr ?\/ ?cr|cr ?\/ ?dr|type|txn type|d ?\/ ?c|c ?\/ ?d)\.?$/.test(s)) return "type";
  if (/balance|bal\.?$/.test(s)) return "balance";
  const deb = /withdrawal|debit|\bdr\b|paid out|money out/.test(s);
  const cred = /deposit|credit|\bcr\b|paid in|money in/.test(s);
  if (deb && cred) return "amount";
  if (deb) return "debit";
  if (cred) return "credit";
  if (/value/.test(s) && /date|\bdt\b/.test(s)) return "value_date";
  if (/narration|description|particulars|remarks|details/.test(s)) return "narration";
  if (/\bdate\b|^dt\.?$|\b(txn|tran|post(ing)?) dt\b/.test(s)) return "date";
  if (/chq|cheque|\bref\b|ref\.|reference|instrument|utr/.test(s)) return "ref";
  if (/amount|\bamt\b/.test(s)) return "amount";
  if (/^(s\.? ?no\.?|sr\.? ?no\.?|sl\.? ?no\.?|#|no\.?)$/.test(s)) return "serial";
  return undefined;
}

function isHeader(segs: Seg[]) {
  const roles = new Set(segs.map((s) => roleOf(s.text)));
  return (roles.has("date") || roles.has("value_date")) && roles.has("narration")
    && (roles.has("debit") || roles.has("credit") || roles.has("amount"));
}

function mergeHeaderLines(a: Seg[], b: Seg[]): Seg[] {
  const out = a.map((s) => ({ ...s }));
  for (const s of b) {
    const target = out.find((o) => Math.min(o.x1, s.x1) - Math.max(o.x0, s.x0) > 0);
    if (target) { target.text += " " + s.text; target.x0 = Math.min(target.x0, s.x0); target.x1 = Math.max(target.x1, s.x1); }
    else out.push({ ...s });
  }
  return out.sort((x, y) => x.x0 - y.x0);
}

const looksLikeData = (l: Line) => l.segs.some((s) => isAmount(s.text) || isDateText(s.text));

/** Finds a header at line i (optionally spanning i+1). Returns [columns, linesUsed] or undefined. */
function headerAt(lines: Line[], i: number): [Col[], number] | undefined {
  const l = lines[i];
  if (looksLikeData(l)) return undefined;
  const next = lines[i + 1];
  const canMerge = next && next.page === l.page && next.y - l.y < 2.2 * l.h && !looksLikeData(next);
  if (canMerge) {
    const merged = mergeHeaderLines(l.segs, next.segs);
    if (isHeader(merged)) return [buildCols(merged), 2];
  }
  if (isHeader(l.segs)) return [buildCols(l.segs), 1];
  return undefined;
}

function buildCols(segs: Seg[]): Col[] {
  const cols: Col[] = [];
  for (const s of segs) {
    const role = roleOf(s.text);
    if (!role) continue;
    // A second "date" column is the value date (e.g. ICICI "Value Date | Transaction Date")
    cols.push({ role, title: s.text, x0: s.x0, x1: s.x1, lo: 0, hi: 0 });
  }
  if (!cols.some((c) => c.role === "date")) {
    const v = cols.find((c) => c.role === "value_date");
    if (v) v.role = "date";
  }
  const dates = cols.filter((c) => c.role === "date");
  if (dates.length > 1) dates.slice(1).forEach((c) => (c.role = "value_date"));
  cols.sort((a, b) => a.x0 - b.x0);
  cols.forEach((c, i) => {
    c.lo = i === 0 ? -Infinity : (cols[i - 1].x1 + c.x0) / 2;
    c.hi = i === cols.length - 1 ? Infinity : (c.x1 + cols[i + 1].x0) / 2;
  });
  return cols;
}

// ---------------------------------------------------------------- cell typing

const AMOUNT_RE = /^\(?-?\s?(?:₹|rs\.?|inr)?\s?\d[\d,]*\.\d{1,2}\)?\s*\(?(?:cr|dr)?\)?\.?$/i;
const isAmount = (t: string) => AMOUNT_RE.test(t.replace(/\s+/g, " ").trim());
const isDateText = (t: string) => t.length <= 14 && !!parseIndianDate(t) && !/^\d+\.\d{2}$/.test(t);
const TYPE_RE = /^\(?(cr|dr|c|d|credit|debit)\)?\.?$/i;

function suffixType(t: string): "debit" | "credit" | undefined {
  if (/(?:\b|\()dr\)?\.?$|debit$/i.test(t.trim())) return "debit";
  if (/(?:\b|\()cr\)?\.?$|credit$/i.test(t.trim())) return "credit";
  return undefined;
}

function signedAmount(t: string): number {
  const v = Math.abs(parseAmount(t));
  return suffixType(t) === "debit" || /^\(.*\)$|^-/.test(t.trim()) ? -v : v;
}

function assign(seg: Seg, cols: Col[]): Col | undefined {
  const numericRoles: Role[] = ["debit", "credit", "amount", "balance"];
  let candidates: Col[];
  if (isAmount(seg.text)) candidates = cols.filter((c) => numericRoles.includes(c.role));
  else if (isDateText(seg.text)) candidates = cols.filter((c) => c.role === "date" || c.role === "value_date");
  else if (TYPE_RE.test(seg.text) && cols.some((c) => c.role === "type")) candidates = cols.filter((c) => c.role === "type");
  else candidates = cols.filter((c) => !numericRoles.includes(c.role));
  if (!candidates.length) candidates = cols;
  let best: Col | undefined, bestScore = -Infinity;
  for (const c of candidates) {
    const overlap = Math.min(seg.x1, c.hi) - Math.max(seg.x0, c.lo);
    const titleOverlap = Math.min(seg.x1, c.x1) - Math.max(seg.x0, c.x0);
    const score = overlap + Math.max(0, titleOverlap) * 0.5 - (overlap <= 0 ? Math.abs((seg.x0 + seg.x1) / 2 - (c.x0 + c.x1) / 2) : 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

// ---------------------------------------------------------------- rows

interface Frag { text: string; x1: number }
interface Row {
  page: number; y: number;
  date: string; value_date?: string;
  narr: Frag[]; ref: string[];
  debit?: number; credit?: number; amount?: number; type?: "debit" | "credit"; balance?: number;
}

const JUNK = /\bpage\s*\d+(\s*(of|\/)\s*\d+)?\b|opening\s+bal|closing\s+bal|statement\s+summary|brought\s+forward|carried\s+forward|\bb\/f\b|\bc\/f\b|computer[\s-]generated|system[\s-]generated|end of statement|^total\b|grand total|abbreviation|registered office|\*{3,}/i;

const BANKS: [RegExp, string, string][] = [
  [/state bank of india/i, "SBIN", "SBI"], [/hdfc bank/i, "HDFC", "HDFC Bank"], [/icici bank/i, "ICIC", "ICICI Bank"],
  [/axis bank/i, "UTIB", "Axis Bank"], [/kotak mahindra/i, "KKBK", "Kotak Mahindra Bank"], [/punjab national bank/i, "PUNB", "Punjab National Bank"],
  [/bank of baroda/i, "BARB", "Bank of Baroda"], [/canara bank/i, "CNRB", "Canara Bank"], [/union bank of india/i, "UBIN", "Union Bank of India"],
  [/idfc first/i, "IDFB", "IDFC FIRST Bank"], [/indusind/i, "INDB", "IndusInd Bank"], [/yes bank/i, "YESB", "Yes Bank"],
  [/federal bank/i, "FDRL", "Federal Bank"], [/au small finance/i, "AUBL", "AU Small Finance Bank"], [/central bank of india/i, "CBIN", "Central Bank of India"],
  [/bank of india/i, "BKID", "Bank of India"], [/indian bank\b/i, "IDIB", "Indian Bank"],
];

function detectBank(text: string): string | undefined {
  // 1. bank name in the letterhead (earliest mention wins); 2. the statement's labelled IFSC
  const top = text.slice(0, 600);
  const named = BANKS.map((b) => [top.search(b[0]), b[2]] as const).filter(([i]) => i >= 0).sort((a, b) => a[0] - b[0])[0]?.[1];
  if (named) return named;
  const ifsc = text.match(/IFSC(?:\s*code)?\s*[:\-]?\s*([A-Z]{4})0[A-Z0-9]{6}/i)?.[1]?.toUpperCase();
  return BANKS.find((b) => b[1] === ifsc)?.[2] ?? BANKS.find((b) => b[0].test(text))?.[2];
}

export async function parsePdfStatement(input: string | Uint8Array, opts: { password?: string; debug?: boolean } = {}): Promise<PdfStatement> {
  const data = typeof input === "string" ? new Uint8Array(readFileSync(input)) : input;
  const { lines, pages, firstPageText } = await extractLines(data, opts.password);
  if (!lines.length) {
    throw new Error("This PDF has no text layer (it is probably a scan or photo). Claude can read the PDF visually instead and pass the rows to analyze_bank_statement as `transactions`.");
  }
  const warnings: string[] = [];

  // Pass 1: walk lines, detect headers, classify rows vs other lines
  type Item = { kind: "row"; row: Row } | { kind: "text"; line: Line; frags: { role: Role; seg: Seg }[] } | { kind: "barrier" };
  const items: Item[] = [];
  let cols: Col[] | undefined;
  let headerCols: Col[] | undefined;
  let opening: number | undefined;
  const lineGaps: number[] = [];
  let lastTableLine: Line | undefined;

  for (let i = 0; i < lines.length; i++) {
    if (opening === undefined && !cols) {
      const t = lines[i].segs.map((x) => x.text).join(" ");
      const m = t.match(/opening\s+bal(?:ance)?\s*(?:\(?(?:inr|rs\.?|₹)\)?)?\s*[:\-]?\s*(\(?-?[\d,]+\.\d{2}\)?\s*(?:\(?(?:cr|dr)\)?)?)/i);
      if (m) opening = signedAmount(m[1]);
    }
    const h = headerAt(lines, i);
    if (h) { cols = h[0]; headerCols ??= h[0]; i += h[1] - 1; lastTableLine = undefined; items.push({ kind: "barrier" }); continue; }
    if (!cols) continue;
    const line = lines[i];
    if (lastTableLine && lastTableLine.page === line.page) lineGaps.push(line.y - lastTableLine.y);
    lastTableLine = line;

    const text = line.segs.map((s) => s.text).join(" ");
    const cells = line.segs.map((seg) => ({ seg, col: assign(seg, cols!) }));
    const dateCell = cells.find((c) => c.col?.role === "date" && isDateText(c.seg.text));

    if (!dateCell) {
      if (/opening\s+bal|brought\s+forward|\bb\/f\b/i.test(text) && opening === undefined) {
        const amts = line.segs.filter((s) => isAmount(s.text));
        if (amts.length) opening = signedAmount(amts[amts.length - 1].text);
      }
      if (JUNK.test(text) || line.segs.some((s) => isAmount(s.text))) continue;
      const frags = cells.filter((c) => c.col && (c.col.role === "narration" || c.col.role === "ref"))
        .map((c) => ({ role: c.col!.role, seg: c.seg }));
      if (frags.length) items.push({ kind: "text", line, frags });
      continue;
    }

    const row: Row = { page: line.page, y: line.y, date: parseIndianDate(dateCell.seg.text)!, narr: [], ref: [] };
    for (const { seg, col } of cells) {
      if (!col || seg === dateCell.seg) continue;
      switch (col.role) {
        case "value_date": row.value_date = parseIndianDate(seg.text) ?? row.value_date; break;
        case "narration": row.narr.push({ text: seg.text, x1: seg.x1 }); break;
        case "ref": row.ref.push(seg.text); break;
        case "debit": if (isAmount(seg.text)) row.debit = Math.abs(parseAmount(seg.text)); break;
        case "credit": if (isAmount(seg.text)) row.credit = Math.abs(parseAmount(seg.text)); break;
        case "amount":
          if (isAmount(seg.text)) { row.amount = Math.abs(parseAmount(seg.text)); row.type = suffixType(seg.text) ?? (signedAmount(seg.text) < 0 ? "debit" : row.type); }
          break;
        case "type": { const t = suffixType(seg.text) ?? (/^\(?d/i.test(seg.text) ? "debit" : /^\(?c/i.test(seg.text) ? "credit" : undefined); if (t) row.type = t; break; }
        case "balance": if (isAmount(seg.text)) row.balance = signedAmount(seg.text); break;
      }
    }
    if (row.debit === undefined && row.credit === undefined && row.amount === undefined) {
      warnings.push(`Skipped a row dated ${row.date} with no amount ("${row.narr.map((f) => f.text).join(" ").slice(0, 60)}").`);
      continue;
    }
    items.push({ kind: "row", row });
  }

  if (!headerCols) {
    const err = new Error("Couldn't find the transaction table header (Date / Narration / Withdrawal / Deposit / Balance) in this PDF. " +
      "Claude can read the PDF directly and pass the rows as `transactions`. To report the layout safely, call convert_bank_statement with debug: true.");
    (err as Error & { preview?: string[] }).preview = maskedPreview(lines);
    throw err;
  }

  // Pass 2: attach wrapped narration lines. The text lines between two rows are split at the
  // biggest vertical gap: lines above it belong to the earlier row, lines below it to the later one
  // (some banks wrap narration below the date row, others above and below it).
  const sorted = [...lineGaps].filter((g) => g > 0 && g < 40).sort((a, b) => a - b);
  const lineH = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 10;
  const maxDist = 2.6 * lineH;
  const rows: Row[] = [];
  type TextItem = Extract<Item, { kind: "text" }>;
  const attach = (row: Row, it: TextItem, prepend: boolean) => {
    const n = it.frags.filter((f) => f.role === "narration").map((f) => ({ text: f.seg.text, x1: f.seg.x1 }));
    const r = it.frags.filter((f) => f.role === "ref").map((f) => f.seg.text);
    if (prepend) { row.narr.unshift(...n); row.ref.unshift(...r); }
    else { row.narr.push(...n); row.ref.push(...r); }
  };
  const settle = (block: TextItem[], before?: Row, after?: Row) => {
    if (!block.length) return;
    // positions: before row, each text line, after row (Infinity across pages)
    const ys = block.map((b) => b.line.y);
    const gaps: number[] = [];
    gaps.push(before && before.page === block[0].line.page ? ys[0] - before.y : Infinity);
    for (let i = 1; i < block.length; i++) gaps.push(block[i].line.page === block[i - 1].line.page ? ys[i] - ys[i - 1] : Infinity);
    gaps.push(after && after.page === block[block.length - 1].line.page ? after.y - ys[ys.length - 1] : Infinity);
    // split index k: block[0..k-1] -> before, block[k..] -> after. Ties favour `before`.
    let k = block.length, big = -1;
    for (let i = 0; i < gaps.length; i++) if (gaps[i] >= big) { big = gaps[i]; k = i; }
    if (!after) k = block.length;
    if (!before) k = 0;
    // walk outwards from each row; stop at the first gap that is too large (footers, disclaimers)
    for (let i = 0; i < k; i++) { if (gaps[i] > maxDist) break; attach(before!, block[i], false); }
    const tail: TextItem[] = [];
    for (let i = block.length - 1; i >= k; i--) { if (gaps[i + 1] > maxDist) break; tail.push(block[i]); }
    for (const t of tail) attach(after!, t, true);
  };
  let block: TextItem[] = [];
  let prev: Row | undefined;
  for (const it of items) {
    if (it.kind === "text") { block.push(it); continue; }
    if (it.kind === "barrier") { settle(block, prev, undefined); block = []; continue; }
    settle(block, prev, it.row);
    block = [];
    rows.push(it.row);
    prev = it.row;
  }
  settle(block, prev, undefined);

  // Join narration fragments. Banks wrap long narrations either at a fixed number of characters
  // (cutting words) or at the column edge. Detect a fixed wrap width from the data: if most
  // non-final lines have the same length, lines of exactly that length were cut mid-word.
  const narrMax = Math.max(...rows.flatMap((r) => r.narr.map((f) => f.x1)), 0);
  const lens = new Map<number, number>();
  let nonFinal = 0;
  for (const r of rows) for (let i = 0; i < r.narr.length - 1; i++) { nonFinal++; lens.set(r.narr[i].text.length, (lens.get(r.narr[i].text.length) ?? 0) + 1); }
  const [modeLen, modeCount] = [...lens.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const fixedWidth = nonFinal >= 3 && modeCount / nonFinal >= 0.6 ? modeLen : 0;
  const joinNarr = (frags: Frag[]) => frags.reduce((acc, f, i) => {
    if (i === 0) return f.text;
    const prevF = frags[i - 1];
    const wordChars = /[\w\/@.\-:]$/.test(acc) && /^[\w\/@.\-:]/.test(f.text);
    // (renderers only cut mid-word when one token is longer than the whole line, i.e. the line has no spaces)
    const cut = wordChars && (fixedWidth ? prevF.text.length === fixedWidth : prevF.x1 >= narrMax - 6 && !/\s/.test(prevF.text));
    // a soft break right after a separator such as / * @ (or "x-") never had a space
    const afterSeparator = /[\/*@_|]$|\w-$/.test(acc) || /^[\/*@_|]/.test(f.text);
    return acc + (cut || afterSeparator ? "" : " ") + f.text;
  }, "");

  // Order: newest first if dates mostly go down
  let up = 0, down = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].date > rows[i - 1].date) up++;
    else if (rows[i].date < rows[i - 1].date) down++;
  }
  const order = down > up ? "newest_first" : "oldest_first";
  if (order === "newest_first") rows.reverse();

  // Reconcile with running balance
  const recon = { rows_with_balance: 0, matched: 0, auto_fixed_direction: 0, mismatches: [] as PdfStatement["reconciliation"]["mismatches"], verdict: "" };
  let running = opening;
  const txns: PdfTxn[] = [];
  rows.forEach((r, idx) => {
    const narration = joinNarr(r.narr).replace(/\s+/g, " ").trim();
    let debit = r.debit ?? 0, credit = r.credit ?? 0;
    let unknown = false;
    if (r.amount !== undefined && r.debit === undefined && r.credit === undefined) {
      if (r.type === "credit") credit = r.amount;
      else if (r.type === "debit") debit = r.amount;
      else unknown = true;
    }
    const amt = unknown ? r.amount! : 0;
    if (r.balance !== undefined && running !== undefined) {
      recon.rows_with_balance++;
      const diff = round2(r.balance - running);
      if (unknown) {
        if (Math.abs(diff - amt) < 0.015) { credit = amt; unknown = false; recon.matched++; }
        else if (Math.abs(diff + amt) < 0.015) { debit = amt; unknown = false; recon.matched++; }
      } else {
        const expected = round2(credit - debit);
        if (Math.abs(diff - expected) < 0.015) recon.matched++;
        else if (Math.abs(diff + expected) < 0.015) { [debit, credit] = [credit, debit]; recon.matched++; recon.auto_fixed_direction++; }
        else recon.mismatches.push({ row: idx + 1, date: r.date, narration: narration.slice(0, 80), expected_balance: round2(running + expected), statement_balance: r.balance });
      }
    }
    if (unknown) {
      // no balance to check against: fall back on wording
      if (/\b(cr|credit|salary|refund|reversal|interest|deposit|received|from)\b/i.test(narration)) credit = amt; else debit = amt;
      warnings.push(`Row ${idx + 1} (${r.date}): direction guessed as ${credit ? "credit" : "debit"} from the narration.`);
    }
    if (r.balance !== undefined) running = r.balance;
    else if (running !== undefined) running = round2(running + credit - debit);
    txns.push({
      date: r.date, narration, debit, credit,
      ...(r.balance !== undefined ? { balance: r.balance } : {}),
      ...(r.ref.length ? { ref: r.ref.reduce((a, x) => a + (/[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(x) && !/\s/.test(a) ? "" : " ") + x) } : {}),
      ...(r.value_date ? { value_date: r.value_date } : {}),
    });
  });

  const checkable = recon.rows_with_balance;
  recon.verdict = !checkable
    ? "Could not check against balances (no balance column or opening balance)."
    : recon.mismatches.length === 0
      ? `All ${checkable} rows with a balance agree with the running balance.`
      : `${recon.mismatches.length} of ${checkable} rows do not agree with the running balance. A row may be missing or misread around those dates; check them against the PDF.`;
  if (opening === undefined && rows.length && rows[0].balance !== undefined) {
    // the first row could not be checked; derive opening balance from it
    opening = round2(rows[0].balance - (txns[0].credit - txns[0].debit));
  }

  const bank = detectBank(firstPageText);
  const acct = firstPageText.match(/(?:a\/?c|account)\s*(?:no\.?|number)?\s*[:\-]?\s*[X*x\d][X*x\d\s-]{5,}(\d{4})\b/i);

  return {
    bank,
    account_last4: acct?.[1],
    pages,
    order,
    opening_balance: opening,
    closing_balance: txns.length ? txns[txns.length - 1].balance : undefined,
    columns: Object.fromEntries(headerCols.map((c) => [c.role, c.title])),
    transactions: txns,
    reconciliation: recon,
    warnings,
    ...(opts.debug ? { layout_preview: maskedPreview(lines) } : {}),
  };
}

/** Layout with every letter and digit masked, safe to paste into a bug report. Header words are kept. */
function maskedPreview(lines: Line[], max = 60): string[] {
  return lines.slice(0, max).map((l) => `p${l.page} y${Math.round(l.y)}: ` + l.segs.map((s) => {
    const keep = roleOf(s.text) !== undefined && s.text.length < 40;
    const t = keep ? s.text : s.text.replace(/[A-Za-z]/g, "x").replace(/\d/g, "9");
    return `[${Math.round(s.x0)}-${Math.round(s.x1)}] ${t}`;
  }).join("  "));
}

/** @internal exported for tests */
export const _internals = { groupLines, roleOf, isAmount, detectBank };
