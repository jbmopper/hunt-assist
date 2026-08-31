#!/usr/bin/env python3
"""Build an explainable BE012O1R desk-scouting shortlist.

The web app only renders the resulting GeoJSON/GPX. Heavy geoprocessing stays in
this reproducible batch step so the hosted Cloudflare worker does not pretend it
can run a statewide raster model on demand.

Run with:

    uv run \
      --with numpy --with scipy --with rasterio --with shapely \
      --with pyproj --with requests --with scikit-image --with pyogrio \
      --with pandas \
      python scripts/build-bear-targets.py

The model ranks places to investigate. It is not a bear-location probability
surface and it does not establish access, an open season, or a safe shot.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import tempfile
import time
import zipfile
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pyogrio
import rasterio
import requests
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize, shapes
from rasterio.transform import from_origin, rowcol, xy
from rasterio.warp import reproject, transform_bounds
from scipy.ndimage import (
    binary_dilation,
    distance_transform_edt,
    gaussian_filter,
    maximum_filter,
    uniform_filter,
)
from shapely import make_valid
from shapely.geometry import LineString, Point, mapping, shape
from shapely.ops import transform as transform_geometry
from shapely.ops import unary_union
from skimage.draw import line as raster_line
from skimage.graph import route_through_array


HUNT_CODE = "BE012O1R"
HUNT_UNITS = (12, 13, 23, 24, 25, 26, 33, 131, 231)
OUTPUT_GEOJSON = Path("public/data/be012o1r-targets.geojson")
OUTPUT_GPX = Path("public/data/be012o1r-targets.gpx")

CPW_ADMIN_GMU = (
    "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/"
    "CPWAdminData/FeatureServer/6"
)
CPW_COTREX_TRAILS = (
    "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/"
    "CPWAdminData/FeatureServer/15"
)
CPW_BEAR_FALL = (
    "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/"
    "CPWSpeciesData/FeatureServer/19"
)
FEMA_DROUGHT = (
    "https://gis.fema.gov/arcgis/rest/services/Partner/"
    "Drought_Current/MapServer/0"
)
BLM_SMA = (
    "https://gis.blm.gov/arcgis/rest/services/lands/"
    "BLM_Natl_SMA_LimitedScale/MapServer"
)
USGS_3DEP = (
    "https://elevation.nationalmap.gov/arcgis/rest/services/"
    "3DEPElevation/ImageServer"
)
LANDFIRE_ROOT = (
    "https://lfps.usgs.gov/arcgis/rest/services/"
    "Landfire_LF2025"
)
EARTH_SEARCH = "https://earth-search.aws.element84.com/v1/search"
GNIS_COLORADO = (
    "https://prd-tnm.s3.amazonaws.com/StagedProducts/GeographicNames/"
    "FullModel/Gazetteer_CO_GPKG.zip"
)

SECTORS = (
    {
        "id": "crosho",
        "name": "Crosho–Sheriff's–Chapman",
        "longitude": -107.0943,
        "latitude": 40.1680,
        "radius_m": 18_000,
    },
    {
        "id": "south-fork",
        "name": "South Fork canyon",
        "longitude": -107.5415,
        "latitude": 39.8780,
        "radius_m": 18_000,
    },
    {
        "id": "vaughan",
        "name": "Vaughan–Ripple Creek",
        "longitude": -107.2940,
        "latitude": 40.1000,
        "radius_m": 18_000,
    },
)

SOURCE_LINKS = {
    "cpw": "https://cpw.state.co.us/maps-and-gis",
    "landfire": "https://landfire.gov/data/lf2025",
    "sentinel": "https://registry.opendata.aws/sentinel-2-l2a-cogs/",
    "terrain": "https://www.usgs.gov/3d-elevation-program/about-3dep-products-services",
    "drought": "https://droughtmonitor.unl.edu/CurrentMap.aspx",
}


class BuildWarning(RuntimeError):
    pass


def log(message: str) -> None:
    print(message, flush=True)


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "Accept": "application/json, application/geo+json, */*",
            "User-Agent": "hunt-assist-target-builder/0.1",
        }
    )
    return session


def request(
    session: requests.Session,
    method: str,
    url: str,
    *,
    timeout: int = 120,
    **kwargs: Any,
) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(4):
        try:
            response = session.request(method, url, timeout=timeout, **kwargs)
            response.raise_for_status()
            return response
        except (requests.RequestException, ValueError) as error:
            last_error = error
            if attempt == 3:
                break
            time.sleep(1.5 * (attempt + 1))
    raise BuildWarning(f"Unable to read {url}: {last_error}")


def arcgis_geojson(
    session: requests.Session,
    layer_url: str,
    *,
    where: str = "1=1",
    out_fields: str = "*",
    bbox: tuple[float, float, float, float] | None = None,
    max_offset: float = 0.00025,
) -> dict[str, Any]:
    params: dict[str, str] = {
        "where": where,
        "outFields": out_fields,
        "returnGeometry": "true",
        "outSR": "4326",
        "geometryPrecision": "6",
        "maxAllowableOffset": str(max_offset),
        "f": "geojson",
    }
    if bbox:
        params.update(
            {
                "geometry": ",".join(str(value) for value in bbox),
                "geometryType": "esriGeometryEnvelope",
                "inSR": "4326",
                "spatialRel": "esriSpatialRelIntersects",
            }
        )
    response = request(session, "GET", f"{layer_url}/query", params=params)
    collection = response.json()
    if collection.get("type") != "FeatureCollection":
        raise BuildWarning(f"{layer_url} did not return GeoJSON")
    return collection


def geometry_bounds(geometries: Iterable[Any]) -> tuple[float, float, float, float]:
    union = unary_union(list(geometries))
    return tuple(float(value) for value in union.bounds)


def export_image(
    session: requests.Session,
    service_url: str,
    destination: Path,
    bounds_3857: tuple[float, float, float, float],
    width: int,
    height: int,
    *,
    pixel_type: str,
    interpolation: str = "RSP_NearestNeighbor",
) -> np.ndarray:
    params = {
        "bbox": ",".join(f"{value:.3f}" for value in bounds_3857),
        "bboxSR": "3857",
        "imageSR": "3857",
        "size": f"{width},{height}",
        "format": "tiff",
        "pixelType": pixel_type,
        "interpolation": interpolation,
        "f": "image",
    }
    response = request(
        session,
        "GET",
        f"{service_url}/exportImage",
        params=params,
        timeout=180,
    )
    destination.write_bytes(response.content)
    with rasterio.open(destination) as source:
        data = source.read(1)
    if data.shape != (height, width):
        raise BuildWarning(
            f"{service_url} returned {data.shape}, expected {(height, width)}"
        )
    return data


def parse_evt_table(session: requests.Session) -> dict[int, dict[str, str]]:
    response = request(
        session,
        "GET",
        "https://landfire.gov/sites/default/files/CSV/LF2025/LF2025_EVT.csv",
    )
    rows = csv.DictReader(response.text.splitlines())
    return {int(row["VALUE"]): row for row in rows}


def normalize_percentile(
    values: np.ndarray,
    valid: np.ndarray,
    low: float = 8,
    high: float = 92,
) -> np.ndarray:
    samples = values[valid & np.isfinite(values)]
    if samples.size < 100:
        return np.full(values.shape, 0.5, dtype=np.float32)
    lower, upper = np.percentile(samples, [low, high])
    if upper <= lower:
        return np.full(values.shape, 0.5, dtype=np.float32)
    return np.clip((values - lower) / (upper - lower), 0, 1).astype(np.float32)


def landfire_scores(
    evt: np.ndarray,
    evc: np.ndarray,
    evt_table: dict[int, dict[str, str]],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    food = np.zeros(evt.shape, dtype=np.float32)
    cover = np.zeros(evt.shape, dtype=np.float32)
    open_food = np.zeros(evt.shape, dtype=bool)
    labels = np.full(evt.shape, "Unknown vegetation", dtype=object)

    tree_cover = np.where((evc >= 110) & (evc <= 199), evc - 100, 0)
    shrub_cover = np.where((evc >= 210) & (evc <= 299), evc - 200, 0)
    herb_cover = np.where((evc >= 310) & (evc <= 399), evc - 300, 0)

    for value in np.unique(evt):
        row = evt_table.get(int(value))
        if not row:
            continue
        mask = evt == value
        name = row.get("EVT_NAME", "Unknown vegetation")
        lifeform = row.get("EVT_LF", "")
        physiognomy = row.get("EVT_PHYS", "")
        group = row.get("EVT_GP_N", "")
        searchable = " ".join((name, lifeform, physiognomy, group)).lower()
        labels[mask] = name

        food_value = 0.08
        if any(
            token in searchable
            for token in (
                "riparian",
                "aspen",
                "gambel oak",
                "chokecherry",
                "serviceberry",
                "snowberry",
                "willow",
            )
        ):
            food_value = 1.0
        elif any(
            token in searchable
            for token in (
                "montane shrub",
                "mountain shrub",
                "mesic shrub",
                "deciduous shrub",
                "forbland",
            )
        ):
            food_value = 0.78
        elif any(
            token in searchable
            for token in ("shrubland", "grassland", "meadow", "herbaceous")
        ):
            food_value = 0.52
        elif "sagebrush" in searchable or "pasture" in searchable:
            food_value = 0.28
        if any(
            token in searchable
            for token in ("developed", "barren", "sparse", "snow", "alpine")
        ):
            food_value *= 0.15
        food[mask] = food_value

        if lifeform.lower() == "tree":
            local_cover = np.clip((tree_cover[mask] - 18) / 55, 0, 1)
        elif lifeform.lower() == "shrub":
            local_cover = np.clip((shrub_cover[mask] - 22) / 60, 0, 1) * 0.88
        else:
            local_cover = np.clip((herb_cover[mask] - 70) / 30, 0, 1) * 0.12
        cover[mask] = local_cover

    open_food = (food >= 0.46) & (cover <= 0.36)
    return food, cover, open_food, labels


def scene_tile(feature: dict[str, Any]) -> str:
    match = re.search(r"S2[ABC]_(\d{2}[A-Z]{3})_", feature.get("id", ""))
    return match.group(1) if match else feature.get("id", "unknown")


def earth_search(
    session: requests.Session,
    bbox: tuple[float, float, float, float],
    start: date,
    end: date,
    aoi_wgs84: Any,
    *,
    per_tile: int,
) -> list[dict[str, Any]]:
    payload = {
        "collections": ["sentinel-2-l2a"],
        "bbox": list(bbox),
        "datetime": f"{start.isoformat()}T00:00:00Z/{end.isoformat()}T23:59:59Z",
        "query": {"eo:cloud_cover": {"lt": 65}},
        "limit": 100,
    }
    features = request(
        session,
        "POST",
        EARTH_SEARCH,
        json=payload,
        timeout=90,
    ).json().get("features", [])
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    footprints: dict[str, list[Any]] = defaultdict(list)
    for feature in features:
        try:
            footprint = shape(feature["geometry"])
            if footprint.intersection(aoi_wgs84).area <= 0:
                continue
        except Exception:
            continue
        tile = scene_tile(feature)
        groups[tile].append(feature)
        footprints[tile].append(footprint)

    # MGRS tiles overlap at UTM-zone and latitude-band seams. A plain
    # intersection test can therefore select dozens of mostly redundant
    # scenes. Greedily retain only tiles that add meaningful AOI coverage.
    tile_footprints = {
        tile: unary_union(tile_shapes) for tile, tile_shapes in footprints.items()
    }
    remaining = aoi_wgs84
    selected_tiles: list[str] = []
    minimum_added_area = max(aoi_wgs84.area * 0.0005, 1e-7)
    while tile_footprints and remaining.area > minimum_added_area:
        tile, added_area = max(
            (
                (candidate, footprint.intersection(remaining).area)
                for candidate, footprint in tile_footprints.items()
            ),
            key=lambda item: item[1],
        )
        if added_area <= minimum_added_area:
            break
        selected_tiles.append(tile)
        remaining = remaining.difference(tile_footprints.pop(tile))

    log(
        f"  selected {len(selected_tiles)} covering tiles from "
        f"{len(groups)} intersecting MGRS tiles"
    )

    selected: list[dict[str, Any]] = []
    for tile in selected_tiles:
        group = groups[tile]

        def scene_rank(feature: dict[str, Any]) -> tuple[float, str]:
            properties = feature.get("properties", {})
            observed_text = properties.get("datetime", "")
            try:
                observed_date = date.fromisoformat(str(observed_text)[:10])
                age_days = max(0, (end - observed_date).days)
            except ValueError:
                age_days = 60
            # Cloud matters, but a perfectly clear month-old scene should not
            # automatically outrank a reasonably clear scene from last week.
            quality_cost = float(properties.get("eo:cloud_cover", 100)) + 1.25 * age_days
            return quality_cost, str(observed_text)

        group.sort(
            key=scene_rank
        )
        selected.extend(group[:per_tile])
    return selected


def warp_asset(
    url: str,
    shape_: tuple[int, int],
    transform: rasterio.Affine,
    *,
    resampling: Resampling,
    dtype: str,
    nodata: float | int,
) -> np.ndarray:
    destination = np.full(shape_, nodata, dtype=dtype)
    with rasterio.open(url) as source:
        reproject(
            source=rasterio.band(source, 1),
            destination=destination,
            src_transform=source.transform,
            src_crs=source.crs,
            src_nodata=source.nodata,
            dst_transform=transform,
            dst_crs="EPSG:3857",
            dst_nodata=nodata,
            resampling=resampling,
        )
    return destination


def composite_ndvi(
    features: list[dict[str, Any]],
    shape_: tuple[int, int],
    transform: rasterio.Affine,
    mask: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, str | None]:
    total = np.zeros(shape_, dtype=np.float32)
    count = np.zeros(shape_, dtype=np.uint16)
    newest: str | None = None
    for index, feature in enumerate(features, start=1):
        identifier = feature.get("id", f"scene {index}")
        log(f"  Sentinel scene {index}/{len(features)}: {identifier}")
        assets = feature.get("assets", {})
        red_asset = assets.get("red", {})
        nir_asset = assets.get("nir", {})
        scl_asset = assets.get("scl", {})
        if not all(asset.get("href") for asset in (red_asset, nir_asset, scl_asset)):
            continue
        try:
            red = warp_asset(
                red_asset["href"],
                shape_,
                transform,
                resampling=Resampling.average,
                dtype="float32",
                nodata=np.nan,
            )
            nir = warp_asset(
                nir_asset["href"],
                shape_,
                transform,
                resampling=Resampling.average,
                dtype="float32",
                nodata=np.nan,
            )
            scl = warp_asset(
                scl_asset["href"],
                shape_,
                transform,
                resampling=Resampling.nearest,
                dtype="uint8",
                nodata=0,
            )
        except Exception as error:
            log(f"    skipped: {error}")
            continue

        red_band = red_asset.get("raster:bands", [{}])[0]
        nir_band = nir_asset.get("raster:bands", [{}])[0]
        red = red * float(red_band.get("scale", 1)) + float(
            red_band.get("offset", 0)
        )
        nir = nir * float(nir_band.get("scale", 1)) + float(
            nir_band.get("offset", 0)
        )
        denominator = nir + red
        valid = (
            mask
            & np.isfinite(red)
            & np.isfinite(nir)
            & (denominator > 0.02)
            & np.isin(scl, (4, 5, 7))
        )
        ndvi = np.zeros(shape_, dtype=np.float32)
        ndvi[valid] = np.clip((nir[valid] - red[valid]) / denominator[valid], -1, 1)
        total[valid] += ndvi[valid]
        count[valid] += 1
        observed = feature.get("properties", {}).get("datetime")
        if isinstance(observed, str) and (newest is None or observed > newest):
            newest = observed

    composite = np.full(shape_, np.nan, dtype=np.float32)
    valid_count = count > 0
    composite[valid_count] = total[valid_count] / count[valid_count]
    return composite, count, newest


def fetch_sentinel_signal(
    session: requests.Session,
    bbox: tuple[float, float, float, float],
    aoi_wgs84: Any,
    mask: np.ndarray,
    transform: rasterio.Affine,
    as_of: date,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, str | None, list[str]]:
    warnings: list[str] = []
    shape_ = mask.shape
    recent_start = as_of - timedelta(days=28)
    recent = earth_search(
        session,
        bbox,
        recent_start,
        as_of,
        aoi_wgs84,
        per_tile=2,
    )
    if not recent:
        raise BuildWarning("No recent Sentinel-2 scenes found")
    log(f"Building recent NDVI from {len(recent)} scenes")
    current, current_count, newest = composite_ndvi(recent, shape_, transform, mask)

    historical_arrays: list[np.ndarray] = []
    historical_counts: list[np.ndarray] = []
    for year in (as_of.year - 1, as_of.year - 2):
        start = date(year, recent_start.month, recent_start.day)
        end = date(year, as_of.month, as_of.day)
        scenes = earth_search(
            session,
            bbox,
            start,
            end,
            aoi_wgs84,
            per_tile=1,
        )
        if not scenes:
            warnings.append(f"No Sentinel baseline scenes for {year}")
            continue
        log(f"Building {year} baseline from {len(scenes)} scenes")
        composite, count, _ = composite_ndvi(scenes, shape_, transform, mask)
        historical_arrays.append(composite)
        historical_counts.append(count)

    if historical_arrays:
        stack = np.stack(historical_arrays)
        valid_years = np.sum(np.isfinite(stack), axis=0)
        baseline = np.full(shape_, np.nan, dtype=np.float32)
        np.divide(
            np.nansum(stack, axis=0),
            valid_years,
            out=baseline,
            where=valid_years > 0,
        )
        baseline_count = np.sum(np.stack(historical_counts), axis=0)
    else:
        baseline = np.full(shape_, np.nan, dtype=np.float32)
        baseline_count = np.zeros(shape_, dtype=np.uint16)
        warnings.append("No Sentinel historical baseline was available")

    anomaly = current - baseline
    coverage = np.where(mask, np.clip(current_count / 2, 0, 1), 0).astype(np.float32)
    return current, anomaly, coverage, newest, warnings


def rasterize_collection(
    collection: dict[str, Any],
    transform: rasterio.Affine,
    shape_: tuple[int, int],
    *,
    projector: Transformer,
    value: int | float = 1,
    property_name: str | None = None,
    default: int | float = 0,
    dtype: str = "uint8",
) -> np.ndarray:
    entries = []
    for feature in collection.get("features", []):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        feature_value = value
        if property_name:
            feature_value = feature.get("properties", {}).get(property_name, default)
        projected = transform_geometry(projector.transform, shape(geometry))
        entries.append((mapping(projected), feature_value))
    return rasterize(
        entries,
        out_shape=shape_,
        transform=transform,
        fill=default,
        dtype=dtype,
        all_touched=True,
    )


def public_land_mask(
    session: requests.Session,
    bbox: tuple[float, float, float, float],
    aoi_wgs84: Any,
    transform: rasterio.Affine,
    shape_: tuple[int, int],
    projector: Transformer,
) -> tuple[np.ndarray, list[str]]:
    warnings: list[str] = []
    geometries = []
    for layer_id, label in ((22, "BLM"), (24, "USFS"), (26, "USBR")):
        try:
            collection = arcgis_geojson(
                session,
                f"{BLM_SMA}/{layer_id}",
                bbox=bbox,
                out_fields="ADMIN_AGENCY_CODE,ADMIN_UNIT_NAME",
                max_offset=0.001,
            )
            for feature in collection.get("features", []):
                geometry = make_valid(shape(feature["geometry"])).intersection(
                    aoi_wgs84
                )
                if not geometry.is_empty:
                    projected = transform_geometry(projector.transform, geometry)
                    geometries.append(mapping(projected))
        except Exception as error:
            warnings.append(f"{label} public-land geometry unavailable: {error}")
    if not geometries:
        warnings.append("Public-land gate unavailable; hunt boundary used as fallback")
        return np.ones(shape_, dtype=bool), warnings
    mask = rasterize(
        [(geometry, 1) for geometry in geometries],
        out_shape=shape_,
        transform=transform,
        fill=0,
        dtype="uint8",
        all_touched=True,
    ).astype(bool)
    return mask, warnings


def terrain_scores(
    elevation: np.ndarray,
    mask: np.ndarray,
    pixel_ground_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    valid_elevation = np.where(mask & (elevation > -500), elevation, np.nan)
    fill_value = float(np.nanmedian(valid_elevation))
    filled = np.where(np.isfinite(valid_elevation), valid_elevation, fill_value)
    gradient_y, gradient_x = np.gradient(filled, pixel_ground_m, pixel_ground_m)
    slope = np.degrees(np.arctan(np.hypot(gradient_x, gradient_y))).astype(np.float32)
    aspect = (np.degrees(np.arctan2(gradient_x, -gradient_y)) + 360) % 360

    local_elevation = gaussian_filter(filled, sigma=8)
    tpi = filled - local_elevation
    local_slope = gaussian_filter(slope, sigma=6)
    draw = (
        np.clip((-tpi - 2) / 38, 0, 1)
        * np.clip((slope - 2) / 8, 0, 1)
        * np.clip((34 - slope) / 16, 0, 1)
    ).astype(np.float32)
    bench = (
        np.clip((local_slope - slope - 1) / 8, 0, 1)
        * np.clip((slope - 2) / 6, 0, 1)
        * np.clip((24 - slope) / 12, 0, 1)
    ).astype(np.float32)
    northeast = ((1 + np.cos(np.radians(aspect - 45))) / 2).astype(np.float32)
    slope[~mask] = 90
    draw[~mask] = 0
    bench[~mask] = 0
    northeast[~mask] = 0
    aspect[~mask] = 0
    return slope, aspect.astype(np.float32), draw, bench, northeast


def line_of_sight(
    elevation: np.ndarray,
    cover: np.ndarray,
    start: tuple[int, int],
    end: tuple[int, int],
) -> bool:
    rows, columns = raster_line(start[0], start[1], end[0], end[1])
    if len(rows) < 4:
        return False
    terrain = elevation[rows, columns].astype(float)
    expected = np.linspace(terrain[0] + 1.8, terrain[-1] + 1.0, len(terrain))
    terrain_clear = np.max(terrain[1:-1] - expected[1:-1]) < 3.5
    vegetation_clear = float(np.mean(cover[rows, columns])) < 0.43
    return terrain_clear and vegetation_clear


def nearest_true(mask: np.ndarray, origin: tuple[int, int], radius: int) -> tuple[int, int] | None:
    row, column = origin
    row_min = max(0, row - radius)
    row_max = min(mask.shape[0], row + radius + 1)
    col_min = max(0, column - radius)
    col_max = min(mask.shape[1], column + radius + 1)
    local = np.argwhere(mask[row_min:row_max, col_min:col_max])
    if not local.size:
        return None
    local[:, 0] += row_min
    local[:, 1] += col_min
    distances = np.square(local[:, 0] - row) + np.square(local[:, 1] - column)
    selected = local[int(np.argmin(distances))]
    return int(selected[0]), int(selected[1])


def least_cost_corridor(
    target: tuple[int, int],
    food_mask: np.ndarray,
    secure_mask: np.ndarray,
    cost: np.ndarray,
    radius: int,
) -> list[tuple[int, int]]:
    start = nearest_true(food_mask, target, radius)
    if start is None:
        return [target]
    secure_candidates = secure_mask.copy()
    row, column = start
    inner = max(3, radius // 4)
    secure_candidates[
        max(0, row - inner) : row + inner + 1,
        max(0, column - inner) : column + inner + 1,
    ] = False
    end = nearest_true(secure_candidates, start, radius)
    if end is None:
        return [start, target]

    margin = 12
    row_min = max(0, min(start[0], end[0]) - margin)
    row_max = min(cost.shape[0], max(start[0], end[0]) + margin + 1)
    col_min = max(0, min(start[1], end[1]) - margin)
    col_max = min(cost.shape[1], max(start[1], end[1]) + margin + 1)
    local_cost = cost[row_min:row_max, col_min:col_max]
    local_start = (start[0] - row_min, start[1] - col_min)
    local_end = (end[0] - row_min, end[1] - col_min)
    try:
        route, _ = route_through_array(
            local_cost,
            local_start,
            local_end,
            fully_connected=True,
            geometric=True,
        )
    except Exception:
        return [start, target, end]
    return [(row + row_min, column + col_min) for row, column in route[::3]]


def choose_glassing_point(
    target: tuple[int, int],
    elevation: np.ndarray,
    cover: np.ndarray,
    open_mask: np.ndarray,
    public_mask: np.ndarray,
    pixel_ground_m: float,
) -> tuple[int, int] | None:
    row, column = target
    minimum = max(4, round(350 / pixel_ground_m))
    maximum = max(minimum + 1, round(1_150 / pixel_ground_m))
    row_min = max(0, row - maximum)
    row_max = min(open_mask.shape[0], row + maximum + 1)
    col_min = max(0, column - maximum)
    col_max = min(open_mask.shape[1], column + maximum + 1)
    local = np.argwhere(
        open_mask[row_min:row_max, col_min:col_max]
        & public_mask[row_min:row_max, col_min:col_max]
    )
    if not local.size:
        return None
    local[:, 0] += row_min
    local[:, 1] += col_min
    distances = np.hypot(local[:, 0] - row, local[:, 1] - column)
    valid = (distances >= minimum) & (distances <= maximum)
    local = local[valid]
    distances = distances[valid]
    if not local.size:
        return None
    elevation_gain = elevation[local[:, 0], local[:, 1]] - elevation[row, column]
    desirability = -np.abs(distances * pixel_ground_m - 700) / 700
    desirability += np.clip(elevation_gain / 140, -0.5, 1)
    order = np.argsort(desirability)[::-1][:80]
    for selected in order:
        candidate = (int(local[selected, 0]), int(local[selected, 1]))
        if line_of_sight(elevation, cover, candidate, target):
            return candidate
    return None


def read_gnis_names(session: requests.Session, directory: Path, bbox: tuple[float, ...]) -> list[dict[str, Any]]:
    archive = directory / "gnis.zip"
    archive.write_bytes(request(session, "GET", GNIS_COLORADO, timeout=180).content)
    with zipfile.ZipFile(archive) as bundle:
        bundle.extractall(directory / "gnis")
    geopackages = list((directory / "gnis").rglob("*.gpkg"))
    if not geopackages:
        return []
    package = geopackages[0]
    columns = ("feature_name", "feature_class", "prim_lat_dec", "prim_long_dec")
    metadata, _, _, field_arrays = pyogrio.raw.read(
        package,
        layer="DomesticNames",
        columns=list(columns),
        bbox=bbox,
    )
    returned_fields = [str(field) for field in metadata["fields"]]
    values = dict(zip(returned_fields, field_arrays))
    names: list[dict[str, Any]] = []
    for feature_name, feature_class, latitude, longitude in zip(
        values["feature_name"],
        values["feature_class"],
        values["prim_lat_dec"],
        values["prim_long_dec"],
    ):
        if feature_name is None or not np.isfinite(latitude) or not np.isfinite(longitude):
            continue
        names.append(
            {
                "name": str(feature_name),
                "class": str(feature_class) if feature_class is not None else "Feature",
                "longitude": float(longitude),
                "latitude": float(latitude),
            }
        )
    return names


def nearest_name(
    names: list[dict[str, Any]],
    longitude: float,
    latitude: float,
) -> dict[str, Any] | None:
    if not names:
        return None
    preferred = {
        "Stream",
        "Lake",
        "Reservoir",
        "Valley",
        "Summit",
        "Ridge",
        "Gap",
    }
    candidates = [name for name in names if name.get("class") in preferred] or names
    latitude_scale = math.cos(math.radians(latitude))
    return min(
        candidates,
        key=lambda item: (
            ((item["longitude"] - longitude) * latitude_scale) ** 2
            + (item["latitude"] - latitude) ** 2
        ),
    )


def point_from_cell(
    transform: rasterio.Affine,
    inverse_transformer: Transformer,
    cell: tuple[int, int],
) -> Point:
    x_coord, y_coord = xy(transform, cell[0], cell[1])
    longitude, latitude = inverse_transformer.transform(x_coord, y_coord)
    return Point(longitude, latitude)


def route_geometry(
    transform: rasterio.Affine,
    inverse_transformer: Transformer,
    route: list[tuple[int, int]],
) -> LineString:
    coordinates = []
    for row, column in route:
        x_coord, y_coord = xy(transform, row, column)
        coordinates.append(inverse_transformer.transform(x_coord, y_coord))
    if len(coordinates) == 1:
        coordinates.append(coordinates[0])
    return LineString(coordinates)


def component_polygon(
    candidate_score: np.ndarray,
    target: tuple[int, int],
    transform: rasterio.Affine,
    inverse_transformer: Transformer,
    pixel_ground_m: float,
) -> Any:
    row, column = target
    radius = max(4, round(450 / pixel_ground_m))
    local_threshold = max(0.42, float(candidate_score[row, column]) * 0.78)
    zone = candidate_score >= local_threshold
    rows, columns = np.ogrid[: zone.shape[0], : zone.shape[1]]
    zone &= np.square(rows - row) + np.square(columns - column) <= radius**2
    zone = binary_dilation(zone, iterations=1)
    polygons = []
    for geometry, value in shapes(zone.astype("uint8"), mask=zone, transform=transform):
        if value != 1:
            continue
        polygon = shape(geometry)
        point_x, point_y = xy(transform, row, column)
        if polygon.buffer(1).contains(Point(point_x, point_y)):
            polygons.append(polygon)
    if polygons:
        projected = max(polygons, key=lambda polygon: polygon.area).simplify(35)
    else:
        point_x, point_y = xy(transform, row, column)
        projected = Point(point_x, point_y).buffer(350)
    return transform_geometry(inverse_transformer.transform, projected)


def local_mean(values: np.ndarray, target: tuple[int, int], radius: int) -> float:
    row, column = target
    row_min = max(0, row - radius)
    row_max = min(values.shape[0], row + radius + 1)
    col_min = max(0, column - radius)
    col_max = min(values.shape[1], column + radius + 1)
    rows, columns = np.ogrid[row_min:row_max, col_min:col_max]
    circle = np.square(rows - row) + np.square(columns - column) <= radius**2
    samples = values[row_min:row_max, col_min:col_max][circle]
    samples = samples[np.isfinite(samples)]
    return float(np.mean(samples)) if samples.size else 0.0


def build_candidates(
    score: np.ndarray,
    eligible: np.ndarray,
    gmu_raster: np.ndarray,
    transform: rasterio.Affine,
    transformer: Transformer,
    pixel_ground_m: float,
) -> list[tuple[int, int]]:
    spacing = max(8, round(2_800 / pixel_ground_m))
    maxima = (score == maximum_filter(score, size=spacing, mode="nearest")) & eligible
    maxima &= score >= np.percentile(score[eligible], 78)
    cells = np.argwhere(maxima)
    cells = sorted(cells, key=lambda cell: float(score[cell[0], cell[1]]), reverse=True)

    selected: list[tuple[int, int]] = []
    selected_sectors: dict[str, int] = defaultdict(int)
    selected_units: dict[int, int] = defaultdict(int)
    sector_points = []
    for sector in SECTORS:
        x_coord, y_coord = transformer.transform(sector["longitude"], sector["latitude"])
        sector_points.append((sector, x_coord, y_coord))

    def cell_sector(cell: tuple[int, int]) -> str | None:
        x_coord, y_coord = xy(transform, cell[0], cell[1])
        matches: list[tuple[float, str]] = []
        for sector, sector_x, sector_y in sector_points:
            distance = math.hypot(x_coord - sector_x, y_coord - sector_y)
            projected_radius = sector["radius_m"] / math.cos(math.radians(40))
            if distance <= projected_radius:
                matches.append((distance / projected_radius, str(sector["id"])))
        return min(matches)[1] if matches else None

    minimum_spacing = 2_500 / pixel_ground_m

    def can_add(cell: tuple[int, int]) -> bool:
        if any(math.hypot(cell[0] - row, cell[1] - column) < minimum_spacing for row, column in selected):
            return False
        unit = int(gmu_raster[cell[0], cell[1]])
        return unit > 0 and selected_units[unit] < 2

    for sector in SECTORS:
        sector_id = str(sector["id"])
        for raw_cell in cells:
            cell = (int(raw_cell[0]), int(raw_cell[1]))
            if cell_sector(cell) != sector_id or not can_add(cell):
                continue
            selected.append(cell)
            selected_sectors[sector_id] += 1
            selected_units[int(gmu_raster[cell])] += 1
            if selected_sectors[sector_id] == 2:
                break

    for raw_cell in cells:
        if len(selected) >= 9:
            break
        cell = (int(raw_cell[0]), int(raw_cell[1]))
        if not can_add(cell):
            continue
        selected.append(cell)
        sector_id = cell_sector(cell)
        if sector_id:
            selected_sectors[sector_id] += 1
        selected_units[int(gmu_raster[cell])] += 1
    return sorted(selected, key=lambda cell: float(score[cell]), reverse=True)


def as_feature(geometry: Any, properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "Feature",
        "geometry": mapping(geometry),
        "properties": properties,
    }


def write_gpx(targets: list[dict[str, Any]], corridors: list[dict[str, Any]]) -> None:
    from xml.sax.saxutils import escape

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Colorado Hunt Finder" '
        'xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <metadata><name>{HUNT_CODE} desk-scouting targets</name></metadata>",
    ]
    for feature in targets:
        properties = feature["properties"]
        longitude, latitude = feature["geometry"]["coordinates"]
        lines.append(
            f'  <wpt lat="{latitude:.6f}" lon="{longitude:.6f}">'
            f"<name>{escape(properties['shortName'])}</name>"
            f"<desc>{escape(properties['summary'])}</desc></wpt>"
        )
    for feature in corridors:
        properties = feature["properties"]
        lines.append(f"  <trk><name>{escape(properties['name'])}</name><trkseg>")
        for longitude, latitude in feature["geometry"]["coordinates"]:
            lines.append(f'    <trkpt lat="{latitude:.6f}" lon="{longitude:.6f}" />')
        lines.append("  </trkseg></trk>")
    lines.append("</gpx>")
    OUTPUT_GPX.write_text("\n".join(lines) + "\n", encoding="utf-8")


def run(as_of: date, *, skip_satellite: bool = False) -> None:
    session = make_session()
    warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="hunt-assist-targets-") as temp_name:
        temporary = Path(temp_name)
        log("Loading current CPW hunt-unit boundaries")
        unit_where = f"GMUID IN ({','.join(str(unit) for unit in HUNT_UNITS)})"
        units_collection = arcgis_geojson(
            session,
            CPW_ADMIN_GMU,
            where=unit_where,
            out_fields="GMUID,COUNTY,BEARDAU,SqMilesGIS,EDIT_DATE",
            max_offset=0.00015,
        )
        unit_geometries = [shape(feature["geometry"]) for feature in units_collection["features"]]
        hunt_geometry = unary_union(unit_geometries)
        bbox = geometry_bounds(unit_geometries)

        forward = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
        inverse = Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True)
        mercator_bounds = transform_bounds("EPSG:4326", "EPSG:3857", *bbox, densify_pts=21)
        pixel_size = 75.0
        width = math.ceil((mercator_bounds[2] - mercator_bounds[0]) / pixel_size)
        height = math.ceil((mercator_bounds[3] - mercator_bounds[1]) / pixel_size)
        aligned_bounds = (
            mercator_bounds[0],
            mercator_bounds[3] - height * pixel_size,
            mercator_bounds[0] + width * pixel_size,
            mercator_bounds[3],
        )
        transform = from_origin(aligned_bounds[0], aligned_bounds[3], pixel_size, pixel_size)
        shape_ = (height, width)
        mean_latitude = (bbox[1] + bbox[3]) / 2
        pixel_ground_m = pixel_size * math.cos(math.radians(mean_latitude))

        hunt_mask = rasterize_collection(
            units_collection,
            transform,
            shape_,
            projector=forward,
            value=1,
        ).astype(bool)
        gmu_entries = [
            (
                mapping(
                    transform_geometry(
                        forward.transform,
                        shape(feature["geometry"]),
                    )
                ),
                int(feature["properties"]["GMUID"]),
            )
            for feature in units_collection["features"]
        ]
        gmu_raster = rasterize(
            gmu_entries,
            out_shape=shape_,
            transform=transform,
            fill=0,
            dtype="uint16",
            all_touched=True,
        )

        log(f"Analysis grid: {width} × {height} at ~{pixel_ground_m:.0f} m ground spacing")
        log("Downloading USGS terrain and LANDFIRE vegetation rasters")
        elevation = export_image(
            session,
            USGS_3DEP,
            temporary / "elevation.tif",
            aligned_bounds,
            width,
            height,
            pixel_type="F32",
            interpolation="RSP_BilinearInterpolation",
        ).astype(np.float32)
        evt = export_image(
            session,
            f"{LANDFIRE_ROOT}/LF2025_EVT_CONUS/ImageServer",
            temporary / "evt.tif",
            aligned_bounds,
            width,
            height,
            pixel_type="S16",
        ).astype(np.int16)
        evc = export_image(
            session,
            f"{LANDFIRE_ROOT}/LF2025_EVC_CONUS/ImageServer",
            temporary / "evc.tif",
            aligned_bounds,
            width,
            height,
            pixel_type="S16",
        ).astype(np.int16)
        evt_table = parse_evt_table(session)
        food_class, cover, open_food, vegetation_labels = landfire_scores(evt, evc, evt_table)
        log(
            "Vegetation diagnostics: "
            f"{np.count_nonzero(open_food & hunt_mask):,} open-food cells; "
            f"food max {float(food_class[hunt_mask].max()):.2f}; "
            f"cover max {float(cover[hunt_mask].max()):.2f}"
        )

        slope, aspect, draw, bench, northeast = terrain_scores(
            elevation,
            hunt_mask,
            pixel_ground_m,
        )

        log("Loading CPW fall habitat, trail pressure, drought, and federal land")
        try:
            fall_collection = arcgis_geojson(
                session,
                CPW_BEAR_FALL,
                bbox=bbox,
                out_fields="ACTIVITYCO,EDIT_DATE",
                max_offset=0.00035,
            )
            fall_mask = rasterize_collection(
                fall_collection,
                transform,
                shape_,
                projector=forward,
                value=1,
            ).astype(bool)
        except Exception as error:
            warnings.append(f"CPW fall-concentration layer unavailable: {error}")
            fall_mask = np.zeros(shape_, dtype=bool)

        try:
            trail_collection = arcgis_geojson(
                session,
                CPW_COTREX_TRAILS,
                bbox=bbox,
                out_fields="name,trail_num,type,hiking,motorcycle,atv,ohv_gt_50,manager",
                max_offset=0.00025,
            )
            trail_mask = rasterize_collection(
                trail_collection,
                transform,
                shape_,
                projector=forward,
                value=1,
            ).astype(bool)
        except Exception as error:
            warnings.append(f"COTREX trail-pressure layer unavailable: {error}")
            trail_mask = np.zeros(shape_, dtype=bool)

        try:
            drought_collection = arcgis_geojson(
                session,
                FEMA_DROUGHT,
                bbox=bbox,
                out_fields="dm,update_dat",
                max_offset=0.001,
            )
            drought = rasterize_collection(
                drought_collection,
                transform,
                shape_,
                projector=forward,
                property_name="dm",
                default=0,
                dtype="uint8",
            )
            drought_dates = [
                feature.get("properties", {}).get("update_dat")
                for feature in drought_collection.get("features", [])
            ]
            drought_updated = max(
                (value for value in drought_dates if isinstance(value, (str, int, float))),
                default=None,
            )
        except Exception as error:
            warnings.append(f"Current drought polygons unavailable: {error}")
            drought = np.zeros(shape_, dtype=np.uint8)
            drought_updated = None

        public_mask, access_warnings = public_land_mask(
            session,
            bbox,
            hunt_geometry,
            transform,
            shape_,
            forward,
        )
        warnings.extend(access_warnings)
        public_mask &= hunt_mask
        log(
            "Mask diagnostics: "
            f"{np.count_nonzero(hunt_mask):,} hunt cells; "
            f"{np.count_nonzero(public_mask):,} federal-public cells; "
            f"{np.count_nonzero((slope >= 3) & (slope <= 38) & hunt_mask):,} "
            "terrain-eligible cells"
        )

        log("Building current and historical Sentinel-2 vegetation signal")
        try:
            if skip_satellite:
                raise BuildWarning("Satellite signal skipped by command-line option")
            with rasterio.Env(
                GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
                CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
                GDAL_HTTP_MULTIRANGE="YES",
                AWS_NO_SIGN_REQUEST="YES",
            ):
                current_ndvi, ndvi_anomaly, imagery_coverage, imagery_date, imagery_warnings = fetch_sentinel_signal(
                    session,
                    bbox,
                    hunt_geometry,
                    hunt_mask,
                    transform,
                    as_of,
                )
            warnings.extend(imagery_warnings)
        except Exception as error:
            warnings.append(f"Sentinel vegetation signal unavailable: {error}")
            current_ndvi = np.full(shape_, np.nan, dtype=np.float32)
            ndvi_anomaly = np.full(shape_, np.nan, dtype=np.float32)
            imagery_coverage = np.zeros(shape_, dtype=np.float32)
            imagery_date = None

        current_green = normalize_percentile(
            np.nan_to_num(current_ndvi, nan=0),
            hunt_mask & np.isfinite(current_ndvi),
        )
        anomaly_green = normalize_percentile(
            np.nan_to_num(ndvi_anomaly, nan=0),
            hunt_mask & np.isfinite(ndvi_anomaly),
            5,
            95,
        )
        satellite_signal = (
            0.68 * current_green + 0.32 * anomaly_green
        ) * imagery_coverage + 0.5 * (1 - imagery_coverage)
        drought_factor = np.clip(1 - drought.astype(np.float32) * 0.09, 0.58, 1)
        forage = food_class * (0.48 + 0.52 * satellite_signal) * drought_factor
        forage = gaussian_filter(forage, sigma=3)

        secure = np.clip(
            0.68 * cover
            + 0.17 * northeast
            + 0.15 * np.clip((slope - 12) / 18, 0, 1),
            0,
            1,
        )
        secure = gaussian_filter(secure, sigma=2)
        food_pixels = (forage >= 0.34) & open_food & hunt_mask
        secure_pixels = (secure >= 0.56) & hunt_mask
        distance_to_food = distance_transform_edt(~food_pixels) * pixel_ground_m
        distance_to_cover = distance_transform_edt(~secure_pixels) * pixel_ground_m
        food_interface = np.exp(-distance_to_food / 360)
        cover_interface = np.exp(-distance_to_cover / 220)
        interface = np.sqrt(food_interface * cover_interface)

        cover_width = distance_transform_edt(secure_pixels) * pixel_ground_m
        pinch = np.exp(-np.square((cover_width - 110) / 105)) * secure_pixels
        corridor = np.clip(
            0.38 * draw + 0.27 * bench + 0.35 * secure,
            0,
            1,
        )
        opening_fraction = uniform_filter(open_food.astype(np.float32), size=17)
        glassing_proxy = np.clip(
            1 - np.abs(opening_fraction - 0.28) / 0.28,
            0,
            1,
        ) * interface

        trail_distance = distance_transform_edt(~trail_mask) * pixel_ground_m
        trail_penalty = np.exp(-trail_distance / 230) * 0.75
        recreation_penalty = np.clip(trail_penalty, 0, 1)

        score = (
            0.27 * forage
            + 0.22 * interface
            + 0.18 * corridor
            + 0.13 * pinch
            + 0.10 * glassing_proxy
            + 0.10 * fall_mask.astype(np.float32)
            - 0.13 * recreation_penalty
        )
        score = gaussian_filter(score, sigma=3)
        eligible = (
            hunt_mask
            & public_mask
            & (slope >= 3)
            & (slope <= 38)
            & (interface >= 0.2)
            & (score > 0)
        )
        score[~eligible] = 0
        log(
            "Score diagnostics: "
            f"{np.count_nonzero(food_pixels):,} food cells; "
            f"{np.count_nonzero(secure_pixels):,} secure-cover cells; "
            f"{np.count_nonzero(interface >= 0.2):,} interface cells; "
            f"{np.count_nonzero(eligible):,} final eligible cells"
        )

        if not np.any(eligible):
            raise BuildWarning("No eligible public-land target cells were produced")

        target_cells = build_candidates(
            score,
            eligible,
            gmu_raster,
            transform,
            forward,
            pixel_ground_m,
        )
        if not target_cells:
            raise BuildWarning("Target selection produced no local maxima")

        try:
            log("Loading current USGS place names")
            gnis_names = read_gnis_names(session, temporary, bbox)
        except Exception as error:
            warnings.append(f"GNIS place names unavailable: {error}")
            gnis_names = []

        raw_scores = np.array([score[cell] for cell in target_cells])
        score_floor = float(np.percentile(score[eligible], 70))
        score_ceiling = float(max(np.percentile(score[eligible], 99.7), raw_scores.max()))

        features: list[dict[str, Any]] = []
        target_features: list[dict[str, Any]] = []
        corridor_features: list[dict[str, Any]] = []
        for feature in units_collection["features"]:
            features.append(
                as_feature(
                    shape(feature["geometry"]),
                    {
                        "kind": "hunt-boundary",
                        "huntCode": HUNT_CODE,
                        "gmu": int(feature["properties"]["GMUID"]),
                    },
                )
            )

        travel_cost = np.clip(
            1.2
            + np.square(np.clip((slope - 16) / 18, -0.5, 1.8))
            + 1.25 * (1 - cover)
            - 0.42 * draw
            - 0.25 * bench
            + 2.2 * trail_penalty,
            0.08,
            8,
        )
        travel_cost[~hunt_mask] = 100

        for rank, cell in enumerate(target_cells, start=1):
            point = point_from_cell(transform, inverse, cell)
            unit = int(gmu_raster[cell])
            nearest = nearest_name(gnis_names, point.x, point.y)

            sector = None
            point_3857 = Point(*forward.transform(point.x, point.y))
            sector_matches: list[tuple[float, dict[str, Any]]] = []
            for candidate_sector in SECTORS:
                sector_point = Point(
                    *forward.transform(
                        candidate_sector["longitude"], candidate_sector["latitude"]
                    )
                )
                projected_radius = candidate_sector["radius_m"] / math.cos(
                    math.radians(mean_latitude)
                )
                distance = point_3857.distance(sector_point)
                if distance <= projected_radius:
                    sector_matches.append(
                        (distance / projected_radius, candidate_sector)
                    )
            if sector_matches:
                sector = min(sector_matches, key=lambda match: match[0])[1]

            place_name = nearest["name"] if nearest else f"GMU {unit} terrain pocket"
            sector_name = sector["name"] if sector else f"GMU {unit} alternate"
            name = f"{sector_name} · {place_name}"
            short_name = f"T{rank:02d} · {place_name}"

            radius = max(3, round(260 / pixel_ground_m))
            components = {
                "forage": local_mean(forage, cell, radius),
                "cover": local_mean(interface, cell, radius),
                "travel": local_mean(corridor, cell, radius),
                "pinch": local_mean(pinch, cell, radius),
                "glassing": local_mean(glassing_proxy, cell, radius),
                "pressure": local_mean(recreation_penalty, cell, radius),
                "imageryCoverage": local_mean(imagery_coverage, cell, radius),
            }
            relative_score = int(
                round(
                    np.clip(
                        (float(score[cell]) - score_floor)
                        / max(score_ceiling - score_floor, 0.001),
                        0,
                        1,
                    )
                    * 35
                    + 60
                )
            )
            desk_score = 0
            desk_score += int(components["forage"] >= 0.37)
            desk_score += int(components["cover"] >= 0.45)
            desk_score += int(components["travel"] >= 0.47)
            desk_score += int(components["pinch"] >= 0.35)
            desk_score += int(components["glassing"] >= 0.35)
            if components["pressure"] >= 0.52:
                desk_score -= 2

            ranked_reasons = sorted(
                (
                    (components["forage"], "late-Aug vegetation signal at a likely food-cover edge"),
                    (components["cover"], "continuous security cover beside the opening"),
                    (components["travel"], "draw or bench terrain supports concealed travel"),
                    (components["pinch"], "cover narrows into a likely pinch"),
                    (components["glassing"], "small-opening geometry is potentially glassable"),
                ),
                reverse=True,
            )
            reasons = [reason for _, reason in ranked_reasons[:3]]
            if bool(fall_mask[cell]):
                reasons.insert(0, "inside CPW fall-concentration habitat")
                reasons = reasons[:3]
            caveats = [
                "verify current berries, mast, tracks, scat, and wind on foot",
                "verify parcel access, closures, discharge rules, and a safe backstop",
            ]
            if components["pressure"] >= 0.4:
                caveats.insert(0, "mapped trail pressure is close enough to matter")
            if components["imageryCoverage"] < 0.55:
                caveats.insert(0, "recent satellite coverage was partly cloud-limited")

            glassing_cell = choose_glassing_point(
                cell,
                elevation,
                cover,
                open_food,
                public_mask,
                pixel_ground_m,
            )
            if glassing_cell:
                glassing_point = point_from_cell(transform, inverse, glassing_cell)
                features.append(
                    as_feature(
                        glassing_point,
                        {
                            "kind": "glassing",
                            "targetId": f"target-{rank}",
                            "name": f"Potential glassing position for {short_name}",
                            "verified": False,
                        },
                    )
                )

            route = least_cost_corridor(
                cell,
                food_pixels,
                secure_pixels,
                travel_cost,
                max(10, round(1_800 / pixel_ground_m)),
            )
            corridor_geometry = route_geometry(transform, inverse, route)
            corridor_feature = as_feature(
                corridor_geometry,
                {
                    "kind": "corridor",
                    "targetId": f"target-{rank}",
                    "name": f"Modeled concealed route for {short_name}",
                    "verified": False,
                },
            )
            corridor_features.append(corridor_feature)
            features.append(corridor_feature)

            zone = component_polygon(score, cell, transform, inverse, pixel_ground_m)
            features.append(
                as_feature(
                    zone,
                    {
                        "kind": "target-zone",
                        "targetId": f"target-{rank}",
                        "rank": rank,
                        "relativeScore": relative_score,
                    },
                )
            )

            vegetation = str(vegetation_labels[cell])
            summary = (
                f"Relative desk score {relative_score}/100; GMU {unit}; "
                f"{vegetation}. Ground-truth before committing a hunt."
            )
            target_properties = {
                "kind": "target",
                "targetId": f"target-{rank}",
                "rank": rank,
                "name": name,
                "shortName": short_name,
                "sector": sector_name,
                "nearbyFeature": place_name,
                "nearbyFeatureType": nearest.get("class") if nearest else None,
                "huntCode": HUNT_CODE,
                "gmu": unit,
                "relativeScore": relative_score,
                "deskScore": max(-2, desk_score),
                "forage": round(components["forage"] * 100),
                "cover": round(components["cover"] * 100),
                "travel": round(components["travel"] * 100),
                "pinch": round(components["pinch"] * 100),
                "glassing": round(components["glassing"] * 100),
                "pressure": round(components["pressure"] * 100),
                "imageryCoverage": round(components["imageryCoverage"] * 100),
                "vegetation": vegetation,
                "elevationFt": round(float(elevation[cell]) * 3.28084),
                "slopeDegrees": round(float(slope[cell])),
                "aspect": round(float(aspect[cell])),
                "reason1": reasons[0],
                "reason2": reasons[1],
                "reason3": reasons[2],
                "caveat1": caveats[0],
                "caveat2": caveats[1],
                "summary": summary,
                "latitude": round(point.y, 6),
                "longitude": round(point.x, 6),
                "imageryDate": imagery_date[:10] if imagery_date else None,
                "analysisDate": as_of.isoformat(),
            }
            target_feature = as_feature(point, target_properties)
            target_features.append(target_feature)
            features.append(target_feature)

        metadata = {
            "huntCode": HUNT_CODE,
            "units": list(HUNT_UNITS),
            "season": "2026-09-02/2026-09-30",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "analysisDate": as_of.isoformat(),
            "imageryDate": imagery_date[:10] if imagery_date else None,
            "droughtUpdated": drought_updated,
            "methodVersion": "0.1-desk-scouting",
            "scoreMeaning": "Relative suitability within the BE012O1R hunt area; not bear probability.",
            "sources": SOURCE_LINKS,
            "warnings": warnings,
        }
        collection = {
            "type": "FeatureCollection",
            "features": features,
            "metadata": metadata,
        }
        OUTPUT_GEOJSON.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_GEOJSON.write_text(
            json.dumps(collection, separators=(",", ":")),
            encoding="utf-8",
        )
        write_gpx(target_features, corridor_features)
        log(
            f"Wrote {len(target_features)} targets to {OUTPUT_GEOJSON} and {OUTPUT_GPX}"
        )
        if warnings:
            log("Warnings:")
            for warning in warnings:
                log(f"  - {warning}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--as-of",
        type=date.fromisoformat,
        default=date.today(),
        help="Analysis date in YYYY-MM-DD format (default: today)",
    )
    parser.add_argument(
        "--skip-satellite",
        action="store_true",
        help="Build with a neutral vegetation signal for offline debugging",
    )
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    run(arguments.as_of, skip_satellite=arguments.skip_satellite)
