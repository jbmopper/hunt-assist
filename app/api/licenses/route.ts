import { getLicenseFeed, type LicenseSourceKind } from '@/lib/cpw';
import { SAMPLE_HUNTS } from '@/lib/sample-hunts';
import type { LicenseFeed } from '@/lib/license-types';

export const dynamic = 'force-dynamic';

function offlineFeed(source: LicenseSourceKind): LicenseFeed {
  const leftover = source === 'leftover';
  return {
    fetchedAt: '2026-09-26T00:00:00.000Z',
    generatedAt: null,
    hunts: leftover ? SAMPLE_HUNTS : [],
    integrity: {
      detectedCodes: leftover ? SAMPLE_HUNTS.length : 0,
      pages: 0,
      parsedCodes: leftover ? SAMPLE_HUNTS.length : 0,
      parserVersion: 'offline-snapshot',
    },
    notice: leftover
      ? 'Offline package: showing the bundled sample licenses. BE012O1R trip targets remain fully available in targeting mode.'
      : 'Offline package: the live reissue preview is not bundled.',
    source: {
      kind: source,
      label: leftover ? 'Bundled sample licenses' : 'Reissue preview',
      officialPageUrl:
        'https://cpw.state.co.us/activities/hunting/big-game/leftover-remaining-and-reissued-licenses',
      pdfPageUrl: '',
    },
    stale: true,
    warning: 'Offline mode: connect and restart without HUNT_ASSIST_OFFLINE=1 to refresh CPW license data.',
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source') ?? 'leftover';
  if (source !== 'leftover' && source !== 'reissue') {
    return Response.json(
      { error: 'source must be leftover or reissue' },
      { status: 400 },
    );
  }

  if (process.env.HUNT_ASSIST_OFFLINE === '1') {
    return Response.json(offlineFeed(source));
  }

  try {
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const feed = await getLicenseFeed(
      source as LicenseSourceKind,
      forceRefresh,
    );
    return Response.json(feed, {
      headers: {
        'Cache-Control': forceRefresh || feed.stale
          ? 'no-store'
          : 'public, max-age=300, stale-while-revalidate=900',
      },
    });
  } catch (error) {
    console.error('Unable to refresh CPW license feed', error);
    return Response.json(
      {
        error: 'The live CPW license list could not be loaded. Try again shortly.',
      },
      { status: 502 },
    );
  }
}
