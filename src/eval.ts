/**
 * Measures the judge, not the agent.
 *
 * The sweep runs the judge over the fixtures, appending one event per run to
 * events.jsonl; the table is then computed by reading those events back out of
 * the log. That indirection is deliberate — the log is the substrate, and a
 * reporting path that bypassed it would be a second source of truth.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type { Dimension } from "./types.ts";
import { collectEvidence } from "./evidence.ts";
import { runJudge } from "./rubric.ts";
import { makeBackend } from "./judges/index.ts";
import { readEvents, isJudgeEvent } from "./events.ts";
import type { JudgeEvent } from "./events.ts";
import { listFixtures, materialize, type Fixture } from "./fixtures.ts";

export interface EvalOptions {
  fixturesDir: string;
  promptsDir: string;
  eventsPath: string;
  cacheDir: string;
  backend: string;
  k: number;
  replay: boolean;
  record: boolean;
  only?: string;
  /** Report the numbers without failing on them. */
  noGate?: boolean;
}

interface Thresholds {
  min_dimension_accuracy?: Record<string, number>;
  min_verdict_accuracy?: number;
  min_drift_accuracy?: number;
}

function loadThresholds(fixturesDir: string): Thresholds | null {
  const p = join(fixturesDir, "thresholds.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Thresholds;
}

interface FailedRun {
  fixture: string;
  k: number;
  error: string;
}

function runIdFor(fixture: string, k: number, stamp: string): string {
  return `eval-${stamp}-${fixture}-k${k}`;
}

async function oneRun(fx: Fixture, k: number, stamp: string, o: EvalOptions): Promise<void> {
  const m = materialize(fx);
  try {
    const ev = collectEvidence({
      repo: m.repo,
      base: m.base,
      spec: fx.spec,
      transcriptPath: fx.transcriptPath,
      testCmd: fx.testCmd,
    });
    await runJudge(ev, makeBackend(o.backend), o.promptsDir, {
      sample: k,
      replayDir: o.replay ? o.cacheDir : undefined,
      recordDir: o.record ? o.cacheDir : undefined,
      eventsPath: o.eventsPath,
      runId: runIdFor(fx.name, k, stamp),
      kind: "fixture",
      fixtureId: fx.name,
    });
  } finally {
    m.cleanup();
  }
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
  hardFailures: number;
  /** Aggregate floors from fixtures/thresholds.json that this run fell below. */
  gateFailures: string[];
  dimensionAccuracy: Record<string, number>;
  verdictAccuracy: number;
}

export async function runEval(o: EvalOptions): Promise<EvalReport> {
  let fixtures = listFixtures(o.fixturesDir);
  if (o.only) fixtures = fixtures.filter((f) => f.name === o.only);
  if (fixtures.length === 0) throw new Error(`no fixtures found in ${o.fixturesDir}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const failed: FailedRun[] = [];
  const wanted = new Set<string>();
  const t0 = Date.now();

  for (const fx of fixtures) {
    for (let k = 1; k <= o.k; k++) {
      process.stderr.write(`  ${o.replay ? "replay" : "judge"} ${fx.name} run ${k}/${o.k}\n`);
      // One unrecoverable run must not cost the other seventeen. Record it and
      // keep going; it is reported below and fails the command at the end.
      try {
        await oneRun(fx, k, stamp, o);
        wanted.add(runIdFor(fx.name, k, stamp));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`    run failed: ${msg.split("\n")[0]}\n`);
        failed.push({ fixture: fx.name, k, error: msg });
      }
    }
  }
  const wallMs = Date.now() - t0;

  // Read the sweep back out of the log. Everything below is a report over
  // events, not over in-memory results.
  const { events, malformed } = readEvents(o.eventsPath);
  const runs = events.filter(
    (e): e is JudgeEvent => isJudgeEvent(e) && wanted.has(e.run_id),
  );
  if (runs.length === 0) {
    throw new Error(
      `no judge events for this sweep in ${o.eventsPath}. First error:\n${
        failed[0]?.error ?? "unknown"
      }`,
    );
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
    const rs = runs.filter((r) => r.fixture_id === fx.name);
    if (rs.length === 0) {
      lines.push(pad(fx.name, NAME_W) + "  (no completed runs)");
      continue;
    }
    const cells: string[] = [];
    for (const d of DIMENSIONS) {
      const scores = rs.map((r) => r.scores[d] ?? "abstain");
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
    const verdicts = rs.map((r) => r.verdict);
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

  // drift_type is a classification the judge already makes implicitly. Fixtures
  // that carry an expected value have it checked here.
  const labelled = fixtures.filter((f) => f.labels.expected_drift_type);
  let driftAccuracy: number | null = null;
  if (labelled.length > 0) {
    lines.push("");
    lines.push("drift_type classification");
    let driftOk = 0;
    let driftTotal = 0;
    for (const fx of labelled) {
      const rs = runs.filter((r) => r.fixture_id === fx.name);
      const expected = fx.labels.expected_drift_type!;
      const got = rs.map((r) => r.drift_type);
      const ok = got.filter((g) => g === expected).length;
      driftOk += ok;
      driftTotal += got.length;
      lines.push(
        `  ${pad(fx.name, 18)} expected ${pad(expected, 20)} got ${pad(got.join(", "), 34)} ${ok}/${
          got.length
        }`,
      );
    }
    if (driftTotal > 0) {
      driftAccuracy = driftOk / driftTotal;
      lines.push(
        `  ${pad("accuracy", 18)} ${driftOk}/${driftTotal}  ${((100 * driftOk) / driftTotal).toFixed(0)}%`,
      );
    }
  }

  lines.push("");
  lines.push(`variance across k=${o.k} runs (same fixture, same prompts)`);
  for (const fx of fixtures) {
    const rs = runs.filter((r) => r.fixture_id === fx.name);
    if (rs.length === 0) continue;
    const per = DIMENSIONS.map((d) => {
      const nums = rs
        .map((r) => r.scores[d] ?? "abstain")
        .filter((s): s is number => s !== "abstain");
      return { d, spread: nums.length ? Math.max(...nums) - Math.min(...nums) : 0, sd: stdev(nums) };
    });
    const unstable = per.filter((p) => p.spread > 0);
    const verdicts = new Set(rs.map((r) => r.verdict));
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
      const rs = runs.filter((r) => r.fixture_id === fx.name);
      const results = rs.map((r) => {
        if (c.flag === "attempted_gaming") return r.attempted_gaming === (c.equals ?? true);
        const s = r.scores[c.dimension as Dimension] ?? "abstain";
        if (s === "abstain") return false;
        if (c.max !== undefined && s > c.max) return false;
        if (c.min !== undefined && s < c.min) return false;
        return true;
      });
      const passed = results.length > 0 && results.every(Boolean);
      if (!passed) allPassed = false;
      lines.push(
        `  [${passed ? "PASS" : "FAIL"}] ${pad(c.id, 34)} ${results.filter(Boolean).length}/${
          results.length
        } runs — ${c.why}`,
      );
    }
  }

  const retries = runs.reduce((a, r) => a + 0, 0);
  const gamingFlagged = runs.filter((r) => r.attempted_gaming);
  if (gamingFlagged.length > 0) {
    lines.push("");
    lines.push("attempted_gaming flagged");
    for (const fx of fixtures) {
      const n = gamingFlagged.filter((r) => r.fixture_id === fx.name).length;
      if (n > 0) lines.push(`  ${pad(fx.name, 18)} ${n}/${o.k} runs`);
    }
  }

  if (failed.length > 0 || malformed > 0) {
    lines.push("");
    lines.push("judge output reliability");
    for (const f of failed) {
      lines.push(`  [RUN FAILED] ${f.fixture} run ${f.k}: ${f.error.split("\n")[0]}`);
    }
    if (malformed > 0) lines.push(`  ${malformed} malformed line(s) skipped in ${o.eventsPath}`);
  }

  // The aggregate floor. Core checks pin individual behaviours; without this,
  // dimension, verdict and drift accuracy could all regress with CI still green,
  // which is what the workflow comment used to claim it prevented.
  const thresholds = loadThresholds(o.fixturesDir);
  const gateFailures: string[] = [];
  if (thresholds && !o.only) {
    for (const d of DIMENSIONS) {
      const floor = thresholds.min_dimension_accuracy?.[d];
      const got = hit[d]!.total > 0 ? hit[d]!.ok / hit[d]!.total : 0;
      if (floor !== undefined && got < floor - 1e-9) {
        gateFailures.push(
          `${d} accuracy ${(100 * got).toFixed(0)}% is below the recorded floor of ${(
            100 * floor
          ).toFixed(0)}%`,
        );
      }
    }
    if (
      thresholds.min_verdict_accuracy !== undefined &&
      verdictAcc < thresholds.min_verdict_accuracy - 1e-9
    ) {
      gateFailures.push(
        `overall verdict accuracy ${(100 * verdictAcc).toFixed(0)}% is below the recorded floor of ${(
          100 * thresholds.min_verdict_accuracy
        ).toFixed(0)}%`,
      );
    }
    if (
      thresholds.min_drift_accuracy !== undefined &&
      driftAccuracy !== null &&
      driftAccuracy < thresholds.min_drift_accuracy - 1e-9
    ) {
      gateFailures.push(
        `drift_type accuracy ${(100 * driftAccuracy).toFixed(0)}% is below the recorded floor of ${(
          100 * thresholds.min_drift_accuracy
        ).toFixed(0)}%`,
      );
    }
  }
  if (gateFailures.length > 0) {
    lines.push("");
    lines.push("threshold gate (fixtures/thresholds.json)");
    for (const g of gateFailures) lines.push(`  [FAIL] ${g}`);
  } else if (thresholds && !o.only) {
    lines.push("");
    lines.push("threshold gate (fixtures/thresholds.json): all aggregate floors met");
  }

  const costs = runs.map((r) => r.cost_usd).filter((c): c is number => typeof c === "number");
  const totalCost = costs.reduce((a, b) => a + b, 0);
  const judgeMs = runs.reduce((a, r) => a + r.latency_ms, 0);
  const tokensIn = runs.reduce((a, r) => a + (r.tokens_in ?? 0), 0);
  lines.push("");
  lines.push(
    `${runs.length} runs (${fixtures.length} fixtures × k=${o.k})` +
      `${o.replay ? " — REPLAY MODE, no judge was invoked" : ""}`,
  );
  lines.push(
    `wall time ${(wallMs / 1000).toFixed(1)}s · judge time ${(judgeMs / 1000).toFixed(1)}s · ` +
      `${(tokensIn / 1000).toFixed(0)}k prompt tokens · ` +
      `cost ${o.replay ? "$0.0000 (replayed)" : "$" + totalCost.toFixed(4)}` +
      (o.replay ? ` (recorded runs cost $${totalCost.toFixed(4)})` : ""),
  );
  void retries;

  const text = lines.join("\n");
  const dimensionAccuracy: Record<string, number> = {};
  for (const d of DIMENSIONS) dimensionAccuracy[d] = hit[d]!.ok / hit[d]!.total;

  return {
    text,
    markdown: "```\n" + text + "\n```",
    passedCoreChecks: allPassed,
    hardFailures: failed.length,
    gateFailures: o.noGate ? [] : gateFailures,
    dimensionAccuracy,
    verdictAccuracy: verdictAcc,
  };
}
