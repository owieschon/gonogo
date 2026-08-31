/** Shared types. The scoring contract here is the one written in RUBRIC.md. */

export const DIMENSIONS = [
  "task_satisfaction",
  "scope_discipline",
  "claim_verification",
  "goal_alignment",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

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
}

export interface Evidence {
  repo: string;
  base: string;
  head: string;
  diff: string;
  diffStat: string;
  changedFiles: string[];
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
}

export interface VerdictFile {
  schema: "gonogo/verdict@1";
  verdict: Verdict;
  overall_score: number | null;
  dimensions: Record<Dimension, DimensionResult>;
  spec_clarity: DimensionResult;
  judge_confidence: number;
  summary: string;
  inferred_goal: string;
  evidence_summary: {
    changed_files: string[];
    diff_stat: string;
    test: { command: string; exit_code: number } | null;
    transcript_present: boolean;
    truncated: { diff: boolean; transcript: boolean };
  };
  provenance: Provenance;
}

/** Human verdict recorded after a real run; same shape as the rubric dimensions. */
export interface HumanFile {
  schema: "gonogo/human@1";
  run_id: string;
  reviewer: string;
  recorded_at: string;
  synthetic?: boolean;
  dimensions: Record<Dimension, number | "abstain">;
  spec_clarity?: number | "abstain";
  notes?: string;
}
