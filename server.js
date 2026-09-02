import 'dotenv/config';
import express from 'express';
import { pool } from './db/pool.js';
import { hashPassword, verifyPassword, signSession, readSession } from './db/auth.js';

const app = express();
app.use(express.json());

// --- cookie parsing + session ---------------------------------------------
app.use((req, _res, next) => {
  const raw = req.headers.cookie || '';
  req.cookies = Object.fromEntries(
    raw.split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf('=');
        return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))];
      })
  );
  next();
});

app.use(async (req, _res, next) => {
  try {
    const id = readSession(req.cookies.sid);
    if (id) {
      const { rows } = await pool.query(
        'SELECT id, name, username, is_admin FROM users WHERE id = $1 AND active = true',
        [id]
      );
      req.user = rows[0] || null;
    }
  } catch (err) {
    console.error('session load failed', err);
  }
  next();
});

function setSession(res, userId) {
  res.cookie('sid', signSession(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: !!process.env.VERCEL,
    path: '/',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'לא מחובר' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'לא מחובר' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'למנהלים בלבד' });
  next();
}

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'שגיאת שרת' });
  });

// Start of the current betting window: the Friday of the previous week
// (weeks run Sun–Sat), inclusive — regardless of today's weekday. It is
// stable Sun-through-Sat and advances by a week each Sunday. Used for the
// roster icon crowd and the admin stats page.
const WINDOW_START_SQL =
  '(CURRENT_DATE - EXTRACT(DOW FROM CURRENT_DATE)::int - 2)';

// a bettor may change a given day's bet at most this many times
const BET_CHANGE_LIMIT = 3;

// --- health / diagnostics ----------------------------------------------
app.get('/api/health', async (_req, res) => {
  const url = process.env.DATABASE_URL || '';
  const host = (url.match(/@([^/:?]+)/) || [])[1] || null; // host only, no creds
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: rows[0].ok === 1, host });
  } catch (err) {
    res.status(500).json({ ok: false, host, error: err.message, code: err.code || null });
  }
});

// --- auth -----------------------------------------------------------------
// no self-registration: accounts are created in the admin console only
app.post('/api/auth/login', wrap(async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  const { rows } = await pool.query(
    'SELECT id, name, username, is_admin, active, password_hash FROM users WHERE lower(username) = lower($1)',
    [username]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
  }
  if (!user.active) {
    return res.status(403).json({ error: 'החשבון הושבת. פנה למנהל המערכת.' });
  }
  setSession(res, user.id);
  res.json({ id: user.id, name: user.name, username: user.username, is_admin: user.is_admin });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json(req.user || null);
});

// --- questions (bettor view) --------------------------------------------
app.get('/api/questions', requireAuth, wrap(async (req, res) => {
  const date = req.query.date || null; // YYYY-MM-DD, defaults to today
  const q = await pool.query(
    `SELECT id, event_date, text, status, correct_answer_id, position
       FROM questions
      WHERE event_date = COALESCE($1::date, CURRENT_DATE)
      ORDER BY position, id`,
    [date]
  );
  const ids = q.rows.map((r) => r.id);
  const answers = ids.length
    ? (await pool.query(
        `SELECT id, question_id, text, value::float8 AS value, position
           FROM answers WHERE question_id = ANY($1) ORDER BY position, id`,
        [ids]
      )).rows
    : [];
  // one bet per user per day
  const dayBet = (await pool.query(
    'SELECT question_id, answer_id, change_count FROM bets WHERE user_id = $1 AND event_date = COALESCE($2::date, CURRENT_DATE)',
    [req.user.id, date]
  )).rows[0] || null;

  res.json(q.rows.map((row) => ({
    ...row,
    my_answer_id: dayBet && dayBet.question_id === row.id ? dayBet.answer_id : null,
    my_bet_question_id: dayBet ? dayBet.question_id : null,
    my_bet_changes: dayBet ? dayBet.change_count : 0,
    answers: answers.filter((a) => a.question_id === row.id),
  })));
}));

app.get('/api/questions/dates', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT event_date, COUNT(*)::int AS count FROM questions GROUP BY event_date ORDER BY event_date DESC`
  );
  res.json(rows);
}));

// --- bets ---------------------------------------------------------------
app.post('/api/bets', requireAuth, wrap(async (req, res) => {
  const questionId = Number(req.body?.question_id);
  const answerId = Number(req.body?.answer_id);
  if (!Number.isInteger(questionId) || !Number.isInteger(answerId)) {
    return res.status(400).json({ error: 'question_id ו-answer_id נדרשים' });
  }
  const { rows } = await pool.query(
    `SELECT q.status, q.event_date, (q.event_date <> CURRENT_DATE) AS not_today, a.id AS answer_ok
       FROM questions q
       LEFT JOIN answers a ON a.id = $2 AND a.question_id = q.id
      WHERE q.id = $1`,
    [questionId, answerId]
  );
  if (!rows.length) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  if (!rows[0].answer_ok) return res.status(400).json({ error: 'התשובה לא שייכת לשאלה' });
  if (rows[0].not_today) return res.status(409).json({ error: 'ניתן להמר רק על אירועי היום' });
  if (rows[0].status !== 'open') return res.status(409).json({ error: 'ההימור על השאלה נסגר' });

  // one bet per user per day. The first placement is free; after that each
  // change to a different answer counts, and is capped at BET_CHANGE_LIMIT.
  const eventDate = rows[0].event_date;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query(
      'SELECT id, question_id, answer_id, change_count FROM bets WHERE user_id = $1 AND event_date = $2 FOR UPDATE',
      [req.user.id, eventDate]
    )).rows[0];

    let saved;
    if (!existing) {
      saved = (await client.query(
        `INSERT INTO bets (user_id, question_id, answer_id, event_date, change_count)
         VALUES ($1, $2, $3, $4, 0)
         RETURNING question_id, answer_id, change_count`,
        [req.user.id, questionId, answerId, eventDate]
      )).rows[0];
    } else if (existing.question_id === questionId && existing.answer_id === answerId) {
      saved = existing; // no actual change — leave the counter untouched
    } else if (existing.change_count >= BET_CHANGE_LIMIT) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'לא ניתן לשנות שוב את ההימור על אירוע זה' });
    } else {
      saved = (await client.query(
        `UPDATE bets SET question_id = $2, answer_id = $3,
                change_count = change_count + 1, updated_at = now()
          WHERE id = $1
          RETURNING question_id, answer_id, change_count`,
        [existing.id, questionId, answerId]
      )).rows[0];
    }
    await client.query('COMMIT');
    // reuse `client` (not pool.query): on Vercel the pool is capped at 1
    // connection, so asking the pool for another one here would deadlock
    // against the client we still hold until the finally block.
    const msg = await client.query('SELECT text FROM bet_messages ORDER BY random() LIMIT 1');
    let message = msg.rows[0]?.text ?? null;
    if (message) {
      message = message.includes('{name}')
        ? message.split('{name}').join(req.user.name)
        : `${req.user.name}, ${message}`;
    }
    res.json({
      question_id: saved.question_id,
      answer_id: saved.answer_id,
      change_count: saved.change_count,
      changes_left: Math.max(0, BET_CHANGE_LIMIT - saved.change_count),
      message,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

// --- roster (public: bettor names + score shown on the login page) --
// admins are management accounts, not participants — excluded here.
// score covers the current betting window only (see WINDOW_START_SQL),
// so the icon crowd reflects this round and rolls over each Sunday.
app.get('/api/users', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.is_admin, u.icon,
           COALESCE(SUM(
             CASE WHEN q.status = 'resolved' AND b.answer_id = q.correct_answer_id
                  THEN a.value ELSE 0 END
           ), 0)::float8 AS score
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
        AND b.event_date >= ${WINDOW_START_SQL}
        AND b.event_date <= CURRENT_DATE
      LEFT JOIN questions q ON q.id = b.question_id
      LEFT JOIN answers a ON a.id = b.answer_id
     WHERE u.is_admin = false AND u.active = true
     GROUP BY u.id
     ORDER BY u.id
  `);
  res.json(rows);
}));

// --- leaderboard (current betting window, same as WINDOW_START_SQL) ----
app.get('/api/leaderboard', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.username,
           COALESCE(SUM(
             CASE WHEN q.status = 'resolved' AND b.answer_id = q.correct_answer_id
                  THEN a.value ELSE 0 END
           ), 0)::float8 AS score,
           COUNT(b.id)::int AS bets_count,
           COUNT(*) FILTER (WHERE q.status = 'resolved' AND b.answer_id = q.correct_answer_id)::int AS hits
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
        AND b.event_date >= ${WINDOW_START_SQL}
        AND b.event_date <= CURRENT_DATE
      LEFT JOIN questions q ON q.id = b.question_id
      LEFT JOIN answers a ON a.id = b.answer_id
     WHERE u.is_admin = false AND u.active = true
     GROUP BY u.id
     ORDER BY score DESC, hits DESC, u.name ASC
  `);
  const range = (await pool.query(`
    SELECT ${WINDOW_START_SQL}::text AS start_date, CURRENT_DATE::text AS end_date
  `)).rows[0];
  res.json({ range, rows });
}));

// --- admin -----------------------------------------------------------
app.get('/api/admin/questions', requireAdmin, wrap(async (req, res) => {
  const date = req.query.date || null;
  const q = await pool.query(
    `SELECT id, event_date, text, status, correct_answer_id, position
       FROM questions
      WHERE event_date = COALESCE($1::date, CURRENT_DATE)
      ORDER BY position, id`,
    [date]
  );
  const ids = q.rows.map((r) => r.id);
  const answers = ids.length
    ? (await pool.query(
        `SELECT a.id, a.question_id, a.text, a.value::float8 AS value, a.position,
                COUNT(b.id)::int AS bet_count
           FROM answers a
           LEFT JOIN bets b ON b.answer_id = a.id
          WHERE a.question_id = ANY($1)
          GROUP BY a.id
          ORDER BY a.position, a.id`,
        [ids]
      )).rows
    : [];
  res.json(q.rows.map((row) => ({
    ...row,
    answers: answers.filter((a) => a.question_id === row.id),
  })));
}));

app.post('/api/admin/questions', requireAdmin, wrap(async (req, res) => {
  const text = (req.body?.text || '').trim();
  const eventDate = req.body?.event_date || null;
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  if (!text) return res.status(400).json({ error: 'טקסט שאלה נדרש' });
  const clean = answers
    .map((a) => ({ text: (a.text || '').trim(), value: Number(a.value) || 0 }))
    .filter((a) => a.text);
  if (clean.length < 2) return res.status(400).json({ error: 'נדרשות לפחות 2 תשובות' });

  const dateChk = await pool.query(
    'SELECT COALESCE($1::date, CURRENT_DATE) < CURRENT_DATE AS is_past',
    [eventDate]
  );
  if (dateChk.rows[0].is_past) {
    return res.status(400).json({ error: 'אפשר להוסיף אירוע רק להיום או לימים קדימה' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pos = await client.query(
      `SELECT COALESCE(MAX(position) + 1, 0) AS p FROM questions
        WHERE event_date = COALESCE($1::date, CURRENT_DATE)`,
      [eventDate]
    );
    const qr = await client.query(
      `INSERT INTO questions (event_date, text, position)
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3)
       RETURNING id, event_date, text, status, correct_answer_id, position`,
      [eventDate, text, pos.rows[0].p]
    );
    const question = qr.rows[0];
    const created = [];
    for (let i = 0; i < clean.length; i++) {
      const ar = await client.query(
        `INSERT INTO answers (question_id, text, value, position)
         VALUES ($1, $2, $3, $4) RETURNING id, question_id, text, value::float8 AS value, position`,
        [question.id, clean[i].text, clean[i].value, i]
      );
      created.push(ar.rows[0]);
    }
    await client.query('COMMIT');
    res.status(201).json({ ...question, answers: created });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}));

app.patch('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { text, event_date, status, correct_answer_id } = req.body || {};
  if (status && !['open', 'closed', 'resolved'].includes(status)) {
    return res.status(400).json({ error: 'סטטוס לא חוקי' });
  }

  const cur = await pool.query(
    'SELECT (event_date < CURRENT_DATE) AS is_past FROM questions WHERE id = $1',
    [id]
  );
  if (!cur.rows.length) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  const settingResult = status === 'resolved' || correct_answer_id != null;
  if (settingResult && !cur.rows[0].is_past) {
    return res.status(400).json({ error: 'ניתן להגדיר תוצאה רק לאירוע מיום שעבר' });
  }

  if (correct_answer_id != null) {
    const ok = await pool.query('SELECT 1 FROM answers WHERE id = $1 AND question_id = $2', [
      correct_answer_id, id,
    ]);
    if (!ok.rows.length) return res.status(400).json({ error: 'התשובה הנכונה לא שייכת לשאלה' });
  }
  const { rows } = await pool.query(
    `UPDATE questions SET
        text = COALESCE($2, text),
        event_date = COALESCE($3::date, event_date),
        status = COALESCE($4, status),
        correct_answer_id = CASE WHEN $5::int IS NULL THEN correct_answer_id ELSE $5::int END
      WHERE id = $1
      RETURNING id, event_date, text, status, correct_answer_id, position`,
    [id, text ?? null, event_date ?? null, status ?? null, correct_answer_id ?? null]
  );
  if (!rows.length) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  res.json(rows[0]);
}));

app.delete('/api/admin/questions/:id', requireAdmin, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM questions WHERE id = $1', [Number(req.params.id)]);
  res.json({ deleted: r.rowCount });
}));

// bettors on one event: their pick and how many changes they have used
app.get('/api/admin/questions/:id/bets', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.id, u.id AS user_id, u.name, u.icon,
            b.answer_id, a.text AS answer_text, b.change_count,
            (b.change_count >= $2) AS locked
       FROM bets b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN answers a ON a.id = b.answer_id
      WHERE b.question_id = $1
      ORDER BY u.name`,
    [Number(req.params.id), BET_CHANGE_LIMIT]
  );
  res.json(rows);
}));

// grant a bettor BET_CHANGE_LIMIT more changes on this event (unlock)
app.post('/api/admin/bets/:id/grant-changes', requireAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE bets SET change_count = GREATEST(0, change_count - $2), updated_at = now()
      WHERE id = $1
      RETURNING id, change_count`,
    [Number(req.params.id), BET_CHANGE_LIMIT]
  );
  if (!rows.length) return res.status(404).json({ error: 'הימור לא נמצא' });
  res.json({
    ...rows[0],
    changes_left: Math.max(0, BET_CHANGE_LIMIT - rows[0].change_count),
    locked: rows[0].change_count >= BET_CHANGE_LIMIT,
  });
}));

app.post('/api/admin/questions/:id/answers', requireAdmin, wrap(async (req, res) => {
  const qid = Number(req.params.id);
  const text = (req.body?.text || '').trim();
  const value = Number(req.body?.value) || 0;
  if (!text) return res.status(400).json({ error: 'טקסט תשובה נדרש' });
  const q = await pool.query('SELECT 1 FROM questions WHERE id = $1', [qid]);
  if (!q.rows.length) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  const pos = await pool.query(
    'SELECT COALESCE(MAX(position) + 1, 0) AS p FROM answers WHERE question_id = $1',
    [qid]
  );
  const { rows } = await pool.query(
    `INSERT INTO answers (question_id, text, value, position) VALUES ($1, $2, $3, $4)
     RETURNING id, question_id, text, value::float8 AS value, position`,
    [qid, text, value, pos.rows[0].p]
  );
  res.status(201).json(rows[0]);
}));

app.patch('/api/admin/answers/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const text = req.body?.text != null ? String(req.body.text).trim() : null;
  const value = req.body?.value != null ? Number(req.body.value) : null;
  const { rows } = await pool.query(
    `UPDATE answers SET
        text = COALESCE($2, text),
        value = COALESCE($3, value)
      WHERE id = $1
      RETURNING id, question_id, text, value::float8 AS value, position`,
    [id, text, value]
  );
  if (!rows.length) return res.status(404).json({ error: 'תשובה לא נמצאה' });
  res.json(rows[0]);
}));

app.delete('/api/admin/answers/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const cnt = await pool.query('SELECT COUNT(*)::int AS c FROM answers WHERE question_id = (SELECT question_id FROM answers WHERE id = $1)', [id]);
  if (cnt.rows[0]?.c <= 2) return res.status(409).json({ error: 'חייבות להישאר לפחות 2 תשובות' });
  const r = await pool.query('DELETE FROM answers WHERE id = $1', [id]);
  res.json({ deleted: r.rowCount });
}));

app.get('/api/admin/users', requireAdmin, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.username, u.is_admin, u.icon, u.active, u.created_at,
           COUNT(b.id)::int AS bets_count
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id
  `);
  res.json(rows);
}));

// every bet, per bettor — which event, what they picked, how it turned out
app.get('/api/admin/bets', requireAdmin, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT b.id, b.event_date, b.created_at,
           u.id AS user_id, u.name AS user_name, u.username, u.icon,
           q.id AS question_id, q.text AS question_text, q.status,
           a.text AS answer_text, a.value::float8 AS value,
           ca.text AS correct_answer_text,
           (q.status = 'resolved' AND q.correct_answer_id IS NOT NULL) AS resolved,
           (q.status = 'resolved' AND b.answer_id = q.correct_answer_id) AS is_hit
      FROM bets b
      JOIN users u ON u.id = b.user_id
      JOIN questions q ON q.id = b.question_id
      JOIN answers a ON a.id = b.answer_id
      LEFT JOIN answers ca ON ca.id = q.correct_answer_id
     WHERE u.is_admin = false
     ORDER BY u.name, b.event_date DESC NULLS LAST, q.position, q.id
  `);
  res.json(rows);
}));

// bettor stats for the current betting window: from the previous week's
// Friday (inclusive) through today, regardless of today's weekday.
app.get('/api/admin/stats', requireAdmin, wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    WITH win AS (
      SELECT ${WINDOW_START_SQL} AS start_date, CURRENT_DATE AS end_date
    )
    SELECT u.id, u.name, u.username, u.icon,
           COUNT(b.id)::int AS bets,
           COUNT(*) FILTER (
             WHERE q.status = 'resolved' AND q.correct_answer_id IS NOT NULL
           )::int AS resolved,
           COUNT(*) FILTER (
             WHERE q.status = 'resolved' AND b.answer_id = q.correct_answer_id
           )::int AS hits,
           COUNT(*) FILTER (
             WHERE b.id IS NOT NULL AND (q.status <> 'resolved' OR q.correct_answer_id IS NULL)
           )::int AS pending,
           COALESCE(SUM(
             CASE WHEN q.status = 'resolved' AND b.answer_id = q.correct_answer_id
                  THEN a.value ELSE 0 END
           ), 0)::float8 AS score
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
        AND b.event_date >= (SELECT start_date FROM win)
        AND b.event_date <= (SELECT end_date FROM win)
      LEFT JOIN questions q ON q.id = b.question_id
      LEFT JOIN answers a ON a.id = b.answer_id
     WHERE u.is_admin = false AND u.active = true
     GROUP BY u.id
     ORDER BY score DESC, hits DESC, u.name ASC
  `);
  const range = (await pool.query(`
    SELECT ${WINDOW_START_SQL}::text AS start_date, CURRENT_DATE::text AS end_date
  `)).rows[0];
  res.json({ range, rows });
}));

app.post('/api/admin/users', requireAdmin, wrap(async (req, res) => {
  const name = (req.body?.name || '').trim();
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  const isAdmin = !!req.body?.is_admin;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'שם, שם משתמש וסיסמה נדרשים' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'סיסמה קצרה מדי (לפחות 4 תווים)' });
  const taken = await pool.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  if (taken.rows.length) return res.status(409).json({ error: 'שם המשתמש תפוס' });
  const { rows } = await pool.query(
    `INSERT INTO users (name, username, password_hash, is_admin) VALUES ($1, $2, $3, $4)
     RETURNING id, name, username, is_admin, created_at`,
    [name, username, hashPassword(password), isAdmin]
  );
  res.status(201).json({ ...rows[0], bets_count: 0 });
}));

app.patch('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const body = req.body || {};
  const name = body.name != null ? String(body.name).trim() : null;
  const password = body.password || null;
  const isAdmin = body.is_admin;
  const active = typeof body.active === 'boolean' ? body.active : null;
  const hasIcon = Object.prototype.hasOwnProperty.call(body, 'icon');
  const icon = hasIcon ? (String(body.icon || '').slice(0, 16) || null) : null;
  if (id === req.user.id && isAdmin === false) {
    return res.status(400).json({ error: 'אי אפשר להסיר לעצמך הרשאת ניהול' });
  }
  if (id === req.user.id && active === false) {
    return res.status(400).json({ error: 'אי אפשר להשבית את המשתמש שלך' });
  }
  if (password != null && password.length < 4) {
    return res.status(400).json({ error: 'סיסמה קצרה מדי (לפחות 4 תווים)' });
  }
  const { rows } = await pool.query(
    `UPDATE users SET
        name = COALESCE($2, name),
        is_admin = COALESCE($3, is_admin),
        password_hash = COALESCE($4, password_hash),
        icon = CASE WHEN $5 THEN $6 ELSE icon END,
        active = COALESCE($7, active)
      WHERE id = $1
      RETURNING id, name, username, is_admin, icon, active, created_at`,
    [id, name, typeof isAdmin === 'boolean' ? isAdmin : null, password ? hashPassword(password) : null, hasIcon, icon, active]
  );
  if (!rows.length) return res.status(404).json({ error: 'משתמש לא נמצא' });
  res.json(rows[0]);
}));

app.delete('/api/admin/users/:id', requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'אי אפשר למחוק את המשתמש שלך' });
  const r = await pool.query('DELETE FROM users WHERE id = $1', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'משתמש לא נמצא' });
  res.json({ deleted: r.rowCount });
}));

// --- editable text pools: bet_messages (popup after a bet) + daily_tips --
function textPoolRoutes(path, table, label) {
  app.get(`/api/admin/${path}`, requireAdmin, wrap(async (_req, res) => {
    const { rows } = await pool.query(`SELECT id, text, position FROM ${table} ORDER BY position, id`);
    res.json(rows);
  }));
  app.post(`/api/admin/${path}`, requireAdmin, wrap(async (req, res) => {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'טקסט נדרש' });
    const pos = await pool.query(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM ${table}`);
    const { rows } = await pool.query(
      `INSERT INTO ${table} (text, position) VALUES ($1, $2) RETURNING id, text, position`,
      [text, pos.rows[0].p]
    );
    res.status(201).json(rows[0]);
  }));
  app.patch(`/api/admin/${path}/:id`, requireAdmin, wrap(async (req, res) => {
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'טקסט נדרש' });
    const { rows } = await pool.query(
      `UPDATE ${table} SET text = $2 WHERE id = $1 RETURNING id, text, position`,
      [Number(req.params.id), text]
    );
    if (!rows.length) return res.status(404).json({ error: `${label} לא נמצא` });
    res.json(rows[0]);
  }));
  app.delete(`/api/admin/${path}/:id`, requireAdmin, wrap(async (req, res) => {
    const r = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [Number(req.params.id)]);
    if (!r.rowCount) return res.status(404).json({ error: `${label} לא נמצא` });
    res.json({ deleted: r.rowCount });
  }));
}
textPoolRoutes('bet-messages', 'bet_messages', 'פריט');
textPoolRoutes('daily-tips', 'daily_tips', 'טיפ');

app.get('/api/daily-tip', requireAuth, wrap(async (_req, res) => {
  const { rows } = await pool.query('SELECT text FROM daily_tips ORDER BY random() LIMIT 1');
  res.json({ text: rows[0]?.text ?? null });
}));

// --- static (local dev only; on Vercel public/ is served as static assets) --
app.use(express.static('public'));

// On Vercel the app is imported by api/index.js as a serverless handler.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 8000;
  app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));
}

export default app;
