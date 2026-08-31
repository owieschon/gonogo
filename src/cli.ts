#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectEvidence, writeEvidence } from "./evidence.ts";
import { runJudge } from "./rubric.ts";
import { renderHtml } from "./report.ts";
import { runEval } from "./eval.ts";
import { runCalibrate } from "./calibrate.ts";
import { makeBackend } from "./judges/index.ts";
import { GONOGO_VERSION } from "./version.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `gonogo ${GONOGO_VERSION} — independent verdicts on completed agent tasks

  gonogo judge --spec <file|string> --repo <path> [--base main]
                [--transcript <file>] [--test-cmd <string>]
                [--judge claude] [--out <dir>] [--quiet]

  gonogo eval [--k 3] [--replay] [--write-replay] [--only <fixture>]
              [--judge claude] [--markdown]

  gonogo calibrate [--dir <path> ...]

Flags:
  --spec        the task prompt the agent was given; a path if it exists, else literal text
  --repo        repository the agent worked in (default: .)
  --base        git ref to diff against (default: main)
  --transcript  session log; treated as opaque text
  --test-cmd    shell command run in --repo; exit code and output become evidence
  --judge       backend name: claude (implemented), codex, qwen (stubs)
  --out         where to write the run directory (default: <repo>/runs/<timestamp>)
  --k           runs per fixture for eval (default 3)
  --replay      score committed fixture verdicts instead of invoking a judge
  --write-replay  overwrite the committed replay verdicts with this live run
`;

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] };
  const multi: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      (args._ as string[]).push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      (multi[key] ??= []).push(next);
      args[key] = next;
      i++;
    }
  }
  for (const [k, v] of Object.entries(multi)) if (v.length > 1) args[k] = v;
  return args;
}

function str(args: Args, key: string, fallback?: string): string | undefined {
  const v = args[key];
  if (v === undefined) return fallback;
  if (typeof v === "boolean") return fallback;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "Z");
}

function die(msg: string): never {
  console.error(`gonogo: ${msg}`);
  process.exit(2);
}

async function cmdJudge(args: Args): Promise<void> {
  const specArg = str(args, "spec");
  if (!specArg) die("--spec is required (a file path, or the prompt text itself)");
  // A path if it resolves; otherwise the flag value is the spec.
  const spec = existsSync(specArg!) ? readFileSync(specArg!, "utf8") : specArg!;

  const repo = resolve(str(args, "repo", ".")!);
  const base = str(args, "base", "main")!;
  const backendName = str(args, "judge", "claude")!;
  const quiet = args.quiet === true;

  const log = (s: string) => {
    if (!quiet) process.stderr.write(s + "\n");
  };

  log(`gonogo ${GONOGO_VERSION}  repo=${repo}  base=${base}  judge=${backendName}`);
  log("collecting evidence...");
  const ev = collectEvidence({
    repo,
    base,
    spec,
    transcriptPath: str(args, "transcript"),
    testCmd: str(args, "test-cmd"),
  });
  if (ev.diff.trim() === "") die(`no diff between ${base} and the working tree of ${repo}`);
  log(`  ${ev.changedFiles.length} changed file(s), ${ev.diff.length} chars of diff`);
  if (ev.test) log(`  test command exited ${ev.test.exitCode}`);

  const outDir = resolve(str(args, "out", join(repo, "runs", timestamp()))!);
  mkdirSync(outDir, { recursive: true });
  writeEvidence(join(outDir, "evidence"), ev);

  log("blind pass (diff + transcript only, no spec)...");
  log("rubric pass (spec + all evidence)...");
  const { verdictFile, raw } = await runJudge(ev, makeBackend(backendName), join(ROOT, "prompts"));

  writeFileSync(join(outDir, "verdict.json"), JSON.stringify(verdictFile, null, 2) + "\n");
  writeFileSync(join(outDir, "verdict.html"), renderHtml(verdictFile));
  writeFileSync(join(outDir, "evidence", "raw-blind-pass.txt"), raw.blind);
  writeFileSync(join(outDir, "evidence", "raw-rubric-pass.txt"), raw.rubric);

  const d = verdictFile.dimensions;
  const cell = (k: keyof typeof d) => (d[k].score === "abstain" ? "abstain" : String(d[k].score));
  console.log("");
  console.log(`  VERDICT: ${verdictFile.verdict.toUpperCase()}   overall ${
    verdictFile.overall_score ?? "—"
  }/4 (min across dimensions)`);
  console.log(`    task_satisfaction  ${cell("task_satisfaction")}`);
  console.log(`    scope_discipline   ${cell("scope_discipline")}`);
  console.log(`    claim_verification ${cell("claim_verification")}`);
  console.log(`    goal_alignment     ${cell("goal_alignment")}`);
  console.log(`    (spec_clarity ${
    verdictFile.spec_clarity.score === "abstain" ? "abstain" : verdictFile.spec_clarity.score
  }, judge_confidence ${verdictFile.judge_confidence.toFixed(2)})`);
  console.log("");
  console.log(`  ${verdictFile.summary}`);
  console.log("");
  console.log(`  ${join(outDir, "verdict.json")}`);
  console.log(`  ${join(outDir, "verdict.html")}`);
}

async function cmdEval(args: Args): Promise<void> {
  const k = Number(str(args, "k", "3"));
  if (!Number.isInteger(k) || k < 1) die("--k must be a positive integer");
  const report = await runEval({
    fixturesDir: join(ROOT, "fixtures"),
    promptsDir: join(ROOT, "prompts"),
    backend: str(args, "judge", "claude")!,
    k,
    replay: args.replay === true,
    writeReplay: args["write-replay"] === true,
    only: str(args, "only"),
  });
  console.log("");
  console.log(args.markdown === true ? report.markdown : report.text);
  console.log("");
  if (!report.passedCoreChecks) {
    console.error("gonogo eval: core checks FAILED — the judge missed a case it must catch.");
    process.exit(1);
  }
}

function cmdCalibrate(args: Args): void {
  const explicit = args.dir;
  const dirs = explicit
    ? (Array.isArray(explicit) ? explicit : [String(explicit)]).map((d) => resolve(d))
    : [join(ROOT, "runs"), join(ROOT, "calibration", "synthetic")];
  console.log("");
  console.log(runCalibrate(dirs));
  console.log("");
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

try {
  switch (cmd) {
    case "judge":
      await cmdJudge(args);
      break;
    case "eval":
      await cmdEval(args);
      break;
    case "calibrate":
      cmdCalibrate(args);
      break;
    case "--version":
    case "version":
      console.log(GONOGO_VERSION);
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      break;
    default:
      die(`unknown command "${cmd}". Run \`gonogo help\`.`);
  }
} catch (err) {
  console.error(`gonogo: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
