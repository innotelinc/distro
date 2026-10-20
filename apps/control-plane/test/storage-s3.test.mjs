import assert from "node:assert/strict";
import test from "node:test";

import { probePool, putObject, listObjects } from "../src/storage.js";

/**
 * The onyx object store, spoken to correctly.
 *
 * The credential pair is resolved from `credential_ref` + `_ACCESS_KEY`/`_SECRET_KEY`;
 * a plain (non-vault) ref is used here so the test needs no Vault. What matters is
 * the shape of the request: path-style URL, a SigV4 header with the pool's region and
 * the payload hash, and a list that reads S3's XML without an XML library.
 */

const pool = {
  name: "onyx-test",
  provider_type: "s3",
  endpoint: "http://192.168.1.60:2090",
  bucket: "distro-shares",
  region: "us-east-1",
  root_path: "pools/demo",
  credential_ref: "test",
};

process.env.test_ACCESS_KEY = "AKIATEST";
process.env.test_SECRET_KEY = "secret-value";

const stored = new Map();
const fetchImpl = async (url, init = {}) => {
  const method = init.method || "GET";
  const parsed = new URL(url);
  assert.equal(parsed.host, "192.168.1.60:2090");
  assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIATEST\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(init.headers["x-amz-content-sha256"].length, 64);
  if (method === "PUT") {
    assert.ok(parsed.pathname.startsWith("/distro-shares/pools/demo/"));
    stored.set(parsed.pathname, init.body);
    return { ok: true, status: 200 };
  }
  if (method === "GET" && parsed.searchParams.get("list-type") === "2") {
    const keys = [...stored.keys()].map((path) => `<Contents><Key>${path.replace("/distro-shares/", "")}</Key></Contents>`).join("");
    return { ok: true, status: 200, text: async () => `<ListBucketResult>${keys}</ListBucketResult>` };
  }
  if (method === "GET") {
    const body = stored.get(parsed.pathname);
    if (!body) return { ok: false, status: 404, text: async () => "" };
    return { ok: true, status: 200, arrayBuffer: async () => body };
  }
  if (method === "DELETE") {
    stored.delete(parsed.pathname);
    return { ok: true, status: 204 };
  }
  if (method === "HEAD") return { ok: true, status: 200 };
  return { ok: true, status: 200, text: async () => "" };
};

test("an S3 pool writes under its root, lists it, and probes itself", async () => {
  const written = await putObject(pool, "briefs/week1.txt", Buffer.from("hello"), { fetchImpl });
  assert.equal(written.location, "s3://distro-shares/pools/demo/briefs/week1.txt");
  assert.deepEqual(await listObjects(pool, "", { fetchImpl }), ["pools/demo/briefs/week1.txt"]);

  const probe = await probePool(pool, { fetchImpl });
  assert.equal(probe.ok, true);
  assert.match(probe.location, /^s3:\/\/distro-shares\/pools\/demo\/probe\//);
  // The probe removes what it wrote.
  assert.deepEqual([...stored.keys()].filter((key) => key.includes("/probe/")), []);
});
