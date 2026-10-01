import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createUser,
  getGatewayKey,
  getUserById,
  listAudit,
  openDb,
  setGatewayKey,
} from "../src/db.js";
import { deleteAccount, revokeAccountKey } from "../src/accounts.js";

/**
 * An account is two pieces of state: the row here and the gateway key it can
 * spend. Deleting the row alone would leave the key live on the gateway — an
 * orphan, which is how one account's credential kept working after its account
 * was "removed", and how a key nobody can attribute stays spendable. These cases
 * pin the order: revoke first, delete second, and *nothing* when the gateway
 * will not take the key back.
 */

const dir = mkdtempSync(join(tmpdir(), "distro-delete-account-"));
openDb(join(dir, "control.sqlite"));

function account(email, key = "sk-" + email) {
  const user = createUser({ email, passwordHash: "x".repeat(20), role: "user" });
  assert.ok(user, `could not create ${email}`);
  setGatewayKey(user.id, { gatewayKeyId: "gk-" + email, gatewayKey: key });
  return user;
}

function fakeGateway({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async login() {
      calls.push("login");
    },
    async revokeApiKey(id) {
      calls.push(`revoke:${id}`);
      if (fail) throw new Error("gateway login failed (401)");
    },
  };
}

test("deleteAccount", async (t) => {
  await t.test("revokes the key, audits the delete, and removes the row", async () => {
    const user = account("gone@example.com");
    const gateway = fakeGateway();

    const result = await deleteAccount(user, { gateway });

    assert.deepEqual(gateway.calls, ["login", "revoke:gk-gone@example.com"]);
    assert.equal(result.deleted, true);
    assert.equal(result.gatewayKeyId, "gk-gone@example.com");

    // The row and everything hanging off it are gone in one step (the schema
    // cascades from users), so a later keys-check cannot resurrect the account.
    assert.equal(getUserById(user.id), undefined);
    assert.equal(getGatewayKey(user.id), undefined);

    const [latest] = listAudit(5, { actionPrefix: "user.delete" });
    assert.equal(latest.target_email, "gone@example.com");
    assert.equal(latest.meta.gatewayKeyId, "gk-gone@example.com");
  });

  await t.test("leaves the account intact when the gateway refuses the revoke", async () => {
    const user = account("kept@example.com");
    const gateway = fakeGateway({ fail: true });

    await assert.rejects(() => deleteAccount(user, { gateway }), /gateway login failed/);

    // The safe half to fail on: better a live account than an unattributable
    // key. Nothing is audited either, because nothing happened.
    assert.ok(getUserById(user.id), "the account must survive a failed revoke");
    assert.ok(getGatewayKey(user.id), "and keep its key");
    assert.equal(
      listAudit(5, { actionPrefix: "user.delete" }).length,
      1,
      "a failed delete must not be recorded as one",
    );
  });

  await t.test("an account with no key is still deletable", async () => {
    const user = createUser({ email: "keyless@example.com", passwordHash: "x".repeat(20), role: "user" });
    const gateway = fakeGateway();

    await deleteAccount(user, { gateway });

    assert.deepEqual(gateway.calls, [], "no key means no gateway call at all");
    assert.equal(getUserById(user.id), undefined);
  });

  await t.test("revokeAccountKey says null when there is nothing to revoke", async () => {
    const user = createUser({ email: "nokey@example.com", passwordHash: "x".repeat(20), role: "user" });
    assert.equal(await revokeAccountKey(user, { gateway: fakeGateway() }), null);
  });
});
