import { createServer } from 'node:http';
import { openDb } from './db.js';
import { GatewayClient } from './gateway.js';
import { handler } from './http.js';

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 20140);

openDb();

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
});
