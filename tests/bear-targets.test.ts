import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BearTargetCollection } from '../lib/bear-targets';
import { getBearTargets } from '../lib/bear-targets';

const collection = JSON.parse(
  readFileSync('public/data/be012o1r-targets.geojson', 'utf8'),
) as BearTargetCollection;
const targets = getBearTargets(collection);

test('ships a complete, current BE012O1R target package', () => {
  assert.equal(collection.metadata.huntCode, 'BE012O1R');
  assert.equal(collection.metadata.imageryDate, '2026-08-28');
  assert.deepEqual(collection.metadata.warnings, []);
  assert.deepEqual(collection.metadata.units, [12, 13, 23, 24, 25, 26, 33, 131, 231]);
  assert.equal(targets.length, 9);
  assert.deepEqual(
    targets.map((target) => target.properties.rank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
});

test('keeps ranks explainable, separated, and inside the hunt', () => {
  const validUnits = new Set(collection.metadata.units);
  const scores = targets.map((target) => target.properties.relativeScore);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));

  for (const target of targets) {
    const properties = target.properties;
    const [longitude, latitude] = target.geometry.coordinates;
    assert.ok(validUnits.has(properties.gmu));
    assert.ok(longitude >= -107.98 && longitude <= -106.64);
    assert.ok(latitude >= 39.52 && latitude <= 40.54);
    assert.ok(properties.relativeScore >= 60 && properties.relativeScore <= 100);
    assert.ok(properties.reason1.length > 10);
    assert.ok(properties.reason2.length > 10);
    assert.ok(properties.reason3.length > 10);
    assert.match(properties.caveat1, /verify|pressure|coverage/i);
  }

  const sectors = new Set(targets.map((target) => target.properties.sector));
  assert.ok(sectors.has("Crosho–Sheriff's–Chapman"));
  assert.ok(sectors.has('South Fork canyon'));
  assert.ok(sectors.has('Vaughan–Ripple Creek'));
});

test('pairs every target with a zone and modeled corridor in GeoJSON and GPX', () => {
  for (const target of targets) {
    const targetId = target.properties.targetId;
    assert.ok(
      collection.features.some(
        (feature) =>
          feature.properties.kind === 'target-zone' &&
          feature.properties.targetId === targetId,
      ),
    );
    assert.ok(
      collection.features.some(
        (feature) =>
          feature.properties.kind === 'corridor' &&
          feature.properties.targetId === targetId,
      ),
    );
  }

  const gpx = readFileSync('public/data/be012o1r-targets.gpx', 'utf8');
  assert.equal((gpx.match(/<wpt /g) ?? []).length, targets.length);
  assert.equal((gpx.match(/<trk>/g) ?? []).length, targets.length);
});
