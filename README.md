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
- Saves starred hunt codes in browser storage on the current device.
- Caches each CPW feed for five minutes and provides a manual refresh action.
- Falls back to a clearly labeled five-row sample if the leftover feed is
  temporarily unavailable.

The local JSON endpoint is:

```text
GET /api/licenses?source=leftover
GET /api/licenses?source=reissue
GET /api/licenses?source=leftover&refresh=1
```

## Data sources

- [CPW leftover and reissued licenses](https://cpw.state.co.us/activities/hunting/big-game/leftover-remaining-and-reissued-licenses)
- [2026 Colorado big-game brochure](https://cpw.state.co.us/sites/default/files/dam/erjzbk48be/colorado-big-game-hunting-brochure.pdf)
- [Colorado Hunting Atlas](https://ndismaps.nrel.colostate.edu/index.html)
- [Hunting Atlas ArcGIS services](https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas)
- [CPW maps and GIS downloads](https://cpw.state.co.us/maps-and-gis)

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
