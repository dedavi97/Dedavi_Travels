"""Build the lightweight world map used by the website: data/geo/countries.geojson.

Run once (or after a Natural Earth upgrade):  python scripts/build_geo.py
Simplifies Natural Earth 10m admin-0 polygons and rounds coordinates so the file
stays well under 2 MB, while keeping microstates (Vatican, Monaco, San Marino...).
"""

import json
import sys

from shapely.geometry import mapping, shape

import naturalearth
from sync import COUNTRY_NAMES, ROOT

TOLERANCE = 0.04      # degrees (~4 km); small shapes use a proportionally finer tolerance
MIN_AREA = 0.002      # drop islands smaller than this (sq. degrees) unless it is the whole unit
DECIMALS = 4          # coordinate rounding (~10 m, keeps microstates recognisable)
OUT = ROOT / "data" / "geo" / "countries.geojson"


def round_coords(obj):
    if isinstance(obj, (list, tuple)):
        if obj and isinstance(obj[0], (int, float)):
            return [round(obj[0], DECIMALS), round(obj[1], DECIMALS)]
        return [round_coords(o) for o in obj]
    return obj


def simplify(geom):
    parts = list(geom.geoms) if geom.geom_type == "MultiPolygon" else [geom]
    largest = max(p.area for p in parts)
    kept = []
    for p in parts:
        if p.area < MIN_AREA and p.area < largest:
            continue
        s = p.simplify(min(TOLERANCE, p.area ** 0.5 / 20), preserve_topology=True)
        kept.append(s if not s.is_empty and s.area > 0 else p)
    return kept


def main():
    features = []
    for f in naturalearth.load(naturalearth.ADMIN0)["features"]:
        p = f["properties"]
        parts = simplify(shape(f["geometry"]))
        coords = [round_coords(mapping(part)["coordinates"]) for part in parts]
        features.append({
            "type": "Feature",
            "properties": {
                "id": p["ADM0_A3"],
                "name": COUNTRY_NAMES.get(p["ADM0_A3"]) or p.get("NAME_EN") or p["NAME"],
            },
            "geometry": {"type": "MultiPolygon", "coordinates": coords},
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps({"type": "FeatureCollection", "features": features},
                      ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8")
    print(f"Wrote {OUT} ({len(text) / 1e6:.2f} MB, {len(features)} units)")


if __name__ == "__main__":
    sys.exit(main())
