import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb, createUser } from "../src/db.js";
import { creditBalance, creditHistory } from "../src/credits.js";
import { openSession } from "../src/auth.js";
import { handler } from "../src/http.js";

/**
 * An operator adding credits, through the console's own route.
 *
 * The cases here are the ones that make a manual grant safe to hand to a person
 * rather than a script: it is an admin's route (not anybody's), a mistyped amount
 * is refused before it reaches the ledger, the balance the console reads back is
 * the one that changed, and the ledger row names the admin who did it.
 */

let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-admin-credits-"));
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
  process.env.ADMIN_EMAILS = "";
  delete process.env.CONTROL_CREDIT_PRICE_USD;
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

let seq = 0;

/** A database with an admin and a customer, and a server in front of it. */
async function world() {
  openDb(join(workdir, `admin-credits-${(seq += 1)}.sqlite`));
  const admin = createUser({ email: "ops@example.com", passwordHash: "x", role: "admin" });
  const customer = createUser({ email: "customer@example.com", passwordHash: "x", role: "user" });
  const server = createServer((req, res) => {
    handler(req, res, {}).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((resolve) => server.close(resolve));
  return {
    admin,
    customer,
    base,
    close,
    as: (user) => ({ authorization: `Bearer ${openSession(user.id)}` }),
    post: (user, body) =>
      fetch(`${base}/api/admin/credits/grant`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(user ? { authorization: `Bearer ${openSession(user.id)}` } : {}) },
        body: JSON.stringify(body),
      }),
  };
}

test("a customer cannot grant themselves credits", async () => {
  const w = await world();
  try {
    const res = await w.post(w.customer, { user: w.customer.email, credits: 5 });
    assert.equal(res.status, 403);
    assert.equal(creditBalance(w.customer.id), 0, "a refused grant writes nothing");
  } finally {
    await w.close();
  }
});

test("a grant is whole credits, and a bad amount never reaches the ledger", async () => {
  const w = await world();
  try {
    for (const credits of [0, -2, 1.5, "two", null]) {
      const res = await w.post(w.admin, { user: w.customer.email, credits });
      assert.equal(res.status, 400, `credits=${JSON.stringify(credits)} should be refused`);
    }
    const unknown = await w.post(w.admin, { user: "nobody@example.com", credits: 1 });
    assert.equal(unknown.status, 404);
    assert.equal(creditHistory(w.customer.id).length, 0);
  } finally {
    await w.close();
  }
});

test("a grant lands, is attributed to the admin, and a repeated reference does not double it", async () => {
  const w = await world();
  try {
    const body = { user: w.customer.email, credits: 3, reason: "invoice 88, credited by hand", reference: "ticket-88" };

    const first = await w.post(w.admin, body);
    assert.equal(first.status, 200);
    const granted = await first.json();
    assert.equal(granted.balance, 3);
    assert.equal(granted.duplicate, false);

    const replay = await (await w.post(w.admin, body)).json();
    assert.equal(replay.duplicate, true);
    assert.equal(replay.balance, 3, "the same reference is the same grant");

    const [row] = creditHistory(w.customer.id);
    assert.equal(row.actor_email, w.admin.email);
    assert.equal(row.reason, "invoice 88, credited by hand");

    const read = await fetch(`${w.base}/api/admin/credits?user=${encodeURIComponent(w.customer.email)}`, {
      headers: w.as(w.admin),
    });
    assert.equal(read.ok, true);
    const view = await read.json();
    assert.equal(view.balance, 3);
    assert.equal(view.entries.length, 1);
    assert.equal(view.entries[0].reference, "ticket-88");

    // The users list carries the balance, so the console's table shows the change
    // without a second request per row.
    const users = await (await fetch(`${w.base}/api/admin/users`, { headers: w.as(w.admin) })).json();
    assert.equal(users.users.find((u) => u.email === w.customer.email).credits, 3);
  } finally {
    await w.close();
  }
});
