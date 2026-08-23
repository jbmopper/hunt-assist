'use client';

import type { FeatureCollection, Geometry } from 'geojson';
import type { Map as MapLibreMap, MapMouseEvent } from 'maplibre-gl';
import { useEffect, useMemo, useRef, useState } from 'react';
import 'maplibre-gl/dist/maplibre-gl.css';

type Species =
  | 'All'
  | 'Elk'
  | 'Deer'
  | 'Pronghorn'
  | 'Black bear'
  | 'Turkey'
  | 'Moose'
  | 'Mountain goat'
  | 'Bighorn sheep'
  | 'Other';

type Hunt = {
  access: 'Public + private' | 'Private land only';
  code: string;
  description: string;
  list: string;
  method: string;
  methodCode: string;
  quota: number;
  residency: 'Everyone' | 'Nonresident only' | 'Resident only';
  season: string;
  seasonCode: string;
  sex: string;
  species: Exclude<Species, 'All'>;
  units: number[];
};

type LicenseFeed = {
  fetchedAt: string;
  generatedAt: string | null;
  hunts: Hunt[];
  notice: string | null;
  source: {
    kind: 'leftover' | 'reissue';
    label: string;
    officialPageUrl: string;
    pdfPageUrl: string;
  };
};

type FeedState = 'loading' | 'live' | 'error';
type SourceKind = LicenseFeed['source']['kind'];
type HuntMethod = 'All' | 'A' | 'M' | 'R' | 'X';

const GMU_QUERY =
  'https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas/HuntingAtlas_Base_Map/MapServer/93/query?where=1%3D1&outFields=GMUID%2CCOUNTY%2CDEERDAU%2CELKDAU%2CANTDAU%2CMOOSEDAU%2CBEARDAU&returnGeometry=true&outSR=4326&geometryPrecision=4&maxAllowableOffset=0.001&f=geojson';
const HUNTING_ATLAS_EXPORT =
  'https://ndismaps.nrel.colostate.edu/arcgis/rest/services/HuntingAtlas/HuntingAtlas_Base_Map/MapServer/export';

function atlasRasterTiles(layerIds: string) {
  return [
    `${HUNTING_ATLAS_EXPORT}?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&dpi=96&format=png32&transparent=true&layers=show%3A${layerIds}&f=image`,
  ];
}

const sampleHunts: Hunt[] = [
  {
    code: 'EF011O4R',
    species: 'Elk',
    sex: 'Cow',
    method: 'Rifle · 4th season',
    methodCode: 'R',
    units: [11, 12, 13, 23, 24, 211],
    quota: 1544,
    season: '11/18/2026 - 11/22/2026',
    seasonCode: '4',
    access: 'Public + private',
    description: '',
    list: 'A',
    residency: 'Everyone',
  },
  {
    code: 'BE034O1R',
    species: 'Black bear',
    sex: 'Either sex',
    method: 'Rifle · September',
    methodCode: 'R',
    units: [34],
    quota: 167,
    season: '09/02/2026 - 09/30/2026',
    seasonCode: '1',
    access: 'Public + private',
    description: '',
    list: 'B',
    residency: 'Everyone',
  },
  {
    code: 'DE104O3M',
    species: 'Deer',
    sex: 'Antlerless · whitetail',
    method: 'Muzzleloader',
    methodCode: 'M',
    units: [104, 105, 106],
    quota: 11,
    season: '10/10/2026 - 10/18/2026',
    seasonCode: '3',
    access: 'Public + private',
    description: 'WHITETAIL ONLY',
    list: 'A',
    residency: 'Everyone',
  },
  {
    code: 'AF106O1R',
    species: 'Pronghorn',
    sex: 'Doe',
    method: 'Rifle',
    methodCode: 'R',
    units: [106],
    quota: 111,
    season: '10/03/2026 - 10/11/2026',
    seasonCode: '1',
    access: 'Public + private',
    description: '',
    list: 'B',
    residency: 'Everyone',
  },
  {
    code: 'EE015P3R',
    species: 'Elk',
    sex: 'Cow',
    method: 'Rifle · 3rd season',
    methodCode: 'R',
    units: [15],
    quota: 16,
    season: '11/07/2026 - 11/15/2026',
    seasonCode: '3',
    access: 'Private land only',
    description: 'PRIVATE LAND ONLY',
    list: 'A',
    residency: 'Everyone',
  },
];

const speciesOptions: Species[] = [
  'All',
  'Elk',
  'Deer',
  'Pronghorn',
  'Black bear',
  'Turkey',
  'Moose',
  'Mountain goat',
  'Bighorn sheep',
];
const methodOptions: Array<{ code: HuntMethod; label: string }> = [
  { code: 'All', label: 'All' },
  { code: 'A', label: 'Archery' },
  { code: 'M', label: 'Muzzleloader' },
  { code: 'R', label: 'Rifle' },
  { code: 'X', label: 'Special' },
];

const OFFICIAL_LIST_URL =
  'https://cpw.state.co.us/activities/hunting/big-game/leftover-remaining-and-reissued-licenses';
const SAVED_HUNTS_KEY = 'colorado-hunt-finder:saved-codes';
const INITIAL_VISIBLE_HUNTS = 60;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatSeason(value: string) {
  return value.replace(
    /(\d{2})\/(\d{2})\/(\d{4})/g,
    (_, month: string, day: string, year: string) =>
      `${MONTHS[Number(month) - 1]} ${Number(day)}${year === '2026' ? '' : ` ’${year.slice(2)}`}`,
  );
}

function formatSourceTime(value: string | null) {
  if (!value) return null;
  return value.replace(/:\d{2} (AM|PM)/, ' $1').replace(' 2026 ', ', ');
}

function MountainMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <span className="brand-peak brand-peak-left" />
      <span className="brand-peak brand-peak-right" />
    </span>
  );
}

export default function HuntPlanner() {
  const mapNode = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [species, setSpecies] = useState<Species>('All');
  const [huntMethod, setHuntMethod] = useState<HuntMethod>('All');
  const [publicOnly, setPublicOnly] = useState(false);
  const [savedOnly, setSavedOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedGmu, setSelectedGmu] = useState<number | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>('leftover');
  const [hunts, setHunts] = useState<Hunt[]>(sampleHunts);
  const [feedState, setFeedState] = useState<FeedState>('loading');
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pdfPageUrl, setPdfPageUrl] = useState<string | null>(null);
  const [usingSample, setUsingSample] = useState(true);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [savedCodes, setSavedCodes] = useState<string[]>([]);
  const [savedReady, setSavedReady] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(INITIAL_VISIBLE_HUNTS);
  const [showAccess, setShowAccess] = useState(false);
  const [showLand, setShowLand] = useState(false);
  const [mapStatus, setMapStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );

  const availableSpecies = useMemo(
    () =>
      speciesOptions.filter(
        (option) => option === 'All' || hunts.some((hunt) => hunt.species === option),
      ),
    [hunts],
  );
  const availableMethods = useMemo(
    () =>
      methodOptions.filter(
        (option) =>
          option.code === 'All' ||
          option.code === huntMethod ||
          hunts.some((hunt) => hunt.methodCode === option.code),
      ),
    [huntMethod, hunts],
  );

  const filteredHunts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return hunts.filter((hunt) => {
      const matchesSpecies = species === 'All' || hunt.species === species;
      const matchesMethod =
        huntMethod === 'All' || hunt.methodCode === huntMethod;
      const matchesAccess =
        !publicOnly || hunt.access === 'Public + private';
      const matchesGmu = selectedGmu === null || hunt.units.includes(selectedGmu);
      const matchesSaved = !savedOnly || savedCodes.includes(hunt.code);
      const matchesQuery =
        !normalizedQuery ||
        hunt.code.toLowerCase().includes(normalizedQuery) ||
        hunt.units.some((unit) => String(unit).includes(normalizedQuery)) ||
        hunt.description.toLowerCase().includes(normalizedQuery) ||
        hunt.method.toLowerCase().includes(normalizedQuery) ||
        hunt.sex.toLowerCase().includes(normalizedQuery) ||
        hunt.residency.toLowerCase().includes(normalizedQuery);
      return (
        matchesSpecies &&
        matchesMethod &&
        matchesAccess &&
        matchesGmu &&
        matchesSaved &&
        matchesQuery
      );
    });
  }, [huntMethod, hunts, publicOnly, query, savedCodes, savedOnly, selectedGmu, species]);

  const visibleHunts = filteredHunts.slice(0, visibleLimit);
  const activeFilterCount = [
    species !== 'All',
    huntMethod !== 'All',
    publicOnly,
    savedOnly,
  ].filter(Boolean).length;

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      try {
        const stored = window.localStorage.getItem(SAVED_HUNTS_KEY);
        const values = stored ? (JSON.parse(stored) as unknown) : [];
        if (Array.isArray(values)) {
          setSavedCodes(
            values.filter((value): value is string => typeof value === 'string'),
          );
        }
      } catch {
        // A malformed or unavailable local store should not stop license research.
      } finally {
        setSavedReady(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!savedReady) return;
    try {
      window.localStorage.setItem(SAVED_HUNTS_KEY, JSON.stringify(savedCodes));
    } catch {
      // Saving is a convenience; private browsing may prevent local persistence.
    }
  }, [savedCodes, savedReady]);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [filtersOpen]);

  useEffect(() => {
    const controller = new AbortController();

    async function loadFeed() {
      try {
        const refresh = refreshCounter > 0 ? '&refresh=1' : '';
        const response = await fetch(
          `/api/licenses?source=${sourceKind}${refresh}`,
          {
            cache: refreshCounter > 0 ? 'no-store' : 'default',
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error('CPW feed did not respond');
        const feed = (await response.json()) as LicenseFeed;
        if (!Array.isArray(feed.hunts)) throw new Error('CPW feed was malformed');

        setHunts(feed.hunts);
        setGeneratedAt(feed.generatedAt);
        setNotice(feed.notice);
        setPdfPageUrl(feed.source.pdfPageUrl);
        setUsingSample(false);
        setFeedState('live');
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        setFeedState('error');
      }
    }

    void loadFeed();
    return () => controller.abort();
  }, [refreshCounter, sourceKind]);

  function chooseSource(nextSource: SourceKind) {
    if (nextSource === sourceKind) return;
    setFeedState('loading');
    setGeneratedAt(null);
    setNotice(null);
    setPdfPageUrl(null);
    setUsingSample(nextSource === 'leftover');
    setHunts(nextSource === 'leftover' ? sampleHunts : []);
    setSourceKind(nextSource);
    setSpecies('All');
    setHuntMethod('All');
    setFiltersOpen(false);
    setSelectedGmu(null);
    setVisibleLimit(INITIAL_VISIBLE_HUNTS);
  }

  function refreshFeed() {
    setFeedState('loading');
    setRefreshCounter((value) => value + 1);
  }

  function toggleSaved(code: string) {
    setSavedCodes((current) =>
      current.includes(code)
        ? current.filter((savedCode) => savedCode !== code)
        : [...current, code],
    );
  }

  function resetHuntFilters() {
    setSpecies('All');
    setHuntMethod('All');
    setPublicOnly(false);
    setSavedOnly(false);
    setVisibleLimit(INITIAL_VISIBLE_HUNTS);
  }

  useEffect(() => {
    if (!mapNode.current || mapRef.current) return;

    let disposed = false;

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
          const response = await fetch(GMU_QUERY);
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
            if (Number.isFinite(gmu)) {
              setSelectedGmu(gmu);
              setVisibleLimit(INITIAL_VISIBLE_HUNTS);
            }
          };
          map.on('click', onMapClick);
          map.on('mouseenter', 'gmu-fill', () => {
            map.getCanvas().style.cursor = 'pointer';
          });
          map.on('mouseleave', 'gmu-fill', () => {
            map.getCanvas().style.cursor = '';
          });
          setMapStatus('ready');
        } catch {
          setMapStatus('error');
        }
      });
    }

    void mountMap();
    return () => {
      disposed = true;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.getLayer('gmu-fill')) return;
    const units = Array.from(new Set(filteredHunts.flatMap((hunt) => hunt.units)));
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
  }, [filteredHunts, mapStatus, selectedGmu]);

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

  const sourceTime = formatSourceTime(generatedAt);
  const feedLabel =
    feedState === 'loading'
      ? 'Refreshing CPW data…'
      : feedState === 'error'
        ? usingSample
          ? 'CPW unavailable · sample shown'
          : 'CPW feed unavailable'
        : sourceTime
          ? `CPW list · ${sourceTime}`
          : 'CPW list is current';

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Colorado Hunt Finder home">
          <MountainMark />
          <span>
            <strong>Colorado Hunt Finder</strong>
            <small>License research + GMU scouting</small>
          </span>
        </a>
        <div className="topbar-actions">
          <span className="source-status">
            <span className={`status-dot status-dot-${feedState}`} /> {feedLabel}
          </span>
          <button
            className="refresh-button"
            type="button"
            onClick={refreshFeed}
            disabled={feedState === 'loading'}
          >
            {feedState === 'loading' ? 'Refreshing…' : 'Refresh'}
          </button>
          <a
            className="text-button"
            href={OFFICIAL_LIST_URL}
            target="_blank"
            rel="noreferrer"
          >
            Official list ↗
          </a>
        </div>
      </header>

      <div className="workspace" id="top">
        <section className="sidebar" aria-label="License finder">
          <div className="sidebar-intro">
            <p className="eyebrow">2026 Colorado licenses</p>
            <h1>Find your hunt.</h1>
          </div>

          <div className="feed-tabs" aria-label="License list">
            <button
              className={sourceKind === 'leftover' ? 'feed-tab feed-tab-active' : 'feed-tab'}
              type="button"
              onClick={() => chooseSource('leftover')}
              aria-pressed={sourceKind === 'leftover'}
            >
              Leftover
            </button>
            <button
              className={sourceKind === 'reissue' ? 'feed-tab feed-tab-active' : 'feed-tab'}
              type="button"
              onClick={() => chooseSource('reissue')}
              aria-pressed={sourceKind === 'reissue'}
            >
              Reissue preview
            </button>
          </div>

          <div className="filter-shell">
            <div className="search-filter-row">
              <label className="search-field">
                <span className="search-icon" aria-hidden="true" />
                <span className="sr-only">Search hunt code or GMU</span>
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                  }}
                  placeholder="Search code or GMU"
                />
              </label>
              <button
                className={
                  filtersOpen || activeFilterCount
                    ? 'filter-launch-button filter-launch-button-active'
                    : 'filter-launch-button'
                }
                type="button"
                onClick={() => setFiltersOpen((value) => !value)}
                aria-controls="hunt-filters"
                aria-expanded={filtersOpen}
              >
                Filters
                {activeFilterCount > 0 && (
                  <span className="filter-count">{activeFilterCount}</span>
                )}
              </button>
            </div>

            {filtersOpen && (
              <section className="filters" id="hunt-filters" aria-label="Hunt filters">
                <div className="filter-popover-header">
                  <strong>Filter hunts</strong>
                  <div>
                    <button
                      className="clear-filters-button"
                      type="button"
                      onClick={resetHuntFilters}
                      disabled={activeFilterCount === 0}
                    >
                      Reset
                    </button>
                    <button
                      className="close-filters-button"
                      type="button"
                      onClick={() => setFiltersOpen(false)}
                      aria-label="Close filters"
                    >
                      ×
                    </button>
                  </div>
                </div>

                <fieldset className="filter-group">
                  <legend>Species</legend>
                  <div className="chip-row">
                    {availableSpecies.map((option) => (
                      <button
                        className={species === option ? 'chip chip-active' : 'chip'}
                        key={option}
                        onClick={() => {
                          setSpecies(option);
                          setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                        }}
                        type="button"
                        aria-pressed={species === option}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <fieldset className="filter-group">
                  <legend>Method</legend>
                  <div className="chip-row">
                    {availableMethods.map((option) => (
                      <button
                        className={huntMethod === option.code ? 'chip chip-active' : 'chip'}
                        key={option.code}
                        onClick={() => {
                          setHuntMethod(option.code);
                          setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                        }}
                        type="button"
                        aria-pressed={huntMethod === option.code}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <label className="toggle-row">
                  <span>
                    <strong>Hide private-land-only hunts</strong>
                    <small>Keep licenses with public-land opportunity</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={publicOnly}
                    onChange={(event) => {
                      setPublicOnly(event.target.checked);
                      setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                    }}
                  />
                </label>

                <label className="toggle-row saved-filter">
                  <span>
                    <strong>Saved hunts only</strong>
                    <small>{savedCodes.length} saved on this device</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={savedOnly}
                    onChange={(event) => {
                      setSavedOnly(event.target.checked);
                      setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                    }}
                  />
                </label>

                <button
                  className="filter-done-button"
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                >
                  View {filteredHunts.length.toLocaleString()} hunts
                </button>
              </section>
            )}
          </div>

          <div className="result-heading">
            <div>
              <strong>{filteredHunts.length} matching hunts</strong>
              <span>
                {feedState === 'loading'
                  ? 'Loading the official CPW list'
                  : usingSample
                    ? 'Fallback sample — verify with CPW'
                    : sourceKind === 'leftover'
                      ? `${hunts.length} hunt codes in the current leftover list`
                      : 'Tuesday preview for Wednesday reissues'}
              </span>
            </div>
            {selectedGmu !== null && (
              <button
                className="clear-button"
                onClick={() => {
                  setSelectedGmu(null);
                  setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                }}
                type="button"
              >
                GMU {selectedGmu} ×
              </button>
            )}
          </div>

          <div className="hunt-list" aria-live="polite">
            {filteredHunts.length ? (
              <>
              {visibleHunts.map((hunt) => {
                const isSaved = savedCodes.includes(hunt.code);
                return (
                <article className="hunt-card" key={hunt.code}>
                  <div className="hunt-card-topline">
                    <span className={`species-tag species-${hunt.species.toLowerCase().replace(' ', '-')}`}>
                      {hunt.species}
                    </span>
                    <div className="card-actions">
                      <span className="quota">
                        <strong>{hunt.quota.toLocaleString()}</strong> available
                      </span>
                      <button
                        className={isSaved ? 'save-button save-button-active' : 'save-button'}
                        type="button"
                        onClick={() => toggleSaved(hunt.code)}
                        aria-pressed={isSaved}
                        aria-label={`${isSaved ? 'Remove' : 'Save'} hunt ${hunt.code}`}
                        title={`${isSaved ? 'Remove' : 'Save'} hunt ${hunt.code}`}
                      >
                        {isSaved ? '★' : '☆'}
                      </button>
                    </div>
                  </div>
                  <div className="hunt-title-row">
                    <h2>
                      <button
                        className="hunt-code-button"
                        type="button"
                        onClick={() => {
                          setQuery(hunt.code);
                          setSpecies('All');
                          setSelectedGmu(null);
                          setVisibleLimit(INITIAL_VISIBLE_HUNTS);
                        }}
                        aria-label={`Show only ${hunt.code} on the map`}
                        title="Show this hunt on the map"
                      >
                        {hunt.code} <small>map</small>
                      </button>
                    </h2>
                    <span>{formatSeason(hunt.season)}</span>
                  </div>
                  <p>{hunt.sex} · {hunt.method}</p>
                  {hunt.description && (
                    <p className="hunt-description">{hunt.description}</p>
                  )}
                  <div className="hunt-meta">
                    <span>GMU {hunt.units.join(', ')}</span>
                    <span className={hunt.access === 'Private land only' ? 'private-access' : ''}>
                      {hunt.access}
                    </span>
                  </div>
                  <div className="hunt-submeta">
                    <span>List {hunt.list || '—'}</span>
                    <span>{hunt.residency}</span>
                  </div>
                </article>
                );
              })}
              {visibleHunts.length < filteredHunts.length && (
                <button
                  className="load-more"
                  type="button"
                  onClick={() => setVisibleLimit((value) => value + INITIAL_VISIBLE_HUNTS)}
                >
                  Show {Math.min(INITIAL_VISIBLE_HUNTS, filteredHunts.length - visibleHunts.length)} more
                </button>
              )}
              </>
            ) : (
              <div className="empty-state">
                <strong>
                  {feedState === 'loading'
                    ? 'Loading CPW licenses…'
                    : notice
                      ? notice
                      : savedOnly && savedCodes.length === 0
                        ? 'No hunts saved yet.'
                        : 'No hunts match.'}
                </strong>
                <span>
                  {notice
                    ? 'CPW has not published hunt codes in this preview yet.'
                    : savedOnly && savedCodes.length === 0
                      ? 'Select the star on a hunt to keep it here.'
                      : 'Clear the GMU or broaden your filters.'}
                </span>
              </div>
            )}
            {pdfPageUrl && (
              <a className="source-pdf-link" href={pdfPageUrl} target="_blank" rel="noreferrer">
                Open the source PDF ↗
              </a>
            )}
          </div>
        </section>

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
      </div>
    </main>
  );
}
