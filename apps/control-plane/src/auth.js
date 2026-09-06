import { createHash, randomBytes } from 'node:crypto';
import { createSession, getUserBySession, deleteSession } from './db.js';

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function newSessionToken() {
  return randomBytes(32).toString('hex');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function openSession(userId) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  createSession(userId, hashToken(token), expiresAt);
  return token;
}

export function currentUser(req) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  return getUserBySession(hashToken(token));
}

export function closeSession(req) {
  const header = req.headers.authorization || '';
  const [, token] = header.split(' ');
  if (token) deleteSession(hashToken(token));
}

export function requireAdmin(req) {
  const user = currentUser(req);
  return user?.role === 'admin' ? user : null;
}
