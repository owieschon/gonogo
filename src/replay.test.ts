import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCache, writeCache } from "./replay.ts";
import type { CacheKey, CachePayload } from "./replay.ts";
import { renderHtml } from "./report.ts";
import { runJudge } from "./rubric.ts";
import type { JudgeBackend, JudgeInvokeOptions, JudgeResponse } from "./judges/types.ts";
import type { Evidence } from "./types.ts";

const roots: string[] = [];
const RUBRIC_SCHEMA_CONTENT = readFileSync(
  join(import.meta.dir, "..", "prompts", "rubric-pass.schema.json"),
  "utf8",
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "gonogo-replay-"));
  roots.push(path);
  return path;
}

function key(extra: Partial<CacheKey> = {}): CacheKey {
  return {
    promptHash: "a".repeat(64),
    evidenceHash: "b".repeat(64),
    sample: 1,
    backend: "claude-cli",
    instrumentVersion: "0.1.0",
    ...extra,
  };
}

function payload(extra: Partial<CachePayload> = {}): CachePayload {
  return {
    recorded_at: "2026-08-31T00:00:00.000Z",
    model_version: "claude-sonnet-5",
    backend: "claude-cli",
    latency_ms: 12,
    cost_usd: 0.01,
    tokens_in: 10,
    tokens_out: 20,
    text: "verdict",
    ...extra,
  };
}

function filesBelow(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else files.push(path);
  }
  return files;
}

describe("replay receipt identity", () => {
  test("a v2 receipt validates backend, instrument, model, and full hashes", () => {
    const dir = root();
    // A requested alias and the resolved model are separate provenance fields.
    const k = key({ model: "sonnet" });
    writeCache(dir, k, payload());

    expect(readCache(dir, k)?.text).toBe("verdict");
    expect(readCache(dir, { ...k, backend: "codex-cli" })).toBeNull();
    expect(readCache(dir, { ...k, instrumentVersion: "0.2.0" })).toBeNull();
    expect(readCache(dir, { ...k, model: "claude-opus-5" })).toBeNull();

    // The path uses hash prefixes; a colliding prefix must not select the
    // receipt unless the complete hash agrees.
    expect(() =>
      readCache(dir, {
        ...k,
        evidenceHash: "b".repeat(16) + "c".repeat(48),
      }),
    ).toThrow("evidence hash");
  });

  test("a receipt cannot claim a different backend", () => {
    const dir = root();
    expect(() => writeCache(dir, key(), payload({ backend: "codex-cli" }))).toThrow(
      "response backend codex-cli",
    );
  });
});

describe("immutable atomic replay recording", () => {
  test("an exact retry is idempotent but different output or model conflicts", () => {
    const dir = root();
    const k = key();
    writeCache(dir, k, payload());
    writeCache(dir, k, payload({ recorded_at: "2026-08-31T01:00:00.000Z" }));

    expect(() => writeCache(dir, k, payload({ text: "different stochastic reply" }))).toThrow(
      "already exists",
    );
    expect(() => writeCache(dir, k, payload({ model_version: "claude-opus-5" }))).toThrow(
      "already exists",
    );
    expect(readCache(dir, k)?.text).toBe("verdict");
    expect(readCache(dir, k)?.model_version).toBe("claude-sonnet-5");
  });

  test("publishes only the final JSON receipt, with no temporary file left behind", () => {
    const dir = root();
    writeCache(dir, key(), payload());
    const files = filesBelow(dir);
    expect(files).toHaveLength(1);
    expect(files[0]!.endsWith(".json")).toBe(true);
    expect(JSON.parse(readFileSync(files[0]!, "utf8")).schema).toBe("gonogo/replay@2");
  });
});

describe("record-on-miss", () => {
  const rubricReply = JSON.stringify({
    drift_type: "none",
    attempted_gaming: false,
    gaming_evidence: [],
    task_satisfaction: {
      score: 4,
      requirements_total: 1,
      requirements_met: 1,
      citations: ["+implemented"],
      reasoning: "met",
    },
    scope_discipline: { score: 4, citations: ["file | 1 +"], reasoning: "focused" },
    claim_verification: { score: 4, citations: ["implemented"], reasoning: "verified" },
    goal_alignment: { score: 4, citations: ["inferred goal"], reasoning: "aligned" },
    spec_clarity: { score: 4, citations: ["Implement it."], reasoning: "clear" },
    judge_confidence: 1,
    summary: "go",
  });

  class CountingBackend implements JudgeBackend {
    readonly name = "test-backend";
    readonly requestedModel = "test-model";
    calls = 0;
    structuredCalls = 0;

    async invoke(
      promptFile: string,
      _attachments: unknown[],
      options?: JudgeInvokeOptions,
    ): Promise<JudgeResponse> {
      this.calls++;
      const blind = promptFile.endsWith("blind-pass.md");
      if (options?.structuredSchema) this.structuredCalls++;
      return {
        text: blind ? "inferred goal" : rubricReply,
        model: this.requestedModel,
        models: [this.requestedModel],
        costUsd: blind ? 0.25 : 0.5,
        durationMs: 1,
        tokensIn: blind ? 10 : 20,
        tokensOut: blind ? 2 : 4,
      };
    }
  }

  function evidence(): Evidence {
    return {
      repo: "/tmp/example",
      base: "a".repeat(40),
      head: "a".repeat(40),
      diff: "+implemented",
      diffStat: "file | 1 +",
      changedFiles: ["file"],
      commitMessages: "implemented",
      spec: "Implement it.",
      transcript: null,
      test: null,
      truncated: { diff: false, transcript: false },
    };
  }

  test("reuses exact receipts and invokes only calls missing from a recording", async () => {
    const dir = root();
    const prompts = join(dir, "prompts");
    const cache = join(dir, "cache");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "blind-pass.md"), "Infer the goal.");
    writeFileSync(join(prompts, "rubric-pass.md"), "Score the work.");
    writeFileSync(join(prompts, "rubric-pass.schema.json"), RUBRIC_SCHEMA_CONTENT);

    const first = new CountingBackend();
    const live = await runJudge(evidence(), first, prompts, { recordDir: cache });
    expect(first.calls).toBe(2);
    expect(first.structuredCalls).toBe(1);
    expect(live.verdictFile.provenance.pass_sources).toEqual({
      blind: "live",
      rubric: "live",
    });
    expect(live.verdictFile.provenance.replayed).toBe(false);
    expect(live.event.replay).toBe(false);
    expect(live.event.cost_usd).toBe(0.75);
    expect(live.event.tokens_in).toBe(30);
    expect(live.event.tokens_out).toBe(6);
    expect(live.verdictFile.provenance.prompt_files.map((file) => file.path)).toContain(
      "prompts/rubric-pass.schema.json",
    );
    expect(live.event.prompt_hashes["prompts/rubric-pass.schema.json"]).toBeDefined();

    const exactReplay = new CountingBackend();
    const fullCache = await runJudge(evidence(), exactReplay, prompts, { recordDir: cache });
    expect(exactReplay.calls).toBe(0);
    expect(fullCache.verdictFile.provenance.pass_sources).toEqual({
      blind: "cache",
      rubric: "cache",
    });
    expect(fullCache.verdictFile.provenance.replayed).toBe(true);
    expect(fullCache.event.replay).toBe(true);
    expect(fullCache.event.cost_usd).toBe(0.75);
    expect(fullCache.event.tokens_in).toBe(30);
    expect(fullCache.event.tokens_out).toBe(6);
    const fullCacheHtml = renderHtml(fullCache.verdictFile);
    expect(fullCacheHtml).toContain("no judge was invoked");
    expect(fullCacheHtml).toContain("uncommitted worktree diff");

    const strictReplay = new CountingBackend();
    const replayed = await runJudge(evidence(), strictReplay, prompts, { replayDir: cache });
    expect(strictReplay.calls).toBe(0);
    expect(replayed.event.replay).toBe(true);
    expect(replayed.event.cost_usd).toBe(0.75);
    expect(replayed.event.tokens_in).toBe(30);
    expect(replayed.event.tokens_out).toBe(6);

    const rubricReceipt = filesBelow(cache).find((path) => {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value.text === rubricReply;
    });
    expect(rubricReceipt).toBeDefined();
    rmSync(rubricReceipt!);

    const oneMissing = new CountingBackend();
    const mixed = await runJudge(evidence(), oneMissing, prompts, { recordDir: cache });
    expect(oneMissing.calls).toBe(1);
    expect(mixed.verdictFile.provenance.pass_sources).toEqual({
      blind: "cache",
      rubric: "live",
    });
    expect(mixed.verdictFile.provenance.replayed).toBe(true);
    expect(mixed.event.replay).toBe(true);
    expect(mixed.verdictFile.provenance.cost_usd).toBe(0.5);
    expect(mixed.event.cost_usd).toBe(0.5);
    expect(mixed.event.tokens_in).toBe(20);
    expect(mixed.event.tokens_out).toBe(4);
    const mixedHtml = renderHtml(mixed.verdictFile);
    expect(mixedHtml).toContain("partial cache — blind pass: cache; rubric pass: live judge");
    expect(mixedHtml).not.toContain("no judge was invoked");

    const blindReceipt = filesBelow(cache).find((path) => {
      const value = JSON.parse(readFileSync(path, "utf8"));
      return value.text === "inferred goal";
    });
    expect(blindReceipt).toBeDefined();
    rmSync(blindReceipt!);

    const blindMissing = new CountingBackend();
    const inverseMixed = await runJudge(evidence(), blindMissing, prompts, { recordDir: cache });
    expect(blindMissing.calls).toBe(1);
    expect(inverseMixed.verdictFile.provenance.pass_sources).toEqual({
      blind: "live",
      rubric: "cache",
    });
    expect(inverseMixed.event.replay).toBe(true);
    expect(inverseMixed.verdictFile.provenance.cost_usd).toBe(0.25);
    expect(inverseMixed.event.cost_usd).toBe(0.25);
    expect(inverseMixed.event.tokens_in).toBe(10);
    expect(inverseMixed.event.tokens_out).toBe(2);
    const inverseHtml = renderHtml(inverseMixed.verdictFile);
    expect(inverseHtml).toContain("partial cache — blind pass: live judge; rubric pass: cache");
    expect(inverseHtml).not.toContain("no judge was invoked");
  });
});

describe("rubric response validation", () => {
  function evidence(): Evidence {
    return {
      repo: "/tmp/example",
      base: "a".repeat(40),
      head: "a".repeat(40),
      diff: "+implemented",
      diffStat: "file | 1 +",
      changedFiles: ["file"],
      commitMessages: "implemented",
      spec: "Implement it.",
      transcript: null,
      test: null,
      truncated: { diff: false, transcript: false },
    };
  }

  function validRubric(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      drift_type: "none",
      attempted_gaming: false,
      gaming_evidence: [],
      task_satisfaction: {
        score: 4,
        requirements_total: 1,
        requirements_met: 1,
        citations: ["+implemented"],
        reasoning: "met",
      },
      scope_discipline: { score: 4, citations: ["file | 1 +"], reasoning: "focused" },
      claim_verification: { score: 4, citations: ["implemented"], reasoning: "verified" },
      goal_alignment: { score: 4, citations: ["inferred goal"], reasoning: "aligned" },
      spec_clarity: { score: 4, citations: ["Implement it."], reasoning: "clear" },
      judge_confidence: 1,
      summary: "go",
      ...extra,
    };
  }

  function promptsAt(parent: string): string {
    const prompts = join(parent, "prompts");
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, "blind-pass.md"), "Infer the goal.");
    writeFileSync(join(prompts, "rubric-pass.md"), "Score the work.");
    writeFileSync(join(prompts, "rubric-pass.schema.json"), RUBRIC_SCHEMA_CONTENT);
    return prompts;
  }

  interface Reply {
    text: string;
    model: string;
  }

  class QueueBackend implements JudgeBackend {
    readonly name = "queue-backend";
    readonly requestedModel = "queue-model";
    calls: { promptFile: string; structured: boolean }[] = [];

    constructor(private readonly replies: Reply[]) {}

    async invoke(
      promptFile: string,
      _attachments: unknown[],
      options?: JudgeInvokeOptions,
    ): Promise<JudgeResponse> {
      this.calls.push({ promptFile, structured: options?.structuredSchema !== undefined });
      const reply = this.replies.shift();
      if (!reply) throw new Error("test backend ran out of replies");
      return {
        text: reply.text,
        model: reply.model,
        models: [reply.model],
        costUsd: 0.1,
        durationMs: 1,
        tokensIn: 10,
        tokensOut: 2,
      };
    }
  }

  const blindReply = (): Reply => ({ text: "inferred goal", model: "blind-model" });
  const rubricReply = (value: Record<string, unknown>, model: string): Reply => ({
    text: JSON.stringify(value),
    model,
  });

  test("retries one live citation-invalid response and meters the discarded call", async () => {
    const prompts = promptsAt(root());
    const invalid = validRubric({
      task_satisfaction: {
        score: 4,
        requirements_total: 1,
        requirements_met: 1,
        citations: ["invented citation"],
        reasoning: "met",
      },
    });
    const backend = new QueueBackend([
      blindReply(),
      rubricReply(invalid, "discarded-model"),
      rubricReply(validRubric(), "accepted-model"),
    ]);

    const result = await runJudge(evidence(), backend, prompts);
    expect(backend.calls).toHaveLength(3);
    expect(backend.calls.map((call) => call.structured)).toEqual([false, true, true]);
    expect(result.verdictFile.dimensions.task_satisfaction.score).toBe(4);
    expect(result.verdictFile.provenance.rubric_citation_retries).toBe(1);
    expect(result.verdictFile.provenance.rubric_parse_retries).toBe(0);
    expect(result.verdictFile.provenance.cost_usd).toBeCloseTo(0.3);
    expect(result.event.tokens_in).toBe(30);
    expect(result.event.tokens_out).toBe(6);
    expect(result.verdictFile.provenance.models_reported).toEqual([
      "accepted-model",
      "blind-model",
      "discarded-model",
    ]);
    expect(renderHtml(result.verdictFile)).toContain("citation retries");
  });

  test("a second citation-invalid live response becomes a safe abstention", async () => {
    const prompts = promptsAt(root());
    const invalid = (citation: string) =>
      validRubric({
        task_satisfaction: {
          score: 4,
          requirements_total: 1,
          requirements_met: 1,
          citations: [citation],
          reasoning: "met",
        },
      });
    const backend = new QueueBackend([
      blindReply(),
      rubricReply(invalid("invented one"), "rubric-1"),
      rubricReply(invalid("invented two"), "rubric-2"),
    ]);

    const result = await runJudge(evidence(), backend, prompts);
    expect(backend.calls).toHaveLength(3);
    expect(result.verdictFile.provenance.rubric_citation_retries).toBe(1);
    expect(result.verdictFile.dimensions.task_satisfaction.score).toBe("abstain");
    expect(result.verdictFile.verdict).toBe("inconclusive");
  });

  test("an explicit abstention is accepted without a retry", async () => {
    const prompts = promptsAt(root());
    const abstained = validRubric({
      claim_verification: { score: "abstain", reason: "no claims to verify" },
    });
    const backend = new QueueBackend([
      blindReply(),
      rubricReply(abstained, "rubric-model"),
    ]);

    const result = await runJudge(evidence(), backend, prompts);
    expect(backend.calls).toHaveLength(2);
    expect(result.verdictFile.provenance.rubric_citation_retries).toBe(0);
    expect(result.verdictFile.dimensions.claim_verification.score).toBe("abstain");
  });

  test("a citation-invalid cached response abstains without falling through to live", async () => {
    const dir = root();
    const prompts = promptsAt(dir);
    const cache = join(dir, "cache");
    const recorder = new QueueBackend([
      blindReply(),
      rubricReply(validRubric(), "rubric-model"),
    ]);
    await runJudge(evidence(), recorder, prompts, { recordDir: cache });
    const receiptPath = filesBelow(cache).find((path) => {
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      return receipt.text === JSON.stringify(validRubric());
    });
    expect(receiptPath).toBeDefined();
    const receipt = JSON.parse(readFileSync(receiptPath!, "utf8"));
    receipt.text = JSON.stringify(
      validRubric({
        task_satisfaction: {
          score: 4,
          requirements_total: 1,
          requirements_met: 1,
          citations: ["not in evidence"],
          reasoning: "met",
        },
      }),
    );
    writeFileSync(receiptPath!, JSON.stringify(receipt));

    const cached = new QueueBackend([]);
    const result = await runJudge(evidence(), cached, prompts, { recordDir: cache });
    expect(cached.calls).toHaveLength(0);
    expect(result.verdictFile.dimensions.task_satisfaction.score).toBe("abstain");
    expect(result.verdictFile.provenance.rubric_citation_retries).toBe(0);
    expect(result.verdictFile.provenance.pass_sources).toEqual({
      blind: "cache",
      rubric: "cache",
    });
  });

  test("malformed rubric JSON fails without asking for another rating", async () => {
    const prompts = promptsAt(root());
    const backend = new QueueBackend([
      blindReply(),
      { text: '{"task_satisfaction":', model: "malformed-model" },
      rubricReply(validRubric(), "must-not-be-called"),
    ]);

    await expect(runJudge(evidence(), backend, prompts, { parseRetries: 99 })).rejects.toThrow(
      "judge did not return strict rubric JSON",
    );
    expect(backend.calls).toHaveLength(2);
  });

  test("prose-wrapped and raw-newline rubric JSON are terminal parse errors", async () => {
    const valid = JSON.stringify(validRubric());
    const malformedReplies = [
      `Here is the result:\n${valid}`,
      valid.replace('"summary":"go"', '"summary":"line one\nline two"'),
    ];
    for (const text of malformedReplies) {
      const prompts = promptsAt(root());
      const backend = new QueueBackend([
        blindReply(),
        { text, model: "malformed-model" },
        rubricReply(validRubric(), "must-not-be-called"),
      ]);
      await expect(runJudge(evidence(), backend, prompts)).rejects.toThrow(
        "judge did not return strict rubric JSON",
      );
      expect(backend.calls).toHaveLength(2);
    }
  });

  test("a schema-invalid rubric response fails without a second rating", async () => {
    const prompts = promptsAt(root());
    const missingSummary = validRubric();
    delete missingSummary.summary;
    const backend = new QueueBackend([
      blindReply(),
      rubricReply(missingSummary, "invalid-model"),
      rubricReply(validRubric(), "must-not-be-called"),
    ]);

    await expect(runJudge(evidence(), backend, prompts)).rejects.toThrow(
      "schema-invalid rubric output",
    );
    expect(backend.calls).toHaveLength(2);
  });

  test("a schema-invalid cached response fails without live fallback", async () => {
    const dir = root();
    const prompts = promptsAt(dir);
    const cache = join(dir, "cache");
    const recorder = new QueueBackend([
      blindReply(),
      rubricReply(validRubric(), "rubric-model"),
    ]);
    await runJudge(evidence(), recorder, prompts, { recordDir: cache });
    const receiptPath = filesBelow(cache).find((path) => {
      const receipt = JSON.parse(readFileSync(path, "utf8"));
      return receipt.text === JSON.stringify(validRubric());
    });
    expect(receiptPath).toBeDefined();
    const receipt = JSON.parse(readFileSync(receiptPath!, "utf8"));
    const missingSummary = validRubric();
    delete missingSummary.summary;
    receipt.text = JSON.stringify(missingSummary);
    writeFileSync(receiptPath!, JSON.stringify(receipt));

    const cached = new QueueBackend([]);
    await expect(runJudge(evidence(), cached, prompts, { recordDir: cache })).rejects.toThrow(
      "schema-invalid rubric output",
    );
    expect(cached.calls).toHaveLength(0);
  });

  test("invalid gaming grounding gets one live retry", async () => {
    const prompts = promptsAt(root());
    const invalidGaming = validRubric({
      attempted_gaming: true,
      gaming_evidence: ["inferred goal"],
    });
    const backend = new QueueBackend([
      blindReply(),
      rubricReply(invalidGaming, "rubric-1"),
      rubricReply(validRubric(), "rubric-2"),
    ]);

    const result = await runJudge(evidence(), backend, prompts);
    expect(backend.calls).toHaveLength(3);
    expect(result.verdictFile.provenance.rubric_citation_retries).toBe(1);
    expect(result.verdictFile.attempted_gaming).toBe(false);
  });

  test("a second invalid gaming response fails closed", async () => {
    const prompts = promptsAt(root());
    const invalidGaming = validRubric({
      attempted_gaming: true,
      gaming_evidence: ["inferred goal"],
    });
    const backend = new QueueBackend([
      blindReply(),
      rubricReply(invalidGaming, "rubric-1"),
      rubricReply(invalidGaming, "rubric-2"),
    ]);

    await expect(runJudge(evidence(), backend, prompts)).rejects.toThrow(
      "not grounded in DIFF, COMMIT_MESSAGES or TRANSCRIPT",
    );
    expect(backend.calls).toHaveLength(3);
  });

  test("schema content participates in replay identity", async () => {
    const dir = root();
    const prompts = promptsAt(dir);
    const cache = join(dir, "cache");
    const recorder = new QueueBackend([
      blindReply(),
      rubricReply(validRubric(), "rubric-model"),
    ]);
    await runJudge(evidence(), recorder, prompts, { recordDir: cache });
    writeFileSync(join(prompts, "rubric-pass.schema.json"), `${RUBRIC_SCHEMA_CONTENT}\n`);

    const replay = new QueueBackend([]);
    await expect(runJudge(evidence(), replay, prompts, { replayDir: cache })).rejects.toThrow(
      "no recorded judge output",
    );
    expect(replay.calls).toHaveLength(0);
  });
});

describe("legacy committed replay compatibility", () => {
  test("reads the validated v1 Claude raw receipt for the 0.1.0 and 0.1.1 parsers", () => {
    const dir = root();
    const k = key({ model: "claude-sonnet-5" });
    const legacyDir = join(dir, k.promptHash.slice(0, 16));
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, `${k.evidenceHash.slice(0, 16)}-${k.sample}.json`),
      JSON.stringify({
        key: {
          promptHash: k.promptHash,
          evidenceHash: k.evidenceHash,
          sample: k.sample,
          promptHashFull: k.promptHash,
          evidenceHashFull: k.evidenceHash,
        },
        ...payload(),
      }),
    );

    expect(readCache(dir, k)?.text).toBe("verdict");
    expect(readCache(dir, { ...k, instrumentVersion: "0.1.1" })?.text).toBe("verdict");
    expect(readCache(dir, { ...k, instrumentVersion: "0.1.2" })).toBeNull();
    expect(readCache(dir, { ...k, backend: "codex-cli" })).toBeNull();
    expect(readCache(dir, { ...k, instrumentVersion: "0.2.0" })).toBeNull();
  });

  test("rejects a legacy truncated-path collision", () => {
    const dir = root();
    const k = key();
    const legacyDir = join(dir, k.promptHash.slice(0, 16));
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, `${k.evidenceHash.slice(0, 16)}-${k.sample}.json`),
      JSON.stringify({
        key: {
          promptHash: "a".repeat(16) + "f".repeat(48),
          evidenceHash: k.evidenceHash,
          sample: k.sample,
        },
        ...payload(),
      }),
    );
    expect(() => readCache(dir, k)).toThrow("prompt hash");
  });
});
