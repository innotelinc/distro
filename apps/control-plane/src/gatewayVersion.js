// M6 — the gateway-version pin.
//
// Everything this plane knows about the gateway's API (docs/gateway-api-
// inventory.md) was verified against one OmniRoute release, and the usage
// sync reads that release's SQLite schema directly. The pin records which
// release that was; the check compares it with what is actually running.
//
// Posture is warn-only: a mismatch logs, fires one webhook alert per cooldown,
// and shows as "incompatible" in the admin console — but nothing stops. The
// schema-drift guard in gatewayUsage.js already keeps a changed ledger from
// crashing the sync, and chat usage reports + key spend caps carry accounting
// regardless. Re-verify the inventory, then move the pin.
//
// The pin is opt-in. The gateway ships its own builds and moves them forward
// without asking this plane, so an unset GATEWAY_EXPECTED_VERSION means "no
// pin": the probe still records which release is running, and nothing is
// called incompatible for having moved.
//
//   GATEWAY_EXPECTED_VERSION   release to pin, when a deployment wants one; unset = no pin

import { alert } from './alerts.js';
import { normalizeVersion } from './gateway.js';

export const DEFAULT_EXPECTED_VERSION = null;

let warnedUnparseable = false;

/** The pin, or null when none is set (unset/empty) or the value is not `x.y.z`. */
export function expectedGatewayVersion() {
  const raw = process.env.GATEWAY_EXPECTED_VERSION;
  if (raw === undefined) return DEFAULT_EXPECTED_VERSION; // no pin unless asked for
  const trimmed = raw.trim();
  if (!trimmed) return null; // explicitly disabled
  const parsed = normalizeVersion(trimmed);
  if (!parsed && !warnedUnparseable) {
    // `latest` is a tag, not a version: it would compare as a permanent
    // mismatch. Treat it as "no pin" rather than raise a false alarm.
    warnedUnparseable = true;
    console.warn(`[gateway] GATEWAY_EXPECTED_VERSION=${JSON.stringify(trimmed)} is not an x.y.z version — version check disabled`);
  }
  return parsed;
}

/**
 * Exact-match compatibility. `null` when either side is unknown — the pin is
 * a statement about what was verified, and an unverifiable gateway is neither
 * compatible nor incompatible, it is unchecked.
 */
export function compatible(expected, running) {
  if (!expected || !running) return null;
  return normalizeVersion(expected) === normalizeVersion(running);
}

let last = null;

/** The most recent check's result, for the stats endpoint and the console. */
export function lastGatewayVersionCheck() {
  return last || { expected: expectedGatewayVersion(), running: null, buildSha: null, compatible: null, checkedAt: null, error: null };
}

/**
 * Probe the gateway, record what it is running, and compare against the pin.
 *
 * With no pin this is a report, not a check: the running release and build are
 * recorded and nothing is called a mismatch, because the gateway updates on its
 * own. When a deployment does pin a release, a difference is logged and alerted
 * (`gateway.version-mismatch`, subject to the alert cooldown) — the caller keeps
 * running. Never throws: an unreachable gateway is recorded as `error` with
 * `compatible: null`.
 */
export async function checkGatewayVersion(gateway, { log = console } = {}) {
  const expected = expectedGatewayVersion();
  const result = { expected, running: null, buildSha: null, endpoint: null, compatible: null, checkedAt: new Date().toISOString(), error: null };

  try {
    const probe = await gateway.version();
    result.running = probe.version;
    result.buildSha = probe.buildSha;
    result.endpoint = probe.endpoint;
    result.compatible = compatible(expected, probe.version);
  } catch (err) {
    result.error = err?.message || String(err);
  }

  if (result.compatible === false) {
    const message = `gateway reports ${result.running}, control plane verified against ${expected} — re-verify docs/gateway-api-inventory.md and the usage_history schema, then update GATEWAY_EXPECTED_VERSION`;
    log.warn(`[gateway] version mismatch: ${message}`);
    void alert('gateway.version-mismatch', {
      title: 'Gateway version differs from the pin',
      message,
      meta: { expected, running: result.running, buildSha: result.buildSha },
    });
  } else if (result.error) {
    log.warn(`[gateway] version check inconclusive: ${result.error}`);
  } else if (result.running == null) {
    log.warn(`[gateway] version check inconclusive: ${result.endpoint} answered without a version (pin ${expected || 'none'})`);
  }

  last = result;
  return result;
}

/** Test hook. */
export function resetGatewayVersionCheck() {
  last = null;
}
