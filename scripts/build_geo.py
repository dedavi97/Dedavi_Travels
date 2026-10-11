"""Build the lightweight world map files used by the website (data/geo/).

Run once (or after a Natural Earth upgrade):  python scripts/build_geo.py

- countries.geojson: Natural Earth 10m admin-0 polygons, simplified and rounded so the
  file stays under 2 MB, while keeping microstates (Vatican, Monaco, San Marino...).
- subdivisions.geojson: internal first-level boundaries (Italian regions, US states...)
  as lines, drawn faintly on the map.
- water.geojson: main lakes (polygons) and rivers (lines), for a more natural look.
"""

import json
import sys

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

import naturalearth
from sync import COUNTRY_NAMES, ROOT

TOLERANCE = 0.04      # degrees (~4 km); small shapes use a proportionally finer tolerance
MIN_AREA = 0.002      # drop islands smaller than this (sq. degrees) unless it is the whole unit
DECIMALS = 4          # coordinate rounding (~10 m, keeps microstates recognisable)
OUT = ROOT / "data" / "geo" / "countries.geojson"
SUB_OUT = ROOT / "data" / "geo" / "subdivisions.geojson"

# Natural Earth admin-1 units are sometimes second-level (Italian provinces, French
# departments...): for these countries, merge them by this property first.
# Everywhere else each admin-1 unit is used as is.
SUB_GROUPING = {
    "ITA": "region",
    "FRA": "region",
    "ESP": "region",
    "SVN": "region",
    "LVA": "region",
    "GBR": "geonunit",
}
SUB_TOLERANCE = 0.03  # degrees
SUB_DECIMALS = 3
OUTLINE_BUFFER = 0.03  # drop lines this close to the country outline (coasts, borders)

WATER_OUT = ROOT / "data" / "geo" / "water.geojson"
LAKES = "ne_10m_lakes"
RIVERS = "ne_10m_rivers_lake_centerlines"
LAKE_MAX_RANK = 7      # Natural Earth scalerank: lower = more important
LAKE_MIN_AREA = 0.004  # sq. degrees (Lake Garda ~0.04)
RIVER_MAX_RANK = 6
WATER_TOLERANCE = 0.01


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


def build_subdivisions():
    """Internal boundaries between first-level subdivisions, one MultiLineString per country."""
    units = {}
    for f in naturalearth.load(naturalearth.ADMIN1)["features"]:
        p = f["properties"]
        a3 = p["adm0_a3"]
        key = p.get(SUB_GROUPING.get(a3, "name")) or p["name"]
        units.setdefault(a3, {}).setdefault(key, []).append(shape(f["geometry"]).buffer(0))
    features = []
    for a3, groups in sorted(units.items()):
        if len(groups) < 2:
            continue
        merged = [unary_union(geoms) for geoms in groups.values()]
        outline = unary_union(merged).boundary.buffer(OUTLINE_BUFFER)
        lines = unary_union([g.boundary for g in merged]).difference(outline)
        lines = lines.simplify(SUB_TOLERANCE)
        if lines.is_empty:
            continue
        parts = [lines] if lines.geom_type == "LineString" else [
            g for g in getattr(lines, "geoms", []) if g.geom_type == "LineString"]
        coords = [[[round(x, SUB_DECIMALS), round(y, SUB_DECIMALS)] for x, y in part.coords]
                  for part in parts if part.length > 0.05]
        if coords:
            features.append({"type": "Feature", "properties": {"id": a3},
                             "geometry": {"type": "MultiLineString", "coordinates": coords}})
    text = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))
    SUB_OUT.write_text(text, encoding="utf-8")
    print(f"Wrote {SUB_OUT} ({len(text) / 1e6:.2f} MB, {len(features)} countries)")


def build_water():
    features = []
    for f in naturalearth.load(LAKES)["features"]:
        p = f["properties"]
        if (p.get("scalerank") or 99) > LAKE_MAX_RANK or not f["geometry"]:
            continue
        g = shape(f["geometry"]).buffer(0)
        if g.area < LAKE_MIN_AREA:
            continue
        g = g.simplify(WATER_TOLERANCE, preserve_topology=True)
        features.append({"type": "Feature", "properties": {"kind": "lake"},
                         "geometry": json.loads(json.dumps(mapping(g)), parse_float=lambda v: round(float(v), SUB_DECIMALS))})
    for f in naturalearth.load(RIVERS)["features"]:
        p = f["properties"]
        if (p.get("scalerank") or 99) > RIVER_MAX_RANK or not f["geometry"]:
            continue
        g = shape(f["geometry"]).simplify(WATER_TOLERANCE * 2)
        features.append({"type": "Feature", "properties": {"kind": "river", "rank": int(p["scalerank"])},
                         "geometry": json.loads(json.dumps(mapping(g)), parse_float=lambda v: round(float(v), SUB_DECIMALS))})
    text = json.dumps({"type": "FeatureCollection", "features": features}, separators=(",", ":"))
    WATER_OUT.write_text(text, encoding="utf-8")
    print(f"Wrote {WATER_OUT} ({len(text) / 1e6:.2f} MB, {len(features)} features)")


def main():
    build_water()
    build_subdivisions()
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
                "tone": (p.get("MAPCOLOR7") or 1) % 4,  # neighbours get different tones
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
