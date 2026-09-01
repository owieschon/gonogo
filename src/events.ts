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
  /** True when either judge pass came from cache rather than a live call. */
  replay: boolean;
  /**
   * True when the judge's first rubric reply would not parse and these scores
   * are a resample. A rerated run is a weaker observation: the discarded reply
   * may have been substantively correct and merely malformed.
   */
  rerated?: boolean;
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

const VERDICTS = new Set(["go", "go-with-notes", "hold", "no-go", "inconclusive"]);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nullableString(value: unknown, label: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string or null`);
  }
}

function nullableNumber(value: unknown, label: string): void {
  if (value !== undefined && value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${label} must be a finite number or null`);
  }
}

function scoreField(value: unknown, label: string): void {
  if (value !== "abstain" && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 4)) {
    throw new Error(`${label} must be an integer from 0 to 4 or "abstain"`);
  }
}

function scoresField(value: unknown, label: string): void {
  const scores = recordOf(value, label);
  const missing = DIMENSIONS.filter((dimension) => !Object.hasOwn(scores, dimension));
  const unknown = Object.keys(scores).filter(
    (dimension) => !(DIMENSIONS as readonly string[]).includes(dimension),
  );
  if (missing.length > 0 || unknown.length > 0) {
    const details = [
      missing.length > 0 ? `missing ${missing.join(", ")}` : "",
      unknown.length > 0 ? `unknown ${unknown.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`${label} must contain exactly ${DIMENSIONS.join(", ")} (${details})`);
  }
  for (const dimension of DIMENSIONS) scoreField(scores[dimension], `${label}.${dimension}`);
}

function outcomeForScores(scores: Record<string, unknown>): {
  abstained: boolean;
  verdict: string;
} {
  const values = DIMENSIONS.map((dimension) => scores[dimension]);
  if (values.includes("abstain")) return { abstained: true, verdict: "inconclusive" };
  const overall = Math.min(...(values as number[]));
  if (overall >= 4) return { abstained: false, verdict: "go" };
  if (overall === 3) return { abstained: false, verdict: "go-with-notes" };
  if (overall === 2) return { abstained: false, verdict: "hold" };
  return { abstained: false, verdict: "no-go" };
}

const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

/** True only for a calendar-valid ISO-8601 timestamp with an explicit zone. */
export function isIso8601Timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = ISO_8601_TIMESTAMP.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

function isoTimestamp(value: unknown, label: string, nullable = false): void {
  if (nullable && (value === undefined || value === null)) return;
  if (!isIso8601Timestamp(value)) throw new Error(`${label} must be an ISO-8601 timestamp`);
}

function validateCurrentEvent(value: unknown): GonogoEvent {
  const event = recordOf(value, "event");
  if (event.schema_version !== EVENT_SCHEMA_VERSION) {
    throw new Error(`event schema_version must be ${EVENT_SCHEMA_VERSION}`);
  }
  isoTimestamp(event.ts, "event.ts");
  stringField(event.gonogo_version, "event.gonogo_version");
  const kind = stringField(event.kind, "event.kind");
  if (kind !== "fixture" && kind !== "real" && kind !== "rater" && kind !== "outcome") {
    throw new Error(`unknown event kind "${kind}"`);
  }

  if (kind === "outcome") {
    stringField(event.task_id, "outcome.task_id");
    nullableString(event.run_id, "outcome.run_id");
    const prUrl = stringField(event.pr_url, "outcome.pr_url");
    let parsed: URL;
    try {
      parsed = new URL(prUrl);
    } catch {
      throw new Error("outcome.pr_url must be an absolute URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("outcome.pr_url must use http or https");
    }
    if (event.state !== "merged" && event.state !== "closed" && event.state !== "abandoned") {
      throw new Error("outcome.state must be merged, closed or abandoned");
    }
    if (event.state === "merged") {
      if (event.merged_at === undefined || event.merged_at === null) {
        throw new Error("outcome.merged_at is required when outcome.state is merged");
      }
      isoTimestamp(event.merged_at, "outcome.merged_at");
    } else if (event.merged_at !== undefined && event.merged_at !== null) {
      throw new Error("outcome.merged_at must be null unless outcome.state is merged");
    }
    return event as unknown as OutcomeEvent;
  }

  stringField(event.run_id, `${kind}.run_id`);
  stringField(event.rater_id, `${kind}.rater_id`);
  scoresField(event.scores, `${kind}.scores`);
  if (event.spec_clarity !== undefined) scoreField(event.spec_clarity, `${kind}.spec_clarity`);

  if (kind === "rater") {
    nullableNumber(event.review_minutes, "rater.review_minutes");
    nullableString(event.notes, "rater.notes");
    if (event.synthetic !== undefined && typeof event.synthetic !== "boolean") {
      throw new Error("rater.synthetic must be a boolean");
    }
    return event as unknown as RaterEvent;
  }

  nullableString(event.fixture_id, `${kind}.fixture_id`);
  nullableString(event.task_id, `${kind}.task_id`);
  nullableString(event.workspace_id, `${kind}.workspace_id`);
  stringField(event.backend, `${kind}.backend`);
  stringField(event.model_version, `${kind}.model_version`);
  const hashes = recordOf(event.prompt_hashes, `${kind}.prompt_hashes`);
  for (const [path, hash] of Object.entries(hashes)) stringField(hash, `${kind}.prompt_hashes.${path}`);
  stringField(event.evidence_hash, `${kind}.evidence_hash`);
  if (typeof event.confidence !== "number" || event.confidence < 0 || event.confidence > 1) {
    throw new Error(`${kind}.confidence must be between 0 and 1`);
  }
  if (typeof event.abstained !== "boolean") throw new Error(`${kind}.abstained must be a boolean`);
  if (!VERDICTS.has(String(event.verdict))) throw new Error(`${kind}.verdict is invalid`);
  const expected = outcomeForScores(event.scores as Record<string, unknown>);
  if (event.abstained !== expected.abstained) {
    throw new Error(`${kind}.abstained is inconsistent with ${kind}.scores`);
  }
  if (event.verdict !== expected.verdict) {
    throw new Error(`${kind}.verdict is inconsistent with ${kind}.scores`);
  }
  if (!(DRIFT_TYPES as readonly unknown[]).includes(event.drift_type)) throw new Error(`${kind}.drift_type is invalid`);
  if (typeof event.attempted_gaming !== "boolean") throw new Error(`${kind}.attempted_gaming must be a boolean`);
  if (event.disclosure !== "none" && event.disclosure !== "mentioned") throw new Error(`${kind}.disclosure is invalid`);
  if (typeof event.latency_ms !== "number" || !Number.isFinite(event.latency_ms) || event.latency_ms < 0) {
    throw new Error(`${kind}.latency_ms must be a non-negative number`);
  }
  nullableNumber(event.tokens_in, `${kind}.tokens_in`);
  nullableNumber(event.tokens_out, `${kind}.tokens_out`);
  nullableNumber(event.cost_usd, `${kind}.cost_usd`);
  if (typeof event.replay !== "boolean") throw new Error(`${kind}.replay must be a boolean`);
  return event as unknown as JudgeEvent;
}

export function isJudgeEvent(e: GonogoEvent): e is JudgeEvent {
  return e.kind === "fixture" || e.kind === "real";
}
export function isRaterEvent(e: GonogoEvent): e is RaterEvent {
  return e.kind === "rater";
}
export function isOutcomeEvent(e: GonogoEvent): e is OutcomeEvent {
  return e.kind === "outcome";
}

/** Resolve the explicit judge/outcome join, rejecting dangling or mismatched ids. */
export function requireOutcomeRun(
  events: GonogoEvent[],
  runId: string,
  taskId: string,
): JudgeEvent {
  const runs = events.filter(
    (event): event is JudgeEvent =>
      isJudgeEvent(event) && event.kind === "real" && event.run_id === runId,
  );
  if (runs.length === 0) throw new Error(`--run "${runId}" does not identify a real judge event`);
  if (runs.length > 1) throw new Error(`--run "${runId}" matches ${runs.length} real judge events`);
  const run = runs[0]!;
  if (!run.task_id) throw new Error(`judge run "${runId}" has no task_id and cannot be joined`);
  if (run.task_id !== taskId) {
    throw new Error(`outcome task "${taskId}" does not match judge run task "${run.task_id}"`);
  }
  return run;
}

/**
 * v1 → v2. v1 had no task_id, workspace_id, disclosure, drift_type or
 * attempted_gaming, and no "outcome" kind. Absent fields become their
 * documented defaults; an absent legacy score becomes an abstention, never an
 * invented numeric judgement.
 */
export function migrateEvent(raw: any): GonogoEvent {
  const version = Number(raw?.schema_version ?? 1);
  if (!Number.isInteger(version) || version < 1) throw new Error("event schema_version is invalid");
  if (version > EVENT_SCHEMA_VERSION) {
    throw new Error(`event schema_version ${version} is newer than supported v${EVENT_SCHEMA_VERSION}`);
  }
  const legacy = version < EVENT_SCHEMA_VERSION;
  const e = version === EVENT_SCHEMA_VERSION ? { ...raw } : { ...raw, schema_version: EVENT_SCHEMA_VERSION };
  if (legacy && (e.kind === "fixture" || e.kind === "real" || e.kind === "rater")) {
    const scores = recordOf(e.scores, `${e.kind}.scores`);
    e.scores = { ...scores };
    for (const dimension of DIMENSIONS) {
      if (!Object.hasOwn(e.scores, dimension)) e.scores[dimension] = "abstain";
    }
    if (e.kind === "fixture" || e.kind === "real") {
      Object.assign(e, outcomeForScores(e.scores));
    }
  }
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
  return validateCurrentEvent(e);
}

export function appendEvent(path: string, event: GonogoEvent): void {
  const validated = validateCurrentEvent(event);
  if (existsSync(path)) {
    const { events, malformed } = readEvents(path);
    if (malformed > 0) {
      throw new Error(`${path} contains ${malformed} malformed event line(s); repair the log before appending`);
    }
    if (isJudgeEvent(validated) && events.some((prior) => isJudgeEvent(prior) && prior.run_id === validated.run_id)) {
      throw new Error(`judge run_id "${validated.run_id}" already exists in ${path}`);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(validated) + "\n");
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
