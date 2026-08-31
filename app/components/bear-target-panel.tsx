'use client';

import { useState } from 'react';
import type { BearTargetFeature } from '@/lib/bear-targets';

type BearTargetPanelProps = {
  error: string | null;
  imageryDate: string | null;
  onSelectTarget: (targetId: string) => void;
  selectedTargetId: string | null;
  targets: BearTargetFeature[];
};

const METRICS: Array<{
  key: 'cover' | 'forage' | 'glassing' | 'pinch' | 'pressure' | 'travel';
  label: string;
}> = [
  { key: 'forage', label: 'Forage' },
  { key: 'cover', label: 'Food → cover' },
  { key: 'travel', label: 'Travel' },
  { key: 'pinch', label: 'Pinch' },
  { key: 'glassing', label: 'Glassing' },
  { key: 'pressure', label: 'Pressure' },
];

function formatDate(value: string | null) {
  if (!value) return 'imagery unavailable';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${value}T12:00:00Z`));
}

export default function BearTargetPanel({
  error,
  imageryDate,
  onSelectTarget,
  selectedTargetId,
  targets,
}: BearTargetPanelProps) {
  const [copiedTarget, setCopiedTarget] = useState<string | null>(null);

  async function copyCoordinates(target: BearTargetFeature) {
    const { latitude, longitude, targetId } = target.properties;
    try {
      await navigator.clipboard.writeText(
        `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      );
      setCopiedTarget(targetId);
      window.setTimeout(() => setCopiedTarget(null), 1600);
    } catch {
      setCopiedTarget(null);
    }
  }

  if (error) {
    return (
      <div className="target-empty">
        <strong>Target analysis unavailable.</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!targets.length) {
    return (
      <div className="target-empty">
        <strong>Loading the BE012O1R shortlist…</strong>
        <span>Terrain, vegetation, access, and pressure context.</span>
      </div>
    );
  }

  return (
    <>
      <section className="target-summary">
        <div>
          <span className="target-code">BE012O1R · Sep 2–30</span>
          <strong>{targets.length} desk-scouting leads</strong>
          <small>Late-summer imagery through {formatDate(imageryDate)}</small>
        </div>
        <a className="gpx-button" href="/data/be012o1r-targets.gpx" download>
          GPX ↓
        </a>
        <p>
          Each lead connects a possible food edge to secure cover through a
          modeled corridor. Scores compare this hunt area only.
        </p>
      </section>

      <div className="target-list" aria-live="polite">
        {targets.map((target) => {
          const properties = target.properties;
          const selected = properties.targetId === selectedTargetId;
          return (
            <article
              className={selected ? 'target-card target-card-active' : 'target-card'}
              key={properties.targetId}
            >
              <button
                className="target-card-select"
                type="button"
                onClick={() => onSelectTarget(properties.targetId)}
                aria-pressed={selected}
              >
                <span className="target-rank">{properties.rank}</span>
                <span className="target-card-heading">
                  <strong>{properties.nearbyFeature}</strong>
                  <small>
                    {properties.sector} · GMU {properties.gmu}
                  </small>
                </span>
                <span className="target-score">
                  <strong>{properties.relativeScore}</strong>
                  <small>/ 100</small>
                </span>
              </button>

              {selected && (
                <div className="target-card-detail">
                  <div className="target-terrain-line">
                    <span>{properties.elevationFt.toLocaleString()} ft</span>
                    <span>{properties.slopeDegrees}° slope</span>
                    <span>{properties.aspect}° aspect</span>
                  </div>

                  <div className="target-metrics" aria-label="Model components">
                    {METRICS.map((metric) => {
                      const value = properties[metric.key];
                      return (
                        <div className="target-metric" key={metric.key}>
                          <span>
                            {metric.label} <strong>{value}</strong>
                          </span>
                          <i>
                            <b style={{ width: `${value}%` }} />
                          </i>
                        </div>
                      );
                    })}
                  </div>

                  <div className="target-reasons">
                    <strong>Why it surfaced</strong>
                    <ul>
                      {[properties.reason1, properties.reason2, properties.reason3].map(
                        (reason) => <li key={reason}>{reason}</li>,
                      )}
                    </ul>
                  </div>

                  <p className="target-vegetation">{properties.vegetation}</p>
                  <p className="target-caveat">
                    Ground-truth first: {properties.caveat1}; {properties.caveat2}.
                  </p>

                  <div className="target-actions">
                    <button
                      type="button"
                      onClick={() => void copyCoordinates(target)}
                    >
                      {copiedTarget === properties.targetId
                        ? 'Copied coordinates'
                        : `${properties.latitude.toFixed(5)}, ${properties.longitude.toFixed(5)}`}
                    </button>
                    <span>Map fit {properties.deskScore}/5</span>
                  </div>
                </div>
              )}
            </article>
          );
        })}
        <p className="target-method-note">
          A high rank is a place to investigate—not a bear probability or a
          substitute for fresh sign, current food, legal access, wind, and a safe shot.
        </p>
      </div>
    </>
  );
}
