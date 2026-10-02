import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServiceCredential,
  getServiceCredentialByHash,
  listServiceCredentials,
  touchServiceCredential,
} from './db.js';

/**
 * Scoped service credentials (M7, the "scoped bridge" half).
 *
 * The service routes (`/api/internal/identity`, `/api/internal/audit`,
 * `/api/internal/alert`) are called by a sibling platform, never by browser JS.
 * They used to be gated by one account-wide token (`CONTROL_INTERNAL_TOKEN`):
 * every consumer shared it, and holding it meant resolving *any* account's key,
 * writing *any* audit row and reporting *any* outage — the blast radius was the
 * whole plane. This module replaces that with credentials bound to a surface
 * and an audience:
 *
 *   * a credential names the SURFACE it was issued to (`genie`);
 *   * it carries a set of SCOPES, and a route refuses a credential that lacks
 *     the scope it needs (403, distinct from "no credential" — 401);
 *   * it is issuable, revocable and optionally short-lived, because a caller
 *     that can be named can also be turned off.
 *
 * The legacy `CONTROL_INTERNAL_TOKEN` env value still works, deliberately, so
 * this ships without a flag day: it is accepted as a *bootstrap* credential
 * that carries every scope. That is a migration affordance, not the target
 * state — the roadmap retires it once the one surface (Genie) is issued a real
 * credential. `bootstrap` is reported as the surface so an audit of "who called
 * this" does not quietly credit the env token to a real surface.
 */

/** Every scope the plane understands, in one place so the CLI and HTTP agree. */
export const SCOPES = Object.freeze(['identity:resolve', 'audit:write', 'alert:report']);

export function isScope(value) {
  return SCOPES.includes(value);
}

/** The surface credited to callers presenting the legacy env token. */
export const BOOTSTRAP_SURFACE = 'bootstrap';

export function newServiceToken() {
  return randomBytes(32).toString('hex');
}

export function hashServiceToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Issue a credential. Returns the plaintext token exactly once — only its hash
 * is stored, so there is nothing to read back later and no lookup that can leak
 * it. Throws on an unknown scope rather than silently dropping it: a caller
 * that asked for a permission it did not get should hear so.
 */
export function issueServiceCredential({ surface, scopes, label = 'default', ttlMs = 0 }) {
  const name = String(surface || '').trim();
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(name)) {
    throw new Error('surface must be a lowercase name (e.g. genie)');
  }
  const wanted = Array.isArray(scopes) ? scopes : String(scopes || '').split(',');
  const list = [...new Set(wanted.map((s) => String(s).trim()).filter(Boolean))];
  if (list.length === 0) throw new Error('at least one scope is required');
  for (const scope of list) {
    if (!isScope(scope)) {
      throw new Error(`unknown scope '${scope}' (known: ${SCOPES.join(', ')})`);
    }
  }
  const token = newServiceToken();
  const expiresAt = ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null;
  const row = createServiceCredential({
    surface: name,
    label: String(label || 'default'),
    tokenHash: hashServiceToken(token),
    scopes: list,
    expiresAt,
  });
  return { credential: row, token };
}

/** A stored credential is live when it is neither revoked nor past its expiry. */
export function credentialIsLive(row, now = Date.now()) {
  if (!row || row.revoked_at) return false;
  if (!row.expires_at) return true;
  const expires = Date.parse(row.expires_at.includes('T') ? row.expires_at : row.expires_at.replace(' ', 'T') + 'Z');
  return Number.isFinite(expires) ? expires > now : false;
}

/** True if any caller could authenticate at all — env token or a live row. */
export function serviceAuthEnabled() {
  if (String(process.env.CONTROL_INTERNAL_TOKEN || '')) return true;
  return listServiceCredentials().some((row) => credentialIsLive(row));
}

function bootstrapMatch(provided) {
  const expected = String(process.env.CONTROL_INTERNAL_TOKEN || '');
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Resolve the service credential on a request, or null.
 *
 * Order matters: the bootstrap env token is compared in constant time and
 * short-circuits, so the DB is only consulted for issued credentials. A
 * credential that exists but is revoked/expired resolves to null — the same
 * answer as an unknown token, so nothing about a revoked credential's identity
 * leaks to its holder.
 */
export function authenticateService(req) {
  const header = req.headers?.['x-control-internal-token'];
  const provided = String(header || '');
  if (!provided) return null;

  if (bootstrapMatch(provided)) {
    return { surface: BOOTSTRAP_SURFACE, scopes: new Set(SCOPES), bootstrap: true };
  }

  const row = getServiceCredentialByHash(hashServiceToken(provided));
  if (!credentialIsLive(row)) return null;

  // Record use, best-effort: a failed touch must never fail the call it is
  // describing.
  try {
    touchServiceCredential(row.id);
  } catch {
    /* ignore */
  }
  return {
    surface: row.surface,
    scopes: new Set(String(row.scopes || '').split(',').filter(Boolean)),
    credentialId: row.id,
    bootstrap: false,
  };
}

/** Does this credential carry the scope the route needs? */
export function allowsScope(auth, scope) {
  return Boolean(auth && auth.scopes && auth.scopes.has(scope));
}
