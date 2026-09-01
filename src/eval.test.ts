import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  evaluateEvalQualityGate,
  loadEvalQualityFloors,
  parseEvalQualityFloors,
  type EvalQualityFloors,
  type EvalQualityGateInput,
} from "./eval.ts";
import type { Dimension } from "./types.ts";

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

test("the checked-in 0.1.3 threshold policy is complete", () => {
  expect(loadEvalQualityFloors(join(import.meta.dir, "..", "fixtures"))).toEqual(FLOORS);
});

test("threshold policy parsing fails closed on version, shape, and range errors", () => {
  const valid = {
    schema: "gonogo/eval-thresholds@1",
    gonogo_version: "0.1.3",
    min_dimension_accuracy: { ...FLOORS.dimensions },
    min_verdict_accuracy: FLOORS.verdict,
    min_drift_accuracy: FLOORS.labelledDrift,
  };
  expect(() => parseEvalQualityFloors({ ...valid, gonogo_version: "0.1.0" })).toThrow(
    "expected 0.1.3",
  );
  const missing = { ...valid, min_dimension_accuracy: { ...valid.min_dimension_accuracy } };
  delete (missing.min_dimension_accuracy as Partial<Record<Dimension, number>>).goal_alignment;
  expect(() => parseEvalQualityFloors(missing)).toThrow("must contain exactly");
  expect(() => parseEvalQualityFloors({ ...valid, min_verdict_accuracy: 1.1 })).toThrow(
    "from 0 to 1",
  );
});
