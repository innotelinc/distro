import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getObject,
  listObjects,
  localPoolDir,
  mountFor,
  normalizeKey,
  poolStat,
  probePool,
  putObject,
} from "../src/storage.js";

/**
 * What a pool actually reaches.
 *
 * The rows were always there and never read, so these cases are the whole of "does
 * a pool store anything": a local folder writes and reads back, a path cannot climb
 * out of the pool root, an NFS pool that is not mounted says so instead of writing
 * to the disk underneath it, and GCS is spoken to with a real RS256 token.
 */

const dir = mkdtempSync(join(tmpdir(), "distro-storage-"));
process.env.CONTROL_POOL_ROOT = dir;

const localPool = { name: "onyx", root_path: "", provider_type: "local" };
const nfsPool = { name: "nightly", root_path: "nightly", provider_type: "nfs" };

test("local pools", async (t) => {
  await t.test("a key is a relative path, never a way out of the pool", () => {
    assert.equal(normalizeKey("/a/b.txt"), "a/b.txt");
    assert.throws(() => normalizeKey("../etc/passwd"), /parent segments/);
    assert.throws(() => normalizeKey("a//b"), /empty/);
    assert.throws(() => normalizeKey(""), /key is required/);
    assert.equal(localPoolDir(localPool), join(dir, "onyx"));
    assert.throws(() => localPoolDir({ ...localPool, root_path: "/etc" }), /relative/);
    assert.throws(() => localPoolDir({ ...localPool, root_path: "../escape" }), /leaves the pool root/);
  });

  await t.test("an object is written, read and listed", async () => {
    const result = await putObject(localPool, "briefs/week1.txt", Buffer.from("hello"));
    assert.match(result.location, /^local:\/\/onyx\//);
    assert.equal(String(await getObject(localPool, "briefs/week1.txt")), "hello");
    assert.deepEqual(await listObjects(localPool, "briefs/"), ["briefs/week1.txt"]);
  });

  await t.test("a probe is the honest answer to \"is it wired\"", async () => {
    const result = await probePool(localPool);
    assert.equal(result.ok, true);
    assert.equal(result.mount.exists, true);
    // The probe removes what it wrote.
    assert.deepEqual((await listObjects(localPool, "probe/")).filter((key) => key.includes(".txt")), []);
  });

  await t.test("an unmounted NFS pool refuses rather than writing to the disk under it", async () => {
    // This test host is not mounting an NFS share at the pool root; the kind exists
    // to tell that apart from an empty pool, so the failure is the point.
    const state = await poolStat(nfsPool);
    assert.equal(state.mounted, false);
    await assert.rejects(() => probePool(nfsPool), /not mounted/);
  });

  await t.test("mountFor picks the innermost mount", () => {
    const table = [
      "22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw",
      "23 22 0:44 / /data/pools/onyx rw,relatime shared:2 - nfs4 192.168.1.60:/mnt/onyx/main-pool/distro rw",
      "24 22 0:45 / /data/pools/onyx/nested rw - tmpfs tmpfs rw",
    ].join("\n");
    assert.equal(mountFor("/data/pools/onyx/a/b", table).fstype, "nfs4");
    assert.equal(mountFor("/data/pools/onyx/a/b", table).source, "192.168.1.60:/mnt/onyx/main-pool/distro");
    assert.equal(mountFor("/data/pools/onyx/nested/x", table).fstype, "tmpfs");
    // A path outside the fake table has no mount it can name.
    assert.equal(mountFor("/srv/other", table), null);
  });
});

test("a GCS pool signs a token and speaks the JSON API", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyFile = join(dir, "service-account.json");
  writeFileSync(
    keyFile,
    JSON.stringify({
      client_email: "pool@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: "https://oauth2.googleapis.com/token",
    }),
  );
  const pool = {
    name: "gcs-test",
    provider_type: "gcs",
    bucket: "innotel-pools",
    root_path: "distro",
    credential_ref: keyFile,
  };

  const calls = [];
  const stored = new Map();
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ url, method });
    if (url.includes("oauth2.googleapis.com")) {
      // The assertion must be a signed JWT with three parts, not a placeholder.
      const assertion = new URLSearchParams(init.body).get("assertion");
      assert.equal(assertion.split(".").length, 3);
      return { ok: true, status: 200, json: async () => ({ access_token: "ya29.test", expires_in: 3600 }) };
    }
    assert.match(init.headers.authorization, /^Bearer ya29\.test$/);
    if (method === "POST" && url.includes("/upload/storage/v1/")) {
      const name = new URL(url).searchParams.get("name");
      stored.set(name, init.body);
      return { ok: true, status: 200, json: async () => ({ name }) };
    }
    if (method === "GET" && url.includes("alt=media")) {
      const name = decodeURIComponent(new URL(url).pathname.split("/o/")[1].replace("/", "%2F"));
      if (!stored.has(name)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, arrayBuffer: async () => stored.get(name) };
    }
    if (method === "DELETE") return { ok: true, status: 204, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };

  const probe = await probePool(pool, { fetchImpl });
  assert.equal(probe.ok, true);
  assert.match(probe.location, /^gs:\/\/innotel-pools\/distro\/probe\//);
  // The object was written under the pool's root prefix, read back, and removed.
  assert.ok([...stored.keys()].every((name) => name.startsWith("distro/probe/")));
  assert.ok(calls.some((call) => call.method === "DELETE"));
});
