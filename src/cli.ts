#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertKnownFlags, parseArgs, str } from "./args.ts";
import type { Args } from "./args.ts";
import { collectEvidence, writeEvidence } from "./evidence.ts";
import { runJudge } from "./rubric.ts";
import { renderHtml } from "./report.ts";
import { runEval } from "./eval.ts";
import { runCalibrate } from "./calibrate.ts";
import { fileCallEvidenceSink } from "./call-receipts.ts";
import { makeBackend } from "./judges/index.ts";
import {
  EVENT_SCHEMA_VERSION,
  appendEvent,
  isIso8601Timestamp,
  isJudgeEvent,
  readEvents,
  requireOutcomeRun,
} from "./events.ts";
import type { Disclosure, OutcomeEvent, OutcomeState } from "./events.ts";
import { GONOGO_VERSION } from "./version.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EVENTS = join(ROOT, "events.jsonl");
const DEFAULT_CACHE = join(ROOT, "replay");

/**
 * Exit codes are the whole integration surface. No --gate flag, no CI features:
 * anything that wants to act on a verdict reads `$?`.
 */
const EXIT = { go: 0, noGo: 1, inconclusive: 2, toolError: 3 } as const;

const USAGE = `gonogo ${GONOGO_VERSION} — independent verdicts on completed agent tasks

  gonogo judge --spec <file|string> --repo <path> [--base main]
                [--transcript <file>] [--test-cmd <string>] [--judge claude]
                [--task <id>] [--workspace <id>] [--disclosure none|mentioned]
                [--record] [--replay] [--out <dir>] [--max-diff-chars N] [--quiet]

  gonogo eval [--k 3] [--replay] [--record] [--only <fixture>]
              [--judge claude] [--markdown]

  gonogo calibrate [--repo <path>] [--dir <path> ...]

  gonogo outcome --task <id> --pr <url> --state merged|closed|abandoned
                 [--run <run_id>] [--merged-at <iso8601>]

Flags:
  --spec        the task prompt the agent was given; a path if it exists, else literal text
  --repo        repository the agent worked in (default: .)
  --base        git ref to diff against (default: main)
  --transcript  session log; treated as opaque text
  --test-cmd    shell command run in --repo; exit code and output become evidence
  --judge       backend name: claude (implemented), codex, qwen (stubs)
  --task        operator-assigned id grouping runs that attack the same task
  --workspace   opaque workspace id, recorded for later joins
  --disclosure  whether the worker was told its output would be judged (default: none)
  --record      write raw judge output to the replay cache
  --replay      serve raw judge output from the replay cache; no judge is invoked
  --out         where to write the run directory (default: <repo>/runs/<timestamp>)
  --max-diff-chars  elide the diff beyond this many characters (default 120000)
  --events      append-only event log (default: <gonogo>/events.jsonl)
  --run         stable run id used to join a verdict, human rating and outcome
  --k           runs per fixture for eval (default 3)

Exit codes: 0 go or go-with-notes, 1 hold or no-go, 2 inconclusive, 3 tool error.
`;

const BOOLEAN_FLAGS = new Set(["record", "replay", "quiet", "markdown"]);
const MULTI_FLAGS = new Set(["dir"]);
const COMMAND_FLAGS: Record<string, ReadonlySet<string>> = {
  judge: new Set([
    "spec", "repo", "base", "transcript", "test-cmd", "judge", "task", "workspace",
    "disclosure", "record", "replay", "out", "max-diff-chars", "events", "run", "quiet",
  ]),
  eval: new Set(["k", "replay", "record", "only", "judge", "markdown", "events"]),
  calibrate: new Set(["dir", "repo", "events"]),
  outcome: new Set(["task", "pr", "state", "run", "merged-at", "events"]),
  help: new Set(),
  "--help": new Set(),
  "-h": new Set(),
  version: new Set(),
  "--version": new Set(),
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function die(msg: string): never {
  console.error(`gonogo: ${msg}`);
  process.exit(EXIT.toolError);
}

function cacheMode(args: Args): void {
  if (args.record === true && args.replay === true) {
    die("--record and --replay are mutually exclusive");
  }
}

function specText(specArg: string): string {
  if (existsSync(specArg)) return readFileSync(specArg, "utf8");
  const pathLike = !/\s/.test(specArg) && (
    specArg.startsWith("/") || specArg.startsWith("./") || specArg.startsWith("../") ||
    specArg.startsWith("~/") || /\.(md|txt)$/i.test(specArg)
  );
  if (pathLike) {
    die(`spec file "${specArg}" does not exist; pass a valid path or literal prompt text`);
  }
  return specArg;
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function maxDiffChars(args: Args): number | undefined {
  const raw = str(args, "max-diff-chars");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) die("--max-diff-chars must be an integer >= 1000");
  return n;
}

function eventsPath(args: Args): string {
  return resolve(str(args, "events", DEFAULT_EVENTS)!);
}

function disclosureOf(args: Args): Disclosure {
  const raw = str(args, "disclosure", "none")!;
  if (raw !== "none" && raw !== "mentioned") {
    die(`--disclosure must be "none" or "mentioned", got "${raw}"`);
  }
  return raw;
}

/** The verdict is the exit status. See EXIT above. */
function exitCodeFor(verdict: string): number {
  if (verdict === "go" || verdict === "go-with-notes") return EXIT.go;
  if (verdict === "inconclusive") return EXIT.inconclusive;
  return EXIT.noGo;
}

async function cmdJudge(args: Args): Promise<number> {
  cacheMode(args);
  const specArg = str(args, "spec");
  if (!specArg) die("--spec is required (a file path, or the prompt text itself)");
  const spec = specText(specArg);

  const repo = resolve(str(args, "repo", ".")!);
  const base = str(args, "base", "main")!;
  const backendName = str(args, "judge", "claude")!;
  const quiet = args.quiet === true;

  const log = (s: string) => {
    if (!quiet) process.stderr.write(s + "\n");
  };

  const stamp = timestamp();
  const runsRoot = join(repo, "runs");
  const outDir = resolve(str(args, "out", join(runsRoot, stamp))!);
  const judgeEventsPath = eventsPath(args);
  const runId = str(args, "run", stamp)!;
  if (runId.trim() === "") die("--run must be a non-empty id");
  const existingLog = readEvents(judgeEventsPath);
  if (existingLog.malformed > 0) {
    die(`${judgeEventsPath} contains ${existingLog.malformed} malformed event line(s); repair the log before judging`);
  }
  if (existingLog.events.some((event) => isJudgeEvent(event) && event.run_id === runId)) {
    die(`judge run_id "${runId}" already exists in ${judgeEventsPath}`);
  }
  if (outDir === repo) die("--out cannot be the repository root");
  const excludedRoots = [runsRoot];
  if (inside(repo, outDir)) excludedRoots.push(outDir);
  if (inside(repo, DEFAULT_CACHE)) excludedRoots.push(DEFAULT_CACHE);
  if (inside(repo, judgeEventsPath)) excludedRoots.push(judgeEventsPath);

  log(`gonogo ${GONOGO_VERSION}  repo=${repo}  base=${base}  judge=${backendName}`);
  log("collecting evidence...");
  const ev = collectEvidence({
    repo,
    base,
    spec,
    transcriptPath: str(args, "transcript"),
    testCmd: str(args, "test-cmd"),
    maxDiffChars: maxDiffChars(args),
    excludeUntrackedRoots: excludedRoots,
  });
  if (ev.diff.trim() === "") die(`no diff between ${base} and the working tree of ${repo}`);
  log(`  ${ev.changedFiles.length} changed file(s), ${ev.diff.length} chars of diff`);
  if (ev.truncated.diff) {
    log("  WARNING: the diff was elided to fit --max-diff-chars; this verdict is partial");
  }
  if (ev.test) log(`  test command exited ${ev.test.exitCode}`);

  mkdirSync(outDir, { recursive: true });
  writeEvidence(join(outDir, "evidence"), ev);

  log("blind pass (diff + transcript only, no spec)...");
  log("rubric pass (spec + all evidence)...");
  const { verdictFile, raw } = await runJudge(ev, makeBackend(backendName), join(ROOT, "prompts"), {
    eventsPath: judgeEventsPath,
    runId,
    kind: "real",
    taskId: str(args, "task") ?? null,
    workspaceId: str(args, "workspace") ?? null,
    disclosure: disclosureOf(args),
    replayDir: args.replay === true ? DEFAULT_CACHE : undefined,
    recordDir: args.record === true ? DEFAULT_CACHE : undefined,
    callEvidenceSink: fileCallEvidenceSink(join(outDir, "evidence")),
  });

  writeFileSync(join(outDir, "verdict.json"), JSON.stringify(verdictFile, null, 2) + "\n");
  writeFileSync(join(outDir, "verdict.html"), renderHtml(verdictFile));
  writeFileSync(join(outDir, "evidence", "raw-blind-pass.txt"), raw.blind);
  writeFileSync(join(outDir, "evidence", "raw-rubric-pass.txt"), raw.rubric);
  if (raw.citation_repair !== undefined) {
    writeFileSync(join(outDir, "evidence", "raw-citation-repair.txt"), raw.citation_repair);
  }
  if (raw.gaming_citation_repair !== undefined) {
    writeFileSync(
      join(outDir, "evidence", "raw-gaming-citation-repair.txt"),
      raw.gaming_citation_repair,
    );
  }

  const d = verdictFile.dimensions;
  const cell = (k: keyof typeof d) => (d[k].score === "abstain" ? "abstain" : String(d[k].score));
  console.log("");
  console.log(
    `  VERDICT: ${verdictFile.verdict.toUpperCase()}   overall ${
      verdictFile.overall_score ?? "—"
    }/4 (min across dimensions)`,
  );
  console.log(`    task_satisfaction  ${cell("task_satisfaction")}`);
  console.log(`    scope_discipline   ${cell("scope_discipline")}`);
  console.log(`    claim_verification ${cell("claim_verification")}`);
  console.log(`    goal_alignment     ${cell("goal_alignment")}`);
  console.log(
    `    (spec_clarity ${
      verdictFile.spec_clarity.score === "abstain" ? "abstain" : verdictFile.spec_clarity.score
    }, judge_confidence ${verdictFile.judge_confidence.toFixed(2)}, drift_type ${
      verdictFile.drift_type
    })`,
  );
  if (verdictFile.attempted_gaming) {
    console.log("");
    console.log("  ATTEMPTED GAMING: the evidence contained instructions aimed at the judge.");
    for (const g of verdictFile.gaming_evidence) console.log(`    ${g}`);
  }
  console.log("");
  console.log(`  ${verdictFile.summary}`);
  console.log("");
  console.log(`  ${join(outDir, "verdict.json")}`);
  console.log(`  ${join(outDir, "verdict.html")}`);
  return exitCodeFor(verdictFile.verdict);
}

async function cmdEval(args: Args): Promise<number> {
  cacheMode(args);
  const k = Number(str(args, "k", "3"));
  if (!Number.isInteger(k) || k < 1) die("--k must be a positive integer");
  const report = await runEval({
    fixturesDir: join(ROOT, "fixtures"),
    promptsDir: join(ROOT, "prompts"),
    eventsPath: eventsPath(args),
    cacheDir: DEFAULT_CACHE,
    backend: str(args, "judge", "claude")!,
    k,
    replay: args.replay === true,
    record: args.record === true,
    only: str(args, "only"),
  });
  console.log("");
  console.log(args.markdown === true ? report.markdown : report.text);
  console.log("");
  if (report.hardFailures > 0) {
    console.error(
      `gonogo eval: ${report.hardFailures} run(s) produced no verdict at all. See above.`,
    );
    return EXIT.noGo;
  }
  if (!report.passedCoreChecks) {
    console.error("gonogo eval: core checks FAILED — the judge missed a case it must catch.");
    return EXIT.noGo;
  }
  if (!report.passedQualityGate) {
    console.error("gonogo eval: quality gate FAILED — accuracy fell below the documented CI floor.");
    return EXIT.noGo;
  }
  return EXIT.go;
}

function cmdCalibrate(args: Args): number {
  const explicit = args.dir;
  const repo = resolve(str(args, "repo", ".")!);
  const calibrationEvents = resolve(str(args, "events", join(repo, "events.jsonl"))!);
  const dirs = explicit
    ? (Array.isArray(explicit) ? explicit : [String(explicit)]).map((d) => resolve(d))
    : [join(repo, "runs"), join(repo, "calibration"), join(ROOT, "calibration", "synthetic")];
  console.log("");
  console.log(runCalibrate({ eventsPath: calibrationEvents, dirs }));
  console.log("");
  return EXIT.go;
}

/** What happened to the work in the end. Recorded by hand; no GitHub API. */
function cmdOutcome(args: Args): number {
  const taskId = str(args, "task");
  const prUrl = str(args, "pr");
  const state = str(args, "state");
  if (!taskId) die("--task is required");
  if (!prUrl) die("--pr is required");
  if (state !== "merged" && state !== "closed" && state !== "abandoned") {
    die(`--state must be merged, closed or abandoned, got "${state ?? "nothing"}"`);
  }
  const runId = str(args, "run") ?? null;
  const mergedAt = str(args, "merged-at") ?? null;
  if (state !== "merged" && mergedAt !== null) die("--merged-at is only valid for a merged outcome");
  if (mergedAt !== null && !isIso8601Timestamp(mergedAt)) {
    die("--merged-at must be an ISO-8601 timestamp");
  }
  const path = eventsPath(args);
  if (runId !== null) {
    const { events, malformed } = readEvents(path);
    if (malformed > 0) die(`${path} contains ${malformed} malformed event line(s); repair the log before joining an outcome`);
    try {
      requireOutcomeRun(events, runId, taskId);
    } catch (error) {
      die(`${error instanceof Error ? error.message : String(error)} in ${path}`);
    }
  }
  const event: OutcomeEvent = {
    schema_version: EVENT_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    kind: "outcome",
    gonogo_version: GONOGO_VERSION,
    task_id: taskId,
    run_id: runId,
    pr_url: prUrl,
    state: state as OutcomeState,
    merged_at: mergedAt ?? (state === "merged" ? new Date().toISOString() : null),
  };
  appendEvent(path, event);
  console.log(`recorded outcome ${state} for task ${taskId} in ${path}`);
  return EXIT.go;
}

const argv = process.argv.slice(2);
const cmd = argv[0];

try {
  const args = parseArgs(argv.slice(1), { booleanFlags: BOOLEAN_FLAGS, multiFlags: MULTI_FLAGS });
  assertKnownFlags(args, COMMAND_FLAGS[cmd ?? "help"] ?? new Set());
  let code: number = EXIT.go;
  switch (cmd) {
    case "judge":
      code = await cmdJudge(args);
      break;
    case "eval":
      code = await cmdEval(args);
      break;
    case "calibrate":
      code = cmdCalibrate(args);
      break;
    case "outcome":
      code = cmdOutcome(args);
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
  process.exit(code);
} catch (err) {
  console.error(`gonogo: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(EXIT.toolError);
}
