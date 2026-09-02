/** Shared types. The scoring contract here is the one written in RUBRIC.md. */

export const DIMENSIONS = [
  "task_satisfaction",
  "scope_discipline",
  "claim_verification",
  "goal_alignment",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

export const CITATION_REPAIR_DIMENSIONS = [...DIMENSIONS, "spec_clarity"] as const;

export type CitationRepairDimension = (typeof CITATION_REPAIR_DIMENSIONS)[number];

/** A dimension is either scored 0-4 with citations, or abstained with a reason. */
export type DimensionResult =
  | { score: number; citations: string[]; reasoning: string }
  | { score: "abstain"; reason: string; citations?: string[] };

export type Verdict =
  | "go"
  | "go-with-notes"
  | "hold"
  | "no-go"
  | "inconclusive";

export interface RubricPass {
  task_satisfaction: DimensionResult;
  scope_discipline: DimensionResult;
  claim_verification: DimensionResult;
  goal_alignment: DimensionResult;
  spec_clarity: DimensionResult;
  judge_confidence: number;
  summary: string;
  drift_type: string;
  attempted_gaming: boolean;
  gaming_evidence: string[];
}

export interface Evidence {
  /** Model-independent identity of the complete, pre-elision subject evidence. */
  subjectHash: string;
  repo: string;
  base: string;
  head: string;
  diff: string;
  diffStat: string;
  changedFiles: string[];
  /** Commit subjects and bodies between base and HEAD; part of the agent's claims. */
  commitMessages: string;
  spec: string;
  transcript: string | null;
  test: TestResult | null;
  truncated: { diff: boolean; transcript: boolean };
}

export interface TestResult {
  command: string;
  exitCode: number;
  output: string;
}

export type JudgePassSource = "live" | "cache";

/** Provenance for a bounded pass that repairs citations without changing frozen scores. */
export interface CitationRepair {
  source: JudgePassSource;
  prompt_sha256: string;
  evidence_sha256: string;
  /** Digest of the canonical run-local gonogo/replay@2 call receipt. */
  receipt_sha256: string;
  requested_dimensions: CitationRepairDimension[];
  repaired_dimensions: CitationRepairDimension[];
  abstained_dimensions: CitationRepairDimension[];
}

export interface Provenance {
  gonogo_version: string;
  judge_backend: string;
  model_version: string;
  models_reported: string[];
  prompt_files: { path: string; sha256: string }[];
  started_at: string;
  finished_at: string;
  duration_ms: number;
  cost_usd: number | null;
  repo: string;
  base: string;
  head: string;
  spec_sha256: string;
  diff_sha256: string;
  /** Rubric-pass replies discarded because they would not parse. Usually 0. */
  rubric_parse_retries?: number;
  /** @deprecated Historical whole-rubric rerates. New runs use citation_repair. */
  rubric_citation_retries?: number;
  /** @deprecated Historical parse-resample marker. Structured runs never rerate. */
  rubric_rerated?: boolean;
  /** Null when every frozen rubric score already had valid citations. */
  citation_repair: CitationRepair | null;
  /** Source of each pass. Optional only for verdicts written before this field existed. */
  pass_sources?: { blind: JudgePassSource; rubric: JudgePassSource };
  /** True when any pass came from cache, so this run is excluded from calibration. */
  replayed?: boolean;
}

export interface VerdictFile {
  schema: "gonogo/verdict@1";
  /** Missing only on legacy artifacts; consumers must treat that as unverifiable. */
  subject_hash?: string | null;
  /** Stable join keys. Optional only so pre-v0.1 artifacts remain readable. */
  run_id?: string;
  task_id?: string | null;
  workspace_id?: string | null;
  verdict: Verdict;
  overall_score: number | null;
  dimensions: Record<Dimension, DimensionResult>;
  spec_clarity: DimensionResult;
  judge_confidence: number;
  summary: string;
  inferred_goal: string;
  /** Which failure mode this is, if any. Definitions in RUBRIC.md. */
  drift_type: string;
  /** True when the evidence itself tried to instruct the judge. */
  attempted_gaming: boolean;
  gaming_evidence: string[];
  evidence_summary: {
    changed_files: string[];
    diff_stat: string;
    test: { command: string; exit_code: number } | null;
    transcript_present: boolean;
    commits: number;
    truncated: { diff: boolean; transcript: boolean };
  };
  provenance: Provenance;
}

/**
 * Who produced a manual rating. Declared, never inferred: a reviewer id says
 * nothing about whether a person or a language model wrote the scores, and
 * treating an AI review as human calibration is the one error this field
 * exists to make impossible.
 *
 * - `human` — a person read the evidence and wrote the scores.
 * - `llm`   — a language model wrote them, in any session, under any handle.
 * - `synthetic` — hand-written demo data that scores no real run.
 */
export const RATER_KINDS = ["human", "llm", "synthetic"] as const;

export type RaterKind = (typeof RATER_KINDS)[number];

/**
 * A rating recorded before `rater_kind` existed. It is not a classification of
 * the author; it is the absence of one, and it is never promoted to `human`.
 */
export const UNDECLARED_RATER_KIND = "undeclared";

export type StoredRaterKind = RaterKind | typeof UNDECLARED_RATER_KIND;

export function isRaterKind(value: unknown): value is RaterKind {
  return typeof value === "string" && (RATER_KINDS as readonly string[]).includes(value);
}

export function isStoredRaterKind(value: unknown): value is StoredRaterKind {
  return isRaterKind(value) || value === UNDECLARED_RATER_KIND;
}

/**
 * A manual rating recorded next to a run: `human.json`, historically named for
 * the only rater kind that was expected to write one. The file name and the
 * `gonogo/human@1` schema id are unchanged; who wrote it is `rater_kind`.
 */
export interface ManualRatingFile {
  schema: "gonogo/human@1";
  run_id: string;
  reviewer: string;
  /** Absent only on records written before the field existed; those are undeclared. */
  rater_kind?: RaterKind;
  recorded_at: string;
  synthetic?: boolean;
  dimensions: Record<Dimension, number | "abstain">;
  spec_clarity?: number | "abstain";
  review_minutes?: number | null;
  notes?: string;
}
