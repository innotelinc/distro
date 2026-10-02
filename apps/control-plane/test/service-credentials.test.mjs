import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import Database from "better-sqlite3";

import { openDb, createServiceCredential, revokeServiceCredential } from "../src/db.js";
import {
  issueServiceCredential,
  hashServiceToken,
  serviceAuthEnabled,
} from "../src/serviceCredentials.js";
import { handler } from "../src/http.js";

/**
 * Scoped service credentials (M7 "scoped bridge").
 *
 * The thing under test is the *shape of the authority*, not the routes: a
 * credential is bound to a surface and a set of scopes, a route refuses one
 * that lacks the scope it needs (403, which is a different answer from "no
 * credential" — 401), revocation stops it, an expiry stops it, and the legacy
 * env token still works as a bootstrap so this shipped without a flag day.
 *
 *   node --test test/
 */

const BOOTSTRAP = "bootstrap-token";

function fakeGateway() {
  return {
    login: async () => "session=1",
    createApiKey: async (name) => ({ id: `key-1`, key: "sk-1", name }),
    revokeApiKey: async () => {},
  };
}

let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-svc-cred-test-"));
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
  process.env.ADMIN_EMAILS = "";
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

let seq = 0;

async function startPlane({ token = "" } = {}) {
  const path = join(workdir, `control-${(seq += 1)}.sqlite`);
  openDb(path);
  process.env.CONTROL_INTERNAL_TOKEN = token;

  const server = createServer((req, res) => {
    handler(req, res, { gateway: fakeGateway() }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    db: () => new Database(path, { readonly: true }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function call(url, path, { token, body = {} } = {}) {
  return fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null || token === undefined ? {} : { "x-control-internal-token": token }),
    },
    body: JSON.stringify(body),
  });
}

const identity = (url, token, body = { sub: "sub-1", email: "a@example.com" }) =>
  call(url, "/api/internal/identity", { token, body });

const audit = (url, token, body = { action: "build.publish" }) =>
  call(url, "/api/internal/audit", { token, body });

test("an issued credential resolves an account and only its hash is stored", async () => {
  const plane = await startPlane();

  try {
    const { credential, token } = issueServiceCredential({
      surface: "genie",
      scopes: ["identity:resolve"],
    });

    assert.equal(credential.surface, "genie");
    assert.equal(credential.scopes, "identity:resolve");
    assert.equal(credential.expires_at, null);

    // The plaintext token is never persisted: the row holds a hash, so a read
    // of the database cannot yield a usable credential.
    const db = plane.db();
    const row = db.prepare("SELECT token_hash FROM service_credentials WHERE id = ?").get(credential.id);
    db.close();
    assert.notEqual(row.token_hash, token);
    assert.equal(row.token_hash, hashServiceToken(token));

    const response = await identity(plane.url, token);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.user.email, "a@example.com");
  } finally {
    await plane.close();
  }
});

test("a credential without the route's scope is refused 403, not 401", async () => {
  const plane = await startPlane();

  try {
    const { token } = issueServiceCredential({ surface: "genie", scopes: ["audit:write"] });

    const refused = await identity(plane.url, token);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).error, /identity:resolve/);

    const allowed = await audit(plane.url, token);
    assert.equal(allowed.status, 201);
  } finally {
    await plane.close();
  }
});

test("a revoked credential stops authenticating", async () => {
  const plane = await startPlane({ token: BOOTSTRAP });

  try {
    const { credential, token } = issueServiceCredential({
      surface: "genie",
      scopes: ["identity:resolve"],
    });
    assert.equal((await identity(plane.url, token)).status, 200);

    revokeServiceCredential(credential.id);

    const after = await identity(plane.url, token);
    assert.equal(after.status, 401);
  } finally {
    await plane.close();
  }
});

test("an expired credential stops authenticating", async () => {
  const plane = await startPlane({ token: BOOTSTRAP });

  try {
    const token = "expired-token-value";
    createServiceCredential({
      surface: "genie",
      tokenHash: hashServiceToken(token),
      scopes: ["identity:resolve"],
      expiresAt: "2000-01-01T00:00:00.000Z",
    });

    assert.equal((await identity(plane.url, token)).status, 401);
  } finally {
    await plane.close();
  }
});

test("the bootstrap env token carries every scope", async () => {
  const plane = await startPlane({ token: BOOTSTRAP });

  try {
    // The one surface (Genie) holds the env token today, so shipping the scope
    // model must not lock it out of any route it already used.
    assert.equal((await identity(plane.url, BOOTSTRAP)).status, 200);
    assert.equal((await audit(plane.url, BOOTSTRAP)).status, 201);
    assert.equal(
      (await call(plane.url, "/api/internal/alert", { token: BOOTSTRAP, body: { event: "controlplane.unreachable" } })).status,
      202,
    );
  } finally {
    await plane.close();
  }
});

test("a live issued credential arms the routes even with no env token", async () => {
  const plane = await startPlane();

  try {
    issueServiceCredential({ surface: "genie", scopes: ["identity:resolve"] });

    // Routes are no longer "off" just because the env token is empty, so an
    // unknown token is a 401 rather than a 503 telling an operator to set it.
    const unknown = await identity(plane.url, "not-a-token");
    assert.equal(unknown.status, 401);
  } finally {
    await plane.close();
  }
});

test("with no credential, no live row and no env token, the routes are off", async () => {
  const plane = await startPlane();

  try {
    // Nothing armed them, so the answer names the setting instead of pretending
    // an unauthenticated caller is simply unwelcome.
    const response = await identity(plane.url, "anything");
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /internal API not configured/);
    assert.equal(serviceAuthEnabled(), false);
  } finally {
    await plane.close();
  }
});

test("issuing rejects an unknown scope instead of silently dropping it", () => {
  assert.throws(
    () => issueServiceCredential({ surface: "genie", scopes: ["identity:resolve", "root:everything"] }),
    /unknown scope/,
  );
  assert.throws(() => issueServiceCredential({ surface: "", scopes: ["audit:write"] }), /surface/);
});
