// Keep every account's gateway key one the gateway accepts — without a person.
//
// `bin/control.mjs keys-check --fix` does this from a shell, and until now that was
// the only way: an account whose key the gateway has forgotten (a restored volume,
// a migration, a rebuilt gateway) keeps looking configured here while every turn
// it makes is refused with `401 Invalid API key`. The builder surface reports that
// as "every model in the chain failed", which reads like a provider outage and is
// never diagnosed as one account's credential.
//
// So the pass runs on its own — at boot, on a timer (`CONTROL_KEY_SYNC_MS`), and
// from the console's **Sync now**. It is the same three verdicts `keys-check`
// reports, and the same re-mint `--fix` performs; what changes is who has to
// remember. A row with no key is minted one, and a key the gateway rejects — or
// that several accounts share, so nothing it spends can be attributed — is rotated.
//
// What it will not do is guess. An unmapped key in the gateway's usage ledger (a
// key no account stores) is reported, not adopted: the plaintext of an existing key
// is not readable after it is minted, so "mapping" it would record an id the account
// cannot authenticate with. The account that needs one gets a *new* key instead,
// which is the only shape that works.

import { logAudit } from './db.js';
import { brokenAccountKeys, checkAccountKeys, remintAccountKey } from './accountKeys.js';

/** The verdicts that mean somebody has to act; kept next to the report for the UI. */
export const BROKEN_VERDICTS = ['rejected', 'missing', 'shared'];

/**
 * Check every live account's key and repair what cannot spend.
 *
 * `dryRun` is what the console's "check" asks for: the verdicts without a
 * rotation, so an operator can see what an automatic pass would do before it
 * touches anything.
 *
 * Never throws for one bad row: a gateway that refuses one mint must not stop the
 * other accounts being repaired, and the failure is reported per account so the
 * console can name the one that needs a person.
 *
 * @param {{ gateway: { login: Function, createApiKey: Function }, fetchImpl?: typeof fetch,
 *           base?: string, dryRun?: boolean, actorEmail?: string, via?: string }} options
 */
export async function reconcileAccountKeys({
  gateway,
  fetchImpl = fetch,
  base,
  dryRun = false,
  actorEmail = 'control-plane',
  via = 'automatic key sync',
} = {}) {
  const check = await checkAccountKeys({ fetchImpl, base });
  const broken = brokenAccountKeys(check);
  const report = {
    base: check.base,
    checked: check.checked,
    ok: check.ok.length,
    rejected: check.rejected,
    missing: check.missing,
    shared: check.shared,
    unchecked: check.unchecked,
    rotated: [],
    failed: [],
    dryRun,
  };
  if (dryRun) {
    report.rotated = broken.map((entry) => ({
      userId: entry.userId,
      email: entry.email,
      label: entry.label,
      reason: reasonFor(entry),
    }));
    return report;
  }

  for (const entry of broken) {
    try {
      await remintAccountKey(entry, { gateway, via });
      report.rotated.push({
        userId: entry.userId,
        email: entry.email,
        label: entry.label,
        reason: reasonFor(entry),
      });
    } catch (error) {
      report.failed.push({
        userId: entry.userId,
        email: entry.email,
        error: error && error.message ? error.message : String(error),
      });
    }
  }

  // One audit row for the pass that changed something, rather than one per key:
  // the per-key rows are written by `remintAccountKey`, and a pass that rotates
  // nine keys should read as one event in the console's activity list.
  if (report.rotated.length > 0) {
    logAudit({
      action: 'key.autosync',
      actorEmail,
      meta: {
        via,
        rotated: report.rotated.map((entry) => entry.email),
        failed: report.failed.map((entry) => entry.email),
        checked: report.checked,
      },
    });
  }

  return report;
}

/** Why one account's key is being replaced, in the words the console shows. */
export function reasonFor(entry) {
  if (entry.reason) return entry.reason;
  return `the gateway answered ${entry.status} for this key`;
}
