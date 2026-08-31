/**
 * events.jsonl — one append-only log, the substrate under `eval` and
 * `calibrate`. Local file, no network, no SDK, no telemetry, ever.
 *
 * Field names follow the OpenTelemetry GenAI semantic conventions where a
 * natural match exists (see DECISIONS.md for the mapping), so the log can be
 * exported later without being rewritten. Nothing here imports an OTel library.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type { Dimension } from "./types.ts";

export const EVENT_SCHEMA_VERSION = 2;

export type EventKind = "fixture" | "real" | "rater" | "outcome";

export const DRIFT_TYPES = [
  "none",
  "proxy_substitution",
  "scope_creep",
  "silent_narrowing",
  "adjacent_solve",
  "abandonment",
  "other",
] as const;
export type DriftType = (typeof DRIFT_TYPES)[number];

export type Disclosure = "none" | "mentioned";
export type OutcomeState = "merged" | "closed" | "abandoned";

interface BaseEvent {
  schema_version: number;
  ts: string;
  kind: EventKind;
  gonogo_version: string;
}

/** One judge invocation: one fixture run, or one real judged task. */
export interface JudgeEvent extends BaseEvent {
  kind: "fixture" | "real";
  run_id: string;
  fixture_id?: string | null;
  task_id?: string | null;
  workspace_id?: string | null;
  backend: string;
  model_version: string;
  prompt_hashes: Record<string, string>;
  evidence_hash: string;
  rater_id: string;
  scores: Record<string, number | "abstain">;
  spec_clarity?: number | "abstain";
  confidence: number;
  abstained: boolean;
  verdict: string;
  drift_type: DriftType;
  attempted_gaming: boolean;
  /** Did the worker's own prompt disclose that its output would be judged? */
  disclosure: Disclosure;
  latency_ms: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  /** True when the scores came from the replay cache rather than a live call. */
  replay: boolean;
}

/** A human (or, later, another judge) scoring the same run. */
export interface RaterEvent extends BaseEvent {
  kind: "rater";
  run_id: string;
  rater_id: string;
  scores: Record<string, number | "abstain">;
  spec_clarity?: number | "abstain";
  review_minutes?: number | null;
  notes?: string | null;
  synthetic?: boolean;
}

/** What happened to the work in the end. Recorded by hand; no GitHub API. */
export interface OutcomeEvent extends BaseEvent {
  kind: "outcome";
  task_id: string;
  run_id?: string | null;
  pr_url: string;
  state: OutcomeState;
  merged_at?: string | null;
}

export type GonogoEvent = JudgeEvent | RaterEvent | OutcomeEvent;

export function isJudgeEvent(e: GonogoEvent): e is JudgeEvent {
  return e.kind === "fixture" || e.kind === "real";
}
export function isRaterEvent(e: GonogoEvent): e is RaterEvent {
  return e.kind === "rater";
}
export function isOutcomeEvent(e: GonogoEvent): e is OutcomeEvent {
  return e.kind === "outcome";
}

/**
 * v1 → v2. v1 had no task_id, workspace_id, disclosure, drift_type or
 * attempted_gaming, and no "outcome" kind. Absent fields become their
 * documented defaults; nothing is invented.
 */
export function migrateEvent(raw: any): GonogoEvent {
  const version = Number(raw?.schema_version ?? 1);
  if (version >= EVENT_SCHEMA_VERSION) return raw as GonogoEvent;
  const e = { ...raw, schema_version: EVENT_SCHEMA_VERSION };
  if (e.kind === "fixture" || e.kind === "real") {
    e.task_id ??= null;
    e.workspace_id ??= null;
    e.disclosure ??= "none";
    e.drift_type ??= "other";
    e.attempted_gaming ??= false;
  }
  if (e.kind === "rater") {
    e.review_minutes ??= null;
    e.notes ??= null;
  }
  return e as GonogoEvent;
}

export function appendEvent(path: string, event: GonogoEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n");
}

/** Read the log, migrating older events on the way in. Bad lines are reported. */
export function readEvents(path: string): { events: GonogoEvent[]; malformed: number } {
  if (!existsSync(path)) return { events: [], malformed: 0 };
  const events: GonogoEvent[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      events.push(migrateEvent(JSON.parse(line)));
    } catch {
      malformed++;
    }
  }
  return { events, malformed };
}

export function scoresOf(dims: Record<string, { score: number | "abstain" }>): Record<
  string,
  number | "abstain"
> {
  const out: Record<string, number | "abstain"> = {};
  for (const d of DIMENSIONS) out[d] = dims[d as Dimension]?.score ?? "abstain";
  return out;
}
