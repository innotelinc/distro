import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { openDb } from "../src/db.js";

/**
 * Where an Authentik sign-in comes back to.
 *
 * The failure this covers was live: the console is served on
 * `admin.distro.innotel.us` while the only registered callback was
 * `http://192.168.1.46:20140/...`, so the provider returned the browser to a
 * different origin, the host-only `distro_oidc_state` cookie was not sent with
 * it, and the console answered "Sign-in failed: invalid or expired state."
 *
 * The module reads its configuration at import time, so the environment is set
 * before the dynamic import below and the discovery document is stubbed through
 * the global fetch — no network, no Authentik.
 */

const CALLBACKS = [
  "https://admin.distro.innotel.us/api/auth/oidc/callback",
  "https://cp.distro.innotel.us/api/auth/oidc/callback",
  "http://192.168.1.46:20140/api/auth/oidc/callback",
];

let workdir = "";
let plane;
let oidc;
let database;
let realFetch;


before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "distro-oidc-test-"));
  process.env.VAULT_ADDR = "";
  process.env.INFISICAL_ADDR = "";
  process.env.MAGNATE_URL = "";
  process.env.CONTROL_ALERT_WEBHOOK_URL = "";
  process.env.CONTROL_CONSUL_URL = "";
  process.env.CONTROL_SYNC_INTERVAL_MS = "0";
  process.env.ADMIN_EMAILS = "";
  process.env.BREAKGLASS_LOGIN = "";
  process.env.OIDC_ISSUER_URL = "https://auth.cerulean.innotel.us/application/o/distro/";
  process.env.OIDC_CLIENT_ID = "distro";
  process.env.OIDC_CLIENT_SECRET = "secret";
  process.env.OIDC_REDIRECT_URI = CALLBACKS.join(",");

  // Discovery and the token endpoint, without Authentik. Only requests to the
  // issuer are intercepted — this file's own calls to the plane go to the real
  // fetch, or the stub would answer them too.
  realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    if (!url.startsWith("https://auth.cerulean.innotel.us/")) return realFetch(input, init);
    if (url.includes(".well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: "https://auth.cerulean.innotel.us/application/o/distro/",
          authorization_endpoint: "https://auth.cerulean.innotel.us/application/o/authorize/",
          token_endpoint: "https://auth.cerulean.innotel.us/application/o/token/",
          userinfo_endpoint: "https://auth.cerulean.innotel.us/application/o/userinfo/",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    // The token endpoint: a code the stub does not know.
    return new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  // Order matters: these modules are imported before the SQLite handle is
  // opened. Opening it first and importing afterwards aborts the test process
  // at exit (better-sqlite3's statement finalizers run against an environment
  // that is already gone — `Assertion failed: (env) != nullptr`).
  oidc = await import("../src/oidc.js");
  const { handler } = await import("../src/http.js");
  database = openDb(join(workdir, "control.sqlite"));

  const server = createServer((req, res) => {
    handler(req, res, { gateway: { login: async () => {} } }).catch((error) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  plane = {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
});

after(async () => {
  await plane.close();
  globalThis.fetch = realFetch;
  // Closed explicitly: a better-sqlite3 handle left to the finalizer can run
  // after the isolate is gone and abort the test process at exit.
  database.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("the callback follows the origin the sign-in started on", () => {
  assert.equal(
    oidc.callbackUrlFor({ "x-forwarded-host": "admin.distro.innotel.us", "x-forwarded-proto": "https" }),
    "https://admin.distro.innotel.us/api/auth/oidc/callback",
  );
  assert.equal(
    oidc.callbackUrlFor({ host: "192.168.1.46:20140" }),
    "http://192.168.1.46:20140/api/auth/oidc/callback",
  );
});

test("an origin that was never registered falls back to the canonical callback", () => {
  // A forged Host cannot aim the authorization code at another origin.
  assert.equal(
    oidc.callbackUrlFor({ "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" }),
    CALLBACKS[0],
  );
  assert.equal(oidc.callbackUrlFor({}), CALLBACKS[0]);
});

test("the start route redirects to Authentik with the request's own callback", async () => {
  const response = await fetch(`${plane.url}/api/auth/oidc/start`, {
    redirect: "manual",
    headers: { host: "admin.distro.innotel.us", "x-forwarded-proto": "https" },
  });

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, "https://auth.cerulean.innotel.us");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://admin.distro.innotel.us/api/auth/oidc/callback",
  );
  assert.ok(location.searchParams.get("state"));
  assert.match(response.headers.get("set-cookie") ?? "", /distro_oidc_state=/);
});

test("the callback at that origin clears the state gate", async () => {
  const start = await fetch(`${plane.url}/api/auth/oidc/start`, {
    redirect: "manual",
    headers: { host: "admin.distro.innotel.us", "x-forwarded-proto": "https" },
  });
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];

  // The stubbed token endpoint refuses the code, so this is the exchange — not
  // the state check — that stops the flow. That is the whole point: with the
  // cookie present the flow is past "invalid or expired state".
  const response = await fetch(
    `${plane.url}/api/auth/oidc/callback?code=code-1&state=${state}`,
    { headers: { host: "admin.distro.innotel.us", "x-forwarded-proto": "https", cookie } },
  );

  assert.equal(response.status, 502);
  assert.match(await response.text(), /did not complete the exchange/i);
});

test("a callback without its state cookie is still refused", async () => {
  const response = await fetch(`${plane.url}/api/auth/oidc/callback?code=code-1&state=whatever`, {
    headers: { host: "admin.distro.innotel.us", "x-forwarded-proto": "https" },
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /invalid or expired state/i);
});
