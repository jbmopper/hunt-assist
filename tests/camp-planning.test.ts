import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BearTargetCollection } from '../lib/bear-targets';
import { getBearTargets } from '../lib/bear-targets';
import {
  CAMP_SOURCE_CAUTION_MILES,
  assessCampCandidate,
  distanceMiles,
  getCampPlan,
  type CampCandidate,
} from '../lib/camp-planning';

const collection = JSON.parse(
  readFileSync('public/data/be012o1r-targets.geojson', 'utf8'),
) as BearTargetCollection;
const targets = getBearTargets(collection);

test('calculates geodesic camp-to-source distance', () => {
  const distance = distanceMiles(
    { latitude: 39.9947, longitude: -107.2428 },
    { latitude: 40.9947, longitude: -107.2428 },
  );
  assert.ok(distance > 68 && distance < 70);
});

test('marks a developed camp on the modeled source as fallback only', () => {
  const target = targets.find(({ properties }) => properties.targetId === 'target-2');
  assert.ok(target);
  const plan = getCampPlan(target);
  assert.ok(plan);
  const campground = plan.candidates.find(
    ({ id }) => id === 'shepherds-rim-developed',
  );
  assert.ok(campground);
  assert.equal(campground.sourceRelationship, 'source-overlap');
  assert.equal(campground.fit, 'fallback-only');
});

test('does not manufacture separation when a dispersed site has no verified pin', () => {
  const target = targets.find(({ properties }) => properties.targetId === 'target-3');
  assert.ok(target);
  const plan = getCampPlan(target);
  assert.ok(plan);
  const dispersed = plan.candidates.find(({ id }) => id === 'fr940-dispersed');
  assert.ok(dispersed);
  assert.equal(dispersed.distanceToSourceMiles, null);
  assert.equal(dispersed.sourceRelationship, 'unknown');
  assert.equal(dispersed.fit, 'conditional');
});

test('prefers a confirmed legal camp outside the analysis caution area', () => {
  const target = targets[0];
  const candidate: CampCandidate = {
    id: 'fixture',
    targetId: target.properties.targetId,
    name: 'Fixture camp',
    kind: 'designated',
    latitude: target.properties.latitude + 0.02,
    longitude: target.properties.longitude,
    legalStatus: 'confirmed',
    legalBasis: 'Fixture legal basis',
    access: 'Fixture access',
    wetRoadRisk: 'low',
    foodStorage: 'Fixture storage',
    source: { label: 'Fixture', url: 'https://example.com' },
  };
  const assessment = assessCampCandidate(candidate, target);
  assert.ok(assessment.distanceToSourceMiles! > CAMP_SOURCE_CAUTION_MILES);
  assert.equal(assessment.fit, 'preferred');
});
