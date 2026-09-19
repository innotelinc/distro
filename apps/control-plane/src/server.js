// FIRST IMPORT, deliberately: it resolves every `vault://` reference in the
// environment, and ESM evaluates this list in order — so the config modules
// below capture resolved values rather than references.
import { vaultStatus } from './vault.js';
import './secrets.js';
import { createServer } from 'node:http';
import { openDb } from './db.js';
import { GatewayClient } from './gateway.js';
import { handler } from './http.js';
import { syncUsageFromGateway } from './sync.js';
import { checkGatewayVersion } from './gatewayVersion.js';
import { alert } from './alerts.js';
import { seedDistroPlan } from './billing.js';
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
    if (result.keys > 0) {
      console.log(
        `[control-plane] usage sync: ${result.matched} user(s) matched, ${result.unknownKeys} unmapped key(s), ` +
          `${result.total.requests} req / ${result.total.tokensIn + result.total.tokensOut} tok ` +
          `(~$${result.total.costUsd.toFixed(4)}) today`,
      );
    }
  } catch (err) {
    console.warn(`[control-plane] usage sync failed: ${err?.message || err}`);
    void alert('sync.failed', {
      title: 'Gateway usage sync failed',
      message: err?.message || String(err),
    });
  }
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

  if (SYNC_INTERVAL_MS > 0) {
    runUsageSync(); // immediate first pass
    setInterval(runUsageSync, SYNC_INTERVAL_MS).unref();
    console.log(`[control-plane] usage sync every ${SYNC_INTERVAL_MS} ms`);
  }
});
