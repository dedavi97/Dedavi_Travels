"""Download and load Natural Earth boundary files (shared by sync.py and build_geo.py).

The full-resolution files are large (~55 MB), so they are not committed: they are
downloaded once into .cache/naturalearth/ (git-ignored, cached in GitHub Actions).
"""

import json
import urllib.request
from pathlib import Path

NE_VERSION = "v5.1.2"
NE_BASE_URL = f"https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{NE_VERSION}/geojson/"
ADMIN0 = "ne_10m_admin_0_countries"
ADMIN1 = "ne_10m_admin_1_states_provinces"

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / ".cache" / "naturalearth"


def load(name):
    """Return the parsed GeoJSON for a Natural Earth layer, downloading it if needed."""
    path = CACHE_DIR / f"{name}.geojson"
    if not path.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        url = NE_BASE_URL + f"{name}.geojson"
        print(f"Downloading {url}")
        tmp = path.with_suffix(".part")
        with urllib.request.urlopen(url, timeout=300) as resp, open(tmp, "wb") as out:
            out.write(resp.read())
        tmp.replace(path)
    with open(path, encoding="utf-8") as f:
        return json.load(f)
