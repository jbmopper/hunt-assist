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
    find_objects,
    gaussian_filter,
    label as connected_components,
    maximum_filter,
    uniform_filter,
)
from shapely import make_valid
from shapely.geometry import LineString, Point, box, mapping, shape
from shapely.ops import transform as transform_geometry
from shapely.ops import unary_union
from skimage.draw import line as raster_line
from skimage.graph import MCP_Geometric, route_through_array


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
CPW_BEAR_CONFLICT = (
    "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/"
    "CPWSpeciesData/FeatureServer/20"
)
CPW_HUNTING_ATLAS_BASE = (
    "https://ndismaps.nrel.colostate.edu/arcgis/rest/services/"
    "HuntingAtlas/HuntingAtlas_Base_Map/MapServer"
)
CPW_CAMPGROUNDS = f"{CPW_HUNTING_ATLAS_BASE}/78"
CPW_SWA_CAMPSITES = f"{CPW_HUNTING_ATLAS_BASE}/69"
USFS_CAMPGROUNDS = (
    "https://apps.fs.usda.gov/arcx/rest/services/EDW/"
    "EDW_RecInfraRecreationSites_02/MapServer/0"
)
BLM_CAMPGROUNDS = (
    "https://gis.blm.gov/arcgis/rest/services/recreation/"
    "BLM_Natl_Recreation_Sites_Facilities/MapServer/8"
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
USGS_NHD = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer"
CENSUS_TRANSPORTATION = (
    "https://tigerweb.geo.census.gov/arcgis/rest/services/"
    "TIGERweb/Transportation/MapServer"
)
LANDFIRE_ROOT = (
    "https://lfps.usgs.gov/arcgis/rest/services/"
    "Landfire_LF2025"
)

FINE_GROUND_RESOLUTION_M = 30.0
FINE_TILE_RADIUS_M = 7_200.0
SOURCE_CAUTION_RADIUS_M = 805.0
CORRIDOR_ENSEMBLE_MEMBERS = 10
SOURCE_DEVELOPED_LINK_RADIUS_M = 450.0
SOURCE_DEVELOPED_MAX_REACH_M = 1_000.0
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
    "campgrounds": "https://ndismaps.nrel.colostate.edu/index.html",
    "habitation": "https://www.usgs.gov/tools/geographic-names-information-system-gnis",
    "hydrography": "https://www.usgs.gov/national-hydrography/nhdplus-high-resolution",
    "roads": "https://tigerweb.geo.census.gov/tigerweb/",
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
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    food = np.zeros(evt.shape, dtype=np.float32)
    cover = np.zeros(evt.shape, dtype=np.float32)
    open_food = np.zeros(evt.shape, dtype=bool)
    developed = np.zeros(evt.shape, dtype=bool)
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
        if any(token in searchable for token in ("developed", "urban", "residential")):
            developed[mask] = True

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
    return food, cover, open_food, developed, labels


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

    local_elevation = gaussian_filter(
        filled,
        sigma=max(1.0, 455 / pixel_ground_m),
    )
    tpi = filled - local_elevation
    local_slope = gaussian_filter(
        slope,
        sigma=max(1.0, 340 / pixel_ground_m),
    )
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


def fine_terrain_scores(
    elevation: np.ndarray,
    mask: np.ndarray,
    pixel_ground_m: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return refuge ruggedness, exposed ridges, and low saddle crossings."""
    valid_elevation = np.where(mask & (elevation > -500), elevation, np.nan)
    fill_value = float(np.nanmedian(valid_elevation))
    filled = np.where(np.isfinite(valid_elevation), valid_elevation, fill_value)

    neighborhood = max(3, round(180 / pixel_ground_m))
    if neighborhood % 2 == 0:
        neighborhood += 1
    mean = uniform_filter(filled, size=neighborhood, mode="nearest")
    mean_square = uniform_filter(np.square(filled), size=neighborhood, mode="nearest")
    ruggedness_raw = np.sqrt(np.maximum(mean_square - np.square(mean), 0))
    ruggedness = normalize_percentile(ruggedness_raw, mask, 10, 90)

    broad = gaussian_filter(filled, sigma=max(1.0, 360 / pixel_ground_m))
    broad_tpi = filled - broad
    ridge = np.clip((broad_tpi - 8) / 55, 0, 1).astype(np.float32)

    offset = max(2, round(180 / pixel_ground_m))
    north = np.roll(filled, -offset, axis=0)
    south = np.roll(filled, offset, axis=0)
    west = np.roll(filled, -offset, axis=1)
    east = np.roll(filled, offset, axis=1)
    north_south_high = np.clip((np.minimum(north, south) - filled) / 32, 0, 1)
    east_west_high = np.clip((np.minimum(east, west) - filled) / 32, 0, 1)
    north_south_low = np.clip((filled - np.maximum(north, south)) / 32, 0, 1)
    east_west_low = np.clip((filled - np.maximum(east, west)) / 32, 0, 1)
    saddle = np.maximum(
        np.minimum(north_south_high, east_west_low),
        np.minimum(east_west_high, north_south_low),
    )
    saddle_sigma = max(0.8, 45 / pixel_ground_m)
    saddle = gaussian_filter(saddle.astype(np.float32), sigma=saddle_sigma)
    saddle = np.clip(saddle * 1.8, 0, 1)
    # np.roll wraps at array edges. Blank the affected fringe so a feature on the
    # opposite side of a local tile cannot manufacture a saddle.
    edge_margin = offset + math.ceil(4 * saddle_sigma)
    saddle[:edge_margin, :] = 0
    saddle[-edge_margin:, :] = 0
    saddle[:, :edge_margin] = 0
    saddle[:, -edge_margin:] = 0
    ridge *= 1 - 0.7 * saddle

    for values in (ruggedness, ridge, saddle):
        values[~mask] = 0
    return ruggedness.astype(np.float32), ridge, saddle.astype(np.float32)


def landfire_behavior_scores(
    evt: np.ndarray,
    evt_table: dict[int, dict[str, str]],
) -> tuple[np.ndarray, np.ndarray]:
    """Translate vegetation classes into literature-informed refuge and water masks."""
    habitat = np.full(evt.shape, 0.18, dtype=np.float32)
    water = np.zeros(evt.shape, dtype=bool)
    for value in np.unique(evt):
        row = evt_table.get(int(value))
        if not row:
            continue
        mask = evt == value
        searchable = " ".join(
            (
                row.get("EVT_NAME", ""),
                row.get("EVT_LF", ""),
                row.get("EVT_PHYS", ""),
                row.get("EVT_GP_N", ""),
            )
        ).lower()
        if any(token in searchable for token in ("open water", "aquatic")):
            water[mask] = True
            habitat[mask] = 0
        elif any(token in searchable for token in ("riparian", "cottonwood", "willow")):
            habitat[mask] = 1.0
        elif "aspen" in searchable:
            habitat[mask] = 0.96
        elif any(
            token in searchable
            for token in ("conifer", "spruce", "fir", "lodgepole", "ponderosa")
        ):
            habitat[mask] = 0.78
        elif "oak" in searchable:
            habitat[mask] = 0.68
        elif "pinyon" in searchable or "juniper" in searchable:
            habitat[mask] = 0.5
        elif "shrub" in searchable:
            habitat[mask] = 0.38
        elif any(token in searchable for token in ("meadow", "grassland", "herbaceous")):
            habitat[mask] = 0.24
        if any(token in searchable for token in ("developed", "barren", "snow", "ice")):
            habitat[mask] *= 0.12
    return habitat, water


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


def source_text(properties: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = properties.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, (int, float)) and math.isfinite(float(value)):
            return str(value)
    return None


def source_number(properties: dict[str, Any], *keys: str) -> float | None:
    value = source_text(properties, *keys)
    if value is None:
        return None
    try:
        return float(value.replace(",", ""))
    except ValueError:
        return None


def load_trail_mask(
    session: requests.Session,
    bbox: tuple[float, float, float, float],
    transform: rasterio.Affine,
    shape_: tuple[int, int],
    forward: Transformer,
) -> tuple[np.ndarray, list[str]]:
    try:
        collection = arcgis_geojson(
            session,
            CPW_COTREX_TRAILS,
            bbox=bbox,
            out_fields="name,trail_num,type,hiking,motorcycle,atv,ohv_gt_50,manager",
            max_offset=0.00025,
        )
        return (
            rasterize_collection(
                collection,
                transform,
                shape_,
                projector=forward,
                value=1,
            ).astype(bool),
            [],
        )
    except Exception as error:
        return (
            np.zeros(shape_, dtype=bool),
            [f"COTREX trail-pressure layer unavailable: {error}"],
        )


def resample_mask(
    source: np.ndarray,
    source_transform: rasterio.Affine,
    destination_transform: rasterio.Affine,
    destination_shape: tuple[int, int],
) -> np.ndarray:
    destination = np.zeros(destination_shape, dtype="uint8")
    reproject(
        source=source.astype("uint8"),
        destination=destination,
        src_transform=source_transform,
        src_crs="EPSG:3857",
        dst_transform=destination_transform,
        dst_crs="EPSG:3857",
        resampling=Resampling.nearest,
    )
    return destination.astype(bool)


def load_local_movement_masks(
    session: requests.Session,
    bbox: tuple[float, float, float, float],
    transform: rasterio.Affine,
    shape_: tuple[int, int],
    forward: Transformer,
) -> tuple[dict[str, np.ndarray], list[str]]:
    """Load fine-scale hydrography, roads, and recreation trails for one source tile."""
    masks = {
        name: np.zeros(shape_, dtype=bool)
        for name in (
            "drainage",
            "perennial",
            "waterbody",
            "primaryRoad",
            "secondaryRoad",
            "localRoad",
            "trail",
        )
    }
    warnings: list[str] = []

    try:
        flowlines = arcgis_geojson(
            session,
            f"{USGS_NHD}/6",
            where="FTYPE=460",
            out_fields="FTYPE,FCODE,GNIS_NAME",
            bbox=bbox,
            max_offset=0.00002,
        )
        masks["drainage"] = rasterize_collection(
            flowlines,
            transform,
            shape_,
            projector=forward,
            value=1,
        ).astype(bool)
        perennial = {
            "type": "FeatureCollection",
            "features": [
                feature
                for feature in flowlines.get("features", [])
                if int(feature.get("properties", {}).get("FCODE", 0) or 0)
                in (46000, 46006)
            ],
        }
        masks["perennial"] = rasterize_collection(
            perennial,
            transform,
            shape_,
            projector=forward,
            value=1,
        ).astype(bool)
    except Exception as error:
        warnings.append(f"USGS hydrography unavailable for a refinement tile: {error}")

    try:
        waterbodies = arcgis_geojson(
            session,
            f"{USGS_NHD}/12",
            out_fields="FTYPE,FCODE,GNIS_NAME",
            bbox=bbox,
            max_offset=0.00002,
        )
        masks["waterbody"] = rasterize_collection(
            waterbodies,
            transform,
            shape_,
            projector=forward,
            value=1,
        ).astype(bool)
    except Exception as error:
        warnings.append(f"USGS waterbody barriers unavailable for a refinement tile: {error}")

    road_layers = ((2, "primaryRoad"), (6, "secondaryRoad"), (8, "localRoad"))
    for layer_id, key in road_layers:
        try:
            roads = arcgis_geojson(
                session,
                f"{CENSUS_TRANSPORTATION}/{layer_id}",
                out_fields="MTFCC,RTTYP,NAME",
                bbox=bbox,
                max_offset=0.00002,
            )
            masks[key] = rasterize_collection(
                roads,
                transform,
                shape_,
                projector=forward,
                value=1,
            ).astype(bool)
        except Exception as error:
            warnings.append(f"Census {key} layer unavailable for a refinement tile: {error}")

    masks["trail"], trail_warnings = load_trail_mask(
        session,
        bbox,
        transform,
        shape_,
        forward,
    )
    warnings.extend(trail_warnings)
    return masks, warnings


def point_cell(
    transform: rasterio.Affine,
    point: Point,
    shape_: tuple[int, int],
    forward: Transformer,
) -> tuple[int, int] | None:
    x_coord, y_coord = forward.transform(point.x, point.y)
    row, column = rowcol(transform, x_coord, y_coord)
    row = int(row)
    column = int(column)
    if row < 0 or column < 0 or row >= shape_[0] or column >= shape_[1]:
        return None
    return row, column


def route_between(
    start: tuple[int, int],
    end: tuple[int, int],
    cost: np.ndarray,
    pixel_ground_m: float,
    *,
    margin_m: float = 2_000,
) -> list[tuple[int, int]]:
    margin = max(18, round(margin_m / pixel_ground_m))
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
        return [start, end]
    return [(row + row_min, column + col_min) for row, column in route]


def route_length_m(route: list[tuple[int, int]], pixel_ground_m: float) -> float:
    return sum(
        math.hypot(right[0] - left[0], right[1] - left[1]) * pixel_ground_m
        for left, right in zip(route, route[1:])
    )


def route_cost(
    route: list[tuple[int, int]],
    cost: np.ndarray,
    pixel_ground_m: float,
) -> float:
    total = 0.0
    for left, right in zip(route, route[1:]):
        step = math.hypot(right[0] - left[0], right[1] - left[1])
        total += (
            float(cost[left]) + float(cost[right])
        ) * 0.5 * step * pixel_ground_m
    return total


def route_to_mask(
    start: tuple[int, int],
    destination_mask: np.ndarray,
    cost: np.ndarray,
) -> list[tuple[int, int]]:
    """Trace the cheapest path to any reachable cell in a multipart destination."""
    destination_cells = np.argwhere(destination_mask & (cost < 100_000))
    if not destination_cells.size:
        raise BuildWarning("No reachable cells remain in the source footprint")
    destinations = [tuple(map(int, cell)) for cell in destination_cells]
    solver = MCP_Geometric(cost, fully_connected=True)
    cumulative_costs, _ = solver.find_costs(
        [start],
        ends=destinations,
        find_all_ends=False,
        max_step_cost=100_000,
    )
    destination_costs = cumulative_costs[
        destination_cells[:, 0],
        destination_cells[:, 1],
    ]
    finite = np.isfinite(destination_costs)
    if not np.any(finite):
        raise BuildWarning("No least-cost path reached the source footprint")
    reachable_cells = destination_cells[finite]
    reachable_costs = destination_costs[finite]
    selected = reachable_cells[int(np.argmin(reachable_costs))]
    return [tuple(map(int, cell)) for cell in solver.traceback(tuple(selected))]


def trim_route_to_caution_mask(
    route: list[tuple[int, int]],
    caution_mask: np.ndarray,
) -> list[tuple[int, int]]:
    outside: list[tuple[int, int]] = []
    for cell in route:
        if caution_mask[cell]:
            break
        outside.append(cell)
    if len(outside) >= 2:
        return outside
    return route[: max(2, min(len(route), 2))]


def distinct_arrival_portals(
    routes: list[list[tuple[int, int]]],
    pixel_ground_m: float,
    minimum_spacing_m: float = 120.0,
) -> int:
    selected: list[tuple[int, int]] = []
    for route in routes:
        if not route:
            continue
        endpoint = route[-1]
        if any(
            math.hypot(endpoint[0] - other[0], endpoint[1] - other[1])
            * pixel_ground_m
            < minimum_spacing_m
            for other in selected
        ):
            continue
        selected.append(endpoint)
    return len(selected)


def route_agreement_score(
    left: list[tuple[int, int]],
    right: list[tuple[int, int]],
    shape_: tuple[int, int],
    pixel_ground_m: float,
) -> int:
    if not left or not right:
        return 0

    def mean_distance(source: list[tuple[int, int]], target: list[tuple[int, int]]) -> float:
        target_mask = np.zeros(shape_, dtype=bool)
        target_rows, target_columns = zip(*target)
        target_mask[np.array(target_rows), np.array(target_columns)] = True
        distances = distance_transform_edt(~target_mask) * pixel_ground_m
        source_rows, source_columns = zip(*source)
        return float(np.mean(distances[np.array(source_rows), np.array(source_columns)]))

    separation = 0.5 * (mean_distance(left, right) + mean_distance(right, left))
    return int(round(100 * math.exp(-separation / 240)))


def corridor_route_ensemble(
    security: tuple[int, int],
    source_mask: np.ndarray,
    caution_mask: np.ndarray,
    night_cost: np.ndarray,
    dawn_cost: np.ndarray,
    pixel_ground_m: float,
    *,
    seed: int,
) -> tuple[list[tuple[int, int]], list[list[tuple[int, int]]], int, int]:
    """Build deterministic night/dawn and perturbed near-optimal route hypotheses."""
    night_routing = night_cost.copy()
    dawn_routing = dawn_cost.copy()
    night_destination = source_mask & (night_routing < 100_000)
    dawn_destination = source_mask & (dawn_routing < 100_000)
    night_routing[night_destination] = np.minimum(
        night_routing[night_destination],
        0.12,
    )
    dawn_routing[dawn_destination] = np.minimum(
        dawn_routing[dawn_destination],
        0.12,
    )

    night_full = route_to_mask(security, night_destination, night_routing)
    dawn_full = route_to_mask(security, dawn_destination, dawn_routing)
    night = trim_route_to_caution_mask(
        night_full,
        caution_mask,
    )
    dawn = trim_route_to_caution_mask(
        dawn_full,
        caution_mask,
    )
    agreement = route_agreement_score(night, dawn, night_cost.shape, pixel_ground_m)

    consensus = 0.45 * night_routing + 0.55 * dawn_routing
    representative = min(
        (night, dawn),
        key=lambda route: route_cost(route, consensus, pixel_ground_m),
    )
    routes: list[list[tuple[int, int]]] = [night, dawn]
    rng = np.random.default_rng(seed)
    attempts = max(0, CORRIDOR_ENSEMBLE_MEMBERS - len(routes))
    for index in range(attempts):
        base = night_routing if index % 2 == 0 else dawn_routing
        noise = gaussian_filter(
            rng.normal(0, 1, size=base.shape).astype(np.float32),
            sigma=max(1.0, 150 / pixel_ground_m),
        )
        standard_deviation = float(np.std(noise))
        if standard_deviation > 0:
            noise /= standard_deviation
        perturbed = np.clip(base * np.exp(0.09 * noise), 0.05, 1_000_000)
        full_route = route_to_mask(security, source_mask, perturbed)
        route = trim_route_to_caution_mask(
            full_route,
            caution_mask,
        )
        if len(route) < 2:
            continue
        if tuple(route) not in {tuple(existing) for existing in routes}:
            routes.append(route)
    return (
        representative,
        routes,
        agreement,
        distinct_arrival_portals(routes, pixel_ground_m),
    )


def load_human_food_sources(
    session: requests.Session,
    bbox: tuple[float, float, float, float],
) -> tuple[list[dict[str, Any]], list[str]]:
    definitions = (
        (
            "CPW campgrounds",
            CPW_CAMPGROUNDS,
            "Display='Yes'",
            "Name,Manager,CGNumSites,CGPropertyName",
            "Campground",
        ),
        (
            "CPW SWA campsites",
            CPW_SWA_CAMPSITES,
            "1=1",
            "PROPNAME,TYPE_DETAIL,SITE_COUNT,MGMT_AUTH",
            "SWA campsite",
        ),
        (
            "USFS campgrounds",
            USFS_CAMPGROUNDS,
            "site_type IN ('CAMPGROUND','GROUP CAMPGROUND','HORSE CAMP','CAMPING AREA')",
            "site_name,site_type,managing_org,total_capacity,operated_by",
            "Campground",
        ),
        (
            "BLM campgrounds",
            BLM_CAMPGROUNDS,
            "State='CO'",
            "FacilityName,FacilityTypeDescription,State",
            "Campground",
        ),
    )
    sources: list[dict[str, Any]] = []
    warnings: list[str] = []
    for label, url, where, fields, default_category in definitions:
        try:
            collection = arcgis_geojson(
                session,
                url,
                where=where,
                out_fields=fields,
                bbox=bbox,
                max_offset=0.00005,
            )
        except Exception as error:
            warnings.append(f"{label} unavailable during build")
            log(f"  {label} unavailable: {error}")
            continue
        for feature in collection.get("features", []):
            if feature.get("geometry", {}).get("type") != "Point":
                continue
            coordinates = feature["geometry"].get("coordinates", [])
            if len(coordinates) < 2:
                continue
            longitude, latitude = coordinates[:2]
            if not all(isinstance(value, (int, float)) for value in (longitude, latitude)):
                continue
            properties = feature.get("properties", {})
            name = source_text(
                properties,
                "Name",
                "PROPNAME",
                "site_name",
                "FacilityName",
                "CGPropertyName",
            )
            if not name:
                continue
            category = (
                default_category
                if default_category == "SWA campsite"
                else source_text(
                    properties,
                    "site_type",
                    "FacilityTypeDescription",
                ) or default_category
            )
            manager = source_text(
                properties,
                "Manager",
                "MGMT_AUTH",
                "operated_by",
                "managing_org",
            ) or label.split()[0]
            sources.append(
                {
                    "point": Point(float(longitude), float(latitude)),
                    "name": name,
                    "category": category,
                    "manager": manager,
                    "capacity": source_number(
                        properties,
                        "CGNumSites",
                        "SITE_COUNT",
                        "total_capacity",
                    ),
                    "inventory": label,
                }
            )

    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, float, float]] = set()
    for source in sources:
        point = source["point"]
        key = (
            re.sub(r"[^a-z0-9]+", " ", source["name"].lower()).strip(),
            round(point.x, 3),
            round(point.y, 3),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(source)
    return deduped, warnings


def habitation_sources(
    developed: np.ndarray,
    hunt_mask: np.ndarray,
    transform: rasterio.Affine,
    inverse: Transformer,
    names: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    populated = [name for name in names if name.get("class") == "Populated Place"]
    density = uniform_filter(developed.astype(np.float32), size=5)
    cores = (density >= 0.24) & hunt_mask
    labels, _ = connected_components(cores)
    sources: list[dict[str, Any]] = []

    for component_id, slices in enumerate(find_objects(labels), start=1):
        if slices is None:
            continue
        local = labels[slices] == component_id
        if np.count_nonzero(local) < 5:
            continue
        cells = np.argwhere(local)
        row = int(round(float(cells[:, 0].mean()))) + slices[0].start
        column = int(round(float(cells[:, 1].mean()))) + slices[1].start
        component_cells = np.argwhere(labels[slices] == component_id)
        nearest_index = int(
            np.argmin(
                np.square(component_cells[:, 0] + slices[0].start - row)
                + np.square(component_cells[:, 1] + slices[1].start - column)
            )
        )
        row = int(component_cells[nearest_index, 0] + slices[0].start)
        column = int(component_cells[nearest_index, 1] + slices[1].start)
        point = point_from_cell(transform, inverse, (row, column))

        nearby = None
        if populated:
            latitude_scale = math.cos(math.radians(point.y))
            candidate = min(
                populated,
                key=lambda item: (
                    ((item["longitude"] - point.x) * latitude_scale) ** 2
                    + (item["latitude"] - point.y) ** 2
                ),
            )
            distance_m = math.hypot(
                (candidate["longitude"] - point.x) * latitude_scale,
                candidate["latitude"] - point.y,
            ) * 111_320
            if distance_m <= 4_000:
                nearby = candidate
        sources.append(
            {
                "point": point,
                "name": (
                    f"Developed area near {nearby['name']}"
                    if nearby
                    else "Mapped developed area"
                ),
                "category": "Developed area",
                "manager": "LANDFIRE 2025",
                "capacity": None,
                "inventory": "LANDFIRE developed-land proxy",
            }
        )

    for place in populated:
        point = Point(float(place["longitude"]), float(place["latitude"]))
        if any(point.distance(source["point"]) < 0.011 for source in sources):
            continue
        sources.append(
            {
                "point": point,
                "name": str(place["name"]),
                "category": "Populated place",
                "manager": "USGS GNIS",
                "capacity": None,
                "inventory": "USGS populated-place gazetteer",
            }
        )
    return sources


def source_strength(source: dict[str, Any]) -> float:
    category = str(source.get("category", "")).lower()
    inventory = str(source.get("inventory", "")).lower()
    if "camp" in category or "camp" in inventory:
        value = 0.88
    elif "developed" in category:
        value = 0.72
    else:
        value = 0.66
    capacity = source.get("capacity")
    if isinstance(capacity, (int, float)) and capacity > 0:
        value += min(0.1, math.log1p(float(capacity)) / 55)
    return min(value, 1.0)


def source_anchor_radius_m(source: dict[str, Any]) -> float:
    """Return a conservative positional footprint around one source record."""
    category = str(source.get("category", "")).lower()
    if "populated" in category:
        return 320.0
    if "developed" in category:
        return 240.0
    if "swa" in category:
        return 160.0
    return 120.0


def cluster_center_point(members: list[dict[str, Any]]) -> Point:
    """Center a refinement tile on all records without implying a food centroid."""
    return Point(
        float(np.mean([member["point"].x for member in members])),
        float(np.mean([member["point"].y for member in members])),
    )


def source_cluster_extent_m(members: list[dict[str, Any]]) -> float:
    projected = [member["projected"] for member in members]
    return max(
        (
            left.distance(right)
            for index, left in enumerate(projected)
            for right in projected[:index]
        ),
        default=0.0,
    )


def source_footprint_mask(
    members: list[dict[str, Any]],
    developed: np.ndarray,
    water: np.ndarray,
    transform: rasterio.Affine,
    shape_: tuple[int, int],
    forward: Transformer,
    pixel_ground_m: float,
) -> tuple[np.ndarray, list[tuple[dict[str, Any], tuple[int, int]]]]:
    """Combine record uncertainty buffers with nearby dense developed patches.

    The result can remain multipart. It deliberately avoids a convex hull, which
    would turn undeveloped terrain between separate facilities into attraction
    habitat merely because both facilities belong to the same cluster.
    """
    rows, columns = np.ogrid[: shape_[0], : shape_[1]]
    anchor_mask = np.zeros(shape_, dtype=bool)
    member_seed_mask = np.zeros(shape_, dtype=bool)
    member_cells: list[tuple[dict[str, Any], tuple[int, int]]] = []
    for member in members:
        cell = point_cell(transform, member["point"], shape_, forward)
        if cell is None:
            continue
        member_cells.append((member, cell))
        member_seed_mask[cell] = True
        radius_cells = source_anchor_radius_m(member) / pixel_ground_m
        anchor_mask |= (
            np.square(rows - cell[0]) + np.square(columns - cell[1])
            <= radius_cells**2
        )
    if not member_cells:
        raise BuildWarning("No source-cluster records fell inside the refinement tile")

    distance_to_member_m = distance_transform_edt(~member_seed_mask) * pixel_ground_m
    # Requiring local density suppresses isolated LANDFIRE road pixels before
    # nearby development is connected to a source record.
    developed_core = uniform_filter(
        developed.astype(np.float32),
        size=3,
        mode="nearest",
    ) >= 0.22
    developed_patch = binary_dilation(developed_core, iterations=1)
    developed_labels, _ = connected_components(developed_patch)
    linked_ids = np.unique(
        developed_labels[distance_to_member_m <= SOURCE_DEVELOPED_LINK_RADIUS_M]
    )
    linked_ids = linked_ids[linked_ids > 0]
    linked_development = (
        np.isin(developed_labels, linked_ids)
        & (distance_to_member_m <= SOURCE_DEVELOPED_MAX_REACH_M)
    )
    footprint = (anchor_mask | linked_development) & ~water
    if not np.any(footprint):
        raise BuildWarning("Source-cluster footprint was empty after water masking")
    return footprint, member_cells


def conflict_linked_source_clusters(
    sources: list[dict[str, Any]],
    conflict_geometry: Any,
    hunt_geometry: Any,
    measurement_forward: Transformer,
) -> list[dict[str, Any]]:
    # Use the CONUS Albers equal-area projection for true-meter proximity and
    # spacing checks. Web Mercator is retained for raster export only; treating
    # its map units as ground meters would inflate Colorado distances by ~30%.
    conflict_projected = transform_geometry(
        measurement_forward.transform,
        conflict_geometry,
    )
    hunt_projected = transform_geometry(
        measurement_forward.transform,
        hunt_geometry,
    )
    candidates: list[dict[str, Any]] = []
    for source in sources:
        point = source["point"]
        projected = Point(*measurement_forward.transform(point.x, point.y))
        if not hunt_projected.buffer(200).contains(projected):
            continue
        conflict_distance_m = float(projected.distance(conflict_projected))
        if conflict_distance_m > 2_400:
            continue
        candidates.append(
            {
                **source,
                "projected": projected,
                "conflictDistanceM": conflict_distance_m,
                "strength": source_strength(source),
            }
        )

    candidates.sort(
        key=lambda source: (
            source["conflictDistanceM"] > 1,
            source["conflictDistanceM"],
            -source["strength"],
        )
    )
    unassigned = set(range(len(candidates)))
    clusters: list[dict[str, Any]] = []
    while unassigned:
        seed_index = min(
            unassigned,
            key=lambda index: (
                candidates[index]["conflictDistanceM"] > 1,
                candidates[index]["conflictDistanceM"],
                -candidates[index]["strength"],
            ),
        )
        seed = candidates[seed_index]
        members = [
            index
            for index in unassigned
            if candidates[index]["projected"].distance(seed["projected"]) <= 1_200
        ]
        for index in members:
            unassigned.remove(index)
        member_sources = [candidates[index] for index in members]
        primary = min(
            member_sources,
            key=lambda source: (
                source["conflictDistanceM"] > 1,
                -source["strength"],
                source["conflictDistanceM"],
            ),
        )
        conflict_distance_m = min(
            float(source["conflictDistanceM"]) for source in member_sources
        )
        conflict_score = (
            1.0
            if conflict_distance_m <= 1
            else math.exp(-conflict_distance_m / 1_150)
        )
        clusters.append(
            {
                **primary,
                "members": member_sources,
                "sourceCount": len(member_sources),
                "sourceExtentM": source_cluster_extent_m(member_sources),
                "conflictDistanceM": conflict_distance_m,
                "conflictScore": conflict_score,
                "strength": max(source["strength"] for source in member_sources),
            }
        )
    return clusters


def choose_security_cells(
    source_cell: tuple[int, int],
    candidate_cells: np.ndarray,
    security_score: np.ndarray,
    pixel_ground_m: float,
    *,
    source_mask: np.ndarray | None = None,
    maximum_options: int = 5,
    minimum_score: float = 0.43,
    minimum_distance_m: float = 1_600,
    maximum_distance_m: float = 5_200,
) -> list[tuple[int, int]]:
    if not candidate_cells.size:
        return []
    row, column = source_cell
    if source_mask is None:
        offsets = candidate_cells - np.array((row, column))
        distances = np.hypot(offsets[:, 0], offsets[:, 1]) * pixel_ground_m
    else:
        distance_surface = distance_transform_edt(~source_mask) * pixel_ground_m
        distances = distance_surface[candidate_cells[:, 0], candidate_cells[:, 1]]
    nearby = (distances >= minimum_distance_m) & (distances <= maximum_distance_m)
    local_cells = candidate_cells[nearby]
    local_distances = distances[nearby]
    if not local_cells.size:
        return []
    desirability = security_score[local_cells[:, 0], local_cells[:, 1]]
    desirability -= np.clip((local_distances - 3_400) / 12_000, 0, 0.18)
    order = np.argsort(desirability)[::-1]
    selected: list[tuple[int, int]] = []
    selected_angles: list[float] = []
    for index in order:
        candidate = (int(local_cells[index, 0]), int(local_cells[index, 1]))
        candidate_score = float(security_score[candidate])
        if candidate_score < minimum_score:
            continue
        if any(
            math.hypot(candidate[0] - other[0], candidate[1] - other[1])
            * pixel_ground_m
            < 1_150
            for other in selected
        ):
            continue
        angle = math.degrees(math.atan2(candidate[0] - row, candidate[1] - column))
        if any(
            min(abs(angle - other), 360 - abs(angle - other)) < 24
            and math.hypot(candidate[0] - other_cell[0], candidate[1] - other_cell[1])
            * pixel_ground_m
            < 2_300
            for other, other_cell in zip(selected_angles, selected)
        ):
            continue
        selected.append(candidate)
        selected_angles.append(angle)
        if len(selected) == maximum_options:
            break
    return selected


def security_area_polygon(
    security_score: np.ndarray,
    public_mask: np.ndarray,
    target: tuple[int, int],
    transform: rasterio.Affine,
    inverse: Transformer,
    pixel_ground_m: float,
) -> Any:
    row, column = target
    radius = max(4, round(550 / pixel_ground_m))
    threshold = max(0.45, float(security_score[target]) * 0.78)
    zone = (security_score >= threshold) & public_mask
    rows, columns = np.ogrid[: zone.shape[0], : zone.shape[1]]
    zone &= np.square(rows - row) + np.square(columns - column) <= radius**2
    polygons = []
    target_x, target_y = xy(transform, row, column)
    for geometry, value in shapes(zone.astype("uint8"), mask=zone, transform=transform):
        if value != 1:
            continue
        polygon = shape(geometry)
        if polygon.buffer(1).contains(Point(target_x, target_y)):
            polygons.append(polygon)
    if polygons:
        projected = max(polygons, key=lambda polygon: polygon.area).simplify(30)
    else:
        projected = Point(target_x, target_y).buffer(220)
    return transform_geometry(inverse.transform, projected)


def select_human_sources(
    clusters: list[dict[str, Any]],
    transform: rasterio.Affine,
    forward: Transformer,
    hunt_mask: np.ndarray,
    gmu_raster: np.ndarray,
    candidate_cells: np.ndarray,
    security_score: np.ndarray,
    pixel_ground_m: float,
) -> list[dict[str, Any]]:
    viable: list[dict[str, Any]] = []
    for cluster in clusters:
        cell = point_cell(transform, cluster["point"], hunt_mask.shape, forward)
        if cell is None or not hunt_mask[cell]:
            continue
        security_cells = choose_security_cells(
            cell,
            candidate_cells,
            security_score,
            pixel_ground_m,
        )
        if len(security_cells) < 2:
            continue
        security_quality = float(
            np.mean([security_score[security] for security in security_cells])
        )
        cluster_bonus = min(math.log1p(cluster["sourceCount"]) / math.log(6), 1)
        priority = (
            0.68 * cluster["conflictScore"]
            + 0.17 * cluster["strength"]
            + 0.10 * security_quality
            + 0.05 * cluster_bonus
        )
        viable.append(
            {
                **cluster,
                "cell": cell,
                "gmu": int(gmu_raster[cell]),
                "priority": priority,
                "securityCells": security_cells,
            }
        )
    viable.sort(key=lambda source: source["priority"], reverse=True)

    selected: list[dict[str, Any]] = []
    unit_counts: dict[int, int] = defaultdict(int)
    for minimum_spacing, unit_limit in ((5_000, 2), (3_000, 3), (1_500, 4)):
        for source in viable:
            if source in selected or len(selected) >= 8:
                continue
            if unit_counts[source["gmu"]] >= unit_limit:
                continue
            if any(
                source["projected"].distance(other["projected"]) < minimum_spacing
                for other in selected
            ):
                continue
            selected.append(source)
            unit_counts[source["gmu"]] += 1
        if len(selected) >= 8:
            break
    return sorted(selected, key=lambda source: source["priority"], reverse=True)


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


def route_line_projected(
    transform: rasterio.Affine,
    route: list[tuple[int, int]],
) -> LineString:
    coordinates = [xy(transform, row, column) for row, column in route]
    if len(coordinates) == 1:
        coordinates.append(coordinates[0])
    return LineString(coordinates)


def route_geometry_outside_zone(
    transform: rasterio.Affine,
    inverse_transformer: Transformer,
    route: list[tuple[int, int]],
    excluded_projected: Any,
) -> tuple[LineString, Point, LineString]:
    """Clip a raster route to the exact displayed exclusion boundary.

    Raster cell centers can sit just outside a caution mask while the segment
    between them clips the smooth displayed polygon. Keeping the component that
    contains the security start makes the map line and arrival portal agree with
    the visible caution edge rather than differing by part of a 30 m cell.
    """
    projected_route = route_line_projected(transform, route)
    outside = projected_route.difference(excluded_projected)

    line_parts: list[LineString] = []

    def collect_lines(geometry: Any) -> None:
        if geometry.geom_type == "LineString" and not geometry.is_empty:
            line_parts.append(geometry)
            return
        if hasattr(geometry, "geoms"):
            for part in geometry.geoms:
                collect_lines(part)

    collect_lines(outside)
    if not line_parts:
        raise BuildWarning("A modeled corridor was fully inside its caution zone")

    start = Point(projected_route.coords[0])
    selected = min(line_parts, key=lambda line: line.distance(start))
    coordinates = list(selected.coords)
    if Point(coordinates[-1]).distance(start) < Point(coordinates[0]).distance(start):
        coordinates.reverse()
    selected = LineString(coordinates)
    endpoint = Point(selected.coords[-1])
    return (
        transform_geometry(inverse_transformer.transform, selected),
        endpoint,
        selected,
    )


def corridor_band_geometry(
    transform: rasterio.Affine,
    inverse_transformer: Transformer,
    routes: list[list[tuple[int, int]]],
    pixel_ground_m: float,
    excluded_projected: Any,
) -> Any:
    map_units_per_ground_m = abs(transform.a) / pixel_ground_m
    route_buffers = [
        route_line_projected(transform, route).buffer(48 * map_units_per_ground_m)
        for route in routes
        if len(route) >= 2
    ]
    if not route_buffers:
        return Point(0, 0).buffer(0)
    projected = unary_union(route_buffers).buffer(0).simplify(
        8 * map_units_per_ground_m,
        preserve_topology=True,
    )
    projected = projected.difference(excluded_projected).buffer(0)
    return transform_geometry(inverse_transformer.transform, projected)


def raster_mask_projected_geometry(
    mask: np.ndarray,
    transform: rasterio.Affine,
) -> Any:
    polygons = [
        shape(geometry)
        for geometry, value in shapes(
            mask.astype("uint8"),
            mask=mask,
            transform=transform,
        )
        if value == 1
    ]
    if not polygons:
        raise BuildWarning("A required raster footprint did not contain any polygons")
    return unary_union(polygons).buffer(0)


def source_zone_geometries(
    source_mask: np.ndarray,
    transform: rasterio.Affine,
    inverse: Transformer,
    pixel_ground_m: float,
) -> tuple[Any, Any, Any, Any]:
    map_units_per_ground_m = abs(transform.a) / pixel_ground_m
    projected_source = raster_mask_projected_geometry(source_mask, transform).simplify(
        8 * map_units_per_ground_m,
        preserve_topology=True,
    )
    projected_caution = projected_source.buffer(
        SOURCE_CAUTION_RADIUS_M * map_units_per_ground_m,
        resolution=24,
    ).simplify(
        10 * map_units_per_ground_m,
        preserve_topology=True,
    )
    return (
        transform_geometry(inverse.transform, projected_source),
        transform_geometry(inverse.transform, projected_caution),
        projected_source,
        projected_caution,
    )


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


def write_human_food_gpx(
    sources: list[dict[str, Any]],
    source_members: list[dict[str, Any]],
    source_buffers: list[dict[str, Any]],
    security_options: list[dict[str, Any]],
    corridors: list[dict[str, Any]],
) -> None:
    from xml.sax.saxutils import escape

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="Colorado Hunt Finder" '
        'xmlns="http://www.topografix.com/GPX/1/1">',
        f"  <metadata><name>{HUNT_CODE} human-food corridors</name></metadata>",
    ]
    for feature in sources:
        properties = feature["properties"]
        longitude, latitude = feature["geometry"]["coordinates"]
        lines.append(
            f'  <wpt lat="{latitude:.6f}" lon="{longitude:.6f}">'
            f"<name>{escape(properties['shortName'])} · CONTEXT</name>"
            f"<desc>{escape(properties['summary'])}</desc>"
            "<type>Human-food context — not a setup location</type></wpt>"
        )
    source_labels = {
        feature["properties"]["targetId"]: feature["properties"]["shortName"]
        for feature in sources
    }
    for feature in source_members:
        properties = feature["properties"]
        longitude, latitude = feature["geometry"]["coordinates"]
        source_label = source_labels.get(properties["targetId"], properties["targetId"])
        lines.append(
            f'  <wpt lat="{latitude:.6f}" lon="{longitude:.6f}">'
            f"<name>{escape(source_label)} · {escape(properties['name'])}</name>"
            f"<desc>{escape(properties['category'])}; "
            f"{escape(properties['inventory'])}. Not confirmed food access.</desc>"
            "<type>Contributing human-food source record</type></wpt>"
        )
    for feature in security_options:
        properties = feature["properties"]
        longitude, latitude = feature["geometry"]["coordinates"]
        lines.append(
            f'  <wpt lat="{latitude:.6f}" lon="{longitude:.6f}">'
            f"<name>{escape(properties['name'])}</name>"
            f"<desc>{escape(properties['summary'])}</desc>"
            "<type>Modeled security option — verify access and sign</type></wpt>"
        )
    for feature in source_buffers:
        properties = feature["properties"]
        geometry = shape(feature["geometry"])
        polygons = (
            [geometry]
            if geometry.geom_type == "Polygon"
            else [part for part in geometry.geoms if part.geom_type == "Polygon"]
        )
        for part_index, polygon in enumerate(polygons, start=1):
            suffix = f" · part {part_index}" if len(polygons) > 1 else ""
            lines.append(
                f"  <trk><name>{escape(properties['sourceName'])} "
                f"0.5 mi caution edge{suffix}</name>"
                "<type>Analysis caution boundary — not statutory</type><trkseg>"
            )
            for longitude, latitude in polygon.exterior.coords:
                lines.append(
                    f'    <trkpt lat="{latitude:.6f}" lon="{longitude:.6f}" />'
                )
            lines.append("  </trkseg></trk>")
    for feature in corridors:
        properties = feature["properties"]
        lines.append(f"  <trk><name>{escape(properties['name'])}</name><trkseg>")
        for longitude, latitude in feature["geometry"]["coordinates"]:
            lines.append(f'    <trkpt lat="{latitude:.6f}" lon="{longitude:.6f}" />')
        lines.append("  </trkseg></trk>")
    lines.append("</gpx>")
    OUTPUT_GPX.write_text("\n".join(lines) + "\n", encoding="utf-8")


def proximity_score(
    feature_mask: np.ndarray,
    pixel_ground_m: float,
    decay_m: float,
) -> np.ndarray:
    if not np.any(feature_mask):
        return np.zeros(feature_mask.shape, dtype=np.float32)
    distance = distance_transform_edt(~feature_mask) * pixel_ground_m
    return np.exp(-distance / decay_m).astype(np.float32)


def build_local_human_refinement(
    session: requests.Session,
    temporary: Path,
    tile_id: str,
    source_point: Point,
    source_members: list[dict[str, Any]],
    units_collection: dict[str, Any],
    global_transform: rasterio.Affine,
    global_public_mask: np.ndarray,
    evt_table: dict[int, dict[str, str]],
    forward: Transformer,
    inverse: Transformer,
) -> tuple[dict[str, Any], list[str]]:
    """Build a 30 m movement tile around one selected source cluster."""
    latitude_scale = max(0.55, math.cos(math.radians(source_point.y)))
    pixel_map_m = FINE_GROUND_RESOLUTION_M / latitude_scale
    radius_map_m = FINE_TILE_RADIUS_M / latitude_scale
    center_x, center_y = forward.transform(source_point.x, source_point.y)
    width = math.ceil(2 * radius_map_m / pixel_map_m)
    height = width
    bounds = (
        center_x - width * pixel_map_m / 2,
        center_y - height * pixel_map_m / 2,
        center_x + width * pixel_map_m / 2,
        center_y + height * pixel_map_m / 2,
    )
    transform = from_origin(bounds[0], bounds[3], pixel_map_m, pixel_map_m)
    shape_ = (height, width)
    west, south = inverse.transform(bounds[0], bounds[1])
    east, north = inverse.transform(bounds[2], bounds[3])
    bbox = (west, south, east, north)

    log(
        f"  Refining {tile_id} on {width} × {height} cells "
        f"at {FINE_GROUND_RESOLUTION_M:.0f} m"
    )
    elevation = export_image(
        session,
        USGS_3DEP,
        temporary / f"{tile_id}-elevation.tif",
        bounds,
        width,
        height,
        pixel_type="F32",
        interpolation="RSP_BilinearInterpolation",
    ).astype(np.float32)
    evt = export_image(
        session,
        f"{LANDFIRE_ROOT}/LF2025_EVT_CONUS/ImageServer",
        temporary / f"{tile_id}-evt.tif",
        bounds,
        width,
        height,
        pixel_type="S16",
    ).astype(np.int16)
    evc = export_image(
        session,
        f"{LANDFIRE_ROOT}/LF2025_EVC_CONUS/ImageServer",
        temporary / f"{tile_id}-evc.tif",
        bounds,
        width,
        height,
        pixel_type="S16",
    ).astype(np.int16)
    _, cover, _, developed, _ = landfire_scores(evt, evc, evt_table)
    habitat, landfire_water = landfire_behavior_scores(evt, evt_table)

    hunt_mask = rasterize_collection(
        units_collection,
        transform,
        shape_,
        projector=forward,
        value=1,
    ).astype(bool)
    gmu_entries = [
        (
            mapping(transform_geometry(forward.transform, shape(feature["geometry"]))),
            int(feature["properties"]["GMUID"]),
        )
        for feature in units_collection.get("features", [])
    ]
    gmu_raster = rasterize(
        gmu_entries,
        out_shape=shape_,
        transform=transform,
        fill=0,
        dtype="uint16",
        all_touched=True,
    )
    public_mask = resample_mask(
        global_public_mask,
        global_transform,
        transform,
        shape_,
    )

    slope, aspect, draw, bench, northeast = terrain_scores(
        elevation,
        hunt_mask,
        FINE_GROUND_RESOLUTION_M,
    )
    ruggedness, ridge, saddle = fine_terrain_scores(
        elevation,
        hunt_mask,
        FINE_GROUND_RESOLUTION_M,
    )
    movement_masks, warnings = load_local_movement_masks(
        session,
        bbox,
        transform,
        shape_,
        forward,
    )
    water = landfire_water | movement_masks["waterbody"]
    source_mask, source_member_cells = source_footprint_mask(
        source_members,
        developed,
        water,
        transform,
        shape_,
        forward,
        FINE_GROUND_RESOLUTION_M,
    )
    source_distance_m = (
        distance_transform_edt(~source_mask) * FINE_GROUND_RESOLUTION_M
    )
    caution_mask = source_distance_m <= SOURCE_CAUTION_RADIUS_M

    drainage = np.maximum(
        0.72 * proximity_score(
            movement_masks["drainage"],
            FINE_GROUND_RESOLUTION_M,
            170,
        ),
        proximity_score(
            movement_masks["perennial"],
            FINE_GROUND_RESOLUTION_M,
            240,
        ),
    )
    primary_road = proximity_score(
        movement_masks["primaryRoad"],
        FINE_GROUND_RESOLUTION_M,
        180,
    )
    secondary_road = proximity_score(
        movement_masks["secondaryRoad"],
        FINE_GROUND_RESOLUTION_M,
        125,
    )
    local_road = proximity_score(
        movement_masks["localRoad"],
        FINE_GROUND_RESOLUTION_M,
        75,
    )
    trail = proximity_score(
        movement_masks["trail"],
        FINE_GROUND_RESOLUTION_M,
        135,
    )
    development = gaussian_filter(
        developed.astype(np.float32),
        sigma=max(1.0, 420 / FINE_GROUND_RESOLUTION_M),
    )
    if np.max(development) > 0:
        development /= float(np.max(development))
    cover_continuity = gaussian_filter(
        cover,
        sigma=max(1.0, 75 / FINE_GROUND_RESOLUTION_M),
    )

    source_cell = point_cell(transform, source_point, shape_, forward)
    if source_cell is None:
        raise BuildWarning(f"{tile_id} source fell outside its refinement tile")

    exertion = (
        0.08 * np.clip((5 - slope) / 5, 0, 1)
        + np.square(np.clip((slope - 24) / 22, 0, 1.7))
    )
    cover_gap = 1 - np.clip(cover_continuity, 0, 1)
    common_refuge = (
        -0.34 * drainage
        - 0.25 * draw
        - 0.18 * bench
        - 0.2 * saddle
        - 0.16 * habitat
        - 0.1 * ruggedness
        + 0.62 * ridge
        + 0.5 * exertion
    )
    night_cost = np.clip(
        0.95
        + 1.02 * cover_gap
        + common_refuge
        + 0.3 * trail
        + 0.28 * local_road
        + 1.7 * secondary_road
        + 4.8 * primary_road
        + 0.35 * development,
        0.08,
        30,
    )
    dawn_cost = np.clip(
        1.0
        + 1.4 * cover_gap
        + common_refuge
        - 0.1 * drainage
        - 0.08 * ruggedness
        + 0.95 * trail
        + 0.72 * local_road
        + 2.2 * secondary_road
        + 5.4 * primary_road
        + 1.05 * development,
        0.08,
        30,
    )
    cliff = slope >= 50
    for cost in (night_cost, dawn_cost):
        cost[water] = np.maximum(cost[water], 18)
        cost[cliff] = np.maximum(cost[cliff], 24)
        cost[~hunt_mask] = 1_000_000

    security_score = np.clip(
        0.36 * cover_continuity
        + 0.14 * habitat
        + 0.14 * ruggedness
        + 0.12 * draw
        + 0.08 * bench
        + 0.06 * saddle
        + 0.04 * northeast
        - 0.1 * trail
        - 0.07 * local_road
        - 0.12 * secondary_road
        - 0.18 * primary_road
        - 0.1 * development,
        0,
        1,
    )
    security_eligible = (
        hunt_mask
        & public_mask
        & ~water
        & ~cliff
        & ~developed
        & (cover_continuity >= 0.3)
        & (slope >= 4)
        & (slope <= 42)
        & (security_score >= 0.32)
    )
    maxima_window = max(7, round(700 / FINE_GROUND_RESOLUTION_M))
    security_maxima = (
        security_score
        == maximum_filter(security_score, size=maxima_window, mode="nearest")
    ) & security_eligible
    candidates = np.argwhere(security_maxima)
    security_cells = choose_security_cells(
        source_cell,
        candidates,
        security_score,
        FINE_GROUND_RESOLUTION_M,
        source_mask=source_mask,
        minimum_score=0.32,
    )

    road_exposure = np.clip(
        0.62 * primary_road + 0.28 * secondary_road + 0.1 * local_road,
        0,
        1,
    )
    pressure = np.clip(
        0.38 * trail
        + 0.18 * local_road
        + 0.2 * secondary_road
        + 0.14 * primary_road
        + 0.1 * development,
        0,
        1,
    )
    return (
        {
            "transform": transform,
            "pixelGroundM": FINE_GROUND_RESOLUTION_M,
            "pixelMapM": pixel_map_m,
            "forward": forward,
            "inverse": inverse,
            "sourceCell": source_cell,
            "sourceMask": source_mask,
            "sourceDistanceM": source_distance_m,
            "sourceCautionMask": caution_mask,
            "sourceMemberCells": source_member_cells,
            "huntMask": hunt_mask,
            "gmu": gmu_raster,
            "public": public_mask,
            "elevation": elevation,
            "slope": slope,
            "cover": cover_continuity,
            "habitat": habitat,
            "draw": draw,
            "bench": bench,
            "ruggedness": ruggedness,
            "saddle": saddle,
            "ridge": ridge,
            "drainage": drainage,
            "roadExposure": road_exposure,
            "pressure": pressure,
            "securityScore": security_score,
            "securityCells": security_cells,
            "nightCost": night_cost,
            "dawnCost": dawn_cost,
        },
        warnings,
    )


def build_human_food_analysis(
    session: requests.Session,
    as_of: date,
    temporary: Path,
    units_collection: dict[str, Any],
    hunt_geometry: Any,
    bbox: tuple[float, float, float, float],
    transform: rasterio.Affine,
    forward: Transformer,
    inverse: Transformer,
    pixel_ground_m: float,
    hunt_mask: np.ndarray,
    gmu_raster: np.ndarray,
    elevation: np.ndarray,
    cover: np.ndarray,
    developed: np.ndarray,
    evt_table: dict[int, dict[str, str]],
    slope: np.ndarray,
    aspect: np.ndarray,
    draw: np.ndarray,
    bench: np.ndarray,
    northeast: np.ndarray,
    public_mask: np.ndarray,
    trail_mask: np.ndarray,
    warnings: list[str],
) -> None:
    log("Loading CPW historical conflict areas")
    conflict_collection = arcgis_geojson(
        session,
        CPW_BEAR_CONFLICT,
        bbox=bbox,
        out_fields="ACTIVITYCO,EDIT_DATE",
        max_offset=0.00025,
    )
    conflict_geometries = []
    for feature in conflict_collection.get("features", []):
        geometry = feature.get("geometry")
        if not geometry:
            continue
        clipped = make_valid(shape(geometry)).intersection(hunt_geometry)
        if not clipped.is_empty:
            conflict_geometries.append(clipped)
    if not conflict_geometries:
        raise BuildWarning("No CPW historical conflict polygons intersect the hunt area")
    conflict_geometry = unary_union(conflict_geometries)

    try:
        log("Loading USGS place names and habitation anchors")
        gnis_names = read_gnis_names(session, temporary, bbox)
    except Exception as error:
        warnings.append(f"GNIS place names unavailable: {error}")
        gnis_names = []

    log("Loading developed camping inventories")
    inventory_sources, inventory_warnings = load_human_food_sources(session, bbox)
    warnings.extend(inventory_warnings)
    habitation = habitation_sources(
        developed,
        hunt_mask,
        transform,
        inverse,
        gnis_names,
    )
    all_sources = inventory_sources + habitation
    measurement_forward = Transformer.from_crs(
        "EPSG:4326",
        "EPSG:5070",
        always_xy=True,
    )
    clusters = conflict_linked_source_clusters(
        all_sources,
        conflict_geometry,
        hunt_geometry,
        measurement_forward,
    )
    if not clusters:
        raise BuildWarning("No mapped campsite or habitation source was linked to conflict habitat")

    secure = np.clip(
        0.68 * cover
        + 0.17 * northeast
        + 0.15 * np.clip((slope - 12) / 18, 0, 1),
        0,
        1,
    )
    secure = gaussian_filter(secure, sigma=2)
    secure_pixels = (secure >= 0.54) & hunt_mask & public_mask
    cover_width = distance_transform_edt(secure_pixels) * pixel_ground_m
    pinch = np.exp(-np.square((cover_width - 125) / 120)) * secure_pixels
    trail_distance = distance_transform_edt(~trail_mask) * pixel_ground_m
    trail_penalty = np.clip(np.exp(-trail_distance / 230) * 0.75, 0, 1)
    security_score = np.clip(
        0.60 * secure
        + 0.18 * draw
        + 0.12 * bench
        + 0.10 * pinch
        - 0.16 * trail_penalty,
        0,
        1,
    )
    security_eligible = (
        secure_pixels
        & (slope >= 4)
        & (slope <= 38)
        & (security_score >= 0.43)
    )
    maximum_window = max(7, round(800 / pixel_ground_m))
    security_maxima = (
        security_score
        == maximum_filter(security_score, size=maximum_window, mode="nearest")
    ) & security_eligible
    candidate_cells = np.argwhere(security_maxima)
    selected_sources = select_human_sources(
        clusters,
        transform,
        forward,
        hunt_mask,
        gmu_raster,
        candidate_cells,
        security_score,
        pixel_ground_m,
    )
    if not selected_sources:
        raise BuildWarning("No conflict-linked source had two nearby public-land security options")

    log("Refining selected sources with 30 m behavior-aware movement tiles")
    refined_sources: list[dict[str, Any]] = []
    for source_index, source in enumerate(selected_sources, start=1):
        cluster_center = cluster_center_point(source["members"])
        try:
            refinement, refinement_warnings = build_local_human_refinement(
                session,
                temporary,
                f"human-{source_index:02d}",
                cluster_center,
                source["members"],
                units_collection,
                transform,
                public_mask,
                evt_table,
                forward,
                inverse,
            )
            warnings.extend(refinement_warnings)
        except Exception as error:
            warnings.append(
                f"30 m refinement unavailable for {source['name']}: {error}"
            )
            continue
        security_cells = refinement["securityCells"]
        if len(security_cells) < 2:
            warnings.append(
                f"30 m refinement found fewer than two security areas for {source['name']}"
            )
            continue
        security_quality = float(
            np.mean(
                [refinement["securityScore"][cell] for cell in security_cells]
            )
        )
        cluster_bonus = min(math.log1p(source["sourceCount"]) / math.log(6), 1)
        priority = (
            0.68 * source["conflictScore"]
            + 0.17 * source["strength"]
            + 0.10 * security_quality
            + 0.05 * cluster_bonus
        )
        refined_sources.append(
            {
                **source,
                "clusterCenter": cluster_center,
                "priority": priority,
                "refinement": refinement,
                "securityCells": security_cells,
            }
        )
    if len(refined_sources) < 4:
        raise BuildWarning(
            "Fewer than four conflict-linked sources survived 30 m refinement"
        )
    selected_sources = sorted(
        refined_sources,
        key=lambda source: source["priority"],
        reverse=True,
    )[:8]

    features: list[dict[str, Any]] = []
    source_features: list[dict[str, Any]] = []
    source_member_features: list[dict[str, Any]] = []
    source_buffer_features: list[dict[str, Any]] = []
    source_area_features: list[dict[str, Any]] = []
    source_portal_features: list[dict[str, Any]] = []
    security_features: list[dict[str, Any]] = []
    corridor_features: list[dict[str, Any]] = []
    for feature in units_collection.get("features", []):
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
    for index, geometry in enumerate(conflict_geometries, start=1):
        features.append(
            as_feature(
                geometry,
                {
                    "kind": "human-conflict",
                    "conflictId": f"conflict-{index}",
                    "source": "CPW Species Activity Mapping",
                    "meaning": "Historical human-conflict area; not a current sighting",
                },
            )
        )

    for rank, source in enumerate(selected_sources, start=1):
        target_id = f"target-{rank}"
        source_point = source["point"]
        refinement = source["refinement"]
        fine_transform = refinement["transform"]
        fine_inverse = refinement["inverse"]
        fine_pixel_ground_m = float(refinement["pixelGroundM"])
        source_mask = refinement["sourceMask"]
        (
            source_area_geometry,
            caution_geometry,
            projected_source_area,
            projected_caution,
        ) = source_zone_geometries(
            source_mask,
            fine_transform,
            fine_inverse,
            fine_pixel_ground_m,
        )
        footprint_acres = (
            float(np.count_nonzero(source_mask))
            * fine_pixel_ground_m**2
            / 4_046.8564224
        )
        _, footprint_parts = connected_components(source_mask)
        source_extent_miles = float(source["sourceExtentM"]) / 1_609.344
        conflict_distance_m = float(source["conflictDistanceM"])
        conflict_distance_miles = conflict_distance_m / 1_609.344
        relative_score = int(round(np.clip(55 + 44 * source["priority"], 60, 99)))
        security_cells = source["securityCells"]
        categories = sorted(
            {str(member["category"]) for member in source["members"]}
        )
        source_members = [
            {
                "name": str(member["name"]),
                "category": str(member["category"]),
                "manager": str(member["manager"]),
                "inventory": str(member["inventory"]),
            }
            for member in source["members"]
        ]
        conflict_reason = (
            "mapped source overlaps CPW historical conflict habitat"
            if conflict_distance_m <= 1
            else f"mapped source is {conflict_distance_miles:.1f} mi from CPW conflict habitat"
        )
        summary = (
            f"Human-food priority {relative_score}/100; {source['sourceCount']} records "
            f"form {footprint_parts} mapped attraction "
            f"{'patch' if footprint_parts == 1 else 'patches'} covering "
            f"{footprint_acres:.0f} acres. Routes stop half a mile from the full "
            "footprint; verify fresh sign and legal access."
        )
        target_properties = {
            "kind": "target",
            "model": "human-food",
            "targetId": target_id,
            "rank": rank,
            "name": source["name"],
            "shortName": f"H{rank:02d} · {source['name']}",
            "sourceCategory": source["category"],
            "sourceCategories": categories,
            "sourceManager": source["manager"],
            "sourceInventory": source["inventory"],
            "sourceCount": int(source["sourceCount"]),
            "sourceMembers": source_members,
            "sourceFootprintAcres": round(footprint_acres),
            "sourceFootprintParts": int(footprint_parts),
            "sourceExtentMiles": round(source_extent_miles, 2),
            "huntCode": HUNT_CODE,
            "gmu": int(source["gmu"]),
            "relativeScore": relative_score,
            "conflictScore": round(float(source["conflictScore"]) * 100),
            "conflictDistanceMiles": round(conflict_distance_miles, 2),
            "securityOptions": len(security_cells),
            "reason1": conflict_reason,
            "reason2": (
                f"{source['sourceCount']} records form {footprint_parts} mapped attraction "
                f"{'patch' if footprint_parts == 1 else 'patches'} across "
                f"{source_extent_miles:.1f} mi"
                if source["sourceCount"] > 1
                else (
                    f"mapped {source['category'].lower()} plus nearby developed land "
                    "define the attraction footprint"
                )
            ),
            "reason3": (
                f"{len(security_cells)} distinct federal-land security areas survived "
                "30 m terrain and disturbance refinement"
            ),
            "caveat1": "historical conflict mapping is not a current bear report",
            "caveat2": "do not hunt at or shoot toward campsites, homes, roads, or occupied areas",
            "summary": summary,
            "latitude": round(source_point.y, 6),
            "longitude": round(source_point.x, 6),
            "analysisDate": as_of.isoformat(),
        }
        source_feature = as_feature(source_point, target_properties)
        source_features.append(source_feature)
        features.append(source_feature)
        source_area_feature = as_feature(
            source_area_geometry,
            {
                "kind": "source-area",
                "targetId": target_id,
                "sourceName": source["name"],
                "sourceCount": int(source["sourceCount"]),
                "footprintAcres": round(footprint_acres),
                "footprintParts": int(footprint_parts),
                "meaning": (
                    "Human-food attraction hypothesis from source-record buffers and "
                    "nearby dense LANDFIRE development; not confirmed food access."
                ),
            },
        )
        source_area_features.append(source_area_feature)
        features.append(source_area_feature)
        source_buffer_feature = as_feature(
            caution_geometry,
            {
                "kind": "source-buffer",
                "targetId": target_id,
                "sourceName": source["name"],
                "radiusMiles": round(SOURCE_CAUTION_RADIUS_M / 1_609.344, 2),
                "bufferBasis": "distance from the full source-attraction footprint",
                "meaning": (
                    "Analysis caution radius around the complete attraction footprint; "
                    "routes stop here. This is not a statutory hunting boundary."
                ),
            },
        )
        source_buffer_features.append(source_buffer_feature)
        features.append(source_buffer_feature)

        for member_index, member in enumerate(source["members"], start=1):
            member_feature = as_feature(
                member["point"],
                {
                    "kind": "source-member",
                    "targetId": target_id,
                    "memberId": f"{target_id}-member-{member_index}",
                    "name": str(member["name"]),
                    "category": str(member["category"]),
                    "manager": str(member["manager"]),
                    "inventory": str(member["inventory"]),
                    "capacity": member.get("capacity"),
                    "meaning": "Contributing mapped record; not confirmed food access.",
                },
            )
            source_member_features.append(member_feature)
            features.append(member_feature)

        for option_index, security_cell in enumerate(security_cells, start=1):
            option_label = chr(64 + option_index)
            security_id = f"{target_id}-security-{option_index}"
            security_point = point_from_cell(
                fine_transform,
                fine_inverse,
                security_cell,
            )
            nearby = nearest_name(gnis_names, security_point.x, security_point.y)
            nearby_name = (
                nearby["name"]
                if nearby
                else f"GMU {int(refinement['gmu'][security_cell])} cover"
            )
            route, ensemble_routes, route_agreement, portal_count = (
                corridor_route_ensemble(
                    security_cell,
                    source_mask,
                    refinement["sourceCautionMask"],
                    refinement["nightCost"],
                    refinement["dawnCost"],
                    fine_pixel_ground_m,
                    seed=rank * 100 + option_index,
                )
            )
            route_rows = np.array([cell[0] for cell in route], dtype=int)
            route_columns = np.array([cell[1] for cell in route], dtype=int)
            direct_distance_m = float(
                refinement["sourceDistanceM"][security_cell]
            )
            (
                corridor_geometry,
                approach_projected,
                projected_corridor,
            ) = route_geometry_outside_zone(
                fine_transform,
                fine_inverse,
                route,
                projected_caution,
            )
            map_units_per_ground_m = abs(fine_transform.a) / fine_pixel_ground_m
            modeled_route_m = projected_corridor.length / map_units_per_ground_m
            approach_cell = route[-1]
            approach_distance_m = (
                approach_projected.distance(projected_source_area)
                / map_units_per_ground_m
            )
            approach_point = Point(
                *fine_inverse.transform(
                    approach_projected.x,
                    approach_projected.y,
                )
            )
            arrival_member, _ = min(
                refinement["sourceMemberCells"],
                key=lambda item: math.hypot(
                    approach_cell[0] - item[1][0],
                    approach_cell[1] - item[1][1],
                ),
            )
            arrival_source = str(arrival_member["name"])
            option_name = f"H{rank:02d}{option_label} · {nearby_name}"
            option_summary = (
                f"{direct_distance_m / 1_609.344:.1f} mi from the nearest source patch; "
                f"representative corridor {modeled_route_m / 1_609.344:.1f} mi to the "
                f"{approach_distance_m / 1_609.344:.1f} mi footprint caution edge "
                f"near {arrival_source}; "
                f"security score {round(float(refinement['securityScore'][security_cell]) * 100)}/100. "
                "Verify ownership, closures, current sign, wind, and safe shooting conditions."
            )
            common_properties = {
                "targetId": target_id,
                "securityId": security_id,
                "option": option_index,
                "optionLabel": option_label,
                "name": option_name,
                "sourceName": source["name"],
                "arrivalSource": arrival_source,
                "portalCount": portal_count,
                "gmu": int(refinement["gmu"][security_cell]),
                "securityScore": round(
                    float(refinement["securityScore"][security_cell]) * 100
                ),
                "cover": round(float(refinement["cover"][security_cell]) * 100),
                "routeCover": round(
                    float(np.mean(refinement["cover"][route_rows, route_columns])) * 100
                ),
                "routeDrainage": round(
                    float(np.mean(refinement["drainage"][route_rows, route_columns]))
                    * 100
                ),
                "roadExposure": round(
                    float(
                        np.mean(refinement["roadExposure"][route_rows, route_columns])
                    )
                    * 100
                ),
                "pressure": round(
                    float(np.mean(refinement["pressure"][route_rows, route_columns]))
                    * 100
                ),
                "publicPercent": round(
                    float(np.mean(refinement["public"][route_rows, route_columns]))
                    * 100
                ),
                "distanceMiles": round(direct_distance_m / 1_609.344, 2),
                "routeMiles": round(modeled_route_m / 1_609.344, 2),
                "approachDistanceMiles": round(approach_distance_m / 1_609.344, 2),
                "sourceBufferMiles": round(SOURCE_CAUTION_RADIUS_M / 1_609.344, 2),
                "routeAgreement": route_agreement,
                "ensembleRoutes": len(ensemble_routes),
                "resolutionM": round(fine_pixel_ground_m),
                "routeScenario": "night approach plus dawn return",
                "elevationFt": round(
                    float(refinement["elevation"][security_cell]) * 3.28084
                ),
                "slopeDegrees": round(float(refinement["slope"][security_cell])),
                "latitude": round(security_point.y, 6),
                "longitude": round(security_point.x, 6),
                "summary": option_summary,
                "verified": False,
            }
            security_polygon = security_area_polygon(
                refinement["securityScore"],
                refinement["public"],
                security_cell,
                fine_transform,
                fine_inverse,
                fine_pixel_ground_m,
            )
            features.append(
                as_feature(
                    security_polygon,
                    {"kind": "security-area", **common_properties},
                )
            )
            security_feature = as_feature(
                security_point,
                {"kind": "security", **common_properties},
            )
            security_features.append(security_feature)
            features.append(security_feature)
            portal_feature = as_feature(
                approach_point,
                {
                    "kind": "source-portal",
                    **common_properties,
                    "name": f"{option_name} modeled arrival portal",
                    "meaning": (
                        "Representative corridor endpoint on the analysis caution edge; "
                        "not an observed crossing or setup recommendation."
                    ),
                },
            )
            source_portal_features.append(portal_feature)
            features.append(portal_feature)
            features.append(
                as_feature(
                    corridor_band_geometry(
                        fine_transform,
                        fine_inverse,
                        ensemble_routes,
                        fine_pixel_ground_m,
                        projected_caution,
                    ),
                    {
                        "kind": "corridor-band",
                        **common_properties,
                        "name": f"{option_name} near-optimal corridor band",
                        "meaning": (
                            "Envelope of night, dawn, and perturbed near-optimal paths; "
                            "not an observed animal trail."
                        ),
                    },
                )
            )
            corridor_feature = as_feature(
                corridor_geometry,
                {
                    "kind": "corridor",
                    **common_properties,
                    "name": f"{option_name} → source-footprint caution edge",
                    "meaning": (
                        "Representative route within the broader uncertainty band; "
                        "not an observed animal trail."
                    ),
                },
            )
            corridor_features.append(corridor_feature)
            features.append(corridor_feature)

    metadata = {
        "huntCode": HUNT_CODE,
        "units": list(HUNT_UNITS),
        "season": "2026-09-02/2026-09-30",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "analysisDate": as_of.isoformat(),
        "imageryDate": None,
        "droughtUpdated": None,
        "mode": "human-food",
        "methodVersion": "0.4-source-footprints",
        "scoreMeaning": (
            "Relative human-food priority led by CPW historical conflict overlap; "
            "multipart source footprints and corridor bands are modeled hypotheses, "
            "not bear probability, confirmed food access, observed trails, or current "
            "sightings."
        ),
        "sourceCount": len(source_features),
        "sourceMemberCount": len(source_member_features),
        "sourceAreaCount": len(source_area_features),
        "sourcePortalCount": len(source_portal_features),
        "securityOptionCount": len(security_features),
        "corridorBandCount": len(corridor_features),
        "screeningResolutionM": round(pixel_ground_m),
        "refinementResolutionM": round(FINE_GROUND_RESOLUTION_M),
        "sourceCautionRadiusMiles": round(
            SOURCE_CAUTION_RADIUS_M / 1_609.344,
            2,
        ),
        "corridorEnsembleMembers": CORRIDOR_ENSEMBLE_MEMBERS,
        "corridorScenarios": ["night approach", "dawn return"],
        "sourceFootprintModel": {
            "meaning": (
                "Multipart attraction hypothesis built without a convex hull; "
                "individual source records remain visible"
            ),
            "anchorRadiiM": {
                "campground": 120,
                "swaCampsite": 160,
                "developedArea": 240,
                "populatedPlace": 320,
            },
            "developedPatchLinkRadiusM": SOURCE_DEVELOPED_LINK_RADIUS_M,
            "developedPatchMaximumReachM": SOURCE_DEVELOPED_MAX_REACH_M,
            "routeDestination": (
                "least-cost reachable cell on any source-footprint patch; displayed "
                "routes stop at the footprint-based caution edge"
            ),
        },
        "costModel": {
            "meaning": "Dimensionless relative traversal cost; lower is easier",
            "commonWeights": {
                "drainage": -0.34,
                "draw": -0.25,
                "bench": -0.18,
                "saddle": -0.20,
                "habitat": -0.16,
                "ruggedness": -0.10,
                "ridge": 0.62,
                "slopeExertion": 0.50,
            },
            "nightWeights": {
                "coverGap": 1.02,
                "trail": 0.30,
                "localRoad": 0.28,
                "secondaryRoad": 1.70,
                "primaryRoad": 4.80,
                "development": 0.35,
            },
            "dawnWeights": {
                "coverGap": 1.40,
                "trail": 0.95,
                "localRoad": 0.72,
                "secondaryRoad": 2.20,
                "primaryRoad": 5.40,
                "development": 1.05,
                "extraDrainage": -0.10,
                "extraRuggedness": -0.08,
            },
            "barriers": {
                "mappedWaterMinimumCost": 18,
                "slopeAtLeast50DegreesMinimumCost": 24,
                "outsideHuntUnits": "closed",
            },
        },
        "behaviorReferences": [
            {
                "title": "Johnson et al. 2015 — dynamic development selection",
                "url": "https://digitalcommons.unl.edu/icwdm_usdanwrc/1698/",
            },
            {
                "title": "Baruch-Mordo et al. 2014 — natural forage and urban use",
                "url": "https://pmc.ncbi.nlm.nih.gov/articles/PMC3885671/",
            },
            {
                "title": "Costello et al. 2013 — covered corridor crossings",
                "url": (
                    "https://www.bearbiology.org/download/"
                    "response-of-american-black-bears-to-the-non-motorized-"
                    "expansion-of-a-road-corridor-in-grand-teton-national-park/"
                ),
            },
        ],
        "sources": {
            "conflict": SOURCE_LINKS["cpw"],
            "campgrounds": SOURCE_LINKS["campgrounds"],
            "habitation": SOURCE_LINKS["habitation"],
            "landfire": SOURCE_LINKS["landfire"],
            "terrain": SOURCE_LINKS["terrain"],
            "hydrography": SOURCE_LINKS["hydrography"],
            "roads": SOURCE_LINKS["roads"],
        },
        "warnings": list(dict.fromkeys(warnings)),
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
    write_human_food_gpx(
        source_features,
        source_member_features,
        source_buffer_features,
        security_features,
        corridor_features,
    )
    log(
        f"Wrote {len(source_features)} human-food source clusters, "
        f"{len(source_member_features)} contributing records, "
        f"{len(security_features)} security options, and "
        f"{len(corridor_features)} routes"
    )


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


def run(
    as_of: date,
    *,
    mode: str = "human-food",
    skip_satellite: bool = False,
) -> None:
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
        food_class, cover, open_food, developed, vegetation_labels = landfire_scores(
            evt,
            evc,
            evt_table,
        )
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

        if mode == "human-food":
            log("Loading trail pressure and federal surface management")
            trail_mask, trail_warnings = load_trail_mask(
                session,
                bbox,
                transform,
                shape_,
                forward,
            )
            warnings.extend(trail_warnings)
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
            build_human_food_analysis(
                session,
                as_of,
                temporary,
                units_collection,
                hunt_geometry,
                bbox,
                transform,
                forward,
                inverse,
                pixel_ground_m,
                hunt_mask,
                gmu_raster,
                elevation,
                cover,
                developed,
                evt_table,
                slope,
                aspect,
                draw,
                bench,
                northeast,
                public_mask,
                trail_mask,
                warnings,
            )
            return

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

        trail_mask, trail_warnings = load_trail_mask(
            session,
            bbox,
            transform,
            shape_,
            forward,
        )
        warnings.extend(trail_warnings)

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
        "--mode",
        choices=("human-food", "natural-food"),
        default="human-food",
        help="Target model to build (default: human-food)",
    )
    parser.add_argument(
        "--skip-satellite",
        action="store_true",
        help="Build with a neutral vegetation signal for offline debugging",
    )
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    run(
        arguments.as_of,
        mode=arguments.mode,
        skip_satellite=arguments.skip_satellite,
    )
