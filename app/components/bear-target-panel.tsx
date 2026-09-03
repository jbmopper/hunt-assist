'use client';

import { useState } from 'react';
import type {
  BearSecurityFeature,
  BearTargetFeature,
} from '@/lib/bear-targets';

type BearTargetPanelProps = {
  error: string | null;
  onSelectTarget: (targetId: string) => void;
  securityOptions: BearSecurityFeature[];
  selectedTargetId: string | null;
  targets: BearTargetFeature[];
  warnings: string[];
};

export default function BearTargetPanel({
  error,
  onSelectTarget,
  securityOptions,
  selectedTargetId,
  targets,
  warnings,
}: BearTargetPanelProps) {
  const [copiedOption, setCopiedOption] = useState<string | null>(null);

  async function copyCoordinates(option: BearSecurityFeature) {
    const { latitude, longitude, securityId } = option.properties;
    try {
      await navigator.clipboard.writeText(
        `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
      );
      setCopiedOption(securityId);
      window.setTimeout(() => setCopiedOption(null), 1600);
    } catch {
      setCopiedOption(null);
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
        <strong>Loading the BE012O1R human-food model…</strong>
        <span>Conflict context, developed sources, terrain, and security cover.</span>
      </div>
    );
  }

  return (
    <>
      <section className="target-summary">
        <div>
          <span className="target-code">BE012O1R · Human-food model</span>
          <strong>{targets.length} conflict-linked sources</strong>
          <small>{securityOptions.length} modeled public-land security options</small>
        </div>
        <a className="gpx-button" href="/data/be012o1r-targets.gpx" download>
          GPX ↓
        </a>
        <p>
          Rank the human-food hypothesis first, then inspect two to five routes
          leading back to security cover. Source markers are context—not setup locations.
        </p>
      </section>

      <div className="target-list" aria-live="polite">
        {targets.map((target) => {
          const properties = target.properties;
          const selected = properties.targetId === selectedTargetId;
          const options = securityOptions.filter(
            (option) => option.properties.targetId === properties.targetId,
          );
          const conflictLabel = properties.conflictDistanceMiles === 0
            ? 'Inside historical conflict area'
            : `${properties.conflictDistanceMiles.toFixed(1)} mi from conflict area`;
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
                  <strong>{properties.name}</strong>
                  <small>
                    {properties.sourceCategory} · GMU {properties.gmu}
                  </small>
                </span>
                <span className="target-score">
                  <strong>{properties.relativeScore}</strong>
                  <small>priority</small>
                </span>
              </button>

              {selected && (
                <div className="target-card-detail">
                  <div className="target-terrain-line">
                    <span>{conflictLabel}</span>
                    <span>{properties.sourceCount} source record{properties.sourceCount === 1 ? '' : 's'}</span>
                  </div>

                  <div className="target-reasons">
                    <strong>Why this source surfaced</strong>
                    <ul>
                      {[properties.reason1, properties.reason2, properties.reason3].map(
                        (reason) => <li key={reason}>{reason}</li>,
                      )}
                    </ul>
                  </div>

                  <section className="security-options" aria-label="Modeled security routes">
                    <div className="security-options-heading">
                      <strong>Security routes</strong>
                      <span>{options.length} options</span>
                    </div>
                    {options.map((option) => {
                      const detail = option.properties;
                      return (
                        <article className="security-option" key={detail.securityId}>
                          <span className="security-option-label">{detail.optionLabel}</span>
                          <div className="security-option-copy">
                            <strong>{detail.name.replace(/^H\d{2}[A-E] · /, '')}</strong>
                            <small>
                              {detail.distanceMiles.toFixed(1)} mi direct · {detail.routeMiles.toFixed(1)} mi route · GMU {detail.gmu}
                            </small>
                            <span>
                              Security {detail.securityScore} · cover {detail.cover} · pressure {detail.pressure}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => void copyCoordinates(option)}
                            aria-label={`Copy coordinates for security option ${detail.optionLabel}`}
                          >
                            {copiedOption === detail.securityId ? 'Copied' : 'Copy'}
                          </button>
                        </article>
                      );
                    })}
                  </section>

                  <p className="target-caveat">
                    Context only: {properties.caveat1}. {properties.caveat2}.
                    Route lines may cross private land and require parcel-level verification.
                  </p>
                </div>
              )}
            </article>
          );
        })}
        <p className="target-method-note">
          CPW conflict polygons are historical area mapping, not incident counts or
          current sightings. Require current food or fresh sign before committing time.
        </p>
        {warnings.length > 0 && (
          <p className="target-source-warning">
            Build note: {warnings.join('; ')}. CPW, BLM, and SWA source inventories still loaded.
          </p>
        )}
      </div>
    </>
  );
}
