'use client';

import type { FeatureCollection, Geometry } from 'geojson';
import type {
  Map as MapLibreMap,
  MapGeoJSONFeature,
  MapMouseEvent,
} from 'maplibre-gl';
import type {
  DataDrivenPropertyValueSpecification,
  StyleSpecification,
} from '@maplibre/maplibre-gl-style-spec';
import { useEffect, useRef, useState } from 'react';
import { CURRENT_DROUGHT_RASTER_TILES } from '@/lib/bear-intel';
import type { LicenseRecord } from '@/lib/license-types';
import type {
  BearCautionMode,
  BearTargetCollection,
  BearTargetFeature,
} from '@/lib/bear-targets';
import {
  addBearAreaLayers,
  addHumanFoodLayers,
  BEAR_AREA_QUERY,
  fetchIntelCollection,
  HUMAN_FOOD_MAP_LAYERS,
  HUMAN_FOOD_QUERY,
  type MapIntelCollection,
} from './bear-map-layers';
import MapLayerMenu, {
  type IntelStatus,
  type MapLayerKey,
  type MapLayerState,
} from './map-layer-menu';
import {
  addOrUpdateBearTargetLayers,
  BEAR_TARGET_INTERACTIVE_LAYERS,
  BEAR_TARGET_LAYER_IDS,
  setBearCautionMode,
  setBearTargetSelection,
} from './bear-target-map-layers';
import 'maplibre-gl/dist/maplibre-gl.css';

type HuntMapProps = {
  analysisMode: boolean;
  cautionMode: BearCautionMode;
  hunts: LicenseRecord[];
  onSelectGmu: (gmu: number) => void;
  onSelectTarget: (targetId: string) => void;
  selectedGmu: number | null;
  selectedTarget: BearTargetFeature | null;
  targetCollection: BearTargetCollection | null;
};

const GMU_QUERY =
  'https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas/HuntingAtlas_Base_Map/MapServer/93/query?where=1%3D1&outFields=GMUID%2CCOUNTY%2CDEERDAU%2CELKDAU%2CANTDAU%2CMOOSEDAU%2CBEARDAU&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.001&f=geojson';
const HUNTING_ATLAS_EXPORT =
  'https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas/HuntingAtlas_Base_Map/MapServer/export';

function atlasRasterTiles(layerIds: string) {
  return [
    `${HUNTING_ATLAS_EXPORT}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true&layers=show%3A${layerIds}&f=image`,
  ];
}

function setLayerVisibility(
  map: MapLibreMap,
  layerIds: readonly string[],
  visible: boolean,
) {
  for (const layerId of layerIds) {
    if (map.getLayer(layerId)) {
      map.setLayoutProperty(
        layerId,
        'visibility',
        visible ? 'visible' : 'none',
      );
    }
  }
}

async function fetchSavedTripModel(signal: AbortSignal) {
  const response = await fetch('/data/be012o1r-targets.geojson', { signal });
  if (!response.ok) throw new Error('Saved trip model did not load');
  return (await response.json()) as BearTargetCollection;
}

function savedGmuCollection(collection: BearTargetCollection) {
  return {
    type: 'FeatureCollection' as const,
    features: collection.features
      .filter((feature) => feature.properties.kind === 'hunt-boundary')
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          GMUID: Number(feature.properties.gmu),
        },
      })),
  } as FeatureCollection<Geometry>;
}

function savedAreaCollection(collection: BearTargetCollection) {
  return {
    type: 'FeatureCollection' as const,
    features: collection.features.filter(
      (feature) => feature.properties.kind === 'human-conflict',
    ),
    metadata: {
      warnings: ['Offline snapshot: live forage source unavailable'],
    },
  } as MapIntelCollection;
}

function savedFoodCollection(collection: BearTargetCollection) {
  return {
    type: 'FeatureCollection' as const,
    features: collection.features
      .filter((feature) => feature.properties.kind === 'source-member')
      .map((feature) => ({
        ...feature,
        properties: {
          ...feature.properties,
          kind: 'human-food-location',
          source:
            typeof feature.properties.inventory === 'string'
              ? feature.properties.inventory
              : 'Saved trip model',
          representedSites: 1,
        },
      })),
    metadata: { warnings: ['Offline snapshot: trip-area sources only'] },
  } as MapIntelCollection;
}

export default function HuntMap({
  analysisMode,
  cautionMode,
  hunts,
  onSelectGmu,
  onSelectTarget,
  selectedGmu,
  selectedTarget,
  targetCollection,
}: HuntMapProps) {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [layers, setLayers] = useState<MapLayerState>({
    access: false,
    forage: false,
    humanFood: false,
    land: false,
  });
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [intelStatus, setIntelStatus] = useState<IntelStatus>('loading');
  const [networkAvailable, setNetworkAvailable] = useState(true);

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    const controller = new AbortController();

    async function mountMap() {
      const maplibregl = await import('maplibre-gl');
      if (disposed || !mapNode.current) return;

      let forcedOffline = false;
      try {
        const response = await fetch('/api/runtime', {
          cache: 'no-store',
          signal: controller.signal,
        });
        if (response.ok) {
          const runtime = (await response.json()) as { offline?: boolean };
          forcedOffline = runtime.offline === true;
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
      }
      const hasNetwork = window.navigator.onLine && !forcedOffline;
      setNetworkAvailable(hasNetwork);
      const style: StyleSpecification = hasNetwork
        ? {
            version: 8,
            glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
            sources: {
              'open-street-map': {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution:
                  '&copy; OpenStreetMap contributors · Colorado GMUs: CPW',
              },
              'usgs-imagery': {
                type: 'raster',
                tiles: [
                  'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
                ],
                tileSize: 256,
                maxzoom: 16,
                attribution: 'Aerial imagery: USGS The National Map / NAIP',
              },
              'current-drought': {
                type: 'raster',
                tiles: CURRENT_DROUGHT_RASTER_TILES,
                tileSize: 256,
                attribution: 'Current drought: U.S. Drought Monitor / FEMA',
              },
              'cpw-land-management': {
                type: 'raster',
                tiles: atlasRasterTiles('103'),
                tileSize: 256,
                attribution: 'Land management: CPW / COMaP',
              },
              'cpw-public-access': {
                type: 'raster',
                tiles: atlasRasterTiles('101%2C102'),
                tileSize: 256,
                attribution: 'Public access and Walk-In Access: CPW',
              },
            },
            layers: [
              {
                id: 'base-map',
                type: 'raster',
                source: 'open-street-map',
                paint: {
                  'raster-saturation': -0.78,
                  'raster-contrast': 0.08,
                  'raster-brightness-max': 0.93,
                },
              },
              {
                id: 'target-imagery',
                type: 'raster',
                source: 'usgs-imagery',
                layout: { visibility: 'none' },
                paint: {
                  'raster-saturation': -0.12,
                  'raster-contrast': 0.16,
                  'raster-brightness-min': 0.04,
                  'raster-brightness-max': 0.82,
                },
              },
              {
                id: 'drought-stress-overlay',
                type: 'raster',
                source: 'current-drought',
                layout: { visibility: 'none' },
                paint: { 'raster-opacity': 0.26 },
              },
              {
                id: 'land-management-overlay',
                type: 'raster',
                source: 'cpw-land-management',
                layout: { visibility: 'none' },
                paint: { 'raster-opacity': 0.7 },
              },
              {
                id: 'public-access-overlay',
                type: 'raster',
                source: 'cpw-public-access',
                layout: { visibility: 'none' },
                paint: { 'raster-opacity': 0.88 },
              },
            ],
          }
        : {
            version: 8,
            sources: {
              'offline-usgs-topo': {
                type: 'raster',
                tiles: ['/data/offline-topo/{z}/{x}/{y}.jpg'],
                tileSize: 256,
                minzoom: 7,
                maxzoom: 14,
                attribution:
                  'Map services and data available from U.S. Geological Survey, National Geospatial Program.',
              },
            },
            layers: [
              {
                id: 'offline-background',
                type: 'background',
                paint: { 'background-color': '#dce3d5' },
              },
              {
                id: 'offline-usgs-topo',
                type: 'raster',
                source: 'offline-usgs-topo',
                paint: {
                  'raster-saturation': -0.08,
                  'raster-contrast': 0.08,
                  'raster-brightness-max': 0.93,
                },
              },
            ],
          };

      const map = new maplibregl.Map({
        container: mapNode.current,
        center: [-105.58, 38.98],
        zoom: 5.65,
        minZoom: 4.8,
        maxZoom: 17,
        attributionControl: false,
        style,
      });

      mapRef.current = map;
      resizeObserver = new ResizeObserver(() => map.resize());
      resizeObserver.observe(mapNode.current);
      map.addControl(
        new maplibregl.NavigationControl({ showCompass: false }),
        'top-right',
      );
      map.addControl(
        new maplibregl.AttributionControl({ compact: true }),
        'bottom-right',
      );

      map.on('load', async () => {
        try {
          let data: FeatureCollection<Geometry> | null = null;
          if (hasNetwork) {
            try {
              const response = await fetch(GMU_QUERY, {
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(3_000),
                ]),
              });
              if (!response.ok) throw new Error('GMU service did not respond');
              data = (await response.json()) as FeatureCollection<Geometry>;
            } catch (error) {
              if ((error as Error).name === 'AbortError') throw error;
              setNetworkAvailable(false);
            }
          }
          const savedModel = data
            ? null
            : await fetchSavedTripModel(controller.signal);
          data ??= savedGmuCollection(savedModel!);
          if (disposed) return;

          map.addSource('colorado-gmus', {
            type: 'geojson',
            data,
            generateId: true,
          });
          map.addLayer({
            id: 'gmu-fill',
            type: 'fill',
            source: 'colorado-gmus',
            paint: { 'fill-color': '#d66b35', 'fill-opacity': 0.09 },
          });
          map.addLayer({
            id: 'gmu-outline',
            type: 'line',
            source: 'colorado-gmus',
            paint: {
              'line-color': '#203f31',
              'line-opacity': 0.72,
              'line-width': 1.2,
            },
          });
          if (hasNetwork) {
            map.addLayer({
              id: 'gmu-labels',
              type: 'symbol',
              source: 'colorado-gmus',
              minzoom: 6.3,
              layout: {
                'text-field': ['to-string', ['get', 'GMUID']],
                'text-size': 11,
                'text-font': ['Open Sans Semibold'],
              },
              paint: {
                'text-color': '#173326',
                'text-halo-color': '#f4f0e7',
                'text-halo-width': 1.5,
              },
            });
          }

          const onMapClick = (event: MapMouseEvent) => {
            const targetLayers = BEAR_TARGET_INTERACTIVE_LAYERS.filter(
              (layerId) => map.getLayer(layerId),
            );
            if (
              targetLayers.length &&
              map.queryRenderedFeatures(event.point, { layers: targetLayers })
                .length
            ) {
              return;
            }
            const intelLayers = HUMAN_FOOD_MAP_LAYERS.filter((layerId) =>
              map.getLayer(layerId),
            );
            if (
              intelLayers.length &&
              map.queryRenderedFeatures(event.point, { layers: intelLayers })
                .length
            ) {
              return;
            }
            const [feature] = map.queryRenderedFeatures(event.point, {
              layers: ['gmu-fill'],
            });
            const gmu = Number(feature?.properties?.GMUID);
            if (Number.isFinite(gmu)) onSelectGmu(gmu);
          };
          map.on('click', onMapClick);
          map.on('mouseenter', 'gmu-fill', () => {
            map.getCanvas().style.cursor = 'pointer';
          });
          map.on('mouseleave', 'gmu-fill', () => {
            map.getCanvas().style.cursor = '';
          });

          setMapStatus('ready');
          void (async () => {
            let areaResult: PromiseSettledResult<MapIntelCollection>;
            let foodResult: PromiseSettledResult<MapIntelCollection>;
            if (hasNetwork) {
              [areaResult, foodResult] = await Promise.allSettled([
                fetchIntelCollection(BEAR_AREA_QUERY, controller.signal),
                fetchIntelCollection(HUMAN_FOOD_QUERY, controller.signal),
              ]);
              if (
                areaResult.status === 'rejected' ||
                foodResult.status === 'rejected'
              ) {
                const localModel = await fetchSavedTripModel(controller.signal);
                if (areaResult.status === 'rejected') {
                  areaResult = {
                    status: 'fulfilled',
                    value: savedAreaCollection(localModel),
                  };
                }
                if (foodResult.status === 'rejected') {
                  foodResult = {
                    status: 'fulfilled',
                    value: savedFoodCollection(localModel),
                  };
                }
                setNetworkAvailable(false);
              }
            } else {
              const localModel = savedModel ??
                (await fetchSavedTripModel(controller.signal));
              areaResult = {
                status: 'fulfilled',
                value: savedAreaCollection(localModel),
              };
              foodResult = {
                status: 'fulfilled',
                value: savedFoodCollection(localModel),
              };
            }
            if (disposed) return;
            let loadedSources = 0;
            let warningCount = 0;

            if (areaResult.status === 'fulfilled') {
              loadedSources += 1;
              warningCount += areaResult.value.metadata?.warnings?.length ?? 0;
              addBearAreaLayers(map, areaResult.value);
            } else {
              warningCount += 1;
            }

            if (foodResult.status === 'fulfilled') {
              loadedSources += 1;
              warningCount += foodResult.value.metadata?.warnings?.length ?? 0;
              addHumanFoodLayers(map, maplibregl, foodResult.value);
            } else {
              warningCount += 1;
            }

            setIntelStatus(
              loadedSources === 0
                ? 'error'
                : warningCount > 0
                  ? 'partial'
                  : 'ready',
            );
          })().catch((error) => {
            if (!disposed && (error as Error).name !== 'AbortError') {
              setIntelStatus('error');
            }
          });
        } catch (error) {
          if (!disposed && (error as Error).name !== 'AbortError') {
            setMapStatus('ready');
            setIntelStatus('error');
          }
        }
      });
    }

    void mountMap().catch((error) => {
      if (!disposed && (error as Error).name !== 'AbortError') {
        setMapStatus('error');
        setIntelStatus('error');
      }
    });
    return () => {
      disposed = true;
      controller.abort();
      resizeObserver?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [onSelectGmu]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapStatus !== 'ready' || !targetCollection) return;

    addOrUpdateBearTargetLayers(map, targetCollection);
    setBearCautionMode(map, cautionMode);

    const onTargetClick = (
      event: MapMouseEvent & { features?: MapGeoJSONFeature[] },
    ) => {
      const targetId = event.features?.[0]?.properties?.targetId;
      if (typeof targetId === 'string') onSelectTarget(targetId);
    };
    const showPointer = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const clearPointer = () => {
      map.getCanvas().style.cursor = '';
    };

    for (const layerId of BEAR_TARGET_INTERACTIVE_LAYERS) {
      map.on('click', layerId, onTargetClick);
      map.on('mouseenter', layerId, showPointer);
      map.on('mouseleave', layerId, clearPointer);
    }

    return () => {
      for (const layerId of BEAR_TARGET_INTERACTIVE_LAYERS) {
        map.off('click', layerId, onTargetClick);
        map.off('mouseenter', layerId, showPointer);
        map.off('mouseleave', layerId, clearPointer);
      }
    };
  }, [cautionMode, mapStatus, onSelectTarget, targetCollection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('bear-corridors')) return;
    setBearCautionMode(map, cautionMode);
  }, [cautionMode, mapStatus, targetCollection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setLayerVisibility(map, ['target-imagery'], analysisMode);
    setLayerVisibility(map, BEAR_TARGET_LAYER_IDS, analysisMode);
  }, [analysisMode, mapStatus, targetCollection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('bear-source-points')) return;
    const targetId = selectedTarget?.properties.targetId ?? null;
    setBearTargetSelection(map, targetId);
    if (!analysisMode || !selectedTarget) return;
    map.flyTo({
      center: selectedTarget.geometry.coordinates as [number, number],
      zoom: Math.max(map.getZoom(), 10.2),
      duration: 900,
      essential: true,
    });
  }, [analysisMode, mapStatus, selectedTarget]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('gmu-fill')) return;
    if (analysisMode) {
      map.setPaintProperty('gmu-fill', 'fill-opacity', 0.012);
      return;
    }
    const units = Array.from(new Set(hunts.flatMap((hunt) => hunt.units)));
    const matchingOpacity = units.length
      ? ['match', ['get', 'GMUID'], units, 0.38, 0.055]
      : 0.055;
    const fillOpacity = (
      selectedGmu === null
        ? matchingOpacity
        : [
            'case',
            ['==', ['get', 'GMUID'], selectedGmu],
            0.58,
            matchingOpacity,
          ]
    ) as DataDrivenPropertyValueSpecification<number>;
    map.setPaintProperty(
      'gmu-fill',
      'fill-opacity',
      fillOpacity,
    );
  }, [analysisMode, hunts, mapStatus, selectedGmu]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    setLayerVisibility(map, ['public-access-overlay'], layers.access);
    setLayerVisibility(map, ['land-management-overlay'], layers.land);
    setLayerVisibility(map, ['drought-stress-overlay'], layers.forage);
    setLayerVisibility(
      map,
      ['bear-fall-concentration-fill', 'bear-fall-concentration-outline'],
      layers.forage,
    );
    setLayerVisibility(
      map,
      ['bear-human-conflict-fill', 'bear-human-conflict-outline'],
      layers.humanFood,
    );
    setLayerVisibility(map, HUMAN_FOOD_MAP_LAYERS, layers.humanFood);
  }, [intelStatus, layers, mapStatus]);

  function changeLayer(layer: MapLayerKey, visible: boolean) {
    setLayers((current) => ({ ...current, [layer]: visible }));
  }

  const proxySummary = layers.forage && layers.humanFood
    ? 'Green marks CPW fall-use habitat under the weekly drought overlay. Purple areas show CPW conflict history; orange points show developed camping.'
    : layers.forage
      ? 'Green marks CPW fall-use habitat; the weekly drought overlay adds current vegetation-stress context, not measured mast abundance.'
      : 'Purple areas show CPW conflict history; orange points show developed camping, not verified garbage access.';
  const cautionLabel = cautionMode === 'rule-screen'
    ? 'mapped 150 yd rule screen'
    : cautionMode === 'quarter-mile'
      ? '0.25 mi caution edge'
      : '0.5 mi caution edge';

  return (
    <section
      className={analysisMode ? 'map-panel map-panel-targeting' : 'map-panel'}
      aria-label={analysisMode ? 'BE012O1R bear target map' : 'Colorado game management unit map'}
    >
      <div className="map-toolbar">
        <div className="map-toolbar-title">
          <span className="map-kicker">
            {analysisMode
              ? 'BE012O1R · human-food model'
              : 'Colorado · 186 big-game units'}
          </span>
          <strong>
            {analysisMode
              ? selectedTarget
                ? `#${selectedTarget.properties.rank} · ${selectedTarget.properties.name}`
                : 'Conflict-linked security routes'
              : selectedGmu !== null
                ? `GMU ${selectedGmu}`
                : 'Statewide view'}
          </strong>
        </div>
        <div className="map-toolbar-actions">
          <MapLayerMenu
            intelStatus={intelStatus}
            layers={layers}
            networkAvailable={networkAvailable}
            onChange={changeLayer}
          />
          <span className={`map-status map-status-${mapStatus}`}>
            {mapStatus === 'loading' && 'Loading map…'}
            {mapStatus === 'ready' &&
              (!networkAvailable
                ? 'Offline · saved topo + model loaded'
                : analysisMode
                  ? 'Human-food model loaded'
                  : 'Map layers live')}
            {mapStatus === 'error' && 'Map unavailable'}
          </span>
        </div>
      </div>
      <div className="map-wrap">
        <div className="map-canvas" ref={mapNode} />
        {(analysisMode || layers.forage || layers.humanFood) && (
          <aside className="map-proxy-note" aria-label="Bear proxy explanation">
            <strong>
              {analysisMode ? 'Lead, not bear probability' : 'Proxy, not a live bear map'}
            </strong>
            <span>
              {analysisMode
                ? `Mint routes stop at the ${cautionLabel}; coral dashes retain the analysis-only continuation to the attraction footprint.`
                : proxySummary}
            </span>
          </aside>
        )}
        <div className="map-legend">
          {analysisMode ? (
            <>
              <span><i className="legend-conflict" /> CPW historical conflict</span>
              <span><i className="legend-target" /> Source-cluster label</span>
              <span><i className="legend-source-area" /> Attraction footprint</span>
              <span><i className="legend-security" /> Security option</span>
              <span><i className="legend-corridor" /> Near-optimal corridor band</span>
              <span><i className="legend-corridor-inner" /> Analysis-only inner route</span>
              <span><i className="legend-source-portal" /> Modeled arrival portal</span>
              <span><i className="legend-legal-exclusion" /> Mapped 150 yd rule screen</span>
              {cautionMode !== 'rule-screen' && (
                <span><i className="legend-source-buffer" /> {cautionLabel}</span>
              )}
              <span><i className="legend-road-exclusion" /> Road no-shot screen</span>
              <span><i className="legend-access-exclusion" /> Private / unknown access</span>
            </>
          ) : (
            <>
              <span><i className="legend-fill" /> Matching hunt unit</span>
              <span><i className="legend-line" /> CPW GMU boundary</span>
            </>
          )}
          {layers.forage && (
            <>
              <span><i className="legend-forage" /> CPW fall-use habitat</span>
              <span><i className="legend-drought" /> Weekly drought stress</span>
            </>
          )}
          {layers.humanFood && (
            <>
              <span><i className="legend-conflict" /> CPW conflict history</span>
              <span><i className="legend-human-food" /> Developed camping</span>
            </>
          )}
          {layers.access && <span><i className="legend-access" /> CPW / Walk-In access</span>}
          {layers.land && <span><i className="legend-land" /> Land management</span>}
        </div>
        <div className="map-hint">
          {analysisMode ? 'Choose a source, then compare its A–E security routes' : 'Click a unit to filter licenses'}
        </div>
      </div>
      <footer className="map-footer">
        <span>
          Planning aid only — verify the current CPW brochure, property rules,
          closures, discharge restrictions and land ownership.
        </span>
        <nav aria-label="Official Colorado hunting resources">
          <a href="https://cpw.widen.net/s/n62qtjdsbw/biggame" target="_blank" rel="noreferrer">2026 brochure ↗</a>
          <a href="https://ndismaps.nrel.colostate.edu/index.html" target="_blank" rel="noreferrer">Hunting Atlas ↗</a>
        </nav>
      </footer>
    </section>
  );
}
