import {
  CAMP_PLANNING_RULES,
  getCampPlan,
} from '@/lib/camp-planning';
import type {
  BearSourceAreaFeature,
  BearTargetFeature,
} from '@/lib/bear-targets';

type CampPlanningProps = {
  sourceArea: BearSourceAreaFeature | undefined;
  target: BearTargetFeature;
};

const FIT_LABELS = {
  preferred: 'Preferred',
  conditional: 'Conditional',
  'fallback-only': 'Fallback only',
} as const;

export default function CampPlanning({ sourceArea, target }: CampPlanningProps) {
  const plan = getCampPlan(target, sourceArea);
  if (!plan) return null;

  return (
    <section className="camp-planning" aria-label="Tent camping assessment">
      <div className="camp-planning-heading">
        <div>
          <strong>Tent-camping base</strong>
          <span>Legal site · bear storage · bait separation · Tesla access</span>
        </div>
        <span className="camp-mode-badge">tent + car</span>
      </div>
      <p>{plan.summary}</p>

      <div className="camp-candidates">
        {plan.candidates.map((candidate) => (
          <article className={`camp-candidate camp-candidate-${candidate.fit}`} key={candidate.id}>
            <div className="camp-candidate-topline">
              <strong>{candidate.name}</strong>
              <span>{FIT_LABELS[candidate.fit]}</span>
            </div>
            <div className="camp-candidate-facts">
              <span>{candidate.kind.replace('-', ' ')}</span>
              <span>{candidate.legalStatus} legality</span>
              <span>{candidate.wetRoadRisk} wet-road risk</span>
              <span>
                {candidate.distanceToSourceMiles === null
                  ? 'separation needs a pin'
                  : candidate.sourceRelationship === 'source-overlap'
                    ? 'overlaps modeled source'
                    : `${candidate.distanceToSourceMiles.toFixed(1)} mi from source footprint`}
              </span>
            </div>
            <dl>
              <div>
                <dt>Camp</dt>
                <dd>{candidate.legalBasis}</dd>
              </div>
              <div>
                <dt>Food</dt>
                <dd>{candidate.foodStorage}</dd>
              </div>
              <div>
                <dt>Road</dt>
                <dd>{candidate.access}</dd>
              </div>
            </dl>
            {candidate.reasons.length > 0 && (
              <ul>
                {candidate.reasons.map((reason) => <li key={reason}>{reason}</li>)}
              </ul>
            )}
            <nav aria-label={`${candidate.name} sources`}>
              <a href={candidate.source.url} target="_blank" rel="noreferrer">
                {candidate.source.label} ↗
              </a>
              {candidate.bookingUrl && (
                <a href={candidate.bookingUrl} target="_blank" rel="noreferrer">
                  Check live sites ↗
                </a>
              )}
            </nav>
          </article>
        ))}
      </div>

      <details className="camp-rule-note">
        <summary>How the camp check works</summary>
        <div>
          {Object.values(CAMP_PLANNING_RULES).map((rule) => (
            <p key={rule.label}>
              <strong>{rule.label}:</strong> {rule.summary}{' '}
              <a href={rule.url} target="_blank" rel="noreferrer">Source ↗</a>
            </p>
          ))}
          <p>
            The 0.5-mile line is the app&apos;s analysis caution boundary—not a legal
            distance. A secured camp can still be a poor hunting base, and an
            unsecured attractant can still be bait regardless of distance.
          </p>
        </div>
      </details>
    </section>
  );
}
