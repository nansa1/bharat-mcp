// Network lookups using free public APIs (no API key needed).
//  - IFSC: Razorpay's open IFSC API (https://github.com/razorpay/ifsc)
//  - PIN code: India Post data via api.postalpincode.in

const UA = { "User-Agent": "bharat-mcp (+https://github.com/)" };

async function getJson(url: string, timeoutMs = 10000): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body };
}

export async function lookupIfsc(code: string) {
  const ifsc = code.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw new Error(`"${code}" is not a valid IFSC format (4 letters, then 0, then 6 letters/digits, e.g. HDFC0000001).`);
  }
  const base = process.env.BHARAT_MCP_IFSC_API ?? "https://ifsc.razorpay.com";
  const { status, body } = await getJson(`${base}/${ifsc}`);
  if (status === 404) return { ifsc, found: false, message: "No bank branch found for this IFSC." };
  if (status !== 200 || typeof body !== "object" || !body) throw new Error(`IFSC lookup failed (HTTP ${status}).`);
  const b = body as Record<string, unknown>;
  return {
    ifsc,
    found: true,
    bank: b.BANK, branch: b.BRANCH, address: b.ADDRESS, city: b.CITY, district: b.DISTRICT, state: b.STATE,
    contact: b.CONTACT || undefined, micr: b.MICR || undefined, swift: b.SWIFT || undefined,
    supports: { upi: b.UPI, imps: b.IMPS, neft: b.NEFT, rtgs: b.RTGS },
  };
}

export async function lookupPincode(pin: string) {
  const p = pin.trim();
  if (!/^[1-9][0-9]{5}$/.test(p)) throw new Error(`"${pin}" is not a valid 6-digit Indian PIN code.`);
  const base = process.env.BHARAT_MCP_PINCODE_API ?? "https://api.postalpincode.in";
  const { status, body } = await getJson(`${base}/pincode/${p}`);
  if (status !== 200 || !Array.isArray(body)) throw new Error(`PIN code lookup failed (HTTP ${status}).`);
  const r = body[0] as { Status?: string; PostOffice?: Record<string, string>[] | null };
  if (r?.Status !== "Success" || !r.PostOffice?.length) return { pincode: p, found: false, message: "No post offices found for this PIN code." };
  const po = r.PostOffice;
  return {
    pincode: p,
    found: true,
    district: po[0].District,
    state: po[0].State,
    region: po[0].Region,
    division: po[0].Division,
    post_offices: po.map((o) => ({ name: o.Name, type: o.BranchType, delivery: o.DeliveryStatus, block: o.Block })),
  };
}
