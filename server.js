import 'dotenv/config';
import express from 'express';
import { pool } from './db/pool.js';

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/users', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, created_at FROM users ORDER BY id'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/api/users', async (req, res) => {
  const { name, email } = req.body ?? {};
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, email, created_at`,
      [name, email]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'db error' });
  }
});

const port = process.env.PORT || 8000;
app.listen(port, () => console.log(`listening on http://127.0.0.1:${port}`));
