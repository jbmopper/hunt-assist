import type { FeatureCollection, Geometry } from 'geojson';
import type {
  GeoJSONSource,
  Map as MapLibreMap,
  MapGeoJSONFeature,
} from 'maplibre-gl';

export type MapIntelCollection = FeatureCollection<
  Geometry,
  Record<string, unknown>
> & {
  metadata?: { warnings?: string[] };
};

export const BEAR_AREA_QUERY = '/api/bear-intel?layer=areas';
export const HUMAN_FOOD_QUERY = '/api/bear-intel?layer=human-food';
export const HUMAN_FOOD_MAP_LAYERS = [
  'human-food-clusters',
  'human-food-cluster-count',
  'human-food-points',
] as const;

export async function fetchIntelCollection(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error('Bear intelligence source did not respond');
  const collection = (await response.json()) as MapIntelCollection;
  if (
    collection.type !== 'FeatureCollection' ||
    !Array.isArray(collection.features)
  ) {
    throw new Error('Bear intelligence source was malformed');
  }
  return collection;
}

function textProperty(
  properties: MapGeoJSONFeature['properties'],
  key: string,
) {
  const value = properties?.[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function humanFoodPopup(properties: MapGeoJSONFeature['properties']) {
  const root = document.createElement('div');
  root.className = 'intel-popup';

  const kicker = document.createElement('span');
  kicker.className = 'intel-popup-kicker';
  kicker.textContent = textProperty(properties, 'category') ?? 'Developed site';
  root.appendChild(kicker);

  const title = document.createElement('strong');
  title.textContent = textProperty(properties, 'name') ?? 'Mapped camping site';
  root.appendChild(title);

  const usageLevel = textProperty(properties, 'usageLevel');
  const capacity = textProperty(properties, 'capacity');
  const details = [
    textProperty(properties, 'manager'),
    usageLevel ? `${usageLevel} reported use` : null,
    capacity ? `${capacity} capacity / sites` : null,
    textProperty(properties, 'status'),
  ].filter((value): value is string => value !== null);

  if (details.length) {
    const detail = document.createElement('span');
    detail.textContent = details.join(' · ');
    root.appendChild(detail);
  }

  const source = document.createElement('small');
  const updated = textProperty(properties, 'updated');
  source.textContent = `${textProperty(properties, 'source') ?? 'Public recreation inventory'}${updated ? ` · updated ${updated}` : ''}`;
  root.appendChild(source);

  const url = textProperty(properties, 'url');
  if (url) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        const link = document.createElement('a');
        link.href = parsed.toString();
        link.target = '_blank';
        link.rel = 'noreferrer';
        link.textContent = 'Open official site ↗';
        root.appendChild(link);
      }
    } catch {
      // Ignore malformed upstream links while keeping the location useful.
    }
  }

  const caveat = document.createElement('em');
  caveat.textContent =
    'Location proxy only — garbage access and bear presence are not verified.';
  root.appendChild(caveat);
  return root;
}

export function addBearAreaLayers(
  map: MapLibreMap,
  collection: MapIntelCollection,
) {
  map.addSource('bear-areas', {
    type: 'geojson',
    data: collection,
  });
  map.addLayer(
    {
      id: 'bear-fall-concentration-fill',
      type: 'fill',
      source: 'bear-areas',
      filter: ['==', ['get', 'kind'], 'fall-concentration'],
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#397a48',
        'fill-opacity': 0.27,
      },
    },
    'gmu-fill',
  );
  map.addLayer(
    {
      id: 'bear-fall-concentration-outline',
      type: 'line',
      source: 'bear-areas',
      filter: ['==', ['get', 'kind'], 'fall-concentration'],
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#235a31',
        'line-opacity': 0.88,
        'line-width': 1.35,
      },
    },
    'gmu-outline',
  );
  map.addLayer(
    {
      id: 'bear-human-conflict-fill',
      type: 'fill',
      source: 'bear-areas',
      filter: ['==', ['get', 'kind'], 'human-conflict'],
      layout: { visibility: 'none' },
      paint: {
        'fill-color': '#8f3250',
        'fill-opacity': 0.18,
      },
    },
    'gmu-fill',
  );
  map.addLayer(
    {
      id: 'bear-human-conflict-outline',
      type: 'line',
      source: 'bear-areas',
      filter: ['==', ['get', 'kind'], 'human-conflict'],
      layout: { visibility: 'none' },
      paint: {
        'line-color': '#77223f',
        'line-dasharray': [2, 1.5],
        'line-opacity': 0.9,
        'line-width': 1.2,
      },
    },
    'gmu-outline',
  );
}

export function addHumanFoodLayers(
  map: MapLibreMap,
  maplibregl: typeof import('maplibre-gl'),
  collection: MapIntelCollection,
) {
  map.addSource('human-food-locations', {
    type: 'geojson',
    data: collection,
    cluster: true,
    clusterMaxZoom: 9,
    clusterRadius: 38,
  });
  map.addLayer({
    id: 'human-food-clusters',
    type: 'circle',
    source: 'human-food-locations',
    filter: ['has', 'point_count'],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': '#c25f2e',
      'circle-radius': [
        'step',
        ['get', 'point_count'],
        12,
        10,
        16,
        35,
        20,
      ],
      'circle-stroke-color': '#fff7ec',
      'circle-stroke-width': 2,
      'circle-opacity': 0.9,
    },
  });
  map.addLayer({
    id: 'human-food-cluster-count',
    type: 'symbol',
    source: 'human-food-locations',
    filter: ['has', 'point_count'],
    layout: {
      visibility: 'none',
      'text-field': ['get', 'point_count_abbreviated'],
      'text-size': 10,
      'text-font': ['Open Sans Semibold'],
    },
    paint: { 'text-color': '#fffdf8' },
  });
  map.addLayer({
    id: 'human-food-points',
    type: 'circle',
    source: 'human-food-locations',
    filter: ['!', ['has', 'point_count']],
    layout: { visibility: 'none' },
    paint: {
      'circle-color': [
        'case',
        ['==', ['get', 'category'], 'SWA campsite'],
        '#d89d35',
        '#c25f2e',
      ],
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        5,
        4,
        10,
        7,
      ],
      'circle-stroke-color': '#fffdf8',
      'circle-stroke-width': 1.6,
      'circle-opacity': 0.94,
    },
  });

  map.on('click', 'human-food-clusters', async (event) => {
    const feature = event.features?.[0];
    if (feature?.geometry.type !== 'Point') return;
    const clusterId = Number(feature.properties?.cluster_id);
    if (!Number.isFinite(clusterId)) return;
    try {
      const source = map.getSource('human-food-locations') as GeoJSONSource;
      const zoom = await source.getClusterExpansionZoom(clusterId);
      map.easeTo({
        center: feature.geometry.coordinates as [number, number],
        zoom,
      });
    } catch {
      // A refresh can replace the source while a cluster click is resolving.
    }
  });
  map.on('click', 'human-food-points', (event) => {
    const feature = event.features?.[0];
    if (feature?.geometry.type !== 'Point') return;
    new maplibregl.Popup({ offset: 12, maxWidth: '280px' })
      .setLngLat(feature.geometry.coordinates as [number, number])
      .setDOMContent(humanFoodPopup(feature.properties))
      .addTo(map);
  });
  for (const layerId of ['human-food-clusters', 'human-food-points']) {
    map.on('mouseenter', layerId, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', layerId, () => {
      map.getCanvas().style.cursor = '';
    });
  }
}
