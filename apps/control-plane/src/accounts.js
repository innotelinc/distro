// Removing an account is two pieces of state, not one: the row here and the
// gateway key it can still spend. A row deleted alone leaves a credential that
// outlives the account on the gateway's host — an orphan, which is exactly the
// shape of the failure that made one account's key stop working while the
// builder surface blamed every model in the chain. So a delete revokes first
// and removes second: if the gateway cannot be reached the account stays, which
// is the half to fail on. Nothing can spend a key whose account is gone, and a
// key nobody can revoke is one the estate cannot account for.
//
// The key is revoked but never read back out of the gateway; the audit row
// records the gateway key id, not the secret.

import { deleteUser, getGatewayKey, logAudit } from './db.js';

/**
 * Revoke an account's gateway key, if it has one.
 *
 * @returns {Promise<object|null>} the revoked row, or null when there was no key.
 *                                Throws when the gateway refuses or is unreachable,
 *                                so the caller can decide to stop.
 */
export async function revokeAccountKey(user, { gateway }) {
  const key = getGatewayKey(user.id);
  if (!key) return null;
  await gateway.login();
  await gateway.revokeApiKey(key.gateway_key_id);
  return key;
}

/**
 * Delete an account and the credential it can still spend.
 *
 * The revoke happens before the delete on purpose: a failure from the gateway
 * propagates and the account is left intact, so a retry is meaningful. The
 * caller maps that error — the HTTP path answers 502, the CLI prints it.
 *
 * @param {{ id: string, email: string }} user
 * @param {{ gateway: object, actor?: { id?: string, email?: string }|null, meta?: object }} options
 */
export async function deleteAccount(user, { gateway, actor = null, meta = {} }) {
  const key = await revokeAccountKey(user, { gateway });
  logAudit({
    action: 'user.delete',
    actorId: actor?.id ?? null,
    actorEmail: actor?.email ?? null,
    targetId: user.id,
    targetEmail: user.email,
    meta: { gatewayKeyId: key?.gateway_key_id ?? null, ...meta },
  });
  deleteUser(user.id);
  return { deleted: true, id: user.id, email: user.email, gatewayKeyId: key?.gateway_key_id ?? null };
}
