import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD!;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers.authorization !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Upstash returns list items already parsed when they were stored as JSON strings.
  // Defensive parse in case of mixed types.
  const raw = await redis.lrange<string | object>('sightings', 0, 99);
  const sightings = raw.map((item) =>
    typeof item === 'string' ? JSON.parse(item) : item
  );
  return res.status(200).json({ sightings });
}
