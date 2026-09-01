import crypto from 'node:crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${dk}`;
}

export function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, salt, dk] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !dk) return false;
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(dk, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function signSession(userId) {
  const payload = String(userId);
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function readSession(token) {
  if (!token) return null;
  const [payload, mac] = String(token).split('.');
  if (!payload || !mac) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const id = Number(payload);
  return Number.isInteger(id) ? id : null;
}
