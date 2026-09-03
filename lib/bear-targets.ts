import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';

export type BearCautionMode =
  | 'rule-screen'
  | 'quarter-mile'
  | 'half-mile';

export type BearApproachProfile = {
  label: string;
  boundaryMiles: number;
  outerRouteMiles: number;
  innerRouteMiles: number;
  portalCount: number;
};

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
  sourceMembers: Array<{
    name: string;
    category: string;
    manager: string;
    inventory: string;
  }>;
  sourceFootprintAcres: number;
  sourceFootprintParts: number;
  sourceExtentMiles: number;
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
  arrivalSource: string;
  portalCount: number;
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
  fullRouteMiles: number;
  innerRouteMiles: number;
  approachDistanceMiles: number;
  sourceBufferMiles: number;
  approachProfiles: Record<BearCautionMode, BearApproachProfile>;
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
    | 'access-exclusion'
    | 'corridor'
    | 'corridor-band'
    | 'corridor-inner'
    | 'human-conflict'
    | 'hunt-boundary'
    | 'legal-exclusion'
    | 'road-exclusion'
    | 'security'
    | 'security-area'
    | 'source-area'
    | 'source-buffer'
    | 'source-member'
    | 'source-portal'
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
    sourceMemberCount: number;
    sourceAreaCount: number;
    sourceBufferCount: number;
    legalExclusionCount: number;
    roadExclusionCount: number;
    accessExclusionCount: number;
    sourcePortalCount: number;
    securityOptionCount: number;
    corridorBandCount: number;
    corridorInnerCount: number;
    screeningResolutionM: number;
    refinementResolutionM: number;
    sourceCautionRadiusMiles: number;
    defaultCautionMode: BearCautionMode;
    cautionProfiles: Array<{
      id: BearCautionMode;
      label: string;
      radiusMiles: number;
      ruleBased: boolean;
      statutoryBoundary: boolean;
    }>;
    corridorEnsembleMembers: number;
    corridorScenarios: string[];
    sourceFootprintModel: {
      meaning: string;
      anchorRadiiM: Record<string, number>;
      developedPatchLinkRadiusM: number;
      developedPatchMaximumReachM: number;
      routeDestination: string;
    };
    legalScreenModel: {
      meaning: string;
      facilityScreen: {
        distanceYards: number;
        basis: string;
        applicability: string;
        boundaryStatus: string;
      };
      roadScreen: {
        distanceFeetEachSide: number;
        basis: string;
        boundaryStatus: string;
      };
      ownershipScreen: {
        basis: string;
        boundaryStatus: string;
      };
      closures: {
        status: string;
        instruction: string;
      };
    };
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
