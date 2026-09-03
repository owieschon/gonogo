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
import {
  CITATION_REPAIR_DIMENSIONS,
  DIMENSIONS,
  RATER_KINDS,
  UNDECLARED_RATER_KIND,
  isStoredRaterKind,
} from "./types.ts";
import type { CitationRepair, CitationRepairDimension, Dimension, StoredRaterKind } from "./types.ts";

export const EVENT_SCHEMA_VERSION = 5;

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
  /** Model-independent work/evidence identity. Null only on migrated legacy events. */
  subject_hash: string | null;
  /** Judge-call identity; includes judge-generated attachments such as INFERRED_GOAL. */
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
  /** Citation-only repair provenance; null when the frozen rubric reply needed no repair. */
  citation_repair: CitationRepair | null;
  /** True when either judge pass came from cache rather than a live call. */
  replay: boolean;
}

/** A person, a language model, or later another judge, scoring the same run. */
export interface RaterEvent extends BaseEvent {
  kind: "rater";
  run_id: string;
  rater_id: string;
  /**
   * Who wrote these scores. Required on new events; v1-v4 events migrate to
   * `undeclared`, which is excluded from agreement rather than read as human.
   */
  rater_kind: StoredRaterKind;
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

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Field(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_HEX.test(value)) {
    throw new Error(`${label} must be a lowercase 64-character SHA-256 hex digest`);
  }
  return value;
}

function citationRepairDimensions(value: unknown, label: string): CitationRepairDimension[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const allowed = CITATION_REPAIR_DIMENSIONS as readonly string[];
  let prior = -1;
  for (const dimension of value) {
    if (typeof dimension !== "string" || !allowed.includes(dimension)) {
      throw new Error(`${label} contains unknown dimension ${JSON.stringify(dimension)}`);
    }
    const index = allowed.indexOf(dimension);
    if (index <= prior) {
      throw new Error(`${label} must contain unique dimensions in canonical order`);
    }
    prior = index;
  }
  return value as CitationRepairDimension[];
}

function validateCitationRepair(
  value: unknown,
  event: Record<string, unknown>,
  kind: "fixture" | "real",
): CitationRepair | null {
  if (value === null) return null;
  const repair = recordOf(value, `${kind}.citation_repair`);
  const expectedKeys = [
    "source",
    "prompt_sha256",
    "evidence_sha256",
    "receipt_sha256",
    "requested_dimensions",
    "repaired_dimensions",
    "abstained_dimensions",
  ].sort();
  const actualKeys = Object.keys(repair).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error(`${kind}.citation_repair must contain exactly ${expectedKeys.join(", ")}`);
  }
  if (repair.source !== "live" && repair.source !== "cache") {
    throw new Error(`${kind}.citation_repair.source must be live or cache`);
  }
  sha256Field(repair.prompt_sha256, `${kind}.citation_repair.prompt_sha256`);
  sha256Field(repair.evidence_sha256, `${kind}.citation_repair.evidence_sha256`);
  sha256Field(repair.receipt_sha256, `${kind}.citation_repair.receipt_sha256`);
  const requested = citationRepairDimensions(
    repair.requested_dimensions,
    `${kind}.citation_repair.requested_dimensions`,
  );
  const repaired = citationRepairDimensions(
    repair.repaired_dimensions,
    `${kind}.citation_repair.repaired_dimensions`,
  );
  const abstained = citationRepairDimensions(
    repair.abstained_dimensions,
    `${kind}.citation_repair.abstained_dimensions`,
  );
  if (requested.length === 0) {
    throw new Error(`${kind}.citation_repair.requested_dimensions must not be empty`);
  }
  const requestedSet = new Set(requested);
  const repairedSet = new Set(repaired);
  const abstainedSet = new Set(abstained);
  if (repaired.some((dimension) => !requestedSet.has(dimension))) {
    throw new Error(`${kind}.citation_repair.repaired_dimensions must be requested`);
  }
  if (abstained.some((dimension) => !requestedSet.has(dimension))) {
    throw new Error(`${kind}.citation_repair.abstained_dimensions must be requested`);
  }
  if (repaired.some((dimension) => abstainedSet.has(dimension))) {
    throw new Error(`${kind}.citation_repair dimensions cannot be both repaired and abstained`);
  }
  if (
    requested.some((dimension) => !repairedSet.has(dimension) && !abstainedSet.has(dimension))
  ) {
    throw new Error(
      `${kind}.citation_repair repaired_dimensions and abstained_dimensions must partition requested_dimensions`,
    );
  }
  const scores = event.scores as Record<string, unknown>;
  for (const dimension of repaired) {
    const finalScore = dimension === "spec_clarity" ? event.spec_clarity : scores[dimension];
    if (finalScore === undefined || finalScore === "abstain") {
      throw new Error(`${kind}.citation_repair repaired ${dimension} but its final score is abstain`);
    }
  }
  for (const dimension of abstained) {
    const finalScore = dimension === "spec_clarity" ? event.spec_clarity : scores[dimension];
    if (finalScore !== "abstain") {
      throw new Error(`${kind}.citation_repair abstained ${dimension} but its final score is not abstain`);
    }
  }
  if (repair.source === "cache" && event.replay !== true) {
    throw new Error(`${kind}.citation_repair from cache requires replay=true`);
  }
  const hashes = event.prompt_hashes as Record<string, unknown>;
  for (const path of ["prompts/citation-repair.md", "prompts/citation-repair.schema.json"]) {
    if (!Object.hasOwn(hashes, path)) {
      throw new Error(`${kind}.citation_repair requires ${path} in ${kind}.prompt_hashes`);
    }
  }
  return repair as unknown as CitationRepair;
}

/**
 * `synthetic` and `rater_kind: "synthetic"` are two spellings of one fact, so a
 * record that spells them differently is asserting two incompatible things
 * about its own author. An undeclared legacy record is exempt: it asserts
 * nothing, which is the whole reason it is excluded from agreement.
 */
function assertRaterKindMatchesSynthetic(
  raterKind: StoredRaterKind,
  synthetic: boolean,
  label: string,
): void {
  if (raterKind === UNDECLARED_RATER_KIND) return;
  if (raterKind === "synthetic" && !synthetic) {
    throw new Error(`${label}.rater_kind "synthetic" requires ${label}.synthetic true`);
  }
  if (raterKind !== "synthetic" && synthetic) {
    throw new Error(`${label}.synthetic true requires ${label}.rater_kind "synthetic"`);
  }
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
    if (!isStoredRaterKind(event.rater_kind)) {
      throw new Error(
        `rater.rater_kind must be one of ${RATER_KINDS.join(", ")} or "${UNDECLARED_RATER_KIND}"`,
      );
    }
    assertRaterKindMatchesSynthetic(event.rater_kind, event.synthetic === true, "rater");
    return event as unknown as RaterEvent;
  }

  nullableString(event.fixture_id, `${kind}.fixture_id`);
  nullableString(event.task_id, `${kind}.task_id`);
  nullableString(event.workspace_id, `${kind}.workspace_id`);
  stringField(event.backend, `${kind}.backend`);
  stringField(event.model_version, `${kind}.model_version`);
  const hashes = recordOf(event.prompt_hashes, `${kind}.prompt_hashes`);
  for (const [path, hash] of Object.entries(hashes)) stringField(hash, `${kind}.prompt_hashes.${path}`);
  if (!Object.hasOwn(event, "subject_hash")) {
    throw new Error(`${kind}.subject_hash must be a SHA-256 digest or null`);
  }
  if (event.subject_hash !== null) sha256Field(event.subject_hash, `${kind}.subject_hash`);
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
  if (!Object.hasOwn(event, "citation_repair")) {
    throw new Error(`${kind}.citation_repair must be an object or null`);
  }
  validateCitationRepair(event.citation_repair, event, kind);
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
 * v1-v4 → v5. Earlier versions had no model-independent subject hash;
 * they migrate to null and must be reinspected before an applicability-aware
 * consumer acts. Other absent fields become their documented defaults; an
 * absent legacy score becomes an abstention, never an invented judgement, and
 * an absent rater kind becomes "undeclared", never "human".
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
    if (version < 3) e.citation_repair = null;
    if (version < 4) e.subject_hash = null;
  }
  if (e.kind === "rater") {
    e.review_minutes ??= null;
    e.notes ??= null;
    // v1-v4 rater events predate rater_kind. The author of those scores was
    // never recorded, so they migrate to "undeclared" and are excluded from
    // agreement. Defaulting them to "human" would invent the one fact this
    // field exists to establish. The single exception is a legacy record that
    // already declared `synthetic: true`: that record states it scores no real
    // run, so carrying the statement over classifies nobody as a reviewer.
    if (version < 5) e.rater_kind = e.synthetic === true ? "synthetic" : UNDECLARED_RATER_KIND;
  }
  return validateCurrentEvent(e);
}

export function appendEvent(path: string, event: GonogoEvent): void {
  const validated = validateCurrentEvent(event);
  // "undeclared" is a migration outcome, not something a writer may choose:
  // whoever records a rating now knows whether a person or a model wrote it.
  if (isRaterEvent(validated) && validated.rater_kind === UNDECLARED_RATER_KIND) {
    throw new Error(
      `a new rater event must declare rater_kind (${RATER_KINDS.join(", ")}); ` +
        `"${UNDECLARED_RATER_KIND}" is reserved for migrated legacy records`,
    );
  }
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
