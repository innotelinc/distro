/**
 * Git export helper — pushes the current project to a remote (Atlas/Gitea).
 *
 * This is a server-side helper that the web app calls when the user clicks
 * "Export to Git". It clones the project from the WebContainer's filesystem
 * (via the agent's output directory) and pushes to the configured remote.
 *
 * In practice, the web app handles the export client-side via WebContainer's
 * git API. This module provides the server-side configuration and validation.
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
