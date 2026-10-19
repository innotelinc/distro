/**
 * The accounting day (12:00 AM America/New_York).
 *
 * Usage was bucketed by UTC, so the dashboard rolled over at 20:00 Eastern and an
 * evening's work counted as tomorrow. These pin the two boundaries a fixed offset
 * gets wrong (EDT and EST) and the ledger formats that have to land on the same
 * day as a live write.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { usageDay, usageDayOf, usageDayStart, USAGE_TIME_ZONE } from '../src/usageDay.js';

test('the day turns at midnight Eastern, not at midnight UTC', () => {
  assert.equal(USAGE_TIME_ZONE, 'America/New_York');
  // 11:59:59 PM EDT on the 18th is still the 18th…
  assert.equal(usageDay(new Date('2026-10-19T03:59:59Z')), '2026-10-18');
  // …and a second later it is the 19th, while UTC has said the 19th for hours.
  assert.equal(usageDay(new Date('2026-10-19T04:00:00Z')), '2026-10-19');
  // Mid-afternoon UTC is still the same Eastern day.
  assert.equal(usageDay(new Date('2026-10-19T18:00:00Z')), '2026-10-19');
});

test('the boundary follows the zone into EST', () => {
  assert.equal(usageDay(new Date('2026-12-19T04:59:59Z')), '2026-12-18');
  assert.equal(usageDay(new Date('2026-12-19T05:00:00Z')), '2026-12-19');
});

test('both ledger timestamp shapes land on the accounting day', () => {
  assert.equal(usageDayOf('2026-10-19T01:22:05.270Z'), '2026-10-18');
  assert.equal(usageDayOf('2026-10-19 01:22:05'), '2026-10-18');
  assert.equal(usageDayOf('2026-10-19T05:30:00.000Z'), '2026-10-19');
});

test('usageDayStart is the zone midnight in both offsets', () => {
  assert.equal(usageDayStart('2026-10-19'), '2026-10-19T04:00:00.000Z'); // EDT
  assert.equal(usageDayStart('2026-12-19'), '2026-12-19T05:00:00.000Z'); // EST
});

test('an unusable timestamp is refused, never guessed', () => {
  assert.throws(() => usageDayOf(''), /empty timestamp/);
  assert.throws(() => usageDay(new Date('nope')), /invalid timestamp/);
});
