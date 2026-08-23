import { getLicenseFeed, type LicenseSourceKind } from '@/lib/cpw';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const source = url.searchParams.get('source') ?? 'leftover';
  if (source !== 'leftover' && source !== 'reissue') {
    return Response.json(
      { error: 'source must be leftover or reissue' },
      { status: 400 },
    );
  }

  try {
    const forceRefresh = url.searchParams.get('refresh') === '1';
    const feed = await getLicenseFeed(
      source as LicenseSourceKind,
      forceRefresh,
    );
    return Response.json(feed, {
      headers: {
        'Cache-Control': forceRefresh
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
