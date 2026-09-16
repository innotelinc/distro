import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import Database from "better-sqlite3";

import { openDb, createUser, updateUser, upsertQuota, setGatewayKey, getGatewayKey } from "../src/db.js";
import { handler } from "../src/http.js";

/**
 * The internal API (`/api/internal/*`), exercised against a real SQLite file and
 * the real HTTP handler — the parts a unit test would have to fake are exactly
 * the parts worth checking: the schema migration, the join between an Authentik
 * subject and an account, and which credential each route demands.
 *
 * The gateway is the one thing stubbed, because provisioning mints a key through
 * a dashboard API that belongs to another service.
 *
 *   node --test test/
 */

const INTERNAL_TOKEN = "internal-token";

/** A gateway dashboard that mints a predictable key and counts the mints. */
function fakeGateway() {
  const state = { logins: 0, mints: [], keys: 0 };
  return {
    state,
    login: async () => {
      state.logins += 1;
      return "session=1";
    },
    createApiKey: async (name, options) => {
      state.keys += 1;
      state.mints.push({ name, options });
      return { id: `key-${state.keys}`, key: `sk-${state.keys}`, name };
    },
    revokeApiKey: async () => {},
  };
}

let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-control-test-"));
  // No secret store, no billing, no alerts, no discovery: this file is about the
  // internal API, and every one of these would otherwise reach for a network.
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

let dbSeq = 0;

async function startPlane({ token = INTERNAL_TOKEN, dbPath, gateway = fakeGateway() } = {}) {
  const path = dbPath ?? join(workdir, `control-${(dbSeq += 1)}.sqlite`);
  openDb(path);
  process.env.CONTROL_INTERNAL_TOKEN = token;

  const server = createServer((req, res) => {
    handler(req, res, { gateway }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    gateway,
    dbPath: path,
    db: () => new Database(path, { readonly: true }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function identityRequest(url, { token = INTERNAL_TOKEN, body = {}, method = "POST" } = {}) {
  return fetch(`${url}/api/internal/identity`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-control-internal-token": token }),
    },
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });
}

test("an unset service token turns the internal routes off, not open", async () => {
  const plane = await startPlane({ token: "" });

  try {
    const response = await identityRequest(plane.url, { token: null, body: { sub: "s", email: "a@b.co" } });

    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /CONTROL_INTERNAL_TOKEN/);
  } finally {
    await plane.close();
  }
});

test("a wrong service token is a 401", async () => {
  const plane = await startPlane();

  try {
    const response = await identityRequest(plane.url, {
      token: "not-the-token",
      body: { sub: "s", email: "a@b.co" },
    });

    assert.equal(response.status, 401);
  } finally {
    await plane.close();
  }
});

test("provisions an account, mints its key once, and validates its input", async () => {
  const plane = await startPlane();

  try {
    const missingSub = await identityRequest(plane.url, { body: { email: "a@b.co" } });
    assert.equal(missingSub.status, 400);

    const badEmail = await identityRequest(plane.url, { body: { sub: "sub-1", email: "nope" } });
    assert.equal(badEmail.status, 400);

    const first = await identityRequest(plane.url, {
      body: { sub: "sub-1", email: "Dev@Example.com", name: "Dev" },
    });
    assert.equal(first.status, 200);
    const created = await first.json();
    assert.equal(created.created, true);
    assert.equal(created.gatewayKey, "sk-1");
    assert.equal(created.user.email, "dev@example.com");
    assert.equal(created.oidcSub, "sub-1");
    assert.equal(created.user.role, "admin", "the first account on an instance is an admin");
    assert.equal(plane.gateway.state.keys, 1);
    assert.equal(plane.gateway.state.mints[0].name, `studio-user-${created.user.id.slice(0, 8)}`);

    // Idempotent: the same subject resolves to the same account and key, and
    // mints nothing new — a caller retries on every cold start.
    const second = await identityRequest(plane.url, {
      body: { sub: "sub-1", email: "dev@example.com" },
    });
    const again = await second.json();
    assert.equal(again.created, false);
    assert.equal(again.user.id, created.user.id);
    assert.equal(again.gatewayKey, "sk-1");
    assert.equal(plane.gateway.state.keys, 1);

    const db = plane.db();
    const row = db.prepare("SELECT email, role, oidc_sub FROM users WHERE id = ?").get(created.user.id);
    db.close();
    assert.deepEqual(row, { email: "dev@example.com", role: "admin", oidc_sub: "sub-1" });

    const audited = plane.db();
    const row2 = audited
      .prepare("SELECT action, target_id FROM audit_log WHERE action = 'user.provisioned'")
      .get();
    audited.close();
    assert.equal(row2.target_id, created.user.id);
  } finally {
    await plane.close();
  }
});

test("adopts an account that already exists for the email, without re-minting", async () => {
  const plane = await startPlane();

  try {
    // An account from before this endpoint existed: a password signup with a key.
    const existing = createUser({ email: "prod@example.com", passwordHash: "scrypt$…", role: "user" });
    upsertQuota(existing.id, { plan: "free" });
    setGatewayKey(existing.id, { gatewayKeyId: "key-old", gatewayKey: "sk-old" });
    assert.equal(getGatewayKey(existing.id).gateway_key, "sk-old");

    const response = await identityRequest(plane.url, {
      body: { sub: "sub-prod", email: "prod@example.com" },
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.created, false);
    assert.equal(payload.user.id, existing.id, "one human, one account");
    assert.equal(payload.gatewayKey, "sk-old", "the key it already had is the one it keeps");
    assert.equal(plane.gateway.state.keys, 0, "nothing was minted");

    const db = plane.db();
    const link = db.prepare("SELECT action FROM audit_log WHERE action = 'user.oidc-link'").get();
    db.close();
    assert.ok(link, "adoption is audited");

    // ...and a second subject claiming that email is a conflict, not a rebind.
    const conflict = await identityRequest(plane.url, {
      body: { sub: "sub-imposter", email: "prod@example.com" },
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /different identity/);
  } finally {
    await plane.close();
  }
});

test("quota and usage follow the account's own gateway key", async () => {
  const plane = await startPlane();

  try {
    const provisioned = await (
      await identityRequest(plane.url, { body: { sub: "sub-q", email: "q@example.com" } })
    ).json();

    const quotaCheck = () =>
      fetch(`${plane.url}/api/internal/quota-check`, {
        headers: { authorization: `Bearer ${provisioned.gatewayKey}` },
      });

    const before = await (await quotaCheck()).json();
    assert.equal(before.allowed, true);
    assert.equal(before.usageToday.requests, 0);

    const report = await fetch(`${plane.url}/api/internal/usage-report`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${provisioned.gatewayKey}`,
      },
      body: JSON.stringify({ tokensIn: 10, tokensOut: 20, requests: 1, model: "auto/coding" }),
    });
    assert.equal(report.status, 200);

    const after = await (await quotaCheck()).json();
    assert.equal(after.usageToday.requests, 1);
    assert.equal(after.usageToday.tokens_in + after.usageToday.tokens_out, 30);

    const unknownKey = await fetch(`${plane.url}/api/internal/quota-check`, {
      headers: { authorization: "Bearer sk-not-a-key" },
    });
    assert.equal(unknownKey.status, 401);
  } finally {
    await plane.close();
  }
});

test("records an audit row for build, publish and export", async () => {
  const plane = await startPlane();

  try {
    const provisioned = await (
      await identityRequest(plane.url, { body: { sub: "sub-a", email: "a@example.com" } })
    ).json();

    for (const action of ["build.start", "build.publish", "build.export"]) {
      const response = await fetch(`${plane.url}/api/internal/audit`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-control-internal-token": INTERNAL_TOKEN },
        body: JSON.stringify({
          action,
          sub: "sub-a",
          targetId: "app-1",
          meta: { slug: "my-app" },
        }),
      });
      assert.equal(response.status, 201);
    }

    const malformed = await fetch(`${plane.url}/api/internal/audit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-control-internal-token": INTERNAL_TOKEN },
      body: JSON.stringify({ action: "Build Publish!" }),
    });
    assert.equal(malformed.status, 400);

    const db = plane.db();
    const rows = db
      .prepare("SELECT action, actor_id, actor_email, target_id, meta FROM audit_log WHERE action LIKE 'build.%' ORDER BY id")
      .all();
    db.close();

    assert.deepEqual(
      rows.map((row) => row.action),
      ["build.start", "build.publish", "build.export"],
    );
    assert.equal(rows[0].actor_id, provisioned.user.id, "the subject resolves to an account");
    assert.equal(rows[0].actor_email, "a@example.com");
    assert.equal(rows[0].target_id, "app-1");
    assert.equal(JSON.parse(rows[0].meta).slug, "my-app");
  } finally {
    await plane.close();
  }
});

test("a database created before oidc_sub existed gains the column", async () => {
  const path = join(workdir, "legacy.sqlite");

  // The pre-convergence schema, exactly as it was: no oidc_sub, and the unique
  // partial index that depends on it does not exist either.
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      disabled_at TEXT
    );
    INSERT INTO users (id, email, password_hash, role) VALUES ('u1', 'old@example.com', 'scrypt$…', 'user');
  `);
  legacy.close();

  const plane = await startPlane({ dbPath: path });

  try {
    const db = plane.db();
    const columns = db
      .prepare("PRAGMA table_info(users)")
      .all()
      .map((column) => column.name);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_oidc_sub'")
      .all();
    const preserved = db.prepare("SELECT email, oidc_sub FROM users WHERE id = 'u1'").get();
    db.close();

    assert.ok(columns.includes("oidc_sub"));
    assert.equal(indexes.length, 1, "the unique partial index is created too");
    assert.deepEqual(preserved, { email: "old@example.com", oidc_sub: null });

    // And the account is usable through the new route.
    const response = await identityRequest(plane.url, {
      body: { sub: "sub-old", email: "old@example.com" },
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.user.id, "u1");
    assert.equal(payload.oidcSub, "sub-old");
  } finally {
    await plane.close();
  }
});

test("a lockout from a half-provisioned account heals on the next call", async () => {
  const plane = await startPlane();

  try {
    // How an account gets here: the gateways disable a brand-new account whose
    // key could not be minted ("so the next attempt re-provisions instead of
    // half-existing"). Nothing else in the flow ever cleared that flag, so one
    // gateway outage — or a password that did not match — meant every call for
    // the account answered "account disabled" from then on, and only a database
    // edit could undo it.
    const orphan = createUser({ email: "orphan@example.com", passwordHash: "sso:…", role: "user" });
    upsertQuota(orphan.id, { plan: "free" });
    updateUser(orphan.id, { disabled_at: new Date().toISOString() });
    assert.equal(getGatewayKey(orphan.id), undefined, "it never got a key");

    const healed = await identityRequest(plane.url, {
      body: { sub: "sub-orphan", email: "orphan@example.com" },
    });
    const payload = await healed.json();

    assert.equal(healed.status, 200, "a disabled account with no key is a lockout, not a decision");
    assert.equal(payload.user.disabled_at, null, "the stale flag is cleared");
    assert.equal(payload.gatewayKey, "sk-1", "and the account is provisioned on the spot");

    const db = plane.db();
    const recovered = db
      .prepare("SELECT action, target_id FROM audit_log WHERE action = 'user.recovered'")
      .get();
    db.close();
    assert.equal(recovered.target_id, orphan.id, "the recovery is audited, not silent");

    // A disabled account that HAS a key is an operator's decision — a revoked or
    // deliberately switched-off account — and that one still stands.
    const revoked = createUser({ email: "revoked@example.com", passwordHash: "sso:…", role: "user" });
    upsertQuota(revoked.id, { plan: "free" });
    setGatewayKey(revoked.id, { gatewayKeyId: "key-revoked", gatewayKey: "sk-revoked" });
    updateUser(revoked.id, { disabled_at: new Date().toISOString() });

    const stillOff = await identityRequest(plane.url, {
      body: { sub: "sub-revoked", email: "revoked@example.com" },
    });
    assert.equal(stillOff.status, 403);
    assert.match((await stillOff.json()).error, /account disabled/);
  } finally {
    await plane.close();
  }
});

test("a gateway outage no longer turns into a permanent lockout", async () => {
  const gateway = fakeGateway();
  const plane = await startPlane({ gateway });
  const healthyMint = gateway.createApiKey;

  try {
    // First attempt lands while the gateway is down. The account is left
    // disabled (unchanged behaviour) and the caller gets a 502 to retry on.
    gateway.createApiKey = async () => {
      throw new Error("gateway down");
    };
    const during = await identityRequest(plane.url, {
      body: { sub: "sub-outage", email: "outage@example.com" },
    });
    assert.equal(during.status, 502);

    // The gateway comes back. The retry re-provisions — it does not spend the
    // rest of the account's life answering "account disabled".
    gateway.createApiKey = healthyMint;
    const after = await identityRequest(plane.url, {
      body: { sub: "sub-outage", email: "outage@example.com" },
    });
    const payload = await after.json();
    assert.equal(after.status, 200);
    assert.equal(payload.gatewayKey, "sk-1");
    assert.equal(payload.user.disabled_at, null);
  } finally {
    await plane.close();
  }
});
