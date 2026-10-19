/**
 * Grouping for the history backfill (M4).
 *
 * The backfill REPLACES stored days, so a grouping bug does not show up as a
 * missing row — it shows up as believable wrong history. These pin the two
 * properties that matter: rows for one account/day collapse into one day, and
 * traffic on keys with no account is reported, never silently dropped.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { planBackfill } from '../src/sync.js';

const owners = { keyA: { id: 'user-1' }, keyB: { id: 'user-2' } };
const lookup = (apiKeyId) => owners[apiKeyId] || null;

const row = (date, apiKeyId, model, tokensIn, tokensOut, requests) => ({
  date,
  apiKeyId,
  model,
  tokensIn,
  tokensOut,
  requests,
  costUsd: tokensIn / 1_000_000,
});

test('collapses a user-day across keys and models, keeping the model rows', () => {
  const plan = planBackfill(
    [
      row('2026-10-16', 'keyA', 'm1', 100, 10, 1),
      row('2026-10-16', 'keyA', 'm2', 200, 20, 2),
      row('2026-10-17', 'keyA', 'm1', 50, 5, 1),
      row('2026-10-16', 'keyB', 'm1', 7, 1, 1),
    ],
    lookup,
  );
  assert.equal(plan.perUserDay.length, 3);
  const day = plan.perUserDay.find((d) => d.date === '2026-10-16' && d.userId === 'user-1');
  assert.deepEqual(
    { tokensIn: day.tokensIn, tokensOut: day.tokensOut, requests: day.requests },
    { tokensIn: 300, tokensOut: 30, requests: 3 },
  );
  // Every per-model row survives for the breakdown table.
  assert.equal(day.models.length, 2);
  // Summed, not averaged: two model rows make the day's cost. Compared with a
  // tolerance because the per-row costs are floats, not cents.
  assert.ok(Math.abs(day.costUsd - (100 + 200) / 1_000_000) < 1e-12);
});

test('reports unmapped traffic instead of dropping it', () => {
  const plan = planBackfill(
    [
      row('2026-10-16', 'keyA', 'm1', 10, 1, 1),
      row('2026-10-16', 'gone', 'm1', 400, 40, 4),
      row('2026-10-17', 'gone', 'm1', 100, 10, 1),
    ],
    lookup,
  );
  assert.equal(plan.unmapped.length, 1);
  assert.deepEqual(
    { key: plan.unmapped[0].apiKeyId, tokensIn: plan.unmapped[0].tokensIn },
    { key: 'gone', tokensIn: 500 },
  );
  assert.equal(plan.unmapped[0].requests, 5);
});
