/**
 * The "sync succeeded, data missing" failure (M4/M8).
 *
 * An unmapped gateway key never errors: the pass completes, `unknownKeys`
 * counts it, and the dashboard silently omits those tokens. The alert text is
 * the only place an operator learns which key to map and how much it is
 * carrying, so its ordering and totals are pinned here rather than trusted.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { unmappedAlert } from '../src/sync.js';

test('orders by tokens and totals every unmapped key', () => {
  const alert = unmappedAlert([
    { apiKeyId: 'small', tokensIn: 10, tokensOut: 5, requests: 1 },
    { apiKeyId: 'big', tokensIn: 1000, tokensOut: 200, requests: 7 },
  ]);
  assert.equal(alert.title, '2 gateway key(s) have no Distro account');
  // Message leads with the biggest consumer: that is the key worth mapping first.
  assert.match(alert.message, /big \(1200 tok\/7 req\), small \(15 tok\/1 req\)/);
  assert.match(alert.message, /1215 token\(s\) across 8 request\(s\)/);
  assert.equal(alert.meta.unmapped[0].apiKeyId, 'big');
});

test('truncates the list but never the totals', () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    apiKeyId: `k${i}`,
    tokensIn: (i + 1) * 100,
    tokensOut: 0,
    requests: 1,
  }));
  const alert = unmappedAlert(rows);
  assert.match(alert.message, /and 2 more/);
  assert.match(alert.message, /2800 token\(s\)/);
  assert.equal(alert.meta.unmapped.length, 7);
  // Every key stays in meta so a receiver can act on the ones not in the text.
  assert.equal(alert.meta.unmapped[0].apiKeyId, 'k6');
});
