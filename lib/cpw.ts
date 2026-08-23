import { extractTextItems, getDocumentProxy } from 'unpdf';
import { parseLicensePages, type PositionedText } from './cpw-parser';
import type { LicenseFeed, LicenseSourceKind } from './license-types';

export type {
  LicenseFeed,
  LicenseRecord,
  LicenseSourceKind,
} from './license-types';

type WidenAsset = {
  document_previews?: { uri?: string };
  filename?: string;
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
const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_RETRY_TTL_MS = 60 * 1000;
const MAX_PDF_BYTES = 3_000_000;
const MAX_PAGES = 40;

const feedCache = new Map<
  LicenseSourceKind,
  { expiresAt: number; value: LicenseFeed }
>();

async function fetchWithTimeout(url: string, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function validateReport(kind: LicenseSourceKind, feed: LicenseFeed) {
  if (kind === 'leftover' && feed.hunts.length) return;
  if (kind === 'reissue' && (feed.hunts.length || feed.notice)) return;
  throw new Error(`CPW ${kind} report did not contain the expected validated data`);
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
    const parsed = parseLicensePages(items as PositionedText[][]);
    const feed: LicenseFeed = {
      fetchedAt: new Date().toISOString(),
      generatedAt: parsed.generatedAt,
      hunts: parsed.hunts,
      integrity: parsed.integrity,
      notice: parsed.notice,
      source: {
        kind,
        label: asset.label,
        officialPageUrl: OFFICIAL_PAGE_URL,
        pdfPageUrl: `https://cpw.widencollective.com/assets/share/asset/${asset.externalId}`,
      },
      stale: false,
      warning: null,
    };
    validateReport(kind, feed);
    return feed;
  } finally {
    await destroyPdf();
  }
}

export async function getLicenseFeed(kind: LicenseSourceKind, force = false) {
  const cached = feedCache.get(kind);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const value = await fetchFeed(kind);
    feedCache.set(kind, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  } catch (error) {
    if (!cached) throw error;
    const staleValue: LicenseFeed = {
      ...cached.value,
      stale: true,
      warning:
        'The latest CPW report failed validation; showing the last verified local copy.',
    };
    feedCache.set(kind, {
      expiresAt: Date.now() + STALE_RETRY_TTL_MS,
      value: staleValue,
    });
    return staleValue;
  }
}
