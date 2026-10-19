/**
 * One account, several keys (M4).
 *
 * The sync REPLACES an account's day, so writing per key instead of per account
 * leaves only the last key's tokens in `usage_cache` — a silently under-reported
 * day, not an error. Every account here has a default key, an app key and often
 * a legacy shared key, so this is the normal case, not an edge.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { groupUnmappedByUser } from '../src/sync.js';

const owners = { keyOne: { id: 'user-1' }, keyTwo: { id: 'user-1' }, other: { id: 'user-2' } };
const lookup = (id) => owners[id] || null;

const agg = (apiKeyId, tokensIn, tokensOut, requests, models = []) => ({
  apiKeyId,
  tokensIn,
  tokensOut,
  requests,
  costUsd: tokensIn / 1_000_000,
  models,
});

test('sums every key an account owns into a single day', () => {
  const { byUser, unknownKeys } = groupUnmappedByUser(
    new Map([
      ['keyOne', agg('keyOne', 100, 10, 2, [{ model: 'a', tokensIn: 100, tokensOut: 10, requests: 2, costUsd: 0.0001 }])],
      ['keyTwo', agg('keyTwo', 50, 5, 1, [{ model: 'b', tokensIn: 50, tokensOut: 5, requests: 1, costUsd: 0.00005 }])],
      ['other', agg('other', 7, 1, 1)],
    ]),
    lookup,
  );

  assert.equal(byUser.size, 2);
  assert.equal(unknownKeys, 0);
  const day = byUser.get('user-1');
  assert.deepEqual(
    { tokensIn: day.tokensIn, tokensOut: day.tokensOut, requests: day.requests },
    { tokensIn: 150, tokensOut: 15, requests: 3 },
  );
  // Both models survive, or the per-model table loses one of the keys.
  assert.deepEqual(day.models.map((m) => m.model), ['a', 'b']);
});

test('an unmapped key is reported once, not folded into an account', () => {
  const { byUser, unmapped, unknownKeys } = groupUnmappedByUser(
    new Map([['gone', agg('gone', 400, 40, 4)]]),
    lookup,
  );
  assert.equal(byUser.size, 0);
  assert.equal(unknownKeys, 1);
  assert.deepEqual(unmapped, [{ apiKeyId: 'gone', tokensIn: 400, tokensOut: 40, requests: 4 }]);
});
