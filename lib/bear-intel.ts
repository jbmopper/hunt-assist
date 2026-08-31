import type {
  Feature,
  FeatureCollection,
  Geometry,
  MultiPolygon,
  Point,
  Polygon,
} from 'geojson';

type SourceProperties = Record<string, unknown>;
type SourceCollection = FeatureCollection<Geometry, SourceProperties>;

export type BearAreaKind = 'fall-concentration' | 'human-conflict';

export type BearAreaProperties = {
  kind: BearAreaKind;
  source: string;
  updated: string | null;
};

export type HumanFoodProperties = {
  kind: 'human-food-location';
  name: string;
  category: string;
  manager: string;
  source: string;
  updated: string | null;
  capacity: number | null;
  usageLevel: string | null;
  status: string | null;
  reservable: string | null;
  url: string | null;
  representedSites: number;
};

export type IntelMetadata = {
  generatedAt: string;
  sources: string[];
  warnings: string[];
};

export type IntelFeatureCollection<
  TGeometry extends Geometry,
  TProperties,
> = FeatureCollection<TGeometry, TProperties> & {
  metadata: IntelMetadata;
};

const CPW_SPECIES_SERVICE =
  'https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWSpeciesData/FeatureServer';
const CPW_HUNTING_ATLAS_BASE =
  'https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas/HuntingAtlas_Base_Map/MapServer';
const USFS_RECREATION_SERVICE =
  'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_RecInfraRecreationSites_02/MapServer/0';
const BLM_CAMPING_SERVICE =
  'https://gis.blm.gov/arcgis/rest/services/recreation/BLM_Natl_Recreation_Sites_Facilities/MapServer/8';
const FEMA_DROUGHT_EXPORT =
  'https://gis.fema.gov/arcgis/rest/services/Partner/Drought_Current/MapServer/export';

const COLORADO_ENVELOPE = '-109.1,36.9,-102,41.1';

function arcgisQuery(
  layerUrl: string,
  options: Record<string, string>,
) {
  const query = new URLSearchParams({
    where: '1=1',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    ...options,
  });
  return `${layerUrl}/query?${query.toString()}`;
}

export const BEAR_INTEL_SOURCE_URLS = {
  fallConcentration: arcgisQuery(`${CPW_SPECIES_SERVICE}/19`, {
    outFields: 'ACTIVITYCO,EDIT_DATE',
    geometryPrecision: '4',
    maxAllowableOffset: '0.001',
  }),
  humanConflict: arcgisQuery(`${CPW_SPECIES_SERVICE}/20`, {
    outFields: 'ACTIVITYCO,EDIT_DATE',
    geometryPrecision: '4',
    maxAllowableOffset: '0.001',
  }),
  cpwCampgrounds: arcgisQuery(`${CPW_HUNTING_ATLAS_BASE}/78`, {
    where: "Display='Yes'",
    outFields:
      'Name,Manager,CGNumSites,CGReservable,DataLastUpdate,URL1,URL2,CGPropertyName',
    geometryPrecision: '5',
  }),
  cpwSwaCampsites: arcgisQuery(`${CPW_HUNTING_ATLAS_BASE}/69`, {
    outFields:
      'PROPNAME,PROP_TYPE,TYPE_DETAIL,SITE_COUNT,MGMT_AUTH,COLL_DATE',
    geometryPrecision: '5',
  }),
  usfsCampgrounds: arcgisQuery(USFS_RECREATION_SERVICE, {
    where:
      "site_type IN ('CAMPGROUND','GROUP CAMPGROUND','HORSE CAMP','CAMPING AREA')",
    geometry: COLORADO_ENVELOPE,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields:
      'site_name,site_type,managing_org,total_capacity,usage_level,seasonal_operational_status,open_season,rec1stop_url,infra_last_update,edw_last_modify,operated_by',
    geometryPrecision: '5',
  }),
  blmCampgrounds: arcgisQuery(BLM_CAMPING_SERVICE, {
    where: "State='CO'",
    outFields:
      'FacilityName,FacilityTypeDescription,Reservable,LastUpdatedDate,BLMFacURL,FacilityReservationURL,State',
    geometryPrecision: '5',
  }),
} as const;

export const CURRENT_DROUGHT_RASTER_TILES = [
  `${FEMA_DROUGHT_EXPORT}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true&layers=show%3A0&f=image`,
];

function propertyString(properties: SourceProperties, ...keys: string[]) {
  for (const key of keys) {
    const value = properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function propertyNumber(properties: SourceProperties, ...keys: string[]) {
  const value = propertyString(properties, ...keys);
  if (value === null) return null;
  const numeric = Number(value.replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizedDate(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? null
      : date.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime())
    ? trimmed.slice(0, 24)
    : parsed.toISOString().slice(0, 10);
}

function safeUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function reservableLabel(value: unknown) {
  if (value === -1 || value === '-1') return 'Yes';
  if (value === 0 || value === '0') return 'No';
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['yes', 'y', 'true'].includes(normalized)) return 'Yes';
  if (['no', 'n', 'false'].includes(normalized)) return 'No';
  return value.trim() || null;
}

function humanFoodFeature(
  feature: Feature<Geometry, SourceProperties>,
  properties: Omit<HumanFoodProperties, 'kind' | 'representedSites'>,
): Feature<Point, HumanFoodProperties> | null {
  if (feature.geometry?.type !== 'Point') return null;
  return {
    type: 'Feature',
    geometry: feature.geometry,
    properties: {
      kind: 'human-food-location',
      representedSites: 1,
      ...properties,
    },
  };
}

function normalizeUsfsFeature(
  feature: Feature<Geometry, SourceProperties>,
) {
  const properties = feature.properties ?? {};
  const name = propertyString(properties, 'site_name');
  if (!name) return null;
  return humanFoodFeature(feature, {
    name,
    category: propertyString(properties, 'site_type') ?? 'Campground',
    manager:
      propertyString(properties, 'operated_by', 'managing_org') ?? 'USFS',
    source: 'USFS recreation inventory',
    updated: normalizedDate(
      properties.edw_last_modify ?? properties.infra_last_update,
    ),
    capacity: propertyNumber(properties, 'total_capacity'),
    usageLevel: propertyString(properties, 'usage_level'),
    status: propertyString(
      properties,
      'seasonal_operational_status',
      'open_season',
    ),
    reservable: null,
    url: safeUrl(properties.rec1stop_url),
  });
}

function normalizeBlmFeature(
  feature: Feature<Geometry, SourceProperties>,
) {
  const properties = feature.properties ?? {};
  const name = propertyString(properties, 'FacilityName');
  if (!name) return null;
  return humanFoodFeature(feature, {
    name,
    category:
      propertyString(properties, 'FacilityTypeDescription') ?? 'Campground',
    manager: 'BLM',
    source: 'BLM recreation inventory',
    updated: normalizedDate(properties.LastUpdatedDate),
    capacity: null,
    usageLevel: null,
    status: null,
    reservable: reservableLabel(properties.Reservable),
    url:
      safeUrl(properties.BLMFacURL) ??
      safeUrl(properties.FacilityReservationURL),
  });
}

function normalizeCpwCampgroundFeature(
  feature: Feature<Geometry, SourceProperties>,
) {
  const properties = feature.properties ?? {};
  const name = propertyString(properties, 'Name', 'CGPropertyName');
  if (!name) return null;
  return humanFoodFeature(feature, {
    name,
    category: 'Campground',
    manager: propertyString(properties, 'Manager') ?? 'Unknown manager',
    source: 'CPW Hunting Atlas campground inventory',
    updated: normalizedDate(properties.DataLastUpdate),
    capacity: propertyNumber(properties, 'CGNumSites'),
    usageLevel: null,
    status: null,
    reservable: reservableLabel(properties.CGReservable),
    url: safeUrl(properties.URL1) ?? safeUrl(properties.URL2),
  });
}

function normalizeSwaCampsites(collection: SourceCollection) {
  const groups = new Map<
    string,
    {
      count: number;
      longitude: number;
      latitude: number;
      properties: HumanFoodProperties;
    }
  >();

  for (const feature of collection.features) {
    if (feature.geometry?.type !== 'Point') continue;
    const properties = feature.properties ?? {};
    const name = propertyString(properties, 'PROPNAME');
    if (!name) continue;
    const [longitude, latitude] = feature.geometry.coordinates;
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.longitude += longitude;
      existing.latitude += latitude;
      existing.properties.representedSites += 1;
      continue;
    }
    groups.set(key, {
      count: 1,
      longitude,
      latitude,
      properties: {
        kind: 'human-food-location',
        name,
        category: 'SWA campsite',
        manager: propertyString(properties, 'MGMT_AUTH') ?? 'CPW',
        source: 'CPW SWA facility inventory',
        updated: normalizedDate(properties.COLL_DATE),
        capacity: propertyNumber(properties, 'SITE_COUNT'),
        usageLevel: null,
        status: propertyString(properties, 'TYPE_DETAIL'),
        reservable: null,
        url: null,
        representedSites: 1,
      },
    });
  }

  return Array.from(groups.values(), (group) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [
        group.longitude / group.count,
        group.latitude / group.count,
      ],
    },
    properties: group.properties,
  }));
}

function dedupeHumanFoodFeatures(
  features: Feature<Point, HumanFoodProperties>[],
) {
  const seen = new Set<string>();
  return features.filter((feature) => {
    const [longitude, latitude] = feature.geometry.coordinates;
    const name = feature.properties.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const key = `${name}:${longitude.toFixed(2)}:${latitude.toFixed(2)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeHumanFoodSources(sources: {
  usfs?: SourceCollection;
  blm?: SourceCollection;
  cpwCampgrounds?: SourceCollection;
  cpwSwaCampsites?: SourceCollection;
}) {
  const normalized = [
    ...(sources.usfs?.features.map(normalizeUsfsFeature) ?? []),
    ...(sources.blm?.features.map(normalizeBlmFeature) ?? []),
    ...(sources.cpwCampgrounds?.features.map(normalizeCpwCampgroundFeature) ?? []),
    ...(sources.cpwSwaCampsites
      ? normalizeSwaCampsites(sources.cpwSwaCampsites)
      : []),
  ].filter(
    (feature): feature is Feature<Point, HumanFoodProperties> =>
      feature !== null,
  );

  return dedupeHumanFoodFeatures(normalized);
}

function normalizeAreaFeatures(
  collection: SourceCollection | undefined,
  kind: BearAreaKind,
  source: string,
) {
  if (!collection) return [];
  return collection.features.flatMap((feature) => {
    if (
      feature.geometry?.type !== 'Polygon' &&
      feature.geometry?.type !== 'MultiPolygon'
    ) {
      return [];
    }
    return [
      {
        type: 'Feature' as const,
        geometry: feature.geometry,
        properties: {
          kind,
          source,
          updated: normalizedDate(feature.properties?.EDIT_DATE),
        },
      },
    ];
  });
}

export function normalizeBearAreaSources(sources: {
  fallConcentration?: SourceCollection;
  humanConflict?: SourceCollection;
}) {
  return [
    ...normalizeAreaFeatures(
      sources.fallConcentration,
      'fall-concentration',
      'CPW Species Activity Mapping',
    ),
    ...normalizeAreaFeatures(
      sources.humanConflict,
      'human-conflict',
      'CPW Species Activity Mapping',
    ),
  ] as Feature<Polygon | MultiPolygon, BearAreaProperties>[];
}

export function isFeatureCollection(value: unknown): value is SourceCollection {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SourceCollection>;
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features);
}
