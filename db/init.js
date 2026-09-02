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
ALTER TABLE users ADD COLUMN IF NOT EXISTS icon TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
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
  event_date  DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, question_id)
);

-- one bet per user per day (not per question)
ALTER TABLE bets ADD COLUMN IF NOT EXISTS event_date DATE;
UPDATE bets b SET event_date = q.event_date
  FROM questions q WHERE q.id = b.question_id AND b.event_date IS NULL;
DELETE FROM bets a USING bets b
 WHERE a.user_id = b.user_id AND a.event_date = b.event_date
   AND a.event_date IS NOT NULL
   AND (a.updated_at, a.id) < (b.updated_at, b.id);
ALTER TABLE bets DROP CONSTRAINT IF EXISTS bets_user_id_question_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS bets_user_day_key ON bets (user_id, event_date);
-- how many times the bettor has changed this day's bet (max 3, enforced in the API)
ALTER TABLE bets ADD COLUMN IF NOT EXISTS change_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS bet_messages (
  id         SERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS daily_tips (
  id         SERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`;

const SEED_DAILY_TIPS = [
  'קבע לעצמך תקציב יומי ואל תחרוג ממנו — משמעת שווה יותר ממזל.',
  'הימור מהלב לרוב מפסיד. בדוק נתונים לפני שאתה מהמר.',
  'רצף הפסדים? קח הפסקה. רדיפה אחרי הפסד היא הדרך הבטוחה להפסיד עוד.',
  'יחס תשלום גבוה = סיכוי נמוך. אל תתפתה רק לזכייה הגדולה.',
  'עקוב אחרי ההימורים שלך — סטטיסטיקה אישית חושפת דפוסים שלא שמת לב אליהם.',
  'אף אחד לא צודק תמיד. גם 55% הצלחה זו תוצאה מצוינת לאורך זמן.',
  'אל תהמר תחת השפעה של אלכוהול, כעס או התלהבות יתר.',
  'מידע מוקדם שווה זהב — פציעות, הרכבים ומזג אוויר משפיעים על התוצאה.',
  'הימור הוא בידור, לא מקור הכנסה. תתייחס אליו ככה.',
  'עדיף פיזור קטן על פני הכול על קלף אחד — סיכון מרוכז נגמר רע.',
];

const SEED_BET_MESSAGES = [
  'הימור אמיץ, {name}! או טיפשי. נראה מחר 🤡',
  '{name}, רשמנו. אם תפסיד — לא הכרנו 🙈',
  'ההימור נשמר. אמא של {name} גאה (כנראה) 🏆',
  'בחירה מעניינת, {name}... אמרנו מעניינת, לא חכמה 🧠',
  '{name}, יאללה — עכשיו רק להתפלל ⚽🙏',
  'ההימור נקלט. הביטחון העצמי של {name} מעורר השראה 😎',
  '{name}, שמור על קור רוח. וגם על הכסף שאין לך 💸',
  'בום! {name} הימר. הבורסה מקנאה 📈',
  'נשמר בהצלחה. גורלו של {name} נחתם ✍️😈',
  '{name}, חבל שאי אפשר להמר על זה שתפסיד 😏',
];

const SEED_USERS = [
  { name: 'Yossi Basson', email: 'oriki.basson@gmail.com', username: 'yossi', password: 'beton123', is_admin: true },
  { name: 'Dana Levi', email: 'dana.levi@example.com', username: 'dana', password: 'beton123', is_admin: false },
  { name: 'Avi Cohen', email: 'avi.cohen@example.com', username: 'avi', password: 'beton123', is_admin: false },
  { name: 'Noa Bar', email: 'noa.bar@example.com', username: 'noa', password: 'beton123', is_admin: false },
  { name: 'Tomer Gal', email: 'tomer.gal@example.com', username: 'tomer', password: 'beton123', is_admin: false },
  { name: 'Shira Peled', email: 'shira.peled@example.com', username: 'shira', password: 'beton123', is_admin: false },
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

  const haveMsgs = await pool.query('SELECT COUNT(*)::int AS c FROM bet_messages');
  if (haveMsgs.rows[0].c === 0) {
    for (let i = 0; i < SEED_BET_MESSAGES.length; i++) {
      await pool.query('INSERT INTO bet_messages (text, position) VALUES ($1, $2)', [SEED_BET_MESSAGES[i], i]);
    }
    console.log(`seeded ${SEED_BET_MESSAGES.length} bet messages`);
  }

  const haveTips = await pool.query('SELECT COUNT(*)::int AS c FROM daily_tips');
  if (haveTips.rows[0].c === 0) {
    for (let i = 0; i < SEED_DAILY_TIPS.length; i++) {
      await pool.query('INSERT INTO daily_tips (text, position) VALUES ($1, $2)', [SEED_DAILY_TIPS[i], i]);
    }
    console.log(`seeded ${SEED_DAILY_TIPS.length} daily tips`);
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
