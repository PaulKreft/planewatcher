import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const LAT = parseFloat(process.env.WATCH_LAT!);
const LON = parseFloat(process.env.WATCH_LON!);
const RADIUS_KM = parseFloat(process.env.WATCH_RADIUS_KM ?? '50');
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL!;
const CRON_SECRET = process.env.CRON_SECRET!;
const ALERT_TTL_SECONDS = 6 * 3600;

const OS_CLIENT_ID = process.env.OPENSKY_CLIENT_ID;
const OS_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;
const OS_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// ──────────────────────────────────────────────────────────────────
// Stage tracking — every step appends to this so we know exactly
// where execution died if anything throws.
// ──────────────────────────────────────────────────────────────────
class Tracer {
  steps: { stage: string; ms: number; ok: boolean; detail?: string }[] = [];
  private start = Date.now();

  async run<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    console.log(`[spot] → ${stage}`);
    try {
      const result = await fn();
      const ms = Date.now() - t0;
      this.steps.push({ stage, ms, ok: true });
      console.log(`[spot] ✓ ${stage} (${ms}ms)`);
      return result;
    } catch (e: unknown) {
      const ms = Date.now() - t0;
      const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      this.steps.push({ stage, ms, ok: false, detail });
      console.error(`[spot] ✗ ${stage} (${ms}ms): ${detail}`);
      // Surface fetch's `cause` field — that's where Node hides the real
      // network error (DNS, connect refused, TLS, timeout, etc).
      if (e instanceof Error && 'cause' in e && e.cause) {
        const cause =
          e.cause instanceof Error
            ? `${e.cause.name}: ${e.cause.message}`
            : String(e.cause);
        this.steps[this.steps.length - 1].detail += ` | cause: ${cause}`;
        console.error(`[spot]   cause: ${cause}`);
      }
      throw e;
    }
  }

  totalMs() {
    return Date.now() - this.start;
  }
}

/** Fetch with an explicit timeout and a labeled error. */
async function timedFetch(
  label: string,
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`${label} HTTP ${r.status}: ${body.slice(0, 200)}`);
    }
    return r;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

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

async function getOpenSkyToken(t: Tracer): Promise<string> {
  if (!OS_CLIENT_ID || !OS_CLIENT_SECRET) {
    throw new Error('OPENSKY_CLIENT_ID or OPENSKY_CLIENT_SECRET not set');
  }

  const cached = await t.run('redis.get(opensky:token)', () =>
    redis.get<string>('opensky:token'),
  );
  if (cached) return cached;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OS_CLIENT_ID,
    client_secret: OS_CLIENT_SECRET,
  });

  const r = await t.run('opensky.token', () =>
    timedFetch(
      'opensky.token',
      OS_TOKEN_URL,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      },
      10_000,
    ),
  );

  const j = (await r.json()) as { access_token: string; expires_in: number };
  const ttl = Math.max(60, (j.expires_in ?? 1800) - 60);
  await t.run('redis.set(opensky:token)', () =>
    redis.set('opensky:token', j.access_token, { ex: ttl }),
  );
  return j.access_token;
}

async function fetchOpenSky(t: Tracer, token: string) {
  const box = bbox(LAT, LON, RADIUS_KM);
  const url =
    `https://opensky-network.org/api/states/all` +
    `?lamin=${box.lamin}&lomin=${box.lomin}&lamax=${box.lamax}&lomax=${box.lomax}`;

  const r = await t.run('opensky.states', () =>
    timedFetch(
      'opensky.states',
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      10_000,
    ),
  );
  const j = (await r.json()) as { states: unknown[][] | null };
  return j.states ?? [];
}

async function lookupType(icao24: string): Promise<string | null> {
  const key = `type:${icao24}`;
  const cached = await redis.get<string>(key);
  if (cached !== null) return cached === '__none__' ? null : cached;

  try {
    const r = await timedFetch(
      `hexdb(${icao24})`,
      `https://hexdb.io/api/v1/aircraft/${icao24}`,
      {},
      5_000,
    );
    const j = (await r.json()) as { ICAOTypeCode?: string };
    const type = j.ICAOTypeCode || null;
    await redis.set(key, type ?? '__none__', { ex: 30 * 86400 });
    return type;
  } catch (e) {
    // Don't poison the cache on transient failures
    console.warn(
      `[spot] hexdb lookup failed for ${icao24}: ${(e as Error).message}`,
    );
    return null;
  }
}

async function postToSlack(
  t: Tracer,
  callsign: string,
  icao24: string,
  dist: number,
  altFt: string,
  velKts: string | number,
  heading: number | null,
) {
  await t.run(`slack.post(${callsign})`, () =>
    timedFetch(
      'slack.post',
      SLACK_WEBHOOK,
      {
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
      },
      5_000,
    ),
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = new Tracer();

  // Auth
  const isVercelCron = (req.headers['user-agent'] ?? '').includes(
    'vercel-cron',
  );
  const hasSecret = req.headers.authorization === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !hasSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Sanity-check env vars before doing any work
  const missing: string[] = [];
  for (const [k, v] of Object.entries({
    WATCH_LAT: process.env.WATCH_LAT,
    WATCH_LON: process.env.WATCH_LON,
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
    OPENSKY_CLIENT_ID: process.env.OPENSKY_CLIENT_ID,
    OPENSKY_CLIENT_SECRET: process.env.OPENSKY_CLIENT_SECRET,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
    CRON_SECRET: process.env.CRON_SECRET,
  })) {
    if (!v) missing.push(k);
  }
  if (missing.length) {
    return res.status(500).json({
      stage: 'env_check',
      error: `Missing env vars: ${missing.join(', ')}`,
    });
  }
  if (Number.isNaN(LAT) || Number.isNaN(LON)) {
    return res.status(500).json({
      stage: 'env_check',
      error: `WATCH_LAT/WATCH_LON not numeric: lat=${process.env.WATCH_LAT} lon=${process.env.WATCH_LON}`,
    });
  }

  try {
    const token = await getOpenSkyToken(t);
    const states = await fetchOpenSky(t, token);

    const alerted: string[] = [];

    await t.run(`process(${states.length} states)`, async () => {
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

        const callsign =
          ((s[1] as string) || '').trim() || icao24.toUpperCase();
        const altM = s[7] as number | null;
        const velMs = s[9] as number | null;
        const heading = s[10] as number | null;
        const dist = haversine(LAT, LON, lat, lon);

        const altFt = altM ? Math.round(altM * 3.281).toLocaleString() : '?';
        const velKts = velMs ? Math.round(velMs * 1.944) : '?';

        await postToSlack(t, callsign, icao24, dist, altFt, velKts, heading);
        alerted.push(callsign);
      }
    });

    return res.status(200).json({
      ok: true,
      checked: states.length,
      alerted,
      totalMs: t.totalMs(),
      steps: t.steps,
    });
  } catch (e: unknown) {
    const failed = t.steps.find(s => !s.ok);
    return res.status(500).json({
      ok: false,
      stage: failed?.stage ?? 'unknown',
      error: failed?.detail ?? (e instanceof Error ? e.message : String(e)),
      totalMs: t.totalMs(),
      steps: t.steps,
    });
  }
}
