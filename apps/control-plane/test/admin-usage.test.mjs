import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb, createUser, recordUsage } from "../src/db.js";
import { openSession } from "../src/auth.js";
import { handler } from "../src/http.js";
import { usageDay, usageDayShift } from "../src/usageDay.js";

/**
 * The operator's trend view.
 *
 * Two properties matter more than the arithmetic: the window is *complete* (a
 * day with no traffic is a zero row, because a chart that closes the gap is a
 * chart that lies about a quiet Sunday), and the series is read from the same
 * `usage_cache` rows the quota gate uses, so the dashboard cannot disagree with
 * the number that refuses a turn.
 */

let workdir = "";

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-admin-usage-"));
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
  openDb(join(workdir, `admin-usage-${(seq += 1)}.sqlite`));
  const admin = createUser({ email: "ops@example.com", passwordHash: "x", role: "admin" });
  const customer = createUser({ email: "customer@example.com", passwordHash: "x", role: "user" });
  const other = createUser({ email: "other@example.com", passwordHash: "x", role: "user" });

  const server = createServer((req, res) => {
    handler(req, res, {}).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    admin,
    customer,
    other,
    base,
    close: () => new Promise((resolve) => server.close(resolve)),
    headers: (user) => ({ authorization: `Bearer ${openSession(user.id)}` }),
    get: (user, path) => fetch(`${base}${path}`, { headers: user ? { authorization: `Bearer ${openSession(user.id)}` } : {} }),
  };
}

test("a customer cannot read the operator's trend", async () => {
  const w = await world();
  try {
    const res = await w.get(w.customer, "/api/admin/usage?days=14");
    assert.equal(res.status, 403);
  } finally {
    await w.close();
  }
});

test("the series is exactly the window requested, oldest first, with empty days as zero", async () => {
  const w = await world();
  try {
    const today = usageDay();
    recordUsage(w.customer.id, { date: today, tokensIn: 100, tokensOut: 40, requests: 2, costUsd: 0.5 });
    // Two days ago, not yesterday: the day between must still be present and zero.
    const twoDaysAgo = usageDayShift(today, -2);
    recordUsage(w.customer.id, { date: twoDaysAgo, tokensIn: 7, tokensOut: 3, requests: 1, costUsd: 0.01 });

    const res = await w.get(w.admin, "/api/admin/usage?days=5");
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.days, 5);
    assert.equal(body.series.length, 5);
    assert.equal(body.series[4].date, today);
    assert.equal(body.series[0].date, usageDayShift(today, -4));
    assert.equal(body.series[4].costUsd, 0.5);
    assert.equal(body.series[4].tokensIn, 100);
    assert.equal(body.series[2].date, twoDaysAgo);
    assert.equal(body.series[2].requests, 1);
    assert.deepEqual(
      { ...body.series[3] },
      { date: usageDayShift(today, -1), requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
      "a day with no traffic is a zero row, never a gap",
    );
  } finally {
    await w.close();
  }
});

test("top spenders are ordered by spend across accounts, not by one account's keys", async () => {
  const w = await world();
  try {
    const today = usageDay();
    recordUsage(w.customer.id, { date: today, tokensIn: 10, tokensOut: 5, requests: 10, costUsd: 2 });
    recordUsage(w.other.id, { date: today, tokensIn: 10, tokensOut: 5, requests: 3, costUsd: 0.25 });
    recordUsage(w.other.id, { date: usageDayShift(today, -1), tokensIn: 1, tokensOut: 1, requests: 1, costUsd: 0.5 });

    const body = await (await w.get(w.admin, "/api/admin/usage?days=7")).json();
    assert.equal(body.top.length, 2);
    assert.equal(body.top[0].email, "customer@example.com");
    assert.equal(body.top[0].costUsd, 2);
    assert.equal(body.top[1].email, "other@example.com");
    assert.equal(body.top[1].costUsd, 0.75, "one account's days are summed before the ranking");
  } finally {
    await w.close();
  }
});

test("a nonsense window is clamped, not rejected into a broken chart", async () => {
  const w = await world();
  try {
    for (const days of ["0", "-4", "10000", "nope"]) {
      const res = await w.get(w.admin, `/api/admin/usage?days=${days}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.ok(body.series.length >= 1 && body.series.length <= 90, `days=${days} produced ${body.series.length} rows`);
      assert.equal(body.series.at(-1).date, usageDay(), "the window always ends today");
    }
  } finally {
    await w.close();
  }
});
