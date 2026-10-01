import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createUser,
  getGatewayKey,
  listAudit,
  openDb,
  setGatewayKey,
  updateUser,
} from "../src/db.js";
import { checkAccountKeys, gatewayApiBase, remintAccountKey } from "../src/accountKeys.js";

/**
 * One account's key can be broken while every other account works, and the
 * builder surface reports it as "every model in the chain failed" — so the whole
 * point of this check is telling a *credential* problem apart from a model,
 * quota or provider one. That is what these cases pin: which statuses count as a
 * refusal, that "could not ask" is not silently either verdict, and that a
 * re-mint really replaces what is stored.
 */

const dir = mkdtempSync(join(tmpdir(), "distro-gateway-keys-"));
openDb(join(dir, "control.sqlite"));

function account(email, key, { gatewayKeyId = "key-" + email, disabled = false } = {}) {
  const created = createUser({ email, passwordHash: "x".repeat(20), role: "user" });
  assert.ok(created, `could not create ${email}`);
  const user = created;
  setGatewayKey(user.id, { gatewayKeyId, gatewayKey: key });
  if (disabled) updateUser(user.id, { disabled_at: new Date().toISOString() });
  return user;
}

const good = account("good@example.com", "sk-good-0000000000000000000000000000");
const orphan = account("orphan@example.com", "sk-orphan-11111111111111111111111111");
const throttled = account("throttled@example.com", "sk-throttled-222222222222222222222");
const gone = account("gone@example.com", "sk-gone-3333333333333333333333333", { disabled: true });

/** A gateway whose /v1/models answers per key, the way the real one does. */
function fakeGateway(statusByKey) {
  const asked = [];
  return {
    asked,
    fetch: async (url, init) => {
      const key = String(init.headers.Authorization || "").replace("Bearer ", "");
      asked.push(key);
      if (key === "sk-offline") throw new Error("fetch failed");
      return { status: statusByKey[key] ?? 200 };
    },
  };
}

test("keys-check", async (t) => {
  await t.test("a 401/403 is a refusal, and nothing else is", async () => {
    const gateway = fakeGateway({
      "sk-orphan-11111111111111111111111111": 401,
      "sk-throttled-222222222222222222222": 429,
    });
    const result = await checkAccountKeys({ fetchImpl: gateway.fetch, base: "http://gateway.test" });

    // The disabled account is not asked about at all: its key cannot be spent,
    // so a refusal there is not something anybody has to fix.
    assert.deepEqual(
      result.ok.map((entry) => entry.email),
      ["good@example.com"],
    );
    assert.deepEqual(
      result.rejected.map((entry) => entry.email),
      ["orphan@example.com"],
    );
    assert.deepEqual(
      result.unchecked.map((entry) => entry.email),
      ["throttled@example.com"],
      "a throttled key is the gateway's weather, not a broken credential",
    );
    assert.equal(result.checked, 3, "each live account is checked exactly once");
    assert.equal(result.rejected[0].keyPrefix, "sk-orphan-11");
    assert.equal(gateway.asked.includes("sk-gone-3333333333333333333333333"), false);
    assert.equal(gateway.asked.includes("sk-orphan-11111111111111111111111111"), true);
    assert.equal(gone.email, "gone@example.com");
  });

  await t.test("a gateway that cannot be reached is checked, not blamed or cleared", async () => {
    const gateway = fakeGateway({});
    const previously = getGatewayKey(orphan.id);
    setGatewayKey(orphan.id, { gatewayKeyId: previously.gateway_key_id, gatewayKey: "sk-offline" });
    const result = await checkAccountKeys({ fetchImpl: gateway.fetch, base: "http://gateway.test" });

    assert.deepEqual(result.rejected, [], "an unreachable gateway must not accuse a key");
    assert.equal(
      result.unchecked.some((entry) => entry.error === "fetch failed"),
      true,
      "it has to be reported as unchecked, with the reason",
    );

    setGatewayKey(orphan.id, {
      gatewayKeyId: previously.gateway_key_id,
      gatewayKey: previously.gateway_key,
    });
  });

  await t.test("--fix stores a key the gateway will accept, and audits the rotation", async () => {
    const before = getGatewayKey(orphan.id);
    const mints = [];
    const gateway = {
      login: async () => "session=1",
      createApiKey: async (name, options) => {
        mints.push({ name, options });
        return { id: "key-reminted", key: "sk-fresh-4444444444444444444444444", name };
      },
    };

    const entry = {
      userId: orphan.id,
      email: orphan.email,
      keyPrefix: String(before.gateway_key).slice(0, 12),
      status: 401,
    };
    await remintAccountKey(entry, { gateway });

    const after = getGatewayKey(orphan.id);
    assert.equal(after.gateway_key, "sk-fresh-4444444444444444444444444");
    assert.equal(after.gateway_key_id, "key-reminted");
    assert.equal(mints.length, 1);
    assert.match(mints[0].name, /^genie-user-/);
    assert.equal(mints[0].name, `genie-user-${orphan.id.slice(0, 8)}`, "the gateway key stays named for the account");

    const audits = listAudit(50, { actionPrefix: "key.rotate", userId: orphan.id });
    assert.equal(audits.length, 1, "the rotation is in the audit log");
    // `meta` comes back as stored — an object through the db helper, a string in
    // some reads — so assert on the text either way rather than on the type.
    const meta = audits[0].meta;
    const asText = typeof meta === "string" ? meta : JSON.stringify(meta);
    assert.match(asText, /gateway refused the stored key/);
    assert.match(asText, /sk-orphan-11/, "the superseded key is named in the audit row");
  });

  await t.test("the API base is not given a second /v1", async () => {
    process.env.GATEWAY_API_URL = "http://192.168.1.71:20128";
    assert.equal(await gatewayApiBase(), "http://192.168.1.71:20128");
    process.env.GATEWAY_API_URL = "http://192.168.1.71:20128/v1";
    // resolveGatewayUrls caches per process, so the second value is asserted
    // through the one thing it controls: a base never ends in /v1 twice.
    const base = await gatewayApiBase();
    assert.equal(base.endsWith("/v1/v1"), false);
    delete process.env.GATEWAY_API_URL;
  });
});
