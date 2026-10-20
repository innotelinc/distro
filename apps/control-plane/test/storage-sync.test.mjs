import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createCloudStorageProvider,
  createStoragePool,
  listCloudStorageProviders,
  listStoragePools,
  openDb,
} from "../src/db.js";
import { lastStorageSync, syncStorage } from "../src/storageSync.js";

/**
 * The reconciliation pass.
 *
 * The rule it encodes: onyx is the authority on what storage exists, distro is
 * the authority on what it can reach. What these cases pin is the seam — a share
 * becomes a pool once, a second pass adds nothing, an operator's pool is never
 * repointed, a share that disappears disables rather than deletes, and an onyx
 * that is down is a status line instead of a failed sync.
 */

const dir = mkdtempSync(join(tmpdir(), "distro-storage-sync-"));
process.env.CONTROL_POOL_ROOT = join(dir, "pools");
openDb(join(dir, "control.sqlite"));

const quiet = { log() {}, warn() {} };
const env = {
  ONYX_API_URL: "http://onyx.test:2081",
  ONYX_S3_ENDPOINT: "http://onyx.test:2090",
  ONYX_S3_BUCKET: "distro-shares",
};

function sharesFetch(shares) {
  return async () => ({ ok: true, status: 200, json: async () => ({ shares }) });
}

const twoShares = [
  { name: "onyx-data", path: "/mnt/onyx", protocols: ["SHARE_PROTOCOL_NFS", "SHARE_PROTOCOL_SMB"] },
  { name: "main-pool", path: "/mnt/onyx/main-pool", protocols: ["SHARE_PROTOCOL_NFS"] },
];

test("storage sync", async (t) => {
  await t.test("registers the object store and one pool per share", async () => {
    const result = await syncStorage({ env, fetchImpl: sharesFetch(twoShares), log: quiet });
    assert.equal(result.ok, true);
    assert.equal(result.error, null);

    const providers = listCloudStorageProviders();
    const names = providers.map((row) => row.name).sort();
    assert.deepEqual(names, ["onyx", "onyx-nfs"]);
    const s3 = providers.find((row) => row.name === "onyx");
    assert.equal(s3.provider_type, "s3");
    assert.equal(s3.endpoint, "http://onyx.test:2090");
    assert.equal(s3.bucket, "distro-shares");
    const nfs = providers.find((row) => row.name === "onyx-nfs");
    assert.equal(nfs.endpoint, "onyx.test:/mnt/onyx");

    const pools = listStoragePools();
    assert.deepEqual(pools.map((row) => row.name).sort(), ["main-pool", "onyx", "onyx-data"]);
    assert.equal(pools.find((row) => row.name === "onyx-data").root_path, "onyx-data");

    // Status is recorded for every pool, even the ones this host cannot reach:
    // an NFS share in another container is "not mounted here", and saying so is
    // the whole point of the field.
    const status = lastStorageSync().status;
    assert.equal(Object.keys(status).length, 3);
    for (const entry of Object.values(status)) {
      assert.equal(typeof entry.detail, "string");
      assert.equal(typeof entry.ok, "boolean");
    }
  });

  await t.test("a second pass adds nothing", async () => {
    const result = await syncStorage({ env, fetchImpl: sharesFetch(twoShares), log: quiet });
    assert.deepEqual(result.added, { providers: [], pools: [] });
    assert.equal(listCloudStorageProviders().length, 2);
    assert.equal(listStoragePools().length, 3);
  });

  await t.test("a duplicate provider is merged and its pool repointed", async () => {
    const dup = createCloudStorageProvider({
      name: "Onyx",
      providerType: "s3",
      endpoint: "http://192.168.1.60:2090",
      bucket: "distro-shares",
    });
    createStoragePool({ name: "operator-pool", providerId: dup.id, rootPath: "operator" });

    await syncStorage({ env, fetchImpl: sharesFetch(twoShares), log: quiet });

    const onyxes = listCloudStorageProviders().filter(
      (row) => String(row.name).toLowerCase() === "onyx",
    );
    assert.equal(onyxes.length, 1);
    const pools = listStoragePools();
    assert.equal(pools.length, 4);
    const operator = pools.find((row) => row.name === "operator-pool");
    // The operator's pool keeps existing and now hangs from the survivor.
    assert.equal(operator.provider_id, onyxes[0].id);
    // And the pass did not touch what that pool points at.
    assert.equal(operator.root_path, "operator");
  });

  await t.test("a share that disappears disables its pool instead of deleting it", async () => {
    await syncStorage({ env, fetchImpl: sharesFetch(twoShares.slice(0, 1)), log: quiet });
    const pool = listStoragePools().find((row) => row.name === "main-pool");
    assert.equal(pool.enabled, 0);
    // Reappearing re-enables the same row: the objects still live at that path.
    await syncStorage({ env, fetchImpl: sharesFetch(twoShares), log: quiet });
    assert.equal(listStoragePools().find((row) => row.name === "main-pool").enabled, 1);
  });

  await t.test("an onyx that is down is a status line, not a failed pass", async () => {
    const before = listStoragePools().length;
    const result = await syncStorage({
      env,
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      log: quiet,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ECONNREFUSED/);
    // Nothing is removed and the pools registered earlier still answer.
    assert.equal(listStoragePools().length, before);
    assert.equal(listCloudStorageProviders().length, 2);
  });
});
