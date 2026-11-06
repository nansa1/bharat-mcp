# bharat-mcp 🇮🇳

**An MCP server that teaches Claude (and any MCP-compatible AI) how India's money and paperwork work.**

Ask your AI to make a GST invoice, check a GSTIN, explain where your salary went from a bank statement, decode a UPI narration, or find a bank branch from an IFSC. It runs on your computer, and your statements never leave it.

> "Make a GST invoice from my studio in Bengaluru to Acme Media in Mumbai for 10 hours of video editing at ₹1,500/hr."
>
> → Claude works out that this is inter-state (IGST 18%) and writes `Invoice_INV_2026-27_001.pdf` with HSN/SAC, place of supply and the amount in words.

> "Analyse ~/Downloads/HDFC_statement.pdf. Where did my money go, and which subscriptions should I cancel?"
>
> → Spending by category (Swiggy/Zomato, Blinkit/Zepto, rent, EMIs, SIPs…), monthly cash flow, top payees and recurring payments.

## Tools

| Tool | What it does | Network |
|---|---|---|
| `create_gst_invoice` | GST tax invoice PDF (Rule 46 fields, CGST/SGST/UTGST/IGST, cess, round-off, bank and UPI details) | Offline |
| `calculate_gst` | Tax split for any line items: intra- vs inter-state, GST-inclusive prices, cess | Offline |
| `validate_gstin` | Format, state code and checksum check; decodes PAN and entity type | Offline |
| `find_gst_rate` | GST rate for goods by HSN code or product name, from the Gazette of India rate notifications with every amendment applied; shows each matching entry with its notification and serial number | Offline |
| `search_hsn_sac` | Find HSN (goods) or SAC (services) codes by everyday description ("laptop", "ghee", "CA services") or code prefix, from the GST portal's official list | Offline |
| `lookup_hsn_sac` | Check whether a code exists, with its chapter, heading and sub-codes; suggests the nearest valid code for a typo | Offline |
| `amount_in_words` | ₹ to words in lakh/crore ("Rupees One Lakh Twenty Thousand Only") | Offline |
| `analyze_bank_statement` | Categorised spend, monthly in/out, top payees, recurring payments and UPI usage, from a **PDF or CSV** statement | Offline |
| `convert_bank_statement` | PDF statement → clean CSV for Excel/Sheets, with categories, payees and decoded UPI details | Offline |
| `parse_upi_narration` | Decodes UPI narrations from SBI, HDFC, ICICI, Axis, Kotak and others into payee, VPA, app, RRN and direction | Offline |
| `lookup_ifsc` | Bank, branch, address, MICR and UPI/IMPS/NEFT/RTGS support | [Razorpay IFSC API](https://github.com/razorpay/ifsc) |
| `lookup_pincode` | District, state and post offices for a PIN code | India Post data |

It also includes a prompt, **`monthly_money_review`**, that turns a statement into a summary and a savings plan.

## Install

Requires Node.js 22.13 or later.

**Claude Code**
```bash
claude mcp add bharat -- npx -y @adnansaliyawala/bharat-mcp
```

**Claude Desktop**: add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):
```json
{
  "mcpServers": {
    "bharat": { "command": "npx", "args": ["-y", "@adnansaliyawala/bharat-mcp"] }
  }
}
```

**From source**
```bash
git clone https://github.com/nansa1/bharat-mcp && cd bharat-mcp && npm install && npm run build
claude mcp add bharat -- node /absolute/path/to/bharat-mcp/dist/index.js
```

## Configuration (optional)

| Env var | Default | Purpose |
|---|---|---|
| `BHARAT_MCP_OUTPUT_DIR` | `~/bharat-mcp/invoices` | Where invoice PDFs are saved |
| `BHARAT_MCP_IFSC_API` | `https://ifsc.razorpay.com` | Self-host the IFSC API if you like |
| `BHARAT_MCP_PINCODE_API` | `https://api.postalpincode.in` | PIN code API base URL |

## Bank statements

Just point it at the **PDF your bank emails you** (or a CSV export from net banking).

- **Layouts:** detects the table automatically, whatever the header wording ("Withdrawal Amt." / "Debit" / "Withdrawal (Dr)/ Deposit (Cr)" / "DR/CR"…). Handles headers on two lines, narrations that wrap above or below the row, newest-first statements, and multi-page statements. It has been tested on SBI, HDFC, ICICI, Axis and Kotak style layouts.
- **Password-protected PDFs:** Claude will ask you for the password. It is used only to open the file and is never stored.
- **Checked against the balance:** every row is reconciled with the running balance. A misread debit/credit is fixed automatically, and a missing row is reported with its date, so you know whether to trust the numbers.
- **Scanned statements** (photos, no text layer) can't be parsed. Claude can read those itself and pass the rows in.

If your bank's PDF doesn't parse, run `convert_bank_statement` with `debug: true`. You get a layout preview with every letter and digit masked, which is safe to paste into a GitHub issue.

## HSN/SAC codes

Codes and descriptions come from the GST portal's official master list ([HSN_SAC.xlsx](https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx)): 21,928 HSN codes and 681 SAC codes. The data is bundled, so search works offline. `create_gst_invoice` also warns when an item's HSN/SAC code isn't in that list.

- Descriptions are kept exactly as published. The only changes are cleaning spreadsheet artefacts and merging seven codes the sheet lists twice; these are recorded in `data/hsn_sac.json`, along with the source file's SHA-256 and download date.
- Everyday names ("atta", "AC", "laptop", "CA") are mapped to tariff wording, but every result is an official code.
- GST rates come from `find_gst_rate` (see below).
- Classification is your responsibility. When it is unclear, confirm it with your CA.

To refresh the list: download the latest `HSN_SAC.xlsx`, then run `pip install openpyxl` and `npm run update-hsn -- path/to/HSN_SAC.xlsx`.

## GST rates

`find_gst_rate` uses the rate notifications exactly as published in the **Gazette of India**:

| Notification | Gazette ID | In force from | What it does |
|---|---|---|---|
| 09/2025-Central Tax (Rate) | CG-DL-E-17092025-266209 | 22 Sep 2025 | Rate schedules I–VII for goods (5%, 18%, 40%, 3%, 0.25%, 1.5%, 28%) |
| 10/2025-Central Tax (Rate) | CG-DL-E-17092025-266210 | 22 Sep 2025 | Exempt (nil-rated) goods |
| 19/2025-Central Tax (Rate) | CG-DL-E-31122025-268978 | 1 Feb 2026 | Tobacco and pan masala to 40%, biris to 18%; 28% schedule removed |
| 01/2026-Central Tax (Rate) | CG-DL-E-01052026-272190 | 1 May 2026 | Beverage tariff codes updated |
| 02/2026 and 03/2026-Central Tax (Rate) | CG-DL-E-27102026-277454 | 1 Nov 2026 | 57th GST Council: retreaded tractor tyres 5%, bio-stimulants, psyllium seeds exempt |

How the data is checked:
- The CGST (09/2025-CT) and IGST (09/2025-IT) notifications are parsed **independently** and must agree entry for entry, with IGST = 2 × CGST.
- Every HSN code in the schedules must exist in the official HSN list.
- Each amendment is transcribed in `scripts/gst_amendments.json`, and the build fails unless its text appears in the amending notification's PDF.
- The Gazette PDFs are in `sources/gazette/`, with their SHA-256 hashes. Run `npm run update-rates` to rebuild.

Things to know:
- **One code can have several entries at different rates.** The right one depends on the wording, for example "pre-packaged and labelled" or "other than …". The tool shows every matching entry instead of guessing.
- **Services (SAC codes) are not covered yet.** Their rates are spread across Notification 11/2017 and many amendments.
- **Compensation cess is nil from 1 February 2026.**
- **The data is current up to the date in `source.in_force_as_of`.** After a new GST Council meeting, check the Gazette for new rate notifications and add them to `scripts/gst_amendments.json`.
- `create_gst_invoice` warns when an item's rate doesn't match any rate notified for its HSN code.

## Privacy

- Statement parsing and analysis, GST maths and invoice generation run **entirely on your machine**.
- Only `lookup_ifsc` and `lookup_pincode` make network calls, and they send only the code you look up.
- Nothing is logged or stored apart from the invoice PDFs you ask for.

## Caveats

- `validate_gstin` checks structure and checksum. It does **not** confirm that a registration is active on the GST portal.
- GST rates change, so always pass the rate that applies to your item.
- Automatic categories are a best guess. They are good for a personal overview, but they are not accounting advice.

## Development

```bash
npm install
npm test          # builds, then runs unit tests and an end-to-end MCP client test
npm run inspect   # opens the MCP Inspector
```

Contributions are very welcome, especially new bank narration formats (add a sample to `test/`), merchant keywords in `src/upi.ts`, and new tools (see the roadmap).

## Releasing (maintainers)

Every push and pull request runs the tests on Ubuntu and Windows with Node 22 and 24 (`.github/workflows/ci.yml`).

Publishing is automatic when a GitHub release is published (`.github/workflows/release.yml`). The workflow:
1. checks that the tag, `package.json` and `server.json` agree;
2. runs the tests;
3. validates `server.json`;
4. publishes to npm with Trusted Publishing (no token; provenance is added automatically);
5. publishes to the MCP Registry with GitHub OIDC.

To release a new version:

```bash
npm version patch          # or minor / major; also updates server.json, commits and tags
git push --follow-tags
```

Then on GitHub: **Releases → Draft a new release**, choose the new tag (e.g. `v0.4.1`), and click **Publish release**.

One-time setup on npmjs.com: in the package's **Settings → Trusted publishing**, add GitHub Actions with user `nansa1`, repository `bharat-mcp`, workflow `release.yml`, and tick **npm publish** under Allowed actions.

## Roadmap

- [ ] E-invoice JSON (IRN schema) and e-way bill helpers
- [x] HSN/SAC code search (v0.3)
- [x] GST rates for goods from the Gazette of India (v0.4)
- [ ] GST rates for services (SAC)
- [ ] Indian income-tax calculator (old vs new regime)
- [x] PDF statement parsing (v0.2)
- [ ] Credit-card statements
- [ ] Train PNR and running status, via a pluggable provider (needs an API key)
- [ ] Hindi and regional-language output

## License

MIT
