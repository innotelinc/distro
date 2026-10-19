import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import Database from "better-sqlite3";

import { openDb, createUser, getUserByEmail, setUserOidcSub, upsertQuota } from "../src/db.js";
import { issueServiceCredential } from "../src/serviceCredentials.js";
import { handler } from "../src/http.js";

/**
 * `GET /api/internal/identity/resolve` — who a person is, by address.
 *
 * It exists so a service can act *for* somebody without inventing an identity for
 * them (G0DM0D3 runs a Genie turn under the signed-in person's own account). That
 * makes the read-only property the thing worth pinning: a resolve must never create
 * an account, never bind a subject, and never leak a subject for an account that
 * has none — the tests below check the user count after each call, not just the
 * response.
 */

const INTERNAL_TOKEN = "internal-token";
let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-resolve-test-"));
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/**
 * The gateway, stubbed: the handler takes one for the routes that mint keys, and
 * this file is not about those. Nothing here reaches it, which is the point.
 */
const gateway = {
  login: async () => "session=1",
  createApiKey: async (name) => ({ id: "key", key: "sk-1", name }),
  revokeApiKey: async () => {},
};

let seq = 0;

async function startPlane() {
  const path = join(workdir, `resolve-${(seq += 1)}.sqlite`);
  openDb(path);
  process.env.CONTROL_INTERNAL_TOKEN = INTERNAL_TOKEN;
  const server = createServer((req, res) => {
    handler(req, res, { gateway }).catch((error) => {
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

function resolve(url, email, token = INTERNAL_TOKEN) {
  const query = email === null ? "" : `?email=${encodeURIComponent(email)}`;
  return fetch(`${url}/api/internal/identity/resolve${query}`, {
    headers: token === null ? {} : { "x-control-internal-token": token },
  });
}

test("an address resolves to the subject its account is keyed on", async () => {
  const plane = await startPlane();
  try {
    const user = createUser({ email: "operator@innotel.us", passwordHash: "x", role: "user" });
    setUserOidcSub(user.id, "authentik-sub-1");
    upsertQuota(user.id, { plan: "unlimited" });

    const response = await resolve(plane.url, "operator@innotel.us");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.email, "operator@innotel.us");
    assert.equal(body.sub, "authentik-sub-1");
    assert.equal(body.plan, "unlimited");
    assert.equal(body.service, false);
    assert.equal(typeof body.id, "string");
  } finally {
    await plane.close();
  }
});

test("the address is matched case-insensitively, because it is what a header carries", async () => {
  const plane = await startPlane();
  try {
    const user = createUser({ email: "mixed@innotel.us", passwordHash: "x", role: "user" });
    setUserOidcSub(user.id, "sub-mixed");
    const body = await (await resolve(plane.url, "Mixed@InnoTel.US")).json();
    assert.equal(body.sub, "sub-mixed");
  } finally {
    await plane.close();
  }
});

test("an address with no account is a 404 and creates nothing", async () => {
  const plane = await startPlane();
  try {
    const before = plane.db().prepare("select count(*) n from users").get().n;
    const response = await resolve(plane.url, "stranger@innotel.us");
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "user_not_found");
    const after = plane.db().prepare("select count(*) n from users").get().n;
    assert.equal(after, before, "resolving must never create an account");
  } finally {
    await plane.close();
  }
});

test("an account with no subject is refused rather than given one", async () => {
  const plane = await startPlane();
  try {
    createUser({ email: "password-only@innotel.us", passwordHash: "x", role: "user" });
    const response = await resolve(plane.url, "password-only@innotel.us");
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, "no_oidc_subject");
    const row = plane.db().prepare("select oidc_sub from users where email = ?").get("password-only@innotel.us");
    assert.equal(row.oidc_sub, null, "and it must not bind one on the way out");
  } finally {
    await plane.close();
  }
});

test("a service-plan account says so, so a caller does not meter it", async () => {
  const plane = await startPlane();
  try {
    const user = createUser({ email: "machine@innotel.us", passwordHash: "x", role: "user" });
    setUserOidcSub(user.id, "sub-machine");
    upsertQuota(user.id, { plan: "service" });
    const body = await (await resolve(plane.url, "machine@innotel.us")).json();
    assert.equal(body.service, true);
    assert.equal(body.plan, "service");
  } finally {
    await plane.close();
  }
});

test("a missing address is a 400, and no credential is a 401", async () => {
  const plane = await startPlane();
  try {
    assert.equal((await resolve(plane.url, null)).status, 400);
    assert.equal((await resolve(plane.url, "operator@innotel.us", null)).status, 401);
    assert.equal((await resolve(plane.url, "operator@innotel.us", "wrong")).status, 401);
  } finally {
    await plane.close();
  }
});

test("a credential without identity:resolve may not ask, and one with it may", async () => {
  const plane = await startPlane();
  try {
    const user = createUser({ email: "scoped@innotel.us", passwordHash: "x", role: "user" });
    setUserOidcSub(user.id, "sub-scoped");

    const wrong = issueServiceCredential({ surface: "genie", scopes: ["credits:read"] });
    assert.equal((await resolve(plane.url, "scoped@innotel.us", wrong.token)).status, 403);

    const right = issueServiceCredential({ surface: "g0dm0d3", scopes: ["identity:resolve"] });
    const body = await (await resolve(plane.url, "scoped@innotel.us", right.token)).json();
    assert.equal(body.sub, "sub-scoped");
  } finally {
    await plane.close();
  }
});
