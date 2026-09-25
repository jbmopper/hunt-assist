import type { BearTargetFeature } from './bear-targets';

export type CampFit = 'preferred' | 'conditional' | 'fallback-only';
export type CampKind = 'designated' | 'developed' | 'dispersed-corridor';
export type CampLegalStatus = 'confirmed' | 'conditional' | 'verify';

export type CampCandidate = {
  id: string;
  targetId: string;
  name: string;
  kind: CampKind;
  latitude?: number;
  longitude?: number;
  legalStatus: CampLegalStatus;
  legalBasis: string;
  access: string;
  wetRoadRisk: 'low' | 'moderate' | 'high';
  foodStorage: string;
  source: { label: string; url: string };
  bookingUrl?: string;
};

export type CampAssessment = CampCandidate & {
  distanceToSourceMiles: number | null;
  sourceRelationship: 'outside-caution' | 'inside-caution' | 'source-overlap' | 'unknown';
  fit: CampFit;
  reasons: string[];
};

export type TargetCampPlan = {
  targetId: string;
  summary: string;
  candidates: CampCandidate[];
};

export const CAMP_SOURCE_CAUTION_MILES = 0.5;

export const CAMP_PLANNING_RULES = {
  baiting: {
    label: 'CPW bear baiting rule',
    url: 'https://cpw.state.co.us/activities/hunting/big-game/hunting-bear/bear-field',
    summary:
      'There is no numeric camp-to-hunt safe harbor. Do not expose or distribute food, refuse, animal parts, salt, or other attractants, and do not hunt a bear over bait regardless of who placed it.',
  },
  food: {
    label: 'CPW living with bears guidance',
    url: 'https://cpw.state.co.us/living-bears',
    summary:
      'Food storage is evaluated separately from hunting distance. Keep food, refuse, toiletries, and cooking residue inaccessible to bears; a closed, locked hard-sided vehicle is the baseline used by this planner unless a posted order is stricter.',
  },
  access: {
    label: 'Forest Service motor vehicle use maps',
    url: 'https://www.fs.usda.gov/visit/maps',
    summary:
      'A road being mapped is not proof that a low-clearance vehicle can pass it today. Current MVUM status, signs, rut depth, water, and weather control the field decision.',
  },
} as const;

const TARGET_CAMP_PLANS: TargetCampPlan[] = [
  {
    targetId: 'target-1',
    summary:
      'Use the SWA campground for the range stop, but verify the exact camp-to-source relationship before treating it as a hunting base.',
    candidates: [
      {
        id: 'west-rifle-creek-swa-campground',
        targetId: 'target-1',
        name: 'West Rifle Creek SWA campground',
        kind: 'designated',
        legalStatus: 'conditional',
        legalBasis:
          'Camping is limited to licensed hunters during an established big-game season and the three days before and after it. Use the designated campground and obey posted property rules.',
        access:
          'County Road 252 approach with several designated parking areas. Stay on the county road and established parking/camp surfaces.',
        wetRoadRisk: 'moderate',
        foodStorage:
          'Lock all food, refuse, toiletries, and cooking gear in the hard-sided vehicle with windows fully closed whenever unattended.',
        source: {
          label: 'CPW West Rifle Creek SWA',
          url: 'https://cpw.state.co.us/state-wildlife-areas/west-rifle-creek-swa',
        },
      },
    ],
  },
  {
    targetId: 'target-2',
    summary:
      'A verified established pullout below the lake complex is the better hunting base. The developed Trappers Lake campgrounds sit inside the modeled human-food source.',
    candidates: [
      {
        id: 'lower-trappers-road-dispersed',
        targetId: 'target-2',
        name: 'Lower FR 205 / CR 8 established dispersed site',
        kind: 'dispersed-corridor',
        legalStatus: 'verify',
        legalBasis:
          'Use only a previously disturbed site where current MVUM, signs, and orders permit overnight use. Stay outside the Trappers Lake camping exclusion and developed-campground boundaries.',
        access:
          'Generally passenger-car reachable when dry; reject any spur with center-crown or rut depth that threatens the battery pan. Turn around before committing to a muddy section.',
        wetRoadRisk: 'high',
        foodStorage:
          'Keep the tent free of food and scented items. Lock every attractant and all refuse in the vehicle when unattended; clean cooking residue before leaving camp.',
        source: {
          label: 'Flat Tops Wilderness order',
          url: 'https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd1164097.pdf',
        },
      },
      {
        id: 'shepherds-rim-developed',
        targetId: 'target-2',
        name: 'Shepherds Rim / Bucks developed campground',
        kind: 'developed',
        latitude: 39.994722,
        longitude: -107.242778,
        legalStatus: 'confirmed',
        legalBasis:
          'Developed campground; use an assigned or first-come site according to the individual campground rules and live availability.',
        access:
          'CR 8 and FR 205 are the official campground approach. Suitable for ordinary vehicles when dry, but the long gravel approach can become muddy.',
        wetRoadRisk: 'high',
        foodStorage:
          'Use the site bear locker when supplied; otherwise lock attractants and refuse in the vehicle. Do not leave coolers or cooking residue exposed.',
        source: {
          label: 'USFS Bucks Campground',
          url: 'https://www.fs.usda.gov/r02/whiteriver/recreation/trappers-lake-bucks-campground',
        },
        bookingUrl: 'https://www.recreation.gov/camping/campgrounds/234795',
      },
    ],
  },
  {
    targetId: 'target-3',
    summary:
      'Use Chapman only as a dry-road option. A verified dispersed site outside the campground source is preferable; the campground is the legal fallback.',
    candidates: [
      {
        id: 'fr940-dispersed',
        targetId: 'target-3',
        name: 'Established dispersed site along FR 940',
        kind: 'dispersed-corridor',
        legalStatus: 'verify',
        legalBasis:
          'Confirm the exact pullout against the current MVUM, posted restrictions, and surface ownership. Previously disturbed ground is not by itself proof that camping is legal.',
        access:
          'The official facility description calls the approach gravel and 2WD. The final spur can be steep or washboarded, so inspect it before taking the Tesla in.',
        wetRoadRisk: 'high',
        foodStorage:
          'Keep the tent free of attractants and lock food, refuse, toiletries, and cooking gear in the vehicle whenever unattended.',
        source: {
          label: 'USFS Chapman facility description',
          url: 'https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd1119790.pdf',
        },
      },
      {
        id: 'chapman-developed',
        targetId: 'target-3',
        name: 'Chapman Reservoir Campground',
        kind: 'developed',
        latitude: 40.186666,
        longitude: -107.086231,
        legalStatus: 'confirmed',
        legalBasis:
          'Developed campground with 12 sites. Confirm open status and fee at the kiosk; no dispersed-camping assumption is required.',
        access:
          'Officially described as gravel 2WD access. Treat rain, rutting, or a deep center crown as a stop condition for a low-clearance car.',
        wetRoadRisk: 'high',
        foodStorage:
          'Lock all attractants and refuse in the vehicle whenever unattended and leave no cooking residue at the site.',
        source: {
          label: 'USFS Chapman facility description',
          url: 'https://www.fs.usda.gov/Internet/FSE_DOCUMENTS/fseprd1119790.pdf',
        },
      },
    ],
  },
];

function degreesToRadians(value: number) {
  return (value * Math.PI) / 180;
}

export function distanceMiles(
  first: { latitude: number; longitude: number },
  second: { latitude: number; longitude: number },
) {
  const earthRadiusMiles = 3958.8;
  const latitudeDelta = degreesToRadians(second.latitude - first.latitude);
  const longitudeDelta = degreesToRadians(second.longitude - first.longitude);
  const firstLatitude = degreesToRadians(first.latitude);
  const secondLatitude = degreesToRadians(second.latitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) *
      Math.cos(secondLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(haversine));
}

export function assessCampCandidate(
  candidate: CampCandidate,
  target: BearTargetFeature,
): CampAssessment {
  const distanceToSourceMiles =
    candidate.latitude === undefined || candidate.longitude === undefined
      ? null
      : distanceMiles(
          { latitude: candidate.latitude, longitude: candidate.longitude },
          {
            latitude: target.properties.latitude,
            longitude: target.properties.longitude,
          },
        );

  const sourceRelationship =
    distanceToSourceMiles === null
      ? 'unknown'
      : distanceToSourceMiles < 0.05
        ? 'source-overlap'
        : distanceToSourceMiles < CAMP_SOURCE_CAUTION_MILES
          ? 'inside-caution'
          : 'outside-caution';

  const reasons: string[] = [];
  if (candidate.legalStatus !== 'confirmed') {
    reasons.push(
      candidate.legalStatus === 'verify'
        ? 'Exact-site camping authority still needs field verification.'
        : 'Camping is legal only if the stated eligibility and season conditions are met.',
    );
  }
  if (sourceRelationship === 'source-overlap') {
    reasons.push(
      'This camp is the modeled human-food source itself; it is a sleeping fallback, not a separated hunting base.',
    );
  } else if (sourceRelationship === 'inside-caution') {
    reasons.push(
      `This camp is inside the planner's ${CAMP_SOURCE_CAUTION_MILES}-mile analysis caution area; that line is not a statutory safe harbor.`,
    );
  } else if (sourceRelationship === 'unknown') {
    reasons.push(
      'Pin the exact occupied tent/vehicle site before relying on source separation.',
    );
  }
  if (candidate.wetRoadRisk === 'high') {
    reasons.push('Wet-road clearance risk can override an otherwise usable plan.');
  }

  const fit: CampFit =
    sourceRelationship === 'source-overlap' || sourceRelationship === 'inside-caution'
      ? 'fallback-only'
      : candidate.legalStatus === 'confirmed' && sourceRelationship === 'outside-caution'
        ? 'preferred'
        : 'conditional';

  return {
    ...candidate,
    distanceToSourceMiles,
    sourceRelationship,
    fit,
    reasons,
  };
}

export function getCampPlan(target: BearTargetFeature) {
  const plan = TARGET_CAMP_PLANS.find(
    (candidate) => candidate.targetId === target.properties.targetId,
  );
  if (!plan) return null;
  return {
    ...plan,
    candidates: plan.candidates.map((candidate) =>
      assessCampCandidate(candidate, target),
    ),
  };
}
