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
import type { Attachment, JudgeBackend } from "./judges/index.ts";
import { GONOGO_VERSION } from "./version.ts";

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

export function parseRubricPass(text: string): RubricPass {
  const raw = extractJson(text);
  const conf = Number(raw.judge_confidence);
  return {
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
  raw: { blind: string; rubric: string };
}

export interface RunJudgeOptions {
  /** Extra rubric-pass attempts allowed when the reply will not parse. */
  parseRetries?: number;
}

export async function runJudge(
  ev: Evidence,
  backend: JudgeBackend,
  promptsDir: string,
  opts: RunJudgeOptions = {},
): Promise<JudgeRunResult> {
  const blindPrompt = join(promptsDir, "blind-pass.md");
  const rubricPrompt = join(promptsDir, "rubric-pass.md");
  const startedAt = new Date();
  const t0 = Date.now();

  // Pass 1 sees the work and never the spec. That isolation is the whole point
  // of the pass; do not add the spec to these attachments.
  const blind = await backend.invoke(blindPrompt, [
    { name: "DIFF", content: ev.diff, lang: "diff" },
    { name: "TRANSCRIPT", content: ev.transcript ?? "" },
  ]);
  const inferredGoal = blind.text.trim();

  // Pass 2 sees everything, including what pass 1 concluded. Judges occasionally
  // emit a reply that will not parse — an unescaped quote inside a citation is
  // the usual cause. One bad reply should not lose the run, so ask again; the
  // retry count is recorded in provenance rather than swallowed, because how
  // often a judge does this is a property worth knowing about the judge.
  const attempts = Math.max(1, (opts.parseRetries ?? 1) + 1);
  let rubric: Awaited<ReturnType<JudgeBackend["invoke"]>> | undefined;
  let parsed: RubricPass | undefined;
  let retries = 0;
  let extraCost = 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const reply = await backend.invoke(rubricPrompt, [
      { name: "SPEC", content: ev.spec },
      { name: "INFERRED_GOAL", content: inferredGoal },
      ...evidenceAttachments(ev),
    ]);
    try {
      parsed = parseRubricPass(reply.text);
      rubric = reply;
      break;
    } catch (err) {
      lastError = err;
      retries++;
      extraCost += reply.costUsd ?? 0;
    }
  }
  if (!parsed || !rubric) throw lastError;
  const finishedAt = new Date();

  const dims: Record<Dimension, DimensionResult> = {
    task_satisfaction: parsed.task_satisfaction,
    scope_discipline: parsed.scope_discipline,
    claim_verification: parsed.claim_verification,
    goal_alignment: parsed.goal_alignment,
  };
  const { verdict, overall } = computeVerdict(dims);

  const cost =
    blind.costUsd === null && rubric.costUsd === null
      ? null
      : (blind.costUsd ?? 0) + (rubric.costUsd ?? 0) + extraCost;

  const verdictFile: VerdictFile = {
    schema: "gonogo/verdict@1",
    verdict,
    overall_score: overall,
    dimensions: dims,
    spec_clarity: parsed.spec_clarity,
    judge_confidence: parsed.judge_confidence,
    summary: parsed.summary,
    inferred_goal: inferredGoal,
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
      prompt_files: [blindPrompt, rubricPrompt].map((p) => ({
        path: p.split("/").slice(-2).join("/"),
        sha256: sha256(readFileSync(p, "utf8")),
      })),
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
    },
  };

  return { verdictFile, raw: { blind: blind.text, rubric: rubric.text } };
}
