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
          <span className="target-code">BE012O1R · 30 m human-food model</span>
          <strong>{targets.length} conflict-linked sources</strong>
          <small>{securityOptions.length} behavior-informed corridor options</small>
        </div>
        <a className="gpx-button" href="/data/be012o1r-targets.gpx" download>
          GPX ↓
        </a>
        <p>
          Compare two to five security areas and their night/dawn route ensembles.
          Each corridor stops at the half-mile source caution ring.
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
                      <strong>Movement corridors</strong>
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
                              {detail.distanceMiles.toFixed(1)} mi to source · {detail.routeMiles.toFixed(1)} mi to {detail.sourceBufferMiles.toFixed(1)} mi ring · GMU {detail.gmu}
                            </small>
                            <span>
                              Security {detail.securityScore} · cover {detail.routeCover} · drainage {detail.routeDrainage} · road exposure {detail.roadExposure}
                            </span>
                            <span>
                              Night/dawn agreement {detail.routeAgreement}% · {detail.ensembleRoutes} paths · {detail.publicPercent}% federal land along representative line
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
                    Corridor bands may cross private land. The caution ring is an
                    analysis guardrail, not a legal boundary.
                  </p>
                </div>
              )}
            </article>
          );
        })}
        <p className="target-method-note">
          Bands combine night approach, dawn return, and perturbed near-optimal paths
          on a 30 m grid. They express uncertainty—not observed bear trails.
        </p>
        <details className="target-method">
          <summary>Model assumptions &amp; cost function</summary>
          <div>
            <p>
              Lower cost means easier modeled travel. Both scenarios favor drainage
              <code>−0.34</code>, draws <code>−0.25</code>, saddles <code>−0.20</code>,
              benches <code>−0.18</code>, and mapped refuge habitat <code>−0.16</code>;
              they penalize exposed ridges <code>+0.62</code> and slope exertion
              <code>+0.50</code>.
            </p>
            <p>
              Night applies lighter disturbance costs. Dawn increases the penalties
              for canopy gaps, trails, roads, and development. Water and 50° slopes
              are strong barriers. All terms are relative 0–1 surfaces, so the
              coefficients are comparisons—not probabilities.
            </p>
            <p className="target-method-warning">
              These are transparent, literature-informed weights, not coefficients
              fitted to local telemetry. Fresh sign and current food still decide
              whether a band deserves field time.
            </p>
            <nav aria-label="Black bear movement evidence">
              <a
                href="https://digitalcommons.unl.edu/icwdm_usdanwrc/1698/"
                target="_blank"
                rel="noreferrer"
              >
                Development selection ↗
              </a>
              <a
                href="https://pmc.ncbi.nlm.nih.gov/articles/PMC3885671/"
                target="_blank"
                rel="noreferrer"
              >
                Food-year behavior ↗
              </a>
              <a
                href="https://www.bearbiology.org/download/response-of-american-black-bears-to-the-non-motorized-expansion-of-a-road-corridor-in-grand-teton-national-park/"
                target="_blank"
                rel="noreferrer"
              >
                Covered crossings ↗
              </a>
            </nav>
          </div>
        </details>
        {warnings.length > 0 && (
          <p className="target-source-warning">
            Build note: {warnings.join('; ')}. CPW, BLM, and SWA source inventories still loaded.
          </p>
        )}
      </div>
    </>
  );
}
