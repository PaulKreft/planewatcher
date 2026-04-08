# A380 spotter — backend

Polls OpenSky every minute for aircraft within a radius of you, looks them up on hexdb.io, and pings Slack the first time it sees an A380. Same shape as your Stripe → Slack pipeline.

## Setup

1. **Create the Vercel project** — push this folder to a new repo and import it on Vercel. No build step needed.

2. **Add Upstash Redis** — Vercel marketplace → Upstash → create a free database → connect it to the project. The `UPSTASH_REDIS_REST_*` vars will be injected automatically.

3. **OpenSky account** — register at https://opensky-network.org/, then add `OPENSKY_USER` / `OPENSKY_PASS` as env vars. Anonymous limits are too tight for per-minute polling; with an account you get ~4000 requests/day on the bbox endpoint, which is plenty.

4. **Slack webhook** — reuse the workspace from your Stripe pipeline, create a new channel like `#a380`, add an incoming webhook, paste the URL into `SLACK_WEBHOOK_URL`.

5. **Set `WATCH_LAT` / `WATCH_LON`** — the defaults in `.env.example` are roughly Köln centre. Adjust if you'd rather watch your apartment specifically.

6. **Set `CRON_SECRET`** — any long random string. Used for external pinger auth (see below).

## Cron

`vercel.json` declares a one-minute cron, but **Vercel Hobby only allows daily crons**. Two options:

- **Upgrade to Pro** — minute-level crons just work, the `vercel.json` is already correct.
- **Stay on Hobby** — delete `vercel.json` and use a free external pinger like cron-job.org. Point it at `https://your-app.vercel.app/api/spot` with header `Authorization: Bearer YOUR_CRON_SECRET`, schedule every 1 minute. The handler accepts both Vercel cron and bearer-auth requests.

## How dedupe works

Each detected A380's `icao24` is written to Redis with `SET NX EX 21600`. If the key already exists (same plane seen in the last 6h), the SET returns null and we skip. This means a plane circling overhead won't spam you, but the same airframe passing tomorrow will re-alert.

Type lookups are cached for 30 days, miss-lookups for 1 day — keeps hexdb.io traffic minimal.

## Tuning

- `WATCH_RADIUS_KM` — 50 km is generous. Drop to 20–30 if you only want planes you'd plausibly see/hear.
- `ALERT_TTL_SECONDS` in `api/spot.ts` — raise to dedupe more aggressively, lower if you want every fresh sighting.
- Pattern `^A38` in the regex catches `A388` (passenger) and `A38F` (freighter — none currently fly, but futureproof).

## Test it

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-app.vercel.app/api/spot
```

Returns `{ ok: true, checked: N, alerted: [...] }`. Check the Vercel function logs to see what was filtered out.
# planewatcher
