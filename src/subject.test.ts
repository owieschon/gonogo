import { describe, expect, test } from "bun:test";
import { subjectHashOf, verdictApplicability } from "./subject.ts";
import type { Evidence, TestResult } from "./types.ts";

function subject(extra: Partial<{
  spec: string;
  diff: string;
  commitMessages: string;
  transcript: string | null;
  test: TestResult | null;
}> = {}) {
  return {
    spec: "Implement the validator.",
    diff: "+export const valid = true;\n",
    commitMessages: "commit abc1234\nfix: validator\n---",
    transcript: "Done; tests pass.",
    test: { command: "bun test", exitCode: 0, output: "1 pass\n" },
    ...extra,
  };
}

describe("subject identity", () => {
  test("is deterministic and binds every operator/worker evidence component", () => {
    const original = subjectHashOf(subject());
    expect(subjectHashOf(subject())).toBe(original);
    expect(subjectHashOf(subject({ spec: "Different spec." }))).not.toBe(original);
    expect(subjectHashOf(subject({ diff: "+different\n" }))).not.toBe(original);
    expect(subjectHashOf(subject({ commitMessages: "fix: different" }))).not.toBe(original);
    expect(subjectHashOf(subject({ transcript: "Different transcript." }))).not.toBe(original);
    expect(subjectHashOf(subject({ test: { command: "bun test --watch", exitCode: 0, output: "1 pass\n" } }))).not.toBe(original);
    expect(subjectHashOf(subject({ test: { command: "bun test", exitCode: 1, output: "1 pass\n" } }))).not.toBe(original);
    expect(subjectHashOf(subject({ test: { command: "bun test", exitCode: 0, output: "different\n" } }))).not.toBe(original);
  });

  test("distinguishes absence from empty evidence and preserves field boundaries", () => {
    expect(subjectHashOf(subject({ transcript: null }))).not.toBe(
      subjectHashOf(subject({ transcript: "" })),
    );
    expect(subjectHashOf(subject({ test: null }))).not.toBe(
      subjectHashOf(subject({ test: { command: "", exitCode: 0, output: "" } })),
    );
    expect(subjectHashOf(subject({ spec: "ab", diff: "c" }))).not.toBe(
      subjectHashOf(subject({ spec: "a", diff: "bc" })),
    );
  });

  test("reports CURRENT, STALE, and legacy UNVERIFIABLE without model input", () => {
    const current = subjectHashOf(subject());
    const evidence = { subjectHash: current } as Pick<Evidence, "subjectHash">;
    expect(verdictApplicability({ subject_hash: current }, evidence)).toEqual({
      status: "CURRENT",
      subject_hash: current,
    });
    const prior = "a".repeat(64);
    expect(verdictApplicability({ subject_hash: prior }, evidence)).toEqual({
      status: "STALE",
      recorded_subject_hash: prior,
      current_subject_hash: current,
    });
    expect(verdictApplicability({}, evidence)).toEqual({
      status: "UNVERIFIABLE",
      current_subject_hash: current,
      reason: "missing_subject_hash",
    });
  });

  test("rejects malformed recorded and current identities", () => {
    expect(() => verdictApplicability({ subject_hash: "bad" }, { subjectHash: "b".repeat(64) })).toThrow(
      "recorded subject_hash",
    );
    expect(() => verdictApplicability({ subject_hash: "a".repeat(64) }, { subjectHash: "bad" })).toThrow(
      "current subject_hash",
    );
  });
});
