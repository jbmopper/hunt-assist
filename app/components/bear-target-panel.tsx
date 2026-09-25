'use client';

import { useState } from 'react';
import CampPlanning from './camp-planning';
import type {
  BearCautionMode,
  BearSecurityFeature,
  BearSourceAreaFeature,
  BearTargetFeature,
} from '@/lib/bear-targets';

type BearTargetPanelProps = {
  cautionMode: BearCautionMode;
  error: string | null;
  onChangeCautionMode: (mode: BearCautionMode) => void;
  onSelectTarget: (targetId: string) => void;
  securityOptions: BearSecurityFeature[];
  selectedTargetId: string | null;
  sourceAreas: BearSourceAreaFeature[];
  targets: BearTargetFeature[];
  warnings: string[];
};

export default function BearTargetPanel({
  cautionMode,
  error,
  onChangeCautionMode,
  onSelectTarget,
  securityOptions,
  selectedTargetId,
  sourceAreas,
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
          <strong>{targets.length} conflict-linked source clusters</strong>
          <small>{securityOptions.length} behavior-informed corridor options</small>
        </div>
        <a className="gpx-button" href="/data/be012o1r-targets.gpx" download>
          GPX ↓
        </a>
        <p>
          Every cluster keeps its contributing records and mapped attraction
          patches. Choose where the outer corridor stops; the remaining modeled
          approach stays visible as a coral, analysis-only line.
        </p>
        <fieldset className="caution-selector">
          <legend>Approach boundary</legend>
          {([
            ['rule-screen', 'Rule screen', '≈150 yd'],
            ['quarter-mile', '0.25 mi', 'caution'],
            ['half-mile', '0.5 mi', 'caution'],
          ] as const).map(([mode, label, detail]) => (
            <label key={mode}>
              <input
                checked={cautionMode === mode}
                name="bear-caution-mode"
                onChange={() => onChangeCautionMode(mode)}
                type="radio"
              />
              <span>
                <strong>{label}</strong>
                <small>{detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="caution-selector-note">
          The red rule screen is a conservative map constraint, not proof of the
          true facility boundary or every applicable order.
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
                    <span>
                      {properties.sourceFootprintAcres} acres · {properties.sourceFootprintParts}{' '}
                      {properties.sourceFootprintParts === 1 ? 'patch' : 'patches'}
                    </span>
                  </div>

                  <details className="source-records">
                    <summary>
                      {properties.sourceCount} contributing source record{properties.sourceCount === 1 ? '' : 's'}
                      {properties.sourceExtentMiles > 0
                        ? ` across ${properties.sourceExtentMiles.toFixed(1)} mi`
                        : ''}
                    </summary>
                    <ul>
                      {properties.sourceMembers.map((member, index) => (
                        <li key={`${member.name}-${member.inventory}-${index}`}>
                          <strong>{member.name}</strong>
                          <span>{member.category} · {member.manager} · {member.inventory}</span>
                        </li>
                      ))}
                    </ul>
                  </details>

                  <div className="target-reasons">
                    <strong>Why this source surfaced</strong>
                    <ul>
                      {[properties.reason1, properties.reason2, properties.reason3].map(
                        (reason) => <li key={reason}>{reason}</li>,
                      )}
                    </ul>
                  </div>

                  <CampPlanning
                    sourceArea={sourceAreas.find(
                      (area) => area.properties.targetId === target.properties.targetId,
                    )}
                    target={target}
                  />

                  <section className="security-options" aria-label="Modeled security routes">
                    <div className="security-options-heading">
                      <strong>Movement corridors</strong>
                      <span>{options.length} options</span>
                    </div>
                    {options.map((option) => {
                      const detail = option.properties;
                      const activeApproach = detail.approachProfiles?.[cautionMode] ?? {
                        label: cautionMode === 'rule-screen'
                          ? 'Mapped rule screen'
                          : cautionMode === 'quarter-mile'
                            ? '0.25 mi caution'
                            : '0.5 mi caution',
                        boundaryMiles: detail.approachDistanceMiles,
                        outerRouteMiles: detail.routeMiles,
                        innerRouteMiles: detail.innerRouteMiles ?? 0,
                        portalCount: detail.portalCount,
                      };
                      return (
                        <article className="security-option" key={detail.securityId}>
                          <span className="security-option-label">{detail.optionLabel}</span>
                          <div className="security-option-copy">
                            <strong>{detail.name.replace(/^H\d{2}[A-E] · /, '')}</strong>
                            <small>
                              {detail.distanceMiles.toFixed(1)} mi to source footprint · {activeApproach.outerRouteMiles.toFixed(1)} mi outer + {activeApproach.innerRouteMiles.toFixed(1)} mi inner · GMU {detail.gmu}
                            </small>
                            <span>
                              Security {detail.securityScore} · cover {detail.routeCover} · drainage {detail.routeDrainage} · road exposure {detail.roadExposure}
                            </span>
                            <span>
                              Night/dawn agreement {detail.routeAgreement}% · {activeApproach.label} · {activeApproach.portalCount} portal{activeApproach.portalCount === 1 ? '' : 's'} toward {detail.arrivalSource} · {detail.publicPercent}% federal land
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
                    Attraction patches are hypotheses, and corridor bands may cross
                    private land. Red facility, road, and private/unknown screens are
                    stop-and-verify warnings, not a complete legal determination.
                  </p>
                </div>
              )}
            </article>
          );
        })}
        <p className="target-method-note">
          Each path can choose any reachable source patch. Bands combine night,
          dawn, and perturbed solutions; portals move with the selected boundary.
          Coral dashes show the same modeled path inside that boundary for analysis,
          never as a setup or shot recommendation.
        </p>
        <details className="target-method">
          <summary>Regulation &amp; access screens</summary>
          <div>
            <p>
              The red facility screen uses the federal 150-yard discharge distance
              around the modeled attraction footprint. That federal rule applies on
              National Forest System lands; other sites can have different property
              or local rules. Because the inventories provide points rather than
              surveyed boundaries, treat it as conservative screening—not a measured
              legal line.
            </p>
            <p>
              Red road ribbons approximate Colorado&apos;s 50-foot roadside restriction
              on the 30 m grid. Purple areas are the BLM&apos;s limited-scale
              <em> Private or Unknown</em> class and are treated as closed until a
              current parcel source and permission say otherwise. Temporary orders
              are not spatially complete in this file.
            </p>
            <p className="target-method-warning">
              Verify the exact campsite/occupied-area edge, road classification,
              ownership, property rules, fire restrictions, and current closures in
              the field. The rule-screen option is not a legal safe harbor.
            </p>
            <nav aria-label="Official hunting and discharge rules">
              <a
                href="https://www.ecfr.gov/current/title-36/chapter-II/part-261/subpart-A/section-261.10"
                target="_blank"
                rel="noreferrer"
              >
                Federal discharge rule ↗
              </a>
              <a
                href="https://cpw.state.co.us/sites/default/files/dam/nucdborcsb/ch-w0-as-approved-march-2026.pdf"
                target="_blank"
                rel="noreferrer"
              >
                2026 Colorado rules ↗
              </a>
              <a
                href="https://www.fs.usda.gov/r02/whiteriver/alerts"
                target="_blank"
                rel="noreferrer"
              >
                Current forest alerts ↗
              </a>
            </nav>
          </div>
        </details>
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
              for canopy gaps, trails, roads, and development. The destination is
              whichever attraction patch produces the lowest cumulative cost. Water
              and 50° slopes are strong barriers. All terms are relative 0–1
              surfaces, so the coefficients are comparisons—not probabilities.
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
