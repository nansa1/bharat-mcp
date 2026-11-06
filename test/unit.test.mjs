import { test } from "node:test";
import assert from "node:assert/strict";
import { validateGstin, gstinChecksum, calculateGst, amountInWords, resolveStateCode } from "../dist/gst.js";
import { parseUpiNarration, parseIndianDate, parseAmount, analyse, loadStatement } from "../dist/upi.js";

test("GSTIN: known valid sample passes and decodes", () => {
  const r = validateGstin("27aapfu0939f1zv");
  assert.equal(r.valid, true, r.errors.join());
  assert.equal(r.state, "Maharashtra");
  assert.equal(r.pan, "AAPFU0939F");
  assert.equal(r.entity_type, "Firm / LLP");
});

test("GSTIN: typo is caught by checksum", () => {
  const r = validateGstin("27AAPFU0939F1ZX");
  assert.equal(r.valid, false);
  assert.match(r.errors.join(), /should be "V"/);
});

test("GSTIN: wrong length / bad state", () => {
  assert.equal(validateGstin("27AAPFU0939F1Z").valid, false);
  const bad = "50AAPFU0939F1Z";
  assert.equal(validateGstin(bad + gstinChecksum(bad)).valid, false);
});

test("state resolution", () => {
  assert.equal(resolveStateCode("Karnataka"), "29");
  assert.equal(resolveStateCode("7"), "07");
  assert.equal(resolveStateCode("tamil"), "33");
  assert.equal(resolveStateCode("Andhra Pradesh"), "37");
  assert.equal(resolveStateCode("27AAPFU0939F1ZV"), "27");
});

test("GST intra-state splits CGST+SGST", () => {
  const r = calculateGst({ supplier_state: "Maharashtra", place_of_supply: "27", items: [{ description: "Design", quantity: 1, rate: 10000, gst_rate: 18 }] });
  assert.equal(r.supply_type, "intra-state");
  assert.equal(r.totals.cgst, 900);
  assert.equal(r.totals.sgst, 900);
  assert.equal(r.totals.igst, 0);
  assert.equal(r.totals.grand_total, 11800);
});

test("GST inter-state uses IGST; UT uses UTGST", () => {
  const inter = calculateGst({ supplier_state: "Karnataka", place_of_supply: "Delhi", items: [{ description: "x", quantity: 2, rate: 500, gst_rate: 5 }] });
  assert.equal(inter.totals.igst, 50);
  const ut = calculateGst({ supplier_state: "Chandigarh", place_of_supply: "Chandigarh", items: [{ description: "x", quantity: 1, rate: 1000, gst_rate: 18 }] });
  assert.deepEqual(ut.tax_heads, ["CGST", "UTGST"]);
  assert.equal(ut.totals.utgst, 90);
});

test("GST inclusive pricing back-calculates", () => {
  const r = calculateGst({ supplier_state: "29", place_of_supply: "29", prices_include_gst: true, round_off: false, items: [{ description: "x", quantity: 1, rate: 1180, gst_rate: 18 }] });
  assert.equal(r.totals.taxable_value, 1000);
  assert.equal(r.totals.grand_total, 1180);
});

test("amount in words, Indian system", () => {
  assert.equal(amountInWords(0), "Rupees Zero Only");
  assert.equal(amountInWords(11800), "Rupees Eleven Thousand Eight Hundred Only");
  assert.equal(amountInWords(123456789.5), "Rupees Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine and Fifty Paise Only");
  assert.equal(amountInWords(100000), "Rupees One Lakh Only");
});

test("UPI narration formats from different banks", () => {
  const sbi = parseUpiNarration("UPI/DR/412345678901/SWIGGY/YESB/swiggy@ybl/Payment");
  assert.equal(sbi.direction, "debit"); assert.equal(sbi.payee, "Swiggy"); assert.equal(sbi.vpa, "swiggy@ybl");
  assert.equal(sbi.rrn, "412345678901"); assert.match(sbi.psp_bank, /PhonePe/);

  const hdfc = parseUpiNarration("UPI-RAHUL SHARMA-rahul.sharma@okaxis-UTIB0000123-421234567892-RENT AUG");
  assert.equal(hdfc.payee, "Rahul Sharma"); assert.equal(hdfc.rrn, "421234567892"); assert.equal(hdfc.type, "P2P");
  assert.equal(hdfc.note, "RENT AUG");

  const icici = parseUpiNarration("UPI/423456789012/Payment/zomato@hdfcbank/HDFC BANK LTD/ICI1234");
  assert.equal(icici.vpa, "zomato@hdfcbank"); assert.equal(icici.rrn, "423456789012");

  const axis = parseUpiNarration("UPI/P2M/423456789013/AMAZON PAY INDIA/UPI/YES BANK");
  assert.equal(axis.type, "P2M"); assert.equal(axis.payee, "Amazon Pay India");

  assert.equal(parseUpiNarration("NEFT CR-HDFC0000001-ACME").is_upi, false);
});

test("dates and amounts", () => {
  assert.equal(parseIndianDate("05/08/26"), "2026-08-05");
  assert.equal(parseIndianDate("05-Aug-2026"), "2026-08-05");
  assert.equal(parseIndianDate("5 Aug 2026"), "2026-08-05");
  assert.equal(parseIndianDate("2026-08-05"), "2026-08-05");
  assert.equal(parseIndianDate("Aug 5, 2026"), "2026-08-05");
  assert.equal(parseAmount("1,02,000.00"), 102000);
  assert.equal(parseAmount("₹ 452.00 Dr"), 452);
});

test("CSV statement end to end", () => {
  const s = loadStatement(new URL("./fixtures/hdfc_sample.csv", import.meta.url).pathname);
  assert.equal(s.transactions.length, 14);
  const a = analyse(s.transactions);
  assert.equal(a.totals.received, 170000);
  const cats = Object.fromEntries(a.by_category.map((c) => [c.category, c.total]));
  assert.equal(cats["Rent & Housing"], 54000);
  assert.equal(cats["Entertainment & Subscriptions"], 1947);
  assert.equal(cats["Food Delivery & Dining"], 452);
  assert.equal(cats["Groceries"], 1230.5);
  assert.equal(cats["Loans & EMI"], 4500);
  assert.equal(cats["Cash Withdrawal"], 5000);
  assert.equal(cats["Investments"], 10000);
  assert.equal(cats["Travel & Transport"], 312);
  const rec = a.recurring_payments.map((r) => r.payee).sort();
  assert.deepEqual(rec, ["Netflix Com", "Rahul Sharma"]);
});
