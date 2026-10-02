import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb, createUser, setGatewayKey, getGatewayKey } from "../src/db.js";
import { openSession } from "../src/auth.js";
import { handler } from "../src/http.js";

/**
 * The browser-facing gateway key is retired (M2 "option A" → the M7 server-side
 * bridge).
 *
 * A per-user key is a bearer credential for the whole gateway. While it was handed
 * to a browser session, every XSS, extension and shared tab was a way to spend that
 * account's quota directly on the gateway, around this plane. The builder surface
 * never needed it in the browser: it resolves the account's key server-side through
 * `POST /api/internal/identity` under the service token.
 *
 * So there are two things to hold, and they are opposites of each other: the browser
 * read must not return the secret (and must say why it is gone rather than read as
 * "no key"), and the *service* read must still return it — otherwise the retirement
 * removes the key from the one consumer that needs it, and tenancy stops working.
 *
 * Exercised against a real SQLite file and the real HTTP handler; only the gateway
 * is stubbed, because minting a key is another service's dashboard API.
 *
 *   node --test test/
 */

const INTERNAL_TOKEN = "internal-token";
const SECRET = "sk-live";

let workdir = "";
const revoked = [];

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-me-key-test-"));
  // No secret store, billing, alerts, discovery or gateway sync: this file is
  // about two routes, and each of those would otherwise reach for a network.
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
  process.env.ADMIN_EMAILS = "";
  process.env.CONTROL_INTERNAL_TOKEN = INTERNAL_TOKEN;
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

let dbSeq = 0;

function fakeGateway(seq) {
  return {
    login: async () => "session=1",
    createApiKey: async (name) => ({ id: `key-new-${seq}`, key: `sk-new-${seq}`, name }),
    revokeApiKey: async (id) => {
      revoked.push(id);
    },
  };
}

async function startPlane() {
  const path = join(workdir, `me-key-${(dbSeq += 1)}.sqlite`);
  openDb(path);
  const gateway = fakeGateway(dbSeq);

  const server = createServer((req, res) => {
    handler(req, res, { gateway }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test("a browser session is told the key is gone, and not why it might be empty", async () => {
  const plane = await startPlane();

  try {
    const user = createUser({ email: "owner@example.test", passwordHash: "x", role: "user" });
    setGatewayKey(user.id, { gatewayKeyId: "key-live", gatewayKey: SECRET });
    const token = openSession(user.id);

    const response = await fetch(`${plane.url}/api/me/gateway-key`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 410, "410 says retired, where 404 would say no key");
    const body = await response.json();
    assert.equal(body.gatewayKey, undefined, "no key reaches a browser session");
    assert.equal(body.gatewayKeyId, undefined);
    assert.match(body.error, /retired/);
    assert.match(body.error, /internal\/identity/);
  } finally {
    await plane.close();
  }
});

test("the retired route still needs a session, so it is not an oracle", async () => {
  const plane = await startPlane();

  try {
    const response = await fetch(`${plane.url}/api/me/gateway-key`);
    assert.equal(response.status, 401);
  } finally {
    await plane.close();
  }
});

test("rotating revokes the old key and returns its id, never the secret", async () => {
  const plane = await startPlane();

  try {
    const user = createUser({ email: "rotate@example.test", passwordHash: "x", role: "user" });
    setGatewayKey(user.id, { gatewayKeyId: "key-old", gatewayKey: "sk-old" });
    const token = openSession(user.id);

    const response = await fetch(`${plane.url}/api/me/gateway-key/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.gatewayKey, undefined, "the fresh key stays server-side");
    assert.equal(body.gatewayKeyPresent, true);
    assert.ok(body.gatewayKeyId, "the id is what a person can read back");
    assert.ok(revoked.includes("key-old"), "the key it replaced was revoked");
    assert.notEqual(getGatewayKey(user.id).gateway_key, "sk-old", "a new key is stored for the surface to read");
  } finally {
    await plane.close();
  }
});

test("the surface still gets the key through the service path", async () => {
  const plane = await startPlane();

  try {
    const user = createUser({ email: "surface@example.test", passwordHash: "x", role: "user" });
    setGatewayKey(user.id, { gatewayKeyId: "key-svc", gatewayKey: "sk-svc" });

    const response = await fetch(`${plane.url}/api/internal/identity`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-control-internal-token": INTERNAL_TOKEN },
      body: JSON.stringify({ sub: "sub-surface", email: "surface@example.test" }),
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.gatewayKey, "sk-svc", "the server-side bridge is where the key lives now");
  } finally {
    await plane.close();
  }
});

test("the service path refuses a caller without the service token", async () => {
  const plane = await startPlane();

  try {
    const response = await fetch(`${plane.url}/api/internal/identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sub: "sub-x", email: "x@example.test" }),
    });
    assert.equal(response.status, 401);
  } finally {
    await plane.close();
  }
});
