// GST rates for goods, from the Gazette of India rate notifications.
// Data: data/gst_rates.json, built by scripts/build_gst_rates.py from Notification 09/2025-Central Tax (Rate)
// (rate schedules) and 10/2025-Central Tax (Rate) (exemptions), with every later amendment applied.
import { readFileSync } from "node:fs";
import { lookupHsnSac, searchHsnSac, stem, tokenize } from "./hsn.js";

interface RateEntry {
  ref: string; notification: string; schedule: string; sno: string;
  codes: string[]; except: string[]; any_chapter: boolean; no_code?: boolean;
  codes_text: string; description: string;
  gst: number; cgst: number; sgst_utgst: number; igst: number;
  amended_by?: { by: string; from: string; change: string; previous?: string }[];
}
interface RateData {
  sources: { notification: string; gazette_id: string; url: string; effective: string; summary?: string }[];
  schedule_rates: Record<string, number>;
  in_force_as_of: string;
  valid_as_of: string;
  lists: { notification: string; title: string; refers_to: string; text: string }[];
  omitted: RateEntry[];
  entries: RateEntry[];
}

let data: RateData | undefined;
let textIndex: { e: RateEntry; tokens: Set<string> }[] | undefined;
let idf: Map<string, number> | undefined;

function load(): RateData {
  if (!data) data = JSON.parse(readFileSync(new URL("../data/gst_rates.json", import.meta.url), "utf8")) as RateData;
  return data;
}

const RESIDUAL = /^Goods which are not specified in Schedule/i;

export function ratesSource() {
  const d = load();
  return {
    in_force_as_of: d.in_force_as_of,
    basis: d.valid_as_of,
    notifications: d.sources.map((s) => ({ notification: s.notification, gazette_id: s.gazette_id, effective: s.effective, url: s.url })),
  };
}

function scheduleLabel(e: RateEntry) {
  return e.schedule === "Exempt" ? "Exempt (nil rate)" : `Schedule ${e.schedule}`;
}

function listFor(e: RateEntry) {
  const d = load();
  const nums = e.description.match(/(List\s+\d+|Annexure\s*-?\s*[IVX]+)/i);
  if (!nums) return undefined;
  const key = nums[1].replace(/\s|-/g, "").toLowerCase();
  const l = d.lists.find((x) => x.notification === e.notification && x.title.replace(/\s|-/g, "").toLowerCase().startsWith(key));
  return l ? { title: l.title, text: l.text } : undefined;
}

function view(e: RateEntry, match: string) {
  const list = listFor(e);
  return {
    gst_rate: e.gst,
    split: { cgst: e.cgst, sgst_or_utgst: e.sgst_utgst, igst: e.igst },
    entry: `${e.notification}, ${scheduleLabel(e)}, S.No. ${e.sno}`,
    applies_to_codes: e.codes_text || (e.any_chapter ? "Any chapter" : "—"),
    description: e.description,
    match,
    ...(e.amended_by?.length ? { amended_by: e.amended_by.map((a) => `${a.by} (from ${a.from}): ${a.change}`) } : {}),
    ...(list ? { referenced_list: list } : {}),
  };
}

/** Rate entries that apply to an HSN code (goods). */
export function gstRatesForCode(code: string, opts: { product?: string; limit?: number } = {}) {
  const d = load();
  const c = code.replace(/[\s.]/g, "");
  if (!/^\d{2,8}$/.test(c)) throw new Error(`"${code}" is not an HSN code (2 to 8 digits).`);
  if (c.length < 4 && !c.startsWith("99")) throw new Error(`Give at least a 4-digit HSN heading: a whole chapter (${c}) contains goods at many different rates. Use search_hsn_sac to find the heading.`);
  if (c.startsWith("99")) {
    return {
      code: c,
      services: true,
      message: "SAC (service) codes are not covered yet: service rates are spread across Notification 11/2017-Central Tax (Rate) and its many amendments. Confirm the rate for this service with the CBIC notification or a CA, and pass it to calculate_gst.",
      source: ratesSource(),
    };
  }
  const hsn = lookupHsnSac(c);
  type Cand = { e: RateEntry; kind: "covers" | "within"; spec: number };
  const cands: Cand[] = [];
  for (const e of d.entries) {
    if (e.except.some((x) => c.startsWith(x))) continue;
    let best: Cand | undefined;
    for (const ec of e.codes) {
      if (c.startsWith(ec)) { if (!best || best.kind !== "covers" || ec.length > best.spec) best = { e, kind: "covers", spec: ec.length }; }
      else if (ec.startsWith(c) && (!best)) best = { e, kind: "within", spec: ec.length };
    }
    if (best) cands.push(best);
  }
  // product words help rank entries whose description matches what is being sold
  const pTokens = opts.product ? new Set(tokenize(opts.product)) : undefined;
  const pScore = (e: RateEntry) => {
    if (!pTokens?.size) return 0;
    const dt = new Set(tokenize(e.description));
    let s = 0;
    for (const t of pTokens) if ([...dt].some((x) => x === t || (t.length >= 4 && x.startsWith(t)))) s++;
    return s / pTokens.size;
  };
  cands.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "covers" ? -1 : 1) || pScore(b.e) - pScore(a.e) || b.spec - a.spec || a.e.gst - b.e.gst);

  // Entries listed against a whole chapter are mostly special-purpose (renewable energy devices, parts of
  // specified machinery, e-waste ...). Keep them, but base the likely rates on heading-level or finer entries.
  const covering = cands.filter((x) => x.kind === "covers");
  const specific = covering.filter((x) => x.spec >= 4);
  const broad = covering.filter((x) => x.spec < 4);
  const main = specific.length ? specific : broad;
  const taxableMain = main.filter((x) => x.e.schedule !== "Exempt");
  const residual = d.entries.find((e) => e.any_chapter && RESIDUAL.test(e.description));
  const limit = Math.min(opts.limit ?? 12, 40);
  const label = (spec: number) => (spec === 2 ? "chapter" : spec === 4 ? "heading" : spec === 6 ? "sub-heading" : "tariff item");
  const mk = ({ e, kind, spec }: Cand) =>
    view(e, kind === "covers" ? `applies to ${c} (listed under ${label(spec)} ${e.codes.find((x) => c.startsWith(x))})` : `applies to some codes under ${c} only`);
  const ordered = [...main, ...cands.filter((x) => x.kind === "within")];
  const results = ordered.slice(0, limit).map(mk);
  if (!taxableMain.length && residual) results.push(view(residual, "residual entry: goods not specified in any other schedule"));
  const special = specific.length ? broad.slice(0, 10).map(mk) : [];

  const rates = [...new Set([...main.map((x) => x.e.gst), ...(!taxableMain.length && residual ? [residual.gst] : [])])].sort((a, b) => a - b);
  return {
    code: c,
    hsn_description: "description" in hsn ? hsn.description : undefined,
    ...(hsn.found ? {} : { warning: `${c} is not in the official HSN list; results are by code prefix only.` }),
    possible_rates: rates,
    how_to_choose: rates.length > 1
      ? "Several entries cover this code. The right one depends on the exact goods and conditions in the description (for example 'pre-packaged and labelled', 'other than ...'). An exemption entry applies when its description fits."
      : "One rate applies to this code, provided the goods match the entry's description.",
    candidates: results,
    ...(special.length ? { special_purpose_entries: special, special_purpose_note: "These entries are listed against the whole chapter and apply only to the specific goods they describe (e.g. renewable energy devices, parts of specified machinery). They are not in possible_rates." } : {}),
    total_candidates: cands.length,
    notes: [
      "Rates in force under the notifications listed in `source`. Total GST = CGST + SGST/UTGST for intra-state supplies, or IGST for inter-state supplies.",
      "Some entries apply to goods of any chapter by description (e.g. puja samagri, rosaries, biomass pellets). Search by product name to see them.",
      "Compensation cess is nil from 1 February 2026 (Notification 03/2025-Compensation Cess (Rate)).",
      "Classification and the choice of entry are the taxpayer's responsibility; confirm with a CA when unsure.",
    ],
    source: ratesSource(),
  };
}

function buildTextIndex() {
  if (textIndex) return textIndex;
  const d = load();
  textIndex = d.entries.map((e) => ({ e, tokens: new Set(tokenize(e.description)) }));
  const df = new Map<string, number>();
  for (const { tokens } of textIndex) for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  idf = new Map([...df].map(([t, n]) => [t, Math.log(1 + textIndex!.length / n)]));
  return textIndex;
}

/** Search the rate notifications' own descriptions, e.g. "namkeen", "puja samagri", "electric vehicle". */
export function gstRatesForProduct(product: string, opts: { limit?: number } = {}) {
  const idx = buildTextIndex();
  const q = [...new Set(tokenize(product))];
  if (!q.length) throw new Error("Describe the product in a few words.");
  const scored = idx.map(({ e, tokens }) => {
    let s = 0, hit = 0;
    for (const t of q) {
      let w = 0;
      for (const x of tokens) {
        if (x === t) w = Math.max(w, idf!.get(x)!);
        else if (t.length >= 4 && x.startsWith(t)) w = Math.max(w, idf!.get(x)! * 0.7);
        else if (x.length >= 5 && stem(t).startsWith(x)) w = Math.max(w, idf!.get(x)! * 0.6);
      }
      if (w) { s += w; hit++; }
    }
    const coverage = hit / q.length;
    return { e, score: s * coverage * coverage, coverage };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  const limit = Math.min(opts.limit ?? 8, 30);
  const anyFull = scored.some((x) => x.coverage === 1);
  const codes = searchHsnSac(product, { type: "goods", limit: 5 });
  return {
    product,
    ...(anyFull ? {} : { note: "No rate entry mentions every word of the query; these are partial matches. Try the official wording, or look up the HSN code instead." }),
    candidates: scored.slice(0, limit).map((x) => ({ ...view(x.e, x.coverage === 1 ? "description mentions every word of the query" : "partial match"), matched_all_words: x.coverage === 1 })),
    suggested_hsn_codes: codes.results.map((r) => ({ code: r.code, description: r.description })),
    notes: [
      "Each candidate is an entry in the official rate notifications. Check the entry's codes and conditions against the actual goods.",
      "For a definite answer, find the HSN code (search_hsn_sac) and call find_gst_rate with it.",
    ],
    source: ratesSource(),
  };
}

/** For invoice checks: the rates that could apply to this goods HSN code, or undefined if not determinable. */
export function plausibleRates(code: string): number[] | undefined {
  const c = code.replace(/[\s.]/g, "");
  if (!/^\d{4,8}$/.test(c) || c.startsWith("99")) return undefined;
  const r = gstRatesForCode(c, { limit: 40 }) as { possible_rates?: number[] };
  return r.possible_rates?.length ? r.possible_rates : undefined;
}
