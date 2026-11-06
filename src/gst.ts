// GST helpers: GSTIN validation, tax split (CGST/SGST/UTGST/IGST), amount in words.

export const STATE_CODES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Daman and Diu (old code)",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh (old code)",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Centre Jurisdiction",
};

/** Union territories without a legislature levy UTGST instead of SGST. */
const UTGST_STATES = new Set(["04", "25", "26", "31", "35", "38", "97"]);

const PAN_ENTITY: Record<string, string> = {
  P: "Individual",
  C: "Company",
  H: "Hindu Undivided Family (HUF)",
  F: "Firm / LLP",
  A: "Association of Persons (AOP)",
  T: "Trust",
  B: "Body of Individuals (BOI)",
  L: "Local Authority",
  J: "Artificial Juridical Person",
  G: "Government",
};

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function gstinChecksum(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GSTIN_CHARS.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36];
}

export interface GstinResult {
  gstin: string;
  valid: boolean;
  errors: string[];
  state_code?: string;
  state?: string;
  pan?: string;
  entity_type?: string;
  registration_number?: string;
}

export function validateGstin(input: string): GstinResult {
  const gstin = input.trim().toUpperCase().replace(/\s+/g, "");
  const errors: string[] = [];
  if (gstin.length !== 15) {
    errors.push(`GSTIN must be 15 characters (got ${gstin.length}).`);
    return { gstin, valid: false, errors };
  }
  // Regular taxpayers: 2 digits, PAN (5 letters, 4 digits, 1 letter), entity no., 'Z', checksum.
  // Special registrations (TDS/TCS, UN bodies, NRTP) use other patterns in the PAN part, so we
  // only require alphanumerics there and report the PAN-based fields when the shape matches.
  if (!/^[0-9]{2}[0-9A-Z]{10}[1-9A-Z][0-9A-Z][0-9A-Z]$/.test(gstin)) {
    errors.push("GSTIN has invalid characters or structure.");
  }
  const stateCode = gstin.slice(0, 2);
  const state = STATE_CODES[stateCode];
  if (!state) errors.push(`Unknown state code "${stateCode}".`);
  const expected = gstinChecksum(gstin.slice(0, 14));
  if (gstin[14] !== expected) {
    errors.push(`Checksum mismatch: last character should be "${expected}", found "${gstin[14]}". Likely a typo.`);
  }
  const pan = gstin.slice(2, 12);
  const panLike = /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan);
  return {
    gstin,
    valid: errors.length === 0,
    errors,
    state_code: stateCode,
    state,
    pan: panLike ? pan : undefined,
    entity_type: panLike ? PAN_ENTITY[pan[3]] ?? "Unknown" : undefined,
    registration_number: gstin[12],
  };
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function resolveStateCode(input: string): string | undefined {
  const s = input.trim();
  if (/^\d{1,2}$/.test(s)) {
    const code = s.padStart(2, "0");
    return STATE_CODES[code] ? code : undefined;
  }
  if (/^\d{2}[0-9A-Z]{13}$/i.test(s)) return s.slice(0, 2); // a GSTIN
  const lower = s.toLowerCase();
  const aliases: Record<string, string> = {
    "new delhi": "07", "nct of delhi": "07", up: "09", mp: "23", "j&k": "01", jk: "01",
    tn: "33", ap: "37", wb: "19", ka: "29", mh: "27", gj: "24", ts: "36", tg: "36",
    "andaman": "35", "pondicherry": "34", "orissa": "21", "bombay": "27",
  };
  if (aliases[lower]) return aliases[lower];
  const found = Object.entries(STATE_CODES).find(
    ([code, name]) => !name.includes("old code") && name.toLowerCase() === lower,
  ) ?? Object.entries(STATE_CODES).find(
    ([, name]) => !name.includes("old code") && name.toLowerCase().startsWith(lower),
  );
  return found?.[0];
}

export interface LineItemInput {
  description: string;
  hsn_sac?: string;
  quantity: number;
  unit?: string;
  rate: number; // price per unit
  gst_rate: number; // percent, e.g. 18
  discount?: number; // flat amount off this line
  cess_rate?: number; // percent
}

export interface TaxLine extends LineItemInput {
  taxable_value: number;
  cgst: number;
  sgst: number;
  utgst: number;
  igst: number;
  cess: number;
  total: number;
}

export interface TaxResult {
  supply_type: "intra-state" | "inter-state";
  supplier_state: string;
  place_of_supply: string;
  tax_heads: string[];
  prices_include_gst: boolean;
  lines: TaxLine[];
  totals: {
    taxable_value: number;
    cgst: number;
    sgst: number;
    utgst: number;
    igst: number;
    cess: number;
    total_tax: number;
    grand_total_before_round_off: number;
    round_off: number;
    grand_total: number;
  };
  amount_in_words: string;
}

export function calculateGst(opts: {
  supplier_state: string;
  place_of_supply: string;
  items: LineItemInput[];
  prices_include_gst?: boolean;
  round_off?: boolean;
}): TaxResult {
  const sup = resolveStateCode(opts.supplier_state);
  const pos = resolveStateCode(opts.place_of_supply);
  if (!sup) throw new Error(`Unrecognised supplier state: "${opts.supplier_state}". Use a state name, 2-digit code, or GSTIN.`);
  if (!pos) throw new Error(`Unrecognised place of supply: "${opts.place_of_supply}". Use a state name, 2-digit code, or GSTIN.`);
  const intra = sup === pos;
  const useUtgst = intra && UTGST_STATES.has(pos);
  const inclusive = opts.prices_include_gst ?? false;

  const lines: TaxLine[] = opts.items.map((it) => {
    const gross = it.quantity * it.rate - (it.discount ?? 0);
    const totalRate = it.gst_rate + (it.cess_rate ?? 0);
    const taxable = round2(inclusive ? gross / (1 + totalRate / 100) : gross);
    let cgst = 0, sgst = 0, utgst = 0, igst = 0;
    if (intra) {
      const half = round2((taxable * it.gst_rate) / 200);
      cgst = half;
      if (useUtgst) utgst = half;
      else sgst = half;
    } else {
      igst = round2((taxable * it.gst_rate) / 100);
    }
    const cess = round2((taxable * (it.cess_rate ?? 0)) / 100);
    return { ...it, taxable_value: taxable, cgst, sgst, utgst, igst, cess, total: round2(taxable + cgst + sgst + utgst + igst + cess) };
  });

  const sum = (k: keyof TaxLine) => round2(lines.reduce((a, l) => a + (l[k] as number), 0));
  const taxable_value = sum("taxable_value");
  const cgst = sum("cgst"), sgst = sum("sgst"), utgst = sum("utgst"), igst = sum("igst"), cess = sum("cess");
  const total_tax = round2(cgst + sgst + utgst + igst + cess);
  const before = round2(taxable_value + total_tax);
  const grand = opts.round_off === false ? before : Math.round(before);
  const tax_heads = intra ? ["CGST", useUtgst ? "UTGST" : "SGST"] : ["IGST"];
  if (cess > 0) tax_heads.push("Cess");

  return {
    supply_type: intra ? "intra-state" : "inter-state",
    supplier_state: `${STATE_CODES[sup]} (${sup})`,
    place_of_supply: `${STATE_CODES[pos]} (${pos})`,
    tax_heads,
    prices_include_gst: inclusive,
    lines,
    totals: {
      taxable_value, cgst, sgst, utgst, igst, cess, total_tax,
      grand_total_before_round_off: before,
      round_off: round2(grand - before),
      grand_total: grand,
    },
    amount_in_words: amountInWords(grand),
  };
}

// ---------- Amount in words (Indian numbering: thousand, lakh, crore) ----------

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? "-" + ONES[n % 10] : "");
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? belowHundred(r) : ""].filter(Boolean).join(" ");
}

export function integerInWords(n: number): string {
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7);
  n %= 1e7;
  const lakh = Math.floor(n / 1e5);
  n %= 1e5;
  const thousand = Math.floor(n / 1e3);
  n %= 1e3;
  if (crore) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (n) parts.push(belowThousand(n));
  return parts.join(" ");
}

export function amountInWords(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Amount must be a non-negative number.");
  const rupees = Math.floor(round2(amount));
  const paise = Math.round(round2(amount - rupees) * 100);
  let s = `Rupees ${integerInWords(rupees)}`;
  if (paise) s += ` and ${belowHundred(paise)} Paise`;
  return s + " Only";
}

/** Format a number the Indian way: 12,34,567.89 */
export function formatINR(n: number): string {
  return n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
