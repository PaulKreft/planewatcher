import type { VercelRequest, VercelResponse } from '@vercel/node';
import dns from 'node:dns';
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici';
import { Redis } from '@upstash/redis';

/** Prefer IPv4 — Vercel ↔ OpenSky often stalls on broken IPv6 paths. */
dns.setDefaultResultOrder('ipv4first');

const redis = Redis.fromEnv();

/**
 * OpenSky often drops or blackholes datacenter egress (ETIMEDOUT to auth API).
 * Optional HTTP CONNECT proxy: `http://user:pass@host:port` or `http://host:port`
 *
 * Use raw ProxyAgent (not EnvHttpProxyAgent): the latter honors NO_PROXY, so a
 * Vercel/env NO_PROXY=* or similar would skip the proxy and still hit ETIMEDOUT direct to OpenSky.
 */
const OPENSKY_PROXY = process.env.OPENSKY_HTTPS_PROXY?.trim();

const openskyConnectOpts = { timeout: 35_000 } as const;

const openskyDispatcher = OPENSKY_PROXY
  ? new ProxyAgent({
      uri: OPENSKY_PROXY,
      connect: openskyConnectOpts,
    })
  : new Agent({ connect: openskyConnectOpts });

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL!;
const CRON_SECRET = process.env.CRON_SECRET!;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ALERT_TTL_SECONDS = 6 * 3600;
const SIGHTINGS_MAX = 200;

const OS_CLIENT_ID = process.env.OPENSKY_CLIENT_ID;
const OS_CLIENT_SECRET = process.env.OPENSKY_CLIENT_SECRET;
const OS_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// ──────────────────────────────────────────────────────────────────
// Config — stored in Redis under "config", with env-var fallback
// for the very first run before the dashboard has been used.
// ──────────────────────────────────────────────────────────────────
export type WatchConfig = { lat: number; lon: number; radiusKm: number };

interface NormalizedAircraft {
  icao24: string;
  callsign: string;
  lat: number;
  lon: number;
  altM: number | null;
  velMs: number | null;
  heading: number | null;
  knownType: string | null;
}

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
// Tracer + timedFetch (same pattern as before)
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

function hintForOpenSkyFailure(
  stage: string,
  detail: string,
  proxyConfigured: boolean,
): string | undefined {
  if (!stage.startsWith('opensky.')) return undefined;
  const d = detail.toLowerCase();
  if (
    d.includes('etimedout') ||
    d.includes('connect timeout') ||
    d.includes('econnrefused') ||
    d.includes('network unreachable')
  ) {
    if (proxyConfigured) {
      return (
        'OPENSKY_HTTPS_PROXY is set but the connection still failed. ' +
        'Confirm the proxy URL is reachable from Vercel, speaks HTTP CONNECT, and can forward TLS to opensky-network.org:443. ' +
        'If the error still names 194.209.200.34, the tunnel target may be timing out (proxy cannot reach OpenSky either).'
      );
    }
    return (
      'OpenSky’s auth and data API use the same IP; if Vercel cannot open TCP (ETIMEDOUT), both token and /states fail. ' +
      'Set OPENSKY_HTTPS_PROXY in Vercel (Production) to an HTTP CONNECT proxy that can reach opensky-network.org:443, ' +
      'or try another regions value in vercel.json, or run the poller off Vercel.'
    );
  }
  return undefined;
}

function openSkyErrorExtras(stage: string, detail: string) {
  if (!stage.startsWith('opensky.')) return {};
  const proxyConfigured = Boolean(OPENSKY_PROXY);
  const hint = hintForOpenSkyFailure(stage, detail, proxyConfigured);
  return {
    openskyProxyConfigured: proxyConfigured,
    ...(hint ? { hint } : {}),
  };
}

function isTimeoutError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'AbortError' || /timed out after \d+ms/.test(e.message))
    return true;
  let cur: unknown = e;
  for (let d = 0; d < 5 && cur instanceof Error; d++) {
    if (cur.name === 'ConnectTimeoutError') return true;
    if (/Connect Timeout Error/i.test(cur.message)) return true;
    if (/ETIMEDOUT/i.test(cur.message)) return true;
    cur = 'cause' in cur ? cur.cause : null;
  }
  return false;
}

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;

async function timedOpenSkyFetch(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<UndiciResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const reqBody = init.body;
  try {
    const r = await undiciFetch(url, {
      method: init.method,
      headers: init.headers,
      ...(reqBody != null ? { body: reqBody } : {}),
      signal: ctrl.signal,
      dispatcher: openskyDispatcher,
    } as Parameters<typeof undiciFetch>[1]);
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

/** Retries only on transport timeouts (slow connect / stalled upstream). */
async function timedOpenSkyFetchWithRetry(
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  attempts: number,
): Promise<UndiciResponse> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await timedOpenSkyFetch(label, url, init, timeoutMs);
    } catch (e) {
      last = e;
      if (!isTimeoutError(e) || i === attempts - 1) throw e;
      await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw last;
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
  const cached = await t.run('redis.get(token)', () =>
    redis.get<string>('opensky:token'),
  );
  if (cached) return cached;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: OS_CLIENT_ID,
    client_secret: OS_CLIENT_SECRET,
  });

  const r = await t.run('opensky.token', () =>
    timedOpenSkyFetchWithRetry(
      'opensky.token',
      OS_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body,
      },
      45_000,
      2,
    ),
  );
  const j = (await r.json()) as { access_token: string; expires_in: number };
  const ttl = Math.max(60, (j.expires_in ?? 1800) - 60);
  await t.run('redis.set(token)', () =>
    redis.set('opensky:token', j.access_token, { ex: ttl }),
  );
  return j.access_token;
}

async function fetchOpenSky(t: Tracer, token: string, cfg: WatchConfig) {
  const box = bbox(cfg.lat, cfg.lon, cfg.radiusKm);
  const url =
    `https://opensky-network.org/api/states/all` +
    `?lamin=${box.lamin}&lomin=${box.lomin}&lamax=${box.lamax}&lomax=${box.lomax}`;
  const r = await t.run('opensky.states', () =>
    timedOpenSkyFetch(
      'opensky.states',
      url,
      { headers: { Authorization: `Bearer ${token}` } },
      30_000,
    ),
  );
  const j = (await r.json()) as { states: unknown[][] | null };
  return j.states ?? [];
}

function normalizeOpenSkyStates(states: unknown[][]): NormalizedAircraft[] {
  return states
    .filter(s => s[5] != null && s[6] != null)
    .map(s => ({
      icao24: s[0] as string,
      callsign: ((s[1] as string) || '').trim() || (s[0] as string).toUpperCase(),
      lat: s[6] as number,
      lon: s[5] as number,
      altM: (s[7] as number) ?? null,
      velMs: (s[9] as number) ?? null,
      heading: (s[10] as number) ?? null,
      knownType: null,
    }));
}

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

async function fetchAdsbLol(
  t: Tracer,
  cfg: WatchConfig,
): Promise<NormalizedAircraft[]> {
  const distNm = Math.round(cfg.radiusKm * 0.53996);
  const url = `https://api.adsb.lol/v2/lat/${cfg.lat}/lon/${cfg.lon}/dist/${distNm}`;
  const r = await t.run('adsb.lol.states', () =>
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

  try {
    const cfg = await t.run('redis.get(config)', () => getConfig());

    let aircraft: NormalizedAircraft[];
    let source = 'opensky';

    try {
      const token = await getOpenSkyToken(t);
      const states = await fetchOpenSky(t, token, cfg);
      aircraft = normalizeOpenSkyStates(states);
    } catch {
      t.steps.push({
        stage: 'opensky→adsb.lol',
        ms: 0,
        ok: true,
        detail: 'OpenSky unreachable, falling back to adsb.lol',
      });
      aircraft = await fetchAdsbLol(t, cfg);
      source = 'adsb.lol';
    }

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
      source,
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
    const extras =
      failed?.detail && failed?.stage
        ? openSkyErrorExtras(failed.stage, failed.detail)
        : {};
    return res.status(500).json({
      ok: false,
      stage: failed?.stage ?? 'unknown',
      error: errText,
      ...extras,
      totalMs: t.totalMs(),
      steps: t.steps,
    });
  }
}
