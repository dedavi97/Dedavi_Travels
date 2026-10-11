"""Data pipeline for Dedavi_Travels.

Reads the visited places from Google My Maps (KML export) or from a CSV export,
resolves an English name for each place, finds its country / territory / subdivision
offline with Natural Earth boundaries, and writes data/places.json for the website.

Usage:
    MYMAPS_ID=<map id> python scripts/sync.py        # normal mode (GitHub Actions)
    python scripts/sync.py --from-csv data/source/visitati.csv   # bootstrap mode

Always updates data/sync_status.json. Never touches data/places.json on failure.
"""

import argparse
import csv
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.ops import nearest_points
from shapely.strtree import STRtree

import naturalearth

# ---------------------------------------------------------------- configuration

LAYER_NAME = "Visitati"  # the only My Maps layer that is read
KML_URL = "https://www.google.com/maps/d/kml?mid={mid}&forcekml=1"
REPO_URL = "https://github.com/dedavi97/Dedavi_Travels"
USER_AGENT = f"Dedavi_Travels/1.0 (+{REPO_URL})"
NOMINATIM_URL = "https://nominatim.openstreetmap.org"
NOMINATIM_MIN_INTERVAL = 1.1  # seconds between requests (policy: max 1 per second)
SEARCH_BOX_DEG = 0.5          # search viewbox: +/- this many degrees around the point
COASTAL_MAX_KM = 25           # points outside every polygon snap to one this close

# Countries that get a subdivision level in the stats (by Natural Earth ADM0_A3).
# Value = how to read the subdivision name from the admin-1 feature properties.
SUBDIVISIONS = {
    "ITA": "region",    # NE units are provinces: grouped by their region
    "USA": "name",      # states
    "GBR": "geonunit",  # England / Scotland / Wales / Northern Ireland
}

ITALY_REGIONS_EN = {
    "Valle d'Aosta": "Aosta Valley",
    "Piemonte": "Piedmont",
    "Lombardia": "Lombardy",
    "Trentino-Alto Adige": "Trentino-South Tyrol",
    "Toscana": "Tuscany",
    "Sardegna": "Sardinia",
    "Sicilia": "Sicily",
    "Puglia": "Apulia",
}

# Shorter / more common English names for some countries (by ADM0_A3).
COUNTRY_NAMES = {
    "USA": "United States",
    "CZE": "Czechia",
}

# UN-style sovereignty fixes where Natural Earth's SOVEREIGNT field differs.
SOVEREIGN_OVERRIDES = {
    "PSX": ("Palestine", "PS"),  # NE lists Palestine under Israel; UN observer state
}

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PLACES_FILE = DATA / "places.json"
STATUS_FILE = DATA / "sync_status.json"
CACHE_FILE = DATA / "name_cache.json"
OVERRIDES_FILE = DATA / "name_overrides.json"
LOCATION_OVERRIDES_FILE = DATA / "location_overrides.json"
REPORT_FILE = DATA / "name_report.md"


class SyncError(Exception):
    """A problem that must stop the sync without touching places.json."""


# ---------------------------------------------------------------- small helpers

def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_if_changed(path, text):
    """Write text to path only if it differs. Returns True if the file changed."""
    try:
        if path.read_text(encoding="utf-8") == text:
            return False
    except FileNotFoundError:
        pass
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def dump_json(obj):
    return json.dumps(obj, ensure_ascii=False, indent=2) + "\n"


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def place_key(name, lat, lon):
    return f"{name}|{lat:.5f}|{lon:.5f}"


def clean(value):
    """Natural Earth uses '-99' for 'no value'."""
    return None if value in (None, "", "-99", -99) else value


# ---------------------------------------------------------------- input

def points_from_kml(mid):
    url = KML_URL.format(mid=urllib.parse.quote(mid))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read()
    except Exception as e:
        raise SyncError(f"Could not download the map from Google My Maps ({e}). "
                        "Check that the map is shared as 'Anyone with the link' and that MYMAPS_ID is correct.")
    if raw[:2] == b"PK":  # KMZ (zipped KML)
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(next(n for n in z.namelist() if n.lower().endswith(".kml")))
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        raise SyncError("Google My Maps did not return a valid KML file. "
                        "Check that the map is shared as 'Anyone with the link'.")

    def local(tag):
        return tag.rsplit("}", 1)[-1]

    def child_text(el, name):
        for c in el:
            if local(c.tag) == name:
                return (c.text or "").strip()
        return ""

    folders = [el for el in root.iter() if local(el.tag) == "Folder"]
    layer = next((f for f in folders if child_text(f, "name") == LAYER_NAME), None)
    if layer is None:
        found = ", ".join(f"'{child_text(f, 'name')}'" for f in folders) or "none"
        raise SyncError(f"Layer '{LAYER_NAME}' not found in the map. Layers found: {found}.")

    points = []
    for pm in layer.iter():
        if local(pm.tag) != "Placemark":
            continue
        point = next((el for el in pm.iter() if local(el.tag) == "Point"), None)
        coords = child_text(point, "coordinates") if point is not None else ""
        if not coords:
            continue  # lines / polygons are ignored
        lon, lat = (float(v) for v in coords.split(",")[:2])
        points.append((child_text(pm, "name"), lat, lon))
    return points


def points_from_csv(path):
    points = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            m = re.match(r"\s*POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)", row.get("WKT", ""))
            if not m:
                continue
            points.append((row["nome"].strip(), float(m.group(2)), float(m.group(1))))
    return points


# ---------------------------------------------------------------- English names

class Nominatim:
    def __init__(self):
        self.last = 0.0

    def get(self, endpoint, params):
        wait = NOMINATIM_MIN_INTERVAL - (time.monotonic() - self.last)
        if wait > 0:
            time.sleep(wait)
        url = f"{NOMINATIM_URL}/{endpoint}?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        finally:
            self.last = time.monotonic()

    @staticmethod
    def english_name(result):
        if not result or not isinstance(result, dict) or "error" in result:
            return None
        details = result.get("namedetails") or {}
        return details.get("name:en") or result.get("name") or None

    def search(self, name, lat, lon):
        d = SEARCH_BOX_DEG
        res = self.get("search", {
            "q": name, "format": "jsonv2", "limit": 1, "bounded": 1,
            "viewbox": f"{lon - d},{lat + d},{lon + d},{lat - d}",
            "accept-language": "en", "namedetails": 1,
        })
        return self.english_name(res[0]) if res else None

    def reverse(self, lat, lon):
        res = self.get("reverse", {
            "lat": lat, "lon": lon, "zoom": 10, "format": "jsonv2",
            "accept-language": "en", "namedetails": 1,
        })
        return self.english_name(res)


def resolve_names(points):
    """Return {key: (english_name, method)} for every point, updating the cache."""
    overrides = read_json(OVERRIDES_FILE, {})
    cache = read_json(CACHE_FILE, {})
    nom = Nominatim()
    out = {}
    try:
        for name, lat, lon in points:
            key = place_key(name, lat, lon)
            if key in overrides or name in overrides:
                out[key] = (overrides.get(key) or overrides[name], "override")
                continue
            if key in cache:
                out[key] = (cache[key]["name"], cache[key]["method"])
                continue
            try:
                found, method = nom.search(name, lat, lon), "search"
                if not found:
                    found, method = nom.reverse(lat, lon), "reverse"
            except Exception as e:
                # Network trouble: use the original name now, retry next sync (not cached).
                print(f"  ! Nominatim failed for '{name}': {e}")
                out[key] = (name, "fallback (Nominatim unreachable, will retry)")
                continue
            if not found:
                found, method = name, "fallback"
            cache[key] = {"name": found, "method": method}
            out[key] = (found, method)
            print(f"  {name} -> {found} ({method})")
    finally:
        write_if_changed(CACHE_FILE, dump_json(dict(sorted(cache.items()))))
    return out


# ---------------------------------------------------------------- geography

class Locator:
    """Offline point-in-polygon on Natural Earth admin-0 and admin-1."""

    def __init__(self):
        admin0 = naturalearth.load(naturalearth.ADMIN0)["features"]
        self.c_props = [f["properties"] for f in admin0]
        self.c_geoms = [shape(f["geometry"]) for f in admin0]
        self.c_tree = STRtree(self.c_geoms)
        self.by_admin = {p["ADMIN"]: p for p in self.c_props}

        admin1 = [f for f in naturalearth.load(naturalearth.ADMIN1)["features"]
                  if f["properties"]["adm0_a3"] in SUBDIVISIONS]
        self.s_props = [f["properties"] for f in admin1]
        self.s_geoms = [shape(f["geometry"]) for f in admin1]
        self.s_tree = STRtree(self.s_geoms)

    @staticmethod
    def _find(tree, geoms, lat, lon, allowed=None):
        """Index of the polygon containing the point, else the nearest within COASTAL_MAX_KM.

        Returns (index or None, distance_km)."""
        pt = Point(lon, lat)
        hits = [i for i in tree.query(pt, predicate="intersects") if allowed is None or allowed(i)]
        if hits:
            return int(hits[0]), 0.0
        best, best_km = None, None
        for i in tree.query(pt.buffer(0.6)):  # ~0.6 deg box is > 25 km at any latitude used
            if allowed is not None and not allowed(i):
                continue
            q = nearest_points(geoms[i], pt)[0]
            km = haversine_km(lat, lon, q.y, q.x)
            if best_km is None or km < best_km:
                best, best_km = int(i), km
        if best is not None and best_km <= COASTAL_MAX_KM:
            return best, best_km
        return None, best_km

    def sovereign(self, p):
        if p["ADM0_A3"] in SOVEREIGN_OVERRIDES:
            return SOVEREIGN_OVERRIDES[p["ADM0_A3"]]
        sp = self.by_admin.get(p["SOVEREIGNT"], p)
        name = COUNTRY_NAMES.get(sp["ADM0_A3"]) or sp.get("NAME_EN") or sp["NAME"]
        return name, clean(sp["ISO_A2_EH"]) or clean(sp["ISO_A2"])

    def locate(self, lat, lon, forced_unit=None):
        """Return (location dict or None, note or None).

        forced_unit (an ADM0_A3 code from location_overrides.json) skips the
        country lookup, for pins where Natural Earth's border is not precise enough."""
        if forced_unit:
            i = next((k for k, p in enumerate(self.c_props) if p["ADM0_A3"] == forced_unit), None)
            if i is None:
                return None, f"location override '{forced_unit}' is not a Natural Earth ADM0_A3 code"
            km = 0.0
        else:
            i, km = self._find(self.c_tree, self.c_geoms, lat, lon)
        if i is None:
            far = f"{km:.0f} km" if km is not None else "far"
            return None, f"no country found (nearest border {far} away)"
        p = self.c_props[i]
        country, country_iso2 = self.sovereign(p)
        is_dependency = p["ADMIN"] != p["SOVEREIGNT"] and p["ADM0_A3"] not in SOVEREIGN_OVERRIDES
        loc = {
            "country": country,
            "country_iso2": country_iso2,
            "territory": (p.get("NAME_EN") or p["NAME"]) if is_dependency else None,
            "territory_iso2": (clean(p["ISO_A2_EH"]) or clean(p["ISO_A2"])) if is_dependency else None,
            "unit": p["ADM0_A3"],
            "subdivision": None,
            "continent": p["CONTINENT"],
        }
        note = f"snapped to {p['ADMIN']} ({km:.1f} km away)" if km else None
        if forced_unit:
            note = f"country set by location_overrides.json ({forced_unit})"

        a3 = p["ADM0_A3"]
        if a3 in SUBDIVISIONS:
            j, skm = self._find(self.s_tree, self.s_geoms, lat, lon,
                                allowed=lambda k: self.s_props[k]["adm0_a3"] == a3)
            if j is None:
                note = (note + "; " if note else "") + "no subdivision found"
            else:
                raw = self.s_props[j][SUBDIVISIONS[a3]]
                loc["subdivision"] = ITALY_REGIONS_EN.get(raw, raw) if a3 == "ITA" else raw
                if skm:
                    note = (note + "; " if note else "") + f"subdivision snapped ({skm:.1f} km away)"
        return loc, note


# ---------------------------------------------------------------- main

def build(points):
    names = resolve_names(points)
    locator = Locator()
    location_overrides = read_json(LOCATION_OVERRIDES_FILE, {})
    places, report, notes, seen = [], [], [], set()
    for name, lat, lon in points:
        key = place_key(name, lat, lon)
        pid = hashlib.sha1(key.encode("utf-8")).hexdigest()[:10]
        while pid in seen:  # identical duplicate pins
            pid = hashlib.sha1((pid + "+").encode()).hexdigest()[:10]
        seen.add(pid)
        en_name, method = names[key]
        loc, note = locator.locate(lat, lon, location_overrides.get(key) or location_overrides.get(name))
        if note:
            notes.append(f"- **{en_name}** ({lat:.5f}, {lon:.5f}): {note}")
            print(f"  ! {en_name}: {note}")
        places.append({
            "id": pid,
            "name": en_name,
            "original_name": name,
            "lat": round(lat, 5),
            "lon": round(lon, 5),
            **(loc or {"country": None, "country_iso2": None, "territory": None,
                       "territory_iso2": None, "unit": None, "subdivision": None,
                       "continent": None}),
        })
        report.append((name, en_name, method))
    return places, report, notes


def write_report(report, notes):
    fallbacks = sum(1 for _, _, m in report if m.startswith("fallback"))
    lines = [
        "# Name report",
        "",
        "How each place name was turned into English (generated by scripts/sync.py).",
        "To fix a name, add it to data/name_overrides.json: `\"Original name\": \"English name\"`.",
        "",
        f"Places: {len(report)}. Fallbacks (original name kept): {fallbacks}.",
        "",
        "| Original name | English name | Method |",
        "|---|---|---|",
    ]
    for orig, en, method in report:
        flag = " ⚠️" if method.startswith("fallback") else ""
        lines.append(f"| {orig} | {en} | {method}{flag} |")
    lines += ["", "## Location notes", ""]
    lines += notes or ["All places fell inside a country polygon."]
    write_if_changed(REPORT_FILE, "\n".join(lines) + "\n")


def main():
    for stream in (sys.stdout, sys.stderr):  # Windows consoles default to a legacy codepage
        stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--from-csv", metavar="FILE", help="read places from a My Maps CSV export")
    args = ap.parse_args()

    status = read_json(STATUS_FILE, {})
    status["last_check"] = now_iso()
    status.setdefault("last_data_change", None)
    try:
        if args.from_csv:
            source = "csv"
            points = points_from_csv(args.from_csv)
        else:
            source = "my_maps"
            mid = os.environ.get("MYMAPS_ID", "").strip()
            if not mid:
                raise SyncError("MYMAPS_ID is not set (GitHub secret missing).")
            points = points_from_kml(mid)
        if not points:
            raise SyncError(f"The layer '{LAYER_NAME}' contains 0 places: nothing was changed.")
        print(f"Read {len(points)} places from {source}.")

        places, report, notes = build(points)
        write_report(report, notes)
        if write_if_changed(PLACES_FILE, dump_json({"places": places})):
            status["last_data_change"] = status["last_check"]
            message = f"Updated: {len(places)} places."
        else:
            message = f"No changes: {len(places)} places."
        status.update(status="ok", message=message, place_count=len(places), source=source)
        print(message)
        return 0
    except SyncError as e:
        status.update(status="error", message=str(e))
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        status.update(status="error", message=f"Unexpected error: {e}")
        raise
    finally:
        write_if_changed(STATUS_FILE, dump_json(status))


if __name__ == "__main__":
    sys.exit(main())
