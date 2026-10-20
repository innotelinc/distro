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
} from "../src/db.js";
import { reconcileAccountKeys } from "../src/keySync.js";

/**
 * The automatic key pass.
 *
 * The rule it encodes is narrow: an account that cannot spend should end the pass
 * able to spend, and an account that already can must not be touched. What these
 * cases pin is the boundary — a throttled gateway is not a broken key, a dry run
 * mints nothing, one failed mint does not stop the rest, and the audit says who was
 * rotated and why.
 */

const dir = mkdtempSync(join(tmpdir(), "distro-key-sync-"));
openDb(join(dir, "control.sqlite"));

let seq = 0;
function account(email, key) {
  const user = createUser({ email, passwordHash: "x".repeat(20), role: "user" });
  assert.ok(user, `could not create ${email}`);
  if (key) setGatewayKey(user.id, { gatewayKeyId: `key-${++seq}`, gatewayKey: key });
  return user;
}

/** A gateway that answers /v1/models per key, and mints keys on demand. */
function fakeGateway(statusByKey = {}) {
  const minted = [];
  return {
    minted,
    fetch: async (url, init) => {
      const key = String(init.headers.Authorization || "").replace("Bearer ", "");
      return { status: statusByKey[key] ?? 200 };
    },
    client: {
      async login() {},
      async createApiKey(name) {
        const id = `minted-${++seq}`;
        const key = `sk-minted-${id}-0000000000000000`;
        minted.push({ name, id });
        return { id, key, name };
      },
    },
  };
}

test("automatic key sync", async (t) => {
  const works = account("works@example.com", "sk-works-000000000000000000000000");
  const orphan = account("orphan@example.com", "sk-orphan-11111111111111111111111");
  const keyless = account("keyless@example.com", "");
  const throttled = account("throttled@example.com", "sk-throttled-2222222222222222");

  await t.test("a rejected key is rotated and a missing one is minted", async () => {
    const gateway = fakeGateway({
      "sk-orphan-11111111111111111111111": 401,
      "sk-throttled-2222222222222222": 429,
    });
    const report = await reconcileAccountKeys({
      gateway: gateway.client,
      fetchImpl: gateway.fetch,
      base: "http://gateway.test",
    });

    assert.deepEqual(report.rotated.map((entry) => entry.email).sort(), [
      "keyless@example.com",
      "orphan@example.com",
    ]);
    // The throttled account is the gateway's weather, not a credential: untouched.
    assert.equal(report.rotated.some((entry) => entry.email === "throttled@example.com"), false);
    // One account is healthy; the throttled one is `unchecked`, not `ok`.
    assert.equal(report.ok, 1);

    // Both accounts now hold a key the gateway minted, and it is stored.
    for (const email of ["keyless@example.com", "orphan@example.com"]) {
      const user = [works, orphan, keyless, throttled].find((u) => u.email === email);
      const stored = getGatewayKey(user.id);
      assert.ok(stored, `${email} still has no key`);
      assert.match(stored.gateway_key, /^sk-minted-/);
    }
    // The working account was not re-minted.
    assert.equal(gateway.minted.length, 2);

    const audit = listAudit(50).filter((entry) => entry.action === "key.autosync");
    assert.equal(audit.length, 1);
    assert.ok(audit[0].meta.rotated.includes("keyless@example.com"));
  });

  await t.test("a dry run reports without minting", async () => {
    const gateway = fakeGateway({});
    const report = await reconcileAccountKeys({
      gateway: gateway.client,
      fetchImpl: gateway.fetch,
      base: "http://gateway.test",
      dryRun: true,
    });
    assert.equal(report.rotated.length, 0);
    assert.equal(gateway.minted.length, 0);
    // Nothing is broken any more after the pass above, so the report is clean —
    // which is what makes a dry run afterwards a useful confirmation.
    assert.deepEqual(report.failed, []);
    assert.equal(report.rejected.length, 0);
    assert.equal(report.missing.length, 0);
  });

  await t.test("a failed mint is reported and does not stop the others", async () => {
    const broken = account("broken@example.com", "");
    const alsoBroken = account("also@example.com", "");
    let calls = 0;
    const gateway = {
      fetch: async () => ({ status: 200 }),
      client: {
        async login() {},
        async createApiKey() {
          calls += 1;
          if (calls === 1) throw new Error("gateway said no");
          return { id: `late-${calls}`, key: `sk-late-${calls}-000000000000000000` };
        },
      },
    };
    const report = await reconcileAccountKeys({
      gateway: gateway.client,
      fetchImpl: gateway.fetch,
      base: "http://gateway.test",
    });
    // Which of the two is first depends on the row order; exactly one of them
    // fails and exactly one is repaired.
    assert.equal(report.rotated.length, 1);
    assert.equal(report.failed.length, 1);
    const repaired = report.rotated[0].email;
    const stillBroken = [broken, alsoBroken].find((u) => u.email !== repaired);
    // The one the mint failed for is still keyless: the pass repaired what it
    // could and said which account needs a person.
    assert.equal(getGatewayKey(stillBroken.id), undefined);
    assert.match(report.failed[0].error, /gateway said no/);
  });
});
