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
  security areas per source, 30-meter security-to-source corridor ensembles,
  copyable option coordinates, aerial imagery, and a GPX download.
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

The batch step uses two spatial scales. It first resolves the nine GMUs in
BE012O1R and screens the entire hunt area on a roughly 57-meter ground grid. The
human-food mode links developed camping and generalized habitation anchors to
CPW historical bear-conflict polygons. Conflict overlap/proximity supplies 68%
of source priority; mapped source strength supplies 17%, nearby security quality
10%, and converging source records 5%. Because CPW's polygon layer does not
contain incident counts or usable event dates, overlap is a strong area prior—not
a claim of recent or frequent conflict.

Each selected source is then rebuilt on its own 14.4 × 14.4 km tile at 30-meter
ground spacing. LANDFIRE 2025 vegetation and canopy, USGS 3DEP terrain, USGS
National Hydrography flowlines and waterbodies, Census TIGER roads, COTREX
trails, and federal surface-management geometry identify two to five distinct
security-cover options 1–3.2 miles from the source. Every endpoint is gated to
mapped BLM, USFS, or Bureau of Reclamation land. Ownership boundaries are still
generalized and must be parcel-verified.

### Movement cost and corridor uncertainty

Movement is solved separately for a night approach and a dawn return. All soft
inputs are normalized to 0–1 and lower cost means easier modeled travel. The
shared part of the dimensionless cell cost is:

```text
-0.34 drainage -0.25 draw -0.18 bench -0.20 saddle
-0.16 habitat  -0.10 rugged cover
+0.62 exposed ridge +0.50 slope exertion
```

Night adds `+1.02 cover gap`, `+0.30 trail`, `+0.28 local road`, `+1.70
secondary road`, `+4.80 primary road`, and `+0.35 development`. Dawn raises
cover-gap and human-disturbance costs (`+1.40`, `+0.95`, `+0.72`, `+2.20`,
`+5.40`, and `+1.05`, respectively) and gives modest extra credit to drainage
and rugged cover. Road and trail terms are distance-decay surfaces, not claims
that a bear cannot cross them. Mapped water and slopes of at least 50 degrees
receive strong barrier costs; cells outside the hunt units are closed.

For each security option, the builder solves the night and dawn paths plus
deterministically perturbed near-optimal paths. The map displays their buffered
union as a corridor band and one representative centerline for GPX export. A
wide band or low night/dawn agreement means the inputs do not identify one
stable route. Every route stops at a 0.5-mile source caution ring. That ring is
an analysis guardrail, not a legal setback.

The cost coefficients are transparent, literature-informed hypotheses—not a
resource- or step-selection model fitted to local bear telemetry. Colorado GPS
work found that selection for development changes with natural-food conditions
and that bears become more nocturnal and use denser human development in poor
food years. A Grand Teton GPS study found more use of steep terrain and areas
farther from a recreation corridor, with covered crossing locations and more
morning/evening/night activity near people. Those findings justify separate
night/dawn surfaces, cover continuity, terrain refuge, and differentiated road
costs; they do not validate any individual line on this map.

- [Johnson et al. 2015: dynamic selection for human development](https://digitalcommons.unl.edu/icwdm_usdanwrc/1698/)
- [Baruch-Mordo et al. 2014: natural forage and urban use in Aspen](https://pmc.ncbi.nlm.nih.gov/articles/PMC3885671/)
- [Costello et al. 2013: response to a recreation/road corridor](https://www.bearbiology.org/download/response-of-american-black-bears-to-the-non-motorized-expansion-of-a-road-corridor-in-grand-teton-national-park/)

The model does not include live bear locations, fresh sign, food availability,
traffic volume, temporary closures, fences, culverts, wildfire blowdown, or a
verified legal shooting position. Routes can cross private land. Treat each
band as a shortlist for aerial review and field verification, not a predicted
animal trail.

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
- [USGS National Hydrography Dataset](https://www.usgs.gov/national-hydrography/nhdplus-high-resolution)
- [Census TIGERweb transportation](https://tigerweb.geo.census.gov/tigerweb/)
- [Colorado Trail Explorer trails](https://trails.colorado.gov/)
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
