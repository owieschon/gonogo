import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCalibrate } from "./calibrate.ts";
import { EVENT_SCHEMA_VERSION } from "./events.ts";

const SCORES = {
  task_satisfaction: 4,
  scope_discipline: 4,
  claim_verification: 4,
  goal_alignment: 4,
};

function inTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-calibrate-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function verdict(promptHash = "prompt-v1", runId?: string): Record<string, unknown> {
  const dimension = (score: number) => ({ score, citations: ["evidence"], reasoning: "r" });
  return {
    schema: "gonogo/verdict@1",
    ...(runId === undefined ? {} : { run_id: runId }),
    verdict: "go",
    overall_score: 4,
    dimensions: {
      task_satisfaction: dimension(4),
      scope_discipline: dimension(4),
      claim_verification: dimension(4),
      goal_alignment: dimension(4),
    },
    provenance: {
      gonogo_version: "0.1.0",
      judge_backend: "claude-cli",
      model_version: "claude-sonnet-5",
      prompt_files: [{ path: "prompts/rubric-pass.md", sha256: promptHash }],
    },
  };
}

function human(runId: string): Record<string, unknown> {
  return {
    schema: "gonogo/human@1",
    run_id: runId,
    reviewer: "human:owen",
    rater_kind: "human",
    recorded_at: "2026-08-31T00:00:00Z",
    dimensions: { ...SCORES },
  };
}

function writeRun(root: string, folder: string, humanRunId = folder, verdictRunId?: string): void {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "verdict.json"), JSON.stringify(verdict("prompt-v1", verdictRunId)));
  writeFileSync(join(dir, "human.json"), JSON.stringify(human(humanRunId)));
}

function judge(runId: string, promptHash: string, scores = SCORES): Record<string, unknown> {
  return {
    schema_version: 2,
    ts: "2026-08-31T00:00:00Z",
    kind: "real",
    gonogo_version: "0.1.0",
    run_id: runId,
    fixture_id: null,
    task_id: null,
    workspace_id: null,
    backend: "claude-cli",
    model_version: "claude-sonnet-5",
    prompt_hashes: { "prompts/rubric-pass.md": promptHash },
    evidence_hash: "evidence-v1",
    rater_id: "judge:claude-cli",
    scores: { ...scores },
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
    replay: false,
  };
}

function rater(runId: string): Record<string, unknown> {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    ts: "2026-08-31T00:01:00Z",
    kind: "rater",
    gonogo_version: "0.1.0",
    run_id: runId,
    rater_id: "human:owen",
    rater_kind: "human",
    scores: { ...SCORES },
  };
}

function writeEvents(path: string, events: Record<string, unknown>[]): void {
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

const REPAIR_PROMPT_HASHES = {
  "prompts/blind-pass.md": "1".repeat(64),
  "prompts/rubric-pass.md": "2".repeat(64),
  "prompts/rubric-pass.schema.json": "3".repeat(64),
  "prompts/citation-repair.md": "4".repeat(64),
  "prompts/citation-repair.schema.json": "5".repeat(64),
};

function v3Judge(runId: string, repair: Record<string, unknown> | null): Record<string, unknown> {
  return {
    ...judge(runId, "unused"),
    schema_version: 3,
    prompt_hashes: { ...REPAIR_PROMPT_HASHES },
    citation_repair: repair,
  };
}

function repair(source: "live" | "cache" = "live"): Record<string, unknown> {
  return {
    source,
    prompt_sha256: "a".repeat(64),
    evidence_sha256: "b".repeat(64),
    receipt_sha256: "c".repeat(64),
    requested_dimensions: ["task_satisfaction"],
    repaired_dimensions: ["task_satisfaction"],
    abstained_dimensions: [],
  };
}

test("discovers a legacy directory pair and reports its instrument", () => {
  inTemp((dir) => {
    const runs = join(dir, "runs");
    writeRun(runs, "run-001");

    const output = runCalibrate({ eventsPath: join(dir, "missing.jsonl"), dirs: [runs] });

    expect(output).toContain(
      "instrument: gonogo=0.1.0; backend=claude-cli; model=claude-sonnet-5",
    );
    expect(output).toContain("prompts/rubric-pass.md=prompt-v1");
    expect(output).toContain("rater pair: judge:claude-cli [LLM] vs human:owen [human]   (1 run)");
    expect(output).toContain("1 comparison(s), 1 real, 1 of them judge-vs-human");
  });
});

test("accepts an explicit artifact run_id that differs from its directory name", () => {
  inTemp((dir) => {
    const runs = join(dir, "runs");
    writeRun(runs, "timestamp-folder", "custom-run", "custom-run");

    const output = runCalibrate({ eventsPath: join(dir, "missing.jsonl"), dirs: [runs] });

    expect(output).toContain("1 comparison(s), 1 real, 1 of them judge-vs-human");
    expect(output).toContain("custom-run");
  });
});

test("excludes replayed and mixed-cache directory verdicts from calibration", () => {
  inTemp((dir) => {
    const runs = join(dir, "runs");
    for (const [folder, provenance] of [
      ["replayed", { replayed: true }],
      ["mixed", { pass_sources: { blind: "live", rubric: "cache" } }],
    ] as const) {
      writeRun(runs, folder);
      const path = join(runs, folder, "verdict.json");
      const artifact = JSON.parse(readFileSync(path, "utf8"));
      Object.assign(artifact.provenance, provenance);
      writeFileSync(path, JSON.stringify(artifact));
    }

    const output = runCalibrate({ eventsPath: join(dir, "missing.jsonl"), dirs: [runs] });

    expect(output).toContain("No double-scored runs found.");
    expect(output).toContain("2 run(s) carry exactly one rating");
    expect(output).toContain("human ratings with nothing to compare against");
    expect(output).not.toContain("1 comparison(s)");
  });
});

test("reports a nested standalone human review without treating it as agreement", () => {
  inTemp((dir) => {
    const reviewDir = join(dir, "calibration", "manual", "pr-1");
    mkdirSync(reviewDir, { recursive: true });
    const rating = human("manual-pr-1") as any;
    rating.notes = "Retrospective review; not a same-evidence calibration pair.";
    writeFileSync(join(reviewDir, "human.json"), JSON.stringify(rating));

    const output = runCalibrate({
      eventsPath: join(dir, "missing.jsonl"),
      dirs: [join(dir, "calibration")],
    });

    expect(output).toContain("No double-scored runs found.");
    expect(output).toContain("manual-pr-1  by human:owen");
    expect(output).toContain("Retrospective review; not a same-evidence calibration pair.");
    expect(output).not.toContain("comparison(s)");
  });
});

test("rejects a human run_id that does not match the verdict artifact", () => {
  inTemp((dir) => {
    const runs = join(dir, "runs");
    writeRun(runs, "artifact-id", "different-id", "artifact-id");

    expect(() =>
      runCalibrate({ eventsPath: join(dir, "missing.jsonl"), dirs: [runs] }),
    ).toThrow('human run_id "different-id" does not match artifact "artifact-id"');
  });
});

test("rejects a legacy human run_id that does not match its directory", () => {
  inTemp((dir) => {
    const runs = join(dir, "runs");
    writeRun(runs, "folder-id", "different-id");

    expect(() =>
      runCalibrate({ eventsPath: join(dir, "missing.jsonl"), dirs: [runs] }),
    ).toThrow('human run_id "different-id" does not match artifact "folder-id"');
  });
});

test("rejects a human artifact with missing or unknown dimensions", () => {
  inTemp((dir) => {
    const runs = join(dir, "runs");
    const runDir = join(runs, "invalid-scores");
    mkdirSync(runDir, { recursive: true });
    const rating = human("invalid-scores") as any;
    delete rating.dimensions.goal_alignment;
    rating.dimensions.extra = 4;
    writeFileSync(join(runDir, "verdict.json"), JSON.stringify(verdict()));
    writeFileSync(join(runDir, "human.json"), JSON.stringify(rating));

    expect(() =>
      runCalibrate({ eventsPath: join(dir, "missing.jsonl"), dirs: [runs] }),
    ).toThrow("must contain exactly");
  });
});

test("partitions the same rater pair by prompt, model, and backend identity", () => {
  inTemp((dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const differentModel = judge("run-model-v2", "prompt-v1");
    differentModel.model_version = "claude-sonnet-6";
    const differentBackend = judge("run-backend-v2", "prompt-v1");
    differentBackend.backend = "claude-api";
    writeEvents(eventsPath, [
      judge("run-v1", "prompt-v1"),
      rater("run-v1"),
      judge("run-v2", "prompt-v2"),
      rater("run-v2"),
      differentModel,
      rater("run-model-v2"),
      differentBackend,
      rater("run-backend-v2"),
    ]);

    const output = runCalibrate({ eventsPath, dirs: [] });

    expect(output.match(/^instrument: /gm)).toHaveLength(4);
    expect(output.match(/rater pair: judge:claude-cli \[LLM\] vs human:owen \[human\]   \(1 run\)/g)).toHaveLength(4);
    expect(output).toContain("backend=claude-api; model=claude-sonnet-5");
    expect(output).toContain("backend=claude-cli; model=claude-sonnet-6");
    expect(output).not.toContain("(4 runs)");
  });
});

test("keeps live repair and no-repair runs in one instrument identity", () => {
  inTemp((dir) => {
    const eventsPath = join(dir, "events.jsonl");
    writeEvents(eventsPath, [
      v3Judge("no-repair", null),
      rater("no-repair"),
      v3Judge("live-repair", repair()),
      rater("live-repair"),
    ]);

    const output = runCalibrate({ eventsPath, dirs: [] });

    expect(output.match(/^instrument: /gm)).toHaveLength(1);
    expect(output).toContain("rater pair: judge:claude-cli [LLM] vs human:owen [human]   (2 runs)");
    expect(output).toContain("prompts/citation-repair.md=" + "4".repeat(64));
    expect(output).toContain("prompts/citation-repair.schema.json=" + "5".repeat(64));
  });
});

test("excludes cached and mixed repair runs through the replay boundary", () => {
  inTemp((dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const cached = v3Judge("cached-repair", repair("cache"));
    cached.replay = true;
    const mixed = v3Judge("mixed-repair", repair("live"));
    mixed.replay = true;
    writeEvents(eventsPath, [cached, rater("cached-repair"), mixed, rater("mixed-repair")]);

    const output = runCalibrate({ eventsPath, dirs: [] });

    expect(output).toContain("No double-scored runs found.");
    expect(output).toContain("2 run(s) carry exactly one rating");
    expect(output).not.toContain("comparison(s)");
  });
});

test("classifies fixture judge events as synthetic even when the rater omits the flag", () => {
  inTemp((dir) => {
    const fixture = judge("fixture-run", "prompt-v1");
    fixture.kind = "fixture";
    fixture.fixture_id = "example-fixture";
    const eventsPath = join(dir, "events.jsonl");
    writeEvents(eventsPath, [fixture, rater("fixture-run")]);

    const output = runCalibrate({ eventsPath, dirs: [] });

    expect(output).toContain("SYNTHETIC DATA ONLY");
    expect(output).toContain("1 comparison(s), all synthetic");
  });
});

test("the calibrate CLI reads the target repository event log by default", () => {
  inTemp((dir) => {
    writeEvents(join(dir, "events.jsonl"), [judge("target-run", "prompt-v1"), rater("target-run")]);

    const output = execFileSync(
      process.execPath,
      ["run", "src/cli.ts", "calibrate", "--repo", dir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("target-run");
    expect(output).toContain("1 comparison(s), 1 real, 1 of them judge-vs-human");
  });
});

test("the calibrate CLI discovers standalone reviews under the target calibration root", () => {
  inTemp((dir) => {
    const reviewDir = join(dir, "calibration", "manual-pr-1");
    mkdirSync(reviewDir, { recursive: true });
    writeFileSync(join(reviewDir, "human.json"), JSON.stringify(human("manual-pr-1")));

    const output = execFileSync(
      process.execPath,
      ["run", "src/cli.ts", "calibrate", "--repo", dir],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("manual-pr-1  by human:owen");
    expect(output).toContain("Real human ratings exist, but none forms a same-evidence judge pair.");
  });
});

test("rejects conflicting duplicate ratings", () => {
  inTemp((dir) => {
    const eventsPath = join(dir, "events.jsonl");
    const conflicting = judge("run-001", "prompt-v1", { ...SCORES, goal_alignment: 1 });
    conflicting.verdict = "no-go";
    writeEvents(eventsPath, [
      judge("run-001", "prompt-v1"),
      conflicting,
      rater("run-001"),
    ]);

    expect(() => runCalibrate({ eventsPath, dirs: [] })).toThrow(
      'Conflicting ratings for run "run-001", rater "judge:claude-cli"',
    );
  });
});

test("deduplicates byte-equivalent ratings", () => {
  inTemp((dir) => {
    const eventsPath = join(dir, "events.jsonl");
    writeEvents(eventsPath, [
      judge("run-001", "prompt-v1"),
      judge("run-001", "prompt-v1"),
      rater("run-001"),
    ]);

    const output = runCalibrate({ eventsPath, dirs: [] });
    expect(output).toContain("1 comparison(s), 1 real, 1 of them judge-vs-human");
  });
});
