#!/usr/bin/env bun
/**
 * Renders a sample verdict from a committed replay receipt. No credentials,
 * no live judge call: `runDemo` replays the recorded claude-sonnet-5 output
 * for fixtures/merged-but-wrong, sample 1.
 *
 *   bun run demo [output directory]   # default: ./demo-out
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_FIXTURE, runDemo } from "../src/demo.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(ROOT, "demo-out"));

try {
  const { verdictFile, verdictPath, htmlPath } = await runDemo({
    fixtureDir: join(ROOT, "fixtures", DEMO_FIXTURE),
    promptsDir: join(ROOT, "prompts"),
    replayDir: join(ROOT, "replay"),
    outDir,
  });
  console.log(`gonogo demo — replayed verdict for fixtures/${DEMO_FIXTURE} (claude-sonnet-5, sample 1)`);
  console.log(`  verdict: ${verdictFile.verdict}`);
  console.log(`  ${verdictPath}`);
  console.log(`  ${htmlPath}`);
} catch (err) {
  console.error(`gonogo demo: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
