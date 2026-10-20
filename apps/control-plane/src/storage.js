// Where a pool's bytes actually live.
//
// A provider is a *connection* and a pool is a *place* inside it — the schema has
// said so since the storage tables were added, but nothing ever read them, so an
// operator could create both and still have nowhere to put a file. This is the half
// that turns the two rows into a working store.
//
// TWO KINDS, ON PURPOSE:
//
//   **local** — a folder on this host (inside `CONTROL_POOL_ROOT`, default
//   `/data/pools`). That is what a pool gets today, and it is deliberately a plain
//   directory: a deployment can back it with whatever mount it likes later without
//   changing a row. The root is resolved and re-checked so a `..` in a pool's
//   root_path cannot reach the rest of the volume.
//
//   **gcs** — Google Cloud Storage, spoken to over its JSON API with a service
//   account. No SDK: the signing is one RS256 JWT and four REST calls, and adding a
//   multi-megabyte dependency to a stdlib-plus-one package to do it would be the
//   larger cost. The credential is read from the file named by the provider's
//   `credential_ref` (or `GCS_SERVICE_ACCOUNT_JSON`), and the token is cached until
//   shortly before it expires.
//
// Every operation takes a pool row (as `listStoragePools` returns it, with the
// provider's columns joined in), so the caller never passes a path or a bucket: the
// route layer decides *which* pool, and this module decides *how* to reach it.

import { readFileSync } from 'node:fs';
import { createHash, createHmac, createSign } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, normalize, resolve, sep } from 'node:path';

/** Where local pools live when `CONTROL_POOL_ROOT` is not set. */
export const DEFAULT_POOL_ROOT = '/data/pools';

/**
 * Provider kinds this module can actually reach.
 *
 * `nfs` is a mounted share, and it is not `local` for one reason that matters when
 * something breaks: the directory can exist, look empty and fail every write
 * because the server is unreachable (`Transport endpoint is not connected`). The
 * kind reads the mount table so a probe can say "not mounted" instead of reporting
 * an empty pool.
 */
export const KINDS = ['local', 'nfs', 's3', 'gcs'];

export class StorageError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * A provider field, read from the pool row.
 *
 * `listStoragePools` joins the provider in, so endpoint/bucket/region arrive as
 * `provider_*`. The unprefixed name is still accepted because a caller can hand this
 * module a provider-shaped object (the seed does, before a pool exists).
 */
export function providerField(pool, name) {
  return pool[`provider_${name}`] ?? pool[name];
}

export function poolRootDir() {
  return process.env.CONTROL_POOL_ROOT || DEFAULT_POOL_ROOT;
}

/**
 * The absolute directory a local pool writes into.
 *
 * `root_path` is relative to the pool root by design: a row cannot point the plane
 * at `/etc`, and an absolute path is refused rather than silently re-rooted.
 */
export function localPoolDir(pool) {
  const root = poolRootDir();
  const rel = String(pool.root_path || pool.name || '').trim();
  if (!rel) throw new StorageError('this pool has no root_path');
  if (isAbsolute(rel)) throw new StorageError('root_path must be relative to the pool root');
  const dir = resolve(join(root, normalize(rel)));
  if (dir !== resolve(root) && !dir.startsWith(resolve(root) + sep)) {
    throw new StorageError('root_path leaves the pool root');
  }
  return dir;
}

/** A key that is safe to join onto a pool: no absolute paths, no `..` segments. */
export function normalizeKey(key) {
  const clean = String(key || '').replace(/^\/+/, '');
  if (!clean) throw new StorageError('a key is required');
  const parts = clean.split('/');
  if (parts.some((part) => part === '..' || part === '.' || part === '')) {
    throw new StorageError('the key must be a relative path without empty or parent segments');
  }
  return parts.join('/');
}

function isGcs(pool) {
  return String(pool.provider_type || '') === 'gcs';
}

function isNfs(pool) {
  return String(pool.provider_type || '') === 'nfs';
}

function isS3(pool) {
  return String(pool.provider_type || '') === 's3';
}

/**
 * The mount a directory lives on, from `/proc/self/mountinfo`.
 *
 * Longest mountpoint wins, because a mount inside a mount is the one that matters
 * for a path. Parsed rather than shelled out: `findmnt` is not in every image, and
 * this is one file read with a fixed shape.
 */
export function mountFor(dir, mountinfo = null) {
  const table = mountinfo || readFileSync('/proc/self/mountinfo', 'utf8');
  const target = resolve(dir);
  let best = null;
  for (const line of table.split('\n')) {
    if (!line.trim()) continue;
    const [before, after] = line.split(' - ');
    if (!before || !after) continue;
    const fields = before.split(' ');
    const tail = after.split(' ');
    const mountpoint = fields[4];
    if (!mountpoint || !tail[0]) continue;
    const root = resolve(mountpoint);
    const inside = target === root || target.startsWith(root + sep);
    if (!inside) continue;
    if (!best || root.length > resolve(best.mountpoint).length) {
      best = { mountpoint: root, fstype: tail[0], source: tail[1] || '' };
    }
  }
  return best;
}

function assertNfsMounted(pool, dir) {
  const mount = mountFor(dir);
  if (!mount || !/^nfs/.test(mount.fstype)) {
    throw new StorageError(
      `the onyx share is not mounted at ${dir}` +
        (mount ? ` (it is on ${mount.fstype})` : ' (nothing is mounted there)'),
      503,
    );
  }
  return mount;
}

// ── local ───────────────────────────────────────────────────────────────────

async function localPut(pool, key, body) {
  const dir = localPoolDir(pool);
  const target = join(dir, normalizeKey(key));
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, body);
  return { location: `local://${pool.name}/${normalizeKey(key)}` };
}

async function localGet(pool, key) {
  const target = join(localPoolDir(pool), normalizeKey(key));
  return readFile(target);
}

async function localDelete(pool, key) {
  const target = join(localPoolDir(pool), normalizeKey(key));
  await rm(target, { force: true });
}

async function localList(pool, prefix = '') {
  const dir = localPoolDir(pool);
  const out = [];
  async function walk(current, rel) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const child = join(current, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child, childRel);
      else out.push(childRel);
    }
  }
  await walk(dir, '');
  return out.filter((key) => key.startsWith(prefix)).sort();
}

async function localStat(pool) {
  const dir = localPoolDir(pool);
  const mount = mountFor(dir);
  try {
    const info = await stat(dir);
    return {
      exists: info.isDirectory(),
      detail: dir,
      fstype: mount ? mount.fstype : null,
      source: mount ? mount.source : null,
    };
  } catch {
    return { exists: false, detail: dir, fstype: mount ? mount.fstype : null, source: mount ? mount.source : null };
  }
}

// ── s3 ──────────────────────────────────────────────────────────────────────
//
// Onyx runs an S3-compatible object store (port 2090) and this estate already has
// credentials for it in the Vault (`cerulean/distro`, keys `SHARES_S3_*`). That is
// the pool "from onyx" that works everywhere: an NFS share has to be mounted, and
// this deployment runs where the mount syscall is refused, while S3 is one HTTPS
// request.
//
// SigV4 written out rather than an SDK: it is four HMACs and a canonical request,
// and the alternative is an eight-megabyte dependency for one adapter. Path-style
// addressing (`/bucket/key`) because that is what MinIO serves.

const sha256Hex = (body) => createHash('sha256').update(body).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

/**
 * The credential pair for an S3 pool.
 *
 * `credential_ref` names the Vault *prefix* (`vault://cerulean/distro#SHARES_S3`),
 * and the two halves are its `_ACCESS_KEY` / `_SECRET_KEY` keys — so a provider row
 * never contains a secret, only where to find one.
 */
export async function s3Credentials(pool, env = process.env) {
  const { resolveSecretValue } = await import('./vault.js');
  const ref = String(providerField(pool, 'credential_ref') || '').trim() || 'vault://cerulean/distro#SHARES_S3';
  // A `vault://` ref is resolved from the store; any other ref names environment
  // variables (a deployment that keeps its keys in the environment rather than the
  // Vault gets the same adapter).
  const read = async (name) => (name.startsWith('vault://')
    ? resolveSecretValue(name, env)
    : env[name]);
  const accessKey = await read(`${ref}_ACCESS_KEY`);
  const secretKey = await read(`${ref}_SECRET_KEY`);
  if (!accessKey || !secretKey) {
    throw new StorageError('this S3 provider has no credentials (credential_ref must resolve to an access/secret pair)');
  }
  return { accessKey, secretKey };
}

function s3Target(pool) {
  const endpoint = String(providerField(pool, 'endpoint') || '').trim().replace(/\/+$/, '');
  if (!endpoint) throw new StorageError('this S3 provider has no endpoint');
  const bucket = String(providerField(pool, 'bucket') || '').trim();
  if (!bucket) throw new StorageError('this S3 provider has no bucket');
  return { url: new URL(endpoint), bucket };
}

/** The object key a pool's root prefix and a caller's key combine into. */
function s3ObjectKey(pool, key) {
  const prefix = String(pool.root_path || '').trim().replace(/^\/+|\/+$/g, '');
  const name = normalizeKey(key);
  return prefix ? `${prefix}/${name}` : name;
}

async function s3Request(pool, method, { key = '', query = new URLSearchParams(), body = Buffer.alloc(0), fetchImpl = fetch } = {}) {
  const { url, bucket } = s3Target(pool);
  const { accessKey, secretKey } = await s3Credentials(pool);
  const path = `/${bucket}${key ? '/' + key.split('/').map(encodeURIComponent).join('/') : ''}`;
  const payloadHash = sha256Hex(body);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const region = String(providerField(pool, 'region') || 'us-east-1');
  const canonicalQuery = [...query.entries()]
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .sort()
    .join('&');
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const target = `${url.origin}${path}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
  return fetchImpl(target, {
    method,
    headers: {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      ...(method === 'PUT' ? { 'content-length': String(body.length) } : {}),
    },
    body: method === 'PUT' ? body : undefined,
  });
}

async function s3Put(pool, key, body, fetchImpl = fetch) {
  const object = s3ObjectKey(pool, key);
  const response = await s3Request(pool, 'PUT', { key: object, body, fetchImpl });
  if (!response.ok) throw new StorageError(`S3 upload failed (${response.status})`, 502);
  return { location: `s3://${providerField(pool, 'bucket')}/${object}` };
}

async function s3Get(pool, key, fetchImpl = fetch) {
  const response = await s3Request(pool, 'GET', { key: s3ObjectKey(pool, key), fetchImpl });
  if (!response.ok) throw new StorageError(`S3 read failed (${response.status})`, 502);
  return Buffer.from(await response.arrayBuffer());
}

async function s3Delete(pool, key, fetchImpl = fetch) {
  const response = await s3Request(pool, 'DELETE', { key: s3ObjectKey(pool, key), fetchImpl });
  if (!response.ok && response.status !== 404) throw new StorageError(`S3 delete failed (${response.status})`, 502);
}

async function s3List(pool, prefix = '', fetchImpl = fetch) {
  const base = String(pool.root_path || '').trim().replace(/^\/+|\/+$/g, '');
  const query = new URLSearchParams({ 'list-type': '2', max_keys: '200' });
  const full = [base, prefix].filter(Boolean).join('/');
  if (full) query.set('prefix', full);
  const response = await s3Request(pool, 'GET', { query, fetchImpl });
  if (!response.ok) throw new StorageError(`S3 list failed (${response.status})`, 502);
  const text = await response.text();
  return [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]);
}

async function s3Stat(pool, fetchImpl = fetch) {
  try {
    const response = await s3Request(pool, 'HEAD', { fetchImpl });
    return {
      exists: response.ok,
      detail: `${providerField(pool, 'endpoint')}/${providerField(pool, 'bucket')}${pool.root_path ? '/' + pool.root_path : ''}`,
      status: response.status,
    };
  } catch (error) {
    return { exists: false, detail: error.message };
  }
}

// ── gcs ─────────────────────────────────────────────────────────────────────

let tokenCache = { key: null, token: '', expiresAt: 0 };

function credentialFile(pool) {
  return String(providerField(pool, 'credential_ref') || '').trim() || process.env.GCS_SERVICE_ACCOUNT_JSON || '';
}

export async function gcsServiceAccount(pool) {
  const file = credentialFile(pool);
  if (!file) {
    throw new StorageError('this provider has no service-account file (set credential_ref or GCS_SERVICE_ACCOUNT_JSON)');
  }
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    throw new StorageError(`cannot read the service-account file ${basename(file)}: ${error.message}`);
  }
  let account;
  try {
    account = JSON.parse(raw);
  } catch (error) {
    throw new StorageError(`the service-account file is not JSON: ${error.message}`);
  }
  if (!account.client_email || !account.private_key) {
    throw new StorageError('the service-account file has no client_email/private_key');
  }
  return account;
}

/**
 * An OAuth token for the storage scope, from a service-account JWT.
 *
 * Cached per credential file for its lifetime minus a minute: a probe and an upload
 * in the same minute should not sign twice, and a cached token five seconds from
 * expiry is a request that fails for no reason an operator can see.
 */
export async function gcsToken(pool, { fetchImpl = fetch, now = Date.now() } = {}) {
  const account = await gcsServiceAccount(pool);
  const cacheKey = credentialFile(pool);
  if (tokenCache.key === cacheKey && tokenCache.token && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }
  const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
  const issuedAt = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      aud: tokenUri,
     iat: issuedAt,
      exp: issuedAt + 3600,
    }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${signer.sign(account.private_key, 'base64url')}`;

  const response = await fetchImpl(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new StorageError(`Google refused the service account (${response.status}): ${body.error_description || body.error || 'no token'}`, 502);
  }
  tokenCache = {
    key: cacheKey,
    token: body.access_token,
    expiresAt: now + Number(body.expires_in || 3600) * 1000,
  };
  return tokenCache.token;
}

function gcsBucket(pool) {
  const bucket = String(providerField(pool, 'bucket') || '').trim();
  if (!bucket) throw new StorageError('this provider has no bucket');
  return bucket;
}

async function gcsCall(pool, path, init = {}, fetchImpl = fetch) {
  const token = await gcsToken(pool, { fetchImpl });
  const response = await fetchImpl(`https://storage.googleapis.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) },
  });
  return response;
}

async function gcsPut(pool, key, body, fetchImpl = fetch) {
  const name = normalizeKey(key);
  const prefix = String(pool.root_path || '').trim().replace(/^\/+|\/+$/g, '');
  const object = prefix ? `${prefix}/${name}` : name;
  const response = await gcsCall(
    pool,
    `/upload/storage/v1/b/${gcsBucket(pool)}/o?uploadType=media&name=${encodeURIComponent(object)}`,
    { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body },
    fetchImpl,
  );
  if (!response.ok) throw new StorageError(`GCS upload failed (${response.status})`, 502);
  return { location: `gs://${gcsBucket(pool)}/${object}` };
}

async function gcsGet(pool, key, fetchImpl = fetch) {
  const prefix = String(pool.root_path || '').trim().replace(/^\/+|\/+$/g, '');
  const name = normalizeKey(key);
  const object = prefix ? `${prefix}/${name}` : name;
  const response = await gcsCall(
    pool,
    `/storage/v1/b/${gcsBucket(pool)}/o/${encodeURIComponent(object)}?alt=media`,
    {},
    fetchImpl,
  );
  if (!response.ok) throw new StorageError(`GCS read failed (${response.status})`, 502);
  return Buffer.from(await response.arrayBuffer());
}

async function gcsDelete(pool, key, fetchImpl = fetch) {
  const prefix = String(pool.root_path || '').trim().replace(/^\/+|\/+$/g, '');
  const name = normalizeKey(key);
  const object = prefix ? `${prefix}/${name}` : name;
  const response = await gcsCall(
    pool,
    `/storage/v1/b/${gcsBucket(pool)}/o/${encodeURIComponent(object)}`,
    { method: 'DELETE' },
    fetchImpl,
  );
  if (!response.ok && response.status !== 404) {
    throw new StorageError(`GCS delete failed (${response.status})`, 502);
  }
}

async function gcsList(pool, prefix = '', fetchImpl = fetch) {
  const base = String(pool.root_path || '').trim().replace(/^\/+|\/+$/g, '');
  const query = new URLSearchParams({
    maxResults: '200',
    ...(base || prefix ? { prefix: [base, prefix].filter(Boolean).join('/') } : {}),
  });
  const response = await gcsCall(pool, `/storage/v1/b/${gcsBucket(pool)}/o?${query}`, {}, fetchImpl);
  if (!response.ok) throw new StorageError(`GCS list failed (${response.status})`, 502);
  const body = await response.json().catch(() => ({}));
  return (body.items || []).map((item) => item.name);
}

async function gcsStat(pool, fetchImpl = fetch) {
  try {
    const response = await gcsCall(pool, `/storage/v1/b/${gcsBucket(pool)}`, {}, fetchImpl);
    return { exists: response.ok, detail: `gs://${gcsBucket(pool)}${pool.root_path ? '/' + pool.root_path : ''}` };
  } catch (error) {
    return { exists: false, detail: error.message };
  }
}

// ── the surface the routes use ──────────────────────────────────────────────

function adapter(pool) {
  const kind = String(pool.provider_type);
  if (!KINDS.includes(kind)) {
    throw new StorageError(
      `provider kind "${kind}" is not one this plane can reach (known: ${KINDS.join(', ')})`,
    );
  }
  if (isS3(pool)) {
    return {
      put: (key, body, fetchImpl) => s3Put(pool, key, body, fetchImpl),
      get: (key, fetchImpl) => s3Get(pool, key, fetchImpl),
      delete: (key, fetchImpl) => s3Delete(pool, key, fetchImpl),
      list: (prefix, fetchImpl) => s3List(pool, prefix, fetchImpl),
      stat: (fetchImpl) => s3Stat(pool, fetchImpl),
    };
  }
  if (isGcs(pool)) {
    return {
      put: (key, body, fetchImpl) => gcsPut(pool, key, body, fetchImpl),
      get: (key, fetchImpl) => gcsGet(pool, key, fetchImpl),
      delete: (key, fetchImpl) => gcsDelete(pool, key, fetchImpl),
      list: (prefix, fetchImpl) => gcsList(pool, prefix, fetchImpl),
      stat: (fetchImpl) => gcsStat(pool, fetchImpl),
    };
  }
  // A local or NFS pool: the same file operations, with the mount checked first
  // for NFS so a dead share is a 503 that says so, not an empty directory.
  const guard = (fn) => async (...args) => {
    if (isNfs(pool)) assertNfsMounted(pool, localPoolDir(pool));
    return fn(...args);
  };
  return {
    put: guard((key, body) => localPut(pool, key, body)),
    get: guard((key) => localGet(pool, key)),
    delete: guard((key) => localDelete(pool, key)),
    list: guard((prefix) => localList(pool, prefix)),
    stat: async () => {
      if (isNfs(pool)) {
        const dir = localPoolDir(pool);
        const mount = mountFor(dir);
        const mounted = !!(mount && /^nfs/.test(mount.fstype));
        return {
          exists: mounted,
          detail: dir,
          fstype: mount ? mount.fstype : null,
          source: mount ? mount.source : null,
          mounted,
        };
      }
      return localStat(pool);
    },
  };
}

export async function poolStat(pool, options = {}) {
  return adapter(pool).stat(options.fetchImpl);
}

export async function putObject(pool, key, body, options = {}) {
  return adapter(pool).put(key, body, options.fetchImpl);
}

export async function getObject(pool, key, options = {}) {
  return adapter(pool).get(key, options.fetchImpl);
}

export async function deleteObject(pool, key, options = {}) {
  return adapter(pool).delete(key, options.fetchImpl);
}

export async function listObjects(pool, prefix = '', options = {}) {
  return adapter(pool).list(prefix, options.fetchImpl);
}

/**
 * Write, read back and remove one small object.
 *
 * This is the only honest answer to "is this pool wired?": a provider row can be
 * created with a bucket that does not exist, and a folder can be a path the
 * process may not write. Both look identical in a table, and differ here.
 */
export async function probePool(pool, options = {}) {
  const state = await poolStat(pool, options);
  if (isNfs(pool) && !state.mounted) {
    throw new StorageError(
      `the share is not mounted at ${state.detail}` +
        (state.fstype ? ` (it is on ${state.fstype})` : ' (nothing is mounted there)'),
      503,
    );
  }
  const key = `probe/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const body = Buffer.from(`distro probe ${new Date().toISOString()}\n`);
  const written = await putObject(pool, key, body, options);
  let read;
  try {
    read = await getObject(pool, key, options);
  } finally {
    await deleteObject(pool, key, options).catch(() => {});
  }
  const ok = Buffer.isBuffer(read) && read.length === body.length;
  return {
    ok,
    key,
    bytes: body.length,
    location: written.location,
    mount: state,
    detail: ok ? 'wrote, read back and removed one object' : 'the object read back did not match what was written',
  };
}

/** Make a local pool's folder, so a new pool is usable before its first write. */
export async function preparePool(pool) {
  if (isS3(pool)) {
    const state = await s3Stat(pool);
    // A bucket is not this plane's to create: it belongs to the store, and a
    // silently-created bucket with these credentials would be a different place
    // than the one an operator meant.
    return { ...state, created: false };
  }
  if (isGcs(pool)) {
    const state = await gcsStat(pool);
    return { ...state, created: false };
  }
  const dir = localPoolDir(pool);
  if (isNfs(pool)) {
    // Never mkdir over an unmounted mountpoint: that creates an empty directory on
    // the local disk, which then hides the share and reports a working pool that
    // writes to the wrong place.
    assertNfsMounted(pool, dir);
    await mkdir(dir, { recursive: true });
    return { exists: true, created: false, detail: dir };
  }
  await mkdir(dir, { recursive: true });
  return { exists: true, created: true, detail: dir };
}
