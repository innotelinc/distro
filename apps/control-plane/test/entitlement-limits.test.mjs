/**
 * Who has limits (subscription terms, as the platform states them).
 *
 * A limit belongs to a subscription; a service account has none. The failure this
 * guards against is the one that actually happened: the classroom's own key being
 * judged by a subscriber's free tier and answering 429 in the middle of a class.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { entitlementFor, gatedQuota, isServicePlan, SERVICE_PLAN } from '../src/billing.js';

const serviceQuota = { plan: SERVICE_PLAN, requests_per_day: null, tokens_per_day: null, spend_cap_usd: null };
const subscriberQuota = { plan: 'genie', requests_per_day: 500, tokens_per_day: 2_000_000, spend_cap_usd: 25 };
const freeQuota = { plan: 'free', requests_per_day: null, tokens_per_day: null, spend_cap_usd: null };

test('a service account keeps no limits even when Magnate says otherwise', () => {
  assert.equal(isServicePlan(serviceQuota), true);
  // entitled:false is exactly the answer a service account gets (it has no
  // subscription), and it must not turn into a free-tier clamp.
  const gated = gatedQuota({ entitled: false, source: 'magnate' }, serviceQuota);
  assert.deepEqual(gated, serviceQuota);
  // Magnate being unreachable changes nothing for a service account either.
  assert.deepEqual(gatedQuota({ entitled: null, source: 'unreachable' }, serviceQuota), serviceQuota);
});

test('a subscriber keeps the limits the platform holds for them', () => {
  assert.deepEqual(gatedQuota({ entitled: true, source: 'magnate' }, subscriberQuota), subscriberQuota);
});

test('an unsubscribed account is not starved of tokens by default', () => {
  // The clamp is opt-in (CONTROL_FREE_TIER_LIMITS): access to a paid surface is
  // decided by the entitlement verdict the product receives, not by burning the
  // account's tokens until it stops.
  assert.deepEqual(gatedQuota({ entitled: false, source: 'magnate' }, freeQuota), freeQuota);
});

test('entitlementFor answers service accounts without asking a billing platform', async () => {
  const answer = await entitlementFor({ id: 'u1', email: 'atheniq@innotel.us' }, serviceQuota, 'genie');
  assert.equal(answer.entitled, true);
  assert.equal(answer.service, true);
  assert.equal(answer.limits, null, 'no limits, and none implied');
  assert.match(answer.reason, /service account/);
  // `source: distro` and not `magnate`: no billing platform was consulted.
  assert.equal(answer.source, 'distro');
});

test('the answer says which plan was asked about, not just the account\'s own label', async () => {
  // The case that motivated it: an account labelled `unlimited` locally, asked
  // about the `genie` plan. `plan` stays the account's label; `plan_asked` is what
  // the caller asked, so a product can tell its own question was understood.
  const localLabel = { plan: 'unlimited', requests_per_day: null, tokens_per_day: null, spend_cap_usd: null };
  const answer = await entitlementFor({ id: 'u3', email: 'someone@example.com' }, localLabel, 'genie');
  assert.equal(answer.plan, 'unlimited');
  assert.equal(answer.plan_asked, 'genie');

  // A service account answers about no plan in particular, and says so.
  const service = await entitlementFor({ id: 'u4', email: 'atheniq@innotel.us' }, serviceQuota, null);
  assert.equal(service.plan, SERVICE_PLAN);
  assert.equal(service.plan_asked, null);
});

test('entitlementFor reports a real account\'s limits beside the verdict', async () => {
  const answer = await entitlementFor({ id: 'u2', email: 'someone@example.com' }, subscriberQuota, 'genie');
  assert.equal(answer.service, false);
  assert.deepEqual(answer.limits, {
    requests_per_day: 500,
    tokens_per_day: 2_000_000,
    spend_cap_usd: 25,
  });
  // With Magnate unconfigured in tests the verdict is "could not check", which is
  // distinct from a refusal — and it still carries the limits.
  assert.equal(answer.entitled, null);
  assert.notEqual(answer.service, true);
});
