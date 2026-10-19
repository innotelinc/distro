import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb, createUser, getUserByEmail, upsertQuota } from "../src/db.js";
import { creditBalance, creditHistory, creditStatus, creditsPerProject, creditPriceUsd, grantCredits, spendCredits } from "../src/credits.js";
import { issueServiceCredential } from "../src/serviceCredentials.js";
import { handler } from "../src/http.js";

/**
 * Credits: the balance, the charges, and the two ways a metered service goes wrong.
 *
 * The cases that matter are not "a grant adds up". They are the ones that cost
 * somebody money or trust: a retried project being charged twice, two projects
 * started at the same moment both spending the last credit, a service credential
 * with read-only scope being able to spend, and a service *account* being asked to
 * pay for anything at all.
 *
 * The schema comes from the real `schema.sql` (via `openDb`), because the unique
 * index that makes a retry safe is part of the behaviour under test.
 */

const INTERNAL_TOKEN = "internal-token";
let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-credits-test-"));
  // No secret store, no billing, no alerts, no discovery: this file is about
  // credits, and each of those would otherwise reach for a network.
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
  process.env.ADMIN_EMAILS = "";
  delete process.env.CONTROL_CREDIT_PRICE_USD;
  delete process.env.CONTROL_CREDITS_PER_PROJECT;
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

let dbSeq = 0;

/** A fresh database with one account, and the id every ledger row is keyed on. */
function freshAccount(email = "customer@example.com") {
  const path = join(workdir, `credits-${(dbSeq += 1)}.sqlite`);
  openDb(path);
  const user = createUser({ email, passwordHash: "x", role: "user" });
  return { path, user, dbPath: path };
}

test("a balance is the sum of its ledger, and the history says where it went", () => {
  const { user } = freshAccount();
  assert.equal(creditBalance(user.id), 0);

  grantCredits({ userId: user.id, credits: 3, reason: "purchase", reference: "order-1" });
  grantCredits({ userId: user.id, credits: 2, reason: "goodwill" });
  assert.equal(creditBalance(user.id), 5);

  const spend = spendCredits({ userId: user.id, reference: "project-a", reason: "reverse engineer project-a" });
  assert.equal(spend.ok, true);
  assert.equal(spend.spent, 1);
  assert.equal(spend.balance, 4);

  const history = creditHistory(user.id);
  assert.equal(history.length, 3);
  // Newest first, and the spend is negative: a ledger a customer can read.
  assert.equal(history[0].kind, "spend");
  assert.equal(history[0].delta, -1);
  assert.equal(history[0].reference, "project-a");
  assert.equal(history.reduce((sum, row) => sum + row.delta, 0), 4);
});

test("a retried charge is the same charge, not a second one", () => {
  const { user } = freshAccount();
  grantCredits({ userId: user.id, credits: 2 });

  const first = spendCredits({ userId: user.id, reference: "project-a" });
  const retry = spendCredits({ userId: user.id, reference: "project-a" });

  assert.equal(first.ok, true);
  assert.equal(retry.ok, true);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.spent, 0);
  assert.equal(creditBalance(user.id), 1, "one project costs one credit however many times it is started");

  // A *different* project is a different charge.
  const other = spendCredits({ userId: user.id, reference: "project-b" });
  assert.equal(other.ok, true);
  assert.equal(creditBalance(user.id), 0);
});

test("a charge cannot go below zero, and the refusal says how much is left", () => {
  const { user } = freshAccount();
  grantCredits({ userId: user.id, credits: 1 });
  spendCredits({ userId: user.id, reference: "project-a" });

  const refused = spendCredits({ userId: user.id, reference: "project-b" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "insufficient_credits");
  assert.equal(refused.balance, 0);
  assert.equal(refused.required, 1);
  assert.equal(creditBalance(user.id), 0, "a refused charge writes nothing");

  const status = creditStatus({ userId: user.id });
  assert.equal(status.allowed, false);
  assert.equal(status.balance, 0);
  assert.match(status.reason, /no credits left/);
});

test("a purchase webhook delivered twice grants once", () => {
  const { user } = freshAccount();
  const first = grantCredits({ userId: user.id, credits: 5, reference: "order-9", reason: "purchase" });
  const second = grantCredits({ userId: user.id, credits: 5, reference: "order-9", reason: "purchase" });

  assert.equal(first.granted, 5);
  assert.equal(second.granted, 0);
  assert.equal(second.duplicate, true);
  assert.equal(creditBalance(user.id), 5);
});

test("a service account is unlimited, and is not asked for credits", () => {
  const status = creditStatus({ userId: "irrelevant", service: true });
  assert.equal(status.service, true);
  assert.equal(status.allowed, true);
  assert.equal(status.unlimited, true);
  assert.equal(status.balance, null, "no balance, rather than an enormous one");
  assert.match(status.reason, /service account/);
});

test("the price of a credit is reported, and a deployment may state its own", () => {
  assert.equal(creditPriceUsd(), 5, "the shipped default matches the plan Magnate sells");
  assert.equal(creditsPerProject(), 1, "one project is one credit");

  process.env.CONTROL_CREDIT_PRICE_USD = "7.5";
  process.env.CONTROL_CREDITS_PER_PROJECT = "2";
  try {
    assert.equal(creditPriceUsd(), 7.5);
    assert.equal(creditsPerProject(), 2);
    const status = creditStatus({ userId: "u" });
    assert.equal(status.price_per_credit_usd, 7.5);
    assert.equal(status.credits_per_project, 2);
  } finally {
    delete process.env.CONTROL_CREDIT_PRICE_USD;
    delete process.env.CONTROL_CREDITS_PER_PROJECT;
  }
});

// --- the routes -------------------------------------------------------------

async function startPlane() {
  const path = join(workdir, `plane-${(dbSeq += 1)}.sqlite`);
  openDb(path);
  process.env.CONTROL_INTERNAL_TOKEN = INTERNAL_TOKEN;

  const server = createServer((req, res) => {
    handler(req, res, {}).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function ask(url, path, { token = INTERNAL_TOKEN, method = "GET", body } = {}) {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { "x-control-internal-token": token }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("the credit routes answer a service, and refuse a credential without the scope", async () => {
  const plane = await startPlane();
  try {
    // A real account, with a real balance, granted through the route.
    const email = "route@example.com";
    const user = createUser({ email, passwordHash: "x", role: "user" });

    const granted = await ask(plane.url, "/api/internal/credits/grant", {
      method: "POST",
      body: { user: email, credits: 2, reference: "order-42", reason: "purchase" },
    });
    assert.equal(granted.status, 200);
    const grantedBody = await granted.json();
    assert.equal(grantedBody.granted, 2);
    assert.equal(grantedBody.balance, 2);

    // Delivered twice: no second grant.
    const again = await ask(plane.url, "/api/internal/credits/grant", {
      method: "POST",
      body: { user: email, credits: 2, reference: "order-42" },
    });
    assert.equal((await again.json()).duplicate, true);

    const read = await ask(plane.url, `/api/internal/credits?user=${encodeURIComponent(email)}`);
    assert.equal(read.status, 200);
    const status = await read.json();
    assert.equal(status.balance, 2);
    assert.equal(status.allowed, true);
    assert.equal(status.price_per_credit_usd, 5);
    assert.equal(status.credits_per_project, 1);

    // A charge for a project, then the same project again.
    const spent = await ask(plane.url, "/api/internal/credits/spend", {
      method: "POST",
      body: { user: email, reference: "project-1", reason: "reverse engineer project-1" },
    });
    const spentBody = await spent.json();
    assert.equal(spentBody.ok, true);
    assert.equal(spentBody.balance, 1);

    const retry = await ask(plane.url, "/api/internal/credits/spend", {
      method: "POST",
      body: { user: email, reference: "project-1" },
    });
    assert.equal((await retry.json()).duplicate, true);

    // An address with no account here is not a customer: an answer, not an error.
    const stranger = await ask(plane.url, "/api/internal/credits?user=nobody@example.com");
    assert.equal(stranger.status, 200);
    assert.equal((await stranger.json()).reason, "user_not_found");

    // A service account is unlimited, and spending nothing.
    upsertQuota(user.id, { plan: "service", requests_per_day: null, tokens_per_day: null, spend_cap_usd: null });
    const serviceSpend = await ask(plane.url, "/api/internal/credits/spend", {
      method: "POST",
      body: { user: email, reference: "project-2" },
    });
    const serviceBody = await serviceSpend.json();
    assert.equal(serviceBody.service, true);
    assert.equal(serviceBody.unlimited, true);
    assert.equal(serviceBody.spent, 0);
    assert.equal(serviceBody.balance, null);

    // The scope boundary: a credential issued for reading cannot spend.
    const reader = issueServiceCredential({ surface: "reader", scopes: ["credits:read"] });
    const refusedSpend = await ask(plane.url, "/api/internal/credits/spend", {
      method: "POST",
      token: reader.token,
      body: { user: email, reference: "project-3" },
    });
    assert.equal(refusedSpend.status, 403);
    assert.match((await refusedSpend.json()).error, /credits:write/);

    // And the same credential cannot read either, if it was not issued that scope.
    const other = issueServiceCredential({ surface: "other", scopes: ["identity:resolve"] });
    const refusedRead = await ask(plane.url, `/api/internal/credits?user=${encodeURIComponent(email)}`, {
      token: other.token,
    });
    assert.equal(refusedRead.status, 403);
    assert.match((await refusedRead.json()).error, /credits:read/);
  } finally {
    await plane.close();
  }
});
