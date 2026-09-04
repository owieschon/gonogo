import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_FIXTURE, DEMO_MODEL, runDemo } from "./demo.ts";
import { GONOGO_VERSION } from "./version.ts";
import type { Attachment, JudgeBackend, JudgeResponse } from "./judges/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "fixtures", DEMO_FIXTURE);
const PROMPTS_DIR = join(ROOT, "prompts");
const REPLAY_DIR = join(ROOT, "replay");
const ROOT_EVENTS_PATH = join(ROOT, "events.jsonl");

const dirs: string[] = [];
function tempOutDir(): string {
  const d = mkdtempSync(join(tmpdir(), "gonogo-demo-test-"));
  dirs.push(d);
  return join(d, "out");
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A backend that fails the test if it is ever actually invoked. */
function throwingSpy(name = "claude-cli"): JudgeBackend & { calls: number } {
  return {
    name,
    requestedModel: DEMO_MODEL,
    calls: 0,
    async invoke(_promptFile: string, _attachments: Attachment[]): Promise<JudgeResponse> {
      this.calls++;
      throw new Error("backend.invoke must not be called by the replay demo");
    },
  };
}

describe("runDemo", () => {
  test("renders a verdict from the recorded receipt without calling the backend", async () => {
    const outDir = tempOutDir();
    const spy = throwingSpy();

    const { verdictFile, verdictPath, htmlPath } = await runDemo({
      fixtureDir: FIXTURE_DIR,
      promptsDir: PROMPTS_DIR,
      replayDir: REPLAY_DIR,
      outDir,
      backend: spy,
    });

    expect(spy.calls).toBe(0);
    expect(existsSync(verdictPath)).toBe(true);
    expect(existsSync(htmlPath)).toBe(true);

    expect(verdictFile.provenance.gonogo_version).toBe(GONOGO_VERSION);
    expect(verdictFile.subject_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(verdictFile.provenance.replayed).toBe(true);
    expect(verdictFile.provenance.pass_sources).toEqual({ blind: "cache", rubric: "cache" });
    expect(verdictFile.provenance.model_version).toBe(DEMO_MODEL);

    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("<html");
  });

  test("fails with the existing replay-miss diagnostic and calls the backend zero times", async () => {
    const outDir = tempOutDir();
    const emptyReplayDir = mkdtempSync(join(tmpdir(), "gonogo-demo-empty-replay-"));
    dirs.push(emptyReplayDir);
    const spy = throwingSpy();

    await expect(
      runDemo({
        fixtureDir: FIXTURE_DIR,
        promptsDir: PROMPTS_DIR,
        replayDir: emptyReplayDir,
        outDir,
        backend: spy,
      }),
    ).rejects.toThrow(/no cache entry|replay/i);

    expect(spy.calls).toBe(0);
    expect(existsSync(outDir)).toBe(false);
    expect(existsSync(join(outDir, "verdict.json"))).toBe(false);
    expect(existsSync(join(outDir, "verdict.html"))).toBe(false);
  });

  test("does not append to or otherwise change the root event log", async () => {
    const before = readFileSync(ROOT_EVENTS_PATH, "utf8");
    const outDir = tempOutDir();

    await runDemo({
      fixtureDir: FIXTURE_DIR,
      promptsDir: PROMPTS_DIR,
      replayDir: REPLAY_DIR,
      outDir,
      backend: throwingSpy(),
    });

    const after = readFileSync(ROOT_EVENTS_PATH, "utf8");
    expect(after).toBe(before);
  });
});
