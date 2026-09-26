'use client';

import { useEffect, useRef, useState } from 'react';

export type IntelStatus = 'error' | 'loading' | 'partial' | 'ready';
export type MapLayerKey = 'access' | 'forage' | 'humanFood' | 'land';
export type MapLayerState = Record<MapLayerKey, boolean>;

type MapLayerMenuProps = {
  intelStatus: IntelStatus;
  layers: MapLayerState;
  networkAvailable: boolean;
  onChange: (layer: MapLayerKey, visible: boolean) => void;
};

export default function MapLayerMenu({
  intelStatus,
  layers,
  networkAvailable,
  onChange,
}: MapLayerMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', closeOnOutsidePress);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', closeOnOutsidePress);
    };
  }, [open]);

  const activeCount = Object.values(layers).filter(Boolean).length;

  return (
    <div className="map-layer-control" ref={menuRef}>
      <button
        className={
          open || activeCount
            ? 'layer-menu-button layer-menu-button-active'
            : 'layer-menu-button'
        }
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="map-layer-menu"
      >
        Layers
        {activeCount > 0 && (
          <span className="map-layer-count">{activeCount}</span>
        )}
      </button>
      {open && (
        <div
          className="map-layer-menu"
          id="map-layer-menu"
          aria-label="Map layer controls"
        >
          <div className="map-layer-menu-header">
            <div>
              <strong>Map layers</strong>
              <span>Combine access, habitat and pressure context.</span>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close map layers"
            >
              ×
            </button>
          </div>
          <fieldset className="map-layer-group">
            <legend>Access</legend>
            <label className="map-layer-row">
              <span>
                <strong>CPW access</strong>
                <small>Public properties and Walk-In Access.</small>
              </span>
              <input
                type="checkbox"
                checked={layers.access}
                onChange={(event) => onChange('access', event.target.checked)}
                disabled={!networkAvailable}
              />
            </label>
            <label className="map-layer-row">
              <span>
                <strong>Land manager</strong>
                <small>BLM, USFS, state and private context.</small>
              </span>
              <input
                type="checkbox"
                checked={layers.land}
                onChange={(event) => onChange('land', event.target.checked)}
                disabled={!networkAvailable}
              />
            </label>
          </fieldset>
          <fieldset className="map-layer-group map-layer-group-bear">
            <legend>Bear intelligence</legend>
            <label className="map-layer-row">
              <span>
                <strong>Fall forage proxy</strong>
                <small>
                  CPW fall concentration + weekly drought stress. Not a berry
                  or acorn count.
                </small>
              </span>
              <input
                type="checkbox"
                checked={layers.forage}
                onChange={(event) => onChange('forage', event.target.checked)}
                disabled={intelStatus === 'error'}
              />
            </label>
            <label className="map-layer-row">
              <span>
                <strong>Human-food exposure</strong>
                <small>
                  Developed camping + CPW conflict history. Not verified
                  unsecured garbage.
                </small>
              </span>
              <input
                type="checkbox"
                checked={layers.humanFood}
                onChange={(event) =>
                  onChange('humanFood', event.target.checked)
                }
                disabled={intelStatus === 'error'}
              />
            </label>
            <span className={`intel-source-status intel-source-${intelStatus}`}>
              {intelStatus === 'loading' && 'Loading bear proxy sources…'}
              {intelStatus === 'ready' && 'All proxy sources loaded'}
              {intelStatus === 'partial' &&
                'Loaded with a partial source fallback'}
              {intelStatus === 'error' && 'Bear proxy sources unavailable'}
            </span>
            {!networkAvailable && (
              <span className="intel-source-status intel-source-partial">
                Offline: using the saved trip model; remote basemap, drought,
                CPW access, and land-manager tiles are unavailable.
              </span>
            )}
          </fieldset>
          <p className="map-layer-caveat">
            These layers rank places to investigate. They do not establish
            current bear presence, legal access or a lawful shooting location.
          </p>
        </div>
      )}
    </div>
  );
}
