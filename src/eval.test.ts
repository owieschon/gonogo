import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  evaluateEvalQualityGate,
  evalCallEvidenceSink,
  loadEvalQualityFloors,
  parseEvalQualityFloors,
  summarizeEvalCostAccounting,
  type EvalQualityFloors,
  type EvalQualityGateInput,
} from "./eval.ts";
import { buildCacheEntry, serializeCacheEntry } from "./replay.ts";
import type { Dimension } from "./types.ts";
import { GONOGO_VERSION } from "./version.ts";

const FLOORS: EvalQualityFloors = {
  dimensions: {
    task_satisfaction: 1,
    scope_discipline: 0.95,
    claim_verification: 1,
    goal_alignment: 0.9,
  },
  verdict: 0.9,
  labelledDrift: 1,
};

function baseline(): EvalQualityGateInput {
  return {
    hardFailures: 0,
    dimensions: {
      task_satisfaction: { ok: 21, total: 21 },
      scope_discipline: { ok: 20, total: 21 },
      claim_verification: { ok: 21, total: 21 },
      goal_alignment: { ok: 19, total: 21 },
    },
    verdict: { ok: 19, total: 21 },
    labelledDrift: { ok: 12, total: 12 },
  };
}

test("verified replay baseline clears every quality floor", () => {
  const result = evaluateEvalQualityGate(baseline(), FLOORS);

  expect(result.passed).toBe(true);
  expect(result.receipt).toContain("[PASS] scope_discipline");
  expect(result.receipt).toContain("20/21 (95.2%); floor >= 95%");
  expect(result.receipt).toContain("quality gate: PASS");
});

test("each accuracy floor rejects a regression", () => {
  const regressions: [string, (input: EvalQualityGateInput) => void][] = [
    ["task_satisfaction", (input) => (input.dimensions.task_satisfaction = { ok: 20, total: 21 })],
    ["scope_discipline", (input) => (input.dimensions.scope_discipline = { ok: 19, total: 21 })],
    ["claim_verification", (input) => (input.dimensions.claim_verification = { ok: 20, total: 21 })],
    ["goal_alignment", (input) => (input.dimensions.goal_alignment = { ok: 18, total: 21 })],
    ["overall verdict", (input) => (input.verdict = { ok: 18, total: 21 })],
    ["labelled drift", (input) => (input.labelledDrift = { ok: 11, total: 12 })],
  ];

  for (const [label, mutate] of regressions) {
    const input = baseline();
    mutate(input);
    const result = evaluateEvalQualityGate(input, FLOORS);
    expect(result.passed).toBe(false);
    expect(result.receipt).toContain(`[FAIL] ${label}`);
  }
});

test("the scope floor accepts exactly 95 percent", () => {
  const input = baseline();
  input.dimensions.scope_discipline = { ok: 19, total: 20 };

  expect(evaluateEvalQualityGate(input, FLOORS).passed).toBe(true);
});

test("hard failures fail even when all completed runs are accurate", () => {
  const input = baseline();
  input.hardFailures = 1;

  const result = evaluateEvalQualityGate(input, FLOORS);
  expect(result.passed).toBe(false);
  expect(result.receipt).toContain("[FAIL] hard failures 1; required 0");
});

test("a metric with no completed labelled runs fails instead of producing a vacuous pass", () => {
  const emptyMetrics: [string, (input: EvalQualityGateInput) => void][] = [
    ...(["task_satisfaction", "scope_discipline", "claim_verification", "goal_alignment"] as Dimension[]).map(
      (dimension): [string, (input: EvalQualityGateInput) => void] => [
        dimension,
        (input) => (input.dimensions[dimension] = { ok: 0, total: 0 }),
      ],
    ),
    ["overall verdict", (input) => (input.verdict = { ok: 0, total: 0 })],
    ["labelled drift", (input) => (input.labelledDrift = { ok: 0, total: 0 })],
  ];

  for (const [label, empty] of emptyMetrics) {
    const input = baseline();
    empty(input);
    const result = evaluateEvalQualityGate(input, FLOORS);
    expect(result.passed).toBe(false);
    expect(result.receipt).toContain(`[FAIL] ${label}`);
    expect(result.receipt).toContain("no completed labelled runs");
  }
});

test("a selected fixture set with no drift labels skips only that metric", () => {
  const input = baseline();
  delete input.labelledDrift;

  const result = evaluateEvalQualityGate(input, FLOORS);
  expect(result.passed).toBe(true);
  expect(result.receipt).toContain("[SKIP] labelled drift");
});

test("the checked-in threshold policy is complete and matches the verified baseline", () => {
  expect(loadEvalQualityFloors(join(import.meta.dir, "..", "fixtures"))).toEqual(FLOORS);
});

test("threshold policy parsing fails closed on version, shape, and range errors", () => {
  const valid = {
    schema: "gonogo/eval-thresholds@1",
    gonogo_version: GONOGO_VERSION,
    min_dimension_accuracy: { ...FLOORS.dimensions },
    min_verdict_accuracy: FLOORS.verdict,
    min_drift_accuracy: FLOORS.labelledDrift,
  };
  // Referenced, not hardcoded: a version bump must not silently break this test.
  expect(() => parseEvalQualityFloors({ ...valid, gonogo_version: "0.0.0-not-the-instrument" })).toThrow(
    `expected ${GONOGO_VERSION}`,
  );
  const missing = { ...valid, min_dimension_accuracy: { ...valid.min_dimension_accuracy } };
  delete (missing.min_dimension_accuracy as Partial<Record<Dimension, number>>).goal_alignment;
  expect(() => parseEvalQualityFloors(missing)).toThrow("must contain exactly");
  expect(() => parseEvalQualityFloors({ ...valid, min_verdict_accuracy: 1.1 })).toThrow(
    "from 0 to 1",
  );
});

test("live eval without --record retains deterministic run-local call receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-eval-receipt-"));
  try {
    const receipt = buildCacheEntry(
      {
        promptHash: "a".repeat(64),
        evidenceHash: "b".repeat(64),
        sample: 2,
        backend: "claude-cli",
        instrumentVersion: GONOGO_VERSION,
        model: "claude-sonnet-5",
      },
      {
        recorded_at: "2026-08-31T00:00:00.000Z",
        model_version: "claude-sonnet-5",
        backend: "claude-cli",
        latency_ms: 12,
        cost_usd: 0.01,
        tokens_in: 10,
        tokens_out: 2,
        text: '{"repairs":[]}',
      },
    );
    const options = { eventsPath: join(dir, "events.jsonl"), record: false, replay: false };
    const sink = evalCallEvidenceSink(options, "eval-run", [], []);
    sink.receipt("rubric", receipt, "live");
    expect(
      readFileSync(
        join(dir, "runs", "eval-run", "evidence", "calls", "rubric.receipt.json"),
        "utf8",
      ),
    ).toBe(serializeCacheEntry(receipt));
    expect(() => sink.receipt("rubric", receipt, "live")).toThrow("refusing to overwrite");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cost accounting retains failed-run costs and discloses unknown provider amounts", () => {
  const makeReceipt = (cost_usd: number | null) =>
    buildCacheEntry(
      {
        promptHash: "a".repeat(64),
        evidenceHash: "b".repeat(64),
        sample: 1,
        backend: "test",
        instrumentVersion: GONOGO_VERSION,
      },
      {
        recorded_at: "2026-09-01T00:00:00.000Z",
        model_version: "test-model",
        backend: "test",
        latency_ms: 1,
        cost_usd,
        tokens_in: 1,
        tokens_out: 1,
        text: "response",
      },
    );
  const accounting = summarizeEvalCostAccounting(
    [
      { runId: "completed", role: "rubric", source: "live", receipt: makeReceipt(1.25) },
      { runId: "failed", role: "blind", source: "live", receipt: makeReceipt(0.5) },
      { runId: "failed", role: "rubric", source: "live", receipt: makeReceipt(null) },
      { runId: "failed", role: "gaming-citation-repair", source: "cache", receipt: makeReceipt(9) },
    ],
    new Set(["failed"]),
    1,
  );

  expect(accounting).toEqual({
    retainedFailedCost: 0.5,
    retainedFailedKnownAmounts: 1,
    retainedSweepCost: 1.75,
    retainedSweepKnownAmounts: 2,
    unknownFailedProviderAmounts: 2,
    unknownProviderAmounts: 2,
  });
});
