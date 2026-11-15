#!/usr/bin/env python3
"""Pull the official SC program (Linklings "Search Program" page) into data/schedule.json.

    python3 tools/import_linklings.py                       # download from the live site
    python3 tools/import_linklings.py --file saved_page.html

Only the standard library is used. The output keeps:
  * every Session (workshops, paper sessions, exhibits, receptions...) as a top-level item
  * stand-alone presentations (BoFs, panels, tutorials, keynote...) as top-level items
  * talks that belong to a session as child items (field "parent"), shown inside that session
"""
import argparse
import html
import json
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://sc26.conference-program.com"
URL = BASE + "/search-program/"
TZ = ZoneInfo("America/Chicago")
OUT = Path(__file__).resolve().parent.parent / "data" / "schedule.json"
DETAILS = OUT.with_name("details.json")

# Linklings event-type label -> app type key
TYPE_MAP = {
    "keynote": "keynote", "hpc unites plenary": "keynote", "invited talk": "keynote",
    "tutorial": "tutorial",
    "workshop": "workshop",
    "paper": "paper", "best paper finalist": "paper", "early career": "paper",
    "birds of a feather": "bof",
    "panel": "panel",
    "posters": "poster", "art of hpc": "poster",
    "exhibits": "exhibit", "exhibitor forum": "exhibit", "scinet network research exhibition": "exhibit",
    "regional tech hub": "exhibit", "career fair": "exhibit",
    "reception": "social",
    "awards and award talks": "award", "acm gordon bell finalist": "award",
    "acm gordon bell climate modeling finalist": "award",
    "community engagement": "community", "students@sc": "student", "student cluster competition": "student",
    "scc connect": "student",
}

TAG_RE = re.compile(r"<[^>]+>")


def text(s):
    return re.sub(r"\s+", " ", html.unescape(TAG_RE.sub(" ", s or ""))).strip()


def first(pattern, s, default=""):
    m = re.search(pattern, s, re.S)
    return m.group(1) if m else default


def local(utc):
    dt = datetime.strptime(utc, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(TZ)
    return dt.strftime("%Y-%m-%d"), dt.strftime("%H:%M")


def clip(s, n):
    return s if len(s) <= n else s[: n - 1].rsplit(" ", 1)[0] + "…"


def people_of(block, cls="presenter-details"):
    """[{n: name, o: organization(s), x: True if not presenting}]"""
    out, seen = [], set()
    for m in re.finditer(r'<(?:div|span) class="ll-person ([^"]*)">(.*?)</span>\s*</(?:div|span)>', block, re.S):
        classes, body = m.group(1), m.group(2)
        name = text(first(r'<div class="presenter-name">(.*?)</div>', body))
        if not name or name in seen:
            continue
        seen.add(name)
        orgs = [text(o) for o in re.findall(r'<div class="presenter-institution">(.*?)</div>', body, re.S)]
        person = {"n": name}
        if orgs:
            person["o"] = "; ".join(dict.fromkeys(o for o in orgs if o))
        if "not-presenting" in classes:
            person["x"] = 1
        out.append(person)
    return out


def tags_of(it):
    d = {}
    rec = [text(t) for grp in re.findall(r'tag_group105">(.*?)</div></div>', it, re.S)
           for t in re.findall(r'<div class="program-track[^"]*">(.*?)</div>', grp + "</div>")]
    if rec:
        d["rec"] = ", ".join(rec)
    reg = [t.replace(" Reg Pass", "").replace("Tech Program", "Technical Program")
           for t in re.findall(r'<span class="[a-z-]*registration" title="([^"]+)"', it)]
    if reg:
        d["reg"] = list(dict.fromkeys(reg))
    return d


def parse_items(block, kind):
    out, details = [], {}
    for it in re.split(r'(?=<div class="agenda-item )', block)[1:]:
        start_utc = first(r'class="dateTimeInfo start-time"[^>]*utc_time="([^"]+)"', it)
        end_utc = first(r'class="dateTimeInfo end-time"[^>]*utc_time="([^"]+)"', it)
        if not start_utc:
            continue
        date, start = local(start_utc)
        end_date, end = local(end_utc or start_utc)
        if end_date != date:
            end = "23:59"
        cat = text(first(r'<div class="etype [^"]*">(.*?)</div>', it))
        psid = first(r'psid="([^"]*)"', it)
        ssid = first(r'ssid="([^"]*)"', it)
        href = html.unescape(first(r'<div class="title-link"><a[^>]*href="([^"]+)"', it))
        topics = [text(t) for grp in re.findall(r'tag_group103">(.*?)</div></div>', it, re.S)
                  for t in re.findall(r'<div class="program-track[^"]*">(.*?)</div>', grp + "</div>")]
        people = people_of(it)
        item = {
            "id": psid if kind == "session" else ssid,
            "title": text(first(r'<div class="title-link">(.*?)</div>', it)),
            "date": date, "start": start, "end": end,
            "room": text(first(r'<span class="location">(.*?)</span>', it)),
            "type": TYPE_MAP.get(cat.lower(), "other"),
            "cat": cat,
            "url": BASE + href if href.startswith("/") else href,
            "_psid": psid,
        }
        if topics:
            item["track"] = ", ".join(topics)
        presenting = [p["n"] for p in people if not p.get("x")] or [p["n"] for p in people]
        if presenting:
            item["speakers"] = ", ".join(presenting)
        det = tags_of(it)
        desc = text(first(r'<span class="abstract"[^>]*>(.*?)</span></div>', it))
        if desc:
            det["d"] = desc
        if people:
            det["people"] = people
        out.append(item)
        details[item["id"]] = det
    return out, details


def fetch(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sc-planner-sync"})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            if i == tries - 1:
                print(f"  failed {url}: {e}", file=sys.stderr)
                return None
            time.sleep(2 * (i + 1))


def session_page_details(sid):
    page = fetch(f"{BASE}/?post_type=page&p=17&sess={sid}")
    if not page:
        return sid, None
    d = {}
    chairs = first(r'<div class="info-section session-chairs-list-sect">(.*?)</span></span></div>', page)
    if chairs:
        d["chairs"] = people_of(chairs + "</span></span>")
    desc = first(r'<div class="info-section session-description"><span class="info-label">Description</span>(.*?)</div>', page)
    if desc:
        d["d"] = text(desc)
    return sid, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="use a saved copy of the Search Program page")
    ap.add_argument("--session-pages", action="store_true",
                    help="also fetch every session page (chairs + session descriptions)")
    a = ap.parse_args()
    # The site occasionally serves an incomplete page; retry before giving up.
    for attempt in range(3):
        page = Path(a.file).read_text(encoding="utf-8", errors="replace") if a.file else fetch(URL)
        heads = {m.group(1): m.start() for m in re.finditer(r"<h2>([^<]*)</h2>", page or "")}
        if "Sessions" in heads and "Presentations" in heads:
            break
        if a.file or attempt == 2:
            sys.exit("Unexpected page layout: no Sessions/Presentations sections found — nothing changed")
        print("incomplete page, retrying…", file=sys.stderr)
        time.sleep(15)
    order = sorted(heads.values()) + [len(page)]
    section = lambda name: page[heads[name]: order[order.index(heads[name]) + 1]]

    sessions, det_s = parse_items(section("Sessions"), "session")
    presentations, det_p = parse_items(section("Presentations"), "presentation")
    details = {**det_s, **det_p}
    session_ids = {s["id"] for s in sessions}

    items = []
    for s in sessions:
        s.pop("_psid")
        if not s["url"]:
            s["url"] = f"{BASE}/?post_type=page&p=17&sess={s['id']}"
        items.append(s)
    for p in presentations:
        parent = p.pop("_psid")
        if parent in session_ids:
            p["parent"] = parent
        items.append(p)

    # de-duplicate ids (a presentation can appear in two sessions)
    seen, uniq = set(), []
    for i in items:
        if i["id"] in seen:
            continue
        seen.add(i["id"])
        uniq.append(i)
    uniq.sort(key=lambda x: (x["date"], x["start"], x.get("parent", ""), x["title"]))

    # Sanity check before writing anything (details included).
    data = json.loads(OUT.read_text()) if OUT.exists() else {}
    old_n = len(data.get("sessions") or [])
    if old_n > 200 and len(uniq) < old_n * 0.8:
        sys.exit(f"Refusing update: only {len(uniq)} items parsed vs {old_n} before (site layout change?)")

    # ---- details: session chairs/descriptions (fetched, or carried over from last run)
    old_details = json.loads(DETAILS.read_text()) if DETAILS.exists() else {}
    if a.session_pages:
        print(f"fetching {len(session_ids)} session pages…")
        with ThreadPoolExecutor(max_workers=4) as pool:
            for sid, d in pool.map(session_page_details, sorted(session_ids)):
                if d is None:
                    d = {k: v for k, v in old_details.get(sid, {}).items() if k in ("chairs", "d")}
                details[sid].update(d)
    else:
        for sid in session_ids:
            old = old_details.get(sid, {})
            for k in ("chairs", "d"):
                if k in old and k not in details[sid]:
                    details[sid][k] = old[k]
    details = {k: v for k, v in details.items() if v and k in seen}

    det_text = json.dumps(details, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n"
    if not DETAILS.exists() or DETAILS.read_text() != det_text:
        DETAILS.write_text(det_text)
        print(f"wrote details for {len(details)} items -> {DETAILS} ({DETAILS.stat().st_size // 1024} KB)")

    if data.get("sessions") == uniq:
        print(f"no change ({len(uniq)} items)")
        return
    data.setdefault("conference", {})
    data["source"] = "Official SC26 program (sc26.conference-program.com)"
    data["updated"] = datetime.now(TZ).strftime("%Y-%m-%d %H:%M %Z")
    data.pop("notice", None)
    data["sessions"] = uniq
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n")
    top = sum(1 for i in uniq if "parent" not in i)
    print(f"wrote {len(uniq)} items ({top} top-level, {len(uniq) - top} talks) -> {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
