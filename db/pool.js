import 'dotenv/config';
import pg from 'pg';

// return DATE (oid 1082) as a plain 'YYYY-MM-DD' string, not a TZ-shifted Date
pg.types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
