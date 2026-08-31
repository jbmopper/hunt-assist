import assert from 'node:assert/strict';
import test from 'node:test';
import type { FeatureCollection, Geometry } from 'geojson';
import {
  BEAR_INTEL_SOURCE_URLS,
  CURRENT_DROUGHT_RASTER_TILES,
  normalizeBearAreaSources,
  normalizeHumanFoodSources,
} from '../lib/bear-intel';

type SourceCollection = FeatureCollection<Geometry, Record<string, unknown>>;

function collection(
  features: SourceCollection['features'],
): SourceCollection {
  return { type: 'FeatureCollection', features };
}

test('normalizes current BLM campground fields and safe links', () => {
  const features = normalizeHumanFoodSources({
    blm: collection([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-105.1, 38.5] },
        properties: {
          FacilityName: 'Example Campground',
          FacilityTypeDescription: 'Campground',
          Reservable: '-1',
          LastUpdatedDate: '2026-05-29',
          BLMFacURL: 'https://www.blm.gov/visit/example',
        },
      },
    ]),
  });

  assert.equal(features.length, 1);
  assert.deepEqual(features[0].properties, {
    kind: 'human-food-location',
    representedSites: 1,
    name: 'Example Campground',
    category: 'Campground',
    manager: 'BLM',
    source: 'BLM recreation inventory',
    updated: '2026-05-29',
    capacity: null,
    usageLevel: null,
    status: null,
    reservable: 'Yes',
    url: 'https://www.blm.gov/visit/example',
  });
});

test('collapses individual SWA campsite points into one planning location', () => {
  const features = normalizeHumanFoodSources({
    cpwSwaCampsites: collection([
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-107, 39] },
        properties: { PROPNAME: 'Example SWA', TYPE_DETAIL: 'Tent' },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-106.98, 39.02] },
        properties: { PROPNAME: 'Example SWA', TYPE_DETAIL: 'Tent' },
      },
    ]),
  });

  assert.equal(features.length, 1);
  assert.ok(Math.abs(features[0].geometry.coordinates[0] - -106.99) < 1e-9);
  assert.ok(Math.abs(features[0].geometry.coordinates[1] - 39.01) < 1e-9);
  assert.equal(features[0].properties.representedSites, 2);
  assert.equal(features[0].properties.category, 'SWA campsite');
});

test('labels CPW bear polygons by their distinct proxy purpose', () => {
  const polygon = {
    type: 'Feature' as const,
    geometry: {
      type: 'Polygon' as const,
      coordinates: [[[-105, 39], [-104, 39], [-104, 40], [-105, 39]]],
    },
    properties: { EDIT_DATE: Date.UTC(2025, 11, 23) },
  };
  const features = normalizeBearAreaSources({
    fallConcentration: collection([polygon]),
    humanConflict: collection([polygon]),
  });

  assert.deepEqual(
    features.map((feature) => feature.properties.kind),
    ['fall-concentration', 'human-conflict'],
  );
  assert.equal(features[0].properties.updated, '2025-12-23');
});

test('uses current official services instead of the retired ForWarn viewer', () => {
  assert.match(
    BEAR_INTEL_SOURCE_URLS.fallConcentration,
    /CPWSpeciesData\/FeatureServer\/19\/query/,
  );
  assert.match(CURRENT_DROUGHT_RASTER_TILES[0], /Drought_Current/);
  assert.doesNotMatch(CURRENT_DROUGHT_RASTER_TILES[0], /forwarn/i);
});
