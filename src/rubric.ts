/** The two-pass pipeline and the verdict arithmetic described in RUBRIC.md. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type {
  Dimension,
  DimensionResult,
  Evidence,
  RubricPass,
  Verdict,
  VerdictFile,
} from "./types.ts";
import type { Attachment, JudgeBackend, JudgeResponse } from "./judges/index.ts";

import { GONOGO_VERSION } from "./version.ts";
import { blindAttachments, blindPacket } from "./blind.ts";
import { DRIFT_TYPES, EVENT_SCHEMA_VERSION, appendEvent, scoresOf } from "./events.ts";
import type { DriftType, Disclosure, JudgeEvent } from "./events.ts";
import { describeMiss, hashOf, readCache, writeCache } from "./replay.ts";
import type { CacheKey } from "./replay.ts";

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

/**
 * Judges quote diff hunks into citation strings and sometimes leave the line
 * breaks raw, which is invalid JSON. Escape control characters that appear
 * inside string literals; leave structure alone.
 */
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

/**
 * Models wrap JSON in prose or fences no matter how firmly asked not to.
 * Pull out the first balanced object rather than failing the whole run.
 */
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

/** Enforce cite-or-abstain against the evidence bytes, not the judge's confidence. */
export function verifyRubricCitations(pass: RubricPass, attachments: Attachment[]): RubricPass {
  // Opaque transcripts and Markdown specs wrap prose across physical lines.
  // Collapse whitespace only; every non-whitespace citation byte must still
  // occur in order in the supplied evidence.
  const comparable = (text: string) => text.replace(/\s+/g, " ").trim();
  const evidence = attachments.flatMap((attachment) => {
    const variants = [comparable(attachment.content)];
    if (attachment.lang === "diff" || attachment.name === "DIFF") {
      const withoutMarkers = attachment.content
        .split("\n")
        .map((line) => (/^[ +\-]/.test(line) ? line.slice(1) : line))
        .join("\n");
      variants.push(comparable(withoutMarkers));
    }
    return variants;
  });
  const grounded = (citation: string): boolean => {
    const normalized = comparable(citation);
    return normalized !== "" && evidence.some((source) => source.includes(normalized));
  };

  const verify = (name: string, result: DimensionResult): DimensionResult => {
    if (isAbstain(result)) return result;
    const missing = result.citations.filter((c) => !grounded(c));
    if (missing.length === 0) return result;

    // Cite-or-abstain asks whether the score rests on the record. A score with
    // no locatable citation at all rests on nothing, and abstains. A score with
    // one bad supplemental quote alongside several good ones still rests on the
    // record; throwing it away would cap the whole verdict at inconclusive over
    // a sloppy extra quote, which costs more truth than it protects.
    const kept = result.citations.length - missing.length;
    if (kept === 0) {
      return {
        score: "abstain",
        reason:
          `judge scored ${name} but none of its ${result.citations.length} citation` +
          `${result.citations.length === 1 ? "" : "s"} occur in the supplied evidence after ` +
          `whitespace normalization; the score rests on nothing in the record`,
        citations: result.citations,
      };
    }
    return {
      ...result,
      reasoning:
        `[gonogo: ${missing.length} of ${result.citations.length} citations could not be located ` +
        `in the evidence; this score rests on the ${kept} that could. Unlocatable: ` +
        `${JSON.stringify(missing[0]?.slice(0, 100) ?? "")}] ${result.reasoning}`,
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
  raw: { blind: string; rubric: string; discardedRubric: string[] };
  event: JudgeEvent;
}

export interface RunJudgeOptions {
  /** Extra rubric-pass attempts allowed when the reply will not parse. */
  parseRetries?: number;
  /** Which of the k samples this is. Part of the replay cache key. */
  sample?: number;
  /** Serve raw judge output from this cache instead of calling a judge. */
  replayDir?: string;
  /** Record raw judge output into this cache. */
  recordDir?: string;
  /** Append a judge event here. */
  eventsPath?: string;
  runId?: string;
  kind?: "fixture" | "real";
  fixtureId?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
  disclosure?: Disclosure;
}

/** Stable identity for one evidence packet, used as the replay cache key. */
function evidenceHashOf(attachments: Attachment[]): string {
  return hashOf(attachments.map((a) => `${a.name}\n${a.content}`).join("\n\u0000\n"));
}

interface CachedCall {
  response: JudgeResponse;
  key: CacheKey;
  fromCache: boolean;
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
): Promise<CachedCall> {
  const evidenceHash = evidenceHashOf(attachments);
  const key: CacheKey = {
    promptHash: sha256(readFileSync(promptFile, "utf8")),
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
      return { key, fromCache: false, response: await backend.invoke(promptFile, attachments) };
    }
    return {
      key,
      fromCache: true,
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
  return { key, fromCache: false, response: await backend.invoke(promptFile, attachments) };
}

function record(
  opts: RunJudgeOptions,
  backend: JudgeBackend,
  key: CacheKey,
  r: JudgeResponse,
): void {
  if (!opts.recordDir) return;
  writeCache(opts.recordDir, key, {
    recorded_at: new Date().toISOString(),
    model_version: r.model,
    backend: backend.name,
    latency_ms: r.durationMs,
    cost_usd: r.costUsd,
    tokens_in: r.tokensIn,
    tokens_out: r.tokensOut,
    text: r.text,
  });
}

export async function runJudge(
  ev: Evidence,
  backend: JudgeBackend,
  promptsDir: string,
  opts: RunJudgeOptions = {},
): Promise<JudgeRunResult> {
  const blindPrompt = join(promptsDir, "blind-pass.md");
  const rubricPrompt = join(promptsDir, "rubric-pass.md");
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

  // Pass 2 sees everything, including what pass 1 concluded. Judges occasionally
  // emit a reply that will not parse — an unescaped quote inside a citation is
  // the usual cause. One bad reply should not lose the run, so ask again; the
  // retry count is recorded in provenance rather than swallowed, because how
  // often a judge does this is a property worth knowing about the judge.
  const rubricAttachments = [
    { name: "SPEC", content: ev.spec },
    { name: "INFERRED_GOAL", content: inferredGoal },
    ...evidenceAttachments(ev),
  ];
  const attempts = Math.max(1, (opts.parseRetries ?? 1) + 1);
  let rubric: JudgeResponse | undefined;
  let rubricKey: CacheKey | undefined;
  let rubricFromCache = false;
  let parsed: RubricPass | undefined;
  let retries = 0;
  const retryResponses: JudgeResponse[] = [];
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const c = await call(backend, rubricPrompt, rubricAttachments, sample, opts);
    try {
      parsed = verifyRubricCitations(parseRubricPass(c.response.text), rubricAttachments);
      rubric = c.response;
      rubricKey = c.key;
      rubricFromCache = c.fromCache;
      break;
    } catch (err) {
      lastError = err;
      retries++;
      // A reply that will not parse is never recorded: the cache exists to
      // replay working runs, not to make a broken one reproducible.
      if (c.fromCache) throw err;
      retryResponses.push(c.response);
    }
  }
  if (!parsed || !rubric || !rubricKey) throw lastError;
  if (!rubricFromCache) record(opts, backend, rubricKey, rubric);
  // A rerating is not a free retry. The discarded reply may have been
  // substantively right and merely malformed, and the reply that replaced it is
  // an independent sample whose scores can differ. Surface it rather than
  // letting a resample look like a clean first answer.
  const rerated = retries > 0;
  const finishedAt = new Date();

  const dims: Record<Dimension, DimensionResult> = {
    task_satisfaction: parsed.task_satisfaction,
    scope_discipline: parsed.scope_discipline,
    claim_verification: parsed.claim_verification,
    goal_alignment: parsed.goal_alignment,
  };
  const { verdict, overall } = computeVerdict(dims);

  const fullyReplayed = blindCall.fromCache && rubricFromCache;
  const anyCached = blindCall.fromCache || rubricFromCache;
  // A full replay retains historical usage for evaluation reports. A mixed
  // run reports only work performed now; charging a cached pass again would
  // overstate its cost and token use. Parse retries are always live because a
  // malformed reply is never recorded.
  const meteredResponses = fullyReplayed
    ? [blind, rubric]
    : [
        ...(blindCall.fromCache ? [] : [blind]),
        ...(rubricFromCache ? [] : [rubric]),
        ...retryResponses,
      ];
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

  const promptFiles = [blindPrompt, rubricPrompt].map((p) => ({
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
      models_reported: [...new Set([...blind.models, ...rubric.models])].sort(),
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
      rubric_parse_retries: retries,
      rubric_rerated: rerated,
      pass_sources: {
        blind: blindCall.fromCache ? "cache" : "live",
        rubric: rubricFromCache ? "cache" : "live",
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
    evidence_hash: rubricKey.evidenceHash,
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
    replay: anyCached,
  };
  if (opts.eventsPath) appendEvent(opts.eventsPath, event);

  return {
    verdictFile,
    raw: {
      blind: blind.text,
      rubric: rubric.text,
      // Kept so a reader can check whether the rerating changed the substance.
      discardedRubric: retryResponses.map((r) => r.text),
    },
    event,
  };
}
