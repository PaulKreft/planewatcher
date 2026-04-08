import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;

function isAuthed(req: VercelRequest) {
  return req.headers.authorization === `Bearer ${ADMIN_PASSWORD}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD not set' });
  }
  if (!isAuthed(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (req.method === 'GET') {
    const stored = await redis.get<{ lat: number; lon: number; radiusKm: number }>('config');
    const config = stored ?? {
      lat: parseFloat(process.env.WATCH_LAT ?? '50.9375'),
      lon: parseFloat(process.env.WATCH_LON ?? '6.9603'),
      radiusKm: parseFloat(process.env.WATCH_RADIUS_KM ?? '50'),
    };
    return res.status(200).json(config);
  }

  if (req.method === 'POST') {
    const body = req.body as { lat?: unknown; lon?: unknown; radiusKm?: unknown };
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const radiusKm = Number(body.radiusKm);

    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      return res.status(400).json({ error: 'lat must be a number between -90 and 90' });
    }
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'lon must be a number between -180 and 180' });
    }
    if (!Number.isFinite(radiusKm) || radiusKm < 5 || radiusKm > 300) {
      return res.status(400).json({ error: 'radiusKm must be a number between 5 and 300' });
    }

    const config = { lat, lon, radiusKm };
    await redis.set('config', config);
    return res.status(200).json({ ok: true, config });
  }

  return res.status(405).json({ error: 'method not allowed' });
}
