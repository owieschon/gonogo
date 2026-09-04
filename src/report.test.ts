/**
 * Focused tests for the accuracy of report.ts's explanatory prose: the
 * blind-input boundary and the confidence label must describe what the code
 * actually does, not an idealized version of it.
 */
import { describe, expect, test } from "bun:test";
import { renderHtml } from "./report.ts";
import type { VerdictFile } from "./types.ts";

function dim(score: number) {
  return { score, citations: ["c"], reasoning: "r" };
}

function verdict(overrides: Partial<VerdictFile> = {}): VerdictFile {
  return {
    schema: "gonogo/verdict@1",
    run_id: "r1",
    task_id: null,
    workspace_id: null,
    verdict: "go",
    overall_score: 4,
    dimensions: {
      task_satisfaction: dim(4),
      scope_discipline: dim(4),
      claim_verification: dim(4),
      goal_alignment: dim(4),
    },
    spec_clarity: dim(4),
    judge_confidence: 0.82,
    summary: "s",
    inferred_goal: "g",
    drift_type: "none",
    attempted_gaming: false,
    gaming_evidence: [],
    evidence_summary: {
      changed_files: [],
      diff_stat: "",
      test: null,
      transcript_present: true,
      commits: 0,
      truncated: { diff: false, transcript: false },
    },
    provenance: {
      gonogo_version: "0.1.6",
      judge_backend: "claude-cli",
      model_version: "claude-sonnet-5",
      models_reported: ["claude-sonnet-5"],
      prompt_files: [],
      started_at: "2026-08-31T00:00:00Z",
      finished_at: "2026-08-31T00:00:01Z",
      duration_ms: 1000,
      cost_usd: null,
      repo: "/tmp/example",
      base: "a".repeat(40),
      head: "b".repeat(40),
      spec_sha256: "a".repeat(64),
      diff_sha256: "b".repeat(64),
      citation_repair: null,
    },
    ...overrides,
  } as VerdictFile;
}

describe("report.ts — blind-input and confidence boundaries are stated accurately", () => {
  test("the blind-pass blurb states no separate spec attachment, not a spec-free transcript", () => {
    const html = renderHtml(verdict());
    expect(html).not.toContain("never the spec");
    expect(html).toMatch(/no\s+separate spec\s+attachment/);
    expect(html.toLowerCase()).toContain("opaque text");
  });

  test("judge confidence is labeled model-reported and uncalibrated", () => {
    const html = renderHtml(verdict({ judge_confidence: 0.5 }));
    expect(html).toContain("judge confidence (model-reported, uncalibrated) 0.50");
  });

  test("HTML escaping is preserved for values embedded next to the boundary prose", () => {
    const html = renderHtml(verdict({ inferred_goal: '<script>alert("x")</script> & co' }));
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co");
  });
});
