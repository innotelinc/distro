/**
 * Resolve `vault://` references into the environment, once, before anything
 * reads it.
 *
 * WHY THIS IS ITS OWN MODULE, IMPORTED FIRST. Every config module here
 * (`oidc.js`, `billing.js`, `server.js`, …) reads `process.env` at module scope,
 * and ESM evaluates an import graph depth-first in order: importing this module
 * ahead of the others means the values they capture are already resolved. A
 * resolution step run later — from inside `server.js`'s body, or from a
 * `--import` preload that ran after the graph — would be too late, and the
 * symptom is not an error but a literal `vault://…` string used as a client
 * secret, which fails somewhere far away with a message that names nothing.
 *
 * `.env` keeps carrying references:
 *
 *   OIDC_CLIENT_SECRET=vault://cerulean/distro#OIDC_CLIENT_SECRET
 *   MAGNATE_ENTITLEMENTS_TOKEN=vault://cerulean/distro#MAGNATE_ENTITLEMENTS_TOKEN
 *   INITIAL_PASSWORD=vault://cerulean/distro#INITIAL_PASSWORD
 *   OPENAI_LIKE_API_KEY=vault://cerulean/distro#OPENAI_LIKE_API_KEY
 *
 * Any value that is a reference is resolved, wherever it came from — `.env`,
 * compose's `environment:` block (which turns `INITIAL_PASSWORD` into
 * `GATEWAY_ADMIN_PASSWORD` and passes the reference through unresolved), or the
 * operator's shell. There is no key list to keep in sync, and a value that is
 * not a reference is never touched.
 *
 * A reference that cannot be resolved is fatal: this service would otherwise
 * start healthy and fail at the first login, token rotation or Magnate call.
 * The failure names the environment KEY, never the value.
 */

import process from 'node:process';

import { parseVaultRef, resolveSecretValue, vaultEnabled } from './vault.js';

/** Every environment key whose value is a `vault://` reference. */
export function vaultReferences(env = process.env) {
  return Object.entries(env)
    .filter(([, value]) => parseVaultRef(value) !== undefined)
    .map(([key]) => key);
}

/**
 * Replace each `vault://` value in `env` with the secret it references.
 * Returns the keys that were resolved.
 */
export async function resolveVaultEnv(env = process.env) {
  const keys = vaultReferences(env);
  if (keys.length === 0) return [];
  if (!vaultEnabled(env)) {
    throw new Error(
      `${keys.length} value(s) reference Cerulean Vault (${keys.join(', ')}) but ` +
        'VAULT_ADDR and VAULT_TOKEN/VAULT_TOKEN_FILE are not configured',
    );
  }
  for (const key of keys) {
    env[key] = await resolveSecretValue(env[key], env);
  }
  return keys;
}

// Resolved on import — this module's whole job is to have run before the next
// import does. Key names only; values are never printed.
try {
  const resolved = await resolveVaultEnv();
  if (resolved.length > 0) {
    console.log(`[control-plane] resolved ${resolved.length} secret(s) from Cerulean Vault: ${resolved.join(', ')}`);
  }
} catch (err) {
  console.error(`[control-plane] secret resolution failed: ${err.message}`);
  process.exit(1);
}
