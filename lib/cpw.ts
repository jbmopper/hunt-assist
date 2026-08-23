import { extractTextItems, getDocumentProxy } from 'unpdf';

export type LicenseSourceKind = 'leftover' | 'reissue';

export type LicenseRecord = {
  access: 'Public + private' | 'Private land only';
  code: string;
  description: string;
  list: string;
  method: string;
  methodCode: string;
  quota: number;
  residency: 'Everyone' | 'Nonresident only' | 'Resident only';
  season: string;
  seasonCode: string;
  sex: string;
  species: string;
  units: number[];
};

export type LicenseFeed = {
  fetchedAt: string;
  generatedAt: string | null;
  hunts: LicenseRecord[];
  notice: string | null;
  source: {
    kind: LicenseSourceKind;
    label: string;
    officialPageUrl: string;
    pdfPageUrl: string;
  };
};

type WidenAsset = {
  document_previews?: { uri?: string };
  filename?: string;
};

type PositionedText = {
  str: string;
  x: number;
  y: number;
};

const CPW_ACCOUNT = 'CPWZZ';
const ACTOR_WRN = `widen:users:visitor:${CPW_ACCOUNT}:anonymous`;
const OFFICIAL_PAGE_URL =
  'https://cpw.state.co.us/activities/hunting/big-game/leftover-remaining-and-reissued-licenses';
const ASSETS: Record<LicenseSourceKind, { externalId: string; label: string }> = {
  leftover: {
    externalId: 'o9u5wmxrdp',
    label: 'Leftover licenses',
  },
  reissue: {
    externalId: '8jqx7mho70',
    label: 'Reissue preview',
  },
};
const CODE_PATTERN = /^[A-Z]{2}\d{3}[A-Z]\d[A-Z]$/;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_PDF_BYTES = 3_000_000;
const MAX_PAGES = 40;

const feedCache = new Map<
  LicenseSourceKind,
  { expiresAt: number; value: LicenseFeed }
>();

function speciesFromCode(code: string) {
  return (
    {
      A: 'Pronghorn',
      B: 'Black bear',
      D: 'Deer',
      E: 'Elk',
      G: 'Mountain goat',
      M: 'Moose',
      S: 'Bighorn sheep',
      T: 'Turkey',
    }[code[0]] ?? 'Other'
  );
}

function sexFromCode(code: string) {
  return (
    {
      E: 'Either sex',
      F: 'Female / antlerless',
      M: 'Male / antlered',
    }[code[1]] ?? 'See brochure'
  );
}

function methodFromCode(code: string) {
  return (
    {
      A: 'Archery',
      M: 'Muzzleloader',
      R: 'Rifle / associated methods',
      X: 'Special methods',
    }[code[7]] ?? 'See brochure'
  );
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

function parseItems(pages: PositionedText[][]) {
  const allText = pages
    .flat()
    .map((item) => item.str.trim())
    .filter(Boolean);
  const generatedAt =
    allText.find((value) => value.startsWith('Run Date and Time:'))?.replace(
      'Run Date and Time:',
      '',
    ).trim() ?? null;
  const notice =
    allText.find(
      (value) =>
        value.includes('Please Check Back Next Week') ||
        value.includes('There are no reissued licenses'),
    ) ?? null;
  const hunts: LicenseRecord[] = [];

  for (const page of pages) {
    const items = page.filter((item) => item.str.trim());
    const codeRows = items
      .filter((item) => CODE_PATTERN.test(item.str.trim()))
      .sort((a, b) => b.y - a.y);

    codeRows.forEach((codeItem, index) => {
      const code = codeItem.str.trim();
      const previousY = codeRows[index - 1]?.y;
      const nextY = codeRows[index + 1]?.y;
      const upper = previousY ? (previousY + codeItem.y) / 2 : codeItem.y + 34;
      const lower = nextY ? (nextY + codeItem.y) / 2 : Math.max(38, codeItem.y - 38);
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
          (item) => item.x >= 88 && item.x < 188 && /^[\d,\s]+$/.test(item.str),
        ),
      );
      const units = Array.from(
        new Set((unitText.match(/\d{1,3}/g) ?? []).map(Number)),
      );
      const list =
        rowItems.find(
          (item) =>
            item.x >= 188 &&
            item.x < 220 &&
            /^[A-C]$/.test(item.str.trim()) &&
            Math.abs(item.y - codeItem.y) < 3,
        )?.str.trim() ?? '';
      const quotaValue = rowItems.find(
        (item) =>
          item.x >= 220 &&
          item.x < 280 &&
          /^\d+$/.test(item.str.trim()) &&
          Math.abs(item.y - codeItem.y) < 3,
      )?.str;
      const season = normalizedLine(
        trailingRowItems.filter(
          (item) => item.x >= 275 && item.x < 395 && /\d{2}\/\d{2}\/\d{4}/.test(item.str),
        ),
      );
      const description = normalizedLine(
        rowItems.filter(
          (item) =>
            item.x >= 390 &&
            item.x < 590 &&
            item.str.trim().toUpperCase() !== 'DESCRIPTION',
        ),
      );
      const quota = Number(quotaValue);

      if (!Number.isFinite(quota) || !season) return;
      if (!units.length) units.push(Number(code.slice(2, 5)));

      const privateOnly =
        code[5] === 'P' || description.toUpperCase().includes('PRIVATE LAND ONLY');
      const upperDescription = description.toUpperCase();
      const residency = upperDescription.includes('NON-RESIDENT ONLY')
        ? 'Nonresident only'
        : upperDescription.includes('RESIDENT ONLY')
          ? 'Resident only'
          : 'Everyone';

      hunts.push({
        access: privateOnly ? 'Private land only' : 'Public + private',
        code,
        description,
        list,
        method: methodFromCode(code),
        methodCode: code[7],
        quota,
        residency,
        season,
        seasonCode: code[6],
        sex: sexFromCode(code),
        species: speciesFromCode(code),
        units,
      });
    });
  }

  return { generatedAt, hunts, notice };
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchFeed(kind: LicenseSourceKind): Promise<LicenseFeed> {
  const asset = ASSETS[kind];
  const assetWrn = `widen:assets:asset:${CPW_ACCOUNT}:${asset.externalId}`;
  const metadataUrl = `https://cpw.widencollective.com/albert/viewer/anonymous/asset/${assetWrn}`;
  const metadataResponse = await fetchWithTimeout(metadataUrl, {
    headers: {
      'x-widen-albert-client': 'einstein',
      'x-widen-context-actor': ACTOR_WRN,
      'x-widen-context-tracking': 'doNotTrack=false; anonymous=true',
    },
  });
  if (!metadataResponse.ok) {
    throw new Error(`CPW asset metadata returned ${metadataResponse.status}`);
  }

  const metadata = (await metadataResponse.json()) as WidenAsset;
  const pdfUrl = metadata.document_previews?.uri;
  if (!pdfUrl) throw new Error('CPW asset did not include a PDF preview');

  const pdfResponse = await fetchWithTimeout(pdfUrl);
  if (!pdfResponse.ok) {
    throw new Error(`CPW PDF returned ${pdfResponse.status}`);
  }
  const declaredLength = Number(pdfResponse.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_PDF_BYTES) {
    throw new Error('CPW PDF exceeded the configured size limit');
  }

  const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
  if (pdfBytes.byteLength > MAX_PDF_BYTES) {
    throw new Error('CPW PDF exceeded the configured size limit');
  }

  const pdf = await getDocumentProxy(pdfBytes, { maxImageSize: 16_777_216 });
  const destroyPdf = async () => {
    const destroy = (pdf as typeof pdf & { destroy?: () => Promise<void> }).destroy;
    if (typeof destroy === 'function') await destroy.call(pdf);
  };
  if (pdf.numPages > MAX_PAGES) {
    await destroyPdf();
    throw new Error('CPW PDF exceeded the configured page limit');
  }

  try {
    const extraction = extractTextItems(pdf);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('CPW PDF parsing timed out')), 12_000),
    );
    const { items } = await Promise.race([extraction, timeout]);
    const parsed = parseItems(items);
    return {
      fetchedAt: new Date().toISOString(),
      generatedAt: parsed.generatedAt,
      hunts: parsed.hunts,
      notice: parsed.notice,
      source: {
        kind,
        label: asset.label,
        officialPageUrl: OFFICIAL_PAGE_URL,
        pdfPageUrl: `https://cpw.widencollective.com/assets/share/asset/${asset.externalId}`,
      },
    };
  } finally {
    await destroyPdf();
  }
}

export async function getLicenseFeed(kind: LicenseSourceKind, force = false) {
  const cached = feedCache.get(kind);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  const value = await fetchFeed(kind);
  feedCache.set(kind, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}
