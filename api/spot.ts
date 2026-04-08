import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL!;
const CRON_SECRET = process.env.CRON_SECRET!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALERT_TTL_SECONDS = 6 * 3600;
const SIGHTINGS_MAX = 200;

// ──────────────────────────────────────────────────────────────────
// Config — stored in Redis under "config", with env-var fallback
// for the very first run before the dashboard has been used.
// ──────────────────────────────────────────────────────────────────
export type WatchConfig = { lat: number; lon: number; radiusKm: number };

export async function getConfig(): Promise<WatchConfig> {
  const stored = await redis.get<WatchConfig>('config');
  if (
    stored &&
    typeof stored.lat === 'number' &&
    typeof stored.lon === 'number'
  ) {
    return {
      lat: stored.lat,
      lon: stored.lon,
      radiusKm: stored.radiusKm ?? 50,
    };
  }
  return {
    lat: parseFloat(process.env.WATCH_LAT ?? '50.9375'),
    lon: parseFloat(process.env.WATCH_LON ?? '6.9603'),
    radiusKm: parseFloat(process.env.WATCH_RADIUS_KM ?? '50'),
  };
}

// ──────────────────────────────────────────────────────────────────
// Tracer + timedFetch
// ──────────────────────────────────────────────────────────────────
class Tracer {
  steps: { stage: string; ms: number; ok: boolean; detail?: string }[] = [];
  private start = Date.now();

  async run<T>(stage: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      this.steps.push({ stage, ms: Date.now() - t0, ok: true });
      return result;
    } catch (e: unknown) {
      const ms = Date.now() - t0;
      let detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (e instanceof Error && 'cause' in e && e.cause) {
        const cause =
          e.cause instanceof Error
            ? `${e.cause.name}: ${e.cause.message}`
            : String(e.cause);
        detail += ` | cause: ${cause}`;
      }
      this.steps.push({ stage, ms, ok: false, detail });
      throw e;
    }
  }

  totalMs() {
    return Date.now() - this.start;
  }
}

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

// ──────────────────────────────────────────────────────────────────
// adsb.lol — free, unauthenticated ADS-B aggregator
// ──────────────────────────────────────────────────────────────────
interface AdsbLolAircraft {
  hex: string;
  flight?: string;
  lat: number;
  lon: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  t?: string;
}

interface Aircraft {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  altM: number | null;
  velMs: number | null;
  heading: number | null;
  knownType: string | null;
}

async function fetchAircraft(
  t: Tracer,
  cfg: WatchConfig,
): Promise<Aircraft[]> {
  const distNm = Math.round(cfg.radiusKm * 0.53996);
  const url = `https://api.adsb.lol/v2/lat/${cfg.lat}/lon/${cfg.lon}/dist/${distNm}`;
  const r = await t.run('adsb.lol', () =>
    timedFetch('adsb.lol', url, {}, 15_000),
  );
  const j = (await r.json()) as { ac?: AdsbLolAircraft[] };
  return (j.ac ?? [])
    .filter(a => a.lat != null && a.lon != null)
    .map(a => ({
      icao24: a.hex,
      callsign: a.flight?.trim() || a.hex.toUpperCase(),
      lat: a.lat,
      lon: a.lon,
      altM: typeof a.alt_baro === 'number' ? a.alt_baro * 0.3048 : null,
      velMs: typeof a.gs === 'number' ? a.gs * 0.5144 : null,
      heading: a.track ?? null,
      knownType: a.t ?? null,
    }));
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
  } catch {
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
  await t.run(`slack(${callsign})`, () =>
    timedFetch(
      'slack',
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

  const isVercelCron = (req.headers['user-agent'] ?? '').includes(
    'vercel-cron',
  );
  const auth = req.headers.authorization;
  const hasCronSecret = auth === `Bearer ${CRON_SECRET}`;
  const hasAdminPassword =
    ADMIN_PASSWORD && auth === `Bearer ${ADMIN_PASSWORD}`;
  if (!isVercelCron && !hasCronSecret && !hasAdminPassword) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const missing: string[] = [];
  for (const [k, v] of Object.entries({
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
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

  try {
    const cfg = await t.run('redis.get(config)', () => getConfig());
    const aircraft = await fetchAircraft(t, cfg);
    const alerted: string[] = [];

    await t.run(`process(${aircraft.length})`, async () => {
      for (const ac of aircraft) {
        const type = ac.knownType ?? (await lookupType(ac.icao24));
        if (!type || !/^A38/i.test(type)) continue;

        const claimed = await redis.set(`seen:${ac.icao24}`, Date.now(), {
          ex: ALERT_TTL_SECONDS,
          nx: true,
        });
        if (claimed === null) continue;

        const dist = haversine(cfg.lat, cfg.lon, ac.lat, ac.lon);
        const altFt = ac.altM ? Math.round(ac.altM * 3.281) : null;
        const velKts = ac.velMs ? Math.round(ac.velMs * 1.944) : null;

        await postToSlack(
          t,
          ac.callsign,
          ac.icao24,
          dist,
          altFt?.toLocaleString() ?? '?',
          velKts ?? '?',
          ac.heading,
        );

        const sighting = {
          ts: Date.now(),
          icao24: ac.icao24,
          callsign: ac.callsign,
          type,
          distKm: Number(dist.toFixed(1)),
          altFt,
          velKts,
          heading: ac.heading,
          lat: ac.lat,
          lon: ac.lon,
        };
        await redis.lpush('sightings', JSON.stringify(sighting));
        await redis.ltrim('sightings', 0, SIGHTINGS_MAX - 1);

        alerted.push(ac.callsign);
      }
    });

    return res.status(200).json({
      ok: true,
      config: cfg,
      checked: aircraft.length,
      alerted,
      totalMs: t.totalMs(),
      steps: t.steps,
    });
  } catch (e: unknown) {
    const failed = t.steps.find(s => !s.ok);
    const errText =
      failed?.detail ?? (e instanceof Error ? e.message : String(e));
    return res.status(500).json({
      ok: false,
      stage: failed?.stage ?? 'unknown',
      error: errText,
      totalMs: t.totalMs(),
      steps: t.steps,
    });
  }
}
