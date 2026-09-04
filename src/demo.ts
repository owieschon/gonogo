/**
 * Renders a verdict from a committed replay receipt, no live judge call.
 *
 * Thin composition over the existing pipeline: materialize the
 * `merged-but-wrong` fixture, collect evidence from it, replay the recorded
 * `claude-sonnet-5` judge output for sample 1, and render the same
 * verdict.json/verdict.html pair `gonogo judge` produces. `eventsPath` is
 * left unset so no event is appended to any events.jsonl.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadFixture, materialize } from "./fixtures.ts";
import { collectEvidence } from "./evidence.ts";
import { runJudge } from "./rubric.ts";
import { renderHtml } from "./report.ts";
import { ClaudeBackend } from "./judges/claude.ts";
import type { JudgeBackend } from "./judges/index.ts";
import type { VerdictFile } from "./types.ts";

export const DEMO_FIXTURE = "merged-but-wrong";
export const DEMO_MODEL = "claude-sonnet-5";

export interface RunDemoOptions {
  /** fixtures/<DEMO_FIXTURE> */
  fixtureDir: string;
  promptsDir: string;
  replayDir: string;
  outDir: string;
  /** Overridable only for tests; production always uses the pinned Claude identity. */
  backend?: JudgeBackend;
}

export interface RunDemoResult {
  verdictFile: VerdictFile;
  verdictPath: string;
  htmlPath: string;
}

/**
 * Serve the recorded `claude-sonnet-5` verdict for the merged-but-wrong
 * fixture. A missing or incompatible receipt makes `runJudge` throw before
 * anything is written, so a failed demo leaves no verdict.json/verdict.html
 * behind.
 */
export async function runDemo(opts: RunDemoOptions): Promise<RunDemoResult> {
  const fx = loadFixture(opts.fixtureDir);
  const m = materialize(fx);
  let verdictFile: VerdictFile;
  try {
    const ev = collectEvidence({
      repo: m.repo,
      base: m.base,
      spec: fx.spec,
      transcriptPath: fx.transcriptPath,
      testCmd: fx.testCmd,
    });
    const result = await runJudge(ev, opts.backend ?? new ClaudeBackend(DEMO_MODEL), opts.promptsDir, {
      sample: 1,
      replayDir: opts.replayDir,
      kind: "fixture",
      fixtureId: fx.name,
      taskId: `demo:${fx.name}`,
    });
    verdictFile = result.verdictFile;
  } finally {
    m.cleanup();
  }

  mkdirSync(opts.outDir, { recursive: true });
  const verdictPath = join(opts.outDir, "verdict.json");
  const htmlPath = join(opts.outDir, "verdict.html");
  writeFileSync(verdictPath, JSON.stringify(verdictFile, null, 2) + "\n");
  writeFileSync(
    htmlPath,
    renderHtml(verdictFile, { title: `gonogo demo verdict — ${verdictFile.verdict}` }),
  );
  return { verdictFile, verdictPath, htmlPath };
}
