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
        'SELECT id, name, username, is_admin FROM users WHERE id = $1',
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

// --- auth -----------------------------------------------------------------
// no self-registration: accounts are created in the admin console only
app.post('/api/auth/login', wrap(async (req, res) => {
  const username = (req.body?.username || '').trim();
  const password = req.body?.password || '';
  const { rows } = await pool.query(
    'SELECT id, name, username, is_admin, password_hash FROM users WHERE lower(username) = lower($1)',
    [username]
  );
  const user = rows[0];
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'שם משתמש או סיסמה שגויים' });
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
  const myBets = ids.length
    ? (await pool.query(
        'SELECT question_id, answer_id FROM bets WHERE user_id = $1 AND question_id = ANY($2)',
        [req.user.id, ids]
      )).rows
    : [];
  const betByQ = Object.fromEntries(myBets.map((b) => [b.question_id, b.answer_id]));

  res.json(q.rows.map((row) => ({
    ...row,
    my_answer_id: betByQ[row.id] ?? null,
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
    `SELECT q.status, (q.event_date <> CURRENT_DATE) AS not_today, a.id AS answer_ok
       FROM questions q
       LEFT JOIN answers a ON a.id = $2 AND a.question_id = q.id
      WHERE q.id = $1`,
    [questionId, answerId]
  );
  if (!rows.length) return res.status(404).json({ error: 'שאלה לא נמצאה' });
  if (!rows[0].answer_ok) return res.status(400).json({ error: 'התשובה לא שייכת לשאלה' });
  if (rows[0].not_today) return res.status(409).json({ error: 'ניתן להמר רק על אירועי היום' });
  if (rows[0].status !== 'open') return res.status(409).json({ error: 'ההימור על השאלה נסגר' });

  const saved = await pool.query(
    `INSERT INTO bets (user_id, question_id, answer_id) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, question_id)
     DO UPDATE SET answer_id = EXCLUDED.answer_id, updated_at = now()
     RETURNING question_id, answer_id`,
    [req.user.id, questionId, answerId]
  );
  res.json(saved.rows[0]);
}));

// --- roster (public: bettor names + score shown on the login page) --
// admins are management accounts, not participants — excluded here
app.get('/api/users', wrap(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id, u.name, u.is_admin, u.icon,
           COALESCE(SUM(
             CASE WHEN q.status = 'resolved' AND b.answer_id = q.correct_answer_id
                  THEN a.value ELSE 0 END
           ), 0)::float8 AS score
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
      LEFT JOIN questions q ON q.id = b.question_id
      LEFT JOIN answers a ON a.id = b.answer_id
     WHERE u.is_admin = false
     GROUP BY u.id
     ORDER BY u.id
  `);
  res.json(rows);
}));

// --- leaderboard ------------------------------------------------------
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
      LEFT JOIN questions q ON q.id = b.question_id
      LEFT JOIN answers a ON a.id = b.answer_id
     WHERE u.is_admin = false
     GROUP BY u.id
     ORDER BY score DESC, hits DESC, u.name ASC
  `);
  res.json(rows);
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
    SELECT u.id, u.name, u.username, u.is_admin, u.icon, u.created_at,
           COUNT(b.id)::int AS bets_count
      FROM users u
      LEFT JOIN bets b ON b.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id
  `);
  res.json(rows);
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
  const hasIcon = Object.prototype.hasOwnProperty.call(body, 'icon');
  const icon = hasIcon ? (String(body.icon || '').slice(0, 16) || null) : null;
  if (id === req.user.id && isAdmin === false) {
    return res.status(400).json({ error: 'אי אפשר להסיר לעצמך הרשאת ניהול' });
  }
  if (password != null && password.length < 4) {
    return res.status(400).json({ error: 'סיסמה קצרה מדי (לפחות 4 תווים)' });
  }
  const { rows } = await pool.query(
    `UPDATE users SET
        name = COALESCE($2, name),
        is_admin = COALESCE($3, is_admin),
        password_hash = COALESCE($4, password_hash),
        icon = CASE WHEN $5 THEN $6 ELSE icon END
      WHERE id = $1
      RETURNING id, name, username, is_admin, icon, created_at`,
    [id, name, typeof isAdmin === 'boolean' ? isAdmin : null, password ? hashPassword(password) : null, hasIcon, icon]
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

// --- static (local dev only; on Vercel public/ is served as static assets) --
app.use(express.static('public'));

// On Vercel the app is imported by api/index.js as a serverless handler.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 8000;
  app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));
}

export default app;
