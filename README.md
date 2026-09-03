# Colorado Hunt Finder

A local-first research tool that joins Colorado Parks and Wildlife license lists
to official Game Management Unit boundaries.

## Run it locally

Requirements: Node.js 22.13 or newer and npm.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). No account, API key, or
environment file is required.

Run the complete local verification suite with:

```bash
npm run check
```

## What works now

- Downloads CPW's current leftover or reissue-preview PDF on the server.
- Extracts hunt code, species, sex, method, GMUs, remaining quota, season,
  license list, residency restriction, access restriction, and description.
- Filters by species, hunting method, hunt code, GMU, description, public-land
  possibility, and saved status.
- Highlights every matching GMU on a MapLibre map using CPW's public Hunting
  Atlas ArcGIS service.
- Toggles CPW Public Access, Walk-In Access, and land-management overlays from
  that same Hunting Atlas service.
- Adds two explicitly labeled bear-planning proxies: fall forage context from
  CPW fall-concentration habitat plus the current U.S. Drought Monitor, and
  human-food exposure from developed campgrounds/SWA campsites plus CPW
  bear-human conflict areas.
- Adds a BE012O1R human-food targeting workspace with eight ranked,
  conflict-linked campsite/habitation sources, two to five nearby federal-land
  security areas per source, modeled security-to-source travel routes, copyable
  option coordinates, aerial imagery, and a GPX download.
- Clusters developed camping locations and shows their manager, source vintage,
  capacity/use details when available, and an official source link on click.
- Saves starred hunt codes in browser storage on the current device.
- Caches each CPW feed for five minutes and provides a manual refresh action.
- Falls back to a clearly labeled five-row sample if the leftover feed is
  temporarily unavailable.

The local JSON endpoint is:

```text
GET /api/licenses?source=leftover
GET /api/licenses?source=reissue
GET /api/licenses?source=leftover&refresh=1
GET /api/bear-intel?layer=areas
GET /api/bear-intel?layer=human-food
GET /data/be012o1r-targets.geojson
GET /data/be012o1r-targets.gpx
```

## Rebuild the BE012O1R analysis

The hosted app renders a precomputed target package. Rebuild it from current
public sources with:

```bash
uv run \
  --with numpy --with scipy --with rasterio --with shapely \
  --with pyproj --with requests --with scikit-image --with pyogrio \
  python scripts/build-bear-targets.py --as-of 2026-09-02 --mode human-food
```

The batch step resolves the nine GMUs in BE012O1R and scores a roughly
57-meter ground grid. The current human-food mode first links developed
camping and generalized habitation anchors to CPW historical bear-conflict
polygons. Conflict overlap/proximity supplies 68% of source priority; mapped
source strength supplies 17%, nearby security quality 10%, and converging
source records 5%. Because CPW's polygon layer does not contain incident counts
or usable event dates, overlap is a strong area prior—not a claim of recent or
frequent conflict.

For each selected source, LANDFIRE canopy, USGS 3DEP slope/aspect/draw/bench
terrain, COTREX trail pressure, and BLM surface-management geometry identify
two to five distinct security-cover options roughly one to 3.2 miles away.
Every endpoint is on mapped BLM, USFS, or Bureau of Reclamation land. A
least-cost route favors cover, draws, benches, and moderate slopes while
penalizing mapped trail proximity. Routes model animal movement and may cross
private land; every endpoint, route, and source must be field- and parcel-
verified.

The earlier vegetation-led analysis remains available to the builder with
`--mode natural-food`; extending it to the same multi-security-route structure
is the next model iteration. Use `--skip-satellite` only when debugging that
natural-food pipeline offline.

## Data sources

- [CPW leftover and reissued licenses](https://cpw.state.co.us/activities/hunting/big-game/leftover-remaining-and-reissued-licenses)
- [2026 Colorado big-game brochure](https://cpw.state.co.us/sites/default/files/dam/erjzbk48be/colorado-big-game-hunting-brochure.pdf)
- [Colorado Hunting Atlas](https://ndismaps.nrel.colostate.edu/index.html)
- [Hunting Atlas ArcGIS services](https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas)
- [CPW maps and GIS downloads](https://cpw.state.co.us/maps-and-gis)
- [CPW Species Activity Mapping web service](https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWSpeciesData/FeatureServer)
- [U.S. Drought Monitor current map service](https://gis.fema.gov/arcgis/rest/services/Partner/Drought_Current/MapServer)
- [USFS recreation-site inventory](https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecInfraRecreationSites_02/MapServer/0)
- [BLM recreation facilities](https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer/8)
- [USGS 3DEP elevation](https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer)
- [LANDFIRE 2025 vegetation](https://landfire.gov/data/lf2025)
- [Sentinel-2 Level-2A public COGs](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
- [USGS Geographic Names Information System](https://www.usgs.gov/tools/geographic-names-information-system-gnis)
- [BLM Surface Management Agency](https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer)

The Widen asset URLs used by CPW are discovered through their public asset
metadata response rather than hard-coding an expiring PDF download URL. PDF
parsing and all caching happen locally in this app.

The parser discovers table columns from each page's headers instead of assuming
fixed coordinates. It requires every detected hunt-code row to produce units,
list, quota, and season dates; malformed reports fail closed and the server uses
the last verified cached copy when one is available. Synthetic regression
fixtures cover wrapped rows, shifted layouts, notices, duplicates, missing
fields, and changed headers. GitHub Actions runs tests, lint, and the production
build on pushes and pull requests.

The bear overlays deliberately avoid manufacturing a precise probability score.
The forage proxy displays CPW's expert-mapped fall concentration polygons with
the weekly drought surface as separate visual signals; drought is vegetation
stress context, not a direct berry or acorn measurement. The human-food proxy
combines mapped developed-camping locations with CPW's historical human-conflict
areas. It does not claim that a campground has unsecured garbage, that a bear is
currently present, or that a location is open to hunting or firearm discharge.
The server normalizes and caches the public sources for six hours and returns a
partial, visibly labeled result when one provider is unavailable.

## Scope and next steps

This first version maps the current license lists and links the authoritative
brochure; it does not yet turn every brochure table and regulation into a
normalized catalog. The most useful next increment is to ingest brochure hunt
tables and special restrictions, then join CPW draw-recap, drawn-out-at, and
harvest statistics. Official Hunting Atlas layers can then add CPW public-access
properties, Walk-In Access parcels, land management, closures, and species
activity ranges.

This is a planning aid, not a license-purchase or legal-regulation system.
Availability can change at any time. Always verify the current CPW list,
brochure, license details, closures, and land ownership before applying or
hunting.
