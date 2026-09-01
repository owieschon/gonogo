/** Model-independent identity for the work and evidence a verdict applies to. */
import { createHash } from "node:crypto";
import type { Evidence, TestResult, VerdictFile } from "./types.ts";

export const SUBJECT_SCHEMA = "gonogo/subject@1" as const;

export interface SubjectInput {
  spec: string;
  diff: string;
  commitMessages: string;
  transcript: string | null;
  test: TestResult | null;
}

/**
 * Hash exact UTF-8 evidence bytes through a fixed JSON tuple. Array position,
 * explicit nulls and the schema tag make field boundaries unambiguous.
 */
export function subjectHashOf(input: SubjectInput): string {
  const canonical = JSON.stringify([
    SUBJECT_SCHEMA,
    input.spec,
    input.diff,
    input.commitMessages,
    input.transcript,
    input.test === null
      ? null
      : [input.test.command, input.test.exitCode, input.test.output],
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type SubjectApplicability =
  | { status: "CURRENT"; subject_hash: string }
  | { status: "STALE"; recorded_subject_hash: string; current_subject_hash: string }
  | { status: "UNVERIFIABLE"; current_subject_hash: string; reason: "missing_subject_hash" };

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Contract used by future PR/workspace consumers before acting on a verdict. */
export function verdictApplicability(
  verdict: Pick<VerdictFile, "subject_hash">,
  current: Pick<Evidence, "subjectHash">,
): SubjectApplicability {
  if (!SHA256_HEX.test(current.subjectHash)) {
    throw new Error("current subject_hash must be a lowercase 64-character SHA-256 hex digest");
  }
  const recorded = verdict.subject_hash;
  if (recorded === undefined || recorded === null) {
    return {
      status: "UNVERIFIABLE",
      current_subject_hash: current.subjectHash,
      reason: "missing_subject_hash",
    };
  }
  if (!SHA256_HEX.test(recorded)) {
    throw new Error("recorded subject_hash must be a lowercase 64-character SHA-256 hex digest");
  }
  return recorded === current.subjectHash
    ? { status: "CURRENT", subject_hash: recorded }
    : {
        status: "STALE",
        recorded_subject_hash: recorded,
        current_subject_hash: current.subjectHash,
      };
}
