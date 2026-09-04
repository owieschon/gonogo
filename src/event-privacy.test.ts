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
import { createHash } from "node:crypto";
import {
  cpSync,
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
import { join, relative, resolve, sep } from "node:path";
import {
  GONOGO_ROOT,
  PRIVATE_EVENTS,
  PRIVATE_EVENTS_DIR,
  TRACKED_FIXTURE_EVENTS,
  assertWritableDestination,
  canonicalPath,
  isPublishedLocation,
  isSamePath,
  isTrackedFixtureLog,
  resolveEventDestination,
} from "./event-destination.ts";
import { EVENT_SCHEMA_VERSION, appendEvent, migrateEvent } from "./events.ts";
import type { GonogoEvent, JudgeEvent, OutcomeEvent, RaterEvent } from "./events.ts";

const SCORES = {
  task_satisfaction: 4,
  scope_discipline: 4,
  claim_verification: 4,
  goal_alignment: 4,
};

// These public records predate the subject-event destination boundary. Pinning
// their positions and bytes preserves the append-only log while preventing a
// future subject event from being normalized into accepted history.
const RETAINED_NON_FIXTURE_RECORDS = [
  [22, "75bda64388c44899d18abd6c3243a0387770c2fee2a8c398a0a64e7c8a3ecd13"],
  [23, "458d6fb2b1dd40f24a7dd6fabb31522ee57bec76d4a2f5c6130a9057dcc6ac5c"],
  [24, "17e90b21bb0177a7c7d2705e16e08796164c14283c74daf60c5b8255d4c82498"],
  [25, "7a3608b41c611112a45f453e145ebdf00d484b1fcf794c3faea17e64887cf26d"],
  [89, "b8aa802d9916b7f311ce2300a0f02f8fbd0e9dae5301176a12235e544e3dc276"],
  [258, "80b743cb0e9f04e0bfdfcdaded367f81e94f6cfa1888acd70b54ba67af20035c"],
  [280, "a0b5fe21821adc1e244e634fee7f8c7030288cd0b00a1c998a32c59038e548e0"],
  [615, "2bcc6c6cd74614ed665867c4155fa166927133bef57d0acc1ce4971e882ece2f"],
  [616, "d5d78fedd0a5063365e2024aa36272684523960321d2d818bfb5f315bcdb43fb"],
  [680, "deecb57abcef432f9a3c0375a09d58d56920ea2520e296ce55ea9193c090b703"],
] as const;

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
  test("the only non-fixture records are the retained public history", () => {
    const records = readFileSync(TRACKED_FIXTURE_EVENTS, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line, index) => ({
        kind: migrateEvent(JSON.parse(line)).kind,
        line: index + 1,
        sha256: createHash("sha256").update(line).digest("hex"),
      }))
      .filter((record) => record.kind !== "fixture")
      .map(({ line, sha256 }) => [line, sha256] as const);

    expect(records).toEqual([...RETAINED_NON_FIXTURE_RECORDS]);
  });

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

describe("a symlink and .. cannot smuggle a subject event into the tracked log", () => {
  /**
   * The bypass this describe block exists for, reproduced against 07ec4e5a:
   *
   *   ln -s <checkout>/private /tmp/escape
   *   gonogo judge ... --events /tmp/escape/../events.jsonl
   *
   * `path.resolve` collapses `..` before following any symlink, so the boundary
   * read that destination as `/tmp/events.jsonl` — outside the checkout, allowed
   * — while `open(2)` followed the symlink first and appended a `real` event to
   * the committed `events.jsonl` at the checkout root.
   */
  function escapeLink(dir: string, target: string): string {
    const link = join(dir, "escape");
    symlinkSync(target, link);
    return link;
  }

  test("the lexical spelling and the real destination disagree", () => {
    inTemp((dir) => {
      mkdirSync(PRIVATE_EVENTS_DIR, { recursive: true });
      const bypass = `${escapeLink(dir, PRIVATE_EVENTS_DIR)}${sep}..${sep}events.jsonl`;
      // What a lexical normalizer sees: a file in the temp directory.
      expect(resolve(bypass)).toBe(join(dir, "events.jsonl"));
      // What the kernel sees, and what the boundary must therefore see.
      expect(canonicalPath(bypass)).toBe(canonicalPath(TRACKED_FIXTURE_EVENTS));
    });
  });

  for (const [name, make] of SUBJECT_EVENTS) {
    test(`a ${name} event through the bypass is refused and appends nothing`, () => {
      inTemp((dir) => {
        mkdirSync(PRIVATE_EVENTS_DIR, { recursive: true });
        const bypass = `${escapeLink(dir, PRIVATE_EVENTS_DIR)}${sep}..${sep}events.jsonl`;
        expect(isTrackedFixtureLog(bypass)).toBe(true);
        let thrown = "";
        const before = snapshot();
        try {
          appendEvent(bypass, make());
        } catch (error) {
          thrown = error instanceof Error ? error.message : String(error);
        }
        expect(thrown).toContain("refusing to write");
        expect(thrown).toContain("the tracked fixture event log");
        // The message names the file that would really have been written, not
        // the spelling that was typed.
        expect(thrown).toContain(canonicalPath(TRACKED_FIXTURE_EVENTS));
        expect(snapshot()).toEqual(before);
        // Nothing was created at the lexical spelling either.
        expect(existsSync(join(dir, "events.jsonl"))).toBe(false);
      });
    });
  }

  test("the same bypass aimed at another public path in the checkout is refused", () => {
    inTemp((dir) => {
      mkdirSync(PRIVATE_EVENTS_DIR, { recursive: true });
      const link = escapeLink(dir, PRIVATE_EVENTS_DIR);
      const bypass = `${link}${sep}..${sep}calibration${sep}events.jsonl`;
      expect(isPublishedLocation(bypass)).toBe(true);
      expectRejected(
        () => appendEvent(bypass, judgeEvent("real")),
        "a public location inside the gonogo checkout",
      );
      expect(existsSync(join(GONOGO_ROOT, "calibration", "events.jsonl"))).toBe(false);
    });
  });

  test("a symlinked directory whose .. leaves the checkout is still allowed", () => {
    // The boundary is a location, not a ban on symlinks: resolving correctly
    // must not start refusing destinations the operator legitimately owns.
    inTemp((dir) => {
      const outside = join(dir, "outside");
      mkdirSync(join(outside, "logs"), { recursive: true });
      const link = escapeLink(dir, join(outside, "logs"));
      const path = `${link}${sep}..${sep}events.jsonl`;
      expect(canonicalPath(path)).toBe(canonicalPath(join(outside, "events.jsonl")));
      appendEvent(path, judgeEvent("real"));
      expect(readFileSync(join(outside, "events.jsonl"), "utf8")).toContain('"kind":"real"');
    });
  });
});

describe("a dangling final symlink cannot smuggle a subject event into the checkout", () => {
  /**
   * The second bypass, reproduced against `2b57307`:
   *
   *   ln -s <checkout>/calibration/leaked-events.jsonl /tmp/dangling
   *   gonogo judge ... --events /tmp/dangling
   *
   * `realpath` fails on a symlink whose target does not exist, so the walk kept
   * the link's own spelling — outside the checkout, allowed — while
   * `appendFileSync` followed the link and created its target inside the public
   * checkout. A link is only dangling until the first write; after that the
   * file it made is committed at the next `git add`.
   */
  const PUBLIC_TARGET = join(GONOGO_ROOT, "calibration", "leaked-events.jsonl");

  function withDanglingLink(target: string, fn: (link: string) => void): void {
    inTemp((dir) => {
      const link = join(dir, "dangling");
      symlinkSync(target, link);
      expect(existsSync(target)).toBe(false);
      fn(link);
    });
  }

  test("the link's own spelling and the file it would create disagree", () => {
    withDanglingLink(PUBLIC_TARGET, (link) => {
      expect(canonicalPath(link)).not.toBe(link);
      expect(canonicalPath(link)).toBe(canonicalPath(PUBLIC_TARGET));
      expect(isPublishedLocation(link)).toBe(true);
    });
  });

  for (const [name, make] of SUBJECT_EVENTS) {
    test(`a ${name} event through a dangling link into the checkout is refused`, () => {
      try {
        withDanglingLink(PUBLIC_TARGET, (link) => {
          expectRejected(
            () => appendEvent(link, make()),
            "a public location inside the gonogo checkout",
          );
          // The whole point: nothing was created at the link's target.
          expect(existsSync(PUBLIC_TARGET)).toBe(false);
        });
      } finally {
        rmSync(PUBLIC_TARGET, { force: true });
      }
    });
  }

  test("a dangling link whose relative target climbs into the checkout is refused", () => {
    // The target is read as written and walked component by component, so a
    // `..` inside it is applied to the resolved prefix like any other.
    try {
      inTemp((dir) => {
        const link = join(dir, "dangling");
        // Relative to the link's own directory, resolved, so the `..` count
        // is the one the kernel will apply.
        symlinkSync(relative(canonicalPath(dir), PUBLIC_TARGET), link);
        expect(canonicalPath(link)).toBe(canonicalPath(PUBLIC_TARGET));
        expectRejected(
          () => appendEvent(link, judgeEvent("real")),
          "a public location inside the gonogo checkout",
        );
        expect(existsSync(PUBLIC_TARGET)).toBe(false);
      });
    } finally {
      rmSync(PUBLIC_TARGET, { force: true });
    }
  });

  test("a dangling link pointing outside the checkout is still allowed", () => {
    // A location boundary, not a ban on dangling links: the operator named a
    // path they own, and the event lands at the file the link really names.
    inTemp((dir) => {
      const target = join(dir, "nested", "events.jsonl");
      const link = join(dir, "dangling");
      symlinkSync(target, link);

      const validated = resolveEventDestination(link, "real");
      expect(validated).toBe(canonicalPath(target));
      expect(existsSync(validated)).toBe(false);

      appendEvent(link, judgeEvent("real"));

      expect(readFileSync(validated, "utf8").trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(readFileSync(validated, "utf8")).kind).toBe("real");
    });
  });

  test("a symlink loop is refused rather than resolved to its own spelling", () => {
    // Neither link ever resolves, so falling back to the lexical form would
    // hand the boundary a path that names no file.
    inTemp((dir) => {
      symlinkSync(join(dir, "b"), join(dir, "a"));
      symlinkSync(join(dir, "a"), join(dir, "b"));
      expect(() => canonicalPath(join(dir, "a"))).toThrow("too many symbolic links");
      expect(() => appendEvent(join(dir, "a"), judgeEvent("real"))).toThrow(
        "too many symbolic links",
      );
    });
  });
});

describe("the checked file is the written file", () => {
  test("normalizing an already-normalized destination changes nothing", () => {
    // `appendEvent` and the CLI each normalize the same `--events` value. They
    // agree only because normalization is idempotent.
    inTemp((dir) => {
      const once = canonicalPath(join(dir, "a", "b", "events.jsonl"));
      expect(canonicalPath(once)).toBe(once);
      expect(isSamePath(once, join(dir, "a", "b", "events.jsonl"))).toBe(true);
    });
  });

  test("an allowed write lands at exactly the destination that was validated", () => {
    inTemp((dir) => {
      // A symlinked directory outside the checkout, with the last two path
      // components not yet created: the existence check, the mkdir and the
      // append must all use the destination the boundary approved.
      const target = join(dir, "target");
      mkdirSync(target, { recursive: true });
      const link = join(dir, "link");
      symlinkSync(target, link);
      const asked = join(link, "nested", "events.jsonl");

      const validated = resolveEventDestination(asked, "real");
      expect(validated).toBe(canonicalPath(join(target, "nested", "events.jsonl")));
      expect(existsSync(validated)).toBe(false);

      appendEvent(asked, judgeEvent("real"));

      expect(readFileSync(validated, "utf8").trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(readFileSync(validated, "utf8")).kind).toBe("real");
    });
  });

  test("the duplicate-run check reads the destination that was validated", () => {
    inTemp((dir) => {
      // Reading one file and appending to another would let a duplicate run_id
      // through. Through a symlink, both must be the same file.
      const target = join(dir, "target");
      mkdirSync(target, { recursive: true });
      const link = join(dir, "link");
      symlinkSync(target, link);
      appendEvent(join(target, "events.jsonl"), judgeEvent("real"));
      expect(() => appendEvent(join(link, "events.jsonl"), judgeEvent("real"))).toThrow(
        'judge run_id "run-real" already exists',
      );
      expect(readFileSync(join(target, "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    });
  });
});

describe("the CLI defaults route subject events to the private log", () => {
  /**
   * These run against a stand-in checkout so the default destination is inside
   * a temporary directory. Asserting on the real `private/events.jsonl` would
   * mean writing test events into the operator's own log.
   */
  function inTempCheckout(fn: (checkout: string) => void): void {
    const checkout = mkdtempSync(join(tmpdir(), "gonogo-default-route-"));
    try {
      cpSync(join(GONOGO_ROOT, "src"), join(checkout, "src"), { recursive: true });
      cpSync(join(GONOGO_ROOT, "package.json"), join(checkout, "package.json"));
      // The tracked fixture log of the stand-in checkout, empty and watched.
      writeFileSync(join(checkout, "events.jsonl"), "");
      fn(checkout);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  }

  function run(checkout: string, args: string[], cwd = checkout) {
    const result = spawnSync("bun", ["run", join(checkout, "src", "cli.ts"), ...args], {
      encoding: "utf8",
      cwd,
    });
    return { status: result.status, stderr: result.stderr, stdout: result.stdout };
  }

  const privateLogOf = (checkout: string) => join(checkout, "private", "events.jsonl");

  test("outcome with no --events writes the private log and not the tracked log", () => {
    inTempCheckout((checkout) => {
      const result = run(checkout, [
        "outcome", "--task", "t", "--pr", "https://example.invalid/pr/1", "--state", "closed",
      ]);
      expect(result.status).toBe(0);
      expect(readFileSync(privateLogOf(checkout), "utf8")).toContain('"kind":"outcome"');
      expect(readFileSync(join(checkout, "events.jsonl"), "utf8")).toBe("");
      // The path it reports is the path it wrote.
      expect(result.stdout).toContain(canonicalPath(privateLogOf(checkout)));
    });
  });

  test("outcome with no --events refuses a run id the private log does not hold", () => {
    inTempCheckout((checkout) => {
      const result = run(checkout, [
        "outcome", "--task", "t", "--pr", "https://example.invalid/pr/1",
        "--state", "closed", "--run", "no-such-run",
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain(canonicalPath(privateLogOf(checkout)));
      expect(existsSync(privateLogOf(checkout))).toBe(false);
    });
  });

  test("judge with no --events reads and would write the private log", () => {
    inTempCheckout((checkout) => {
      // Seeded only in the private log. The collision proves which file the
      // default destination named, before any evidence or judge call.
      mkdirSync(join(checkout, "private"), { recursive: true });
      writeFileSync(privateLogOf(checkout), JSON.stringify(judgeEvent("real")) + "\n");
      const result = run(checkout, [
        "judge", "--spec", "do the thing", "--repo", join(checkout, "no-such-repo"),
        "--run", "run-real",
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).toContain('judge run_id "run-real" already exists in');
      expect(result.stderr).toContain(canonicalPath(privateLogOf(checkout)));
      expect(result.stderr).not.toContain("not a git repository");
      expect(readFileSync(join(checkout, "events.jsonl"), "utf8")).toBe("");
    });
  });

  test("judge with no --events is not refused by the boundary", () => {
    inTempCheckout((checkout) => {
      // The default destination is permitted, so the run proceeds far enough to
      // fail on the subject repository instead.
      const result = run(checkout, [
        "judge", "--spec", "do the thing", "--repo", join(checkout, "no-such-repo"),
      ]);
      expect(result.status).toBe(3);
      expect(result.stderr).not.toContain("refusing to write");
      expect(result.stderr).toContain("not a git repository");
    });
  });

  test("eval with no --events keeps the tracked fixture log as its default", () => {
    inTempCheckout((checkout) => {
      // Nothing is swept here; --only names no fixture, so eval fails on the
      // fixtures directory. What matters is that the tracked default is not
      // refused for a fixture sweep.
      const result = run(checkout, ["eval", "--replay", "--only", "no-such-fixture"]);
      expect(result.stderr).not.toContain("refusing to write");
    });
  });

  test("the calibrate hint compares paths canonically, not textually", () => {
    inTempCheckout((checkout) => {
      const ratings = join(checkout, "ratings");
      mkdirSync(ratings, { recursive: true });
      mkdirSync(join(checkout, "private"), { recursive: true });
      writeFileSync(privateLogOf(checkout), "");
      // A symlink to private/: a different string, the same file.
      symlinkSync(join(checkout, "private"), join(checkout, "plink"));

      const withDefault = run(checkout, ["calibrate", "--dir", ratings]);
      expect(withDefault.stdout).toContain("A private event log exists");

      const throughLink = run(checkout, [
        "calibrate", "--dir", ratings, "--events", join(checkout, "plink", "events.jsonl"),
      ]);
      // It is already reading the private log; telling it to include the
      // private log would be wrong.
      expect(throughLink.stdout).not.toContain("A private event log exists");
    });
  });
});
