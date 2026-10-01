import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { GatewayClient } from "../src/gateway.js";

/**
 * A minted key must only be able to spend on the providers this deployment
 * connected.
 *
 * The gateway answers "which providers do I have" at `GET /api/providers`, and
 * `allowedConnections` on a key is what turns that answer into enforcement — when
 * one is set, a router skips every provider outside it. This file holds the two
 * edges that matter: the scope is the *enabled* connections, and a providers read
 * that fails mints an unscoped key rather than refusing to mint.
 */

/** A dashboard that records what it was asked for and answers as configured. */
async function fakeDashboard({ providers }) {
  const seen = { requests: [] };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.url === "/api/providers") {
        if (!providers) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end('{"error":"nope"}');
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(providers));
        return;
      }
      if (req.url === "/api/keys" && req.method === "POST") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "key-1", key: "sk-1", name: "minted" }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    client: new GatewayClient({ dashboardUrl: `http://127.0.0.1:${port}` }),
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const CONNECTED = {
  connections: [
    { id: "c-agentrouter", provider: "agentrouter", isActive: true },
    { id: "c-openrouter", provider: "openrouter", isActive: true },
    { id: "c-opencode", provider: "opencode", isActive: false },
    { id: "c-backoff", provider: "gemini", isActive: true, backoffLevel: 2 },
    { id: "c-limited", provider: "aihorde", isActive: true, rateLimitProtection: true },
  ],
};

test("only the switched-on connections are read", async () => {
  const { client, close } = await fakeDashboard({ providers: CONNECTED });
  try {
    assert.deepEqual(await client.enabledConnectionIds(), ["c-agentrouter", "c-openrouter"]);
  } finally {
    await close();
  }
});

test("a minted key is scoped to them, without the caller asking", async () => {
  const { client, seen, close } = await fakeDashboard({ providers: CONNECTED });
  try {
    assert.equal((await client.createApiKey("genie-user-abc")).key, "sk-1");
    const mint = seen.requests.find((request) => request.url === "/api/keys");
    assert.deepEqual(mint.body.allowedConnections, ["c-agentrouter", "c-openrouter"]);
    assert.equal(mint.body.name, "genie-user-abc");
  } finally {
    await close();
  }
});

test("an unreadable provider list mints unscoped rather than failing", async () => {
  const { client, seen, close } = await fakeDashboard({ providers: null });
  try {
    assert.equal((await client.createApiKey("genie-user-abc")).id, "key-1");
    const mint = seen.requests.find((request) => request.url === "/api/keys");
    assert.equal("allowedConnections" in mint.body, false);
  } finally {
    await close();
  }
});

test("an empty connection set is not sent as an empty scope", async () => {
  const { client, seen, close } = await fakeDashboard({ providers: { connections: [] } });
  try {
    await client.createApiKey("genie-user-abc");
    const mint = seen.requests.find((request) => request.url === "/api/keys");
    assert.equal("allowedConnections" in mint.body, false);
  } finally {
    await close();
  }
});

test("a caller that names its own scope keeps it", async () => {
  const { client, seen, close } = await fakeDashboard({ providers: CONNECTED });
  try {
    await client.createApiKey("genie-user-abc", { allowedConnections: ["c-openrouter"] });
    const mint = seen.requests.find((request) => request.url === "/api/keys");
    assert.deepEqual(mint.body.allowedConnections, ["c-openrouter"]);
    assert.equal(
      seen.requests.some((request) => request.url === "/api/providers"),
      false,
      "a caller-supplied scope needs no provider read",
    );
  } finally {
    await close();
  }
});
