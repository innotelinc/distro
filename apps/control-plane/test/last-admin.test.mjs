import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb, createUser, getUserById, listAudit, updateUser } from "../src/db.js";
import { openSession } from "../src/auth.js";
import { handler } from "../src/http.js";

/**
 * The plane must not be able to lock its operator out.
 *
 * `PATCH /api/admin/users/:id {role:"user"}` on the last admin was already
 * refused. Disabling that account is the same lockout through a different
 * field — and one the console's Disable button made easy — because a disabled
 * account's sessions stop resolving at once. One active admin remains required;
 * with a second one present the action is ordinary.
 */

let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-last-admin-"));
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

async function world() {
  openDb(join(workdir, `last-admin-${(seq += 1)}.sqlite`));
  const admin = createUser({ email: "ops@example.com", passwordHash: "x", role: "admin" });
  const server = createServer((req, res) => {
    handler(req, res, {}).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const patch = (user, id, body) =>
    fetch(`${base}/api/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${openSession(user.id)}` },
      body: JSON.stringify(body),
    });
  return { admin, base, patch, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the last active admin cannot disable themselves", async () => {
  const w = await world();
  try {
    const res = await w.patch(w.admin, w.admin.id, { disabled: true });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /last active admin/);
    assert.equal(getUserById(w.admin.id).disabled_at, null, "a refused disable writes nothing");
    assert.equal(
      listAudit(5, { actionPrefix: "user.update" }).length,
      0,
      "a refused disable is not recorded as an update",
    );
  } finally {
    await w.close();
  }
});

test("with a second active admin the first can be disabled", async () => {
  const w = await world();
  try {
    const second = createUser({ email: "ops2@example.com", passwordHash: "x", role: "admin" });
    const res = await w.patch(second, w.admin.id, { disabled: true });
    assert.equal(res.status, 200);
    assert.ok(getUserById(w.admin.id).disabled_at, "the account is disabled");
    // The disabled admin's own session no longer resolves, which is exactly why
    // the last-admin guard has to exist.
    const own = await fetch(`${w.base}/api/admin/stats`, {
      headers: { authorization: `Bearer ${openSession(w.admin.id)}` },
    });
    assert.equal(own.status, 401);
  } finally {
    await w.close();
  }
});

test("re-enabling is never blocked", async () => {
  const w = await world();
  try {
    const second = createUser({ email: "ops2@example.com", passwordHash: "x", role: "admin" });
    updateUser(w.admin.id, { disabled_at: new Date().toISOString() });

    const res = await w.patch(second, w.admin.id, { disabled: false });
    assert.equal(res.status, 200);
    assert.equal(getUserById(w.admin.id).disabled_at, null);
  } finally {
    await w.close();
  }
});
