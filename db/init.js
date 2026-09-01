import { pool } from './pool.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const SEED = [
  ['Yossi Basson', 'oriki.basson@gmail.com'],
  ['Dana Levi', 'dana.levi@example.com'],
  ['Avi Cohen', 'avi.cohen@example.com'],
];

async function main() {
  await pool.query(SCHEMA);
  for (const [name, email] of SEED) {
    await pool.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
      [name, email]
    );
  }
  const { rows } = await pool.query('SELECT id, name, email, created_at FROM users ORDER BY id');
  console.log('users table ready:');
  console.table(rows);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
