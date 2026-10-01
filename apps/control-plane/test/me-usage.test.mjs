import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb, createUser, upsertQuota, recordUsage } from "../src/db.js";
import { openSession } from "../src/auth.js";
import { handler } from "../src/http.js";

/**
 * `GET /api/me/usage` — the half of the tenancy layer the *account* reads (M8).
 *
 * The operator console already shows spend; what was missing was a user being
 * able to answer "how much is left" without asking anyone. That is three things
 * on one response: today, the rolling window today sits in, and the caps both
 * are measured against — plus the same allow/deny verdict the gate applies, so
 * the number a person reads and the number that refuses their next turn cannot
 * disagree.
 *
 * Exercised against a real SQLite file and the real HTTP handler, because the
 * parts worth checking are the ones a stub would replace: that the window sums
 * the right days, that a day outside it is excluded, and that the caps and the
 * verdict are the account's own.
 *
 *   node --test test/
 */

let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-usage-test-"));
  // No secret store, no billing, no alerts, no discovery, no gateway: this file
  // is about one route, and each of those would otherwise reach for a network.
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

async function startPlane() {
  const path = join(workdir, `usage-${(dbSeq += 1)}.sqlite`);
  openDb(path);

  const server = createServer((req, res) => {
    handler(req, res, { gateway: {} }).catch((error) => {
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

function usageRequest(url, token) {
  return fetch(`${url}/api/me/usage`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

/** A UTC day `offset` days before today, matching SQLite's `date('now')`. */
function daysAgo(offset) {
  const when = new Date();
  when.setUTCDate(when.getUTCDate() - offset);
  return when.toISOString().slice(0, 10);
}

test("the account's own usage carries today, the window, and the caps it is judged by", async () => {
  const plane = await startPlane();

  try {
    const user = createUser({ email: "reader@example.test", passwordHash: "x", role: "user" });
    const token = openSession(user.id);

    // Today (the default date), two days inside the window, and one well outside
    // it — so the window sum has something to include *and* something to exclude.
    recordUsage(user.id, { tokensIn: 100, tokensOut: 40, requests: 3, costUsd: 0.02 });
    recordUsage(user.id, { date: daysAgo(2), tokensIn: 50, tokensOut: 10, requests: 2, costUsd: 0.01 });
    recordUsage(user.id, { date: daysAgo(30), tokensIn: 999, tokensOut: 999, requests: 99, costUsd: 9.99 });
    upsertQuota(user.id, { plan: "pro", requests_per_day: 50, tokens_per_day: 1000, spend_cap_usd: 5 });

    const response = await usageRequest(plane.url, token);
    assert.equal(response.status, 200);
    const usage = await response.json();

    // Today, unchanged from before this milestone.
    assert.equal(usage.tokens_in, 100);
    assert.equal(usage.tokens_out, 40);
    assert.equal(usage.requests, 3);

    // The window: seven daily rows, inclusive of today, and the 30-day-old day
    // is not one of them.
    assert.equal(usage.window.days, 7);
    assert.equal(usage.window.tokens_in, 150);
    assert.equal(usage.window.tokens_out, 50);
    assert.equal(usage.window.requests, 5);
    assert.ok(Math.abs(usage.window.cost_usd - 0.03) < 1e-9);

    // The caps the account is measured against, and that it is within them.
    assert.equal(usage.caps.plan, "pro");
    assert.equal(usage.caps.requestsPerDay, 50);
    assert.equal(usage.caps.tokensPerDay, 1000);
    assert.equal(usage.caps.spendCapUsd, 5);
    assert.equal(usage.allowed, true);
    assert.deepEqual(usage.reasons, []);
  } finally {
    await plane.close();
  }
});

test("the verdict is the gate's own, so a cap the account has reached reads as reached", async () => {
  const plane = await startPlane();

  try {
    const user = createUser({ email: "capped@example.test", passwordHash: "x", role: "user" });
    const token = openSession(user.id);

    recordUsage(user.id, { tokensIn: 10, tokensOut: 10, requests: 5, costUsd: 0 });
    upsertQuota(user.id, { plan: "free", requests_per_day: 5, tokens_per_day: null, spend_cap_usd: null });

    const usage = await (await usageRequest(plane.url, token)).json();

    assert.equal(usage.allowed, false);
    assert.deepEqual(usage.reasons, ["daily request limit reached"]);
    // An unset cap is `null`, not `0`: uncapped is a real answer and must not
    // read as "no allowance left".
    assert.equal(usage.caps.tokensPerDay, null);
    assert.equal(usage.caps.spendCapUsd, null);
  } finally {
    await plane.close();
  }
});

test("an account with no usage yet still gets a readable answer", async () => {
  const plane = await startPlane();

  try {
    const user = createUser({ email: "fresh@example.test", passwordHash: "x", role: "user" });
    const token = openSession(user.id);

    const usage = await (await usageRequest(plane.url, token)).json();

    assert.equal(usage.requests, 0);
    assert.equal(usage.window.requests, 0);
    assert.deepEqual(usage.models, []);
    // No quota row means the unconstrained default, not a denial.
    assert.equal(usage.allowed, true);
    assert.deepEqual(usage.reasons, []);
  } finally {
    await plane.close();
  }
});

test("one account cannot read another's usage", async () => {
  const plane = await startPlane();

  try {
    const mine = createUser({ email: "mine@example.test", passwordHash: "x", role: "user" });
    const theirs = createUser({ email: "theirs@example.test", passwordHash: "x", role: "user" });
    recordUsage(mine.id, { tokensIn: 7, tokensOut: 3, requests: 1, costUsd: 0 });
    recordUsage(theirs.id, { tokensIn: 900, tokensOut: 900, requests: 9, costUsd: 1 });
    const token = openSession(mine.id);

    const usage = await (await usageRequest(plane.url, token)).json();

    assert.equal(usage.tokens_in, 7);
    assert.equal(usage.window.tokens_in, 7);
  } finally {
    await plane.close();
  }
});

test("reading usage needs a session", async () => {
  const plane = await startPlane();

  try {
    assert.equal((await usageRequest(plane.url, null)).status, 401);
    assert.equal((await usageRequest(plane.url, "not-a-session")).status, 401);
  } finally {
    await plane.close();
  }
});
