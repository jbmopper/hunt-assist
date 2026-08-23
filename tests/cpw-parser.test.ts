import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LicenseParseError,
  parseLicensePages,
  type PositionedText,
} from '../lib/cpw-parser';
import { decodeHuntCode } from '../lib/hunt-code';

type FixtureOptions = {
  includeQuota?: boolean;
  offset?: number;
  scale?: number;
};

const text = (str: string, x: number, y: number): PositionedText => ({ str, x, y });

function fixturePage(options: FixtureOptions = {}) {
  const { includeQuota = true, offset = 0, scale = 1 } = options;
  const x = (value: number) => offset + value * scale;
  return [
    text('Run Date and Time: Aug 23 2026 4:19:00 PM MDT', x(372), 665),
    text('HUNT CODE', x(38), 630),
    text('VALID UNITS (GMU)', x(96), 630),
    text('LIST', x(193), 630),
    text('QUOTA', x(235), 630),
    text('SEASON DATES', x(303), 630),
    text('DESCRIPTION', x(396), 630),
    text('EF011O4R', x(36), 600),
    text('11,12,13,23,24,', x(94), 600),
    text('211', x(94), 589),
    text('A', x(200), 600),
    ...(includeQuota ? [text('1544', x(244), 600)] : []),
    text('11/18/2026 - 11/22/2026', x(283), 600),
    text('12/01/2026 - 12/04/2026', x(283), 589),
    text('SPECIAL RESTRICTIONS', x(394), 600),
    text('SEE BROCHURE', x(394), 589),
    text('EE015P3R', x(36), 560),
    text('15', x(94), 560),
    text('A', x(200), 560),
    text('16', x(246), 560),
    text('11/07/2026 - 11/15/2026', x(283), 560),
    text('PRIVATE LAND ONLY, NON-RESIDENT ONLY', x(394), 560),
  ];
}

test('parses wrapped units, dates, and descriptions without dropping rows', () => {
  const result = parseLicensePages([fixturePage()]);

  assert.equal(result.hunts.length, 2);
  assert.deepEqual(result.integrity, {
    detectedCodes: 2,
    pages: 1,
    parsedCodes: 2,
    parserVersion: 'cpw-leftover-v2',
  });
  assert.equal(result.generatedAt, 'Aug 23 2026 4:19:00 PM MDT');
  assert.deepEqual(result.hunts[0].units, [11, 12, 13, 23, 24, 211]);
  assert.equal(
    result.hunts[0].season,
    '11/18/2026 - 11/22/2026 12/01/2026 - 12/04/2026',
  );
  assert.equal(result.hunts[0].description, 'SPECIAL RESTRICTIONS SEE BROCHURE');
  assert.equal(result.hunts[0].sex, 'Female / antlerless');
  assert.equal(result.hunts[1].access, 'Private land only');
  assert.equal(result.hunts[1].residency, 'Nonresident only');
});

test('discovers columns from headers when the PDF layout shifts and scales', () => {
  const result = parseLicensePages([fixturePage({ offset: 47, scale: 1.18 })]);

  assert.equal(result.hunts.length, 2);
  assert.equal(result.hunts[0].quota, 1544);
  assert.deepEqual(result.hunts[1].units, [15]);
});

test('accepts a reissue notice without table headers', () => {
  const notice = 'Hunt Codes Have Been Moved To The Leftover List. Please Check Back Next Week.';
  const result = parseLicensePages([[text(notice, 40, 700)]]);

  assert.equal(result.notice, notice);
  assert.deepEqual(result.hunts, []);
  assert.equal(result.integrity.detectedCodes, 0);
});

test('fails closed and identifies a row when a required field disappears', () => {
  assert.throws(
    () => parseLicensePages([fixturePage({ includeQuota: false })]),
    (error) => {
      assert.ok(error instanceof LicenseParseError);
      assert.equal(error.diagnostics.detectedCodes, 2);
      assert.equal(error.diagnostics.parsedCodes, 1);
      assert.deepEqual(error.diagnostics.rejectedRows[0], {
        code: 'EF011O4R',
        page: 1,
        reasons: ['available quota was not found'],
      });
      return true;
    },
  );
});

test('fails closed when CPW changes a required table header', () => {
  const changedHeader = fixturePage().map((item) =>
    item.str === 'VALID UNITS (GMU)'
      ? { ...item, str: 'HUNTING UNITS' }
      : item,
  );

  assert.throws(
    () => parseLicensePages([changedHeader]),
    (error) => {
      assert.ok(error instanceof LicenseParseError);
      assert.equal(error.diagnostics.parsedCodes, 0);
      assert.match(
        error.diagnostics.rejectedRows[0].reasons[0],
        /missing column headers: VALID UNITS \(GMU\)/,
      );
      return true;
    },
  );
});

test('fails closed when a hunt code appears more than once', () => {
  const duplicatePage = fixturePage().filter(
    (item) => item.str !== 'EE015P3R' && item.y > 570,
  );

  assert.throws(
    () => parseLicensePages([duplicatePage, duplicatePage]),
    (error) => {
      assert.ok(error instanceof LicenseParseError);
      assert.deepEqual(error.diagnostics.duplicateCodes, ['EF011O4R']);
      return true;
    },
  );
});

test('uses one hunt-code decoder for parser and sample labels', () => {
  assert.deepEqual(decodeHuntCode('EF011O4R'), {
    method: 'Rifle / associated methods',
    methodCode: 'R',
    seasonCode: '4',
    sex: 'Female / antlerless',
    species: 'Elk',
  });
});
