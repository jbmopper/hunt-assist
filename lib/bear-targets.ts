import type { Feature, FeatureCollection, Geometry, Point } from 'geojson';

export type BearTargetProperties = {
  kind: 'target';
  targetId: string;
  rank: number;
  name: string;
  shortName: string;
  sector: string;
  nearbyFeature: string;
  nearbyFeatureType: string | null;
  huntCode: 'BE012O1R';
  gmu: number;
  relativeScore: number;
  deskScore: number;
  forage: number;
  cover: number;
  travel: number;
  pinch: number;
  glassing: number;
  pressure: number;
  imageryCoverage: number;
  vegetation: string;
  elevationFt: number;
  slopeDegrees: number;
  aspect: number;
  reason1: string;
  reason2: string;
  reason3: string;
  caveat1: string;
  caveat2: string;
  summary: string;
  latitude: number;
  longitude: number;
  imageryDate: string | null;
  analysisDate: string;
};

export type BearAnalysisProperties = Record<string, unknown> & {
  kind: 'corridor' | 'glassing' | 'hunt-boundary' | 'target' | 'target-zone';
  targetId?: string;
};

export type BearTargetFeature = Feature<Point, BearTargetProperties>;

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
    methodVersion: string;
    scoreMeaning: string;
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
