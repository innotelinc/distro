import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";

import { readBuildQueue, readRunner } from "../src/buildQueue.js";

/**
 * The admin build-queue view is a reader over another service's directory, so
 * what it must never do is trust it: the tests here are about a missing
 * directory, a file that is half-written, a filename that is not a job id, and a
 * heartbeat old enough to mean the runner is gone.
 */

const JOB = "0123456789abcdef";
const OTHER = "fedcba9876543210";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "distro-queue-test-"));
  process.env.STUDIO_BUILD_QUEUE_DIR = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STUDIO_BUILD_QUEUE_DIR;
});

function writeQueueFile(name, contents) {
  writeFileSync(join(dir, name), typeof contents === "string" ? contents : JSON.stringify(contents, null, 2));
}

function request(job, overrides = {}) {
  return {
    v: 1,
    job,
    action: "build",
    spec: `build-requests/${job}.md`,
    slug: "my-app",
    title: "My App",
    requested_by: "studio",
    requested_at: "2026-09-14T09:00:00.000Z",
    kind: "website",
    ...overrides,
  };
}

function status(job, overrides = {}) {
  return {
    job,
    state: "running",
    action: "build",
    slug: "my-app",
    title: "My App",
    requested_by: "studio",
    requested_at: "2026-09-14T09:00:00.000Z",
    started_at: "2026-09-14T09:00:05.000Z",
    updated_at: "2026-09-14T09:00:30.000Z",
    message: "",
    ...overrides,
  };
}

test("says so when the queue is not mounted, instead of erroring", () => {
  delete process.env.STUDIO_BUILD_QUEUE_DIR;

  const view = readBuildQueue();

  assert.equal(view.configured, false);
  assert.equal(view.readable, false);
  assert.deepEqual(view.jobs, []);
  assert.equal(view.counts.total, 0);
});

test("reports a configured directory it cannot read", () => {
  process.env.STUDIO_BUILD_QUEUE_DIR = join(dir, "does-not-exist");

  const view = readBuildQueue();

  assert.equal(view.configured, true);
  assert.equal(view.readable, false);
  assert.deepEqual(view.jobs, []);
});

test("merges a request with its status, newest first", () => {
  writeQueueFile(`${JOB}.request.json`, request(JOB));
  writeQueueFile(
    `${JOB}.status.json`,
    status(JOB, {
      state: "succeeded",
      finished_at: "2026-09-14T09:01:00.000Z",
      updated_at: "2026-09-14T09:01:00.000Z",
      exit_code: 0,
      published_url: "https://my-app.innotel.us",
    }),
  );
  writeQueueFile(`${OTHER}.request.json`, request(OTHER, { slug: "other-app", kind: "app" }));

  const view = readBuildQueue();

  assert.equal(view.readable, true);
  assert.equal(view.dir, dir);
  assert.deepEqual(
    view.jobs.map((job) => [job.job, job.state, job.slug, job.kind]),
    [
      [JOB, "succeeded", "my-app", "website"],
      [OTHER, "queued", "other-app", "app"],
    ],
  );
  assert.equal(view.jobs[0].publishedUrl, "https://my-app.innotel.us");
  assert.equal(view.jobs[0].exitCode, 0);
  assert.deepEqual(view.counts, {
    total: 2,
    queued: 1,
    running: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
  });
});

test("keeps a status whose request has been pruned", () => {
  writeQueueFile(`${JOB}.status.json`, status(JOB, { state: "failed", exit_code: 1, message: "vite build failed" }));

  const view = readBuildQueue();

  assert.equal(view.jobs.length, 1);
  assert.equal(view.jobs[0].state, "failed");
  assert.equal(view.jobs[0].message, "vite build failed");
});

test("ignores anything that is not a job file", () => {
  writeQueueFile(`${JOB}.request.json`, request(JOB));
  writeQueueFile("not-a-job.request.json", request(JOB));
  writeQueueFile("0123456789abcde.status.json", status("0123456789abcde")); // 15 chars: not a job id
  writeQueueFile("runner.heartbeat.tmp", "{}");
  writeQueueFile(`${JOB}.status.json`, "{ this is not json");
  mkdirSync(join(dir, `${OTHER}.request.json.d`));

  const view = readBuildQueue();

  assert.deepEqual(
    view.jobs.map((job) => job.job),
    [JOB],
    "a half-written status leaves the row, it does not fail the listing",
  );
  assert.equal(view.jobs[0].state, "queued");
});

test("bounds the number of jobs it returns", () => {
  for (let index = 0; index < 5; index += 1) {
    const job = index.toString(16).padStart(16, "0");
    writeQueueFile(`${job}.request.json`, request(job));
  }

  assert.equal(readBuildQueue({ limit: 2 }).jobs.length, 2);
  assert.equal(readBuildQueue({ limit: 500 }).jobs.length, 5);
  assert.equal(readBuildQueue().jobs.length, 5);
});

test("a heartbeat older than a minute is not a live runner", () => {
  const fresh = new Date(Date.now() - 5_000).toISOString();
  const stale = new Date(Date.now() - 600_000).toISOString();

  writeQueueFile("runner.heartbeat.json", {
    beat_at: fresh,
    pid: 4242,
    host: "factory-1",
    busy_with: JOB,
  });

  const live = readRunner(dir);
  assert.equal(live.live, true);
  assert.equal(live.host, "factory-1");
  assert.equal(live.busyWith, JOB);
  assert.ok(live.ageSeconds >= 4 && live.ageSeconds <= 6, `age ${live.ageSeconds}`);

  writeQueueFile("runner.heartbeat.json", { beat_at: stale, pid: 4242 });
  const gone = readRunner(dir);
  assert.equal(gone.live, false);
  assert.ok(gone.ageSeconds >= 599);

  // A heartbeat with no usable timestamp is not evidence of a runner.
  writeQueueFile("runner.heartbeat.json", { beat_at: "whenever" });
  assert.equal(readRunner(dir).live, false);
});
