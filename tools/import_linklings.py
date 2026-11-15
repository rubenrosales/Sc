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
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

BASE = "https://sc26.conference-program.com"
URL = BASE + "/?post_type=page&p=19"
TZ = ZoneInfo("America/Chicago")
OUT = Path(__file__).resolve().parent.parent / "data" / "schedule.json"

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


def parse_items(block, kind):
    out = []
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
                  for t in re.findall(r'<div class="program-track[^"]*">(.*?)</div>', grp)]
        people = []
        for p in re.findall(r'<div class="presenter-name">(.*?)</div>', it, re.S):
            name = text(p)
            if name and name not in people:
                people.append(name)
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
        if people:
            item["speakers"] = ", ".join(people[:6]) + (f" +{len(people) - 6}" if len(people) > 6 else "")
        desc = text(first(r'<span class="abstract"[^>]*>(.*?)</span></div>', it))
        if desc:
            item["description"] = desc
        out.append(item)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", help="use a saved copy of the Search Program page")
    a = ap.parse_args()
    if a.file:
        page = Path(a.file).read_text(encoding="utf-8", errors="replace")
    else:
        req = urllib.request.Request(URL, headers={"User-Agent": "sc-planner-sync"})
        with urllib.request.urlopen(req, timeout=120) as r:
            page = r.read().decode("utf-8", errors="replace")

    heads = {m.group(1): m.start() for m in re.finditer(r"<h2>([^<]*)</h2>", page)}
    if "Sessions" not in heads or "Presentations" not in heads:
        sys.exit("Unexpected page layout: no Sessions/Presentations sections found")
    order = sorted(heads.values()) + [len(page)]
    section = lambda name: page[heads[name]: order[order.index(heads[name]) + 1]]

    sessions = parse_items(section("Sessions"), "session")
    presentations = parse_items(section("Presentations"), "presentation")
    session_ids = {s["id"] for s in sessions}

    items = []
    for s in sessions:
        s.pop("_psid")
        if not s["url"]:
            s["url"] = f"{BASE}/?post_type=page&p=17&sess={s['id']}"
        if "description" in s:
            s["description"] = clip(s["description"], 900)
        items.append(s)
    for p in presentations:
        parent = p.pop("_psid")
        if parent in session_ids:
            p["parent"] = parent
            if "description" in p:
                p["description"] = clip(p["description"], 400)
        elif "description" in p:
            p["description"] = clip(p["description"], 900)
        items.append(p)

    # de-duplicate ids (a presentation can appear in two sessions)
    seen, uniq = set(), []
    for i in items:
        if i["id"] in seen:
            continue
        seen.add(i["id"])
        uniq.append(i)
    uniq.sort(key=lambda x: (x["date"], x["start"], x.get("parent", ""), x["title"]))

    data = json.loads(OUT.read_text()) if OUT.exists() else {}
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
