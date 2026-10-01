import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb } from "../src/db.js";
import { handler } from "../src/http.js";

/**
 * The bare host has to show the console.
 *
 * `distro.innotel.us` publishes this control plane (roadmap: "the Cerulean edge
 * now serves distro.innotel.us, cp.distro.innotel.us and admin.distro.innotel.us
 * over HTTPS to the control plane on port 20140"), but `/` is not an API route,
 * so it fell through to the catch-all 401 and a visitor saw
 * `{"error":"unauthorized"}` — an API answering where a UI was expected.
 *
 * These checks pin the fix from both sides: `/` reaches the console, and the
 * routes that are real (the console itself, health, the API) are untouched.
 *
 *   node --test test/
 */

function stubGateway() {
  return {
    login: async () => "session=1",
    createApiKey: async (name) => ({ id: "key-1", key: "sk-1", name }),
    revokeApiKey: async () => {},
  };
}

let workdir = "";
let seq = 0;

before(() => {
  workdir = mkdtempSync(join(tmpdir(), "distro-root-test-"));
  // Nothing in this file reaches a network: no secret store, no billing, no
  // discovery, no background sync.
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

async function startPlane() {
  openDb(join(workdir, `root-${(seq += 1)}.sqlite`));

  const server = createServer((req, res) => {
    handler(req, res, { gateway: stubGateway() }).catch((error) => {
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

test("the bare host redirects to the console", async () => {
  const plane = await startPlane();

  try {
    // `redirect: "manual"` so the redirect itself is the assertion rather than
    // whatever axe the console's data calls make after it.
    const response = await fetch(`${plane.url}/`, { redirect: "manual" });

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/admin", "a relative Location keeps the origin (and its SSO cookie)");
  } finally {
    await plane.close();
  }
});

test("the redirect does not swallow the routes that are real", async () => {
  const plane = await startPlane();

  try {
    const console_ = await fetch(`${plane.url}/admin`);
    assert.equal(console_.status, 200);
    assert.match(console_.headers.get("content-type") ?? "", /text\/html/);

    const health = await fetch(`${plane.url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    // An API route keeps answering as the API: with no token the internal API
    // is off, which is a 503 and never a redirect to the console.
    const api = await fetch(`${plane.url}/api/internal/quota-check`, { redirect: "manual" });
    assert.notEqual(api.status, 302);
  } finally {
    await plane.close();
  }
});
