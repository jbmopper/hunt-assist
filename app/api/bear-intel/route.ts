import type { FeatureCollection, Geometry } from 'geojson';
import {
  BEAR_INTEL_SOURCE_URLS,
  isFeatureCollection,
  normalizeBearAreaSources,
  normalizeHumanFoodSources,
  type IntelFeatureCollection,
} from '@/lib/bear-intel';

export const dynamic = 'force-dynamic';

type IntelLayer = 'areas' | 'human-food';
type CachedCollection = IntelFeatureCollection<Geometry, Record<string, unknown>>;

const SOURCE_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;
const cache = new Map<
  IntelLayer,
  { expiresAt: number; collection: CachedCollection }
>();

async function fetchCollection(url: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/geo+json, application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`source responded with ${response.status}`);
    }
    const data = (await response.json()) as unknown;
    if (!isFeatureCollection(data)) {
      throw new Error('source did not return a GeoJSON FeatureCollection');
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function settledSources<T extends Record<string, string>>(sources: T) {
  const entries = Object.entries(sources);
  const results = await Promise.allSettled(
    entries.map(([, url]) => fetchCollection(url)),
  );
  const values: Record<string, FeatureCollection<Geometry, Record<string, unknown>>> = {};
  const loaded: string[] = [];
  const warnings: string[] = [];

  results.forEach((result, index) => {
    const name = entries[index][0];
    if (result.status === 'fulfilled') {
      values[name] = result.value;
      loaded.push(name);
    } else {
      warnings.push(`${name} unavailable`);
      console.warn(`Bear intelligence source ${name} unavailable`, result.reason);
    }
  });

  return { loaded, values, warnings };
}

async function buildAreaCollection(): Promise<CachedCollection> {
  const result = await settledSources({
    fallConcentration: BEAR_INTEL_SOURCE_URLS.fallConcentration,
    humanConflict: BEAR_INTEL_SOURCE_URLS.humanConflict,
  });
  if (result.loaded.length === 0) {
    throw new Error('No CPW bear-area source responded');
  }
  return {
    type: 'FeatureCollection',
    features: normalizeBearAreaSources({
      fallConcentration: result.values.fallConcentration,
      humanConflict: result.values.humanConflict,
    }),
    metadata: {
      generatedAt: new Date().toISOString(),
      sources: result.loaded,
      warnings: result.warnings,
    },
  };
}

async function buildHumanFoodCollection(): Promise<CachedCollection> {
  const result = await settledSources({
    usfs: BEAR_INTEL_SOURCE_URLS.usfsCampgrounds,
    blm: BEAR_INTEL_SOURCE_URLS.blmCampgrounds,
    cpwCampgrounds: BEAR_INTEL_SOURCE_URLS.cpwCampgrounds,
    cpwSwaCampsites: BEAR_INTEL_SOURCE_URLS.cpwSwaCampsites,
  });
  if (result.loaded.length === 0) {
    throw new Error('No developed-camping source responded');
  }
  return {
    type: 'FeatureCollection',
    features: normalizeHumanFoodSources({
      usfs: result.values.usfs,
      blm: result.values.blm,
      cpwCampgrounds: result.values.cpwCampgrounds,
      cpwSwaCampsites: result.values.cpwSwaCampsites,
    }),
    metadata: {
      generatedAt: new Date().toISOString(),
      sources: result.loaded,
      warnings: result.warnings,
    },
  };
}

async function getCollection(layer: IntelLayer, forceRefresh: boolean) {
  const cached = cache.get(layer);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.collection;
  }
  const collection = layer === 'areas'
    ? await buildAreaCollection()
    : await buildHumanFoodCollection();
  cache.set(layer, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    collection,
  });
  return collection;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const layer = url.searchParams.get('layer');
  if (layer !== 'areas' && layer !== 'human-food') {
    return Response.json(
      { error: 'layer must be areas or human-food' },
      { status: 400 },
    );
  }

  try {
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const collection = await getCollection(layer, forceRefresh);
    return Response.json(collection, {
      headers: {
        'Cache-Control': forceRefresh
          ? 'no-store'
          : 'public, max-age=900, stale-while-revalidate=21600',
      },
    });
  } catch (error) {
    console.error(`Unable to load ${layer} bear intelligence`, error);
    return Response.json(
      { error: 'Bear intelligence data is temporarily unavailable.' },
      { status: 502 },
    );
  }
}
