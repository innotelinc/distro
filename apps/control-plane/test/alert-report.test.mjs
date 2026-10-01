import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb } from "../src/db.js";

/**
 * `POST /api/internal/alert` — the route that lets a sibling platform report an
 * outage it lived through (M8).
 *
 * The failure this covers cannot be reported when it happens: Genie finds out the
 * control plane is unreachable *because* it could not reach it, and reaches it to
 * say so only once it is back. So the plane receives a named event and pages the
 * operator through the same webhook every other alert uses.
 *
 * The webhook is a real local HTTP server, because the interesting behaviour is
 * the delivery and the cooldown, not a stubbed `fetch`. `alerts.js` reads its
 * configuration at import time, so the environment is set before the dynamic
 * import — no network, no operator.
 */

const INTERNAL_TOKEN = "internal-token";

const received = [];
let webhook;
let workdir = "";
let handler;

function webhookServer() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      received.push({ path: req.url, body: JSON.parse(body || "{}") });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "distro-alert-test-"));
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_INTERNAL_TOKEN = INTERNAL_TOKEN;
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
  process.env.ADMIN_EMAILS = "";

  webhook = webhookServer();
  await new Promise((resolve) => webhook.listen(0, "127.0.0.1", resolve));
  process.env.CONTROL_ALERT_WEBHOOK_URL = `http://127.0.0.1:${webhook.address().port}/hook`;
  // Long enough that two distinct events in this file do not collide, short
  // enough that a second *same-event* call inside a tick is suppressed.
  process.env.CONTROL_ALERT_COOLDOWN_MS = "600000";

  openDb(join(workdir, "control.sqlite"));
  ({ handler } = await import("../src/http.js"));
});

after(() => {
  webhook?.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function callAlert({ event, title, message, token = INTERNAL_TOKEN } = {}) {
  const server = createServer((req, res) => {
    handler(req, res, { gateway: {} }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/internal/alert`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { "x-control-internal-token": token } : {}),
      },
      body: JSON.stringify({ event, title, message }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a reported outage reaches the operator's webhook", async () => {
  const before = received.length;
  const { status, body } = await callAlert({
    event: "controlplane.unreachable",
    title: "Genie could not reach the tenancy service",
    message: "3 turns were refused between 10:02 and 10:07.",
  });

  assert.equal(status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.sent, true);
  assert.equal(received.length, before + 1);

  const posted = received.at(-1).body;
  assert.equal(posted.event, "controlplane.unreachable");
  assert.equal(posted.title, "Genie could not reach the tenancy service");
  assert.equal(posted.message, "3 turns were refused between 10:02 and 10:07.");
  assert.equal(posted.source, "distro-control-plane");
  assert.ok(posted.time, "the payload carries a timestamp");
});

test("the same event inside its cooldown is received but not re-sent", async () => {
  const before = received.length;
  const { status, body } = await callAlert({
    event: "controlplane.unreachable",
    title: "again",
    message: "a retry storm, not a second outage",
  });

  assert.equal(status, 202);
  assert.equal(body.ok, true);
  assert.equal(body.sent, false);
  assert.equal(body.reason, "cooldown");
  assert.equal(received.length, before, "the cooldown suppressed the second page");
});

test("a different event is not suppressed by another event's cooldown", async () => {
  const before = received.length;
  const { status, body } = await callAlert({ event: "sync.stale", title: "sync went quiet" });
  assert.equal(status, 202);
  assert.equal(body.sent, true);
  assert.equal(received.length, before + 1);
});

test("an event name that is not a lowercase dotted name is refused", async () => {
  const before = received.length;
  const { status } = await callAlert({ event: "Not An Event", title: "x" });
  assert.equal(status, 400);
  assert.equal(received.length, before, "nothing was posted for an invalid event");
});

test("the route is a service call: a wrong or missing token is refused", async () => {
  const before = received.length;
  const wrong = await callAlert({ event: "controlplane.unreachable", title: "x", token: "not-the-token" });
  assert.equal(wrong.status, 401);
  const missing = await callAlert({ event: "controlplane.unreachable", title: "x", token: "" });
  assert.equal(missing.status, 401);
  assert.equal(received.length, before);
});
