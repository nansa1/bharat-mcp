#!/usr/bin/env python3
"""Build data/gst_rates.json from the official GST rate notifications in the Gazette of India.

Inputs (PDFs from https://egazette.gov.in, Gazette of India Extraordinary, Part II Sec 3(i)):
  --ctr   Notification 09/2025-Central Tax (Rate)      goods rate schedules I-VII   (CG-DL-E-17092025-266209)
  --itr   Notification 09/2025-Integrated Tax (Rate)   same schedules, IGST rates   (CG-DL-E-17092025-266211)
  --exempt Notification 10/2025-Central Tax (Rate)     exempt (nil) goods           (CG-DL-E-17092025-266210)
  --manifest JSON with gazette_id / url / sha256 / dates for each file

Usage:
  python3 scripts/build_gst_rates.py --ctr ctr.pdf --itr itr.pdf --exempt exempt.pdf --manifest manifest.json

Needs `pdftotext` (poppler-utils). The CGST and IGST notifications are parsed independently and
must agree entry-for-entry (IGST = 2 x CGST) or the build fails. Text is kept as published.
"""
import argparse, hashlib, json, re, subprocess, sys
from pathlib import Path

ROMAN = {"I": 1, "II": 2, "III": 3, "IV": 4, "V": 5, "VI": 6, "VII": 7}
PAGE_JUNK = re.compile(
    r"THE GAZETTE OF INDIA|भारत का राजपत्र|\[PART II|\[भाग II|Uploaded by Dte\. of Printing|Published by the Controller|"
    r"Digitally signed by|^\s*Date: \d{4}\.\d{2}\.\d{2}|^\s*NATH YADAVA\s*$|^\s*\d{1,3}\s*$")
HEADER_LINE = re.compile(r"^\s*(S\.\s*No\.?|\(1\)\s+\(2\)|Chapter\s*/?\s*Heading|heading\s*/\s*Tariff|Sub-?heading\s*/\s*Tariff|Heading/Tariff|item\s*$|Tariff\s*$)", re.I)
ROW = re.compile(r"^\s{0,10}(\d{1,3}[A-Z]?)\.\s{1,}(\S.*)$")
CODEISH = re.compile(r"^(?:\d{2,4}(?:\s\d{2}){0,3}|any\s+(?:other\s+)?chapter|chapter\s+\d+|\(?except|or|and|to|,|\s|\(|\)|\d)+$", re.I)


def pdf_text(path):
    return subprocess.run(["pdftotext", "-layout", str(path), "-"], check=True, capture_output=True, text=True).stdout


def english_part(text, start_after=0):
    """The Gazette prints Hindi first, then English. Return lines of the first English notification body."""
    lines = text.splitlines()
    for i in range(start_after, len(lines)):
        if re.match(r"^\s*NOTIFICATION\s*$", lines[i]):
            body = " ".join(lines[i + 1:i + 8])
            if re.search(r"G\.S\.R\.|In exercise of the powers", body):
                return lines[i:], i
    raise SystemExit("English NOTIFICATION not found")


def segments(line):
    return [(m.start(), m.group(0)) for m in re.finditer(r"\S(?:.*?\S)??(?=\s{2,}|$)", line)]


def split_first(rest_line, offset):
    """Split the text after 'N.' into (codes, description, desc_col)."""
    segs = segments(rest_line)
    if not segs:
        return "", "", None
    if len(segs) == 1:
        # codes and description run together with one space: peel off leading code-ish tokens
        m = re.match(r"^((?:\d{2,4}(?:\s\d{2}){0,3}(?:,\s*|\s+or\s+|\s+))+)(?=[A-Za-z\"“(])", segs[0][1])
        if m:
            return m.group(1).strip(" ,"), segs[0][1][m.end():], offset + segs[0][0] + m.end()
        return "", segs[0][1], offset + segs[0][0]
    return segs[0][1], " ".join(s for _, s in segs[1:]), offset + segs[1][0]


def parse_schedules(lines, exempt=False):
    entries, lists = [], {}
    sched, rate = ("Exempt", 0.0) if exempt else (None, None)
    cur, cur_page_desc_col, page_no = None, None, 0
    in_list = None
    pending_title = None
    for raw in lines[1:]:
        line = raw.replace("‐", "-").replace("–", "–").rstrip()
        if "\f" in line:
            page_no += 1; cur_page_desc_col = None
            line = line.replace("\f", "")
        if not line.strip() or PAGE_JUNK.search(line):
            continue
        if re.match(r"^\s{0,12}Explanation\.?\s*[-—–]+\s*(For the purposes of this (notification|Schedule))", line):
            sched = "__after__"; cur = None; in_list = None   # lists can follow the closing Explanation
            continue
        if re.match(r"^\s*\[F\.\s*No\.", line):
            sched = "__after__"; cur = None; in_list = None   # annexures can follow the signature
            continue
        if sched == "__after__" and re.match(r"^\s*NOTIFICATION\s*$", line):
            break   # next notification in the same Gazette issue
        am = re.match(r"^\s*(Annexure\s*-?\s*[IVX]+)\s*$", line, re.I)
        if am:
            pending_title = am.group(1); in_list = None
            continue
        m = re.match(r"^\s*Schedule\s+([IVX]+)\s*[–-]\s*([\d.]+)\s*%", line)
        if m and not exempt:
            sched, rate = m.group(1), float(m.group(2)); cur = None; in_list = None
            continue
        m = re.match(r"^\s*(List\s+\d+|Annexure\s*[IVX]*)?\s*\[See S\.\s*No\.?\s*([\d,\sand]+)\s+of\s+the\s+Schedule\s*([IVX–-]*)\]", line, re.I)
        if m:
            title = ((pending_title + " ") if pending_title else "") + line.strip()
            pending_title = None
            in_list = {"title": title, "refers_to": m.group(2).strip(), "text": []}
            lists[title] = in_list; cur = None
            continue
        if re.match(r"^\s*[A-Z][A-Z .]+,\s*(Under|Deputy|Joint|Additional)\s+Secy\.?\s*$", line) or re.match(r"^\s*Note\s*:?\s*The principal notification", line):
            in_list = None; continue
        if in_list is not None:
            if re.search(r"[\u0900-\u097F]{2,}", line):   # Hindi text of the next notification: list is over
                if sched == "__after__":
                    break
                in_list = None; continue
            in_list["text"].append(line.strip())
            continue
        if sched in (None, "__after__") or HEADER_LINE.match(line):
            continue
        m = ROW.match(line)
        if m and (not cur or _plausible_next(cur["sno"], m.group(1))):
            codes, desc, desc_col = split_first(m.group(2), m.start(2))
            cur = {"schedule": sched, "cgst": rate, "sno": m.group(1), "codes_text": codes, "description": desc}
            cur_page_desc_col = desc_col
            entries.append(cur)
            continue
        if cur is None:
            continue
        # continuation line: codes column or description column?
        for col, seg in segments(line):
            # codes column only if it is left of the description column AND looks like codes
            is_code = bool(CODEISH.match(seg)) and len(seg) < 60 and (cur_page_desc_col is None or col < cur_page_desc_col - 3)
            if is_code:
                cur["codes_text"] = (cur["codes_text"] + " " + seg).strip()
            else:
                cur["description"] = _join(cur["description"], seg)
    for l in lists.values():
        l["text"] = re.sub(r"\s+", " ", " ".join(l["text"])).strip()
    return entries, list(lists.values())


def _plausible_next(prev, nxt):
    p, n = int(re.match(r"\d+", prev).group()), int(re.match(r"\d+", nxt).group())
    return n == p + 1 or (n == p and nxt != prev) or n == 1


def _join(a, b):
    if not a:
        return b
    if a.endswith("-") and not a.endswith(" -"):
        return a + b  # hyphenated across lines, e.g. "sub-" + "heading" keeps the hyphen as printed
    return a + " " + b


def parse_codes(text):
    t = re.sub(r"\s+", " ", text.replace(" ", " ")).strip()
    any_chapter = bool(re.search(r"any\s+chapter", t, re.I))
    exc = []
    m = re.search(r"\(\s*(?:except|other than)\s+([^)]*)\)", t, re.I) or re.search(r"\bexcept\s+([\d\s,]+(?:or\s+[\d\s]+)?)$", t, re.I)
    main = t
    if m:
        exc = [c.replace(" ", "") for c in re.findall(r"\d{2,4}(?:\s?\d{2}){0,3}", m.group(1))]
        main = t[:m.start()] + t[m.end():]
    codes = []
    for tok in re.findall(r"(?<!\d)\d{2,4}(?:\s?\d{2}){0,3}(?!\d)", main):
        c = tok.replace(" ", "")
        if len(c) in (2, 4, 6, 8):
            codes.append(c)
    return {"codes": codes, "except": exc, "any_chapter": any_chapter}


def check_sequence(entries, label):
    problems = []
    by = {}
    for e in entries:
        by.setdefault(e["schedule"], []).append(e)
    for s, es in by.items():
        nums = [int(re.match(r"\d+", e["sno"]).group()) for e in es]
        for a, b in zip(nums, nums[1:]):
            if b not in (a, a + 1):
                problems.append(f"{label} Schedule {s}: S.No {a} followed by {b}")
        for e in es:
            if not e["description"]:
                problems.append(f"{label} Schedule {s} S.No {e['sno']}: empty description")
            if not e["codes"] and not e["any_chapter"] and e["codes_text"].strip() not in ("-", "–"):
                problems.append(f"{label} Schedule {s} S.No {e['sno']}: no codes ({e['codes_text']!r})")
    return problems


def _squash(t):
    return re.sub(r"[^a-z0-9]", "", t.lower().replace("“", "").replace("”", ""))


def apply_amendments(entries, amend, pdf_dir, manifest):
    """Apply transcribed amendments; each quoted text must appear in the amending notification's PDF."""
    by_key = {(e["schedule"], e["sno"]): e for e in entries}
    order = [(e["schedule"], e["sno"]) for e in entries]
    omitted, applied = [], []
    for n in amend["notifications"]:
        pdf = pdf_dir / n["file"]
        raw = pdf.read_bytes()
        sha = hashlib.sha256(raw).hexdigest()
        m = manifest.get(n["file"])
        if not m or m["sha256"] != sha or m["gazette_id"] != n["gazette_id"]:
            raise SystemExit(f"{n['file']}: not in manifest or hash/gazette id mismatch")
        text = _squash(pdf_text(pdf))
        letters = re.sub(r"\d", "", text)   # descriptions can be interleaved with the codes column line by line
        digits = re.sub(r"\D", "", text)
        ref = n["id"]
        for op in n["operations"]:
            for field in ("description", "codes_text", "quote"):
                if field == "description":
                    hay, needle = letters, re.sub(r"\d", "", _squash(op.get(field, "")))
                elif field == "codes_text":   # compare the digit sequence (the column can wrap around the description)
                    hay, needle = digits, re.sub(r"\D", "", op.get(field, ""))
                else:
                    hay, needle = text, _squash(op.get(field, ""))
                if field in op and needle not in hay:
                    raise SystemExit(f"{ref}: transcribed {field} not found in {n['file']}: {op[field][:80]!r}")
            key = (op["schedule"], op.get("sno"))
            if op["op"] == "omit_schedule":
                gone = [k for k in order if k[0] == op["schedule"]]
                if not gone:
                    raise SystemExit(f"{ref}: schedule {op['schedule']} has no entries to omit")
                for k in gone:
                    e = by_key.pop(k); order.remove(k)
                    omitted.append({**e, "omitted_by": ref, "omitted_from": n["effective"]})
                continue
            if op["op"] == "insert":
                if key in by_key:
                    raise SystemExit(f"{ref}: {key} already exists")
                after = (op["schedule"], op["after"])
                if after not in by_key:
                    raise SystemExit(f"{ref}: insert after missing {after}")
                notif = "10/2025-Central Tax (Rate)" if op["schedule"] == "Exempt" else "09/2025-Central Tax (Rate)"
                base_ref = f"10/2025-CTR S.No {op['sno']}" if op["schedule"] == "Exempt" else f"09/2025-CTR Sch {op['schedule']} S.No {op['sno']}"
                cgst = 0 if op["schedule"] == "Exempt" else {"I": 2.5, "II": 9, "III": 20, "IV": 1.5, "V": 0.125, "VI": 0.75}[op["schedule"]]
                e = {"ref": base_ref, "notification": notif, "schedule": op["schedule"], "sno": op["sno"],
                     **parse_codes(op["codes_text"]), "codes_text": op["codes_text"], "description": op["description"],
                     "gst": round(cgst * 2, 3), "cgst": cgst, "sgst_utgst": cgst, "igst": round(cgst * 2, 3),
                     "amended_by": [{"by": ref, "from": n["effective"], "change": "inserted"}]}
                by_key[key] = e; order.insert(order.index(after) + 1, key)
                continue
            if key not in by_key:
                raise SystemExit(f"{ref}: target {key} not found")
            e = by_key[key]
            if op["op"] == "substitute_codes":
                old = e["codes_text"]
                e.update(parse_codes(op["codes_text"])); e["codes_text"] = op["codes_text"]
                e.setdefault("amended_by", []).append({"by": ref, "from": n["effective"], "change": "codes", "previous": old})
            elif op["op"] == "substitute_description":
                old = e["description"]
                e["description"] = op["description"]
                e.setdefault("amended_by", []).append({"by": ref, "from": n["effective"], "change": "description", "previous": old})
            else:
                raise SystemExit(f"{ref}: unknown op {op['op']}")
        applied.append({"notification": n["notification"], "gazette_id": n["gazette_id"], "effective": n["effective"],
                        "sha256": sha, "summary": n["summary"], "url": m["url"]})
        print(f"applied {ref}: {len(n['operations'])} operations")
    return [by_key[k] for k in order], omitted, applied


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ctr", required=True); ap.add_argument("--itr", required=True)
    ap.add_argument("--exempt", required=True); ap.add_argument("--manifest", required=True)
    ap.add_argument("--amendments", default=str(Path(__file__).resolve().parent / "gst_amendments.json"))
    ap.add_argument("--pdf-dir", help="folder holding the amending notification PDFs (default: folder of --ctr)")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent.parent / "data" / "gst_rates.json"))
    a = ap.parse_args()
    manifest = {m["file"]: m for m in json.loads(Path(a.manifest).read_text())}

    def meta(path, notification, effective):
        m = manifest[Path(path).name]
        sha = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        if sha != m["sha256"]:
            raise SystemExit(f"{path}: sha256 does not match manifest")
        return {"notification": notification, "gazette_id": m["gazette_id"], "url": m["url"], "issued": "2025-09-17",
                "effective": effective, "sha256": sha, "gazette_part": m["part"]}

    ctr_lines, _ = english_part(pdf_text(a.ctr))
    itr_lines, _ = english_part(pdf_text(a.itr))
    ex_lines, _ = english_part(pdf_text(a.exempt))
    ctr, ctr_lists = parse_schedules(ctr_lines)
    itr, _ = parse_schedules(itr_lines)
    ex, ex_lists = parse_schedules(ex_lines, exempt=True)
    for e in ctr + itr + ex:
        e.update(parse_codes(e["codes_text"]))
        e["description"] = re.sub(r"\s+", " ", e["description"]).strip()

    problems = check_sequence(ctr, "CTR") + check_sequence(itr, "ITR") + check_sequence(ex, "Exempt")
    # Cross-check: CGST and IGST notifications must list the same goods, IGST = 2 x CGST
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.lower())
    # The IGST version cites its own Act and notification numbers ("section 5 of the Integrated ..."
    # instead of "section 9 of the Central ..."); ignore only those legal cross-references.
    norm_x = lambda s: re.sub(r"central|integrated|[^a-z]", "", s.lower())
    if len(ctr) != len(itr):
        problems.append(f"CTR has {len(ctr)} entries, ITR has {len(itr)}")
    mismatches = []
    for c, i in zip(ctr, itr):
        if (c["schedule"], c["sno"]) != (i["schedule"], i["sno"]) or abs(i["cgst"] - 2 * c["cgst"]) > 1e-9 \
                or c["codes"] != i["codes"] or norm_x(c["description"]) != norm_x(i["description"]):
            mismatches.append({"ctr": [c["schedule"], c["sno"], c["codes_text"], c["description"][:90]],
                               "itr": [i["schedule"], i["sno"], i["codes_text"], i["description"][:90]]})
    print(f"CTR {len(ctr)} entries, ITR {len(itr)}, exempt {len(ex)}; lists {len(ctr_lists)}+{len(ex_lists)}")
    print(f"CTR/ITR mismatches: {len(mismatches)}")
    import difflib
    for c, i in zip(ctr, itr):
        if norm_x(c["description"]) != norm_x(i["description"]) or c["codes"] != i["codes"]:
            a, b = c["description"], i["description"]
            sm = difflib.SequenceMatcher(None, a, b)
            diffs = [(a[i1:i2], b[j1:j2]) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal"]
            print("  ", c["schedule"], c["sno"], "codes", c["codes_text"], "|", i["codes_text"], "| diffs:", diffs[:4])
    for p in problems[:40]:
        print("  !", p)
    if problems or mismatches:
        raise SystemExit("Build failed: fix the parser or review the entries above.")

    src_rate = meta(a.ctr, "09/2025-Central Tax (Rate)", "2025-09-22")
    src_irate = meta(a.itr, "09/2025-Integrated Tax (Rate)", "2025-09-22")
    src_ex = meta(a.exempt, "10/2025-Central Tax (Rate)", "2025-09-22")
    out_entries = []
    for e in ctr:
        out_entries.append({
            "ref": f"09/2025-CTR Sch {e['schedule']} S.No {e['sno']}", "notification": "09/2025-Central Tax (Rate)",
            "schedule": e["schedule"], "sno": e["sno"], "codes": e["codes"], "except": e["except"], "any_chapter": e["any_chapter"],
            "codes_text": re.sub(r"\s+", " ", e["codes_text"]).strip(), "description": e["description"],
            "gst": round(e["cgst"] * 2, 3), "cgst": e["cgst"], "sgst_utgst": e["cgst"], "igst": round(e["cgst"] * 2, 3)})
    for e in ex:
        out_entries.append({
            "ref": f"10/2025-CTR S.No {e['sno']}", "notification": "10/2025-Central Tax (Rate)", "schedule": "Exempt", "sno": e["sno"],
            "codes": e["codes"], "except": e["except"], "any_chapter": e["any_chapter"],
            "codes_text": re.sub(r"\s+", " ", e["codes_text"]).strip(), "description": e["description"],
            **({"no_code": True} if e["codes_text"].strip() in ("-", "–") else {}),
            "gst": 0, "cgst": 0, "sgst_utgst": 0, "igst": 0})
    amend = json.loads(Path(a.amendments).read_text())
    pdf_dir = Path(a.pdf_dir) if a.pdf_dir else Path(a.ctr).parent
    out_entries, omitted, applied = apply_amendments(out_entries, amend, pdf_dir, manifest)
    rates = {"I": 5, "II": 18, "III": 40, "IV": 3, "V": 0.25, "VI": 1.5, "VII": 28, "Exempt": 0}
    for s_ in {o["schedule"] for o in omitted}:
        rates.pop(s_, None)
    out = {
        "sources": [src_rate, src_irate, src_ex] + applied,
        "schedule_rates": rates,
        "in_force_as_of": amend["checked_through"],
        "valid_as_of": ("Notification 09/2025-Central Tax (Rate) as amended by 19/2025, 01/2026 and 02/2026, and 10/2025-Central Tax (Rate) "
                        f"as amended by 03/2026; Gazette of India checked through {amend['checked_through']}."),
        "omitted": omitted,
        "lists": [{"notification": "09/2025-Central Tax (Rate)", **l} for l in ctr_lists] + [{"notification": "10/2025-Central Tax (Rate)", **l} for l in ex_lists],
        "entries": out_entries,
    }
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {a.out} ({Path(a.out).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
