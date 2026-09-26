import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { BearTargetCollection } from '../lib/bear-targets';
import { getBearSourceAreas, getBearTargets } from '../lib/bear-targets';
import {
  CAMP_SOURCE_CAUTION_MILES,
  assessCampCandidate,
  distanceMiles,
  distanceToFootprintMiles,
  getCampPlan,
  type CampCandidate,
} from '../lib/camp-planning';

const collection = JSON.parse(
  readFileSync('public/data/be012o1r-targets.geojson', 'utf8'),
) as BearTargetCollection;
const targets = getBearTargets(collection);
const sourceAreas = getBearSourceAreas(collection);

function footprintFor(targetId: string) {
  const footprint = sourceAreas.find(({ properties }) => properties.targetId === targetId);
  assert.ok(footprint);
  return footprint;
}

function fixtureCandidate(
  targetId: string,
  latitude: number,
  longitude: number,
): CampCandidate {
  return {
    id: 'fixture',
    targetId,
    name: 'Fixture camp',
    kind: 'designated',
    latitude,
    longitude,
    legalStatus: 'confirmed',
    legalBasis: 'Fixture legal basis',
    access: 'Fixture access',
    wetRoadRisk: 'low',
    foodStorage: 'Fixture storage',
    source: { label: 'Fixture', url: 'https://example.com' },
  };
}

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
  const plan = getCampPlan(target, footprintFor('target-2'));
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
  const plan = getCampPlan(target, footprintFor('target-3'));
  assert.ok(plan);
  const dispersed = plan.candidates.find(({ id }) => id === 'fr940-dispersed');
  assert.ok(dispersed);
  assert.equal(dispersed.distanceToSourceMiles, null);
  assert.equal(dispersed.sourceRelationship, 'unknown');
  assert.equal(dispersed.fit, 'conditional');
});

test('prefers a confirmed legal camp outside the analysis caution area', () => {
  const target = targets[0];
  const candidate = fixtureCandidate(
    target.properties.targetId,
    target.properties.latitude + 0.02,
    target.properties.longitude,
  );
  const assessment = assessCampCandidate(
    candidate,
    footprintFor(target.properties.targetId),
  );
  assert.ok(assessment.distanceToSourceMiles! > CAMP_SOURCE_CAUTION_MILES);
  assert.equal(assessment.fit, 'preferred');
});

test('measures separation from every footprint patch, not the headline point', () => {
  // Chapman's second patch and a Rifle Falls developed-area record both sit
  // about 0.7 mi from their target's headline point but inside the footprint.
  for (const [targetId, latitude, longitude] of [
    ['target-3', 40.19708967458382, -107.08549815573176],
    ['target-1', 39.66340631245913, -107.70264075592188],
  ] as const) {
    const target = targets.find(({ properties }) => properties.targetId === targetId);
    assert.ok(target);
    assert.ok(
      distanceMiles({ latitude, longitude }, target.properties) > CAMP_SOURCE_CAUTION_MILES,
    );
    const assessment = assessCampCandidate(
      fixtureCandidate(targetId, latitude, longitude),
      footprintFor(targetId),
    );
    assert.equal(assessment.distanceToSourceMiles, 0);
    assert.equal(assessment.sourceRelationship, 'source-overlap');
    assert.equal(assessment.fit, 'fallback-only');
  }
});

test('flags a camp inside the caution distance of an outlying patch', () => {
  // 0.25 mi north of Chapman's second patch record: well over 0.5 mi from the
  // headline point, but within the caution distance of the footprint.
  const latitude = 40.19708967458382 + 0.25 / 69;
  const longitude = -107.08549815573176;
  const footprint = footprintFor('target-3');
  const distance = distanceToFootprintMiles({ latitude, longitude }, footprint);
  assert.ok(distance > 0 && distance < CAMP_SOURCE_CAUTION_MILES);
  const assessment = assessCampCandidate(
    fixtureCandidate('target-3', latitude, longitude),
    footprint,
  );
  assert.equal(assessment.sourceRelationship, 'inside-caution');
  assert.equal(assessment.fit, 'fallback-only');
});

test('marks the stock-only Horse Thief campground as ineligible', () => {
  const target = targets.find(({ properties }) => properties.targetId === 'target-2');
  assert.ok(target);
  const plan = getCampPlan(target, footprintFor('target-2'));
  assert.ok(plan);
  const horseThief = plan.candidates.find(({ id }) => id === 'horse-thief-developed');
  assert.ok(horseThief);
  assert.equal(horseThief.legalStatus, 'stock-only');
  assert.equal(horseThief.sourceRelationship, 'source-overlap');
  assert.equal(horseThief.fit, 'ineligible');
});

test('does not claim separation when the source footprint is missing', () => {
  const target = targets[0];
  const assessment = assessCampCandidate(
    fixtureCandidate(
      target.properties.targetId,
      target.properties.latitude + 0.02,
      target.properties.longitude,
    ),
    undefined,
  );
  assert.equal(assessment.distanceToSourceMiles, null);
  assert.equal(assessment.sourceRelationship, 'unknown');
  assert.equal(assessment.fit, 'conditional');
});
