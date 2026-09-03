/**
 * Rater provenance: who wrote a rating, recorded explicitly and never inferred.
 *
 * The failure this file exists to prevent is a specific one. gonogo's two
 * committed manual reviews were written by language models. Nothing in a
 * reviewer id distinguishes them from a person's review, so before `rater_kind`
 * existed `calibrate` printed both under "human ratings". Publishing that as
 * judge-versus-human calibration would be a false claim about the only number
 * this project treats as trust currency.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCalibrate } from "./calibrate.ts";
import { EVENT_SCHEMA_VERSION, appendEvent, migrateEvent } from "./events.ts";
import type { RaterEvent } from "./events.ts";
import { RATER_KINDS, UNDECLARED_RATER_KIND, isRaterKind } from "./types.ts";
import type { ManualRatingFile } from "./types.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SCORES = {
  task_satisfaction: 4,
  scope_discipline: 4,
  claim_verification: 4,
  goal_alignment: 4,
};

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-rater-kind-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function raterEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    ts: "2026-09-02T00:00:00Z",
    kind: "rater",
    gonogo_version: "0.1.6",
    run_id: "run-001",
    rater_id: "owen",
    rater_kind: "human",
    scores: { ...SCORES },
    review_minutes: null,
    notes: null,
    ...overrides,
  };
}

function judgeEvent(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    ts: "2026-09-02T00:00:00Z",
    kind: "real",
    gonogo_version: "0.1.6",
    run_id: runId,
    fixture_id: null,
    task_id: null,
    workspace_id: null,
    backend: "claude-cli",
    model_version: "claude-sonnet-5",
    prompt_hashes: { "prompts/rubric-pass.md": "a".repeat(64) },
    subject_hash: "b".repeat(64),
    evidence_hash: "c".repeat(64),
    rater_id: "judge:claude-cli",
    scores: { ...SCORES },
    confidence: 0.9,
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
    ...overrides,
  };
}

function writeEvents(path: string, events: Record<string, unknown>[]): void {
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

describe("rater kind in the event log", () => {
  test("a legacy rater event migrates to undeclared, never to human", () => {
    const { rater_kind: _absent, ...v4 } = raterEvent({ schema_version: 4 });
    const migrated = migrateEvent(v4) as RaterEvent;
    expect(migrated.schema_version).toBe(EVENT_SCHEMA_VERSION);
    expect(migrated.rater_kind).toBe(UNDECLARED_RATER_KIND);
  });

  test("a legacy rater event that declared itself synthetic migrates to synthetic", () => {
    const { rater_kind: _absent, ...v4 } = raterEvent({ schema_version: 4, synthetic: true });
    expect((migrateEvent(v4) as RaterEvent).rater_kind).toBe("synthetic");
  });

  test("a legacy rater event cannot smuggle a rater kind in through migration", () => {
    const v4 = raterEvent({ schema_version: 4, rater_kind: "human" });
    expect((migrateEvent(v4) as RaterEvent).rater_kind).toBe(UNDECLARED_RATER_KIND);
  });

  test("a current rater event must declare a known rater kind", () => {
    const { rater_kind: _absent, ...missing } = raterEvent();
    expect(() => migrateEvent(missing)).toThrow("rater.rater_kind");
    expect(() => migrateEvent(raterEvent({ rater_kind: "person" }))).toThrow("rater.rater_kind");
    expect(() => migrateEvent(raterEvent({ rater_kind: null }))).toThrow("rater.rater_kind");
  });

  test("synthetic and rater_kind may not contradict each other", () => {
    expect(() => migrateEvent(raterEvent({ rater_kind: "human", synthetic: true }))).toThrow(
      'rater.synthetic true requires rater.rater_kind "synthetic"',
    );
    expect(() => migrateEvent(raterEvent({ rater_kind: "synthetic" }))).toThrow(
      'rater.rater_kind "synthetic" requires rater.synthetic true',
    );
    expect(
      (migrateEvent(raterEvent({ rater_kind: "synthetic", synthetic: true })) as RaterEvent).rater_kind,
    ).toBe("synthetic");
  });

  test("a newly appended rating may not be recorded as undeclared", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      expect(() =>
        appendEvent(path, raterEvent({ rater_kind: UNDECLARED_RATER_KIND }) as unknown as RaterEvent),
      ).toThrow("must declare rater_kind");
      expect(existsSync(path)).toBe(false);
      appendEvent(path, raterEvent({ rater_kind: "llm", rater_id: "claude-code" }) as unknown as RaterEvent);
      expect(readFileSync(path, "utf8")).toContain('"rater_kind":"llm"');
    });
  });
});

describe("rater kind in agreement", () => {
  test("an LLM rating paired with a judge run is not human calibration", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeEvents(path, [
        judgeEvent("run-001"),
        raterEvent({ rater_id: "claude-code-uhg22r", rater_kind: "llm" }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("judge-vs-human calibration pairs: 0");
      expect(output).toContain("machine vs machine (not human calibration)");
      expect(output).toContain("judge:claude-cli [LLM] vs claude-code-uhg22r [LLM]");
      expect(output).not.toContain("[human]");
      expect(output).toContain("1 comparison(s), 1 real, 0 of them judge-vs-human");
    });
  });

  test("a declared human rating paired with a judge run is counted once", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeEvents(path, [judgeEvent("run-001"), raterEvent()]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("judge-vs-human calibration pairs: 1");
      expect(output).toContain("comparison: judge vs human (calibration)");
      expect(output).not.toContain("uncalibrated against human review");
    });
  });

  test("a legacy undeclared rating is excluded from every figure and said so", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      const { rater_kind: _absent, ...legacy } = raterEvent({ schema_version: 4 });
      writeEvents(path, [judgeEvent("run-001"), legacy]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("judge-vs-human calibration pairs: 0");
      expect(output).toContain("pairs excluded for an undeclared rater kind: 1");
      expect(output).toContain("pairs excluded because a rater kind was never declared");
      expect(output).toContain("judge:claude-cli [LLM] vs owen [undeclared]");
      expect(output).toContain("0 comparison(s), 0 of them judge-vs-human");
      // No table may be built out of a rating whose author was never recorded.
      expect(output).not.toContain("mean gap");
    });
  });

  test("the same rater may not be human in one record and a model in another", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      const runDir = join(dir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "human.json"),
        JSON.stringify({
          schema: "gonogo/human@1",
          run_id: "run-001",
          reviewer: "owen",
          rater_kind: "llm",
          recorded_at: "2026-09-02T00:00:00Z",
          dimensions: { ...SCORES },
        }),
      );
      writeEvents(path, [raterEvent()]);
      expect(() => runCalibrate({ eventsPath: path, dirs: [join(dir, "runs")] })).toThrow(
        "Conflicting ratings",
      );
    });
  });

  test("a manual rating file must declare a known kind consistent with synthetic", () => {
    inTemp((dir) => {
      const runDir = join(dir, "runs", "run-001");
      mkdirSync(runDir, { recursive: true });
      const write = (rating: Record<string, unknown>) =>
        writeFileSync(join(runDir, "human.json"), JSON.stringify(rating));
      const base = {
        schema: "gonogo/human@1",
        run_id: "run-001",
        reviewer: "owen",
        recorded_at: "2026-09-02T00:00:00Z",
        dimensions: { ...SCORES },
      };
      const run = () => runCalibrate({ eventsPath: join(dir, "none.jsonl"), dirs: [join(dir, "runs")] });

      write({ ...base, rater_kind: "reviewer" });
      expect(run).toThrow("rater_kind must be one of");
      write({ ...base, rater_kind: "human", synthetic: true });
      expect(run).toThrow("disagree about who wrote this rating");
      // Absent is legal and means undeclared; it is listed, never counted.
      write(base);
      expect(run()).toContain("no declared rater kind");
    });
  });
});

/**
 * The two committed manual reviews were written by language models. This block
 * is the rule that keeps them out of human calibration: re-keying either file
 * to `human` fails here, and their provenance — reviewer handle, timestamp,
 * notes — stays exactly as recorded.
 */
describe("this repository's committed calibration records", () => {
  const AI_WRITTEN_REVIEWS: Record<string, string> = {
    "calibration/manual-pr-1/human.json": "codex",
    "calibration/manual-pr-2/human.json": "claude-code-uhg22r",
  };

  function ratingFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...ratingFiles(path));
      else if (entry.name === "human.json") out.push(path);
    }
    return out;
  }

  test("every committed manual rating declares who wrote it", () => {
    const files = ratingFiles(join(ROOT, "calibration"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const rating = JSON.parse(readFileSync(file, "utf8")) as ManualRatingFile;
      expect(isRaterKind(rating.rater_kind)).toBe(true);
      expect(RATER_KINDS).toContain(rating.rater_kind!);
    }
  });

  test("the AI-written reviews stay classified as LLM ratings with their provenance", () => {
    for (const [relative, reviewer] of Object.entries(AI_WRITTEN_REVIEWS)) {
      const rating = JSON.parse(readFileSync(join(ROOT, relative), "utf8")) as ManualRatingFile;
      expect(rating.rater_kind).toBe("llm");
      expect(rating.reviewer).toBe(reviewer);
      expect(rating.notes && rating.notes.length).toBeGreaterThan(0);
      expect(rating.synthetic).toBeUndefined();
    }
  });

  test("calibrate reports the human pair count this repository's records support", () => {
    const humanPairs = ratingFiles(join(ROOT, "calibration")).filter((file) => {
      const rating = JSON.parse(readFileSync(file, "utf8")) as ManualRatingFile;
      return rating.rater_kind === "human" && existsSync(join(dirname(file), "verdict.json"));
    }).length;
    const output = runCalibrate({
      eventsPath: join(ROOT, "events.jsonl"),
      dirs: [join(ROOT, "calibration")],
    });
    expect(output).toContain(`judge-vs-human calibration pairs: ${humanPairs}`);
    expect(output).toContain("LLM-written ratings with nothing to compare against");
    expect(output).not.toMatch(/^human ratings with nothing to compare against$/m);
  });
});

/**
 * The classification boundary itself. Two ways a pair was misreported before
 * this block existed: a human rating beside an LLM review with no judge run
 * was counted as judge-versus-human calibration, and a pair holding an
 * undeclared rating escaped exclusion whenever the other side was synthetic.
 * Both are false statements about provenance, so both are pinned here along
 * with the report branches that read the same classification.
 */
describe("pair classification boundary", () => {
  test("a human rating beside an LLM review with no judge run is not calibration", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeEvents(path, [
        raterEvent({ rater_id: "owen", rater_kind: "human" }),
        raterEvent({ rater_id: "claude-code-uhg22r", rater_kind: "llm" }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("judge-vs-human calibration pairs: 0");
      expect(output).toContain("human vs LLM review, no judge run (not calibration) pairs: 1");
      expect(output).toContain("uncalibrated against human review");
      expect(output).toContain(
        "comparison: human vs LLM review, no judge run (not calibration)",
      );
      expect(output).not.toContain("judge vs human (calibration)");
      expect(output).toContain("1 comparison(s), 1 real, 0 of them judge-vs-human");
    });
  });

  test("the same pair read from a rating directory is classified the same way", () => {
    inTemp((dir) => {
      const runDir = join(dir, "calibration", "manual-pr-9");
      mkdirSync(runDir, { recursive: true });
      writeFileSync(
        join(runDir, "human.json"),
        JSON.stringify({
          schema: "gonogo/human@1",
          run_id: "run-001",
          reviewer: "codex",
          rater_kind: "llm",
          recorded_at: "2026-09-02T00:00:00Z",
          dimensions: { ...SCORES },
        }),
      );
      const path = join(dir, "events.jsonl");
      writeEvents(path, [raterEvent({ run_id: "run-001", rater_id: "owen" })]);
      const output = runCalibrate({ eventsPath: path, dirs: [join(dir, "calibration")] });
      expect(output).toContain("judge-vs-human calibration pairs: 0");
      expect(output).toContain("human vs LLM review, no judge run (not calibration) pairs: 1");
    });
  });

  test("a judge run still makes a declared human rating calibration", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeEvents(path, [
        judgeEvent("run-001"),
        raterEvent({ rater_id: "owen", rater_kind: "human" }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("judge-vs-human calibration pairs: 1");
      expect(output).not.toContain("human vs LLM review");
    });
  });

  test("an undeclared rating is excluded even when the other side is synthetic", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      const { rater_kind: _absent, ...legacy } = raterEvent({
        schema_version: 4,
        run_id: "run-001",
        rater_id: "legacy-reviewer",
      });
      writeEvents(path, [
        legacy,
        raterEvent({
          run_id: "run-001",
          rater_id: "synthetic-demo",
          rater_kind: "synthetic",
          synthetic: true,
        }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("pairs excluded for an undeclared rater kind: 1");
      expect(output).toContain("pairs excluded because a rater kind was never declared");
      expect(output).toContain("synthetic-demo [synthetic] vs legacy-reviewer [undeclared]");
      expect(output).toContain("No comparison remains after excluding pairs");
      // The pair must not be scored as synthetic demo data instead.
      expect(output).not.toContain("SYNTHETIC DATA ONLY");
      expect(output).not.toContain("mean gap");
      expect(output).toContain("0 comparison(s), 0 of them judge-vs-human");
    });
  });

  test("a legacy rating that declared itself synthetic is not undeclared", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      const { rater_kind: _absent, ...legacy } = raterEvent({
        schema_version: 4,
        run_id: "run-001",
        rater_id: "legacy-demo",
        synthetic: true,
      });
      writeEvents(path, [
        legacy,
        raterEvent({
          run_id: "run-001",
          rater_id: "synthetic-demo",
          rater_kind: "synthetic",
          synthetic: true,
        }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("SYNTHETIC DATA ONLY");
      expect(output).not.toContain("undeclared");
    });
  });

  test("the synthetic banner reports a real human rating that forms no judge pair", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeEvents(path, [
        raterEvent({ run_id: "run-s", rater_id: "demo-a", rater_kind: "synthetic", synthetic: true }),
        raterEvent({ run_id: "run-s", rater_id: "demo-b", rater_kind: "synthetic", synthetic: true }),
        raterEvent({ run_id: "run-h", rater_id: "owen", rater_kind: "human" }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("SYNTHETIC DATA ONLY");
      expect(output).toContain("Real human ratings exist, but none forms a same-evidence judge pair.");
      expect(output).toContain("human ratings with nothing to compare against");
      expect(output).toContain("judge-vs-human calibration pairs: 0");
    });
  });

  test("the synthetic banner says so when no human has rated a real run", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      writeEvents(path, [
        raterEvent({ run_id: "run-s", rater_id: "demo-a", rater_kind: "synthetic", synthetic: true }),
        raterEvent({ run_id: "run-s", rater_id: "demo-b", rater_kind: "synthetic", synthetic: true }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("No human has reviewed a real gonogo run yet.");
      expect(output).not.toContain("Real human ratings exist");
    });
  });

  test("the synthetic banner counts excluded undeclared pairs without calling them real", () => {
    inTemp((dir) => {
      const path = join(dir, "events.jsonl");
      const { rater_kind: _absent, ...legacy } = raterEvent({
        schema_version: 4,
        run_id: "run-u",
        rater_id: "legacy-reviewer",
      });
      writeEvents(path, [
        raterEvent({ run_id: "run-s", rater_id: "demo-a", rater_kind: "synthetic", synthetic: true }),
        raterEvent({ run_id: "run-s", rater_id: "demo-b", rater_kind: "synthetic", synthetic: true }),
        legacy,
        raterEvent({ run_id: "run-u", rater_id: "claude-code-uhg22r", rater_kind: "llm" }),
      ]);
      const output = runCalibrate({ eventsPath: path, dirs: [] });
      expect(output).toContain("SYNTHETIC DATA ONLY");
      expect(output).toContain(
        "1 further pair(s) carry an undeclared rater kind and are excluded.",
      );
      expect(output).not.toContain("real pair(s) exist");
    });
  });
});
