// The pool this deployment starts with, so a fresh console has somewhere to put
// a file instead of an empty form.
//
// Onyx is this estate's object store host. The pool is its S3-compatible bucket
// (`SHARES_S3_*` in the Vault), because that works without a mount — and a pool row
// alone is not a working pool, so the seed *prepares* it and reports where it landed
// in the boot log. Onyx also exports the same bulk dataset over NFSv4 for a host
// that can mount it; switching kinds is one field on the provider.
//
// Idempotent on the name: re-running it never creates a second provider or pool, and
// it never overwrites one an operator has edited.

import {
  createCloudStorageProvider,
  createStoragePool,
  listCloudStorageProviders,
  listStoragePools,
} from './db.js';
import { preparePool } from './storage.js';

export const ONYX_PROVIDER = 'onyx';
export const ONYX_POOL = 'onyx';

export async function seedStoragePools({ env = process.env, log = console } = {}) {
  if (env.CONTROL_SEED_STORAGE === '0') return { skipped: true };

  const providers = listCloudStorageProviders();
  let provider = providers.find((row) => row.name === ONYX_PROVIDER) || null;
  const created = { provider: false, pool: false };

  if (!provider) {
    // Onyx's object store: the same pool the estate's shares already use
    // (`SHARES_S3_*` in the Vault, bucket `distro-shares`). This is the shape that
    // works without a mount, which is why it is the seeded default rather than the
    // NFS export — that one is there for hosts that can mount it.
    provider = createCloudStorageProvider({
      name: ONYX_PROVIDER,
      providerType: env.ONYX_POOL_KIND || 's3',
      endpoint: env.ONYX_S3_ENDPOINT || 'http://192.168.1.60:2090',
      bucket: env.ONYX_S3_BUCKET || 'distro-shares',
      region: env.ONYX_S3_REGION || 'us-east-1',
      credentialRef: env.ONYX_S3_CREDENTIAL_REF || 'vault://cerulean/distro#SHARES_S3',
      enabled: true,
    });
    created.provider = true;
  }

  const pools = listStoragePools();
  let pool = pools.find((row) => row.name === ONYX_POOL) || null;
  if (!pool) {
    // `root_path` empty means "the pool's own directory": /data/pools/onyx, which is
    // where the host's NFS mount is bound in. Keeping it a name rather than an
    // absolute path is what lets the same row work on another host.
    pool = createStoragePool({ name: ONYX_POOL, providerId: provider.id, rootPath: '', capacityLabel: 'onyx' });
    created.pool = true;
  }

  if (!created.provider && !created.pool) return { created, pool, prepared: null };

  let prepared;
  try {
    prepared = await preparePool(pool);
  } catch (error) {
    prepared = { exists: false, detail: error.message };
    log.warn(`[storage] pool ${ONYX_POOL} is not ready: ${error.message}`);
  }
  log.log(
    `[storage] pool ${ONYX_POOL} ${created.pool ? 'created' : 'present'} via ${provider.provider_type} ` +
      `${provider.endpoint || ''} → ${prepared.detail || 'unprepared'}`,
  );
  return { created, pool, prepared };
}
