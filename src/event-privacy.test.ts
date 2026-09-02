/**
 * Real subject events must not be able to reach the committed fixture log.
 *
 * The failure this file exists to prevent: `gonogo judge` on somebody's private
 * repository appended a `real` event — their task id, their verdict, their
 * evidence hash — to `events.jsonl` at the root of this public checkout, where
 * the next `git add` would publish it. The tracked log is for fixture sweeps.
 * Everything about a real subject goes to the gitignored private log, or to an
 * explicit path the operator named outside the checkout.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  linkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  GONOGO_ROOT,
  PRIVATE_EVENTS,
  PRIVATE_EVENTS_DIR,
  TRACKED_FIXTURE_EVENTS,
  assertWritableDestination,
  canonicalPath,
  isPublishedLocation,
  isTrackedFixtureLog,
} from "./event-destination.ts";
import { EVENT_SCHEMA_VERSION, appendEvent, migrateEvent } from "./events.ts";
import type { GonogoEvent, JudgeEvent, OutcomeEvent, RaterEvent } from "./events.ts";

const SCORES = {
  task_satisfaction: 4,
  scope_discipline: 4,
  claim_verification: 4,
  goal_alignment: 4,
};

function judgeEvent(kind: "fixture" | "real"): JudgeEvent {
  return migrateEvent({
    schema_version: EVENT_SCHEMA_VERSION,
    ts: "2026-09-02T00:00:00Z",
    kind,
    gonogo_version: "0.1.6",
    run_id: `run-${kind}`,
    fixture_id: kind === "fixture" ? "clean-pass" : null,
    task_id: kind === "real" ? "private-task" : null,
    workspace_id: null,
    backend: "claude-cli",
    model_version: "claude-sonnet-5",
    prompt_hashes: { "prompts/rubric-pass.md": "a".repeat(64) },
    subject_hash: "c".repeat(64),
    evidence_hash: "b".repeat(64),
    rater_id: "judge:claude-cli",
    scores: SCORES,
    spec_clarity: 4,
    confidence: 0.8,
    abstained: false,
    verdict: "go",
    drift_type: "none",
    attempted_gaming: false,
    disclosure: "none",
    latency_ms: 100,
    tokens_in: null,
    tokens_out: null,
    cost_usd: null,
    citation_repair: null,
    replay: false,
  }) as JudgeEvent;
}

function raterEvent(): RaterEvent {
  return migrateEvent({
    schema_version: EVENT_SCHEMA_VERSION,
    ts: "2026-09-02T00:00:00Z",
    kind: "rater",
    gonogo_version: "0.1.6",
    run_id: "run-real",
    rater_id: "owen",
    rater_kind: "human",
    scores: SCORES,
    spec_clarity: 4,
    review_minutes: 12,
    notes: null,
  }) as RaterEvent;
}

function outcomeEvent(): OutcomeEvent {
  return migrateEvent({
    schema_version: EVENT_SCHEMA_VERSION,
    ts: "2026-09-02T00:00:00Z",
    kind: "outcome",
    gonogo_version: "0.1.6",
    task_id: "private-task",
    run_id: null,
    pr_url: "https://example.invalid/pr/1",
    state: "closed",
    merged_at: null,
  }) as OutcomeEvent;
}

const SUBJECT_EVENTS: Array<[string, () => GonogoEvent]> = [
  ["judge", () => judgeEvent("real")],
  ["rater", raterEvent],
  ["outcome", outcomeEvent],
];

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-event-privacy-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Both files this branch exists to protect, as bytes, or null when absent. */
function snapshot(): { tracked: string | null; priv: string | null } {
  const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  return { tracked: read(TRACKED_FIXTURE_EVENTS), priv: read(PRIVATE_EVENTS) };
}

function expectRejected(write: () => void, message: string): void {
  const before = snapshot();
  expect(write).toThrow(message);
  expect(snapshot()).toEqual(before);
}

describe("the tracked fixture log cannot receive a subject event", () => {
  for (const [name, make] of SUBJECT_EVENTS) {
    test(`a ${name} event is refused at the tracked log, naming the safe command`, () => {
      let thrown = "";
      try {
        appendEvent(TRACKED_FIXTURE_EVENTS, make());
      } catch (error) {
        thrown = error instanceof Error ? error.message : String(error);
      }
      expect(thrown).toContain("refusing to write");
      expect(thrown).toContain("the tracked fixture event log");
      // The error must hand the operator the destination that works.
      expect(thrown).toContain(PRIVATE_EVENTS);
    });

    test(`a refused ${name} event changes neither the tracked nor the private log`, () => {
      expectRejected(() => appendEvent(TRACKED_FIXTURE_EVENTS, make()), "refusing to write");
    });

    test(`a ${name} event is refused anywhere public inside the checkout`, () => {
      expectRejected(
        () => appendEvent(join(GONOGO_ROOT, "calibration", "events.jsonl"), make()),
        "a public location inside the gonogo checkout",
      );
      expectRejected(
        () => appendEvent(join(GONOGO_ROOT, "audits", "nested", "events.jsonl"), make()),
        "a public location inside the gonogo checkout",
      );
    });

    test(`a ${name} event is written when the operator names a safe path`, () => {
      inTemp((dir) => {
        const path = join(dir, "nested", "events.jsonl");
        appendEvent(path, make());
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
      });
    });

    test(`a ${name} event is written to the gitignored private default`, () => {
      // Same directory the real default lives in, with a test-owned filename so
      // the operator's own private log is never touched.
      const path = join(PRIVATE_EVENTS_DIR, `test-${name}-events.jsonl`);
      rmSync(path, { force: true });
      try {
        appendEvent(path, make());
        expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
      } finally {
        rmSync(path, { force: true });
      }
    });
  }
});

describe("fixture events keep the tracked log", () => {
  test("a fixture event is allowed at the committed default", () => {
    expect(() => assertWritableDestination(TRACKED_FIXTURE_EVENTS, "fixture")).not.toThrow();
  });

  test("a fixture event still appends normally", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      appendEvent(path, judgeEvent("fixture"));
      expect(readFileSync(path, "utf8")).toContain('"kind":"fixture"');
    });
  });
});

describe("path spellings that name the tracked log are all the tracked log", () => {
  const aliases = () => [
    TRACKED_FIXTURE_EVENTS,
    join(GONOGO_ROOT, ".", "events.jsonl"),
    join(GONOGO_ROOT, "src", "..", "events.jsonl"),
    join(GONOGO_ROOT, "private", "..", "events.jsonl"),
    `${GONOGO_ROOT}${sep}${sep}events.jsonl`,
  ];

  test("normalized spellings resolve to one file", () => {
    for (const alias of aliases()) {
      expect(isTrackedFixtureLog(alias)).toBe(true);
      expect(() => assertWritableDestination(alias, "real")).toThrow("refusing to write");
    }
  });

  test("a symlink pointing at the tracked log is the tracked log", () => {
    const link = join(PRIVATE_EVENTS_DIR, "test-alias-events.jsonl");
    mkdirSync(PRIVATE_EVENTS_DIR, { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(TRACKED_FIXTURE_EVENTS, link);
    try {
      expect(isTrackedFixtureLog(link)).toBe(true);
      expectRejected(() => appendEvent(link, judgeEvent("real")), "refusing to write");
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("a hard link to the tracked log is the tracked log", () => {
    // A hard link has no symlink to resolve, so only the device and inode
    // distinguish it. Putting one under private/ would otherwise pass the
    // location test and append straight into the committed file.
    const link = join(PRIVATE_EVENTS_DIR, "test-hardlink-events.jsonl");
    mkdirSync(PRIVATE_EVENTS_DIR, { recursive: true });
    rmSync(link, { force: true });
    linkSync(TRACKED_FIXTURE_EVENTS, link);
    try {
      expect(isTrackedFixtureLog(link)).toBe(true);
      expect(isPublishedLocation(link)).toBe(false);
      expectRejected(() => appendEvent(link, judgeEvent("real")), "refusing to write");
    } finally {
      rmSync(link, { force: true });
    }
  });

  test("a symlinked directory inside the checkout is still inside the checkout", () => {
    inTemp((dir) => {
      const link = join(dir, "checkout-link");
      symlinkSync(GONOGO_ROOT, link);
      expect(isPublishedLocation(join(link, "events.jsonl"))).toBe(true);
      expect(() => assertWritableDestination(join(link, "events.jsonl"), "real")).toThrow(
        "refusing to write",
      );
    });
  });

  test("a path outside the checkout is not published, however it is spelled", () => {
    inTemp((dir) => {
      expect(isPublishedLocation(join(dir, "events.jsonl"))).toBe(false);
      expect(isTrackedFixtureLog(join(dir, "events.jsonl"))).toBe(false);
      expect(canonicalPath(join(dir, "a", "..", "events.jsonl"))).toBe(
        canonicalPath(join(dir, "events.jsonl")),
      );
    });
  });

  test("the private log itself is not a published location", () => {
    expect(isPublishedLocation(PRIVATE_EVENTS)).toBe(false);
    expect(() => assertWritableDestination(PRIVATE_EVENTS, "real")).not.toThrow();
  });
});

describe("a malformed log does not weaken the boundary", () => {
  test("the destination is refused before the log is read at all", () => {
    // Ordering matters. A malformed log at a refused destination must report
    // the privacy refusal, not "repair the log first" — otherwise an operator
    // repairs the file and the write then lands where it must never land.
    const dir = join(GONOGO_ROOT, ".eval-tmp");
    const path = join(dir, "test-malformed-events.jsonl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "not json\n");
    try {
      expect(() => appendEvent(path, judgeEvent("real"))).toThrow("refusing to write");
      expect(() => appendEvent(path, judgeEvent("real"))).not.toThrow("malformed event line");
      expect(readFileSync(path, "utf8")).toBe("not json\n");
    } finally {
      rmSync(path, { force: true });
    }
  });

  test("the tracked log is refused whatever it contains", () => {
    expectRejected(
      () => appendEvent(TRACKED_FIXTURE_EVENTS, judgeEvent("real")),
      "refusing to write",
    );
  });

  test("a malformed private log is refused for repair without being changed", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeFileSync(path, "not json\n");
      expect(() => appendEvent(path, judgeEvent("real"))).toThrow("malformed event line");
      expect(readFileSync(path, "utf8")).toBe("not json\n");
    });
  });
});

describe("the CLI resolves destinations without consulting the subject repository", () => {
  function gonogo(args: string[]): { status: number | null; stderr: string; stdout: string } {
    const result = spawnSync(join(GONOGO_ROOT, "bin", "gonogo"), args, { encoding: "utf8" });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  test("outcome refuses the tracked log and writes neither file", () => {
    const before = snapshot();
    const result = gonogo([
      "outcome", "--task", "t", "--pr", "https://example.invalid/pr/1",
      "--state", "closed", "--events", TRACKED_FIXTURE_EVENTS,
    ]);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("refusing to write an outcome event");
    expect(snapshot()).toEqual(before);
  });

  test("outcome writes an explicitly named safe path", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      const result = gonogo([
        "outcome", "--task", "t", "--pr", "https://example.invalid/pr/1",
        "--state", "closed", "--events", path,
      ]);
      expect(result.status).toBe(0);
      expect(readFileSync(path, "utf8")).toContain('"kind":"outcome"');
    });
  });

  test("judge refuses the tracked log before it collects evidence or calls a judge", () => {
    inTemp((dir) => {
      const before = snapshot();
      // --repo does not exist, so anything that reached evidence collection
      // would fail with a git error instead of the privacy refusal.
      const result = gonogo([
        "judge", "--spec", "do the thing", "--repo", join(dir, "subject"),
        "--events", TRACKED_FIXTURE_EVENTS,
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("refusing to write a real judge event");
      expect(result.stderr).not.toContain("not a git repository");
      expect(snapshot()).toEqual(before);
    });
  });

  test("the destination follows the gonogo checkout, not --repo", () => {
    inTemp((dir) => {
      // A subject repository cannot make its own path the events destination,
      // and cannot make the tracked log acceptable.
      const result = gonogo([
        "judge", "--spec", "do the thing", "--repo", dir,
        "--events", join(GONOGO_ROOT, "events.jsonl"),
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain("refusing to write a real judge event");
      expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
    });
  });
});

describe("the private default is gitignored", () => {
  test(".gitignore excludes the private directory", () => {
    const ignore = readFileSync(join(GONOGO_ROOT, ".gitignore"), "utf8").split("\n");
    expect(ignore).toContain("private/");
  });

  test("git does not track the private log", () => {
    const tracked = spawnSync(
      "git",
      ["-C", GONOGO_ROOT, "ls-files", "--error-unmatch", "private/events.jsonl"],
      { encoding: "utf8" },
    );
    expect(tracked.status).not.toBe(0);
  });
});
