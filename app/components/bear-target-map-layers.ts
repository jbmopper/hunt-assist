import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { BearTargetCollection } from '@/lib/bear-targets';

export const BEAR_TARGET_LAYER_IDS = [
  'bear-hunt-area-fill',
  'bear-analysis-conflict-fill',
  'bear-analysis-conflict-outline',
  'bear-source-buffer-fill',
  'bear-source-buffer-outline',
  'bear-source-area-fill',
  'bear-source-area-outline',
  'bear-corridor-bands',
  'bear-corridor-band-outlines',
  'bear-security-areas',
  'bear-security-area-outlines',
  'bear-corridors',
  'bear-hunt-area-outline',
  'bear-source-portals',
  'bear-source-members',
  'bear-source-halos',
  'bear-source-points',
  'bear-source-labels',
  'bear-security-points',
  'bear-security-labels',
] as const;

export const BEAR_TARGET_INTERACTIVE_LAYERS = [
  'bear-source-points',
  'bear-source-members',
  'bear-source-area-fill',
  'bear-source-portals',
  'bear-security-points',
  'bear-security-areas',
  'bear-corridor-bands',
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
      'fill-opacity': 0.05,
    },
  });
  map.addLayer({
    id: 'bear-analysis-conflict-fill',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'human-conflict'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#8f3250',
      'fill-opacity': 0.17,
    },
  });
  map.addLayer({
    id: 'bear-analysis-conflict-outline',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'human-conflict'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#bc6683',
      'line-dasharray': [2, 1.5],
      'line-opacity': 0.72,
      'line-width': 1.2,
    },
  });
  map.addLayer({
    id: 'bear-source-buffer-fill',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'source-buffer'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#d76542',
      'fill-opacity': 0.08,
    },
  });
  map.addLayer({
    id: 'bear-source-buffer-outline',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'source-buffer'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#f1a36e',
      'line-dasharray': [1.2, 1.4],
      'line-opacity': 0.8,
      'line-width': 1.5,
    },
  });
  map.addLayer({
    id: 'bear-source-area-fill',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'source-area'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#c64f34',
      'fill-opacity': 0.24,
    },
  });
  map.addLayer({
    id: 'bear-source-area-outline',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'source-area'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#ffb07c',
      'line-opacity': 0.86,
      'line-width': 1.6,
    },
  });
  map.addLayer({
    id: 'bear-corridor-bands',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'corridor-band'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#4fd0aa',
      'fill-opacity': 0.16,
    },
  });
  map.addLayer({
    id: 'bear-corridor-band-outlines',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'corridor-band'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#87efd0',
      'line-opacity': 0.38,
      'line-width': 1,
    },
  });
  map.addLayer({
    id: 'bear-security-areas',
    type: 'fill',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'security-area'],
    layout: { visibility: 'none' },
    paint: {
      'fill-color': '#28745b',
      'fill-opacity': 0.24,
    },
  });
  map.addLayer({
    id: 'bear-security-area-outlines',
    type: 'line',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'security-area'],
    layout: { visibility: 'none' },
    paint: {
      'line-color': '#86e1bd',
      'line-opacity': 0.86,
      'line-width': 1.8,
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
      'line-color': '#83e3c2',
      'line-dasharray': [1.5, 1.6],
      'line-opacity': 0.76,
      'line-width': [
        'interpolate',
        ['linear'],
        ['zoom'],
        7,
        1.2,
        13,
        2.4,
      ],
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
      'line-opacity': 0.68,
      'line-width': 1.2,
    },
  });
  map.addLayer({
    id: 'bear-source-portals',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'source-portal'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#fff5dd',
      'circle-opacity': 0.9,
      'circle-radius': 4.5,
      'circle-stroke-color': '#d76542',
      'circle-stroke-width': 1.8,
    },
  });
  map.addLayer({
    id: 'bear-source-members',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'source-member'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#d76542',
      'circle-opacity': 0.8,
      'circle-radius': 4,
      'circle-stroke-color': '#fff4e7',
      'circle-stroke-width': 1.4,
    },
  });
  map.addLayer({
    id: 'bear-source-halos',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#4d152c',
      'circle-opacity': 0.54,
      'circle-radius': 16,
    },
  });
  map.addLayer({
    id: 'bear-source-points',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'target'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#e4673f',
      'circle-radius': 9,
      'circle-stroke-color': '#fff4e7',
      'circle-stroke-width': 2.2,
    },
  });
  map.addLayer({
    id: 'bear-source-labels',
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
    paint: { 'text-color': '#fffdf5' },
  });
  map.addLayer({
    id: 'bear-security-points',
    type: 'circle',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'security'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#236f56',
      'circle-radius': 8,
      'circle-stroke-color': '#d8fff0',
      'circle-stroke-width': 2,
    },
  });
  map.addLayer({
    id: 'bear-security-labels',
    type: 'symbol',
    source: 'bear-target-analysis',
    filter: ['==', ['get', 'kind'], 'security'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'optionLabel'],
      'text-font': ['Open Sans Semibold'],
      'text-size': 10,
      'text-allow-overlap': true,
    },
    paint: { 'text-color': '#f4fff9' },
  });
}

export function setBearTargetSelection(
  map: MapLibreMap,
  targetId: string | null,
) {
  if (!map.getLayer('bear-source-points')) return;
  const selected = ['==', ['get', 'targetId'], targetId ?? ''];
  map.setPaintProperty('bear-source-points', 'circle-color', [
    'case',
    selected,
    '#ffd36a',
    '#e4673f',
  ]);
  map.setPaintProperty('bear-source-points', 'circle-radius', [
    'case',
    selected,
    12,
    8,
  ]);
  map.setPaintProperty('bear-security-areas', 'fill-opacity', [
    'case',
    selected,
    0.44,
    0.09,
  ]);
  map.setPaintProperty('bear-security-area-outlines', 'line-opacity', [
    'case',
    selected,
    1,
    0.25,
  ]);
  map.setPaintProperty('bear-security-points', 'circle-opacity', [
    'case',
    selected,
    1,
    0.3,
  ]);
  map.setPaintProperty('bear-security-labels', 'text-opacity', [
    'case',
    selected,
    1,
    0.25,
  ]);
  map.setPaintProperty('bear-corridors', 'line-opacity', [
    'case',
    selected,
    1,
    0.14,
  ]);
  map.setPaintProperty('bear-corridor-bands', 'fill-opacity', [
    'case',
    selected,
    0.26,
    0.035,
  ]);
  map.setPaintProperty('bear-corridor-band-outlines', 'line-opacity', [
    'case',
    selected,
    0.58,
    0.08,
  ]);
  map.setPaintProperty('bear-source-buffer-fill', 'fill-opacity', [
    'case',
    selected,
    0.12,
    0.025,
  ]);
  map.setPaintProperty('bear-source-buffer-outline', 'line-opacity', [
    'case',
    selected,
    0.95,
    0.16,
  ]);
  map.setPaintProperty('bear-source-area-fill', 'fill-opacity', [
    'case',
    selected,
    0.34,
    0.045,
  ]);
  map.setPaintProperty('bear-source-area-outline', 'line-opacity', [
    'case',
    selected,
    1,
    0.12,
  ]);
  map.setPaintProperty('bear-source-members', 'circle-opacity', [
    'case',
    selected,
    1,
    0.18,
  ]);
  map.setPaintProperty('bear-source-portals', 'circle-opacity', [
    'case',
    selected,
    1,
    0.12,
  ]);
}
