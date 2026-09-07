/**
 * Atlas integration — git export helper.
 *
 * Distro is where you build; Atlas (CodeOps in the Innotel Platform Stack) is
 * where you ship.  When ATLAS_URL + ATLAS_GIT_REMOTE are both set, Distro can
 * push the current WebContainer project to an Atlas/Gitea remote.
 *
 * Atlas itself is wired into the same stack services Distro consumes:
 *   - OmniRoute  → Chef's codegen model plane (shared gateway)
 *   - Magnate    → paid developer-seat billing / entitlements
 *   - Cerulean   → Authentik SSO + DNS + TLS for git/chef/convex hosts
 *   - Infisical  → secrets (Atlas .env is derived from it)
 *
 * This module only provides the server-side configuration + remote validation
 * for the Export-to-Git flow. The actual push is done client-side by the web
 * app via WebContainer's git API (or ssh-agent where available).
 *
 * Env vars (set in distro/.env):
 *   ATLAS_URL        – base URL of the Atlas instance
 *                      (e.g. https://atlas.innotel.us)
 *   ATLAS_GIT_REMOTE – Git SSH host for exports
 *                      (e.g. git@atlas.innotel.us)
 */

const ATLAS_URL = (process.env.ATLAS_URL || '').replace(/\/+$/, '');
const ATLAS_GIT_REMOTE = process.env.ATLAS_GIT_REMOTE || '';

export function atlasConfigured() {
  return Boolean(ATLAS_URL && ATLAS_GIT_REMOTE);
}

export function getAtlasConfig() {
  return {
    configured: atlasConfigured(),
    url: ATLAS_URL,
    remote: ATLAS_GIT_REMOTE,
  };
}

/**
 * Validate a git remote URL.
 * Accepts SSH (git@host:user/repo.git) and HTTPS (https://host/user/repo.git).
 */
export function validateRemote(url) {
  if (!url) return { valid: false, error: 'remote URL required' };

  const sshPattern = /^git@[^:]+:[\w.-]+\/[\w.-]+\.git$/;
  const httpsPattern = /^https?:\/\/[^/]+\/[\w.-]+\/[\w.-]+(?:\.git)?$/;

  if (!sshPattern.test(url) && !httpsPattern.test(url)) {
    return { valid: false, error: 'invalid remote URL (expected git@host:user/repo.git or https://host/user/repo.git)' };
  }

  return { valid: true };
}
