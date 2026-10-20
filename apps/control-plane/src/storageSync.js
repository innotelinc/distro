// Keep the plane's picture of the estate's storage true without an operator
// pressing anything.
//
// Onyx owns the disks and publishes what it holds (`/api/v1/shares`, and its
// object store on :2090). Distro owns the catalog: which provider, which pool,
// and whether the pool can be reached right now. Until now those two facts were
// joined by hand — a share created on onyx did not appear here, and a provider
// row written once by the seed sat beside a second one somebody had added, with
// no pool under either.
//
// So this pass is a reconciliation, not a copy:
//
//   * the object store becomes the `onyx` provider, and the bucket the estate
//     already writes into becomes the `onyx` pool;
//   * every NFS/SMB share on onyx becomes one pool under an `onyx-nfs` provider,
//     named after the share, so a new share shows up on the next pass;
//   * a share that disappeared disables its pool instead of deleting it — the
//     objects already written are still somewhere, and a row costs nothing;
//   * every enabled pool is asked where it lives, and the answers are the
//     `status` the console draws.
//
// Nothing here throws for an onyx that is down. A quiet object store is a status
// line, not a failed boot: the pools it already registered keep working, and the
// next pass picks up whatever changed while it was away.

import {
  createCloudStorageProvider,
  createStoragePool,
  deleteCloudStorageProvider,
  listCloudStorageProviders,
  listStoragePools,
  updateCloudStorageProvider,
  setStoragePoolEnabled,
  setStoragePoolProvider,
} from './db.js';
import { poolStat } from './storage.js';

export const ONYX_PROVIDER = 'onyx';
export const ONYX_NFS_PROVIDER = 'onyx-nfs';
export const DEFAULT_ONYX_API = 'http://192.168.1.60:2081';
export const DEFAULT_ONYX_S3 = 'http://192.168.1.60:2090';

/** How often the pass runs. `0` turns the timer off; the endpoint still works. */
export function storageSyncInterval(env = process.env) {
  const raw = Number.parseInt(String(env.CONTROL_STORAGE_SYNC_MS ?? ''), 10);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 5 * 60_000;
}

let lastRun = { at: null, ok: null, error: null, added: [], status: {} };

/** The result of the most recent pass, for the console to draw. */
export function lastStorageSync() {
  return { ...lastRun, status: { ...lastRun.status } };
}

function byName(providers, name) {
  return providers.filter((row) => String(row.name || '').trim().toLowerCase() === name);
}

/**
 * One provider per name, even if the table has two.
 *
 * `Onyx` and `onyx` both existed: the seed wrote one, an operator typed the
 * other, and a pool under either would be invisible to a lookup by the name the
 * seed uses. The survivor keeps the rows pointing at it; the duplicates are
 * removed only after their pools have been repointed, so no pool is orphaned.
 */
function collapse(providers, name, log) {
  const rows = byName(providers, name);
  if (rows.length <= 1) return rows[0] || null;
  const pools = listStoragePools();
  const count = (row) => pools.filter((pool) => pool.provider_id === row.id).length;
  const [keep, ...rest] = rows.sort(
    (a, b) =>
      count(b) - count(a) ||
      String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
      String(a.id).localeCompare(String(b.id)),
  );
  for (const dup of rest) {
    for (const pool of pools.filter((row) => row.provider_id === dup.id)) {
      setStoragePoolProvider(pool.id, keep.id);
    }
    deleteCloudStorageProvider(dup.id);
  }
  log?.warn?.(`[storage] merged ${rows.length} providers named "${keep.name}" into one`);
  return keep;
}

export async function syncStorage({ env = process.env, fetchImpl = fetch, log = console } = {}) {
  const api = String(env.ONYX_API_URL || DEFAULT_ONYX_API).replace(/\/+$/, '');
  const s3Endpoint = String(env.ONYX_S3_ENDPOINT || DEFAULT_ONYX_S3).replace(/\/+$/, '');
  const bucket = String(env.ONYX_S3_BUCKET || 'distro-shares');
  const host = new URL(api).hostname;
  const added = { providers: [], pools: [] };
  const status = {};

  // 1. The object store: one provider, one pool. This is the path distro can
  //    actually write through — a container cannot mount NFS, but it can speak S3.
  const providers = listCloudStorageProviders();
  const onyx = collapse(providers, ONYX_PROVIDER, log);
  const provider = onyx
    ? updateCloudStorageProvider(onyx.id, {
        // Only fill what is empty: an operator who pointed the provider at
        // another bucket meant it, and a sync that overwrote that every five
        // minutes would be the opposite of reconciliation.
        endpoint: onyx.endpoint || s3Endpoint,
        bucket: onyx.bucket || bucket,
        region: onyx.region || 'us-east-1',
        credential_ref: onyx.credential_ref || env.ONYX_S3_CREDENTIAL_REF || 'vault://cerulean/distro#SHARES_S3',
      })
    : createCloudStorageProvider({
        name: ONYX_PROVIDER,
        providerType: 's3',
        endpoint: s3Endpoint,
        bucket,
        region: env.ONYX_S3_REGION || 'us-east-1',
        credentialRef: env.ONYX_S3_CREDENTIAL_REF || 'vault://cerulean/distro#SHARES_S3',
        enabled: true,
      });
  if (!onyx) added.providers.push(provider.name);

  let pools = listStoragePools();
  if (!pools.some((pool) => pool.name === ONYX_PROVIDER)) {
    createStoragePool({ name: ONYX_PROVIDER, providerId: provider.id, rootPath: '', capacityLabel: 'onyx' });
    added.pools.push(ONYX_PROVIDER);
  }

  // 2. The shares. A share is a place on onyx's disks; the provider is the host
  //    that exports them. Distro may not be able to mount the share, and the
  //    status line says so rather than pretending the pool is broken.
  let shares = [];
  let sharesError = null;
  try {
    const response = await fetchImpl(`${api}/api/v1/shares`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`onyx answered HTTP ${response.status}`);
    const body = await response.json();
    shares = Array.isArray(body.shares) ? body.shares : [];
  } catch (error) {
    sharesError = error?.message || String(error);
  }

  if (sharesError === null) {
    const nfsProviders = listCloudStorageProviders();
    const existingNfs = byName(nfsProviders, ONYX_NFS_PROVIDER)[0] || null;
    const nfs = existingNfs
      ? updateCloudStorageProvider(existingNfs.id, { endpoint: existingNfs.endpoint || `${host}:/mnt/onyx` })
      : createCloudStorageProvider({
          name: ONYX_NFS_PROVIDER,
          providerType: 'nfs',
          endpoint: `${host}:/mnt/onyx`,
          enabled: true,
        });

    pools = listStoragePools();
    const seen = new Set();
    for (const share of shares) {
      const name = String(share.name || '').trim();
      if (!name) continue;
      seen.add(name);
      const pool = pools.find((row) => row.name === name);
      if (pool) {
        // An operator's pool keeps its own provider; the share is only a hint
        // that it exists, never a reason to repoint a working pool.
        continue;
      }
      createStoragePool({
        name,
        providerId: nfs.id,
        rootPath: name,
        capacityLabel: host,
      });
      added.pools.push(name);
    }

    // A share that is gone loses its row's `enabled`, not the row: a deleted
    // share is often a detached disk, and deleting the pool would forget the
    // objects' address on the day the disk comes back.
    for (const pool of pools.filter((row) => row.provider_id === nfs.id)) {
      const present = seen.has(pool.name);
      if (present !== Boolean(pool.enabled)) setStoragePoolEnabled(pool.id, present);
    }
  }

  // 3. Status: where each pool lives right now. `poolStat` is a read; a probe
  //    writes an object and is left to the button, because a timer that writes
  //    to storage every five minutes is not a status check.
  pools = listStoragePools();
  for (const pool of pools) {
    if (!pool.enabled) {
      status[pool.id] = { ok: false, detail: 'disabled', at: new Date().toISOString() };
      continue;
    }
    try {
      const reach = await poolStat(pool);
      // For a share, "exists: false" means one specific thing — nothing is
      // mounted at that path — and the status should say that, not just print the
      // path back, because the path is the part the operator already knows.
      const unmounted = reach.exists === false && String(pool.provider_type) === 'nfs';
      status[pool.id] = {
        ok: reach.exists !== false,
        detail: unmounted
          ? `not mounted at ${reach.detail}`
          : reach.detail || (reach.exists ? 'reachable' : 'unreachable'),
        at: new Date().toISOString(),
      };
    } catch (error) {
      status[pool.id] = { ok: false, detail: error?.message || String(error), at: new Date().toISOString() };
    }
  }

  const down = Object.values(status).filter((entry) => !entry.ok).length;
  lastRun = {
    at: new Date().toISOString(),
    ok: sharesError === null,
    error: sharesError,
    added,
    down,
    status,
  };
  if (sharesError) log?.warn?.(`[storage] onyx did not answer (${sharesError}); kept the pools already registered`);
  return lastRun;
}
