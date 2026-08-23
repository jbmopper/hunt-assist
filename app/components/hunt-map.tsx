'use client';

import type { FeatureCollection, Geometry } from 'geojson';
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useRef, useState } from 'react';
import type { LicenseRecord } from '@/lib/license-types';
import 'maplibre-gl/dist/maplibre-gl.css';

type HuntMapProps = {
  hunts: LicenseRecord[];
  onSelectGmu: (gmu: number) => void;
  selectedGmu: number | null;
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

export default function HuntMap({
  hunts,
  onSelectGmu,
  selectedGmu,
}: HuntMapProps) {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [showAccess, setShowAccess] = useState(false);
  const [showLand, setShowLand] = useState(false);
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;
    const controller = new AbortController();

    async function mountMap() {
      const maplibregl = await import('maplibre-gl');
      if (disposed || !mapNode.current) return;

      const map = new maplibregl.Map({
        container: mapNode.current,
        center: [-105.58, 38.98],
        zoom: 5.65,
        minZoom: 4.8,
        maxZoom: 13,
        attributionControl: false,
        style: {
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
        },
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
          const response = await fetch(GMU_QUERY, { signal: controller.signal });
          if (!response.ok) throw new Error('GMU service did not respond');
          const data = (await response.json()) as FeatureCollection<Geometry>;
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
            paint: {
              'fill-color': '#d66b35',
              'fill-opacity': 0.09,
            },
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

          const onMapClick = (event: MapMouseEvent) => {
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
        } catch (error) {
          if (!disposed && (error as Error).name !== 'AbortError') {
            setMapStatus('error');
          }
        }
      });
    }

    void mountMap().catch((error) => {
      if (!disposed && (error as Error).name !== 'AbortError') {
        setMapStatus('error');
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
    if (!map?.getLayer('gmu-fill')) return;
    const units = Array.from(new Set(hunts.flatMap((hunt) => hunt.units)));
    const matchingOpacity = units.length
      ? (['match', ['get', 'GMUID'], units, 0.38, 0.055] as const)
      : 0.055;
    map.setPaintProperty(
      'gmu-fill',
      'fill-opacity',
      selectedGmu === null
        ? matchingOpacity
        : [
            'case',
            ['==', ['get', 'GMUID'], selectedGmu],
            0.58,
            matchingOpacity,
          ],
    );
  }, [hunts, mapStatus, selectedGmu]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('public-access-overlay')) return;
    map.setLayoutProperty(
      'public-access-overlay',
      'visibility',
      showAccess ? 'visible' : 'none',
    );
    map.setLayoutProperty(
      'land-management-overlay',
      'visibility',
      showLand ? 'visible' : 'none',
    );
  }, [mapStatus, showAccess, showLand]);

  return (
    <section className="map-panel" aria-label="Colorado game management unit map">
      <div className="map-toolbar">
        <div className="map-toolbar-title">
          <span className="map-kicker">Colorado · 186 big-game units</span>
          <strong>{selectedGmu ? `GMU ${selectedGmu}` : 'Statewide view'}</strong>
        </div>
        <div className="map-toolbar-actions">
          <div className="layer-switches" aria-label="Map layers">
            <button
              className={showAccess ? 'layer-button layer-button-active' : 'layer-button'}
              type="button"
              onClick={() => setShowAccess((value) => !value)}
              aria-pressed={showAccess}
            >
              CPW access
            </button>
            <button
              className={showLand ? 'layer-button layer-button-active' : 'layer-button'}
              type="button"
              onClick={() => setShowLand((value) => !value)}
              aria-pressed={showLand}
            >
              Land manager
            </button>
          </div>
          <span className={`map-status map-status-${mapStatus}`}>
            {mapStatus === 'loading' && 'Loading CPW boundaries…'}
            {mapStatus === 'ready' && 'CPW layers live'}
            {mapStatus === 'error' && 'Boundary layer unavailable'}
          </span>
        </div>
      </div>
      <div className="map-wrap">
        <div className="map-canvas" ref={mapNode} />
        <div className="map-legend">
          <span><i className="legend-fill" /> Matching hunt unit</span>
          <span><i className="legend-line" /> CPW GMU boundary</span>
          {showAccess && <span><i className="legend-access" /> CPW / Walk-In access</span>}
          {showLand && <span><i className="legend-land" /> Land management</span>}
        </div>
        <div className="map-hint">Click a unit to filter licenses</div>
      </div>
      <footer className="map-footer">
        <span>Planning aid only — always verify the current CPW brochure, license, closures, and land ownership.</span>
        <nav aria-label="Official Colorado hunting resources">
          <a href="https://cpw.widen.net/s/n62qtjdsbw/biggame" target="_blank" rel="noreferrer">2026 brochure ↗</a>
          <a href="https://ndismaps.nrel.colostate.edu/index.html" target="_blank" rel="noreferrer">Hunting Atlas ↗</a>
        </nav>
      </footer>
    </section>
  );
}
