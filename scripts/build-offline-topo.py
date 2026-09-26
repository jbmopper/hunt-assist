#!/usr/bin/env python3
"""Cache a focused set of public-domain USGS topo tiles for offline field use."""

from __future__ import annotations

import argparse
import json
import math
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "public" / "data" / "offline-topo"
SERVICE = (
    "https://basemap.nationalmap.gov/arcgis/rest/services/"
    "USGSTopo/MapServer/tile/{z}/{y}/{x}"
)
ATTRIBUTION = "Map services and data available from U.S. Geological Survey, National Geospatial Program."

# Focused coverage around the three BE012O1R field areas. Bounds are
# west, south, east, north in WGS84 longitude/latitude.
AREAS = {
    "Rifle Creek": [-107.84, 39.57, -107.56, 39.79],
    "Trappers Lake": [-107.38, 39.88, -107.10, 40.10],
    "Chapman Reservoir": [-107.22, 40.07, -106.93, 40.28],
}
ZOOMS = range(7, 15)


def tile_xy(lon: float, lat: float, zoom: int) -> tuple[int, int]:
    scale = 2**zoom
    x = int((lon + 180.0) / 360.0 * scale)
    y = int(
        (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi)
        / 2.0
        * scale
    )
    return x, y


def required_tiles() -> list[tuple[int, int, int]]:
    tiles: set[tuple[int, int, int]] = set()
    for zoom in ZOOMS:
        for west, south, east, north in AREAS.values():
            left, bottom = tile_xy(west, south, zoom)
            right, top = tile_xy(east, north, zoom)
            for x in range(min(left, right), max(left, right) + 1):
                for y in range(min(top, bottom), max(top, bottom) + 1):
                    tiles.add((zoom, x, y))
    return sorted(tiles)


def download_tile(tile: tuple[int, int, int], force: bool) -> tuple[str, int]:
    zoom, x, y = tile
    destination = OUTPUT / str(zoom) / str(x) / f"{y}.jpg"
    if destination.exists() and destination.stat().st_size > 1_000 and not force:
        return "cached", destination.stat().st_size

    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(
        SERVICE.format(z=zoom, x=x, y=y),
        headers={"User-Agent": "hunt-assist-offline-cache/1.0"},
    )
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
                content_type = response.headers.get_content_type()
            if content_type != "image/jpeg" or len(data) < 1_000:
                raise RuntimeError(
                    f"unexpected response for {zoom}/{x}/{y}: "
                    f"{content_type}, {len(data)} bytes"
                )
            destination.write_bytes(data)
            return "downloaded", len(data)
        except (OSError, RuntimeError, urllib.error.URLError) as error:
            last_error = error
            time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"failed {zoom}/{x}/{y}: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="redownload cached tiles")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()

    tiles = required_tiles()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    totals = {"cached": 0, "downloaded": 0, "bytes": 0}

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(download_tile, tile, args.force): tile for tile in tiles}
        for index, future in enumerate(as_completed(futures), start=1):
            status, size = future.result()
            totals[status] += 1
            totals["bytes"] += size
            if index % 100 == 0 or index == len(tiles):
                print(f"{index}/{len(tiles)} tiles ready")

    manifest = {
        "source": "USGS The National Map — USGSTopo",
        "service": SERVICE,
        "attribution": ATTRIBUTION,
        "generated": date.today().isoformat(),
        "zoomRange": [min(ZOOMS), max(ZOOMS)],
        "areas": AREAS,
        "tileCount": len(tiles),
        "totalBytes": totals["bytes"],
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"USGS topo cache complete: {totals['downloaded']} downloaded, "
        f"{totals['cached']} cached, {totals['bytes'] / 1_000_000:.1f} MB"
    )


if __name__ == "__main__":
    main()
