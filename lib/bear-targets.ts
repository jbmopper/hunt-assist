import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';

export type BearTargetProperties = {
  kind: 'target';
  model: 'human-food';
  targetId: string;
  rank: number;
  name: string;
  shortName: string;
  sourceCategory: string;
  sourceCategories: string[];
  sourceManager: string;
  sourceInventory: string;
  sourceCount: number;
  huntCode: 'BE012O1R';
  gmu: number;
  relativeScore: number;
  conflictScore: number;
  conflictDistanceMiles: number;
  securityOptions: number;
  reason1: string;
  reason2: string;
  reason3: string;
  caveat1: string;
  caveat2: string;
  summary: string;
  latitude: number;
  longitude: number;
  analysisDate: string;
};

export type BearSecurityProperties = {
  kind: 'security';
  targetId: string;
  securityId: string;
  option: number;
  optionLabel: string;
  name: string;
  sourceName: string;
  gmu: number;
  securityScore: number;
  cover: number;
  routeCover: number;
  routeDrainage: number;
  roadExposure: number;
  pressure: number;
  publicPercent: number;
  distanceMiles: number;
  routeMiles: number;
  approachDistanceMiles: number;
  sourceBufferMiles: number;
  routeAgreement: number;
  ensembleRoutes: number;
  resolutionM: number;
  routeScenario: string;
  elevationFt: number;
  slopeDegrees: number;
  latitude: number;
  longitude: number;
  summary: string;
  verified: false;
};

export type BearAnalysisProperties = Record<string, unknown> & {
  kind:
    | 'corridor'
    | 'corridor-band'
    | 'human-conflict'
    | 'hunt-boundary'
    | 'security'
    | 'security-area'
    | 'source-buffer'
    | 'target';
  targetId?: string;
};

export type BearTargetFeature = Feature<Point, BearTargetProperties>;
export type BearSecurityFeature = Feature<Point, BearSecurityProperties>;

export type BearTargetCollection = FeatureCollection<
  Geometry,
  BearAnalysisProperties
> & {
  metadata: {
    huntCode: 'BE012O1R';
    units: number[];
    season: string;
    generatedAt: string;
    analysisDate: string;
    imageryDate: string | null;
    droughtUpdated: string | number | null;
    mode: 'human-food' | 'natural-food';
    methodVersion: string;
    scoreMeaning: string;
    sourceCount: number;
    securityOptionCount: number;
    corridorBandCount: number;
    screeningResolutionM: number;
    refinementResolutionM: number;
    sourceCautionRadiusMiles: number;
    corridorEnsembleMembers: number;
    corridorScenarios: string[];
    costModel: {
      meaning: string;
      commonWeights: Record<string, number>;
      nightWeights: Record<string, number>;
      dawnWeights: Record<string, number>;
      barriers: Record<string, number | string>;
    };
    behaviorReferences: Array<{
      title: string;
      url: string;
    }>;
    sources: Record<string, string>;
    warnings: string[];
  };
};

export function isBearTargetFeature(
  feature: Feature<Geometry, BearAnalysisProperties>,
): feature is BearTargetFeature {
  return (
    feature.geometry.type === 'Point' &&
    feature.properties.kind === 'target' &&
    typeof feature.properties.targetId === 'string'
  );
}

export function getBearTargets(collection: BearTargetCollection | null) {
  if (!collection) return [];
  return collection.features
    .filter(isBearTargetFeature)
    .sort((left, right) => left.properties.rank - right.properties.rank);
}

function isBearSecurityFeature(
  feature: Feature<Geometry, BearAnalysisProperties>,
): feature is BearSecurityFeature {
  return (
    feature.geometry.type === 'Point' &&
    feature.properties.kind === 'security' &&
    typeof feature.properties.securityId === 'string'
  );
}

export function getBearSecurityOptions(
  collection: BearTargetCollection | null,
  targetId?: string,
) {
  if (!collection) return [];
  return collection.features
    .filter(isBearSecurityFeature)
    .filter(
      (feature) => !targetId || feature.properties.targetId === targetId,
    )
    .sort((left, right) => {
      if (left.properties.targetId !== right.properties.targetId) {
        return left.properties.targetId.localeCompare(right.properties.targetId);
      }
      return left.properties.option - right.properties.option;
    });
}
