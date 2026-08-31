import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { BearTargetCollection } from '@/lib/bear-targets';

export const BEAR_TARGET_LAYER_IDS = [
  'bear-hunt-area-fill',
  'bear-target-zones',
  'bear-target-zone-outlines',
  'bear-corridors',
  'bear-glassing-halos',
  'bear-glassing-points',
  'bear-hunt-area-outline',
  'bear-target-halos',
  'bear-target-points',
  'bear-target-labels',
] as const;

export const BEAR_TARGET_INTERACTIVE_LAYERS = [
  'bear-target-points',
  'bear-target-zones',
] as const;

export function addOrUpdateBearTargetLayers(
  map: MapLibreMap,
  collection: BearTargetCollection,
) {
  const existing = map.getSource('bear-target-analysis') as
    | GeoJSONSource
    | undefined;
  if (existing) {
    existing.setData(collection);
    return;
  }

  map.addSource('bear-target-analysis', {
    type: 'geojson',
    data: collection,
  });
  map.addLayer({
    id: 'bear-hunt-area-fill',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'hunt-boundary'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#081f17',
      'fill-opacity': 0.07,
    },
  });
  map.addLayer({
    id: 'bear-target-zones',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target-zone'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': [
        'interpolate',
        ['linear'],
        ['get', 'relativeScore'],
        60,
        '#e5b34d',
        100,
        '#ef6c36',
      ],
      'fill-opacity': 0.3,
    },
  });
  map.addLayer({
    id: 'bear-target-zone-outlines',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target-zone'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#ffb44c',
      'line-opacity': 0.94,
      'line-width': 2,
    },
  });
  map.addLayer({
    id: 'bear-corridors',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'corridor'],
    layout: {
      visibility: 'none',
      'line-cap': 'round',
      'line-join': 'round',
    },
    paint: {
      'line-color': '#75e1be',
      'line-dasharray': [2, 1.5],
      'line-opacity': 0.96,
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        7,
        2,
        13,
        4,
      ],
    },
  });
  map.addLayer({
    id: 'bear-glassing-halos',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'glassing'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#d8f5ff',
      'circle-opacity': 0.28,
      'circle-radius': 10,
    },
  });
  map.addLayer({
    id: 'bear-glassing-points',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'glassing'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#7ddff5',
      'circle-radius': 4,
      'circle-stroke-color': '#082c35',
      'circle-stroke-width': 1.5,
    },
  });
  map.addLayer({
    id: 'bear-hunt-area-outline',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'hunt-boundary'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#f7f1df',
      'line-opacity': 0.75,
      'line-width': 1.3,
    },
  });
  map.addLayer({
    id: 'bear-target-halos',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#081f17',
      'circle-opacity': 0.48,
      'circle-radius': 15,
    },
  });
  map.addLayer({
    id: 'bear-target-points',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#ef7b3d',
      'circle-radius': 9,
      'circle-stroke-color': '#fff8e8',
      'circle-stroke-width': 2.2,
    },
  });
  map.addLayer({
    id: 'bear-target-labels',
    type: 'symbol',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target'],
    layout: {
      visibility: 'none',
      'text-field': ['to-string', ['get', 'rank']],
      'text-font': ['Open Sans Semibold'],
      'text-size': 11,
      'text-allow-overlap': true,
    },
    paint: {
      'text-color': '#fffdf5',
    },
  });
}

export function setBearTargetSelection(
  map: MapLibreMap,
  targetId: string | null,
) {
  if (!map.getLayer('bear-target-points')) return;
  map.setPaintProperty('bear-target-points', 'circle-color', [
    'case',
    ['==', ['get', 'targetId'], targetId ?? ''],
    '#ffd36a',
    '#ef7b3d',
  ]);
  map.setPaintProperty('bear-target-points', 'circle-radius', [
    'case',
    ['==', ['get', 'targetId'], targetId ?? ''],
    12,
    9,
  ]);
  map.setPaintProperty('bear-target-zones', 'fill-opacity', [
    'case',
    ['==', ['get', 'targetId'], targetId ?? ''],
    0.5,
    0.25,
  ]);
  map.setPaintProperty('bear-corridors', 'line-opacity', [
    'case',
    ['==', ['get', 'targetId'], targetId ?? ''],
    1,
    0.58,
  ]);
}
