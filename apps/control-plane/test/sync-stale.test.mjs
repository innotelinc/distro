import assert from "node:assert/strict";
import test from "node:test";

import { syncIsStale } from "../src/sync.js";

/**
 * The usage-sync watchdog's boundary (M8).
 *
 * A timer that stopped, a wedged process and a sync that has never once
 * succeeded all look identical from the outside — the ledger is frozen and
 * nobody is told. The decision is a pure function so the case that matters most
 * (never succeeded) is a boundary a test can pin rather than a timer a test would
 * have to race.
 */

const MINUTE = 60 * 1000;
const STALE = 5 * MINUTE;

test("a sync that has never succeeded is stale once the grace window passes", () => {
  const startedAt = 1_000_000;
  // Inside the window: a fresh process is not stale yet.
  assert.equal(syncIsStale({ now: startedAt + STALE, lastSuccessAt: null, startedAt, staleMs: STALE }), false);
  // Just past it: this is the failure nobody reports today.
  assert.equal(
    syncIsStale({ now: startedAt + STALE + 1, lastSuccessAt: null, startedAt, staleMs: STALE }),
    true,
  );
});

test("a successful sync resets the clock from its own time, not from boot", () => {
  const startedAt = 1_000_000;
  const lastSuccessAt = startedAt + 10 * MINUTE; // ran for a while, then succeeded
  const now = lastSuccessAt + STALE;
  assert.equal(syncIsStale({ now, lastSuccessAt, startedAt, staleMs: STALE }), false);
  assert.equal(syncIsStale({ now: now + 1, lastSuccessAt, startedAt, staleMs: STALE }), true);
});

test("a stale window of zero reports immediately, so the check is never the thing that hides", () => {
  // `staleMs` is always a real window in production; this pins that the boundary
  // is `>` rather than `>=`, which is what stops a fresh process alerting on its
  // very first tick.
  const now = 5_000;
  assert.equal(syncIsStale({ now, lastSuccessAt: 4_000, startedAt: 0, staleMs: 1_000 }), false);
  assert.equal(syncIsStale({ now: now + 1, lastSuccessAt: 4_000, startedAt: 0, staleMs: 1_000 }), true);
});
