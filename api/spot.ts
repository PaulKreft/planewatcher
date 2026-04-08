import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LAT = parseFloat(process.env.WATCH_LAT!);
const LON = parseFloat(process.env.WATCH_LON!);
const RADIUS_KM = parseFloat(process.env.WATCH_RADIUS_KM ?? '50');
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL!;
const CRON_SECRET = process.env.CRON_SECRET!;
const ALERT_TTL_SECONDS = 6 * 3600;

// OpenSky OAuth2 client credentials (required since March 2026)
const OS_CLIENT_ID = process.env.OPENSKY_CLIENT_ID;
const OS_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;
const OS_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

function bbox(lat: number, lon: number, km: number) {
  const dLat = km / 111;
  const dLon = km / (111 * Math.cos((lat * Math.PI) / 180));
  return {
    lamin: lat - dLat,
    lamax: lat + dLat,
    lomin: lon - dLon,
    lomax: lon + dLon,
  };
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Get a valid OpenSky bearer token via OAuth2 client credentials.
 * Cached in Redis so it's shared across cron invocations — each Vercel
 * invocation is a fresh process, so without this we'd refresh every minute.
 */
async function getOpenSkyToken(): Promise<string | null> {
  if (!OS_CLIENT_ID || !OS_CLIENT_SECRET) return null;

  const cached = await redis.get<string>('opensky:token');
  if (cached) return cached;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OS_CLIENT_ID,
    client_secret: OS_CLIENT_SECRET,
  });

  const r = await fetch(OS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!r.ok) throw new Error(`OpenSky token ${r.status}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };

  // Cache for slightly less than expires_in to avoid mid-expiry use
  const ttl = Math.max(60, (j.expires_in ?? 1800) - 60);
  await redis.set('opensky:token', j.access_token, { ex: ttl });
  return j.access_token;
}

async function lookupType(icao24: string): Promise<string | null> {
  const key = `type:${icao24}`;
  const cached = await redis.get<string>(key);
  if (cached !== null) return cached === '__none__' ? null : cached;

  try {
    const r = await fetch(`https://hexdb.io/api/v1/aircraft/${icao24}`);
    if (!r.ok) {
      await redis.set(key, '__none__', { ex: 86400 });
      return null;
    }
    const j = (await r.json()) as { ICAOTypeCode?: string };
    const type = j.ICAOTypeCode || null;
    await redis.set(key, type ?? '__none__', { ex: 30 * 86400 });
    return type;
  } catch {
    return null;
  }
}

async function fetchOpenSky() {
  const box = bbox(LAT, LON, RADIUS_KM);
  const url =
    `https://opensky-network.org/api/states/all` +
    `?lamin=${box.lamin}&lomin=${box.lomin}&lamax=${box.lamax}&lomax=${box.lomax}`;

  const headers: Record<string, string> = {};
  const token = await getOpenSkyToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`OpenSky ${r.status}`);
  const j = (await r.json()) as { states: unknown[][] | null };
  return j.states ?? [];
}

async function postToSlack(
  callsign: string,
  icao24: string,
  dist: number,
  altFt: string,
  velKts: string | number,
  heading: number | null,
) {
  await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: `🛬 A380 overhead: ${callsign}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `🛬 *A380 overhead*: \`${callsign}\`\n` +
              `*${dist.toFixed(1)} km* away · *${altFt} ft* · *${velKts} kts* · hdg ${heading?.toFixed(0) ?? '?'}°\n` +
              `<https://globe.adsbexchange.com/?icao=${icao24}|Track on ADS-B Exchange>`,
          },
        },
      ],
    }),
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const isVercelCron = (req.headers['user-agent'] ?? '').includes(
    'vercel-cron',
  );
  const hasSecret = req.headers.authorization === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    const states = await fetchOpenSky();
    const alerted: string[] = [];

    for (const s of states) {
      const icao24 = s[0] as string;
      const lon = s[5] as number | null;
      const lat = s[6] as number | null;
      if (lat == null || lon == null) continue;

      const type = await lookupType(icao24);
      if (!type || !/^A38/i.test(type)) continue;

      const claimed = await redis.set(`seen:${icao24}`, Date.now(), {
        ex: ALERT_TTL_SECONDS,
        nx: true,
      });
      if (claimed === null) continue;

      const callsign = ((s[1] as string) || '').trim() || icao24.toUpperCase();
      const altM = s[7] as number | null;
      const velMs = s[9] as number | null;
      const heading = s[10] as number | null;
      const dist = haversine(LAT, LON, lat, lon);

      const altFt = altM ? Math.round(altM * 3.281).toLocaleString() : '?';
      const velKts = velMs ? Math.round(velMs * 1.944) : '?';

      await postToSlack(callsign, icao24, dist, altFt, velKts, heading);
      alerted.push(callsign);
    }

    return res.status(200).json({
      ok: true,
      checked: states.length,
      alerted,
      ts: new Date().toISOString(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(msg);
    return res.status(500).json({ error: msg });
  }
}
