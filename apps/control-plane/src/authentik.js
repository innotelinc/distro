import { randomBytes } from 'node:crypto';
import {
  createUser,
  getUserByEmail,
  getUserByOidcSub,
  setUserOidcSub,
  upsertQuota,
  getQuota,
  getGatewayKey,
  setGatewayKey,
  updateUser,
  upsertIdentityGroup,
  replaceIdentityGroupMembers,
} from './db.js';

const API_URL = String(process.env.AUTHENTIK_API_URL || '').trim().replace(/\/+$/, '');
const API_TOKEN = String(process.env.AUTHENTIK_API_TOKEN || '').trim();
const GROUP_NAME = String(process.env.AUTHENTIK_GROUP_NAME || 'distro-users').trim();

export function authentikGroupConfigured() {
  return Boolean(API_URL && API_TOKEN && GROUP_NAME);
}

async function authentikFetch(path, options = {}) {
  if (!authentikGroupConfigured()) throw new Error('Authentik group sync is not configured (AUTHENTIK_API_URL, AUTHENTIK_API_TOKEN, AUTHENTIK_GROUP_NAME)');
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${API_TOKEN}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) throw new Error(`Authentik API returned HTTP ${response.status}`);
  return body;
}

async function findOrCreateGroup() {
  const query = `/api/v3/core/groups/?name=${encodeURIComponent(GROUP_NAME)}`;
  const found = await authentikFetch(query);
  if (found?.results?.length) return found.results[0];
  return authentikFetch('/api/v3/core/groups/', {
    method: 'POST',
    body: JSON.stringify({ name: GROUP_NAME }),
  });
}

async function groupUsers(group) {
  const users = Array.isArray(group.users)
    ? group.users
    : (await authentikFetch(`/api/v3/core/groups/${encodeURIComponent(group.pk || group.id)}/`))?.users || [];
  // Authentik may return only user primary keys in a group representation.
  return Promise.all(users.map((user) => {
    if (user && typeof user === 'object') return user;
    return authentikFetch(`/api/v3/core/users/${encodeURIComponent(user)}/`);
  }));
}

function memberEmail(member) {
  return String(member.email || member.attributes?.email || member.username || '').trim().toLowerCase();
}

function memberSubject(member) {
  return String(member.uid || member.uuid || member.pk || member.id || '').trim();
}

async function ensureGatewayKey(user, gateway) {
  const existing = getGatewayKey(user.id);
  if (existing?.gateway_key) return existing;
  const quota = getQuota(user.id);
  await gateway.login();
  const key = await gateway.createApiKey(`distro-user-${user.id.slice(0, 8)}`, {
    dailyUsageLimitUsd: quota.spend_cap_usd ?? undefined,
    weeklyUsageLimitUsd: quota.spend_cap_usd != null ? quota.spend_cap_usd * 7 : undefined,
  });
  return setGatewayKey(user.id, { gatewayKeyId: key.id, gatewayKey: key.key });
}

/**
 * Mirror the configured Authentik group into local accounts and membership rows.
 * The remote group is authoritative; missing groups are created automatically.
 */
export async function syncAuthentikGroup({ gateway }) {
  const group = await findOrCreateGroup();
  const remoteUsers = await groupUsers(group);
  const localMembers = [];
  let created = 0;

  for (const member of remoteUsers) {
    const email = memberEmail(member);
    const subject = `authentik:${memberSubject(member)}`;
    if (!email || !memberSubject(member)) continue;

    let user = getUserByOidcSub(subject) || getUserByEmail(email);
    if (!user) {
      user = createUser({
        email,
        passwordHash: `sso:${randomBytes(18).toString('hex')}`,
        role: 'user',
      });
      upsertQuota(user.id, { plan: 'free' });
      created += 1;
    }
    if (!user.oidc_sub) user = setUserOidcSub(user.id, subject);
    if (user.disabled_at && !getGatewayKey(user.id)) user = updateUser(user.id, { disabled_at: null });
    await ensureGatewayKey(user, gateway);
    localMembers.push({ userId: user.id, externalId: memberSubject(member) });
  }

  const localGroup = upsertIdentityGroup({
    provider: 'authentik',
    externalId: String(group.pk || group.id || ''),
    name: GROUP_NAME,
  });
  replaceIdentityGroupMembers(localGroup.id, localMembers);

  return {
    configured: true,
    group: { id: localGroup.id, externalId: localGroup.external_id, name: localGroup.name },
    remoteMembers: remoteUsers.length,
    mappedMembers: localMembers.length,
    createdUsers: created,
  };
}

export function authentikGroupConfig() {
  return { configured: authentikGroupConfigured(), groupName: GROUP_NAME };
}
