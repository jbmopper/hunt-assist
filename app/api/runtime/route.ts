export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({
    offline: process.env.HUNT_ASSIST_OFFLINE === '1',
  });
}
