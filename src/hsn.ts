// HSN (goods) and SAC (services) code search over the GST portal's official master list.
// Data: data/hsn_sac.json, built by scripts/build_hsn_data.py from https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx
import { readFileSync } from "node:fs";

interface Entry {
  code: string;
  kind: "goods" | "services";
  description: string; // the code's own description
  context: string[]; // broader descriptions published with it, if any
  tokens: Map<string, number>; // token -> weight (1 own text, 0.5 context)
}

interface Dataset {
  source: { name: string; url: string; sha256: string; downloaded: string; hsn_codes: number; sac_codes: number };
  byCode: Map<string, Entry>;
  entries: Entry[];
  index: Map<string, Entry[]>;
  idf: Map<string, number>;
  vocab: string[];
}

let data: Dataset | undefined;

const STOP = new Set(["of", "and", "or", "the", "a", "an", "for", "in", "on", "with", "without", "to", "by", "not", "other", "than", "its", "their", "whether", "including", "etc", "as", "such", "nes", "n", "e", "s", "kind", "used", "type"]);

export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t)).map(stem);
}

/**
 * Everyday Indian names that don't appear in the tariff wording. Each value lists alternative
 * phrases separated by "|"; an alternative matches only if all of its words match. Results
 * still come only from the official list, and tests check every mapping finds codes.
 */
const SYNONYMS: Record<string, string> = {
  mobile: "smartphones|telephones cellular networks",
  smartphone: "smartphones",
  cellphone: "telephones cellular networks",
  laptop: "portable automatic data processing machines",
  notebook_computer: "portable automatic data processing machines",
  computer: "automatic data processing machines",
  atta: "wheat meslin flour",
  maida: "wheat flour",
  dal: "leguminous vegetables dried shelled",
  paneer: "curd|cheese",
  dahi: "curd",
  chawal: "rice",
  chini: "cane sugar",
  bulb: "lamps",
  ac: "air conditioning machines|air conditioner",
  fridge: "refrigerators",
  tv: "television",
  bike: "motorcycles",
  car: "motor cars",
  scooty: "scooters|motorcycles",
  ca: "accounting|auditing",
  chartered: "accounting|auditing",
  accountant: "accounting|auditing|bookkeeping",
  software_development: "information technology design development",
  gold: "precious metal",
  app: "software",
  stay: "accommodation",
  hotel: "accommodation",
  salon: "hairdressing|beauty",
  gym: "fitness",
  tuition: "education",
  coaching: "education",
  rent: "rental|leasing",
  incense: "agarbatti|odoriferous preparations",
  sari: "saree",
};

function load(): Dataset {
  if (data) return data;
  const raw = JSON.parse(readFileSync(new URL("../data/hsn_sac.json", import.meta.url), "utf8")) as {
    source: Dataset["source"]; goods: [string, string[]][]; services: [string, string[]][];
  };
  const entries: Entry[] = [];
  for (const [kind, list] of [["goods", raw.goods], ["services", raw.services]] as const) {
    for (const [code, parts] of list) {
      const description = parts[parts.length - 1];
      const context = parts.slice(0, -1);
      const tokens = new Map<string, number>();
      for (const t of tokenize(context.join(" "))) tokens.set(t, 0.5);
      for (const t of tokenize(description)) tokens.set(t, 1);
      entries.push({ code, kind, description, context, tokens });
    }
  }
  const byCode = new Map(entries.map((e) => [e.code, e]));
  // Inherit words from parent codes at low weight, so "smartphones" also finds its heading context
  for (const e of entries) {
    // headings and sub-headings only: chapter titles are long catch-all lists that add noise
    for (const len of [4, 6]) {
      if (e.code.length <= len) break;
      const parent = byCode.get(e.code.slice(0, len));
      if (!parent) continue;
      for (const t of tokenize(parent.description)) if (!e.tokens.has(t)) e.tokens.set(t, 0.25);
    }
  }
  const index = new Map<string, Entry[]>();
  for (const e of entries) for (const t of e.tokens.keys()) {
    const l = index.get(t);
    if (l) l.push(e); else index.set(t, [e]);
  }
  const idf = new Map<string, number>();
  for (const [t, l] of index) idf.set(t, Math.log(1 + entries.length / l.length));
  data = { source: raw.source, byCode, entries, index, idf, vocab: [...index.keys()] };
  return data;
}

export function hsnSource() {
  return load().source;
}

const LEVEL: Record<number, string> = { 2: "chapter", 4: "heading", 6: "sub-heading", 8: "tariff item" };
const SAC_LEVEL: Record<number, string> = { 2: "section", 4: "heading", 6: "service code" };

function levelOf(e: Entry) {
  return (e.kind === "goods" ? LEVEL : SAC_LEVEL)[e.code.length] ?? "code";
}

function parentsOf(e: Entry) {
  const d = load();
  const out: { code: string; description: string }[] = [];
  for (const len of [2, 4, 6]) {
    if (e.code.length <= len) break;
    const p = d.byCode.get(e.code.slice(0, len));
    if (p) out.push({ code: p.code, description: p.description });
  }
  return out;
}

function view(e: Entry, withParents = true) {
  return {
    code: e.code,
    type: e.kind === "goods" ? "HSN (goods)" : "SAC (services)",
    level: levelOf(e),
    description: e.description,
    ...(e.context.length ? { published_context: e.context } : {}),
    ...(withParents ? { within: parentsOf(e) } : {}),
  };
}

export function searchHsnSac(query: string, opts: { type?: "goods" | "services" | "any"; limit?: number } = {}) {
  const d = load();
  const limit = Math.min(opts.limit ?? 10, 50);
  const q = query.trim();
  if (!q) throw new Error("Give a product or service description, or a code.");

  // Code or code prefix
  const digits = q.replace(/[\s.]/g, "");
  if (/^\d{2,8}$/.test(digits)) {
    const hits = d.entries.filter((e) => e.code.startsWith(digits) && (opts.type ?? "any") !== (e.kind === "goods" ? "services" : "goods"));
    return {
      query, match_type: "code_prefix", total_matches: hits.length,
      results: hits.slice(0, limit).map((e) => view(e)),
      source: d.source,
    };
  }

  // Each word the user typed is one concept: matched by the word itself or by any of its
  // synonyms (everyday Indian names -> tariff wording). Coverage counts concepts, not tokens.
  const text = q.toLowerCase().replace(/notebook computer/g, "notebook_computer").replace(/software development/g, "software_development");
  // groups[i] = alternatives for word i; each alternative is a list of tokens that must all match
  const groups: string[][][] = [];
  const used: Record<string, string> = {};
  for (const w of text.split(/[^a-z0-9_]+/).filter(Boolean)) {
    const own = tokenize(w.replace(/_/g, " "));
    const syn = SYNONYMS[w] ?? SYNONYMS[stem(w)];
    if (syn) used[w.replace(/_/g, " ")] = syn.split("|").join(" / ");
    const alts = [own, ...(syn ? syn.split("|").map(tokenize) : [])].filter((a) => a.length);
    if (alts.length) groups.push(alts);
  }
  if (!groups.length) throw new Error("The query only had very common words; describe the product or service more specifically.");

  const variantCache = new Map<string, [string, number][]>();
  const variants = (t: string) => {
    let v = variantCache.get(t);
    if (!v) {
      v = t.length >= 4 ? d.vocab.filter((x) => x.startsWith(t)).map((x) => [x, x === t ? 1 : 0.6] as [string, number]) : d.index.has(t) ? [[t, 1]] : [];
      variantCache.set(t, v);
    }
    return v;
  };
  const tokenScores = (t: string) => {
    const best = new Map<Entry, number>();
    for (const [v, f] of variants(t)) {
      const idf = d.idf.get(v)! * f;
      for (const e of d.index.get(v)!) {
        const w = e.tokens.get(v)! * idf;
        if (w > (best.get(e) ?? 0)) best.set(e, w);
      }
    }
    return best;
  };
  const scores = new Map<Entry, { score: number; matched: number }>();
  for (const alts of groups) {
    const groupBest = new Map<Entry, number>();
    for (const alt of alts) {
      const per = alt.map(tokenScores);
      // entries matching every token of this alternative; average so long phrases aren't favoured
      for (const [e, w0] of per[0]) {
        let sum = w0, ok = true;
        for (let i = 1; i < per.length && ok; i++) { const w = per[i].get(e); if (w === undefined) ok = false; else sum += w; }
        if (!ok) continue;
        const w = sum / Math.sqrt(alt.length);
        if (w > (groupBest.get(e) ?? 0)) groupBest.set(e, w);
      }
    }
    for (const [e, w] of groupBest) {
      const s = scores.get(e) ?? { score: 0, matched: 0 };
      s.score += w; s.matched++;
      scores.set(e, s);
    }
  }
  const type = opts.type ?? "any";
  const ranked = [...scores.entries()]
    .filter(([e]) => type === "any" || e.kind === type)
    .map(([e, s]) => {
      const coverage = s.matched / groups.length;
      // prefer full coverage; mild preference for specific codes and focused descriptions
      const specificity = e.code.length >= 6 ? 1.05 : 1;
      const focus = 1 / (1 + Math.max(0, e.description.length - 60) / 400);
      return { e, score: s.score * coverage * coverage * specificity * focus, coverage };
    })
    .sort((a, b) => b.score - a.score || a.e.code.localeCompare(b.e.code));
  const anyFull = ranked.some((r) => r.coverage === 1);

  return {
    query,
    match_type: "text",
    ...(Object.keys(used).length ? { interpreted_as: used } : {}),
    total_matches: ranked.length,
    ...(anyFull ? {} : { note: "No code matches every word of the query; these are partial matches. Try the official tariff wording or fewer words." }),
    results: ranked.slice(0, limit).map(({ e, coverage }) => ({ ...view(e), matched_all_words: coverage === 1 })),
    source: d.source,
  };
}

export function lookupHsnSac(code: string) {
  const d = load();
  const c = code.replace(/[\s.]/g, "");
  if (!/^\d{2,8}$/.test(c)) throw new Error(`"${code}" is not an HSN/SAC code (2 to 8 digits).`);
  const e = d.byCode.get(c);
  const guidance = "Tax invoices must show HSN/SAC: at least 4 digits on B2B invoices if aggregate turnover is up to ₹5 crore, and 6 digits on all invoices above ₹5 crore. Service (SAC) codes are 6 digits starting with 99.";
  if (!e) {
    let parent: Entry | undefined;
    for (const len of [6, 4, 2]) if (c.length > len && (parent = d.byCode.get(c.slice(0, len)))) break;
    return {
      code: c,
      found: false,
      message: parent
        ? `${c} is not in the official HSN/SAC list. The closest existing code above it is ${parent.code} (${parent.description}).`
        : `${c} is not in the official HSN/SAC list.`,
      ...(parent ? { nearest_parent: view(parent), sibling_codes: children(parent.code).slice(0, 30).map((x) => ({ code: x.code, description: x.description })) } : {}),
      source: d.source,
    };
  }
  const kids = children(c);
  return {
    found: true,
    ...view(e),
    ...(kids.length ? { sub_codes: kids.slice(0, 50).map((x) => ({ code: x.code, description: x.description })), sub_code_count: kids.length } : {}),
    invoice_guidance: guidance,
    source: d.source,
  };
}

/** Next level of codes directly under a code (e.g. 4-digit heading -> its 6-digit sub-headings). */
function children(code: string): Entry[] {
  const d = load();
  const under = d.entries.filter((e) => e.code.length > code.length && e.code.startsWith(code));
  if (!under.length) return [];
  const next = Math.min(...under.map((e) => e.code.length));
  return under.filter((e) => e.code.length === next);
}

/** For invoice validation: is this an official HSN/SAC code? */
export function isKnownHsnSac(code: string): boolean {
  return load().byCode.has(code.replace(/[\s.]/g, ""));
}
