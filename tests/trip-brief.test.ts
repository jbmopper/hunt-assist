import assert from 'node:assert/strict';
import test from 'node:test';
import trip from '../lib/trip-brief.json';

test('keeps the requested two-night West Rifle Creek plan', () => {
  assert.match(trip.itinerary[0].sleep, /night 1 of 2/i);
  assert.match(trip.itinerary[1].sleep, /night 2 of 2/i);
});

test('separates legal screens from optional caution margins', () => {
  assert.match(trip.stance, /not legal setbacks/i);
  assert.match(trip.goNoGo.join(' '), /optional caution-ring separation/i);
});

test('does not offer Horse Thief to a non-stock camper', () => {
  const horseThief = trip.camps.find(({ name }) => name === 'Horse Thief Campground');
  assert.ok(horseThief);
  assert.equal(horseThief.fit, 'INELIGIBLE');
  assert.match(horseThief.legal, /stock users only/i);
});

test('uses only model scout cards with mapped public-land support', () => {
  assert.equal(trip.scoutCards.length, 3);
  for (const card of trip.scoutCards) {
    assert.equal(card.options.length, 2);
    for (const option of card.options) {
      assert.match(option.mapSignal, /mapped federal land/i);
      assert.match(option.coordinates, /^\d{2}\.\d{6}, -\d{3}\.\d{6}$/);
    }
  }
});
