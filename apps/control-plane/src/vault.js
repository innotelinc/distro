/**
 * Cerulean Vault client (HashiCorp Vault, KV v2) — the control plane's half of
 * SecretOps.
 *
 * Cerulean is the platform's secret store; Distro's `.env` carries references
 * rather than values:
 *
 *   OIDC_CLIENT_SECRET=vault://cerulean/distro#OIDC_CLIENT_SECRET
 *
 * `vault://<mount>/<path>#<key>` is the convention the whole stack resolves at
 * startup, so the platform and this service agree on one format. The same
 * contract is implemented in Cerulean (`server/src/services/vault.ts`, the
 * reference resolver) and read by `scripts/vault-migrate.py`, which is what
 * moves values in.
 *
 * Configuration comes from the environment, all of it optional:
 *
 *   VAULT_ADDR          base URL, e.g. http://vault:8200
 *   VAULT_TOKEN         inline token, or…
 *   VAULT_TOKEN_FILE    …a file containing one (preferred; the CLI reads it too)
 *   VAULT_PREFIX        KV v2 mount point, default "cerulean"
 *   VAULT_PATH          this product's path under the mount, default "distro"
 *   VAULT_NAMESPACE     Enterprise namespaces; unused on OSS Vault
 *   VAULT_SKIP_VERIFY   "1" to accept a self-signed certificate
 *   VAULT_CACERT        CA bundle to pin instead
 *
 * Nothing here logs a value: failures name the path and the key, never the
 * secret. See docs/stack.md and docs/ops.md.
 */

import { readFile } from 'node:fs/promises';
import process from 'node:process';

const DEFAULT_PREFIX = 'cerulean';
const DEFAULT_PATH = 'distro';
const REQUEST_TIMEOUT_MS = 15_000;

/** Parse `vault://<mount>/<path>#<key>`. Returns undefined for anything else. */
export function parseVaultRef(value) {
  if (typeof value !== 'string' || !value.startsWith('vault://')) return undefined;
  const rest = value.slice('vault://'.length);
  const hash = rest.indexOf('#');
  const location = (hash === -1 ? rest : rest.slice(0, hash)).replace(/^\/+|\/+$/g, '').trim();
  if (!location) return undefined;
  const slash = location.indexOf('/');
  const mount = (slash === -1 ? location : location.slice(0, slash)).trim();
  const path = (slash === -1 ? '' : location.slice(slash + 1)).replace(/^\/+|\/+$/g, '').trim();
  if (!mount) return undefined;
  return { mount, path, key: hash === -1 ? undefined : rest.slice(hash + 1).trim() };
}

/** The Vault environment this process sees, with the platform defaults applied. */
export function vaultConfig(env = process.env) {
  const prefix = (env.VAULT_PREFIX || '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_PREFIX;
  const path = (env.VAULT_PATH || '').trim().replace(/^\/+|\/+$/g, '') || DEFAULT_PATH;
  return {
    addr: (env.VAULT_ADDR || '').trim().replace(/\/+$/, ''),
    token: (env.VAULT_TOKEN || '').trim(),
    tokenFile: (env.VAULT_TOKEN_FILE || '').trim(),
    prefix,
    path,
    namespace: (env.VAULT_NAMESPACE || '').trim(),
    skipVerify: ['1', 'true', 'yes'].includes((env.VAULT_SKIP_VERIFY || '').trim().toLowerCase()),
    caCert: (env.VAULT_CACERT || '').trim(),
  };
}

/** True when a reference CAN be resolved (an address and some credential). */
export function vaultEnabled(env = process.env) {
  const cfg = vaultConfig(env);
  return Boolean(cfg.addr && (cfg.token || cfg.tokenFile));
}

/** The token, read from VAULT_TOKEN or the file VAULT_TOKEN_FILE names. */
async function readToken(cfg) {
  if (cfg.token) return cfg.token;
  if (!cfg.tokenFile) {
    throw new Error('no Vault token: set VAULT_TOKEN, or VAULT_TOKEN_FILE to a file containing one');
  }
  let raw;
  try {
    raw = await readFile(cfg.tokenFile, 'utf8');
  } catch (err) {
    throw new Error(`cannot read VAULT_TOKEN_FILE (${cfg.tokenFile}): ${err.message}`);
  }
  const token = raw.trim();
  if (!token) throw new Error(`VAULT_TOKEN_FILE (${cfg.tokenFile}) is empty`);
  return token;
}

/** Read every key of the KV v2 secret at `<mount>/<path>`. */
export async function readKV(mount, path, env = process.env) {
  const cfg = vaultConfig(env);
  if (!cfg.addr) throw new Error('VAULT_ADDR is not set');
  if (!mount || !path) throw new Error(`vault path is incomplete: mount=${mount} path=${path}`);

  const token = await readToken(cfg);
  const url = `${cfg.addr}/v1/${mount}/data/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

  let res;
  try {
    res = await fetch(url, {
      headers: {
        'X-Vault-Token': token,
        Accept: 'application/json',
        ...(cfg.namespace ? { 'X-Vault-Namespace': cfg.namespace } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`vault read ${mount}/${path} failed: ${err.message}`);
  }

  if (res.status === 404) throw new Error(`vault secret not found: ${mount}/${path}`);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`vault read ${mount}/${path} failed (HTTP ${res.status}): ${detail}`);
  }

  const body = await res.json().catch(() => null);
  const data = body?.data?.data;
  if (data === undefined) {
    throw new Error(
      `vault read ${mount}/${path} did not answer as KV v2 (no data.data) — ` +
        'point VAULT_PREFIX at the KV v2 mount',
    );
  }
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = typeof value === 'string' ? value : JSON.stringify(value);
  }
  return out;
}

/**
 * Resolve a single .env-style value. A `vault://` reference reads from Cerulean
 * Vault; anything else is returned unchanged.
 *
 * Throws rather than returning an empty string: every caller is resolving a
 * credential, and an empty one fails later with a message that does not name
 * the secret.
 */
export async function resolveSecretValue(value, env = process.env) {
  const ref = parseVaultRef(value);
  if (!ref) return value;
  if (!vaultEnabled(env)) {
    throw new Error(
      `value references Cerulean Vault but VAULT_ADDR and VAULT_TOKEN/VAULT_TOKEN_FILE are not configured`,
    );
  }
  const secret = await readKV(ref.mount, ref.path, env);
  if (ref.key) {
    if (!(ref.key in secret)) {
      throw new Error(`vault secret ${ref.mount}/${ref.path} has no key "${ref.key}"`);
    }
    return secret[ref.key];
  }
  const first = Object.values(secret)[0];
  if (first === undefined) throw new Error(`vault secret ${ref.mount}/${ref.path} is empty`);
  return first;
}

/**
 * Health check — "ok", "not-configured", or "error: <detail>". Never throws.
 *
 * The probe is this stack's OWN path: a path-scoped token cannot read an
 * unrelated one, and reporting an error for a working store would be worse than
 * reporting nothing. A 404 is a pass — it proves the data endpoint and the
 * credential both work, which is all this reports.
 */
export async function vaultStatus(env = process.env) {
  if (!vaultEnabled(env)) return 'not-configured';
  const cfg = vaultConfig(env);
  try {
    await readKV(cfg.prefix, cfg.path, env);
    return 'ok';
  } catch (err) {
    if (/not found/.test(err.message)) return 'ok';
    return `error: ${err.message}`;
  }
}
