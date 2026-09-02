import 'dotenv/config';
import pg from 'pg';

// return DATE (oid 1082) as a plain 'YYYY-MM-DD' string, not a TZ-shifted Date
pg.types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Locally: copy .env.example to .env. On Vercel: add it in Project Settings → Environment Variables.');
}

// Reuse one pool across warm serverless invocations.
export const pool =
  globalThis.__betonPool ??
  (globalThis.__betonPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: process.env.VERCEL ? 1 : 10,
    // fail fast instead of hanging the whole serverless invocation when the
    // database is unreachable (wrong DATABASE_URL, Neon IP-allow list, …)
    connectionTimeoutMillis: 8000,
  }));
