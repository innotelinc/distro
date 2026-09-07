// Service discovery for the remote platform services Distro consumes.
//
// Gateway: resolve the remote OmniRoute gateway's dashboard/API base URLs
// without hardcoding them.
//
// Resolution order (first hit wins):
//   1. Explicit env overrides — GATEWAY_DASHBOARD_URL / GATEWAY_API_URL
//   2. Consul service discovery — CONTROL_CONSUL_URL (default the stack's
//      Consul on server 1), looking up the `omniroute` service registered
//      there (`./stack.sh discover omniroute` in the platform stack resolves
//      the same way). Only the first healthy instance is used.
//   3. Fallback — the legacy local compose address (gateway:20128/20129),
//      which keeps `--profile local-gateway` deployments working unchanged.
//
// Discovery is cached per process; call resetDiscoveryCache() in tests.

const CONSUL_URL = (process.env.CONTROL_CONSUL_URL || 'http://10.10.1.1:8500').replace(/\/+$/, '');
const CONSUL_SERVICE = process.env.GATEWAY_CONSUL_SERVICE || 'omniroute';
const MAGNATE_CONSUL_SERVICE = process.env.MAGNATE_CONSUL_SERVICE || 'magnate';
const DISCOVERY_TIMEOUT_MS = Number(process.env.GATEWAY_DISCOVERY_TIMEOUT_MS || 3000);

let cache = null; // { dashboardUrl, apiUrl, source }
let magnate = undefined; // undefined = unresolved; null = not found; { url, source }

export function resetDiscoveryCache() {
  cache = null;
  magnate = undefined;
}

async function consulLookup(service) {
  const res = await fetch(`${CONSUL_URL}/v1/health/service/${encodeURIComponent(service)}?passing=true`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`consul returned HTTP ${res.status}`);
  const entries = await res.json();
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`no healthy '${service}' instances in consul`);
  }
  const { Service, Node } = entries[0];
  const host = Service.Address || Node.Address;
  const port = Service.Port;
  if (!host || !port) throw new Error(`consul entry for '${service}' missing address/port`);
  return `http://${host}:${port}`;
}

/**
 * Resolve { dashboardUrl, apiUrl, source } for the gateway.
 * Never throws — falls back to the local compose addresses so the control
 * plane still boots (and logs why discovery fell back).
 */
export async function resolveGatewayUrls() {
  if (cache) return cache;

  const dashboardEnv = process.env.GATEWAY_DASHBOARD_URL;
  const apiEnv = process.env.GATEWAY_API_URL;
  if (dashboardEnv || apiEnv) {
    let dashboardUrl = (dashboardEnv || '').replace(/\/+$/, '');
    let apiUrl = (apiEnv || '').replace(/\/+$/, '');
    if (!dashboardUrl && apiUrl) {
      // Only the API url is pinned: strip the /v1 suffix, swap the known API
      // port (20129) for the dashboard port (20128).
      dashboardUrl = apiUrl
        .replace(/\/v1\/?$/, '')
        .replace(/:20129(\/|$)/, ':20128$1');
    }
    if (!apiUrl && dashboardUrl) {
      apiUrl = dashboardUrl.replace(/:20128(\/|$)/, ':20129$1');
    }
    cache = {
      dashboardUrl: dashboardUrl || 'http://gateway:20128',
      apiUrl: apiUrl || 'http://gateway:20129',
      source: 'env',
    };
    return cache;
  }

  try {
    // Consul registers omniroute with its dashboard port (20128). Derive the
    // OpenAI-compatible API port (20129 = dashboard + 1) from whichever port
    // came back; anything else is treated as the dashboard port.
    const base = (await consulLookup(CONSUL_SERVICE)).replace(/\/+$/, '');
    const portMatch = base.match(/:(\d+)$/);
    const port = portMatch ? Number(portMatch[1]) : 20128;
    const host = base.replace(/:\d+$/, '');
    const dashboardUrl = port === 20129 ? `http://${host}:20128` : base;
    const apiUrl = port === 20129 ? base : `http://${host}:20129`;
    cache = { dashboardUrl, apiUrl, source: `consul:${CONSUL_SERVICE}` };
  } catch (err) {
    console.warn(
      `[discovery] consul lookup for '${CONSUL_SERVICE}' at ${CONSUL_URL} failed (${err?.message || err}); ` +
        `falling back to local compose gateway`,
    );
    cache = {
      dashboardUrl: 'http://gateway:20128',
      apiUrl: 'http://gateway:20129',
      source: 'fallback-local',
    };
  }
  return cache;
}

/**
 * Synchronously read the currently-known Magnate base URL, if any.
 * Prefers the MAGNATE_URL env override; otherwise returns the Consul result
 * once resolveMagnateUrl() has run (null until then / when not discoverable).
 */
export function magnateUrlSync() {
  if (magnate) return magnate.url;
  return (process.env.MAGNATE_URL || '').replace(/\/+$/, '') || null;
}

/**
 * Resolve Magnate's base URL (billing service on the platform stack).
 *   1. MAGNATE_URL env override
 *   2. Consul — service `magnate` (MAGNATE_CONSUL_SERVICE) on CONTROL_CONSUL_URL
 *   3. null — billing stays disabled (graceful, billing is optional)
 * Cached per process. Never throws.
 */
export async function resolveMagnateUrl() {
  if (magnate !== undefined) return magnate;

  const envUrl = (process.env.MAGNATE_URL || '').replace(/\/+$/, '');
  if (envUrl) {
    magnate = { url: envUrl, source: 'env' };
    return magnate;
  }

  try {
    const url = await consulLookup(MAGNATE_CONSUL_SERVICE);
    magnate = { url, source: `consul:${MAGNATE_CONSUL_SERVICE}` };
  } catch (err) {
    console.warn(
      `[discovery] consul lookup for '${MAGNATE_CONSUL_SERVICE}' at ${CONSUL_URL} failed (${err?.message || err}); ` +
        `billing disabled (set MAGNATE_URL to enable)`,
    );
    magnate = null;
  }
  return magnate;
}
