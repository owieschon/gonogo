/** Measures the judge, not the agent: accuracy against labels, and variance. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type { Dimension, VerdictFile } from "./types.ts";
import { collectEvidence } from "./evidence.ts";
import { runJudge } from "./rubric.ts";
import { makeBackend } from "./judges/index.ts";
import { listFixtures, materialize, type Fixture } from "./fixtures.ts";

export interface EvalOptions {
  fixturesDir: string;
  promptsDir: string;
  backend: string;
  k: number;
  replay: boolean;
  only?: string;
  writeReplay: boolean;
}

interface RunRecord {
  fixture: string;
  k: number;
  verdict: VerdictFile;
}

interface FailedRun {
  fixture: string;
  k: number;
  error: string;
}

function replayPath(fx: Fixture, k: number): string {
  return join(fx.dir, "replay", `run-${k}.json`);
}

async function oneRun(fx: Fixture, k: number, o: EvalOptions): Promise<VerdictFile> {
  if (o.replay) {
    const p = replayPath(fx, k);
    if (!existsSync(p)) {
      throw new Error(
        `--replay needs ${p}, which is not committed. Run \`gonogo eval --write-replay\` ` +
          `with a live judge to regenerate the recorded verdicts.`,
      );
    }
    return JSON.parse(readFileSync(p, "utf8")) as VerdictFile;
  }
  const m = materialize(fx);
  try {
    const ev = collectEvidence({
      repo: m.repo,
      base: m.base,
      spec: fx.spec,
      transcriptPath: fx.transcriptPath,
      testCmd: fx.testCmd,
    });
    const { verdictFile } = await runJudge(ev, makeBackend(o.backend), o.promptsDir);
    if (o.writeReplay) {
      mkdirSync(join(fx.dir, "replay"), { recursive: true });
      // Fixture repos live in a fresh mkdtemp each run; scrub the path so
      // committed replay verdicts are byte-stable across machines.
      const scrubbed: VerdictFile = {
        ...verdictFile,
        provenance: { ...verdictFile.provenance, repo: `fixtures/${fx.name} (materialized)` },
      };
      writeFileSync(replayPath(fx, k), JSON.stringify(scrubbed, null, 2) + "\n");
    }
    return verdictFile;
  } finally {
    m.cleanup();
  }
}

function scoreOf(v: VerdictFile, d: Dimension): number | "abstain" {
  const r = v.dimensions[d];
  return r.score === "abstain" ? "abstain" : (r.score as number);
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export interface EvalReport {
  text: string;
  markdown: string;
  passedCoreChecks: boolean;
  /** Runs that produced no verdict at all. Non-zero fails the command. */
  hardFailures: number;
  dimensionAccuracy: Record<string, number>;
  verdictAccuracy: number;
}

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  let fixtures = listFixtures(o.fixturesDir);
  if (o.only) fixtures = fixtures.filter((f) => f.name === o.only);
  if (fixtures.length === 0) throw new Error(`no fixtures found in ${o.fixturesDir}`);

  const runs: RunRecord[] = [];
  const failed: FailedRun[] = [];
  const t0 = Date.now();
  for (const fx of fixtures) {
    for (let k = 1; k <= o.k; k++) {
      process.stderr.write(`  ${o.replay ? "replay" : "judge"} ${fx.name} run ${k}/${o.k}\n`);
      // One unrecoverable run must not cost the other seventeen. Record it and
      // keep going; it is reported below and fails the command at the end.
      try {
        runs.push({ fixture: fx.name, k, verdict: await oneRun(fx, k, o) });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`    run failed: ${msg.split("\n")[0]}\n`);
        failed.push({ fixture: fx.name, k, error: msg });
      }
    }
  }
  const wallMs = Date.now() - t0;
  if (runs.length === 0) {
    throw new Error(`every run failed. First error:\n${failed[0]?.error ?? "unknown"}`);
  }

  const hit: Record<string, { ok: number; total: number; abstain: number }> = {};
  for (const d of DIMENSIONS) hit[d] = { ok: 0, total: 0, abstain: 0 };
  let verdictOk = 0;

  const lines: string[] = [];
  const NAME_W = 18;
  lines.push(
    pad("fixture", NAME_W) +
      DIMENSIONS.map((d) => padL(d.slice(0, 9), 11)).join("") +
      padL("verdicts (k runs)", 26),
  );
  lines.push("-".repeat(NAME_W + 11 * DIMENSIONS.length + 26));

  const perFixtureSpread: number[] = [];

  for (const fx of fixtures) {
    const rs = runs.filter((r) => r.fixture === fx.name);
    const cells: string[] = [];
    for (const d of DIMENSIONS) {
      const scores = rs.map((r) => scoreOf(r.verdict, d));
      const range = fx.labels.dimensions[d];
      let ok = 0;
      for (const s of scores) {
        hit[d]!.total++;
        if (s === "abstain") {
          hit[d]!.abstain++;
          continue;
        }
        if (range && s >= range[0] && s <= range[1]) {
          ok++;
          hit[d]!.ok++;
        }
      }
      const nums = scores.filter((s): s is number => s !== "abstain");
      perFixtureSpread.push(nums.length ? Math.max(...nums) - Math.min(...nums) : 0);
      const shown = scores.map((s) => (s === "abstain" ? "A" : String(s))).join("");
      cells.push(padL(`${shown} ${ok}/${scores.length}`, 11));
    }
    const verdicts = rs.map((r) => r.verdict.verdict);
    for (const v of verdicts) if (fx.labels.expected_verdicts.includes(v)) verdictOk++;
    lines.push(pad(fx.name, NAME_W) + cells.join("") + padL(verdicts.join(", "), 26));
  }

  lines.push("");
  lines.push("per-dimension accuracy vs. labels");
  for (const d of DIMENSIONS) {
    const h = hit[d]!;
    lines.push(
      `  ${pad(d, 20)} ${padL(`${h.ok}/${h.total}`, 7)}  ${padL(
        ((100 * h.ok) / h.total).toFixed(0) + "%",
        5,
      )}${h.abstain ? `   (${h.abstain} abstention${h.abstain === 1 ? "" : "s"})` : ""}`,
    );
  }
  const verdictAcc = verdictOk / runs.length;
  lines.push(
    `  ${pad("overall verdict", 20)} ${padL(`${verdictOk}/${runs.length}`, 7)}  ${padL(
      (100 * verdictAcc).toFixed(0) + "%",
      5,
    )}`,
  );

  lines.push("");
  lines.push(`variance across k=${o.k} runs (same fixture, same prompts)`);
  for (const fx of fixtures) {
    const rs = runs.filter((r) => r.fixture === fx.name);
    const per = DIMENSIONS.map((d) => {
      const nums = rs
        .map((r) => scoreOf(r.verdict, d))
        .filter((s): s is number => s !== "abstain");
      return { d, spread: nums.length ? Math.max(...nums) - Math.min(...nums) : 0, sd: stdev(nums) };
    });
    const unstable = per.filter((p) => p.spread > 0);
    const verdicts = new Set(rs.map((r) => r.verdict.verdict));
    lines.push(
      `  ${pad(fx.name, 18)} verdict ${verdicts.size === 1 ? "stable" : `UNSTABLE (${[...verdicts].join("/")})`}` +
        (unstable.length
          ? `; score spread: ${unstable.map((p) => `${p.d} ±${p.spread}`).join(", ")}`
          : "; scores identical across runs"),
    );
  }
  const meanSpread =
    perFixtureSpread.reduce((a, b) => a + b, 0) / Math.max(1, perFixtureSpread.length);
  lines.push(`  mean per-dimension score spread: ${meanSpread.toFixed(2)} points`);

  // Named assertions from labels.json — the behaviours the fixtures exist to pin.
  lines.push("");
  lines.push("core checks");
  let allPassed = true;
  for (const fx of fixtures) {
    for (const c of fx.labels.core_checks ?? []) {
      const rs = runs.filter((r) => r.fixture === fx.name);
      const results = rs.map((r) => {
        const s = scoreOf(r.verdict, c.dimension as Dimension);
        if (s === "abstain") return false;
        if (c.max !== undefined && s > c.max) return false;
        if (c.min !== undefined && s < c.min) return false;
        return true;
      });
      const passed = results.every(Boolean);
      if (!passed) allPassed = false;
      lines.push(
        `  [${passed ? "PASS" : "FAIL"}] ${pad(c.id, 34)} ${results.filter(Boolean).length}/${
          results.length
        } runs — ${c.why}`,
      );
    }
  }

  const retries = runs.reduce(
    (a, r) => a + (r.verdict.provenance.rubric_parse_retries ?? 0),
    0,
  );
  if (retries > 0 || failed.length > 0) {
    lines.push("");
    lines.push("judge output reliability");
    lines.push(
      `  ${retries} rubric-pass repl${retries === 1 ? "y" : "ies"} discarded as unparseable and ` +
        `re-asked, across ${runs.length} completed run(s)`,
    );
    for (const f of failed) {
      lines.push(`  [RUN FAILED] ${f.fixture} run ${f.k}: ${f.error.split("\n")[0]}`);
    }
  }

  const costs = runs
    .map((r) => r.verdict.provenance.cost_usd)
    .filter((c): c is number => typeof c === "number");
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const judgeMs = runs.reduce((a, r) => a + r.verdict.provenance.duration_ms, 0);
  lines.push("");
  lines.push(
    `${runs.length} runs (${fixtures.length} fixtures × k=${o.k})` +
      `${o.replay ? " — REPLAY MODE, no judge was invoked" : ""}`,
  );
  lines.push(
    `wall time ${(wallMs / 1000).toFixed(1)}s · judge time ${(judgeMs / 1000).toFixed(1)}s · ` +
      `cost ${o.replay ? "$0.0000 (replayed)" : "$" + totalCost.toFixed(4)}` +
      (o.replay ? ` (recorded runs cost $${totalCost.toFixed(4)})` : ""),
  );

  const text = lines.join("\n");
  const dimensionAccuracy: Record<string, number> = {};
  for (const d of DIMENSIONS) dimensionAccuracy[d] = hit[d]!.ok / hit[d]!.total;

  return {
    text,
    markdown: "```\n" + text + "\n```",
    passedCoreChecks: allPassed,
    hardFailures: failed.length,
    dimensionAccuracy,
    verdictAccuracy: verdictAcc,
  };
}
