import { pool } from './pool.js';
import { hashPassword } from './auth.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT,
  username      TEXT,
  password_hash TEXT,
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS questions (
  id                SERIAL PRIMARY KEY,
  event_date        DATE NOT NULL DEFAULT CURRENT_DATE,
  text              TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  correct_answer_id INTEGER,
  position          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS answers (
  id          SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  value       NUMERIC NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_correct_answer_fk') THEN
    ALTER TABLE questions ADD CONSTRAINT questions_correct_answer_fk
      FOREIGN KEY (correct_answer_id) REFERENCES answers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS bets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answer_id   INTEGER NOT NULL REFERENCES answers(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);
`;

const SEED_USERS = [
  { name: 'Yossi Basson', email: 'oriki.basson@gmail.com', username: 'yossi', password: 'beton123', is_admin: true },
  { name: 'Dana Levi', email: 'dana.levi@example.com', username: 'dana', password: 'beton123', is_admin: false },
  { name: 'Avi Cohen', email: 'avi.cohen@example.com', username: 'avi', password: 'beton123', is_admin: false },
];

async function main() {
  await pool.query(SCHEMA);

  for (const u of SEED_USERS) {
    const existing = await pool.query(
      'SELECT id FROM users WHERE email = $1 OR lower(username) = lower($2) LIMIT 1',
      [u.email, u.username]
    );
    if (existing.rows.length) {
      await pool.query(
        `UPDATE users SET name = $1,
                username = COALESCE(username, $2),
                password_hash = COALESCE(password_hash, $3),
                is_admin = $4
         WHERE id = $5`,
        [u.name, u.username, hashPassword(u.password), u.is_admin, existing.rows[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO users (name, email, username, password_hash, is_admin)
         VALUES ($1, $2, $3, $4, $5)`,
        [u.name, u.email, u.username, hashPassword(u.password), u.is_admin]
      );
    }
  }

  const { rows } = await pool.query(
    'SELECT id, name, username, is_admin FROM users ORDER BY id'
  );
  console.log('schema ready. users:');
  console.table(rows);
  console.log('\nseed logins (username / password): yossi/beton123 (admin), dana/beton123, avi/beton123');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
