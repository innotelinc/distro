import { createServer } from 'node:http';
import { openDb } from './db.js';
import { GatewayClient } from './gateway.js';
import { handler } from './http.js';
import { syncUsageFromGateway } from './sync.js';
import { alert } from './alerts.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 20140);

openDb();

// M4: periodically reconcile usage_cache with the gateway's own per-key
// aggregates (gateway-data volume mounted read-only). 0 disables.
const SYNC_INTERVAL_MS = Number(process.env.CONTROL_SYNC_INTERVAL_MS || 0);

async function runUsageSync() {
  try {
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
  dashboardUrl: process.env.GATEWAY_DASHBOARD_URL,
  adminPassword: process.env.GATEWAY_ADMIN_PASSWORD,
});

const server = createServer((req, res) => {
  handler(req, res, { gateway }).catch((err) => {
    // Last-resort error envelope (no stack traces over HTTP).
    const payload = JSON.stringify({ error: `internal error: ${err?.message || 'unknown'}` });
    res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[control-plane] listening on http://${HOST}:${PORT}`);
  console.log(`[control-plane] gateway dashboard: ${gateway.dashboardUrl}`);

  if (SYNC_INTERVAL_MS > 0) {
    runUsageSync(); // immediate first pass
    setInterval(runUsageSync, SYNC_INTERVAL_MS).unref();
    console.log(`[control-plane] usage sync every ${SYNC_INTERVAL_MS} ms`);
  }
});
