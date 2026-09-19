import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { GatewayClient, extractVersion, normalizeVersion } from "../src/gateway.js";
import {
  DEFAULT_EXPECTED_VERSION,
  checkGatewayVersion,
  compatible,
  expectedGatewayVersion,
  resetGatewayVersionCheck,
} from "../src/gatewayVersion.js";

/**
 * The version pin is a statement about which OmniRoute release the inventory
 * and the ledger schema were verified against. What matters here is that the
 * probe survives payloads it was not written for, that a mismatch is a warning
 * and never a throw, and that "could not tell" is reported as unchecked rather
 * than as either verdict.
 */

before(() => {
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
});

after(() => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
});

/** A gateway whose health routes answer as configured. */
async function fakeGateway(routes) {
  const server = createServer((req, res) => {
    const route = routes[req.url];
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(route.status || 200, { "content-type": "application/json" });
    res.end(typeof route.body === "string" ? route.body : JSON.stringify(route.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    client: new GatewayClient({ dashboardUrl: `http://127.0.0.1:${port}` }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const quiet = { log: { warn: () => {} } };

test("normalizeVersion strips prefixes and suffixes, rejects noise", () => {
  assert.equal(normalizeVersion("v3.8.51"), "3.8.51");
  assert.equal(normalizeVersion("3.8.51-web"), "3.8.51");
  assert.equal(normalizeVersion("  3.9.0 "), "3.9.0");
  assert.equal(normalizeVersion("latest"), null);
  assert.equal(normalizeVersion(""), null);
  assert.equal(normalizeVersion(null), null);
});

test("extractVersion finds the version under the names it has appeared under", () => {
  assert.deepEqual(extractVersion({ version: "3.8.51" }), { version: "3.8.51", buildSha: null });
  assert.deepEqual(extractVersion({ build: { version: "v3.8.51", sha: "abcdef1234" } }), { version: "3.8.51", buildSha: "abcdef1234" });
  assert.deepEqual(extractVersion({ status: "ok", buildSha: "0123abc" }), { version: null, buildSha: "0123abc" });
  assert.deepEqual(extractVersion({ buildSha: "not-a-sha!" }), { version: null, buildSha: null });
  assert.deepEqual(extractVersion(null), { version: null, buildSha: null });
  assert.deepEqual(extractVersion("3.8.51"), { version: null, buildSha: null });
});

test("compatible is exact-match, and null when either side is unknown", () => {
  assert.equal(compatible("3.8.51", "v3.8.51"), true);
  assert.equal(compatible("3.8.51", "3.8.52"), false);
  assert.equal(compatible("3.8.51", null), null);
  assert.equal(compatible(null, "3.8.51"), null);
});

test("the pin defaults to the verified release and can be moved or disabled", () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  assert.equal(expectedGatewayVersion(), DEFAULT_EXPECTED_VERSION);
  process.env.GATEWAY_EXPECTED_VERSION = "v3.9.0";
  assert.equal(expectedGatewayVersion(), "3.9.0");
  process.env.GATEWAY_EXPECTED_VERSION = "   ";
  assert.equal(expectedGatewayVersion(), null);
  // A tag is not a version: no pin, rather than a permanent false mismatch.
  process.env.GATEWAY_EXPECTED_VERSION = "latest";
  assert.equal(expectedGatewayVersion(), null);
  delete process.env.GATEWAY_EXPECTED_VERSION;
});

test("a monitoring route without a version lets /api/health supply it", async () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  resetGatewayVersionCheck();
  const gw = await fakeGateway({
    "/api/monitoring/health": { body: { status: "healthy", buildSha: "abc1234" } },
    "/api/health": { body: { version: DEFAULT_EXPECTED_VERSION } },
  });
  try {
    const result = await checkGatewayVersion(gw.client, quiet);
    assert.equal(result.endpoint, "/api/health");
    assert.equal(result.compatible, true);
  } finally {
    await gw.close();
  }
});

test("a matching gateway is compatible", async () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  resetGatewayVersionCheck();
  const gw = await fakeGateway({ "/api/monitoring/health": { body: { status: "ok", version: DEFAULT_EXPECTED_VERSION, buildSha: "deadbeef" } } });
  try {
    const result = await checkGatewayVersion(gw.client, quiet);
    assert.equal(result.compatible, true);
    assert.equal(result.running, DEFAULT_EXPECTED_VERSION);
    assert.equal(result.buildSha, "deadbeef");
    assert.equal(result.endpoint, "/api/monitoring/health");
    assert.equal(result.error, null);
  } finally {
    await gw.close();
  }
});

test("a mismatch is warned, not thrown, and the sync caller keeps going", async () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  resetGatewayVersionCheck();
  const warnings = [];
  const gw = await fakeGateway({ "/api/monitoring/health": { body: { version: "3.9.0" } } });
  try {
    const result = await checkGatewayVersion(gw.client, { log: { warn: (m) => warnings.push(m) } });
    assert.equal(result.compatible, false);
    assert.equal(result.running, "3.9.0");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /version mismatch/);
    assert.match(warnings[0], /GATEWAY_EXPECTED_VERSION/);
  } finally {
    await gw.close();
  }
});

test("the probe falls back to /api/health when the monitoring route is missing", async () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  resetGatewayVersionCheck();
  const gw = await fakeGateway({ "/api/health": { body: { ok: true, appVersion: `v${DEFAULT_EXPECTED_VERSION}` } } });
  try {
    const result = await checkGatewayVersion(gw.client, quiet);
    assert.equal(result.endpoint, "/api/health");
    assert.equal(result.compatible, true);
  } finally {
    await gw.close();
  }
});

test("a health route that does not say its version is unchecked, not incompatible", async () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  resetGatewayVersionCheck();
  const gw = await fakeGateway({ "/api/monitoring/health": { body: { status: "healthy", providers: { activeCount: 3 } } } });
  try {
    const result = await checkGatewayVersion(gw.client, quiet);
    assert.equal(result.compatible, null);
    assert.equal(result.running, null);
    assert.equal(result.error, null);
    assert.equal(result.endpoint, "/api/monitoring/health", "the route that answered is still reported");
  } finally {
    await gw.close();
  }
});

test("an unreachable gateway is recorded as an error with no verdict", async () => {
  delete process.env.GATEWAY_EXPECTED_VERSION;
  resetGatewayVersionCheck();
  const gw = await fakeGateway({});
  await gw.close(); // nothing listening any more
  const result = await checkGatewayVersion(gw.client, quiet);
  assert.equal(result.compatible, null);
  assert.match(result.error, /version probe failed/);
});

test("an empty pin disables the check", async () => {
  process.env.GATEWAY_EXPECTED_VERSION = "";
  resetGatewayVersionCheck();
  const gw = await fakeGateway({ "/api/monitoring/health": { body: { version: "0.0.1" } } });
  try {
    const result = await checkGatewayVersion(gw.client, quiet);
    assert.equal(result.expected, null);
    assert.equal(result.compatible, null);
    assert.match(result.error, /disabled/);
  } finally {
    await gw.close();
    delete process.env.GATEWAY_EXPECTED_VERSION;
  }
});
