// Seed demo questions: 3 per day, 10 days forward from today.
// All demo question texts are prefixed with "[דמו] " so a re-run replaces only demo rows.
import { pool } from './pool.js';

const DAYS = 10;
const PER_DAY = 3;
const PREFIX = '[דמו] ';

const TEAMS = [
  'הפועל ת"א', 'מכבי חיפה', 'בית"ר ירושלים', 'מכבי ת"א', 'הפועל באר שבע',
  'בני סכנין', 'הפועל חיפה', 'מ.ס אשדוד', 'מכבי נתניה', 'הפועל ירושלים',
];

const pair = (i) => [TEAMS[i % TEAMS.length], TEAMS[(i + 3) % TEAMS.length]];

// three question generators, one used per slot each day
const generators = [
  (a, b) => ({
    text: `${a} מול ${b} — מה תהיה התוצאה?`,
    answers: [
      { text: `ניצחון ${a}`, value: 3 },
      { text: 'תיקו', value: 4 },
      { text: `ניצחון ${b}`, value: 3 },
    ],
  }),
  (a, b) => ({
    text: `כמה שערים יירשמו במשחק ${a}–${b}?`,
    answers: [
      { text: '0–1 שערים', value: 3 },
      { text: '2–3 שערים', value: 2 },
      { text: '4 ומעלה', value: 5 },
    ],
  }),
  (a, b) => ({
    text: `האם יוצג כרטיס אדום ב-${a}–${b}?`,
    answers: [
      { text: 'כן', value: 4 },
      { text: 'לא', value: 1 },
    ],
  }),
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const del = await client.query(
      `DELETE FROM questions WHERE text LIKE $1 AND event_date >= CURRENT_DATE`,
      [PREFIX + '%']
    );
    console.log(`removed ${del.rowCount} existing demo questions (today onward)`);

    let created = 0;
    for (let d = 0; d < DAYS; d++) {
      for (let s = 0; s < PER_DAY; s++) {
        const idx = d * PER_DAY + s;
        const [a, b] = pair(idx);
        const g = generators[s % generators.length](a, b);

        const qr = await client.query(
          `INSERT INTO questions (event_date, text, position)
           VALUES (CURRENT_DATE + $1::int, $2, $3)
           RETURNING id`,
          [d, PREFIX + g.text, s]
        );
        const qid = qr.rows[0].id;
        for (let i = 0; i < g.answers.length; i++) {
          await client.query(
            `INSERT INTO answers (question_id, text, value, position) VALUES ($1, $2, $3, $4)`,
            [qid, g.answers[i].text, g.answers[i].value, i]
          );
        }
        created++;
      }
    }

    await client.query('COMMIT');
    console.log(`created ${created} demo questions across ${DAYS} days (${PER_DAY}/day)`);

    const summary = await pool.query(
      `SELECT event_date, COUNT(*)::int AS questions
         FROM questions WHERE text LIKE $1
        GROUP BY event_date ORDER BY event_date`,
      [PREFIX + '%']
    );
    console.table(summary.rows);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
