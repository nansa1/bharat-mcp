#!/usr/bin/env python3
"""Convert the GST portal's official HSN/SAC master (HSN_SAC.xlsx) into data/hsn_sac.json.

Source: https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx
Usage:  python3 scripts/build_hsn_data.py path/to/HSN_SAC.xlsx [YYYY-MM-DD downloaded]
Needs:  pip install openpyxl

Descriptions are kept as published; only Excel artefacts and whitespace are cleaned,
and codes that lost a leading zero in the spreadsheet are repaired (listed in "fixes").
"""
import datetime, hashlib, json, re, sys
from pathlib import Path
import openpyxl

SRC_URL = "https://tutorial.gst.gov.in/downloads/HSN_SAC.xlsx"

def clean_desc(s):
    s = str(s).replace("_x000D_", " ")
    parts = [re.sub(r"\s+", " ", p).strip(" :") for p in s.split("~")]
    return [p for p in parts if p]

def main(path, downloaded):
    raw = Path(path).read_bytes()
    wb = openpyxl.load_workbook(path, read_only=True)
    fixes, goods, services = [], {}, {}

    for code, desc in list(wb["HSN_MSTR"].iter_rows(values_only=True))[1:]:
        if code is None or desc is None:
            continue
        orig = str(code).strip()
        c = re.sub(r"\s+", "", orig)
        if len(c) in (5, 7):          # leading zero dropped by Excel, e.g. 30559 -> 030559
            c = "0" + c
        if not re.fullmatch(r"\d{2}|\d{4}|\d{6}|\d{8}", c):
            raise SystemExit(f"Unexpected HSN code {orig!r}")
        d = clean_desc(desc)
        if c != orig:
            fixes.append([orig, c])
        if c in goods:
            # The sheet repeats a few codes in a second format; keep the more descriptive entry
            if c == orig and not any(f[1] == c for f in fixes):
                raise SystemExit(f"Duplicate HSN code {c}")
            if len(d) > len(goods[c]) or (len(d) == len(goods[c]) and len(" ".join(d)) > len(" ".join(goods[c]))):
                goods[c] = d
            continue
        goods[c] = d

    for code, desc in list(wb["SAC_MSTR"].iter_rows(values_only=True))[1:]:
        if code is None or desc is None:
            continue
        c = str(code).strip()
        if not re.fullmatch(r"99(\d{2}){0,2}", c):
            raise SystemExit(f"Unexpected SAC code {c!r}")
        services[c] = clean_desc(desc)

    # Sanity check: every repaired code must sit under an existing chapter whose title matches
    for orig, c in fixes:
        chapter = goods.get(c[:2])
        norm = lambda x: re.sub(r"[^A-Z]", "", x.upper())
        if not chapter or (len(goods[c]) > 1 and norm(goods[c][0]) != norm(chapter[0])):
            raise SystemExit(f"Repaired code {orig} -> {c} does not fit chapter {c[:2]}")

    out = {
        "source": {
            "name": "GST portal HSN/SAC master",
            "url": SRC_URL,
            "sha256": hashlib.sha256(raw).hexdigest(),
            "downloaded": downloaded,
            "hsn_codes": len(goods),
            "sac_codes": len(services),
        },
        "fixes": fixes,  # [as published, normalised] - all are duplicates merged into the normalised code
        # Each entry: [code, [description parts, broadest first]]
        "goods": sorted([k, v] for k, v in goods.items()),
        "services": sorted([k, v] for k, v in services.items()),
    }
    dest = Path(__file__).resolve().parent.parent / "data" / "hsn_sac.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {dest} ({dest.stat().st_size // 1024} KB): {len(goods)} HSN, {len(services)} SAC, {len(fixes)} fixed codes")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else datetime.date.today().isoformat())
