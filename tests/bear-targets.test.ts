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

test('ships a human-food BE012O1R target package', () => {
  assert.equal(collection.metadata.huntCode, 'BE012O1R');
  assert.equal(collection.metadata.mode, 'human-food');
  assert.equal(collection.metadata.methodVersion, '0.2-human-food-corridors');
  assert.deepEqual(collection.metadata.units, [12, 13, 23, 24, 25, 26, 33, 131, 231]);
  assert.ok(targets.length >= 4 && targets.length <= 8);
  assert.equal(collection.metadata.sourceCount, targets.length);
  assert.equal(collection.metadata.securityOptionCount, securityOptions.length);
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
      assert.ok(properties.routeMiles >= properties.distanceMiles);
      assert.ok(properties.securityScore >= 40 && properties.securityScore <= 100);
      assert.ok(
        collection.features.some(
          (feature) =>
            feature.properties.kind === 'security-area' &&
            feature.properties.securityId === properties.securityId,
        ),
      );
      assert.ok(
        collection.features.some(
          (feature) =>
            feature.properties.kind === 'corridor' &&
            feature.properties.securityId === properties.securityId,
        ),
      );
    }
  }
});

test('exports context, security waypoints, and every route to GPX', () => {
  const gpx = readFileSync('public/data/be012o1r-targets.gpx', 'utf8');
  assert.equal(
    (gpx.match(/<wpt /g) ?? []).length,
    targets.length + securityOptions.length,
  );
  assert.equal((gpx.match(/<trk>/g) ?? []).length, securityOptions.length);
  assert.match(gpx, /Human-food context — not a setup location/);
  assert.match(gpx, /Modeled security option — verify access and sign/);
});
