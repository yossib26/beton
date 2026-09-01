// Seed demo questions. Demo texts are prefixed with "[דמו] " so a re-run
// replaces only the demo rows in the same time window (future or past).
//
//   node db/seed-demo.js                 -> 10 days forward, 3/day (30), status open
//   node db/seed-demo.js --past          -> 10 days back,    2/day (20), status resolved
//   node db/seed-demo.js --days 5 --per-day 2 --past
import { pool } from './pool.js';

const args = process.argv.slice(2);
const past = args.includes('--past');
const argVal = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};

const DAYS = argVal('days', 10);
const PER_DAY = argVal('per-day', past ? 2 : 3);
const PREFIX = '[דמו] ';

const TEAMS = [
  'הפועל ת"א', 'מכבי חיפה', 'בית"ר ירושלים', 'מכבי ת"א', 'הפועל באר שבע',
  'בני סכנין', 'הפועל חיפה', 'מ.ס אשדוד', 'מכבי נתניה', 'הפועל ירושלים',
];
const pair = (i) => [TEAMS[i % TEAMS.length], TEAMS[(i + 3) % TEAMS.length]];

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
      `DELETE FROM questions
        WHERE text LIKE $1
          AND event_date ${past ? '< CURRENT_DATE' : '>= CURRENT_DATE'}`,
      [PREFIX + '%']
    );
    console.log(`removed ${del.rowCount} existing demo questions (${past ? 'past' : 'today onward'})`);

    // deterministic pseudo-random in [0,1)
    const rnd = (n) => { const x = Math.sin(n) * 43758.5453; return x - Math.floor(x); };

    const users = past
      ? (await client.query('SELECT id FROM users WHERE is_admin = false ORDER BY id')).rows.map((r) => r.id)
      : [];
    let bets = 0;

    let created = 0;
    for (let d = 0; d < DAYS; d++) {
      const dayOffset = past ? -(d + 1) : d; // past: yesterday .. -DAYS
      for (let s = 0; s < PER_DAY; s++) {
        const idx = d * PER_DAY + s;
        const [a, b] = pair(idx);
        const g = generators[(past ? idx : s) % generators.length](a, b);

        const qr = await client.query(
          `INSERT INTO questions (event_date, text, status, position)
           VALUES (CURRENT_DATE + $1::int, $2, $3, $4)
           RETURNING id`,
          [dayOffset, PREFIX + g.text, past ? 'resolved' : 'open', s]
        );
        const qid = qr.rows[0].id;

        const answerIds = [];
        for (let i = 0; i < g.answers.length; i++) {
          const ar = await client.query(
            `INSERT INTO answers (question_id, text, value, position)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [qid, g.answers[i].text, g.answers[i].value, i]
          );
          answerIds.push(ar.rows[0].id);
        }

        if (past) {
          // deterministic "correct" answer so the leaderboard has data
          const correctIdx = (idx * 7 + 2) % answerIds.length;
          await client.query('UPDATE questions SET correct_answer_id = $1 WHERE id = $2', [answerIds[correctIdx], qid]);

          // demo bets: each user bets on ~half the questions, with a
          // per-user "skill" driving how often they pick the right answer
          for (const uid of users) {
            if (rnd(uid * 7 + qid * 13) >= 0.55) continue;
            const skill = 0.3 + rnd(uid * 101) * 0.5; // 0.30–0.80
            let pick;
            if (rnd(uid * 3 + qid * 17) < skill) {
              pick = answerIds[correctIdx];
            } else {
              const wrong = answerIds.filter((_, i) => i !== correctIdx);
              pick = wrong[Math.floor(rnd(uid * 5 + qid * 11) * wrong.length)];
            }
            await client.query(
              `INSERT INTO bets (user_id, question_id, answer_id) VALUES ($1, $2, $3)
               ON CONFLICT (user_id, question_id) DO NOTHING`,
              [uid, qid, pick]
            );
            bets++;
          }
        }
        created++;
      }
    }

    await client.query('COMMIT');
    console.log(`created ${created} demo questions across ${DAYS} days (${PER_DAY}/day, status ${past ? 'resolved' : 'open'})`);
    if (past) console.log(`created ${bets} demo bets across ${users.length} users`);

    const summary = await pool.query(
      `SELECT event_date, COUNT(*)::int AS questions,
              MIN(status) AS status
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
