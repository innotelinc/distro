// Studio's build queue, read-only (convergence plan §5.2, "admin surface").
//
// Studio queues a build by writing a request file and reading the status the
// host-side runner writes back. The queue directory is therefore the only record
// of what is building — and it lives on the host that runs the factory, not on
// this container.
//
// This module is a **reader**. It never writes, never claims a job, and never
// interprets a file as an instruction: it renders what is on disk so an operator
// looking at users and quotas can see the queue beside them instead of opening a
// shell. Studio's own `make build-runner-list` remains the authoritative answer,
// and the runner remains the only writer that matters.
//
// Point `STUDIO_BUILD_QUEUE_DIR` at the same directory Studio does (a mount, or
// unset for "no view"). Every path here comes from that variable: a job id is
// re-checked against the id pattern before it is used as a filename, so nothing
// read from a request can name a file outside the directory.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The ids Studio generates (Studio's own JOB_ID_PATTERN). */
export const JOB_ID_PATTERN = /^[0-9a-f]{16}$/;

/**
 * Seconds after which a heartbeat is too old to believe (Studio's
 * RUNNER_STALE_SECONDS). Duplicated deliberately: this process must not read a
 * stale heartbeat as a live runner just because the other one changed its mind.
 */
export const RUNNER_STALE_SECONDS = 60;

/** How many jobs the view returns. The queue is a window, not an archive. */
export const MAX_JOBS = 50;

const MAX_FIELD_CHARS = 200;
const MAX_MESSAGE_CHARS = 500;

export function buildQueueDir() {
  const configured = String(process.env.STUDIO_BUILD_QUEUE_DIR || '').trim();
  return configured ? resolve(configured) : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // One unreadable file is one missing row, never a failed listing: the runner
    // writes these while the view reads them, and a half-written file is normal.
    return null;
  }
}

function asString(value, limit = MAX_FIELD_CHARS) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asIso(value) {
  const text = asString(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? text : null;
}

/**
 * Whether a build runner is alive, from the heartbeat it writes.
 *
 * Same clamping as Studio's: a slightly-future timestamp reads as "just now"
 * rather than as a negative age.
 */
export function readRunner(directory) {
  const beat = readJson(join(directory, 'runner.heartbeat.json'));
  if (typeof beat !== 'object' || beat === null) {
    return { live: false, ageSeconds: null, pid: null, host: null, busyWith: null };
  }

  const beatAt = asIso(beat.beat_at);
  const parsed = beatAt ? Date.parse(beatAt) : Number.NaN;
  const ageSeconds = Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;

  return {
    live: ageSeconds !== null && ageSeconds <= RUNNER_STALE_SECONDS,
    ageSeconds,
    pid: asNumber(beat.pid),
    host: asString(beat.host),
    busyWith: asString(beat.busy_with),
  };
}

/** One job, from its request and its status, whichever exist. */
function toJob(job, request, status) {
  const state = status ? asString(status.state) : null;
  return {
    job,
    // A request with no status has been queued and not yet picked up.
    state: state || 'queued',
    action: asString(status?.action) || asString(request?.action) || 'build',
    kind: asString(request?.kind),
    slug: asString(status?.slug) || asString(request?.slug),
    title: asString(status?.title) || asString(request?.title),
    requestedBy: asString(status?.requested_by) || asString(request?.requested_by),
    requestedAt: asIso(status?.requested_at) || asIso(request?.requested_at),
    startedAt: asIso(status?.started_at),
    finishedAt: asIso(status?.finished_at),
    updatedAt: asIso(status?.updated_at),
    exitCode: asNumber(status?.exit_code),
    message: asString(status?.message, MAX_MESSAGE_CHARS) || '',
    publishedUrl: asString(status?.published_url),
    previewUrl: asString(status?.preview_url),
  };
}

/** When a job last said anything, as a sort key that tolerates missing times. */
function recency(job) {
  const stamp = job.updatedAt || job.finishedAt || job.startedAt || job.requestedAt;
  const parsed = stamp ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The queue as it stands.
 *
 * `configured: false` is a normal answer, not an error: the view exists whether
 * or not this deployment mounts the queue, and the console says which it is.
 */
export function readBuildQueue({ limit = MAX_JOBS } = {}) {
  const directory = buildQueueDir();
  if (!directory) {
    return {
      configured: false,
      dir: null,
      readable: false,
      jobs: [],
      runner: { live: false, ageSeconds: null, pid: null, host: null, busyWith: null },
      counts: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    };
  }

  let names;
  try {
    names = readdirSync(directory);
  } catch {
    return {
      configured: true,
      dir: directory,
      readable: false,
      jobs: [],
      runner: { live: false, ageSeconds: null, pid: null, host: null, busyWith: null },
      counts: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    };
  }

  // Collect the ids first, from both file kinds, so a status whose request has
  // been pruned still shows up.
  const jobs = new Map();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const match = name.match(/^([0-9a-f]{16})\.(request|status)\.json$/);
    if (!match) continue;
    const [, job, kind] = match;
    if (!JOB_ID_PATTERN.test(job)) continue;
    if (!jobs.has(job)) jobs.set(job, { request: null, status: null });
    jobs.get(job)[kind] = readJson(join(directory, name));
  }

  const rows = [...jobs.entries()].map(([job, files]) => toJob(job, files.request, files.status));
  rows.sort((left, right) => recency(right) - recency(left));

  const counts = { total: rows.length, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    if (counts[row.state] !== undefined) counts[row.state] += 1;
  }

  return {
    configured: true,
    dir: directory,
    readable: true,
    runner: readRunner(directory),
    counts,
    jobs: rows.slice(0, Math.max(1, Math.min(MAX_JOBS, Number(limit) || MAX_JOBS))),
  };
}
