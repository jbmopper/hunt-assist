import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BearTargetCollection } from '../lib/bear-targets';
import {
  getBearSecurityOptions,
  getBearTargets,
} from '../lib/bear-targets';

const collection = JSON.parse(
  readFileSync('public/data/be012o1r-targets.geojson', 'utf8'),
) as BearTargetCollection;
const targets = getBearTargets(collection);
const securityOptions = getBearSecurityOptions(collection);
const cautionModes = ['rule-screen', 'quarter-mile', 'half-mile'] as const;

test('ships a human-food BE012O1R target package', () => {
  assert.equal(collection.metadata.huntCode, 'BE012O1R');
  assert.equal(collection.metadata.mode, 'human-food');
  assert.equal(collection.metadata.methodVersion, '0.5-regulation-aware-approaches');
  assert.equal(collection.metadata.refinementResolutionM, 30);
  assert.equal(collection.metadata.sourceCautionRadiusMiles, 0.5);
  assert.deepEqual(collection.metadata.units, [12, 13, 23, 24, 25, 26, 33, 131, 231]);
  assert.ok(targets.length >= 4 && targets.length <= 8);
  assert.equal(collection.metadata.sourceCount, targets.length);
  assert.equal(collection.metadata.sourceAreaCount, targets.length);
  assert.equal(
    collection.metadata.sourceMemberCount,
    targets.reduce((sum, target) => sum + target.properties.sourceCount, 0),
  );
  assert.equal(collection.metadata.securityOptionCount, securityOptions.length);
  assert.equal(collection.metadata.sourceBufferCount, targets.length * 2);
  assert.equal(collection.metadata.legalExclusionCount, targets.length);
  assert.ok(collection.metadata.roadExclusionCount > 0);
  assert.ok(collection.metadata.accessExclusionCount > 0);
  assert.equal(collection.metadata.sourcePortalCount, securityOptions.length * 3);
  assert.equal(collection.metadata.corridorBandCount, securityOptions.length * 3);
  assert.equal(collection.metadata.corridorInnerCount, securityOptions.length * 3);
  assert.equal(collection.metadata.defaultCautionMode, 'half-mile');
  assert.deepEqual(
    collection.metadata.cautionProfiles.map((profile) => profile.id),
    cautionModes,
  );
  assert.equal(collection.metadata.cautionProfiles[0].ruleBased, true);
  assert.equal(collection.metadata.cautionProfiles[0].statutoryBoundary, false);
  assert.equal(collection.metadata.legalScreenModel.facilityScreen.distanceYards, 150);
  assert.equal(collection.metadata.legalScreenModel.roadScreen.distanceFeetEachSide, 50);
  assert.ok(collection.metadata.sources.hydrography);
  assert.ok(collection.metadata.sources.roads);
  assert.ok(collection.metadata.sources.surfaceManagement);
  assert.ok(collection.metadata.sources.federalDischargeRule);
  assert.ok(collection.metadata.sources.currentForestAlerts);
  assert.match(collection.metadata.costModel.meaning, /lower is easier/i);
  assert.equal(collection.metadata.costModel.commonWeights.drainage, -0.34);
  assert.equal(collection.metadata.costModel.nightWeights.primaryRoad, 4.8);
  assert.equal(collection.metadata.costModel.dawnWeights.primaryRoad, 5.4);
  assert.ok(collection.metadata.behaviorReferences.length >= 3);
  assert.ok(
    collection.features.some(
      (feature) => feature.properties.kind === 'human-conflict',
    ),
  );
});

test('prioritizes conflict-linked human-food sources', () => {
  const validUnits = new Set(collection.metadata.units);
  const scores = targets.map((target) => target.properties.relativeScore);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));

  for (const target of targets) {
    const properties = target.properties;
    assert.equal(properties.model, 'human-food');
    assert.equal(properties.huntCode, 'BE012O1R');
    assert.ok(validUnits.has(properties.gmu));
    assert.ok(properties.relativeScore >= 60 && properties.relativeScore <= 99);
    assert.ok(properties.conflictScore > 10);
    assert.ok(properties.conflictDistanceMiles <= 1.5);
    assert.ok(properties.securityOptions >= 2 && properties.securityOptions <= 5);
    assert.equal(properties.sourceMembers.length, properties.sourceCount);
    assert.ok(properties.sourceFootprintAcres > 0);
    assert.ok(properties.sourceFootprintParts >= 1);
    assert.ok(properties.sourceExtentMiles >= 0);
    assert.match(properties.caveat1, /historical conflict/i);
    assert.match(properties.caveat2, /do not hunt/i);
  }
});

test('pairs every source with two to five security areas and routes', () => {
  const validUnits = new Set(collection.metadata.units);
  for (const target of targets) {
    const targetId = target.properties.targetId;
    const options = securityOptions.filter(
      (option) => option.properties.targetId === targetId,
    );
    assert.equal(options.length, target.properties.securityOptions);
    assert.ok(options.length >= 2 && options.length <= 5);
    assert.equal(new Set(options.map((option) => option.properties.optionLabel)).size, options.length);

    for (const option of options) {
      const properties = option.properties;
      assert.ok(validUnits.has(properties.gmu));
      assert.ok(properties.distanceMiles >= 0.95 && properties.distanceMiles <= 3.3);
      assert.ok(properties.routeMiles >= 0.2);
      assert.ok(properties.routeMiles <= properties.distanceMiles + 2);
      assert.ok(properties.approachDistanceMiles >= 0.49);
      assert.ok(properties.approachDistanceMiles <= 0.55);
      assert.equal(properties.sourceBufferMiles, 0.5);
      assert.ok(properties.fullRouteMiles >= properties.routeMiles);
      assert.equal(
        Math.round(properties.routeMiles + properties.innerRouteMiles),
        Math.round(properties.fullRouteMiles),
      );
      assert.deepEqual(Object.keys(properties.approachProfiles), cautionModes);
      assert.equal(properties.resolutionM, 30);
      assert.ok(properties.ensembleRoutes >= 2 && properties.ensembleRoutes <= 10);
      assert.ok(properties.portalCount >= 1 && properties.portalCount <= 10);
      assert.ok(properties.arrivalSource.length > 0);
      assert.ok(properties.routeAgreement >= 0 && properties.routeAgreement <= 100);
      assert.ok(properties.routeDrainage >= 0 && properties.routeDrainage <= 100);
      assert.ok(properties.roadExposure >= 0 && properties.roadExposure <= 100);
      assert.ok(properties.publicPercent >= 0 && properties.publicPercent <= 100);
      assert.ok(properties.securityScore >= 30 && properties.securityScore <= 100);
      assert.ok(
        collection.features.some(
          (feature) =>
            feature.properties.kind === 'security-area' &&
            feature.properties.securityId === properties.securityId,
        ),
      );
      for (const cautionMode of cautionModes) {
        for (const kind of ['source-portal', 'corridor', 'corridor-band', 'corridor-inner']) {
          assert.ok(
            collection.features.some(
              (feature) =>
                feature.properties.kind === kind &&
                feature.properties.securityId === properties.securityId &&
                feature.properties.cautionMode === cautionMode,
            ),
          );
        }
      }
    }
    assert.ok(
      collection.features.some(
        (feature) =>
          feature.properties.kind === 'source-buffer' &&
          feature.properties.targetId === targetId,
      ),
    );
    assert.equal(
      collection.features.filter(
        (feature) =>
          feature.properties.kind === 'source-buffer' &&
          feature.properties.targetId === targetId,
      ).length,
      2,
    );
    assert.ok(
      collection.features.some(
        (feature) =>
          feature.properties.kind === 'legal-exclusion' &&
          feature.properties.targetId === targetId,
      ),
    );
    assert.ok(
      collection.features.some(
        (feature) =>
          feature.properties.kind === 'source-area' &&
          feature.properties.targetId === targetId,
      ),
    );
  }
});

test('exports context, security waypoints, and every route to GPX', () => {
  const gpx = readFileSync('public/data/be012o1r-targets.gpx', 'utf8');
  assert.equal(
    (gpx.match(/<wpt /g) ?? []).length,
    targets.length + collection.metadata.sourceMemberCount + securityOptions.length,
  );
  assert.ok(
    (gpx.match(/<trk>/g) ?? []).length >= securityOptions.length + targets.length,
  );
  assert.match(gpx, /Human-food context — not a setup location/);
  assert.match(gpx, /Contributing human-food source record/);
  assert.match(gpx, /Analysis caution boundary — not statutory/);
  assert.match(gpx, /Rule screen — verify true boundary and applicability/);
  assert.match(gpx, /ANALYSIS ONLY inner approach/);
  assert.match(gpx, /Modeled security option — verify access and sign/);
});
