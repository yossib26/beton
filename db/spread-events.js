// Enforce one event per day: any day with more than one event keeps the
// first (by position, id) and pushes the rest onto the next free days.
// Bets move with their question (bets.event_date is kept in sync).
import { pool } from './pool.js';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT id, event_date::text AS event_date
         FROM questions ORDER BY event_date, position, id`
    );
    if (!rows.length) { console.log('no events'); await client.query('COMMIT'); return; }

    const taken = new Set(rows.map((r) => r.event_date));
    const nextFreeAfter = (dateStr) => {
      const d = new Date(dateStr + 'T00:00:00');
      do { d.setDate(d.getDate() + 1); } while (taken.has(d.toISOString().slice(0, 10)));
      const s = d.toISOString().slice(0, 10);
      taken.add(s);
      return s;
    };

    const seenDay = new Set();
    let moved = 0;
    for (const q of rows) {
      if (!seenDay.has(q.event_date)) { seenDay.add(q.event_date); continue; }
      const dest = nextFreeAfter(q.event_date);
      await client.query('UPDATE questions SET event_date = $1 WHERE id = $2', [dest, q.id]);
      await client.query('UPDATE bets SET event_date = $1 WHERE question_id = $2', [dest, q.id]);
      moved++;
    }

    await client.query('COMMIT');
    console.log(`moved ${moved} event(s) so every day has at most one`);

    const summary = await pool.query(
      `SELECT event_date, COUNT(*)::int AS n FROM questions
        GROUP BY event_date HAVING COUNT(*) > 1`
    );
    console.log(summary.rows.length ? summary.rows : 'clean — 1 event per day');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
