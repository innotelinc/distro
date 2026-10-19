// The accounting day, in the operator's timezone.
//
// Reset is 12:00 AM America/New_York, not UTC: with UTC the dashboard rolled
// over at 20:00 Eastern, so an evening's work landed on "tomorrow" and a day's
// total changed under the user while they were still working. DST is left to the
// zone database rather than a fixed -5 offset, because a fixed offset is wrong
// for half the year in both directions.
//
// One function for both sides of the ledger: the scheduled sync, the backfill and
// every per-user write call `usageDay`, and the gateway's UTC timestamps are
// bucketed through `usageDayOf`, so a backfilled day and a live day cannot
// disagree about where a 23:30 UTC call belongs.
//
// Override with CONTROL_USAGE_TIME_ZONE for a deployment that bills in another
// zone; the value is an IANA zone name.

export const USAGE_TIME_ZONE = process.env.CONTROL_USAGE_TIME_ZONE || 'America/New_York';

// en-CA formats as YYYY-MM-DD, but the parts are assembled by hand below: a
// locale change upstream must not be able to alter the string format this
// service stores in a primary key.
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: USAGE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The accounting day (YYYY-MM-DD) that `at` falls in.
 *
 * @param {Date|string|number} [at] default: now
 */
export function usageDay(at = new Date()) {
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) throw new Error(`usageDay: invalid timestamp ${JSON.stringify(at)}`);
  const parts = formatter.formatToParts(when);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The accounting day of a gateway ledger timestamp.
 *
 * The gateway writes ISO-8601 UTC (`2026-10-19T01:22:05.270Z`), but rows from an
 * older release come back as `YYYY-MM-DD HH:MM:SS`; both are read as UTC, which
 * is what they are.
 */
export function usageDayOf(timestamp) {
  const raw = String(timestamp ?? '').trim();
  if (!raw) throw new Error('usageDayOf: empty timestamp');
  const iso = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  return usageDay(new Date(iso));
}

/**
 * `day` shifted by whole calendar days (negative goes back).
 *
 * Plain `now - n*24h` drifts across a DST change — the window would end an hour
 * early or late and lose (or gain) a day at the edge. This adds days to the date
 * itself, in UTC, where a day is always 24 hours.
 */
export function usageDayShift(day, delta) {
  const [y, m, d] = String(day).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + delta));
  return shifted.toISOString().slice(0, 10);
}

/** The first instant of `day` in the accounting zone, as an ISO UTC string. */
export function usageDayStart(day = usageDay()) {
  // Walk forward from a UTC guess in minute steps until the zone's date matches:
  // the offset is ±a few hours and DST moves it by one, so a bounded walk is both
  // exact and free of hard-coded offsets.
  const target = new Date(`${day}T00:00:00Z`).getTime();
  let candidate = target - 6 * 60 * 60 * 1000;
  for (let i = 0; i < 24 * 60; i += 1) {
    const d = new Date(candidate);
    if (usageDay(d) === day && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0) {
      // Step back out of the previous day's last minute, then find the exact edge.
      for (let back = 1; back <= 60; back += 1) {
        const prev = new Date(candidate - back * 60 * 1000);
        if (usageDay(prev) !== day) return new Date(candidate).toISOString();
      }
      return new Date(candidate).toISOString();
    }
    candidate += 60 * 1000;
  }
  throw new Error(`usageDayStart: could not resolve the start of ${day} in ${USAGE_TIME_ZONE}`);
}
