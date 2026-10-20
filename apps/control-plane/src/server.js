// FIRST IMPORT, deliberately: it resolves every `vault://` reference in the
// environment, and ESM evaluates this list in order — so the config modules
// below capture resolved values rather than references.
import { vaultStatus } from './vault.js';
import './secrets.js';
import { createServer } from 'node:http';
import { openDb } from './db.js';
import { GatewayClient } from './gateway.js';
import { handler } from './http.js';
import { syncUsageFromGateway, syncIsStale, unmappedAlert } from './sync.js';
import { checkGatewayVersion } from './gatewayVersion.js';
import { alert } from './alerts.js';
import { seedDistroPlan } from './billing.js';
import { reconcileAccountKeys } from './keySync.js';
import { seedStoragePools } from './storageSeed.js';
import { resolveGatewayUrls, resolveMagnateUrl } from './discovery.js';
import { atlasConfigured } from './export.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 20140);

openDb();

// M4 usage sync reconciles usage_cache with the gateway's own per-key ledger
// (`usage_history`). It reads the gateway's SQLite file from disk, which needs a
// gateway-data volume mounted HERE — and the gateway is a shared platform
// service on another host, so there is none (and, with the `local-gateway`
// profile that used to carry it removed, there is no deployment shape that has
// one). Default the interval to 0 (off) and let chat-traffic usage reports keep
// quota accounting working; set CONTROL_SYNC_INTERVAL_MS explicitly only for a
// deployment that mounts the gateway's data directory itself.
const SYNC_INTERVAL_MS = Number(process.env.CONTROL_SYNC_INTERVAL_MS ?? 0);

/*
 * Keys repair themselves (M-key sync).
 *
 * The one failure this plane cannot report honestly without it: a key the gateway
 * has forgotten keeps looking configured here, so every turn is refused while the
 * dashboard says the account is fine. `keys-check --fix` fixed it for whoever
 * happened to run it. This runs the same pass every `CONTROL_KEY_SYNC_MS`
 * (default 15 min) and once shortly after boot, so an account that cannot spend
 * is an account for at most one interval. Set it to 0 to make the pass manual.
 */
const KEY_SYNC_MS = Number(process.env.CONTROL_KEY_SYNC_MS ?? 15 * 60 * 1000);
let lastKeySyncAt = null;

async function runKeySync() {
  try {
    const report = await reconcileAccountKeys({ gateway });
    lastKeySyncAt = new Date().toISOString();
    if (report.rotated.length > 0) {
      console.log(
        `[control-plane] key sync: rotated ${report.rotated.length} of ${report.checked} key(s) — ` +
          report.rotated.map((entry) => entry.email).join(', '),
      );
    }
    if (report.failed.length > 0) {
      console.warn(
        `[control-plane] key sync: ${report.failed.length} account(s) could not be repaired — ` +
          report.failed.map((entry) => `${entry.email}: ${entry.error}`).join('; '),
      );
    }
  } catch (err) {
    // A gateway that is briefly down is weather, not an outage of this plane: the
    // next pass asks again, and the console's Sync now is the manual override.
    console.warn(`[control-plane] key sync skipped: ${err?.message || err}`);
  }
}

// When the sync goes quiet (M8): a timer that stopped, a process that wedged,
// or a sync that has never once succeeded. `CONTROL_SYNC_STALE_MS` overrides;
// the default is three intervals or five minutes, whichever is longer, so a
// single slow pass is not an outage. The watchdog is only armed when the sync
// is scheduled at all — an interval of 0 is a deployment saying "not this".
const STARTED_AT = Date.now();
const SYNC_STALE_MS =
  Number(process.env.CONTROL_SYNC_STALE_MS || 0) > 0
    ? Number(process.env.CONTROL_SYNC_STALE_MS)
    : Math.max(SYNC_INTERVAL_MS * 3, 5 * 60 * 1000);
let lastSyncSuccessAt = null;

async function runUsageSync() {
  try {
    // M6 pin: the ledger read below assumes the verified release's schema. A
    // mismatch is warned and alerted (inside the check) and the sync still
    // runs — the schema-drift guard turns a real incompatibility into a warning.
    await checkGatewayVersion(gateway);
    const result = await syncUsageFromGateway();
    if (!result.ok) {
      console.warn(`[control-plane] usage sync skipped: ${result.reason}`);
      void alert('sync.failed', {
        title: 'Gateway usage sync unavailable',
        message: result.reason,
      });
      return;
    }
    lastSyncSuccessAt = Date.now();
    if (result.keys > 0) {
      console.log(
        `[control-plane] usage sync: ${result.matched} user(s) matched, ${result.unknownKeys} unmapped key(s), ` +
          `${result.total.requests} req / ${result.total.tokensIn + result.total.tokensOut} tok ` +
          `(~$${result.total.costUsd.toFixed(4)}) today`,
      );
    }
    // A pass that matches nothing still "succeeds"; without this the only
    // symptom of an unmapped key is a dashboard that looks idle.
    if (result.unmapped?.length) {
      console.warn(
        `[control-plane] usage sync: ${result.unmapped.length} unmapped key(s) — ` +
          result.unmapped.map((u) => `${u.apiKeyId} (${u.tokensIn + u.tokensOut} tok)`).join(', '),
      );
      void alert('sync.unmapped-keys', unmappedAlert(result.unmapped));
    }
  } catch (err) {
    console.warn(`[control-plane] usage sync failed: ${err?.message || err}`);
    void alert('sync.failed', {
      title: 'Gateway usage sync failed',
      message: err?.message || String(err),
    });
  }
}

/**
 * Alert when the usage sync has not completed inside its window (M8).
 *
 * Different from `sync.failed`: that fires on a *bad pass*, this fires when
 * passes stopped happening at all and `usage_cache` is quietly frozen — the
 * failure an operator otherwise reads as "nobody used the gateway today".
 */
function checkSyncStale() {
  if (!syncIsStale({ now: Date.now(), lastSuccessAt: lastSyncSuccessAt, startedAt: STARTED_AT, staleMs: SYNC_STALE_MS })) {
    return;
  }
  const since = lastSyncSuccessAt ?? STARTED_AT;
  const minutes = Math.round((Date.now() - since) / 60000);
  void alert('sync.stale', {
    title: 'Gateway usage sync has not completed',
    message:
      lastSyncSuccessAt === null
        ? `No usage sync has succeeded in ${minutes} min of running; the ledger is only as fresh as the last chat report.`
        : `The last successful usage sync was ${minutes} min ago (scheduled every ${Math.round(SYNC_INTERVAL_MS / 1000)}s).`,
    meta: {
      lastSuccessAt: lastSyncSuccessAt === null ? null : new Date(lastSyncSuccessAt).toISOString(),
      intervalMs: SYNC_INTERVAL_MS,
      staleMs: SYNC_STALE_MS,
    },
  });
}

const gateway = new GatewayClient({
  adminPassword: process.env.GATEWAY_ADMIN_PASSWORD,
});

const server = createServer((req, res) => {
  handler(req, res, { gateway }).catch((err) => {
    // Last-resort error envelope (no stack traces over HTTP).
    //
    // A handler that already wrote a response and then threw (e.g. a failure
    // after a 4xx was sent) must not reach writeHead again: that throws
    // ERR_HTTP_HEADERS_SENT from *inside* the catch-all and takes the process
    // down, turning a handled error into an outage.
    if (res.headersSent) {
      console.error('[control-plane] handler failed after response was sent:', err?.message || err);
      res.end();
      return;
    }
    const payload = JSON.stringify({ error: `internal error: ${err?.message || 'unknown'}` });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });
});

server.listen(PORT, HOST, async () => {
  const urls = await resolveGatewayUrls();
  console.log(`[control-plane] listening on http://${HOST}:${PORT}`);
  // references in .env were already resolved by the first import (./secrets.js);
  // this reports whether the store is reachable and its credential usable.
  console.log(`[control-plane] secret store: Cerulean Vault ${await vaultStatus()}`);
  console.log(`[control-plane] gateway dashboard: ${urls.dashboardUrl} (via ${urls.source})`);
  try {
    await seedStoragePools();
  } catch (err) {
    console.warn(`[storage] could not prepare the onyx pool: ${err?.message || err}`);
  }

  const version = await checkGatewayVersion(gateway);
  console.log(
    `[control-plane] gateway version: ${version.running || 'unknown'}` +
      (version.buildSha ? ` (${version.buildSha.slice(0, 7)})` : '') +
      ` — pin ${version.expected || 'none'} → ` +
      (version.compatible === true ? 'compatible' : version.compatible === false ? 'MISMATCH' : 'unchecked'),
  );

  // Magnate billing: resolve via env override or Consul, then seed the distro
  // plan. When neither resolves, billing stays disabled (free/self-hosted mode).
  const magnate = await resolveMagnateUrl();
  if (magnate) {
    console.log(`[billing] Magnate at ${magnate.url} (via ${magnate.source})`);
    await seedDistroPlan();
  } else {
    console.log('[billing] Magnate not configured/discoverable — billing disabled');
  }

  // Atlas integration is optional (git export). No boot-time action required —
  // the control plane only exposes /api/export/config + /api/export/validate.
  if (atlasConfigured()) {
    console.log(`[atlas] Atlas configured at ${process.env.ATLAS_URL} (git remote: ${process.env.ATLAS_GIT_REMOTE})`);
  }

  if (KEY_SYNC_MS > 0) {
    // Delayed rather than immediate: boot is when the gateway is least likely to
    // be waiting for us, and a rotation during startup would race the console's
    // first render.
    setTimeout(runKeySync, 20_000).unref();
    setInterval(runKeySync, KEY_SYNC_MS).unref();
    console.log(`[control-plane] key sync every ${Math.round(KEY_SYNC_MS / 1000)}s`);
  }
  console.log(`[control-plane] last key sync: ${lastKeySyncAt || 'not yet'}`);

  if (SYNC_INTERVAL_MS > 0) {
    runUsageSync(); // immediate first pass
    setInterval(runUsageSync, SYNC_INTERVAL_MS).unref();
    // The watchdog rides the same schedule: a sync that never runs again is the
    // failure no single pass reports.
    setInterval(checkSyncStale, SYNC_INTERVAL_MS).unref();
    console.log(`[control-plane] usage sync every ${SYNC_INTERVAL_MS} ms (stale after ${SYNC_STALE_MS} ms)`);
  }
});
