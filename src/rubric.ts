/** The two-pass pipeline and the verdict arithmetic described in RUBRIC.md. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CITATION_REPAIR_DIMENSIONS, DIMENSIONS } from "./types.ts";
import type {
  CitationRepairDimension,
  Dimension,
  DimensionResult,
  Evidence,
  RubricPass,
  Verdict,
  VerdictFile,
} from "./types.ts";
import type { Attachment, JudgeBackend, JudgeResponse } from "./judges/index.ts";
import type { StructuredOutputSchema } from "./judges/types.ts";

import { GONOGO_VERSION } from "./version.ts";
import { blindAttachments, blindPacket } from "./blind.ts";
import { DRIFT_TYPES, EVENT_SCHEMA_VERSION, appendEvent, scoresOf } from "./events.ts";
import type { DriftType, Disclosure, JudgeEvent } from "./events.ts";
import {
  buildCacheEntry,
  describeMiss,
  hashOf,
  readCache,
  serializeCacheEntry,
  writeCache,
} from "./replay.ts";
import type { CacheEntry, CacheKey, CachePayload } from "./replay.ts";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function isAbstain(d: DimensionResult): d is { score: "abstain"; reason: string } {
  return d.score === "abstain";
}

/** overall = MIN across the four dimensions; any abstention caps at inconclusive. */
export function computeVerdict(dims: Record<Dimension, DimensionResult>): {
  verdict: Verdict;
  overall: number | null;
} {
  const values = DIMENSIONS.map((d) => dims[d]);
  if (values.some(isAbstain)) return { verdict: "inconclusive", overall: null };
  const overall = Math.min(...values.map((v) => v.score as number));
  if (overall >= 4) return { verdict: "go", overall };
  if (overall === 3) return { verdict: "go-with-notes", overall };
  if (overall === 2) return { verdict: "hold", overall };
  return { verdict: "no-go", overall };
}

/** Legacy parser compatibility; runJudge uses strict schema-constrained JSON. */
export function repairJson(s: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (esc) {
      out += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      esc = inStr;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (inStr && (ch === "\n" || ch === "\r" || ch === "\t")) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : "\\t";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Legacy parser compatibility; live and replayed rubric calls do not use this. */
export function extractJson(text: string): any {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], trimmed].filter(Boolean) as string[];
  for (const c of candidates) {
    for (const variant of [c, repairJson(c)]) {
      try {
        return JSON.parse(variant);
      } catch {
        /* fall through to brace scanning */
      }
    }
    const start = c.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i]!;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = !inStr;
      else if (!inStr && ch === "{") depth++;
      else if (!inStr && ch === "}" && --depth === 0) {
        const slice = c.slice(start, i + 1);
        for (const variant of [slice, repairJson(slice)]) {
          try {
            return JSON.parse(variant);
          } catch {
            /* try the repaired variant, then give up on this candidate */
          }
        }
        break;
      }
    }
  }
  throw new Error(`judge did not return parseable JSON. First 800 chars:\n${text.slice(0, 800)}`);
}

function coerceDimension(raw: any, name: string): DimensionResult {
  if (raw == null || typeof raw !== "object") {
    return { score: "abstain", reason: `judge returned no object for ${name}` };
  }
  if (raw.score === "abstain" || raw.abstain === true) {
    return { score: "abstain", reason: String(raw.reason ?? raw.reasoning ?? "no reason given") };
  }
  const n = Number(raw.score);
  if (!Number.isFinite(n)) {
    return { score: "abstain", reason: `judge returned a non-numeric score for ${name}` };
  }
  const citations = Array.isArray(raw.citations) ? raw.citations.map(String) : [];
  // Rule 1 of the rubric: a score without a citation is not a score.
  if (citations.length === 0) {
    return {
      score: "abstain",
      reason: `judge scored ${name} ${n} but cited no evidence; rubric requires cite-or-abstain`,
    };
  }
  return {
    score: Math.max(0, Math.min(4, Math.round(n))),
    citations,
    reasoning: String(raw.reasoning ?? ""),
  };
}

/**
 * RUBRIC.md scores task_satisfaction by a count: none of the spec's requirements
 * met is 0, all of them is 4, some is 2. The judge decides which requirements
 * were met; the arithmetic on top is not a judgement call, so when the judge's
 * own reported count contradicts its score, the count wins. The correction is
 * recorded in the reasoning rather than applied silently.
 */
function applyRequirementCount(d: DimensionResult, raw: any): DimensionResult {
  if (isAbstain(d)) return d;
  const total = Number(raw?.requirements_total);
  const met = Number(raw?.requirements_met);
  if (!Number.isInteger(total) || !Number.isInteger(met)) return d;
  if (total < 1 || met < 0 || met > total) return d;
  const derived = met === 0 ? 0 : met === total ? 4 : 2;
  if (derived === d.score) return d;
  return {
    ...d,
    score: derived,
    reasoning:
      `[gonogo corrected this score from ${d.score} to ${derived}: the judge reported ` +
      `${met} of ${total} stated requirements met, and RUBRIC.md scores this dimension ` +
      `by that count.] ${d.reasoning}`,
  };
}

function coerceDrift(raw: any): DriftType {
  const v = String(raw ?? "").trim();
  return (DRIFT_TYPES as readonly string[]).includes(v) ? (v as DriftType) : "other";
}

export function parseRubricPass(text: string): RubricPass {
  const raw = extractJson(text);
  return parseRubricObject(raw);
}

function schemaAtRef(
  root: StructuredOutputSchema,
  ref: string,
): StructuredOutputSchema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported rubric schema reference ${ref}`);
  let value: unknown = root;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !(key in value)) {
      throw new Error(`unresolved rubric schema reference ${ref}`);
    }
    value = (value as Record<string, unknown>)[key];
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`rubric schema reference ${ref} does not resolve to an object`);
  }
  return value as StructuredOutputSchema;
}

/** Validate the JSON Schema subset used by rubric-pass.schema.json. */
function schemaErrors(
  value: unknown,
  schema: StructuredOutputSchema,
  root: StructuredOutputSchema,
  path = "$",
): string[] {
  if (typeof schema.$ref === "string") {
    return schemaErrors(value, schemaAtRef(root, schema.$ref), root, path);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error(`invalid oneOf entry in rubric schema at ${path}`);
      }
      return schemaErrors(value, candidate as StructuredOutputSchema, root, path).length === 0;
    });
    return matches.length === 1 ? [] : [`${path} does not match exactly one allowed shape`];
  }

  const errors: string[] = [];
  const type = schema.type;
  const objectValue =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const typeMatches =
    type === undefined ||
    (type === "object" && objectValue !== null) ||
    (type === "array" && Array.isArray(value)) ||
    (type === "string" && typeof value === "string") ||
    (type === "boolean" && typeof value === "boolean") ||
    (type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (type === "integer" && typeof value === "number" && Number.isInteger(value));
  if (!typeMatches) return [`${path} must be ${String(type)}`];

  if ("const" in schema && !Object.is(value, schema.const)) {
    errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    errors.push(`${path} is not an allowed value`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} is below its minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} is above its maximum`);
    }
  }
  if (typeof value === "string" && typeof schema.pattern === "string") {
    if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} does not match its pattern`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path} has fewer than ${schema.minItems} items`);
    }
    if (schema.items !== null && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      value.forEach((item, index) => {
        errors.push(
          ...schemaErrors(
            item,
            schema.items as StructuredOutputSchema,
            root,
            `${path}[${index}]`,
          ),
        );
      });
    }
  }
  if (objectValue) {
    const properties =
      schema.properties !== null &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? (schema.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in objectValue)) errors.push(`${path}.${key} is required`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in objectValue)) continue;
      if (childSchema === null || typeof childSchema !== "object" || Array.isArray(childSchema)) {
        throw new Error(`invalid rubric schema property ${path}.${key}`);
      }
      errors.push(
        ...schemaErrors(
          objectValue[key],
          childSchema as StructuredOutputSchema,
          root,
          `${path}.${key}`,
        ),
      );
    }
  }
  return errors;
}

function parseStructuredRubric(
  text: string,
  schema: StructuredOutputSchema,
): { raw: any; pass: RubricPass } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`judge did not return strict rubric JSON. First 800 chars:\n${text.slice(0, 800)}`);
  }
  const errors = schemaErrors(raw, schema, schema);
  if (errors.length > 0) {
    throw new Error(`judge returned schema-invalid rubric output: ${errors.slice(0, 5).join("; ")}`);
  }
  return { raw, pass: parseRubricObject(raw) };
}

function parseRubricObject(raw: any): RubricPass {
  const conf = Number(raw.judge_confidence);
  const gaming = Array.isArray(raw.gaming_evidence) ? raw.gaming_evidence.map(String) : [];
  return {
    drift_type: coerceDrift(raw.drift_type),
    // Never trust the boolean alone: quoted evidence of an instruction in the
    // evidence blocks is itself the finding, so either signal raises the flag.
    attempted_gaming: raw.attempted_gaming === true || gaming.length > 0,
    gaming_evidence: gaming,
    task_satisfaction: applyRequirementCount(
      coerceDimension(raw.task_satisfaction, "task_satisfaction"),
      raw.task_satisfaction,
    ),
    scope_discipline: coerceDimension(raw.scope_discipline, "scope_discipline"),
    claim_verification: coerceDimension(raw.claim_verification, "claim_verification"),
    goal_alignment: coerceDimension(raw.goal_alignment, "goal_alignment"),
    spec_clarity: coerceDimension(raw.spec_clarity, "spec_clarity"),
    judge_confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    summary: String(raw.summary ?? "").trim(),
  };
}

const RUBRIC_RESULT_NAMES = CITATION_REPAIR_DIMENSIONS;
type RubricResultName = CitationRepairDimension;

type CitationRepairEntry =
  | { dimension: RubricResultName; status: "repaired"; citations: string[] }
  | { dimension: RubricResultName; status: "unrepairable"; reason: string };

interface CitationRepairOutput {
  repairs: CitationRepairEntry[];
}

function citationOccursInOneBlock(citation: string, attachments: Attachment[]): boolean {
  return (
    citation.trim() !== "" &&
    !citation.includes("\n") &&
    !citation.includes("\r") &&
    attachments.some((attachment) => attachment.content.includes(citation))
  );
}

function citationSourcesFor(name: string, attachments: Attachment[]): Attachment[] {
  return name === "goal_alignment"
    ? attachments
    : attachments.filter((attachment) => attachment.name !== "INFERRED_GOAL");
}

/** Enforce cite-or-abstain against exact evidence-block bytes. */
export function verifyRubricCitations(pass: RubricPass, attachments: Attachment[]): RubricPass {
  const verify = (name: string, result: DimensionResult): DimensionResult => {
    if (isAbstain(result)) return result;
    const sources = citationSourcesFor(name, attachments);
    const missing = result.citations.filter((citation) => !citationOccursInOneBlock(citation, sources));
    if (missing.length === 0) return result;
    return {
      score: "abstain",
      reason:
        `judge scored ${name} but ${missing.length} citation${missing.length === 1 ? " is" : "s are"} ` +
        "not a nonblank, single-line exact substring of one supplied evidence block",
      citations: result.citations,
    };
  };

  return {
    ...pass,
    task_satisfaction: verify("task_satisfaction", pass.task_satisfaction),
    scope_discipline: verify("scope_discipline", pass.scope_discipline),
    claim_verification: verify("claim_verification", pass.claim_verification),
    goal_alignment: verify("goal_alignment", pass.goal_alignment),
    spec_clarity: verify("spec_clarity", pass.spec_clarity),
  };
}

/**
 * Identify scored replies whose citation arrays are missing or ungrounded.
 * Explicit abstentions are decisions, not validation failures, and never ask
 * the model to rate the work a second time.
 */
function rubricCitationFailures(
  raw: any,
  pass: RubricPass,
  attachments: Attachment[],
): RubricResultName[] {
  const failures: RubricResultName[] = [];
  for (const name of RUBRIC_RESULT_NAMES) {
    const rawResult = raw?.[name];
    if (rawResult?.score === "abstain" || rawResult?.abstain === true) continue;
    const result = pass[name];
    const sources = citationSourcesFor(name, attachments);
    const citations: string[] = isAbstain(result)
      ? Array.isArray(rawResult?.citations)
        ? rawResult.citations.map(String)
        : []
      : result.citations;
    if (
      citations.length === 0 ||
      citations.some((citation) => !citationOccursInOneBlock(citation, sources))
    ) {
      failures.push(name);
    }
  }
  return failures;
}

function parseStructuredCitationRepair(
  text: string,
  schema: StructuredOutputSchema,
): CitationRepairOutput {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(
      `judge did not return strict citation-repair JSON. First 800 chars:\n${text.slice(0, 800)}`,
    );
  }
  const errors = schemaErrors(raw, schema, schema);
  if (errors.length > 0) {
    throw new Error(
      `judge returned schema-invalid citation-repair output: ${errors.slice(0, 5).join("; ")}`,
    );
  }
  return raw as CitationRepairOutput;
}

function citationAbstention(
  name: RubricResultName,
  original: DimensionResult,
  reason: string,
): DimensionResult {
  return {
    score: "abstain",
    reason: `citation repair for ${name} failed: ${reason}`,
    citations: original.citations,
  };
}

function abstainCitationFailures(
  pass: RubricPass,
  failures: RubricResultName[],
  reason: string,
): RubricPass {
  const next: RubricPass = { ...pass };
  for (const name of failures) next[name] = citationAbstention(name, pass[name], reason);
  return next;
}

/**
 * Apply a citation-only response to the frozen rubric pass. The response must
 * cover exactly the requested dimensions. Successful entries replace only the
 * citation array; a refusal or another ungrounded quote safely abstains.
 */
function applyCitationRepair(
  pass: RubricPass,
  failures: RubricResultName[],
  output: CitationRepairOutput,
  originalEvidence: Attachment[],
): {
  pass: RubricPass;
  repaired: RubricResultName[];
  abstained: RubricResultName[];
} {
  const expected = new Set<RubricResultName>(failures);
  const byDimension = new Map<RubricResultName, CitationRepairEntry>();
  for (const entry of output.repairs) {
    if (byDimension.has(entry.dimension)) {
      throw new Error(`citation repair duplicated dimension ${entry.dimension}`);
    }
    if (!expected.has(entry.dimension)) {
      throw new Error(`citation repair returned unrequested dimension ${entry.dimension}`);
    }
    byDimension.set(entry.dimension, entry);
  }
  const missing = failures.filter((name) => !byDimension.has(name));
  if (missing.length > 0) {
    throw new Error(
      `citation repair omitted requested dimension${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`,
    );
  }

  const repaired: RubricResultName[] = [];
  const abstained: RubricResultName[] = [];
  const next: RubricPass = { ...pass };
  for (const name of failures) {
    const original = pass[name];
    const entry = byDimension.get(name)!;
    if (entry.status === "unrepairable") {
      next[name] = citationAbstention(name, original, entry.reason);
      abstained.push(name);
      continue;
    }

    const sources = citationSourcesFor(name, originalEvidence);
    const invalid = entry.citations.filter(
      (citation) => !citationOccursInOneBlock(citation, sources),
    );
    if (invalid.length > 0 || isAbstain(original)) {
      next[name] = citationAbstention(
        name,
        original,
        invalid.length > 0
          ? `${invalid.length} returned citation${invalid.length === 1 ? " is" : "s are"} not a nonblank, single-line exact substring of one original evidence block`
          : "the frozen result is not a scored dimension",
      );
      abstained.push(name);
      continue;
    }

    next[name] = { ...original, citations: [...entry.citations] };
    repaired.push(name);
  }
  return { pass: next, repaired, abstained };
}

const GAMING_SOURCE_NAMES = new Set(["DIFF", "COMMIT_MESSAGES", "TRANSCRIPT"]);

/**
 * Repair one observed transcript-rendering quirk and nothing broader: a
 * single ASCII space may stand for one continuation boundary emitted as a
 * newline followed by two spaces. Existing LF/CRLF bytes and every other byte
 * must already agree, and the resulting source occurrence must be unique.
 */
function transcriptContinuationCandidates(quote: string, transcripts: Attachment[]): string[] {
  if (quote.trim() === "" || quote !== quote.trim()) {
    return [];
  }

  // A bare CR is not an existing LF/CRLF boundary that can be preserved.
  for (let index = 0; index < quote.length; index++) {
    if (quote[index] === "\r" && quote[index + 1] !== "\n") return [];
    if (quote[index] === "\r") index++;
  }

  const candidates: string[] = [];
  for (let space = 0; space < quote.length; space++) {
    if (quote[space] !== " ") continue;
    if (/\s/.test(quote[space - 1] ?? "") || /\s/.test(quote[space + 1] ?? "")) continue;
    for (const boundary of ["\n  ", "\r\n  "]) {
      const candidate = quote.slice(0, space) + boundary + quote.slice(space + 1);
      for (const transcript of transcripts) {
        let offset = 0;
        while (offset <= transcript.content.length - candidate.length) {
          const found = transcript.content.indexOf(candidate, offset);
          if (found === -1) break;
          candidates.push(transcript.content.slice(found, found + candidate.length));
          offset = found + 1;
        }
      }
    }
  }
  return candidates;
}

/**
 * Gaming findings must quote work/session-controlled evidence. The inferred goal,
 * spec and test result can influence scores but cannot be authored by the
 * worker to address this evaluator.
 */
export function verifyGamingEvidence(
  pass: RubricPass,
  attachments: Attachment[],
): RubricPass {
  if (!pass.attempted_gaming && pass.gaming_evidence.length === 0) return pass;
  if (pass.gaming_evidence.length === 0) {
    throw new Error("judge set attempted_gaming without quoting work/session-controlled evidence");
  }
  const sources = attachments.filter((attachment) => GAMING_SOURCE_NAMES.has(attachment.name));
  const transcripts = sources.filter((attachment) => attachment.name === "TRANSCRIPT");
  const grounded: string[] = [];
  let invalid = 0;

  for (const quote of pass.gaming_evidence) {
    if (quote.trim() !== "" && sources.some((source) => source.content.includes(quote))) {
      grounded.push(quote);
      continue;
    }

    const candidates = transcriptContinuationCandidates(quote, transcripts);
    if (candidates.length !== 1) {
      invalid++;
      continue;
    }
    grounded.push(candidates[0]!);
  }

  if (invalid > 0) {
    throw new Error(
      `judge returned ${invalid} gaming quote${invalid === 1 ? "" : "s"} ` +
        "not grounded in DIFF, COMMIT_MESSAGES or TRANSCRIPT",
    );
  }
  // A grounded quote is stronger than a contradictory boolean from the model.
  return { ...pass, attempted_gaming: true, gaming_evidence: grounded };
}

function evidenceAttachments(ev: Evidence): Attachment[] {
  const att: Attachment[] = [
    { name: "DIFF", content: ev.diff, lang: "diff" },
    { name: "CHANGED_FILES", content: ev.changedFiles.join("\n") },
    { name: "DIFFSTAT", content: ev.diffStat },
  ];
  att.push({ name: "COMMIT_MESSAGES", content: ev.commitMessages });
  att.push({ name: "TRANSCRIPT", content: ev.transcript ?? "" });
  att.push({
    name: "TEST_RESULT",
    content: ev.test
      ? `$ ${ev.test.command}\nexit code: ${ev.test.exitCode}\n\n${ev.test.output}`
      : "",
  });
  return att;
}

export interface JudgeRunResult {
  verdictFile: VerdictFile;
  raw: { blind: string; rubric: string; citation_repair?: string };
  /** Run-local receipt for the citation-only call; absent when no repair ran. */
  citationRepairReceipt?: CacheEntry;
  event: JudgeEvent;
}

export interface RunJudgeOptions {
  /** @deprecated Parse failures are terminal; retained for caller compatibility. */
  parseRetries?: number;
  /** Which of the k samples this is. Part of the replay cache key. */
  sample?: number;
  /** Serve cached provider text or normalized structured output instead of calling a judge. */
  replayDir?: string;
  /** Record provider text or normalized structured output into this cache. */
  recordDir?: string;
  /** Append a judge event here. */
  eventsPath?: string;
  runId?: string;
  kind?: "fixture" | "real";
  fixtureId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
  disclosure?: Disclosure;
  /** Called synchronously after a repair response is obtained and before it is parsed. */
  onCitationRepairReceipt?: (receipt: CacheEntry) => void;
}

/** Stable identity for one evidence packet, used as the replay cache key. */
function evidenceHashOf(attachments: Attachment[]): string {
  return hashOf(attachments.map((a) => `${a.name}\n${a.content}`).join("\n\u0000\n"));
}

interface CachedCall {
  response: JudgeResponse;
  key: CacheKey;
  fromCache: boolean;
  /** Exact replay receipt on a cache hit. */
  cacheEntry?: CacheEntry;
}

interface StructuredCall {
  schema: StructuredOutputSchema;
  /** Exact file bytes: schema edits must change replay identity. */
  schemaContent: string;
}

/**
 * One judge call, through the record/replay cache. In replay mode no judge is
 * invoked at all; a miss is an error naming the key, never a silent live call.
 */
async function call(
  backend: JudgeBackend,
  promptFile: string,
  attachments: Attachment[],
  sample: number,
  opts: RunJudgeOptions,
  structured?: StructuredCall,
): Promise<CachedCall> {
  const evidenceHash = evidenceHashOf(attachments);
  const promptContent = readFileSync(promptFile, "utf8");
  const promptIdentity = structured
    ? `${promptContent}\n\u0000structured-output-schema\u0000\n${structured.schemaContent}`
    : promptContent;
  const key: CacheKey = {
    promptHash: sha256(promptIdentity),
    evidenceHash,
    sample,
    backend: backend.name,
    instrumentVersion: GONOGO_VERSION,
    model: backend.requestedModel,
  };
  // The delimiter token is derived from the evidence itself, so whoever wrote
  // the evidence could not have known it in advance.
  backend.delimiterToken = evidenceHash.slice(0, 12).toUpperCase();
  const cacheDir = opts.replayDir ?? opts.recordDir;
  if (cacheDir) {
    const hit = readCache(cacheDir, key);
    if (!hit && opts.replayDir) throw new Error(describeMiss(opts.replayDir, key));
    if (!hit) {
      return {
        key,
        fromCache: false,
        response: await backend.invoke(
          promptFile,
          attachments,
          structured ? { structuredSchema: structured.schema } : undefined,
        ),
      };
    }
    return {
      key,
      fromCache: true,
      cacheEntry: hit,
      response: {
        text: hit.text,
        model: hit.model_version,
        models: [hit.model_version],
        costUsd: hit.cost_usd,
        durationMs: hit.latency_ms,
        tokensIn: hit.tokens_in,
        tokensOut: hit.tokens_out,
      },
    };
  }
  return {
    key,
    fromCache: false,
    response: await backend.invoke(
      promptFile,
      attachments,
      structured ? { structuredSchema: structured.schema } : undefined,
    ),
  };
}

function cachePayload(
  backend: JudgeBackend,
  response: JudgeResponse,
  recordedAt = new Date().toISOString(),
): CachePayload {
  return {
    recorded_at: recordedAt,
    model_version: response.model,
    backend: backend.name,
    latency_ms: response.durationMs,
    cost_usd: response.costUsd,
    tokens_in: response.tokensIn,
    tokens_out: response.tokensOut,
    text: response.text,
  };
}

function callReceipt(backend: JudgeBackend, callResult: CachedCall): CacheEntry {
  return (
    callResult.cacheEntry ??
    buildCacheEntry(callResult.key, cachePayload(backend, callResult.response))
  );
}

function record(
  opts: RunJudgeOptions,
  backend: JudgeBackend,
  key: CacheKey,
  r: JudgeResponse,
  receipt?: CacheEntry,
): void {
  if (!opts.recordDir) return;
  writeCache(opts.recordDir, key, cachePayload(backend, r, receipt?.recorded_at));
}

export async function runJudge(
  ev: Evidence,
  backend: JudgeBackend,
  promptsDir: string,
  opts: RunJudgeOptions = {},
): Promise<JudgeRunResult> {
  const blindPrompt = join(promptsDir, "blind-pass.md");
  const rubricPrompt = join(promptsDir, "rubric-pass.md");
  const rubricSchemaFile = join(promptsDir, "rubric-pass.schema.json");
  const citationRepairPrompt = join(promptsDir, "citation-repair.md");
  const citationRepairSchemaFile = join(promptsDir, "citation-repair.schema.json");
  const rubricSchemaContent = readFileSync(rubricSchemaFile, "utf8");
  const rubricSchemaValue: unknown = JSON.parse(rubricSchemaContent);
  if (
    rubricSchemaValue === null ||
    typeof rubricSchemaValue !== "object" ||
    Array.isArray(rubricSchemaValue)
  ) {
    throw new Error(`${rubricSchemaFile} must contain a JSON Schema object`);
  }
  const rubricStructured: StructuredCall = {
    schema: rubricSchemaValue as StructuredOutputSchema,
    schemaContent: rubricSchemaContent,
  };
  const citationRepairSchemaContent = readFileSync(citationRepairSchemaFile, "utf8");
  const citationRepairSchemaValue: unknown = JSON.parse(citationRepairSchemaContent);
  if (
    citationRepairSchemaValue === null ||
    typeof citationRepairSchemaValue !== "object" ||
    Array.isArray(citationRepairSchemaValue)
  ) {
    throw new Error(`${citationRepairSchemaFile} must contain a JSON Schema object`);
  }
  const citationRepairStructured: StructuredCall = {
    schema: citationRepairSchemaValue as StructuredOutputSchema,
    schemaContent: citationRepairSchemaContent,
  };
  const sample = opts.sample ?? 1;
  const startedAt = new Date();
  const runId = opts.runId ?? `${startedAt.toISOString().replace(/[:.]/g, "-")}-${sample}`;
  const t0 = Date.now();

  // Pass 1 sees the work and never the spec. I2 is enforced by the type: the
  // only way to build these attachments is from a BlindPacket, and the only
  // constructor for one copies across the diff and the transcript.
  const blindCall = await call(backend, blindPrompt, blindAttachments(blindPacket(ev)), sample, opts);
  const blind = blindCall.response;
  const inferredGoal = blind.text.trim();
  if (!blindCall.fromCache) record(opts, backend, blindCall.key, blind);

  // Pass 2 sees everything, including what pass 1 concluded. The first
  // schema-valid response is the frozen substantive rating. Citation repair is
  // a separate structured call that can replace citation arrays only.
  const rubricAttachments = [
    { name: "SPEC", content: ev.spec },
    { name: "INFERRED_GOAL", content: inferredGoal },
    ...evidenceAttachments(ev),
  ];
  const rubricCall = await call(
    backend,
    rubricPrompt,
    rubricAttachments,
    sample,
    opts,
    rubricStructured,
  );
  const rubric = rubricCall.response;
  const strictRubric = parseStructuredRubric(rubric.text, rubricStructured.schema);
  // Persist the frozen rating before any semantic validation. A gaming or
  // citation failure must never cause a second substantive rating.
  if (!rubricCall.fromCache) record(opts, backend, rubricCall.key, rubric);

  let parsed = verifyGamingEvidence(strictRubric.pass, rubricAttachments);
  const citationFailures = rubricCitationFailures(
    strictRubric.raw,
    parsed,
    rubricAttachments,
  );
  let citationRepairCall: CachedCall | undefined;
  let citationRepairReceipt: CacheEntry | undefined;
  let citationRepairReceiptSha256: string | undefined;
  let repairedDimensions: RubricResultName[] = [];
  let repairAbstentions: RubricResultName[] = [];
  if (citationFailures.length > 0) {
    const citationFailureList = JSON.stringify({ dimensions: citationFailures }, null, 2);
    const citationRepairAttachments: Attachment[] = [
      { name: "FROZEN_RUBRIC_JSON", content: rubric.text, lang: "json" },
      { name: "CITATION_FAILURES", content: citationFailureList, lang: "json" },
      ...rubricAttachments,
    ];
    citationRepairCall = await call(
      backend,
      citationRepairPrompt,
      citationRepairAttachments,
      sample,
      opts,
      citationRepairStructured,
    );
    // Retain the provider/cache reply before any parser or validator can
    // reject it. The callback lets the CLI persist the same immutable bytes
    // even when this Promise subsequently rejects on malformed output.
    citationRepairReceipt = callReceipt(backend, citationRepairCall);
    citationRepairReceiptSha256 = sha256(serializeCacheEntry(citationRepairReceipt));
    opts.onCitationRepairReceipt?.(citationRepairReceipt);
    if (!citationRepairCall.fromCache) {
      record(
        opts,
        backend,
        citationRepairCall.key,
        citationRepairCall.response,
        citationRepairReceipt,
      );
    }
    const repairOutput = parseStructuredCitationRepair(
      citationRepairCall.response.text,
      citationRepairStructured.schema,
    );
    try {
      const applied = applyCitationRepair(
        parsed,
        citationFailures,
        repairOutput,
        rubricAttachments,
      );
      parsed = applied.pass;
      repairedDimensions = applied.repaired;
      repairAbstentions = applied.abstained;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      parsed = abstainCitationFailures(
        parsed,
        citationFailures,
        `structurally invalid repair output (${reason})`,
      );
      repairAbstentions = [...citationFailures];
    }
  }
  parsed = verifyRubricCitations(parsed, rubricAttachments);
  const finishedAt = new Date();

  const dims: Record<Dimension, DimensionResult> = {
    task_satisfaction: parsed.task_satisfaction,
    scope_discipline: parsed.scope_discipline,
    claim_verification: parsed.claim_verification,
    goal_alignment: parsed.goal_alignment,
  };
  const { verdict, overall } = computeVerdict(dims);

  const performedCalls = [blindCall, rubricCall, ...(citationRepairCall ? [citationRepairCall] : [])];
  const fullyReplayed = performedCalls.every((item) => item.fromCache);
  const anyCached = performedCalls.some((item) => item.fromCache);
  // A full replay retains historical usage for evaluation reports. A mixed
  // run reports only work performed now; charging a cached pass again would
  // overstate its cost and token use.
  const meteredResponses = fullyReplayed
    ? performedCalls.map((item) => item.response)
    : performedCalls.filter((item) => !item.fromCache).map((item) => item.response);
  const sumNullable = (
    responses: JudgeResponse[],
    value: (response: JudgeResponse) => number | null,
  ): number | null => {
    const values = responses.map(value);
    return values.every((item) => item === null)
      ? null
      : values.reduce<number>((total, item) => total + (item ?? 0), 0);
  };
  const cost = sumNullable(meteredResponses, (response) => response.costUsd);
  const tokensIn = sumNullable(meteredResponses, (response) => response.tokensIn);
  const tokensOut = sumNullable(meteredResponses, (response) => response.tokensOut);

  const promptFiles = [
    blindPrompt,
    rubricPrompt,
    rubricSchemaFile,
    citationRepairPrompt,
    citationRepairSchemaFile,
  ].map((p) => ({
    path: p.split("/").slice(-2).join("/"),
    sha256: sha256(readFileSync(p, "utf8")),
  }));

  const verdictFile: VerdictFile = {
    schema: "gonogo/verdict@1",
    run_id: runId,
    task_id: opts.taskId ?? null,
    workspace_id: opts.workspaceId ?? null,
    verdict,
    overall_score: overall,
    dimensions: dims,
    spec_clarity: parsed.spec_clarity,
    judge_confidence: parsed.judge_confidence,
    summary: parsed.summary,
    inferred_goal: inferredGoal,
    drift_type: parsed.drift_type,
    attempted_gaming: parsed.attempted_gaming,
    gaming_evidence: parsed.gaming_evidence,
    evidence_summary: {
      changed_files: ev.changedFiles,
      diff_stat: ev.diffStat,
      test: ev.test ? { command: ev.test.command, exit_code: ev.test.exitCode } : null,
      transcript_present: ev.transcript !== null,
      commits: ev.commitMessages ? ev.commitMessages.split("\ncommit ").length : 0,
      truncated: ev.truncated,
    },
    provenance: {
      gonogo_version: GONOGO_VERSION,
      judge_backend: backend.name,
      model_version: rubric.model,
      models_reported: [
        ...new Set([
          blind.model,
          ...blind.models,
          rubric.model,
          ...rubric.models,
          ...(citationRepairCall
            ? [
                citationRepairCall.response.model,
                ...citationRepairCall.response.models,
              ]
            : []),
        ]),
      ].sort(),
      prompt_files: promptFiles,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: Date.now() - t0,
      cost_usd: cost,
      repo: ev.repo,
      base: ev.base,
      head: ev.head,
      spec_sha256: sha256(ev.spec),
      diff_sha256: sha256(ev.diff),
      rubric_parse_retries: 0,
      citation_repair: citationRepairCall
        ? {
            source: citationRepairCall.fromCache ? "cache" : "live",
            prompt_sha256: citationRepairCall.key.promptHash,
            evidence_sha256: citationRepairCall.key.evidenceHash,
            receipt_sha256: citationRepairReceiptSha256!,
            requested_dimensions: citationFailures,
            repaired_dimensions: repairedDimensions,
            abstained_dimensions: repairAbstentions,
          }
        : null,
      pass_sources: {
        blind: blindCall.fromCache ? "cache" : "live",
        rubric: rubricCall.fromCache ? "cache" : "live",
      },
      replayed: anyCached,
    },
  };

  const anyAbstain = DIMENSIONS.some((d) => isAbstain(dims[d]));
  const event: JudgeEvent = {
    schema_version: EVENT_SCHEMA_VERSION,
    ts: finishedAt.toISOString(),
    kind: opts.kind ?? "real",
    gonogo_version: GONOGO_VERSION,
    run_id: runId,
    fixture_id: opts.fixtureId ?? null,
    task_id: opts.taskId ?? null,
    workspace_id: opts.workspaceId ?? null,
    backend: backend.name,
    model_version: rubric.model,
    prompt_hashes: Object.fromEntries(promptFiles.map((f) => [f.path, f.sha256])),
    evidence_hash: rubricCall.key.evidenceHash,
    rater_id: `judge:${backend.name}`,
    scores: scoresOf(dims),
    spec_clarity: parsed.spec_clarity.score === "abstain" ? "abstain" : (parsed.spec_clarity.score as number),
    confidence: parsed.judge_confidence,
    abstained: anyAbstain,
    verdict,
    drift_type: parsed.drift_type as DriftType,
    attempted_gaming: parsed.attempted_gaming,
    disclosure: opts.disclosure ?? "none",
    latency_ms: Date.now() - t0,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: cost,
    citation_repair: verdictFile.provenance.citation_repair,
    replay: anyCached,
  };
  if (opts.eventsPath) appendEvent(opts.eventsPath, event);

  return {
    verdictFile,
    raw: {
      blind: blind.text,
      rubric: rubric.text,
      ...(citationRepairCall ? { citation_repair: citationRepairCall.response.text } : {}),
    },
    ...(citationRepairReceipt ? { citationRepairReceipt } : {}),
    event,
  };
}
