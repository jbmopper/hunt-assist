import { decodeHuntCode } from './hunt-code';
import type {
  LicenseRecord,
  LicenseResidency,
  ParserIntegrity,
} from './license-types';

export type PositionedText = {
  str: string;
  x: number;
  y: number;
};

export type ParseRejection = {
  code: string;
  page: number;
  reasons: string[];
};

export type ParseDiagnostics = ParserIntegrity & {
  duplicateCodes: string[];
  rejectedRows: ParseRejection[];
};

type ColumnLayout = {
  descriptionStart: number;
  listEnd: number;
  listStart: number;
  quotaEnd: number;
  quotaStart: number;
  seasonEnd: number;
  seasonStart: number;
  unitsEnd: number;
  unitsStart: number;
};

const PARSER_VERSION = 'cpw-leftover-v2';
const CODE_PATTERN = /^[A-Z]{2}\d{3}[A-Z]\d[A-Z]$/;
const DATE_PATTERN = /\d{2}\/\d{2}\/\d{4}/;
const HEADER_LABELS = [
  'HUNT CODE',
  'VALID UNITS (GMU)',
  'LIST',
  'QUOTA',
  'SEASON DATES',
  'DESCRIPTION',
] as const;

export class LicenseParseError extends Error {
  readonly diagnostics: ParseDiagnostics;

  constructor(message: string, diagnostics: ParseDiagnostics) {
    super(message);
    this.name = 'LicenseParseError';
    this.diagnostics = diagnostics;
  }
}

function midpoint(left: number, right: number) {
  return (left + right) / 2;
}

function detectColumnLayout(items: PositionedText[], page: number) {
  const anchors = HEADER_LABELS.map((label) => {
    const item = items.find((candidate) => candidate.str.trim() === label);
    return item ? { label, x: item.x } : null;
  });
  const missing = anchors
    .map((anchor, index) => (anchor ? null : HEADER_LABELS[index]))
    .filter((label): label is (typeof HEADER_LABELS)[number] => label !== null);
  if (missing.length) {
    throw new Error(`Page ${page} is missing column headers: ${missing.join(', ')}`);
  }

  const values = anchors.map((anchor) => anchor!.x);
  if (!values.every((value, index) => index === 0 || value > values[index - 1])) {
    throw new Error(`Page ${page} has column headers in an unexpected order`);
  }

  const [code, units, list, quota, season, description] = values;
  return {
    descriptionStart: midpoint(season, description),
    listEnd: midpoint(list, quota),
    listStart: midpoint(units, list),
    quotaEnd: midpoint(quota, season),
    quotaStart: midpoint(list, quota),
    seasonEnd: midpoint(season, description),
    seasonStart: midpoint(quota, season),
    unitsEnd: midpoint(units, list),
    unitsStart: midpoint(code, units),
  } satisfies ColumnLayout;
}

function normalizedLine(items: PositionedText[]) {
  const lines: Array<{ y: number; values: PositionedText[] }> = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) < 1.5);
    if (line) line.values.push(item);
    else lines.push({ y: item.y, values: [item] });
  }

  return lines
    .sort((a, b) => b.y - a.y)
    .map((line) =>
      line.values
        .sort((a, b) => a.x - b.x)
        .map((item) => item.str.trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inColumn(item: PositionedText, start: number, end: number) {
  return item.x >= start && item.x < end;
}

function parseRow(
  items: PositionedText[],
  codeRows: PositionedText[],
  codeIndex: number,
  layout: ColumnLayout,
  page: number,
) {
  const codeItem = codeRows[codeIndex];
  const code = codeItem.str.trim();
  const previousY = codeRows[codeIndex - 1]?.y;
  const nextY = codeRows[codeIndex + 1]?.y;
  const upper = previousY ? midpoint(previousY, codeItem.y) : codeItem.y + 34;
  const lower = nextY ? midpoint(nextY, codeItem.y) : Math.max(38, codeItem.y - 38);
  const rowItems = items.filter(
    (item) => item !== codeItem && item.y <= upper && item.y >= lower,
  );
  const trailingRowItems = items.filter(
    (item) =>
      item !== codeItem &&
      item.y <= codeItem.y + 2 &&
      item.y > (nextY ? nextY + 2 : Math.max(38, codeItem.y - 40)),
  );

  const unitText = normalizedLine(
    trailingRowItems.filter(
      (item) =>
        inColumn(item, layout.unitsStart, layout.unitsEnd) &&
        /^[\d,\s]+$/.test(item.str),
    ),
  );
  const units = Array.from(
    new Set((unitText.match(/\d{1,3}/g) ?? []).map(Number)),
  ).filter((unit) => unit >= 1 && unit <= 999);
  const list =
    rowItems.find(
      (item) =>
        inColumn(item, layout.listStart, layout.listEnd) &&
        /^[A-C]$/.test(item.str.trim()) &&
        Math.abs(item.y - codeItem.y) < 3,
    )?.str.trim() ?? '';
  const quotaValue = rowItems.find(
    (item) =>
      inColumn(item, layout.quotaStart, layout.quotaEnd) &&
      /^\d+$/.test(item.str.trim()) &&
      Math.abs(item.y - codeItem.y) < 3,
  )?.str;
  const season = normalizedLine(
    trailingRowItems.filter(
      (item) =>
        inColumn(item, layout.seasonStart, layout.seasonEnd) &&
        DATE_PATTERN.test(item.str),
    ),
  );
  const description = normalizedLine(
    rowItems.filter(
      (item) =>
        item.x >= layout.descriptionStart &&
        item.str.trim().toUpperCase() !== 'DESCRIPTION',
    ),
  );
  const quota = quotaValue === undefined ? Number.NaN : Number(quotaValue);
  const reasons: string[] = [];
  if (!units.length) reasons.push('valid units were not found');
  if (!list) reasons.push('license list was not found');
  if (!Number.isFinite(quota)) reasons.push('available quota was not found');
  if (!season) reasons.push('season dates were not found');
  if (reasons.length) {
    return {
      rejection: { code, page, reasons } satisfies ParseRejection,
      record: null,
    };
  }

  const upperDescription = description.toUpperCase();
  const privateOnly =
    code[5] === 'P' || upperDescription.includes('PRIVATE LAND ONLY');
  const residency: LicenseResidency = upperDescription.includes(
    'NON-RESIDENT ONLY',
  )
    ? 'Nonresident only'
    : upperDescription.includes('RESIDENT ONLY')
      ? 'Resident only'
      : 'Everyone';

  return {
    rejection: null,
    record: {
      access: privateOnly ? 'Private land only' : 'Public + private',
      code,
      description,
      list,
      quota,
      residency,
      season,
      units,
      ...decodeHuntCode(code),
    } satisfies LicenseRecord,
  };
}

function failureMessage(diagnostics: ParseDiagnostics) {
  const parts: string[] = [];
  if (diagnostics.rejectedRows.length) {
    const first = diagnostics.rejectedRows[0];
    parts.push(`${first.code}: ${first.reasons.join(', ')}`);
  }
  if (diagnostics.duplicateCodes.length) {
    parts.push(`duplicate codes: ${diagnostics.duplicateCodes.join(', ')}`);
  }
  return `CPW license PDF failed integrity checks (${parts.join('; ')})`;
}

export function parseLicensePages(pages: PositionedText[][]) {
  const allText = pages
    .flat()
    .map((item) => item.str.trim())
    .filter(Boolean);
  const generatedAt =
    allText
      .find((value) => value.startsWith('Run Date and Time:'))
      ?.replace('Run Date and Time:', '')
      .trim() ?? null;
  const notice =
    allText.find(
      (value) =>
        value.includes('Please Check Back Next Week') ||
        value.includes('There are no reissued licenses'),
    ) ?? null;
  const hunts: LicenseRecord[] = [];
  const rejectedRows: ParseRejection[] = [];
  let detectedCodes = 0;

  pages.forEach((rawPage, pageIndex) => {
    const items = rawPage.filter((item) => item.str.trim());
    const codeRows = items
      .filter((item) => CODE_PATTERN.test(item.str.trim()))
      .sort((a, b) => b.y - a.y);
    if (!codeRows.length) return;
    detectedCodes += codeRows.length;

    let layout: ColumnLayout;
    try {
      layout = detectColumnLayout(items, pageIndex + 1);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'column layout failed';
      rejectedRows.push(
        ...codeRows.map((item) => ({
          code: item.str.trim(),
          page: pageIndex + 1,
          reasons: [reason],
        })),
      );
      return;
    }

    codeRows.forEach((_, codeIndex) => {
      const parsed = parseRow(items, codeRows, codeIndex, layout, pageIndex + 1);
      if (parsed.record) hunts.push(parsed.record);
      if (parsed.rejection) rejectedRows.push(parsed.rejection);
    });
  });

  const counts = new Map<string, number>();
  hunts.forEach((hunt) => counts.set(hunt.code, (counts.get(hunt.code) ?? 0) + 1));
  const duplicateCodes = Array.from(counts)
    .filter(([, count]) => count > 1)
    .map(([code]) => code);
  const diagnostics: ParseDiagnostics = {
    detectedCodes,
    duplicateCodes,
    pages: pages.length,
    parsedCodes: hunts.length,
    parserVersion: PARSER_VERSION,
    rejectedRows,
  };

  if (
    rejectedRows.length ||
    duplicateCodes.length ||
    diagnostics.parsedCodes !== diagnostics.detectedCodes
  ) {
    throw new LicenseParseError(failureMessage(diagnostics), diagnostics);
  }

  return {
    generatedAt,
    hunts,
    integrity: {
      detectedCodes: diagnostics.detectedCodes,
      pages: diagnostics.pages,
      parsedCodes: diagnostics.parsedCodes,
      parserVersion: diagnostics.parserVersion,
    } satisfies ParserIntegrity,
    notice,
  };
}
